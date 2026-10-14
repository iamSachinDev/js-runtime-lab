/** Simulated Node.js built-ins that need no scheduler access. */

type Listener = Function & { listener?: Function };

export const invalidArg = (name: string, value: unknown): TypeError => {
  const got =
    value === null ? 'null' : typeof value === 'object' ? 'an instance of Object' : `type ${typeof value} (${String(value)})`;
  return Object.assign(new TypeError(`The "${name}" argument must be of type function. Received ${got}`), {
    code: 'ERR_INVALID_ARG_TYPE',
  });
};

/** Node's EventEmitter: emit() calls listeners synchronously, in registration order. */
export function createEventEmitter(PromiseCtor: PromiseConstructor, show: (v: unknown) => string) {
  const store = new WeakMap<object, Map<string | symbol, Listener[]>>();
  const map = (em: object) => {
    let m = store.get(em);
    if (!m) store.set(em, (m = new Map()));
    return m;
  };
  const check = (fn: unknown): Listener => {
    if (typeof fn !== 'function') throw invalidArg('listener', fn);
    return fn as Listener;
  };
  const add = (em: object, name: string | symbol, fn: Listener, prepend: boolean) => {
    const list = map(em).get(name) ?? [];
    if (prepend) list.unshift(fn);
    else list.push(fn);
    map(em).set(name, list);
    return em;
  };
  const remove = (em: object, name: string | symbol, fn: unknown) => {
    const list = map(em).get(name);
    if (!list) return;
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i] === fn || list[i]!.listener === fn) {
        list.splice(i, 1);
        break;
      }
    }
    if (!list.length) map(em).delete(name);
  };
  const wrapOnce = (em: object, name: string | symbol, fn: Listener): Listener => {
    const w: Listener = function (this: unknown, ...args: unknown[]) {
      remove(em, name, w);
      return fn.apply(this, args);
    };
    w.listener = fn;
    return w;
  };

  class EventEmitter {
    static defaultMaxListeners = 10;
    static EventEmitter: typeof EventEmitter;
    static once: (em: EventEmitter, name: string | symbol) => Promise<unknown[]>;

    on(name: string | symbol, fn: unknown): this {
      return add(this, name, check(fn), false) as this;
    }
    addListener(name: string | symbol, fn: unknown): this {
      return this.on(name, fn);
    }
    prependListener(name: string | symbol, fn: unknown): this {
      return add(this, name, check(fn), true) as this;
    }
    once(name: string | symbol, fn: unknown): this {
      return add(this, name, wrapOnce(this, name, check(fn)), false) as this;
    }
    prependOnceListener(name: string | symbol, fn: unknown): this {
      return add(this, name, wrapOnce(this, name, check(fn)), true) as this;
    }
    off(name: string | symbol, fn: unknown): this {
      remove(this, name, fn);
      return this;
    }
    removeListener(name: string | symbol, fn: unknown): this {
      return this.off(name, fn);
    }
    removeAllListeners(name?: string | symbol): this {
      if (name === undefined) map(this).clear();
      else map(this).delete(name);
      return this;
    }
    emit(name: string | symbol, ...args: unknown[]): boolean {
      const list = map(this).get(name);
      if (!list || !list.length) {
        if (name === 'error') {
          const er = args[0];
          if (er instanceof Error) throw er;
          throw Object.assign(new Error(`Unhandled error. (${show(er)})`), { code: 'ERR_UNHANDLED_ERROR', context: er });
        }
        return false;
      }
      for (const fn of [...list]) fn.apply(this, args);
      return true;
    }
    listenerCount(name: string | symbol): number {
      return map(this).get(name)?.length ?? 0;
    }
    listeners(name: string | symbol): Function[] {
      return (map(this).get(name) ?? []).map((l) => l.listener ?? l);
    }
    rawListeners(name: string | symbol): Function[] {
      return [...(map(this).get(name) ?? [])];
    }
    eventNames(): (string | symbol)[] {
      return [...map(this).keys()];
    }
    setMaxListeners(): this {
      return this;
    }
    getMaxListeners(): number {
      return EventEmitter.defaultMaxListeners;
    }
  }
  EventEmitter.EventEmitter = EventEmitter;
  EventEmitter.once = (em, name) =>
    new PromiseCtor<unknown[]>((resolve, reject) => {
      const onError = (err: unknown) => {
        em.off(name, onEvent);
        reject(err);
      };
      const onEvent = (...args: unknown[]) => {
        if (name !== 'error') em.off('error', onError);
        resolve(args);
      };
      em.once(name, onEvent);
      if (name !== 'error') em.once('error', onError);
    });
  return EventEmitter;
}

export type EventEmitterClass = ReturnType<typeof createEventEmitter>;

