import type { Phase, QueueId, RunLimits, RuntimeMode, TaskInfo, TaskKind } from '../types';
import { isSignal, type Tracer } from './tracer';

export interface Job {
  task: TaskInfo;
  run: () => void;
  cancelled?: boolean;
  started?: boolean;
}

export interface Timer extends Job {
  handle: number;
  fn: Function;
  args: unknown[];
  /** Interval period in ms, or null for one-shot timers. */
  repeat: number | null;
  /** Absolute due time in µs (browser ordering; display in both modes). */
  dueUs: number;
  /** Node: integer-millisecond start (getLibuvNow()) and the duration list the timer lives in. */
  startMs: number;
  msecs: number;
  seq: number;
  ref: boolean;
  queued: boolean;
  nesting: number;
  thisArg: unknown;
}

/** Node keeps one list per timer duration; lists are prioritized by (expiry, id). */
interface TimerList {
  msecs: number;
  expiry: number;
  id: number;
  items: Timer[];
}

interface IoOp extends Job {
  completeUs: number;
  seq: number;
}

/** Services the loop needs from the API layer (process listeners, error reporting). */
export interface LoopHost {
  uncaught(error: unknown, source: 'uncaught' | 'unhandled-rejection', promise?: object, line?: number): 'fatal' | 'handled';
  promiseValue(p: object): unknown;
  beforeExit(): boolean;
}

type Wake = { at: number; reason: string };

const TIMEOUT_MAX = 2 ** 31 - 1;
const FRAME_US = 16_667;
const byDue = (a: Timer, b: Timer) => a.dueUs - b.dueUs || a.seq - b.seq;
const isTimer = (j: Job): j is Timer => 'repeat' in j && 'handle' in j;

/**
 * Deterministic event loop over virtual time.
 * Node mode mirrors libuv >= 1.45 (timers once before the loop, then pending → idle/prepare →
 * poll → check → close → timers) and lib/internal/timers.js (per-duration lists, processTimers /
 * listOnTimeout), with processTicksAndRejections after every callback.
 * Browser mode follows the HTML model: one task, then a microtask checkpoint, with rendering
 * opportunities at 60 Hz frame boundaries.
 */
export class EventLoop {
  nextTicks: Job[] = [];
  microtasks: Job[] = [];
  immediates: Job[] = [];
  macrotasks: Job[] = [];
  rafs: Job[] = [];
  io: IoOp[] = [];
  readonly timers = new Map<number, Timer>();
  readonly unhandled = new Set<object>();
  readonly warnings: string[] = [];
  pendingRejections: object[] = [];
  host!: LoopHost;
  iteration = 0;
  frameTimeMs = 0;
  private readonly lists = new Map<number, TimerList>();
  private listSeq = 0;
  private lastFrameUs = 0;
  private taskSeq = 0;
  private handleSeq = 0;
  private seq = 0;
  private tasksRun = 0;
  private immediateBatch: Job[] = [];
  private readonly raceNoted = new Set<number>();

  constructor(
    readonly mode: RuntimeMode,
    readonly tracer: Tracer,
    readonly limits: RunLimits,
  ) {}

  get nowUs(): number {
    return this.tracer.clock.us;
  }

  /** libuv's millisecond clock, as returned by Node's getLibuvNow(). */
  nowMs(): number {
    return Math.floor(this.tracer.clock.us / 1000);
  }

  newTask(kind: TaskKind, label: string, extra: Partial<TaskInfo> = {}): TaskInfo {
    const current = this.tracer.currentTask;
    return {
      id: ++this.taskSeq,
      kind,
      label,
      createdAt: this.tracer.now(),
      parentId: current?.id ?? null,
      line: current ? this.tracer.currentLine : undefined,
      ...extra,
    };
  }

  // ------------------------------------------------------------------ running callbacks
  runJob(job: Job, queue: QueueId | 'main' | 'internal'): void {
    if (++this.tasksRun > this.limits.maxTasks)
      this.tracer.halt(
        'task-limit',
        `Stopped after ${this.limits.maxTasks.toLocaleString()} callbacks: something keeps scheduling work (an uncleared interval or a recursive scheduler).`,
      );
    job.started = true;
    const base = this.tracer.beginTask(job.task, queue);
    let failure: { error: unknown; line?: number } | null = null;
    try {
      job.run();
    } catch (error) {
      if (isSignal(error)) throw error;
      failure = { error, line: this.tracer.currentLine };
      this.tracer.unwindTo(base);
    }
    this.tracer.endTask(job.task, failure ? 'error' : 'ok', base);
    if (failure && this.host.uncaught(failure.error, 'uncaught', undefined, failure.line) === 'fatal') this.tracer.crash();
  }

