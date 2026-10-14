import type { FrameInfo, HaltCode, ProgramMeta, QueueId, RunLimits, SV, TaskInfo, TraceEvent, VarUpdate } from '../types';
import type { ValueSerializer } from './serialize';

export const DEFAULT_LIMITS: RunLimits = {
  maxEvents: 25_000,
  maxOps: 5_000_000,
  maxWallMs: 3_000,
  maxTasks: 2_000,
  maxMicrotasksPerCheckpoint: 5_000,
  maxVirtualMs: 10 * 60_000,
  maxConsoleLines: 1_000,
};

/** Thrown to stop execution. User code cannot swallow it: every later hook re-throws it. */
/** Virtual CPU cost of one traced operation (statement, call, loop iteration). */
export const OP_COST_US = 1;

export class RuntimeSignal {
  constructor(
    readonly reason: 'halt' | 'exit' | 'crash',
    readonly code: HaltCode | 'exit' | 'crash',
    readonly message: string,
    readonly exitCode = 1,
  ) {}
}
export const isSignal = (e: unknown): e is RuntimeSignal => e instanceof RuntimeSignal;

export interface RtFrame {
  id: number;
  fnId: number;
  kind: FrameInfo['kind'];
  parent: RtFrame | null;
  captured: boolean;
  suspended: boolean;
  taskId: number | null;
  callbackFnId?: number;
  returning?: { value: unknown };
  info: FrameInfo;
}

export const AWAIT_SIGNAL = Symbol('await');
export interface AwaitSignal {
  [AWAIT_SIGNAL]: true;
  frame: RtFrame;
  value: unknown;
}

/** Wall clock captured at load, so user code replacing `performance` can't disable the time budget. */
export const wallNow: () => number = performance.now.bind(performance);

const TDZ = Symbol('tdz');
/** Event kinds caused by user code; they inherit the line currently executing. */
const LINE_KINDS = new Set(['schedule', 'cancel', 'console', 'promise', 'error', 'catch', 'suspend']);
type Reader = () => unknown[];
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type NewEvent = DistributiveOmit<TraceEvent, 'seq' | 'time' | 'taskId'> & { taskId?: number | null };

export class Tracer {
  readonly events: TraceEvent[] = [];
  readonly stack: RtFrame[] = [];
  readonly fnIds = new WeakMap<Function, number>();
  halted: RuntimeSignal | null = null;
  /** Tasks currently running (nested only for runtime-internal listener jobs). */
  readonly tasks: TaskInfo[] = [];
  /** Virtual clock in integer microseconds; advanced by operations and by idle waits. */
  readonly clock = { us: 0 };
  currentLine: number | undefined;
  paused = 0;
  private frameSeq = 0;
  private ops = 0;
  private readonly startedAt = wallNow();
  private readonly lastRaw = new Map<string, unknown>();
  private readonly lastJson = new Map<string, string>();
  private readonly dummy: RtFrame;

  constructor(
    readonly meta: ProgramMeta,
    readonly limits: RunLimits,
    readonly serializer: ValueSerializer,
  ) {
    this.dummy = this.makeFrame(-1, 'function', null, { name: '(internal)', layoutKey: 'dummy' });
  }

  // ---------------------------------------------------------------- core
  get currentTask(): TaskInfo | null {
    return this.tasks[this.tasks.length - 1] ?? null;
  }

  now(): number {
    return this.clock.us / 1000;
  }

  /** Structural events (`force`) bypass the trace budget so cleanup can always be recorded. */
  emit(ev: NewEvent, force = false): void {
    if (!force && this.events.length >= this.limits.maxEvents)
      this.halt('trace-limit', `Trace limit reached (${this.limits.maxEvents.toLocaleString()} events). The program may contain an infinite loop, or it does more work than can be visualized; reduce loop sizes to trace the full run.`);
    const full = {
      ...ev,
      seq: this.events.length,
      time: this.now(),
      taskId: ev.taskId !== undefined ? ev.taskId : this.currentTask?.id ?? null,
    } as TraceEvent;
    if (full.line === undefined && this.currentLine !== undefined && LINE_KINDS.has(full.kind)) full.line = this.currentLine;
    this.events.push(full);
  }

