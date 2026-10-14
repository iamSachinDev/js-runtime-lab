import {
  CircleCheck,
  CircleX,
  CornerDownRight,
  Diamond,
  Flag,
  Hourglass,
  Info,
  Layers,
  ListPlus,
  LogIn,
  LogOut,
  OctagonX,
  Pause,
  Play,
  RefreshCw,
  Rocket,
  Send,
  ShieldCheck,
  StepForward,
  Terminal,
  TriangleAlert,
} from 'lucide-react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ComponentType, type CSSProperties } from 'react';
import { summarize } from '../engine/explain/explain';
import { fmtMs, kindTone, PHASE_LABEL, type Tone } from '../engine/trace/format';
import type { TraceIndex } from '../engine/trace/model';
import type { TraceEvent } from '../engine/types';
import { useRuntime, useStore } from '../store/store';
import { Empty, Toggle, TONE_VAR } from './ui';

type Icon = ComponentType<{ size?: number; className?: string; style?: CSSProperties }>;

const ICONS: Record<TraceEvent['kind'], Icon> = {
  'run-start': Rocket,
  step: CornerDownRight,
  enter: LogIn,
  exit: LogOut,
  suspend: Pause,
  resume: StepForward,
  catch: ShieldCheck,
  schedule: Send,
  enqueue: ListPlus,
  cancel: CircleX,
  'task-start': Play,
  'task-end': CircleCheck,
  phase: RefreshCw,
  checkpoint: Layers,
  idle: Hourglass,
  console: Terminal,
  promise: Diamond,
  error: TriangleAlert,
  limit: OctagonX,
  note: Info,
  'run-end': Flag,
};

function eventTone(ev: TraceEvent): Tone {
  switch (ev.kind) {
    case 'schedule':
    case 'task-start':
      return kindTone(ev.task.kind);
    case 'error':
    case 'limit':
    case 'cancel':
      return 'coral';
    case 'note':
      return 'amber';
    case 'console':
    case 'task-end':
      return 'green';
    case 'checkpoint':
      return ev.queue === 'nextTick' ? 'fuchsia' : 'violet';
    case 'promise':
    case 'suspend':
      return 'violet';
    case 'phase':
    case 'idle':
      return 'slate';
    default:
      return 'cyan';
  }
}

const ROW = 26;

function upperBound(arr: number[], x: number): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid]! <= x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function statusText(index: TraceIndex): string {
  const r = index.result;
  const mode = r.mode === 'node' ? 'Node.js simulation' : 'Browser runtime';
  const end = r.events[r.events.length - 1];
  const outcome = r.status === 'completed' ? 'completed' : r.status === 'exited' ? `exited (${r.exitCode})` : r.status;
  return `${mode} · ${r.events.length.toLocaleString()} events · ${fmtMs(end?.time ?? 0)} ms virtual · ${outcome}`;
}

export function Timeline() {
  const { index, cursor } = useRuntime();
  const hideSteps = useStore((s) => s.hideSteps);
  const follow = useStore((s) => s.follow);
  const breakpoints = useStore((s) => s.breakpoints);
  const seek = useStore((s) => s.seek);
  const setUi = useStore((s) => s.setUi);
  const scroller = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ top: 0, height: 240 });

  const rows = useMemo(() => {
    if (!index) return [] as number[];
    return hideSteps ? index.events.filter((e) => e.kind !== 'step').map((e) => e.seq) : index.events.map((e) => e.seq);
  }, [index, hideSteps]);
  const currentRow = upperBound(rows, cursor) - 1;
  const bpSet = useMemo(() => new Set(breakpoints), [breakpoints]);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setView((v) => ({ ...v, height: el.clientHeight })));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const el = scroller.current;
    if (!el || !follow || currentRow < 0) return;
    const y = currentRow * ROW;
    if (y < el.scrollTop + ROW || y > el.scrollTop + el.clientHeight - 2 * ROW) el.scrollTop = Math.max(0, y - el.clientHeight / 2);
  }, [currentRow, follow]);

  const start = Math.max(0, Math.floor(view.top / ROW) - 8);
  const end = Math.min(rows.length, Math.ceil((view.top + view.height) / ROW) + 8);

  return (
    <section className="glass flex h-full min-h-0 flex-col rounded-[10px]" aria-label="Execution timeline">
      <header className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line px-3 py-1.5">
        <h3 className="panel-title">Timeline</h3>
        <span className="min-w-0 truncate text-[11.5px] text-faint">{index ? statusText(index) : 'No trace yet'}</span>
        <input
          type="range"
          className="scrubber min-w-[120px] flex-1"
          min={0}
          max={Math.max(0, (index?.length ?? 1) - 1)}
          value={Math.max(0, cursor)}
          onChange={(e) => seek(Number(e.target.value))}
          disabled={!index}
          aria-label="Seek through the execution trace"
        />
        <Toggle on={!hideSteps} onClick={() => setUi({ hideSteps: !hideSteps })} label="Show one row per executed statement">
          Statements
        </Toggle>
        <Toggle on={follow} onClick={() => setUi({ follow: !follow })} label="Keep the current event in view">
          Follow
        </Toggle>
      </header>
      <div className="tl-head" aria-hidden>
        <span>#</span>
        <span>t (ms)</span>
        <span>Phase</span>
        <span>Event</span>
        <span className="tl-task">Callback</span>
      </div>
      <div
        ref={scroller}
        className="relative min-h-0 flex-1 overflow-y-auto"
        onScroll={(e) => {
          // Read now: React clears currentTarget after the handler, and the updater may run later.
          const top = e.currentTarget.scrollTop;
          setView((v) => ({ ...v, top }));
        }}
      >
        {!index && (
          <div className="p-3">
            <Empty>Every traced event appears here. Click a row to jump to that moment.</Empty>
          </div>
        )}
        {index && (
          <div style={{ height: rows.length * ROW, position: 'relative' }}>
            {rows.slice(start, end).map((seq, i) => {
              const ev = index.events[seq]!;
              const Icon = ICONS[ev.kind];
              const phase = index.phaseAt[seq];
              const current = start + i === currentRow;
              return (
                <button
                  key={seq}
                  type="button"
                  className={`tl-row ${current ? 'is-current' : seq > cursor ? 'is-future' : ''}`}
                  style={{ position: 'absolute', top: (start + i) * ROW, left: 0, right: 0 }}
                  onClick={() => seek(seq)}
                  aria-current={current ? 'step' : undefined}
                >
                  <span className="font-mono text-[11px] text-faint">{seq}</span>
                  <span className="font-mono text-[11px] text-muted">{fmtMs(ev.time)}</span>
                  <span className="truncate text-[11.5px] text-faint">{phase ? PHASE_LABEL[phase] : ''}</span>
                  <span className="flex min-w-0 items-center gap-2">
                    <Icon size={13} className="flex-none" style={{ color: TONE_VAR[eventTone(ev)] }} />
                    <span className={`truncate ${ev.kind === 'step' ? 'font-mono text-[11.5px] text-muted' : ''}`}>{summarize(index, ev)}</span>
                    {ev.kind === 'step' && ev.line !== undefined && bpSet.has(ev.line) && (
                      <span className="h-1.5 w-1.5 flex-none rounded-full bg-coral" title="Breakpoint on this line" />
                    )}
                  </span>
                  <span className="tl-task truncate text-[11.5px] text-faint">{ev.taskId !== null ? index.taskLabel(ev.taskId) : ''}</span>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}