  private starve(queue: string): never {
    return this.tracer.halt(
      'microtask-starvation',
      `The ${queue} queue never emptied: over ${this.limits.maxMicrotasksPerCheckpoint.toLocaleString()} callbacks ran in one checkpoint because each one queued another. The event loop could never move on.`,
    );
  }

  private checkpoint(queue: 'nextTick' | 'microtask', state: 'start' | 'end'): void {
    this.tracer.emit({ kind: 'checkpoint', queue, state, taskId: null }, true);
  }

  runMicrotasks(): void {
    if (!this.microtasks.length) return;
    this.checkpoint('microtask', 'start');
    let n = 0;
    while (this.microtasks.length) {
      if (++n > this.limits.maxMicrotasksPerCheckpoint) this.starve('microtask');
      this.runJob(this.microtasks.shift()!, 'microtask');
    }
    this.checkpoint('microtask', 'end');
  }

  /** Node's processTicksAndRejections: nextTicks, then all microtasks, repeat; then rejections. */
  drainNode(): void {
    do {
      if (this.nextTicks.length) {
        this.checkpoint('nextTick', 'start');
        let n = 0;
        while (this.nextTicks.length) {
          if (++n > this.limits.maxMicrotasksPerCheckpoint) this.starve('process.nextTick');
          this.runJob(this.nextTicks.shift()!, 'nextTick');
        }
        this.checkpoint('nextTick', 'end');
      }
      this.runMicrotasks();
    } while (this.nextTicks.length || this.processRejections());
  }

  private checkpointBrowser(): void {
    this.runMicrotasks();
    this.processRejections();
  }

  private processRejections(): boolean {
    if (!this.pendingRejections.length) return false;
    const list = this.pendingRejections;
    this.pendingRejections = [];
    let acted = false;
    for (const p of list) {
      if (!this.unhandled.delete(p)) continue;
      acted = true;
      if (this.host.uncaught(this.host.promiseValue(p), 'unhandled-rejection', p) === 'fatal') this.tracer.crash();
    }
    return acted || this.pendingRejections.length > 0;
  }

  // ------------------------------------------------------------------ scheduling
  queueMicrotask(task: TaskInfo, run: () => void, api: string): void {
    this.microtasks.push({ task, run });
    this.tracer.emit({ kind: 'schedule', task, target: 'microtask', api });
  }

  queueNextTick(task: TaskInfo, run: () => void): void {
    this.nextTicks.push({ task, run });
    this.tracer.emit({ kind: 'schedule', task, target: 'nextTick', api: 'process.nextTick' });
  }

  queueImmediate(task: TaskInfo, run: () => void, api = 'setImmediate'): Job {
    const job: Job = { task, run };
    this.immediates.push(job);
    this.tracer.emit({ kind: 'schedule', task, target: 'check', api });
    return job;
  }

  cancelImmediate(job: Job): void {
    if (job.started || job.cancelled) return;
    const i = this.immediates.indexOf(job);
    if (i < 0 && !this.immediateBatch.includes(job)) return;
    job.cancelled = true;
    if (i >= 0) this.immediates.splice(i, 1);
    this.tracer.emit({ kind: 'cancel', id: job.task.id, api: 'clearImmediate' });
  }