  halt(code: HaltCode, message: string): never {
    if (!this.halted) this.halted = new RuntimeSignal('halt', code, message);
    throw this.halted;
  }

  exit(code: number): never {
    if (!this.halted) this.halted = new RuntimeSignal('exit', 'exit', `process.exit(${code})`, code);
    throw this.halted;
  }

  crash(): never {
    if (!this.halted) this.halted = new RuntimeSignal('crash', 'crash', 'Process crashed', 1);
    throw this.halted;
  }

  /** After a stop signal: pop every frame and close every open task. */
  abortAll(): void {
    while (this.stack.length) this.popTop();
    while (this.tasks.length) this.emit({ kind: 'task-end', id: this.tasks.pop()!.id, status: 'error', taskId: null }, true);
  }

  private tick(): void {
    if (this.halted) throw this.halted;
    this.clock.us += OP_COST_US;
    if (++this.ops > this.limits.maxOps)
      this.halt('op-limit', `Execution stopped after ${this.limits.maxOps.toLocaleString()} operations — likely an infinite loop.`);
    if ((this.ops & 1023) === 0 && wallNow() - this.startedAt > this.limits.maxWallMs)
      this.halt('time-limit', `Execution stopped after ${this.limits.maxWallMs / 1000}s of CPU time — likely an infinite loop.`);
  }

  ser(v: unknown, depth = 2): SV {
    this.paused++;
    try {
      return this.serializer.serialize(v, depth);
    } finally {
      this.paused--;
    }
  }

  private makeFrame(fnId: number, kind: FrameInfo['kind'], parent: RtFrame | null, info: Partial<FrameInfo>): RtFrame {
    const id = ++this.frameSeq;
    return {
      id,
      fnId,
      kind,
      parent,
      captured: false,
      suspended: false,
      taskId: this.currentTask?.id ?? null,
      info: { id, kind, name: '', layoutKey: `frame-${id}`, ...info } as FrameInfo,
    };
  }

  // ---------------------------------------------------------------- tasks
  beginTask(task: TaskInfo, queue: QueueId | 'main' | 'internal'): number {
    if (this.halted) throw this.halted;
    if (this.events.length >= this.limits.maxEvents) this.halt('trace-limit', `Trace limit reached (${this.limits.maxEvents.toLocaleString()} events).`);
    const base = this.stack.length;
    this.tasks.push(task);
    let frameId: number | undefined;
    if (task.kind !== 'await') {
      const f = this.makeFrame(-1, 'task', null, { name: task.label, taskId: task.id, layoutKey: `task-${task.id}`, line: task.line });
      f.callbackFnId = task.fnId;
      this.stack.push(f);
      frameId = f.id;
    }
    const line = task.fnId !== undefined ? this.meta.functions[task.fnId]?.line : undefined;
    this.currentLine = line;
    this.emit({ kind: 'task-start', task, queue, frameId, line, taskId: task.id });
    return base;
  }

  endTask(task: TaskInfo, status: 'ok' | 'error', base: number): void {
    while (this.stack.length > base) this.popTop();
    this.emit({ kind: 'task-end', id: task.id, status, taskId: task.id }, true);
    this.tasks.pop();
    this.currentLine = undefined;
  }

  unwindTo(depth: number): void {
    while (this.stack.length > depth) this.popTop();
  }

  get depth(): number {
    return this.stack.length;
  }

  private popTop(): void {
    const f = this.stack.pop()!;
    const ret = f.returning;
    this.emit({
      kind: 'exit',
      frameId: f.id,
      reason: ret ? 'return' : 'unwind',
      value: ret ? this.ser(ret.value, 1) : undefined,
      retained: f.kind !== 'task' && (f.captured || f.fnId === 0),
    }, true);
  }

