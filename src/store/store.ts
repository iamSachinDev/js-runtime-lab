import { create } from 'zustand';
import { TraceIndex } from '../engine/trace/model';
import type { RuntimeMode, TraceEvent } from '../engine/types';
import { DEFAULT_EXAMPLE, EXAMPLES } from '../examples';
import { runInSandbox, SandboxError, type SandboxRun } from '../sandbox/client';

export const SPEEDS = [0.25, 0.5, 1, 2, 4] as const;
export type Speed = (typeof SPEEDS)[number];
export type InspectorTab = 'variables' | 'promises' | 'graph';
export type MobileView = 'code' | 'runtime' | 'explain' | 'timeline';
export type Move = 'forward' | 'backward' | 'jump';

const STORAGE_KEY = 'js-runtime-lab:v1';

interface Prefs {
  code: string;
  mode: RuntimeMode;
  speed: Speed;
  breakpoints: number[];
  exampleId: string | null;
  hideSteps: boolean;
  follow: boolean;
  /** Fractions of the window width, and px for the timeline. */
  editorWidth: number;
  inspectorWidth: number;
  timelineHeight: number;
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

const DEFAULT_PREFS: Prefs = {
  code: DEFAULT_EXAMPLE.code,
  mode: DEFAULT_EXAMPLE.mode,
  speed: 1,
  breakpoints: [],
  exampleId: DEFAULT_EXAMPLE.id,
  hideSteps: false,
  follow: true,
  editorWidth: 0.3,
  inspectorWidth: 0.25,
  timelineHeight: 210,
};

function loadPrefs(): Prefs {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_PREFS;
    const p = JSON.parse(raw) as Partial<Prefs>;
    return {
      code: typeof p.code === 'string' && p.code.length < 200_000 ? p.code : DEFAULT_PREFS.code,
      mode: p.mode === 'browser' || p.mode === 'node' ? p.mode : DEFAULT_PREFS.mode,
      speed: SPEEDS.includes(p.speed as Speed) ? (p.speed as Speed) : 1,
      breakpoints: Array.isArray(p.breakpoints) ? p.breakpoints.filter((n): n is number => Number.isInteger(n) && n > 0).slice(0, 200) : [],
      exampleId: typeof p.exampleId === 'string' && EXAMPLES.some((e) => e.id === p.exampleId) ? p.exampleId : null,
      hideSteps: p.hideSteps === true,
      follow: p.follow !== false,
      editorWidth: clamp(Number(p.editorWidth) || DEFAULT_PREFS.editorWidth, 0.18, 0.5),
      inspectorWidth: clamp(Number(p.inspectorWidth) || DEFAULT_PREFS.inspectorWidth, 0.16, 0.4),
      timelineHeight: clamp(Number(p.timelineHeight) || DEFAULT_PREFS.timelineHeight, 120, 520),
    };
  } catch {
    return DEFAULT_PREFS;
  }
}

/** Base on-screen time per event at 1x, tuned so each kind of movement can be followed. */
const BASE_MS: Record<TraceEvent['kind'], number> = {
  'run-start': 380,
  step: 400,
  enter: 480,
  exit: 420,
  suspend: 560,
  resume: 520,
  catch: 480,
  schedule: 680,
  enqueue: 600,
  cancel: 460,
  'task-start': 660,
  'task-end': 340,
  phase: 540,
  checkpoint: 340,
  idle: 560,
  console: 460,
  promise: 260,
  error: 1100,
  limit: 1100,
  note: 1000,
  'run-end': 420,
};

export function eventDuration(ev: TraceEvent): number {
  if (ev.kind === 'phase' && ev.empty) return 180;
  if (ev.kind === 'checkpoint' && ev.state === 'end') return 200;
  return BASE_MS[ev.kind];
}

export interface AppState extends Prefs {
  index: TraceIndex | null;
  runCode: string | null;
  runMode: RuntimeMode | null;
  cursor: number;
  move: Move;
  playing: boolean;
  running: boolean;
  sandboxError: string | null;
  inspectorTab: InspectorTab;
  mobileView: MobileView;
  presenting: boolean;
  examplesOpen: boolean;
  aboutOpen: boolean;

  setCode(code: string): void;
  setMode(mode: RuntimeMode): void;
  loadExample(id: string): void;
  run(opts?: { autoplay?: boolean }): Promise<void>;
  play(): void;
  pause(): void;
  togglePlay(): void;
  stepForward(): void;
  stepBackward(): void;
  seek(seq: number): void;
  restart(): void;
  advance(): void;
  setSpeed(speed: Speed): void;
  toggleBreakpoint(line: number): void;
  clearBreakpoints(): void;
  setUi(patch: Partial<Pick<AppState, 'inspectorTab' | 'mobileView' | 'presenting' | 'examplesOpen' | 'aboutOpen' | 'hideSteps' | 'follow' | 'editorWidth' | 'inspectorWidth' | 'timelineHeight'>>): void;
}

