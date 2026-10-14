import { instrument } from '../instrument/instrument';
import type { Diagnostic, ProgramMeta, RunLimits, RunOptions, RunResult, RunStatus, TraceEvent } from '../types';
import { createEnvironment } from './apis';
import { EventLoop, type Job } from './loop';
import { createPromiseClass, type PromiseHost, type PromiseRuntime } from './promise';
import { ValueSerializer, type ValueIntrospection } from './serialize';
import { AWAIT_SIGNAL, DEFAULT_LIMITS, isSignal, Tracer, wallNow, type AwaitSignal } from './tracer';

// Captured before any user code runs.
const globalEval: (code: string) => unknown = globalThis.eval;
const nativeToString = Function.prototype.toString;

type GenFn = (this: unknown, ...args: unknown[]) => Generator<unknown, unknown, unknown>;

/** Drives a transformed async function (a generator yielding AwaitSignals) with spec Await semantics. */
function makeAsyncDriver(tracer: Tracer, promises: PromiseRuntime, meta: ProgramMeta) {
  return (genFn: GenFn, thisArg: unknown, args: ArrayLike<unknown> | null, fnId: number) => {
    const name = meta.functions[fnId]?.name ?? 'async function';
    const cap = promises.newCapability(`${name}() result`);
    const gen = genFn.apply(thisArg, args ? Array.from(args) : []);
    const step = (method: 'next' | 'throw', arg: unknown, depth: number) => {
      let res: IteratorResult<unknown>;
      try {
        res = method === 'next' ? gen.next(arg) : gen.throw(arg);
      } catch (err) {
        if (isSignal(err)) throw err;
        tracer.unwindTo(depth);
        cap.reject(err);
        return;
      }
      if (res.done) {
        cap.resolve(res.value);
        return;
      }
      const sig = res.value as AwaitSignal;
      if (!sig || !sig[AWAIT_SIGNAL]) {
        step('throw', new TypeError('Unexpected yield inside async function'), tracer.depth);
        return;
      }
      const resume = (m: 'next' | 'throw') => (v: unknown) => {
        const d = tracer.depth;
        tracer.resumeAwait(sig.frame);
        step(m, v, d);
      };
      const r = promises.awaitValue(sig.value, resume('next'), resume('throw'), {
        label: `resume ${name}() after await`,
        fnId,
        frame: sig.frame,
      });
      if (!r.ok) step('throw', r.error, tracer.depth);
    };
    step('next', undefined, tracer.depth);
    return cap.promise;
  };
}

/** Temporarily defines properties on `target`; returns a function restoring the originals. */
function mount(target: object, props: Record<string, unknown>): () => void {
  const saved: [string, PropertyDescriptor | undefined][] = [];
  for (const [key, value] of Object.entries(props)) {
    const prev = Object.getOwnPropertyDescriptor(target, key);
    try {
      Object.defineProperty(target, key, { value, writable: true, configurable: true, enumerable: false });
      saved.push([key, prev]);
    } catch {
      /* non-configurable host property: leave it */
    }
  }
  return () => {
    for (const [key, prev] of saved.reverse()) {
      try {
        if (prev) Object.defineProperty(target, key, prev);
        else delete (target as Record<string, unknown>)[key];
      } catch {
        /* user code made it non-configurable */
      }
    }
  };
}

function failure(mode: RunOptions['mode'], meta: ProgramMeta, diagnostics: Diagnostic[], started: number): RunResult {
  const d = diagnostics[0]!;
  const base = { time: 0, taskId: null } as const;
  const events: TraceEvent[] = [
    { ...base, seq: 0, kind: 'run-start', mode },
    {
      ...base,
      seq: 1,
      kind: 'error',
      line: d.line,
      fatal: true,
      source: 'syntax',
      error: { name: d.message.split(':')[0] ?? 'Error', message: d.message, value: { t: 'string', v: d.message }, line: d.line },
    },
    { ...base, seq: 2, kind: 'run-end', status: 'crashed', exitCode: 1 },
  ];
  return { mode, events, meta, console: [], status: 'crashed', exitCode: 1, warnings: [], wallMs: wallNow() - started, diagnostics };
}

