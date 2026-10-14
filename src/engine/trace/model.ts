import type {
  FrameInfo,
  FrameKind,
  Phase,
  PromiseState,
  QueueId,
  RunResult,
  RunStatus,
  RuntimeMode,
  SV,
  TaskInfo,
  TaskKind,
  TraceEvent,
  VarUpdate,
} from '../types';

export interface FrameView {
  id: number;
  name: string;
  kind: FrameKind;
  layoutKey: string;
  line?: number;
  async?: boolean;
  generator?: boolean;
  args?: { name: string; value: SV }[];
  taskId?: number;
  fnId?: number;
}

export interface TokenView {
  id: number;
  kind: TaskKind;
  label: string;
  layoutKey: string;
  api?: string;
  delay?: number;
  dueAt?: number;
  createdAt: number;
  detail?: string;
  line?: number;
  promiseId?: number;
  repeatRun?: number;
}

export interface ScopeView {
  id: number;
  name: string;
  fnId?: number;
  status: 'active' | 'suspended' | 'closure';
  global: boolean;
  vars: [string, SV][];
}

export interface PromiseView {
  id: number;
  state: PromiseState;
  origin: string;
  value?: SV;
}

/** Everything the visualization shows at one point of the trace. Plain data (structured-cloneable). */
export interface RuntimeState {
  seq: number;
  time: number;
  mode: RuntimeMode;
  stack: FrameView[];
  suspended: FrameView[];
  webapis: TokenView[];
  queues: Record<QueueId, TokenView[]>;
  phase: Phase | null;
  phaseEmpty: boolean;
  iteration: number;
  checkpoint: 'nextTick' | 'microtask' | null;
  task: TaskInfo | null;
  taskQueue: QueueId | 'main' | 'internal' | null;
  line?: number;
  scopes: ScopeView[];
  promises: PromiseView[];
  completed: number;
  done: boolean;
  status?: RunStatus;
  halted?: string;
  errorCount: number;
}

export const QUEUE_IDS: QueueId[] = ['nextTick', 'microtask', 'timers', 'poll', 'check', 'task', 'raf'];
const MAX_CLOSURES = 12;
const MAX_PROMISES = 12;

export function initialState(mode: RuntimeMode = 'node'): RuntimeState {
  return {
    seq: -1,
    time: 0,
    mode,
    stack: [],
    suspended: [],
    webapis: [],
    queues: { nextTick: [], microtask: [], timers: [], poll: [], check: [], task: [], raf: [] },
    phase: null,
    phaseEmpty: false,
    iteration: 0,
    checkpoint: null,
    task: null,
    taskQueue: null,
    scopes: [],
    promises: [],
    completed: 0,
    done: false,
    errorCount: 0,
  };
}

const frameView = (f: FrameInfo): FrameView => ({
  id: f.id,
  name: f.name,
  kind: f.kind,
  layoutKey: f.layoutKey,
  line: f.line,
  async: f.async,
  generator: f.generator,
  args: f.args,
  taskId: f.taskId,
  fnId: f.fnId,
});

function takeToken(s: RuntimeState, id: number): TokenView | undefined {
  let i = s.webapis.findIndex((t) => t.id === id);
  if (i >= 0) return s.webapis.splice(i, 1)[0];
  for (const q of QUEUE_IDS) {
    i = s.queues[q].findIndex((t) => t.id === id);
    if (i >= 0) return s.queues[q].splice(i, 1)[0];
  }
  return undefined;
}

function tokenOf(s: RuntimeState, task: TaskInfo, api?: string): TokenView {
  let layoutKey = `task-${task.id}`;
  // An await continuation travels back to the stack as the suspended frame itself.
  if (task.kind === 'await' && task.frameId !== undefined) {
    const f = s.suspended.find((x) => x.id === task.frameId);
    layoutKey = f ? f.layoutKey : `frame-${task.frameId}`;
  }
  return {
    id: task.id,
    kind: task.kind,
    label: task.label,
    layoutKey,
    api,
    delay: task.delay,
    dueAt: task.dueAt,
    createdAt: task.createdAt,
    detail: task.detail,
    line: task.line,
    promiseId: task.promiseId,
    repeatRun: task.repeatRun,
  };
}