let current: SandboxRun | null = null;

export const useStore = create<AppState>()((set, get) => ({
  ...loadPrefs(),
  index: null,
  runCode: null,
  runMode: null,
  cursor: -1,
  move: 'jump',
  playing: false,
  running: false,
  sandboxError: null,
  inspectorTab: 'variables',
  mobileView: 'runtime',
  presenting: false,
  examplesOpen: false,
  aboutOpen: false,

  setCode: (code) => set({ code }),
  setMode: (mode) => set({ mode }),

  loadExample: (id) => {
    const ex = EXAMPLES.find((e) => e.id === id);
    if (!ex) return;
    set({ code: ex.code, mode: ex.mode, exampleId: ex.id, breakpoints: [], examplesOpen: false });
    void get().run({ autoplay: true });
  },

  run: async (opts = {}) => {
    current?.cancel();
    const { code, mode } = get();
    set({ running: true, sandboxError: null, playing: false });
    const handle = runInSandbox({ source: code, mode });
    current = handle;
    try {
      const result = await handle.promise;
      if (current !== handle) return;
      const index = new TraceIndex(result);
      const ok = result.diagnostics.length === 0;
      set({ index, runCode: code, runMode: mode, running: false, cursor: ok ? 0 : index.length - 1, move: 'jump', playing: ok && opts.autoplay !== false });
    } catch (err) {
      if (err instanceof SandboxError && err.code === 'cancelled') return;
      if (current !== handle) return;
      set({ running: false, sandboxError: err instanceof Error ? err.message : String(err) });
    } finally {
      if (current === handle) current = null;
    }
  },

  play: () => {
    const { index, cursor } = get();
    if (!index || index.length === 0) return;
    if (cursor >= index.length - 1) set({ cursor: 0, move: 'jump' });
    set({ playing: true });
  },
  pause: () => set({ playing: false }),
  togglePlay: () => (get().playing ? get().pause() : get().play()),

  stepForward: () => {
    const { index, cursor } = get();
    if (!index || cursor >= index.length - 1) return;
    set({ cursor: cursor + 1, move: 'forward', playing: false });
  },
  stepBackward: () => {
    const { index, cursor } = get();
    if (!index || cursor <= 0) return;
    set({ cursor: cursor - 1, move: 'backward', playing: false });
  },
  seek: (seq) => {
    const { index } = get();
    if (!index) return;
    set({ cursor: clamp(Math.round(seq), 0, index.length - 1), move: 'jump', playing: false });
  },
  restart: () => {
    if (get().index) set({ cursor: 0, move: 'jump', playing: false });
  },
  /** Playback tick: one event forward; stops at breakpoints and at the end. */
  advance: () => {
    const { index, cursor, breakpoints } = get();
    if (!index) return;
    const next = cursor + 1;
    if (next > index.length - 1) {
      set({ playing: false });
      return;
    }
    const ev = index.events[next]!;
    const hit = ev.kind === 'step' && ev.line !== undefined && breakpoints.includes(ev.line);
    set({ cursor: next, move: 'forward', playing: !hit && next < index.length - 1 });
  },

  setSpeed: (speed) => set({ speed }),
  toggleBreakpoint: (line) => {
    const bps = get().breakpoints;
    set({ breakpoints: bps.includes(line) ? bps.filter((l) => l !== line) : [...bps, line].sort((a, b) => a - b) });
  },
  clearBreakpoints: () => set({ breakpoints: [] }),
  setUi: (patch) => set(patch),
}));

// Persist code and preferences (debounced).
let saveTimer: ReturnType<typeof setTimeout> | undefined;
useStore.subscribe((s) => {
  if (saveTimer !== undefined) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const prefs: Prefs = {
      code: s.code,
      mode: s.mode,
      speed: s.speed,
      breakpoints: s.breakpoints,
      exampleId: s.exampleId,
      hideSteps: s.hideSteps,
      follow: s.follow,
      editorWidth: s.editorWidth,
      inspectorWidth: s.inspectorWidth,
      timelineHeight: s.timelineHeight,
    };
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
    } catch {
      /* storage full or disabled: preferences just won't persist */
    }
  }, 300);
});

/** Derived view of the trace at the cursor (memoized by TraceIndex). */
export function useRuntime() {
  const index = useStore((s) => s.index);
  const cursor = useStore((s) => s.cursor);
  const state = index ? index.stateAt(cursor) : null;
  const event = index && cursor >= 0 ? index.events[cursor] : undefined;
  return { index, cursor, state, event };
}