// ---------------------------------------------------------------- path (POSIX)
const normalize = (p: string): string => {
  const abs = p.startsWith('/');
  const out: string[] = [];
  for (const seg of p.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') {
      if (out.length && out[out.length - 1] !== '..') out.pop();
      else if (!abs) out.push('..');
    } else out.push(seg);
  }
  const s = (abs ? '/' : '') + out.join('/');
  return s || (abs ? '/' : '.');
};

export const CWD = '/app';

export const pathModule = {
  sep: '/',
  delimiter: ':',
  normalize: (p: unknown) => normalize(String(p)),
  isAbsolute: (p: unknown) => String(p).startsWith('/'),
  join: (...parts: unknown[]) => normalize(parts.map(String).filter(Boolean).join('/') || '.'),
  resolve: (...parts: unknown[]): string => {
    let r = '';
    for (let i = parts.length - 1; i >= 0 && !r.startsWith('/'); i--) {
      const s = String(parts[i]);
      if (s) r = r ? `${s}/${r}` : s;
    }
    if (!r.startsWith('/')) r = `${CWD}/${r}`;
    const n = normalize(r);
    return n.length > 1 ? n.replace(/\/$/, '') : n;
  },
  basename: (p: unknown, ext?: unknown): string => {
    const b = String(p).replace(/\/+$/, '').split('/').pop() ?? '';
    return typeof ext === 'string' && b.endsWith(ext) && b !== ext ? b.slice(0, -ext.length) : b;
  },
  dirname: (p: unknown): string => {
    const s = String(p).replace(/\/+$/, '');
    const i = s.lastIndexOf('/');
    return i < 0 ? '.' : i === 0 ? '/' : s.slice(0, i);
  },
  extname: (p: unknown): string => {
    const b = pathModule.basename(p);
    const i = b.lastIndexOf('.');
    return i <= 0 ? '' : b.slice(i);
  },
};

// ---------------------------------------------------------------- Buffer (minimal)
const enc = new TextEncoder();
const dec = new TextDecoder();

export class Buffer extends Uint8Array {
  static from(value: unknown): Buffer {
    const bytes = typeof value === 'string' ? enc.encode(value) : Uint8Array.from(value as ArrayLike<number>);
    const b = new Buffer(bytes.length);
    b.set(bytes);
    return b;
  }
  static alloc(size: number): Buffer {
    return new Buffer(size);
  }
  static isBuffer(v: unknown): v is Buffer {
    return v instanceof Buffer;
  }
  static byteLength(s: unknown): number {
    return enc.encode(String(s)).length;
  }
  static concat(list: Uint8Array[]): Buffer {
    const out = new Buffer(list.reduce((n, b) => n + b.length, 0));
    let o = 0;
    for (const b of list) {
      out.set(b, o);
      o += b.length;
    }
    return out;
  }
  override toString(encoding = 'utf8'): string {
    if (encoding === 'hex') return Array.from(this, (b) => b.toString(16).padStart(2, '0')).join('');
    if (encoding === 'base64') return btoa(String.fromCharCode(...this));
    return dec.decode(this);
  }
  toJSON(): { type: 'Buffer'; data: number[] } {
    return { type: 'Buffer', data: Array.from(this) };
  }
}

// ---------------------------------------------------------------- fixtures
export const FILE_FIXTURES: Record<string, string> = {
  '/app/data.json': JSON.stringify({ users: [{ id: 1, name: 'Ada' }, { id: 2, name: 'Linus' }] }, null, 2),
  '/app/notes.txt': 'Event loop phases: timers, pending, poll, check, close.\n',
  '/app/config.json': '{ "retries": 3, "timeoutMs": 50 }\n',
};

export const FETCH_FIXTURES: Record<string, { body: unknown; latencyMs: number; status?: number }> = {
  '/api/user': { body: { id: 1, name: 'Ada Lovelace', role: 'admin' }, latencyMs: 120 },
  '/api/users': { body: [{ id: 1, name: 'Ada' }, { id: 2, name: 'Linus' }, { id: 3, name: 'Grace' }], latencyMs: 180 },
  '/api/todos': { body: [{ id: 1, title: 'Learn the event loop', done: true }, { id: 2, title: 'Master microtasks', done: false }], latencyMs: 90 },
  '/api/slow': { body: { ok: true }, latencyMs: 800 },
  '/api/error': { body: { error: 'Internal Server Error' }, latencyMs: 60, status: 500 },
};

export const NODE_CORE_MODULES = new Set([
  'assert', 'buffer', 'child_process', 'cluster', 'crypto', 'dgram', 'dns', 'http', 'http2', 'https', 'net', 'os',
  'querystring', 'readline', 'stream', 'string_decoder', 'tls', 'url', 'v8', 'vm', 'worker_threads', 'zlib',
]);
