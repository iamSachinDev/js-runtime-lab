/**
 * Typed execution trace schema. The engine emits TraceEvents; every visualization
 * (call stack, queues, heap, timeline, graph, explanations) is derived from them.
 */

export type RuntimeMode = 'node' | 'browser';

export type QueueId = 'nextTick' | 'microtask' | 'timers' | 'poll' | 'check' | 'task' | 'raf';
export type NodePhase = 'timers' | 'pending' | 'idle' | 'poll' | 'check' | 'close';
export type BrowserPhase = 'task' | 'render';
export type Phase = 'main' | NodePhase | BrowserPhase;

export type TaskKind =
  | 'main'
  | 'timeout'
  | 'interval'
  | 'immediate'
  | 'nextTick'
  | 'promise'
  | 'await'
  | 'thenable'
  | 'microtask'
  | 'io'
  | 'raf'
  | 'event';

/** Serialized runtime value (structured-clone safe). */
export type SV =
  | { t: 'undefined' }
  | { t: 'null' }
  | { t: 'boolean'; v: boolean }
  | { t: 'number'; v: string }
  | { t: 'bigint'; v: string }
  | { t: 'string'; v: string; trunc?: boolean }
  | { t: 'symbol'; v: string }
  | { t: 'tdz' }
  | { t: 'function'; id: number; name: string; async?: boolean; generator?: boolean; cls?: boolean }
  | { t: 'array'; id: number; len: number; items: SV[]; more?: boolean }
  | { t: 'object'; id: number; ctor: string; entries: [string, SV][]; more?: boolean }
  | { t: 'map'; id: number; size: number; entries: [SV, SV][]; more?: boolean }
  | { t: 'set'; id: number; size: number; items: SV[]; more?: boolean }
  | { t: 'promise'; id: number; pid: number; state: PromiseState; value?: SV }
  | { t: 'error'; id: number; name: string; message: string }
  | { t: 'date'; v: string }
  | { t: 'regexp'; v: string }
  | { t: 'ref'; id: number; kind: string };

export type PromiseState = 'pending' | 'fulfilled' | 'rejected';

export interface TaskInfo {
  id: number;
  kind: TaskKind;
  /** Short human label, usually the callback source, e.g. `() => console.log('x')`. */
  label: string;
  fnId?: number;
  delay?: number;
  dueAt?: number;
  createdAt: number;
  line?: number;
  /** Causality: the task that was running when this one was scheduled. */
  parentId: number | null;
  detail?: string;
  promiseId?: number;
  frameId?: number;
  repeatRun?: number;
  /** Timer/immediate/rAF handle (stable across interval re-arms). */
  handle?: number;
  nesting?: number;
}

export type FrameKind = 'function' | 'task' | 'main';

export interface FrameInfo {
  id: number;
  kind: FrameKind;
  name: string;
  fnId?: number;
  async?: boolean;
  generator?: boolean;
  line?: number;
  args?: { name: string; value: SV }[];
  taskId?: number;
  /** Lexical parent frame (closure scope). */
  parentScopeId?: number | null;
  /** Stable animation identity: a task token keeps its key when it becomes a frame. */
  layoutKey: string;
}

export interface VarUpdate {
  scope: number;
  name: string;
  value: SV;
}

export type ConsoleLevel = 'log' | 'info' | 'warn' | 'error' | 'debug';

export interface ErrorInfo {
  name: string;
  message: string;
  value: SV;
  line?: number;
}

export interface PromiseInfo {
  id: number;
  state: PromiseState;
  origin: string;
  value?: SV;
}

export type HaltCode =
  | 'op-limit'
  | 'time-limit'
  | 'trace-limit'
  | 'task-limit'
  | 'microtask-starvation'
  | 'console-limit'
  | 'virtual-time-limit'
  | 'internal-error'
  | 'worker-timeout';

export type RunStatus = 'completed' | 'crashed' | 'halted' | 'exited';

interface EvBase {
  seq: number;
  time: number;
  taskId: number | null;
  line?: number;
}