  addTimer(o: { fn: Function; delay: unknown; args: unknown[]; repeat: boolean; api: string; label?: string }): Timer {
    let delay = Number(o.delay);
    let nesting = 0;
    if (this.mode === 'node') {
      if (!(delay >= 1 && delay <= TIMEOUT_MAX)) delay = 1;
      delay = Math.trunc(delay);
    } else {
      delay = Number.isFinite(delay) ? Math.trunc(delay) | 0 : 0;
      if (delay < 0) delay = 0;
      const cur = this.tracer.currentTask;
      nesting = cur && (cur.kind === 'timeout' || cur.kind === 'interval') ? (cur.nesting ?? 0) : 0;
      if (nesting > 5 && delay < 4) delay = 4;
    }
    const startMs = this.nowMs();
    const dueUs = this.mode === 'node' ? (startMs + delay) * 1000 : this.nowUs + delay * 1000;
    const handle = ++this.handleSeq;
    const info = this.tracer.fnLabel(o.fn);
    const task = this.newTask(o.repeat ? 'interval' : 'timeout', o.label ?? info.label, {
      fnId: o.label ? undefined : info.fnId,
      delay,
      dueAt: dueUs / 1000,
      handle,
      nesting: nesting + 1,
    });
    const timer: Timer = {
      task,
      run: () => void timer.fn.apply(timer.thisArg, timer.args),
      handle,
      fn: o.fn,
      args: o.args,
      repeat: o.repeat ? delay : null,
      dueUs,
      startMs,
      msecs: delay,
      seq: ++this.seq,
      ref: true,
      queued: false,
      nesting: nesting + 1,
      thisArg: undefined,
    };
    this.timers.set(handle, timer);
    if (this.mode === 'node') this.listInsert(timer, delay, startMs);
    this.tracer.emit({ kind: 'schedule', task, target: 'webapi', api: o.api });
    return timer;
  }

  private listInsert(t: Timer, msecs: number, startMs: number): void {
    t.startMs = startMs;
    t.msecs = msecs;
    t.dueUs = (startMs + msecs) * 1000;
    let list = this.lists.get(msecs);
    if (!list) {
      list = { msecs, expiry: startMs + msecs, id: ++this.listSeq, items: [] };
      this.lists.set(msecs, list);
    }
    list.items.push(t);
  }

  clearTimer(handle: number | undefined, api: string): void {
    const t = handle === undefined ? undefined : this.timers.get(handle);
    if (!t) return;
    this.timers.delete(t.handle);
    t.cancelled = true;
    if (this.mode === 'node') {
      const list = this.lists.get(t.msecs);
      if (list) {
        const i = list.items.indexOf(t);
        if (i >= 0) list.items.splice(i, 1);
        if (!list.items.length) this.lists.delete(t.msecs);
      }
    } else if (t.queued) this.macrotasks = this.macrotasks.filter((j) => j !== t);
    t.queued = false;
    this.tracer.emit({ kind: 'cancel', id: t.task.id, api });
  }

  addIo(o: { label: string; detail: string; api: string; latencyMs: number; fnId?: number; run: () => void }): void {
    const completeUs = this.nowUs + o.latencyMs * 1000;
    const task = this.newTask('io', o.label, { fnId: o.fnId, detail: o.detail, delay: o.latencyMs, dueAt: completeUs / 1000 });
    this.io.push({ task, run: o.run, completeUs, seq: ++this.seq });
    this.tracer.emit({ kind: 'schedule', task, target: 'webapi', api: o.api });
  }

  addRaf(fn: Function): number {
    const info = this.tracer.fnLabel(fn);
    const handle = ++this.handleSeq;
    const task = this.newTask('raf', info.label, { fnId: info.fnId, handle });
    this.rafs.push({ task, run: () => void fn(this.frameTimeMs) });
    this.tracer.emit({ kind: 'schedule', task, target: 'raf', api: 'requestAnimationFrame' });
    return handle;
  }

  cancelRaf(handle: number): void {
    const i = this.rafs.findIndex((j) => j.task.handle === handle);
    if (i < 0) return;
    const [job] = this.rafs.splice(i, 1);
    job!.cancelled = true;
    this.tracer.emit({ kind: 'cancel', id: job!.task.id, api: 'cancelAnimationFrame' });
  }

  private runTimer(t: Timer, queue: QueueId): void {
    t.queued = false;
    if (t.repeat === null) this.timers.delete(t.handle);
    const startMs = this.nowMs();
    this.runJob(t, queue);
    if (t.repeat === null || t.cancelled || this.timers.get(t.handle) !== t) return;
    t.nesting++;
    if (this.mode === 'browser' && t.nesting > 5 && t.repeat < 4) t.repeat = 4;
    const prev = t.task;
    t.seq = ++this.seq;
    t.started = false;
    if (this.mode === 'node') this.listInsert(t, t.repeat, startMs);
    else t.dueUs = this.nowUs + t.repeat * 1000;
    t.task = {
      ...prev,
      id: ++this.taskSeq,
      createdAt: this.tracer.now(),
      dueAt: t.dueUs / 1000,
      parentId: prev.id,
      nesting: t.nesting,
      repeatRun: (prev.repeatRun ?? 1) + 1,
    };
    this.tracer.emit({ kind: 'schedule', task: t.task, target: 'webapi', api: 'setInterval (re-armed)', taskId: null });
  }

