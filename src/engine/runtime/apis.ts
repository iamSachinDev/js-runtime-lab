import type { ConsoleLevel, RunLimits, RuntimeMode } from '../types';
import type { EventLoop, Job, LoopHost } from './loop';
import {
  Buffer,
  createEventEmitter,
  CWD,
  FETCH_FIXTURES,
  FILE_FIXTURES,
  invalidArg,
  NODE_CORE_MODULES,
  pathModule,
} from './modules';
import type { PromiseRuntime } from './promise';
import { formatArgs, inspect, type ValueIntrospection } from './serialize';
import type { Tracer } from './tracer';

export interface EnvContext {
  mode: RuntimeMode;
  source: string;
  tracer: Tracer;
  loop: EventLoop;
  promises: PromiseRuntime;
  intro: ValueIntrospection;
  limits: RunLimits;
}

export interface Environment {
  /** Properties mounted on the real global object for the duration of the run. */
  globals: Record<string, unknown>;
  /** CommonJS wrapper parameters (Node mode), or null for browser global code. */
  moduleParams: Record<string, unknown> | null;
  thisValue: unknown;
  host: LoopHost & { exit(code: number): void };
  exitCode(): number;
}

type Fn = (...args: unknown[]) => unknown;

export function createEnvironment(ctx: EnvContext): Environment {
  const { mode, tracer, loop, promises, intro, limits } = ctx;
  const isNode = mode === 'node';
  const P = promises.Promise;
  const show = (v: unknown) => {
    tracer.paused++;
    try {
      return inspect(v, intro);
    } finally {
      tracer.paused--;
    }
  };
  const callable = (v: unknown, name = 'callback'): Fn => {
    if (typeof v === 'function') return v as Fn;
    if (isNode) throw invalidArg(name, v);
    if (typeof v === 'string')
      throw new TypeError('String handlers are not supported in the sandbox (they would run untraced). Pass a function instead.');
    throw new TypeError(`Failed to execute: parameter 1 is not of type 'Function'.`);
  };

  // ------------------------------------------------------------------ console
  let lines = 0;
  let group = 0;
  const write = (level: ConsoleLevel, api: string, text: string) => {
    if (++lines > limits.maxConsoleLines)
      tracer.halt('console-limit', `Console output limit reached (${limits.maxConsoleLines.toLocaleString()} lines).`);
    const indented = group ? text.replace(/^/gm, '  '.repeat(group)) : text;
    tracer.emit({ kind: 'console', level, text: indented, api });
  };
  const out = (level: ConsoleLevel, api: string) => (...args: unknown[]) => {
    tracer.paused++;
    let text: string;
    try {
      text = formatArgs(args, intro);
    } finally {
      tracer.paused--;
    }
    write(level, api, text);
  };
  const counts = new Map<string, number>();
  const timers = new Map<string, number>();
  const table = (data: unknown) => {
    if (data === null || typeof data !== 'object') return out('log', 'console.table')(data);
    const rows = Object.entries(data as object);
    const cols: string[] = [];
    let values = false;
    for (const [, v] of rows) {
      if (v !== null && typeof v === 'object') for (const k of Object.keys(v)) !cols.includes(k) && cols.push(k);
      else values = true;
    }
    const cell = (v: unknown) => (v === undefined ? '' : show(v));
    const head = ['(index)', ...cols, ...(values ? ['Values'] : [])];
    const body = rows.map(([k, v]) => {
      const obj = v !== null && typeof v === 'object' ? (v as Record<string, unknown>) : null;
      return [k, ...cols.map((c) => (obj && c in obj ? cell(obj[c]) : '')), ...(values ? [obj ? '' : cell(v)] : [])];
    });
    const widths = head.map((h, i) => Math.max(h.length, ...body.map((r) => r[i]!.length)));
    const rule = (l: string, m: string, r: string) => l + widths.map((w) => '─'.repeat(w + 2)).join(m) + r;
    const row = (cells: string[]) => `│${cells.map((c, i) => ` ${c.padEnd(widths[i]!)} `).join('│')}│`;
    write('log', 'console.table', [rule('┌', '┬', '┐'), row(head), rule('├', '┼', '┤'), ...body.map(row), rule('└', '┴', '┘')].join('\n'));
  };
  const consoleObj = {
    log: out('log', 'console.log'),
    info: out('info', 'console.info'),
    debug: out('debug', 'console.debug'),
    warn: out('warn', 'console.warn'),
    error: out('error', 'console.error'),
    dir: (v: unknown) => write('log', 'console.dir', show(v)),
    trace: (...a: unknown[]) => out('error', 'console.trace')('Trace:', ...a),
    table,
    group: (...a: unknown[]) => {
      if (a.length) out('log', 'console.group')(...a);
      group++;
    },
    groupCollapsed: (...a: unknown[]) => consoleObj.group(...a),
    groupEnd: () => void (group = Math.max(0, group - 1)),
    count: (label: unknown = 'default') => {
      const k = String(label);
      const n = (counts.get(k) ?? 0) + 1;
      counts.set(k, n);
      write('log', 'console.count', `${k}: ${n}`);
    },
    countReset: (label: unknown = 'default') => void counts.delete(String(label)),
    time: (label: unknown = 'default') => void timers.set(String(label), tracer.now()),
    timeLog: (label: unknown = 'default', ...a: unknown[]) => consoleObj.timeEnd(label, false, ...a),
    timeEnd: (label: unknown = 'default', end: unknown = true, ...a: unknown[]) => {
      const k = String(label);
      const start = timers.get(k);
      if (start === undefined) return write('warn', 'console.timeEnd', `Warning: No such label '${k}' for console.timeEnd()`);
      if (end === true) timers.delete(k);
      out('log', 'console.timeEnd')(`${k}: ${(tracer.now() - start).toFixed(3)}ms`, ...a);
    },
    assert: (cond: unknown, ...a: unknown[]) => {
      if (!cond) out('error', 'console.assert')(a.length ? 'Assertion failed:' : 'Assertion failed', ...a);
    },
  };

  // ------------------------------------------------------------------ timers
  class Timeout {
    #h: number;
    constructor(h: number) {
      this.#h = h;
    }
    ref() {
      const t = loop.timers.get(this.#h);
      if (t) t.ref = true;
      return this;
    }
    unref() {
      const t = loop.timers.get(this.#h);
      if (t) t.ref = false;
      return this;
    }
    hasRef() {
      return loop.timers.get(this.#h)?.ref ?? false;
    }
    close() {
      loop.clearTimer(this.#h, 'timeout.close()');
      return this;
    }
    [Symbol.toPrimitive]() {
      return this.#h;
    }
  }
  class Immediate {
    ref() {
      return this;
    }
    unref() {
      return this;
    }
    hasRef() {
      return true;
    }
  }
  const immediateJobs = new WeakMap<object, Job>();
  const handleOf = (h: unknown): number | undefined =>
    h instanceof Timeout ? h[Symbol.toPrimitive]() : typeof h === 'number' || typeof h === 'string' ? Number(h) : undefined;

  const makeTimer = (repeat: boolean, api: string) =>
    function (fn: unknown, delay?: unknown, ...args: unknown[]) {
      const timer = loop.addTimer({ fn: callable(fn), delay, args, repeat, api });
      if (!isNode) return timer.handle;
      const obj = new Timeout(timer.handle);
      timer.thisArg = obj;
      return obj;
    };
  const setTimeoutV = makeTimer(false, 'setTimeout');
  const setIntervalV = makeTimer(true, 'setInterval');
  const clearTimeoutV = (h: unknown) => loop.clearTimer(handleOf(h), 'clearTimeout');
  const clearIntervalV = (h: unknown) => loop.clearTimer(handleOf(h), 'clearInterval');

  const setImmediateV = (fn: unknown, ...args: unknown[]) => {
    const cb = callable(fn);
    const info = tracer.fnLabel(cb);
    const imm = new Immediate();
    const job = loop.queueImmediate(loop.newTask('immediate', info.label, { fnId: info.fnId }), () => void cb.apply(imm, args));
    immediateJobs.set(imm, job);
    return imm;
  };
  const clearImmediateV = (imm: unknown) => {
    const job = imm && typeof imm === 'object' ? immediateJobs.get(imm) : undefined;
    if (job) loop.cancelImmediate(job);
  };
  const queueMicrotaskV = (fn: unknown) => {
    if (typeof fn !== 'function')
      throw isNode ? invalidArg('callback', fn) : new TypeError("Failed to execute 'queueMicrotask': parameter 1 is not of type 'Function'.");
    const info = tracer.fnLabel(fn);
    loop.queueMicrotask(loop.newTask('microtask', info.label, { fnId: info.fnId }), () => void (fn as Fn)(), 'queueMicrotask');
  };
  const nextTick = (fn: unknown, ...args: unknown[]) => {
    const cb = callable(fn);
    const info = tracer.fnLabel(cb);
    loop.queueNextTick(loop.newTask('nextTick', info.label, { fnId: info.fnId }), () => void cb(...args));
  };

  const custom = Symbol.for('nodejs.util.promisify.custom');
  const timersPromises = {
    setTimeout: (delay?: unknown, value?: unknown) => {
      const cap = promises.newCapability('timers/promises.setTimeout()');
      loop.addTimer({ fn: () => cap.resolve(value), delay, args: [], repeat: false, api: 'timers/promises.setTimeout', label: `resolve after ${Number(delay) || 1}ms` });
      return cap.promise;
    },
    setImmediate: (value?: unknown) => {
      const cap = promises.newCapability('timers/promises.setImmediate()');
      loop.queueImmediate(loop.newTask('immediate', 'resolve setImmediate promise'), () => cap.resolve(value), 'timers/promises.setImmediate');
      return cap.promise;
    },
  };
  Object.assign(setTimeoutV, { [custom]: timersPromises.setTimeout });
  Object.assign(setImmediateV, { [custom]: timersPromises.setImmediate });

  // ------------------------------------------------------------------ virtual clock
  const RealDate = Date;
  const epoch = RealDate.now();
  const virtualNow = () => epoch + Math.floor(tracer.now());
  const VDate = function (this: unknown, ...args: unknown[]) {
    if (!new.target) return new RealDate(virtualNow()).toString();
    return args.length ? new (RealDate as unknown as new (...a: unknown[]) => Date)(...args) : new RealDate(virtualNow());
  } as unknown as DateConstructor;
  Object.defineProperties(VDate, {
    prototype: { value: RealDate.prototype },
    now: { value: virtualNow },
    parse: { value: RealDate.parse },
    UTC: { value: RealDate.UTC },
  });
  const performanceV = { now: () => tracer.now(), timeOrigin: epoch, mark: () => undefined, measure: () => undefined };

  // ------------------------------------------------------------------ fetch (simulated fixtures)
  class Response {
    constructor(
      readonly url: string,
      readonly status: number,
      private readonly body: string,
    ) {}
    get ok() {
      return this.status >= 200 && this.status < 300;
    }
    get statusText() {
      return this.ok ? 'OK' : 'Internal Server Error';
    }
    readonly headers = new Map([['content-type', 'application/json']]);
    json() {
      return P.resolve(JSON.parse(this.body));
    }
    text() {
      return P.resolve(this.body);
    }
  }
  const fetchV = (input: unknown) => {
    const url = String(input);
    let pathname = url;
    try {
      pathname = new URL(url, 'https://api.example.test').pathname.replace(/\/+$/, '');
    } catch {
      /* keep raw */
    }
    const fx = FETCH_FIXTURES[pathname];
    const cap = promises.newCapability(`fetch('${url}')`);
    loop.addIo({
      label: fx ? `resolve fetch ${pathname}` : `reject fetch ${pathname}`,
      detail: `fetch('${url}')`,
      api: 'fetch',
      latencyMs: fx?.latencyMs ?? 30,
      run: () =>
        fx
          ? cap.resolve(new Response(url, fx.status ?? 200, JSON.stringify(fx.body)))
          : cap.reject(new TypeError(`Failed to fetch: the sandbox has no network. Simulated endpoints: ${Object.keys(FETCH_FIXTURES).join(', ')}`)),
    });
    return cap.promise;
  };

  // ------------------------------------------------------------------ fs (in-memory)
  const files = new Map<string, string>(Object.entries(FILE_FIXTURES));
  files.set(`${CWD}/index.js`, ctx.source);
  const resolvePath = (p: unknown) => pathModule.resolve(String(p));
  const enoent = (syscall: string, p: string) =>
    Object.assign(new Error(`ENOENT: no such file or directory, ${syscall} '${p}'`), { errno: -2, code: 'ENOENT', syscall, path: p });
  const encodingOf = (o: unknown) =>
    typeof o === 'string' ? o : o && typeof o === 'object' ? ((o as { encoding?: string }).encoding ?? null) : null;
  const contents = (p: string, enc: string | null) => (enc ? files.get(p)! : Buffer.from(files.get(p)!));
  const latency = (p: string) => 2 + Math.ceil((files.get(p)?.length ?? 0) / 8192);
  const ioCallback = (cb: Fn, detail: string, api: string, ms: number, run: () => void) => {
    const info = tracer.fnLabel(cb);
    loop.addIo({ label: info.label, fnId: info.fnId, detail, api, latencyMs: ms, run });
  };
  const ioPromise = (detail: string, api: string, ms: number, settle: (res: (v: unknown) => void, rej: (e: unknown) => void) => void) => {
    const cap = promises.newCapability(detail);
    loop.addIo({ label: `settle ${detail}`, detail, api, latencyMs: ms, run: () => settle(cap.resolve, cap.reject) });
    return cap.promise;
  };
  const fs = {
    readFile(p: unknown, opts: unknown, cb?: unknown) {
      if (typeof opts === 'function') [cb, opts] = [opts, undefined];
      const file = resolvePath(p);
      const enc = encodingOf(opts);
      const done = callable(cb, 'cb');
      ioCallback(done, `fs.readFile('${file}')`, 'fs.readFile', latency(file), () =>
        files.has(file) ? done(null, contents(file, enc)) : done(enoent('open', file)),
      );
    },
    writeFile(p: unknown, data: unknown, opts: unknown, cb?: unknown) {
      if (typeof opts === 'function') [cb, opts] = [opts, undefined];
      const file = resolvePath(p);
      const done = callable(cb, 'cb');
      ioCallback(done, `fs.writeFile('${file}')`, 'fs.writeFile', 4, () => {
        files.set(file, String(data));
        done(null);
      });
    },
    readdir(p: unknown, opts: unknown, cb?: unknown) {
      if (typeof opts === 'function') [cb, opts] = [opts, undefined];
      const dir = resolvePath(p);
      const done = callable(cb, 'cb');
      ioCallback(done, `fs.readdir('${dir}')`, 'fs.readdir', 2, () => done(null, fs.readdirSync(dir)));
    },
    readFileSync(p: unknown, opts?: unknown) {
      const file = resolvePath(p);
      if (!files.has(file)) throw enoent('open', file);
      return contents(file, encodingOf(opts));
    },
    writeFileSync(p: unknown, data: unknown) {
      files.set(resolvePath(p), String(data));
    },
    existsSync: (p: unknown) => files.has(resolvePath(p)),
    readdirSync(p: unknown) {
      const dir = resolvePath(p).replace(/\/$/, '');
      return [...files.keys()].filter((f) => pathModule.dirname(f) === dir).map((f) => pathModule.basename(f)).sort();
    },
    promises: {
      readFile(p: unknown, opts?: unknown) {
        const file = resolvePath(p);
        const enc = encodingOf(opts);
        return ioPromise(`fs.promises.readFile('${file}')`, 'fs.promises.readFile', latency(file), (res, rej) =>
          files.has(file) ? res(contents(file, enc)) : rej(enoent('open', file)),
        );
      },
      writeFile(p: unknown, data: unknown) {
        const file = resolvePath(p);
        return ioPromise(`fs.promises.writeFile('${file}')`, 'fs.promises.writeFile', 4, (res) => {
          files.set(file, String(data));
          res(undefined);
        });
      },
    },
  };

  // ------------------------------------------------------------------ process, util, require
  const EventEmitter = createEventEmitter(P, show);
  const proc = new EventEmitter() as InstanceType<typeof EventEmitter> & Record<string, unknown>;
  let exiting = false;
  let inUncaughtHandler = false;
  const listeners = (name: string) => proc.listenerCount(name) > 0;
  const runListeners = (label: string, name: string, args: unknown[]) =>
    loop.runJob({ task: loop.newTask('event', label, { parentId: null }), run: () => void proc.emit(name, ...args) }, 'internal');
  const exitCode = () => {
    const c = Number(proc.exitCode ?? 0);
    return Number.isFinite(c) ? c | 0 : 1;
  };
  const hrtime = (prev?: [number, number]) => {
    const ns = Math.round(tracer.clock.us * 1000);
    let s = Math.floor(ns / 1e9);
    let n = ns % 1e9;
    if (prev) {
      s -= prev[0];
      n -= prev[1];
      if (n < 0) {
        s--;
        n += 1e9;
      }
    }
    return [s, n];
  };
  Object.assign(proc, {
    nextTick,
    argv: ['/usr/local/bin/node', `${CWD}/index.js`],
    argv0: 'node',
    env: { NODE_ENV: 'development', HOME: '/home/app' },
    platform: 'linux',
    arch: 'x64',
    pid: 4242,
    ppid: 4200,
    title: 'node',
    version: 'v22.12.0',
    versions: { node: '22.12.0', v8: '12.4.254', uv: '1.49.2' },
    exitCode: undefined,
    cwd: () => CWD,
    uptime: () => tracer.now() / 1000,
    hrtime: Object.assign(hrtime, { bigint: () => BigInt(Math.round(tracer.clock.us * 1000)) }),
    memoryUsage: () => ({ rss: 41_943_040, heapTotal: 6_291_456, heapUsed: 4_718_592, external: 1_048_576, arrayBuffers: 16_384 }),
    stdout: { isTTY: false, write: (s: unknown) => (write('log', 'process.stdout.write', String(s).replace(/\n$/, '')), true) },
    stderr: { isTTY: false, write: (s: unknown) => (write('error', 'process.stderr.write', String(s).replace(/\n$/, '')), true) },
    emitWarning: (w: unknown) => write('warn', 'process.emitWarning', `(node:4242) ${w instanceof Error ? `${w.name}: ${w.message}` : `Warning: ${String(w)}`}`),
    exit: (code?: unknown) => {
      if (code !== undefined) proc.exitCode = code;
      const c = exitCode();
      if (!exiting) {
        exiting = true;
        proc.emit('exit', c);
      }
      tracer.exit(c);
    },
  });

  const util = {
    promisify(fn: unknown) {
      const f = callable(fn, 'original');
      const own = (f as unknown as Record<symbol, unknown>)[custom];
      if (typeof own === 'function') return own;
      return function (this: unknown, ...args: unknown[]) {
        return new P((resolve, reject) => {
          f.call(this, ...args, (err: unknown, value: unknown) => (err ? reject(err) : resolve(value)));
        });
      };
    },
    inspect: (v: unknown) => show(v),
    format: (...a: unknown[]) => formatArgs(a, intro),
    inherits: (ctor: Function, sup: Function) => Object.setPrototypeOf(ctor.prototype, sup.prototype),
    types: { isPromise: (v: unknown) => promises.isPromise(v) },
  };
  Object.assign(util.promisify, { custom });

  const timersModule = { setTimeout: setTimeoutV, setInterval: setIntervalV, setImmediate: setImmediateV, clearTimeout: clearTimeoutV, clearInterval: clearIntervalV, clearImmediate: clearImmediateV };
  const builtins: Record<string, unknown> = {
    fs,
    'fs/promises': fs.promises,
    events: EventEmitter,
    util,
    path: pathModule,
    timers: timersModule,
    'timers/promises': timersPromises,
    process: proc,
  };
  const SUPPORTED = Object.keys(builtins).join(', ');
  const requireV = (id: unknown) => {
    const name = String(id);
    const key = name.replace(/^node:/, '');
    if (key in builtins) return builtins[key];
    const fail = (message: string, code: string) => Object.assign(new Error(message), { code });
    if (NODE_CORE_MODULES.has(key))
      throw fail(`Cannot load '${name}': this Node.js core module isn't available in the browser-based simulator. Supported modules: ${SUPPORTED}.`, 'ERR_SIMULATOR_UNSUPPORTED_MODULE');
    if (key.startsWith('.') || key.startsWith('/'))
      throw fail(`Cannot find module '${name}': the simulator runs a single file, so local modules can't be required.`, 'MODULE_NOT_FOUND');
    throw fail(`Cannot find module '${name}': npm packages can't be loaded in the simulator.`, 'MODULE_NOT_FOUND');
  };

  // ------------------------------------------------------------------ error reporting
  const report = (err: unknown, source: 'uncaught' | 'unhandled-rejection', line?: number) => {
    const isErr = err instanceof Error;
    const shown = show(err);
    const text =
      source === 'unhandled-rejection' && !isNode
        ? `Uncaught (in promise) ${shown}`
        : source === 'unhandled-rejection' && !isErr
          ? `Uncaught [UnhandledPromiseRejection: This error originated either by throwing inside of an async function without a catch block, or by rejecting a promise which was not handled with .catch(). The promise rejected with the reason "${shown}".] { code: 'ERR_UNHANDLED_REJECTION' }`
          : `Uncaught ${shown}`;
    write('error', 'runtime', text);
    tracer.emit(
      {
        kind: 'error',
        error: { name: isErr ? err.name : 'Error', message: isErr ? err.message : shown, value: tracer.ser(err, 1), line: line ?? tracer.currentLine },
        fatal: isNode,
        source,
      },
      true,
    );
  };

  const host: Environment['host'] = {
    uncaught(err, source, promise, line) {
      if (isNode && !inUncaughtHandler) {
        if (source === 'unhandled-rejection' && listeners('unhandledRejection')) {
          runListeners("process 'unhandledRejection' listener", 'unhandledRejection', [err, promise]);
          return 'handled';
        }
        if (listeners('uncaughtException')) {
          inUncaughtHandler = true;
          try {
            runListeners("process 'uncaughtException' listener", 'uncaughtException', [err, source === 'uncaught' ? 'uncaughtException' : 'unhandledRejection']);
          } finally {
            inUncaughtHandler = false;
          }
          return 'handled';
        }
      }
      report(err, source, line);
      return isNode ? 'fatal' : 'handled';
    },
    promiseValue: (p) => promises.inspect(p)?.value,
    beforeExit() {
      if (exiting || !listeners('beforeExit')) return false;
      runListeners("process 'beforeExit' listener", 'beforeExit', [exitCode()]);
      loop.drainNode();
      return true;
    },
    exit(code) {
      if (exiting || !listeners('exit')) return;
      exiting = true;
      runListeners("process 'exit' listener", 'exit', [code]);
    },
  };

  // ------------------------------------------------------------------ assemble
  const realGlobal = globalThis as unknown as Record<string, unknown>;
  const common: Record<string, unknown> = {
    console: consoleObj,
    setTimeout: setTimeoutV,
    setInterval: setIntervalV,
    clearTimeout: clearTimeoutV,
    clearInterval: clearIntervalV,
    queueMicrotask: queueMicrotaskV,
    Promise: P,
    Date: VDate,
    performance: performanceV,
    fetch: fetchV,
  };
  // Host capabilities user code must not see. The worker boundary and CSP are the real
  // protection; shadowing keeps each mode's global surface honest.
  const HOST_ONLY = ['postMessage', 'close', 'importScripts', 'onmessage', 'onmessageerror', 'onerror', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'indexedDB', 'caches', 'BroadcastChannel', 'Worker', 'SharedWorker'];
  const shadow = (names: string[]) => Object.fromEntries(names.map((n) => [n, undefined]));
  let globals: Record<string, unknown>;
  let moduleParams: Record<string, unknown> | null = null;
  let thisValue: unknown;
  if (isNode) {
    const moduleObj = { id: '.', filename: `${CWD}/index.js`, loaded: false, exports: {}, children: [], paths: [], require: requireV };
    moduleParams = { exports: moduleObj.exports, require: requireV, module: moduleObj, __filename: `${CWD}/index.js`, __dirname: CWD };
    globals = {
      ...shadow([...HOST_ONLY, 'window', 'self', 'document', 'name', 'location', 'requestAnimationFrame', 'cancelAnimationFrame']),
      ...common,
      process: proc,
      setImmediate: setImmediateV,
      clearImmediate: clearImmediateV,
      Buffer,
      global: realGlobal,
    };
    thisValue = moduleObj.exports;
  } else {
    globals = {
      ...shadow([...HOST_ONLY, 'process', 'require', 'module', 'exports', '__filename', '__dirname', 'global', 'Buffer', 'setImmediate', 'clearImmediate']),
      ...common,
      requestAnimationFrame: (fn: unknown) => loop.addRaf(callable(fn)),
      cancelAnimationFrame: (h: unknown) => loop.cancelRaf(Number(h)),
      window: realGlobal,
      self: realGlobal,
    };
    thisValue = realGlobal;
  }
  return { globals, moduleParams, thisValue, host, exitCode };
}