function applyVars(s: RuntimeState, vars: VarUpdate[] | undefined): void {
  if (!vars) return;
  for (const v of vars) {
    const scope = s.scopes.find((x) => x.id === v.scope);
    if (!scope) continue;
    const i = scope.vars.findIndex(([n]) => n === v.name);
    if (i >= 0) scope.vars[i] = [v.name, v.value];
    else scope.vars.push([v.name, v.value]);
  }
}

function removeFrame(list: FrameView[], id: number): FrameView | undefined {
  for (let i = list.length - 1; i >= 0; i--) if (list[i]!.id === id) return list.splice(i, 1)[0];
  return undefined;
}

export interface ApplyContext {
  frames: Map<number, FrameInfo>;
}

export function apply(s: RuntimeState, ev: TraceEvent, ctx: ApplyContext): void {
  s.seq = ev.seq;
  s.time = ev.time;
  switch (ev.kind) {
    case 'run-start':
      s.mode = ev.mode;
      s.phase = 'main';
      break;
    case 'step':
      s.line = ev.line;
      applyVars(s, ev.vars);
      break;
    case 'enter': {
      const f = frameView(ev.frame);
      const i = ev.mergedFrameId === undefined ? -1 : s.stack.findIndex((x) => x.id === ev.mergedFrameId);
      if (i >= 0) s.stack[i] = f;
      else s.stack.push(f);
      if (f.kind !== 'task') {
        const main = f.fnId === 0;
        s.scopes.push({
          id: f.id,
          name: main ? (s.mode === 'node' ? 'Module scope' : 'Global scope') : f.name,
          fnId: f.fnId,
          status: 'active',
          global: main,
          vars: [],
        });
      }
      applyVars(s, ev.vars);
      s.line = ev.line;
      break;
    }
    case 'exit': {
      applyVars(s, ev.vars);
      const f = removeFrame(s.stack, ev.frameId) ?? removeFrame(s.suspended, ev.frameId);
      const si = s.scopes.findIndex((x) => x.id === ev.frameId);
      if (si >= 0) {
        if (ev.retained || f?.fnId === 0) {
          s.scopes[si]!.status = 'closure';
          const closures = s.scopes.filter((x) => x.status === 'closure' && !x.global);
          if (closures.length > MAX_CLOSURES) s.scopes.splice(s.scopes.indexOf(closures[0]!), 1);
        } else s.scopes.splice(si, 1);
      }
      break;
    }
    case 'suspend': {
      const f = removeFrame(s.stack, ev.frameId);
      if (f) s.suspended.push(f);
      const scope = s.scopes.find((x) => x.id === ev.frameId);
      if (scope) scope.status = 'suspended';
      break;
    }
    case 'resume': {
      const info = ctx.frames.get(ev.frameId);
      const f = removeFrame(s.suspended, ev.frameId) ?? (info ? frameView(info) : undefined);
      if (f) s.stack.push(f);
      const scope = s.scopes.find((x) => x.id === ev.frameId);
      if (scope) scope.status = 'active';
      break;
    }
    case 'schedule': {
      const token = tokenOf(s, ev.task, ev.api);
      if (ev.target === 'webapi') s.webapis.push(token);
      else s.queues[ev.target].push(token);
      break;
    }
    case 'enqueue': {
      const token = takeToken(s, ev.id);
      if (token) s.queues[ev.queue].push(token);
      break;
    }
    case 'cancel':
      takeToken(s, ev.id);
      break;
    case 'task-start':
      takeToken(s, ev.task.id);
      s.task = ev.task;
      s.taskQueue = ev.queue;
      if (ev.frameId !== undefined)
        s.stack.push({ id: ev.frameId, kind: 'task', name: ev.task.label, layoutKey: `task-${ev.task.id}`, taskId: ev.task.id, line: ev.line });
      s.line = ev.line;
      break;
    case 'task-end':
      s.task = null;
      s.taskQueue = null;
      s.completed++;
      s.line = undefined;
      break;
    case 'phase':
      s.phase = ev.phase;
      s.phaseEmpty = ev.empty;
      s.iteration = ev.iteration;
      break;
    case 'checkpoint':
      s.checkpoint = ev.state === 'start' ? ev.queue : null;
      break;
    case 'promise': {
      const i = s.promises.findIndex((p) => p.id === ev.promise.id);
      const view: PromiseView = { id: ev.promise.id, state: ev.promise.state, origin: ev.promise.origin, value: ev.promise.value };
      if (i >= 0) s.promises[i] = { ...view, origin: s.promises[i]!.origin };
      else {
        s.promises.push(view);
        if (s.promises.length > MAX_PROMISES) s.promises.shift();
      }
      break;
    }
    case 'error':
      s.errorCount++;
      if (ev.line) s.line = ev.line;
      break;
    case 'limit':
      s.halted = ev.message;
      break;
    case 'run-end':
      s.done = true;
      s.status = ev.status;
      s.phase = null;
      s.checkpoint = null;
      s.task = null;
      s.line = undefined;
      break;
    default:
      break;
  }
}