  private idleUntil(targetUs: number, reason: string): void {
    if (targetUs > this.limits.maxVirtualMs * 1000)
      this.tracer.halt(
        'virtual-time-limit',
        `The next callback is due at t=${(targetUs / 1000).toLocaleString()} ms, beyond the ${this.limits.maxVirtualMs / 60_000}-minute virtual time window.`,
      );
    this.tracer.emit({ kind: 'idle', from: this.tracer.now(), to: targetUs / 1000, reason, taskId: null }, true);
    this.tracer.clock.us = targetUs;
  }

  // ------------------------------------------------------------------ Node.js
  private phase(phase: Phase, empty: boolean): void {
    this.tracer.emit({ kind: 'phase', phase, iteration: this.iteration, empty, taskId: null }, true);
  }

  private aliveNode(): boolean {
    if (this.immediates.length || this.io.length) return true;
    for (const t of this.timers.values()) if (t.ref) return true;
    return false;
  }

  runNode(main: Job): void {
    this.runJob(main, 'main');
    this.drainNode();
    for (;;) {
      if (this.aliveNode()) this.uvRun();
      if (!this.host.beforeExit() || !this.aliveNode()) break;
    }
  }

  private uvRun(): void {
    this.runTimersNode();
    while (this.aliveNode()) {
      this.iteration++;
      this.phase('pending', true);
      this.phase('idle', true);
      this.pollNode();
      this.runImmediates();
      this.phase('close', true);
      this.runTimersNode();
    }
  }

  /** The timers processTimers(now) will run, in its exact order (dry run). */
  private dueTimersNode(now: number): Timer[] {
    const out: Timer[] = [];
    const lists = [...this.lists.values()].filter((l) => l.expiry <= now).sort((a, b) => a.expiry - b.expiry || a.id - b.id);
    for (const l of lists)
      for (const t of l.items) {
        if (now - t.startMs < l.msecs) break;
        out.push(t);
      }
    return out;
  }

  private runTimersNode(): void {
    const now = this.nowMs();
    const due = this.dueTimersNode(now);
    this.phase('timers', due.length === 0);
    this.noteRaces(now);
    for (const t of due) {
      t.queued = true;
      this.tracer.emit({ kind: 'enqueue', id: t.task.id, queue: 'timers', reason: 'timer expired', taskId: null });
    }
    for (;;) {
      let next: TimerList | undefined;
      for (const l of this.lists.values())
        if (!next || l.expiry < next.expiry || (l.expiry === next.expiry && l.id < next.id)) next = l;
      if (!next || next.expiry > now) return;
      this.listOnTimeout(next, now);
    }
  }

  private listOnTimeout(list: TimerList, now: number): void {
    for (;;) {
      const t = list.items[0];
      if (!t) break;
      if (now - t.startMs < list.msecs) {
        list.expiry = Math.max(t.startMs + list.msecs, now + 1);
        list.id = ++this.listSeq;
        return;
      }
      list.items.shift();
      this.runTimer(t, 'timers');
      this.drainNode();
    }
    if (this.lists.get(list.msecs) === list) this.lists.delete(list.msecs);
  }

  /**
   * A timer due within 1 ms while setImmediate callbacks wait is a real-world race: Node's
   * order depends on elapsed wall time. The simulator picks one order and says so.
   */
  private noteRaces(now: number): void {
    const imm = this.immediates.find((j) => !j.cancelled);
    if (!imm) return;
    for (const l of this.lists.values())
      for (const t of l.items) {
        const dueMs = t.startMs + l.msecs;
        if (dueMs <= now || dueMs - now > 1 || this.raceNoted.has(t.handle)) continue;
        this.raceNoted.add(t.handle);
        const message = `Timing-dependent order: the timer for ${t.task.label} (#${t.task.id}) was due in under 1 ms when the timers phase ran, while the setImmediate callback ${imm.task.label} (#${imm.task.id}) was waiting. In real Node.js this order is non-deterministic: it depends on how much real time has passed. The simulator assumes an ideal, fast CPU and runs the immediate first.`;
        if (this.warnings.length < 3) this.warnings.push(message);
        this.tracer.emit({ kind: 'note', code: 'timer-race', message, taskId: null }, true);
      }
  }