  private resume(frame: RtFrame, reason: 'await' | 'yield' | 'lazy'): void {
    frame.suspended = false;
    this.stack.push(frame);
    this.emit({ kind: 'resume', frameId: frame.id, reason });
  }

  resumeAwait(frame: RtFrame): void {
    if (frame.suspended) this.resume(frame, 'await');
  }

  /** Make `frame` the top of the stack: pops frames abandoned by exceptions, re-pushes lazily resumed ones. */
  private sync(frame: RtFrame): void {
    if (frame.suspended) {
      this.resume(frame, 'lazy');
      return;
    }
    const idx = this.stack.lastIndexOf(frame);
    if (idx === -1) {
      this.resume(frame, 'lazy');
      return;
    }
    while (this.stack.length - 1 > idx) this.popTop();
  }

  // ---------------------------------------------------------------- variables
  private collect(frame: RtFrame, refs: { n: string; o: number }[], reader: Reader | undefined, tdz: string[]): VarUpdate[] | undefined {
    const out: VarUpdate[] = [];
    if (reader && refs.length) {
      let values: unknown[] | null = null;
      this.paused++;
      try {
        values = reader();
      } catch {
        values = null;
      } finally {
        this.paused--;
      }
      if (values) {
        for (let i = 0; i < refs.length; i++) {
          const ref = refs[i]!;
          const owner = ref.o === -1 ? frame : this.findOwner(frame, ref.o);
          if (owner) this.diffPush(out, owner.id, ref.n, values[i]);
        }
      }
    }
    for (const n of tdz) this.diffPush(out, frame.id, n, TDZ);
    return out.length ? out : undefined;
  }

  private findOwner(frame: RtFrame, fnId: number): RtFrame | null {
    for (let f = frame.parent; f; f = f.parent) if (f.fnId === fnId) return f;
    return null;
  }

  private diffPush(out: VarUpdate[], scope: number, name: string, raw: unknown): void {
    const key = `${scope}|${name}`;
    const primitive = raw === null || (typeof raw !== 'object' && typeof raw !== 'function');
    if (primitive && this.lastRaw.has(key) && Object.is(this.lastRaw.get(key), raw)) return;
    const sv: SV = raw === TDZ ? { t: 'tdz' } : this.ser(raw);
    const json = JSON.stringify(sv);
    this.lastRaw.set(key, raw);
    if (this.lastJson.get(key) === json) return;
    this.lastJson.set(key, json);
    out.push({ scope, name, value: sv });
  }