/** Random access into a trace: snapshots every N events plus forward replay. */
export class TraceIndex {
  readonly events: TraceEvent[];
  readonly mode: RuntimeMode;
  readonly frames = new Map<number, FrameInfo>();
  readonly tasks = new Map<number, TaskInfo>();
  /** seqs of console events, ascending. */
  readonly consoleSeqs: number[] = [];
  readonly phaseAt: (Phase | null)[] = [];
  private readonly snaps: RuntimeState[] = [];
  private readonly interval: number;
  private readonly ctx: ApplyContext;
  private cache: RuntimeState | null = null;

  constructor(readonly result: RunResult) {
    this.events = result.events;
    this.mode = result.mode;
    this.interval = this.events.length > 4000 ? 100 : 25;
    this.ctx = { frames: this.frames };
    const s = initialState(result.mode);
    let phase: Phase | null = null;
    for (const ev of this.events) {
      if (ev.kind === 'enter') this.frames.set(ev.frame.id, ev.frame);
      else if (ev.kind === 'task-start') {
        this.tasks.set(ev.task.id, ev.task);
        if (ev.frameId !== undefined)
          this.frames.set(ev.frameId, { id: ev.frameId, kind: 'task', name: ev.task.label, layoutKey: `task-${ev.task.id}`, taskId: ev.task.id });
      } else if (ev.kind === 'schedule' && !this.tasks.has(ev.task.id)) this.tasks.set(ev.task.id, ev.task);
      else if (ev.kind === 'console') this.consoleSeqs.push(ev.seq);
      if (ev.kind === 'phase') phase = ev.phase;
      else if (ev.kind === 'run-start') phase = 'main';
      else if (ev.kind === 'run-end') phase = null;
      this.phaseAt[ev.seq] = phase;
      apply(s, ev, this.ctx);
      if (ev.seq % this.interval === 0) this.snaps.push(structuredClone(s));
    }
  }

  get length(): number {
    return this.events.length;
  }

  stateAt(seq: number): RuntimeState {
    if (seq < 0 || !this.events.length) return initialState(this.mode);
    const target = Math.min(seq, this.events.length - 1);
    if (this.cache?.seq === target) return this.cache;
    const s =
      this.cache && this.cache.seq < target && target - this.cache.seq <= this.interval
        ? structuredClone(this.cache)
        : structuredClone(this.snaps[Math.floor(target / this.interval)]!);
    for (let i = s.seq + 1; i <= target; i++) apply(s, this.events[i]!, this.ctx);
    this.cache = s;
    return s;
  }

  /** Number of console lines printed up to and including `seq`. */
  consoleCount(seq: number): number {
    let lo = 0;
    let hi = this.consoleSeqs.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.consoleSeqs[mid]! <= seq) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  taskLabel(id: number | null | undefined): string {
    if (id === null || id === undefined) return '';
    return this.tasks.get(id)?.label ?? `#${id}`;
  }

  frameName(id: number): string {
    return this.frames.get(id)?.name ?? 'function';
  }
}