export type TraceEvent = EvBase &
  (
    | { kind: 'run-start'; mode: RuntimeMode }
    | { kind: 'step'; stmtId: number; frameId: number; vars?: VarUpdate[] }
    | { kind: 'enter'; frame: FrameInfo; mergedFrameId?: number; vars?: VarUpdate[] }
    | {
        kind: 'exit';
        frameId: number;
        reason: 'return' | 'unwind';
        value?: SV;
        retained: boolean;
        vars?: VarUpdate[];
      }
    | { kind: 'suspend'; frameId: number; reason: 'await' | 'yield'; value?: SV }
    | { kind: 'resume'; frameId: number; reason: 'await' | 'yield' | 'lazy' }
    | { kind: 'catch'; frameId: number; error?: SV }
    | { kind: 'schedule'; task: TaskInfo; target: QueueId | 'webapi'; api: string }
    | { kind: 'enqueue'; id: number; queue: QueueId; reason: string }
    | { kind: 'cancel'; id: number; api: string }
    | { kind: 'task-start'; task: TaskInfo; queue: QueueId | 'main' | 'internal'; frameId?: number }
    | { kind: 'task-end'; id: number; status: 'ok' | 'error' }
    | { kind: 'phase'; phase: Phase; iteration: number; empty: boolean }
    | { kind: 'checkpoint'; queue: 'nextTick' | 'microtask'; state: 'start' | 'end' }
    | { kind: 'idle'; from: number; to: number; reason: string }
    | { kind: 'console'; level: ConsoleLevel; text: string; api: string }
    | { kind: 'promise'; op: 'create' | 'settle'; promise: PromiseInfo }
    | { kind: 'error'; error: ErrorInfo; fatal: boolean; source: 'uncaught' | 'unhandled-rejection' | 'syntax' }
    | { kind: 'limit'; code: HaltCode; message: string }
    | { kind: 'note'; code: 'timer-race'; message: string }
    | { kind: 'run-end'; status: RunStatus; exitCode: number }
  );

export type TraceEventKind = TraceEvent['kind'];

// ---- Instrumentation metadata -------------------------------------------------

export interface FnMeta {
  id: number;
  name: string;
  kind: 'program' | 'function' | 'arrow' | 'method' | 'getter' | 'setter' | 'constructor';
  async: boolean;
  generator: boolean;
  params: string[];
  line: number;
  endLine: number;
  /** Source offsets, so fn.toString() can return the original text. */
  start: number;
  end: number;
  parentId: number | null;
  snippet: string;
  /** fnIds whose bindings this function closes over. */
  captures: number[];
}

export interface StmtMeta {
  id: number;
  fnId: number;
  type: string;
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
  snippet: string;
  detail: { kind: string; text?: string; declKind?: string; names?: string[] };
  /** Variables read by the generated reader, in order. o = -1 for locals, else owner fnId. */
  vars: { n: string; o: number }[];
  /** Locals currently in their temporal dead zone at this statement. */
  tdz: string[];
}

export interface Diagnostic {
  severity: 'error' | 'warning';
  message: string;
  line: number;
  column: number;
  hint?: string;
}

export interface ProgramMeta {
  functions: FnMeta[];
  statements: StmtMeta[];
  /** Readers for function epilogues, keyed by fnId. */
  exitVars: Record<number, { n: string; o: number }[]>;
}

export interface InstrumentResult {
  ok: boolean;
  code: string;
  meta: ProgramMeta;
  diagnostics: Diagnostic[];
}

export interface RunOptions {
  mode: RuntimeMode;
  source: string;
  limits?: Partial<RunLimits>;
}

export interface RunLimits {
  maxEvents: number;
  maxOps: number;
  maxWallMs: number;
  maxTasks: number;
  maxMicrotasksPerCheckpoint: number;
  maxVirtualMs: number;
  maxConsoleLines: number;
}

export interface RunResult {
  mode: RuntimeMode;
  events: TraceEvent[];
  meta: ProgramMeta;
  console: { level: ConsoleLevel; text: string }[];
  status: RunStatus;
  exitCode: number;
  warnings: string[];
  wallMs: number;
  diagnostics: Diagnostic[];
}