  // ---------------------------------------------------------------- hooks (called by instrumented code)
  readonly hooks = {
    /** statement */
    s: (frame: RtFrame, stmtId: number, reader?: Reader): void => {
      if (this.paused || frame === this.dummy) return;
      this.tick();
      this.sync(frame);
      const meta = this.meta.statements[stmtId]!;
      this.currentLine = meta.line;
      const vars = this.collect(frame, meta.vars, reader, meta.tdz);
      this.emit({ kind: 'step', stmtId, frameId: frame.id, line: meta.line, vars });
    },
    /** function entry */
    e: (fnId: number, parent: RtFrame | null, args: unknown[]): RtFrame => {
      if (this.paused) return this.dummy;
      this.tick();
      const meta = this.meta.functions[fnId]!;
      const frame = this.makeFrame(fnId, fnId === 0 ? 'main' : 'function', parent, {
        name: meta.name,
        fnId,
        async: meta.async,
        generator: meta.generator,
        line: meta.line,
        parentScopeId: parent?.id ?? null,
        args: meta.params.slice(0, 6).map((name, i) => ({ name, value: this.ser(args[i], 1) })),
      });
      const top = this.stack[this.stack.length - 1];
      let mergedFrameId: number | undefined;
      if (top && top.kind === 'task' && top.taskId === frame.taskId && top.callbackFnId === fnId) {
        frame.info.layoutKey = top.info.layoutKey;
        mergedFrameId = top.id;
        this.stack[this.stack.length - 1] = frame;
      } else this.stack.push(frame);
      const vars: VarUpdate[] = [];
      meta.params.forEach((p, i) => this.diffPush(vars, frame.id, p, args[i]));
      this.emit({ kind: 'enter', frame: frame.info, mergedFrameId, line: meta.line, vars: vars.length ? vars : undefined });
      return frame;
    },
    /** return (pops the frame) */
    r: <T>(frame: RtFrame, value: T, stmtId: number, reader?: Reader): T => {
      if (this.paused || frame === this.dummy) return value;
      this.tick();
      this.sync(frame);
      const refs = stmtId >= 0 ? this.meta.statements[stmtId]!.vars : this.meta.exitVars[frame.fnId] ?? [];
      const vars = this.collect(frame, refs, reader, []);
      this.stack.pop();
      this.emit({
        kind: 'exit',
        frameId: frame.id,
        reason: 'return',
        value: this.ser(value, 1),
        retained: frame.captured || frame.fnId === 0,
        vars,
      });
      return value;
    },
    /** return inside try/finally: record the value, pop lazily */
    rv: <T>(frame: RtFrame, value: T): T => {
      if (this.paused || frame === this.dummy) return value;
      this.sync(frame);
      frame.returning = { value };
      return value;
    },
    /** catch clause entry */
    c: (frame: RtFrame, err: unknown): void => {
      if (this.paused || frame === this.dummy) return;
      this.tick();
      this.sync(frame);
      this.emit({ kind: 'catch', frameId: frame.id, error: this.ser(err, 1) });
    },
    /** loop guard */
    g: (): void => {
      if (!this.paused) this.tick();
    },
    /** function object creation */
    fn: <F>(fnId: number, fn: F, parent: RtFrame | null, specName?: string): F => {
      if (typeof fn !== 'function') return fn;
      this.fnIds.set(fn, fnId);
      if (specName && fn.name === '') Object.defineProperty(fn, 'name', { value: specName, configurable: true });
      const owners = this.meta.functions[fnId]?.captures ?? [];
      for (let f: RtFrame | null = parent; f; f = f.parent) if (owners.includes(f.fnId)) f.captured = true;
      return fn;
    },
    /** await: suspend the frame and hand the awaited value to the async driver */
    aw: (frame: RtFrame, value: unknown): AwaitSignal => {
      if (!this.paused && frame !== this.dummy) {
        this.tick();
        this.sync(frame);
        this.stack.pop();
        frame.suspended = true;
        this.emit({ kind: 'suspend', frameId: frame.id, reason: 'await', value: this.ser(value, 1) });
      }
      return { [AWAIT_SIGNAL]: true, frame, value };
    },
    /** yield (user generators) */
    ys: <T>(frame: RtFrame, value: T): T => {
      if (this.paused || frame === this.dummy) return value;
      this.tick();
      this.sync(frame);
      this.stack.pop();
      frame.suspended = true;
      this.emit({ kind: 'suspend', frameId: frame.id, reason: 'yield', value: this.ser(value, 1) });
      return value;
    },
    yr: <T>(frame: RtFrame, sent: T): T => {
      if (!this.paused && frame !== this.dummy && frame.suspended) this.resume(frame, 'yield');
      return sent;
    },
    /** TDZ-safe read */
    q: (thunk: () => unknown): unknown => {
      try {
        return thunk();
      } catch {
        return TDZ;
      }
    },
  };

  fnLabel(fn: unknown): { label: string; fnId?: number; name?: string } {
    if (typeof fn !== 'function') return { label: String(fn) };
    const fnId = this.fnIds.get(fn);
    const meta = fnId !== undefined ? this.meta.functions[fnId] : undefined;
    if (meta) {
      const named = meta.name !== '(anonymous)' && !meta.name.endsWith(' callback');
      return { label: named ? meta.name : meta.snippet, fnId, name: meta.name };
    }
    return { label: fn.name ? `${fn.name} (native)` : '(native function)', name: fn.name };
  }
}