  private nextWakeNode(): Wake | null {
    let best: Wake | null = null;
    for (const l of this.lists.values()) {
      const at = l.expiry * 1000;
      if (!best || at < best.at) best = { at, reason: `the timer for ${l.items[0]?.task.label ?? 'a timer'} expires` };
    }
    for (const op of this.io)
      if (!best || op.completeUs < best.at) best = { at: op.completeUs, reason: `${op.task.detail ?? op.task.label} completes` };
    return best;
  }

  private pollNode(): void {
    let target = this.nowUs;
    let reason = '';
    if (!this.immediates.length) {
      const wake = this.nextWakeNode();
      if (wake && wake.at > target) {
        target = wake.at;
        reason = wake.reason;
      }
    }
    this.phase('poll', !this.io.some((op) => op.completeUs <= target));
    if (target > this.nowUs) this.idleUntil(target, `Nothing is ready, so the poll phase blocks until ${reason}.`);
    const now = this.nowUs;
    const done = this.io.filter((op) => op.completeUs <= now).sort((a, b) => a.completeUs - b.completeUs || a.seq - b.seq);
    if (!done.length) return;
    this.io = this.io.filter((op) => !done.includes(op));
    for (const op of done) this.tracer.emit({ kind: 'enqueue', id: op.task.id, queue: 'poll', reason: 'I/O completed', taskId: null });
    for (const op of done) {
      this.runJob(op, 'poll');
      this.drainNode();
    }
  }

  private runImmediates(): void {
    const batch = this.immediates;
    this.phase('check', batch.length === 0);
    if (!batch.length) return;
    this.immediates = [];
    this.immediateBatch = batch;
    for (const job of batch) {
      if (job.cancelled) continue;
      this.runJob(job, 'check');
      this.drainNode();
    }
    this.immediateBatch = [];
  }

  // ------------------------------------------------------------------ browser
  private nextFrameUs(): number {
    return (Math.floor(this.lastFrameUs / FRAME_US) + 1) * FRAME_US;
  }

  private nextWakeBrowser(): Wake | null {
    let best: Wake | null = null;
    for (const t of this.timers.values())
      if (!t.queued && (!best || t.dueUs < best.at)) best = { at: t.dueUs, reason: `the timer for ${t.task.label} (#${t.task.id}) is due` };
    for (const op of this.io)
      if (!best || op.completeUs < best.at) best = { at: op.completeUs, reason: `${op.task.detail ?? op.task.label} completes` };
    if (this.rafs.length) {
      const at = this.nextFrameUs();
      if (!best || at < best.at) best = { at, reason: 'the next animation frame' };
    }
    return best;
  }

  runBrowser(main: Job): void {
    this.runJob(main, 'main');
    this.checkpointBrowser();
    for (;;) {
      this.collectDue();
      if (this.rafs.length && this.nowUs >= this.nextFrameUs()) {
        this.render();
        continue;
      }
      const job = this.macrotasks.shift();
      if (job) {
        this.iteration++;
        this.phase('task', false);
        if (isTimer(job)) this.runTimer(job, 'task');
        else this.runJob(job, 'task');
        this.checkpointBrowser();
        continue;
      }
      const wake = this.nextWakeBrowser();
      if (!wake) break;
      if (wake.at > this.nowUs) this.idleUntil(wake.at, `Nothing to run until ${wake.reason}.`);
    }
  }

  private collectDue(): void {
    const due = [...this.timers.values()].filter((t) => !t.queued && t.dueUs <= this.nowUs).sort(byDue);
    for (const t of due) {
      t.queued = true;
      this.macrotasks.push(t);
      this.tracer.emit({ kind: 'enqueue', id: t.task.id, queue: 'task', reason: 'timer expired', taskId: null });
    }
    const now = this.nowUs;
    const done = this.io.filter((op) => op.completeUs <= now).sort((a, b) => a.completeUs - b.completeUs || a.seq - b.seq);
    if (!done.length) return;
    this.io = this.io.filter((op) => !done.includes(op));
    for (const op of done) {
      this.macrotasks.push(op);
      this.tracer.emit({ kind: 'enqueue', id: op.task.id, queue: 'task', reason: 'response ready', taskId: null });
    }
  }

  private render(): void {
    this.iteration++;
    this.lastFrameUs = this.nowUs;
    this.frameTimeMs = this.tracer.now();
    this.phase('render', false);
    const batch = this.rafs;
    this.rafs = [];
    for (const job of batch) {
      if (job.cancelled) continue;
      this.runJob(job, 'raf');
      this.checkpointBrowser();
    }
  }
}