export function execute(opts: RunOptions): RunResult {
  const started = wallNow();
  const mode = opts.mode;
  const limits: RunLimits = { ...DEFAULT_LIMITS, ...opts.limits };
  // Browser scripts run as global code (top-level var/function become window properties);
  // Node programs run inside the CommonJS module wrapper, exactly like a real .js file.
  const inst = instrument(opts.source, { wrapProgram: mode === 'browser' });
  if (!inst.ok) return failure(mode, inst.meta, inst.diagnostics, started);
  const meta = inst.meta;

  let promises!: PromiseRuntime;
  let tracer!: Tracer;
  const intro: ValueIntrospection = {
    fnInfo: (fn) => {
      const id = tracer.fnIds.get(fn);
      const m = id === undefined ? undefined : meta.functions[id];
      return m ? { name: m.name, async: m.async, generator: m.generator } : undefined;
    },
    promiseInfo: (v) => {
      const i = promises.inspect(v);
      return i ? { pid: i.pid, state: i.state, value: i.value } : undefined;
    },
  };
  tracer = new Tracer(meta, limits, new ValueSerializer(intro));
  const loop = new EventLoop(mode, tracer, limits);

  const host: PromiseHost = {
    enqueueJob(run, info) {
      const task = loop.newTask(info.kind, info.label, { fnId: info.fnId, promiseId: info.promiseId, frameId: info.frame?.id });
      const api = info.kind === 'await' ? 'await' : info.kind === 'thenable' ? 'resolve(thenable)' : 'promise reaction';
      loop.queueMicrotask(task, run, api);
    },
    rejectionTracker(p, op) {
      if (op === 'reject') {
        loop.unhandled.add(p);
        loop.pendingRejections.push(p);
      } else loop.unhandled.delete(p);
    },
    trace(op, p) {
      const i = promises.inspect(p);
      if (!i || i.internal) return;
      tracer.emit({
        kind: 'promise',
        op,
        promise: { id: i.pid, state: i.state, origin: i.origin, value: i.state === 'pending' ? undefined : tracer.ser(i.value, 1) },
      });
    },
    guard(fn) {
      const depth = tracer.depth;
      try {
        return { ok: true, value: fn() };
      } catch (error) {
        if (isSignal(error)) throw error;
        tracer.unwindTo(depth);
        return { ok: false, error };
      }
    },
    fnLabel: (fn) => tracer.fnLabel(fn),
  };
  promises = createPromiseClass(host);
  const env = createEnvironment({ mode, source: opts.source, tracer, loop, promises, intro, limits });
  loop.host = env.host;
  Object.assign(tracer.hooks, { async: makeAsyncDriver(tracer, promises, meta) });

  const globals: Record<string, unknown> = { ...env.globals };
  let runMain: () => void;
  if (env.moduleParams) {
    const params = env.moduleParams;
    const names = Object.keys(params);
    let compiled: Function;
    try {
      compiled = new Function('__rt', ...names, inst.code);
    } catch (err) {
      const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      return failure(mode, meta, [{ severity: 'error', message, line: 1, column: 1 }], started);
    }
    const values = names.map((n) => params[n]);
    runMain = () => void compiled.call(env.thisValue, tracer.hooks, ...values);
  } else {
    globals.__rt = tracer.hooks;
    runMain = () => void globalEval(inst.code);
  }
  // fn.toString() must show the user's source, not the instrumented body.
  const source = opts.source;
  const toString = {
    toString(this: unknown): string {
      const id = typeof this === 'function' ? tracer.fnIds.get(this) : undefined;
      const fn = id === undefined ? undefined : meta.functions[id];
      return fn ? source.slice(fn.start, fn.end) : nativeToString.call(this as Function);
    },
  }.toString;
  const main: Job = { task: loop.newTask('main', '(main script)', { line: 1, fnId: 0 }), run: runMain };

  let status: RunStatus = 'completed';
  let exitCode = 0;
  const unmount = [mount(globalThis, globals), mount(Function.prototype, { toString })];
  tracer.emit({ kind: 'run-start', mode, taskId: null }, true);
  try {
    if (mode === 'node') {
      loop.runNode(main);
      env.host.exit(env.exitCode());
    } else loop.runBrowser(main);
    exitCode = env.exitCode();
  } catch (err) {
    if (isSignal(err)) {
      status = err.reason === 'halt' ? 'halted' : err.reason === 'crash' ? 'crashed' : 'exited';
      exitCode = err.exitCode;
      if (err.reason === 'halt' && err.code !== 'exit' && err.code !== 'crash')
        tracer.emit({ kind: 'limit', code: err.code, message: err.message }, true);
    } else {
      status = 'halted';
      exitCode = 1;
      tracer.emit({ kind: 'limit', code: 'internal-error', message: `Internal simulator error: ${err instanceof Error ? err.message : String(err)}` }, true);
    }
    tracer.abortAll();
  } finally {
    for (const undo of unmount.reverse()) undo();
  }
  tracer.emit({ kind: 'run-end', status, exitCode, taskId: null }, true);
  const consoleLines = tracer.events.flatMap((e) => (e.kind === 'console' ? [{ level: e.level, text: e.text }] : []));
  return {
    mode,
    events: tracer.events,
    meta,
    console: consoleLines,
    status,
    exitCode,
    warnings: loop.warnings,
    wallMs: wallNow() - started,
    diagnostics: [],
  };
}
