import type { PromiseState, SV } from '../types';

export interface ValueIntrospection {
  /** Static metadata for instrumented functions (name/async/generator), if known. */
  fnInfo(fn: Function): { name: string; async: boolean; generator: boolean } | undefined;
  /** Internal state of a virtual promise, or undefined if `v` is not one. */
  promiseInfo(v: object): { pid: number; state: PromiseState; value: unknown } | undefined;
}

const MAX_ENTRIES = 24;
const MAX_STRING = 400;

export class ValueSerializer {
  private ids = new WeakMap<object, number>();
  private next = 1;
  constructor(private intro: ValueIntrospection) {}

  idOf(o: object): number {
    let id = this.ids.get(o);
    if (id === undefined) {
      id = this.next++;
      this.ids.set(o, id);
    }
    return id;
  }

  serialize(v: unknown, depth = 2, seen: Set<object> = new Set()): SV {
    switch (typeof v) {
      case 'undefined':
        return { t: 'undefined' };
      case 'boolean':
        return { t: 'boolean', v };
      case 'number':
        return { t: 'number', v: Object.is(v, -0) ? '-0' : String(v) };
      case 'bigint':
        return { t: 'bigint', v: `${v}n` };
      case 'string':
        return v.length > MAX_STRING ? { t: 'string', v: v.slice(0, MAX_STRING), trunc: true } : { t: 'string', v };
      case 'symbol':
        return { t: 'symbol', v: v.toString() };
      case 'function': {
        const info = this.intro.fnInfo(v);
        const src = Function.prototype.toString.call(v);
        return {
          t: 'function',
          id: this.idOf(v),
          name: info?.name ?? (v.name || ''),
          async: info?.async,
          generator: info?.generator,
          cls: src.startsWith('class'),
        };
      }
    }
    if (v === null) return { t: 'null' };
    const o = v as object;
    const id = this.idOf(o);
    if (seen.has(o)) return { t: 'ref', id, kind: 'circular' };
    const p = this.intro.promiseInfo(o);
    if (p) {
      return {
        t: 'promise',
        id,
        pid: p.pid,
        state: p.state,
        value: p.state === 'pending' || depth <= 0 ? undefined : this.serialize(p.value, depth - 1, seen),
      };
    }
    if (o instanceof Error) return { t: 'error', id, name: safeName(o), message: String(o.message) };
    if (o instanceof Date) return { t: 'date', v: isNaN(o.getTime()) ? 'Invalid Date' : o.toISOString() };
    if (o instanceof RegExp) return { t: 'regexp', v: String(o) };
    if (depth <= 0) return { t: 'ref', id, kind: Array.isArray(o) ? 'Array' : ctorName(o) };
    seen.add(o);
    try {
      if (Array.isArray(o)) {
        const len = o.length;
        const items: SV[] = [];
        for (let i = 0; i < Math.min(len, MAX_ENTRIES); i++) items.push(this.serialize(readOwn(o, String(i)), depth - 1, seen));
        return { t: 'array', id, len, items, more: len > MAX_ENTRIES };
      }
      if (o instanceof Map) {
        const entries: [SV, SV][] = [];
        for (const [k, val] of o) {
          if (entries.length >= MAX_ENTRIES) break;
          entries.push([this.serialize(k, depth - 1, seen), this.serialize(val, depth - 1, seen)]);
        }
        return { t: 'map', id, size: o.size, entries, more: o.size > MAX_ENTRIES };
      }
      if (o instanceof Set) {
        const items: SV[] = [];
        for (const val of o) {
          if (items.length >= MAX_ENTRIES) break;
          items.push(this.serialize(val, depth - 1, seen));
        }
        return { t: 'set', id, size: o.size, items, more: o.size > MAX_ENTRIES };
      }
      const keys = Reflect.ownKeys(o).filter((k) => Object.getOwnPropertyDescriptor(o, k)?.enumerable);
      const entries: [string, SV][] = keys.slice(0, MAX_ENTRIES).map((k) => [
        typeof k === 'symbol' ? `[${k.toString()}]` : k,
        this.serialize(readOwn(o, k), depth - 1, seen),
      ]);
      return { t: 'object', id, ctor: ctorName(o), entries, more: keys.length > MAX_ENTRIES };
    } finally {
      seen.delete(o);
    }
  }
}

/** Reads an own property without invoking getters (getters show as [Getter]). */
function readOwn(o: object, k: PropertyKey): unknown {
  const d = Object.getOwnPropertyDescriptor(o, k);
  if (!d) return undefined;
  if ('value' in d) return d.value;
  return GETTER;
}
const GETTER = Symbol('[Getter]');

function safeName(e: Error): string {
  const d = Object.getOwnPropertyDescriptor(e, 'name') ?? Object.getOwnPropertyDescriptor(Object.getPrototypeOf(e), 'name');
  return d && 'value' in d && typeof d.value === 'string' ? d.value : 'Error';
}

function ctorName(o: object): string {
  const proto = Object.getPrototypeOf(o);
  if (proto === null) return '[Object: null prototype]';
  const d = Object.getOwnPropertyDescriptor(proto, 'constructor');
  const c = d && 'value' in d ? d.value : undefined;
  return typeof c === 'function' && c.name ? c.name : 'Object';
}

// ------------------------------------------------------------------ inspect

const IDENT = /^[A-Za-z_$][\w$]*$/;

function quote(s: string): string {
  const q = s.includes("'") && !s.includes('"') ? '"' : "'";
  const body = s.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/\t/g, '\\t');
  return q + (q === "'" ? body.replace(/'/g, "\\'") : body) + q;
}

/** Node-flavoured util.inspect for console output (single line unless long). */
export function inspect(v: unknown, intro: ValueIntrospection, depth = 2, seen: object[] = []): string {
  if (v === GETTER) return '[Getter]';
  switch (typeof v) {
    case 'string':
      return quote(v);
    case 'number':
      return Object.is(v, -0) ? '-0' : String(v);
    case 'bigint':
      return `${v}n`;
    case 'symbol':
      return v.toString();
    case 'undefined':
      return 'undefined';
    case 'boolean':
      return String(v);
    case 'function': {
      const info = intro.fnInfo(v);
      const src = Function.prototype.toString.call(v);
      if (src.startsWith('class')) return `[class ${v.name || '(anonymous)'}]`;
      const kind = info?.async ? 'AsyncFunction' : info?.generator ? 'GeneratorFunction' : 'Function';
      const name = v.name;
      return name ? `[${kind}: ${name}]` : `[${kind} (anonymous)]`;
    }
  }
  if (v === null) return 'null';
  const o = v as object;
  if (seen.includes(o)) return '[Circular *1]';
  const p = intro.promiseInfo(o);
  if (p) {
    if (p.state === 'pending') return 'Promise { <pending> }';
    const inner = inspect(p.value, intro, depth - 1, [...seen, o]);
    return p.state === 'rejected' ? `Promise { <rejected> ${inner} }` : `Promise { ${inner} }`;
  }
  if (o instanceof Error) {
    const head = o.message ? `${safeName(o)}: ${o.message}` : safeName(o);
    if (seen.length) return `[${head}]`;
    const extra = Object.keys(o).map((k) => `${IDENT.test(k) ? k : quote(k)}: ${inspect(readOwn(o, k), intro, depth - 1, [o])}`);
    return extra.length ? `${head} {\n  ${extra.join(',\n  ')}\n}` : head;
  }
  if (ArrayBuffer.isView(o) && !(o instanceof DataView)) {
    const arr = Array.from(o as unknown as ArrayLike<number>);
    if (ctorName(o) === 'Buffer') {
      const hex = arr.slice(0, 50).map((b) => b.toString(16).padStart(2, '0')).join(' ');
      return `<Buffer${hex ? ` ${hex}` : ''}${arr.length > 50 ? ` ... ${arr.length - 50} more bytes` : ''}>`;
    }
    const shown = arr.slice(0, 100).join(', ');
    return `${ctorName(o)}(${arr.length}) [${shown ? ` ${shown} ` : ''}]`;
  }
  if (o instanceof Date) return isNaN(o.getTime()) ? 'Invalid Date' : o.toISOString();
  if (o instanceof RegExp) return String(o);
  const next = [...seen, o];
  let parts: string[];
  let open: string;
  let close: string;
  if (Array.isArray(o)) {
    if (depth < 0) return '[Array]';
    parts = [];
    let holes = 0;
    const flush = () => {
      if (holes) parts.push(`<${holes} empty item${holes > 1 ? 's' : ''}>`);
      holes = 0;
    };
    for (let i = 0; i < Math.min(o.length, 100); i++) {
      if (!(i in o)) {
        holes++;
        continue;
      }
      flush();
      parts.push(inspect(readOwn(o, String(i)), intro, depth - 1, next));
    }
    flush();
    if (o.length > 100) parts.push(`... ${o.length - 100} more items`);
    open = '[';
    close = ']';
  } else if (o instanceof Map) {
    if (depth < 0) return '[Map]';
    parts = [...o].map(([k, val]) => `${inspect(k, intro, depth - 1, next)} => ${inspect(val, intro, depth - 1, next)}`);
    open = `Map(${o.size}) {`;
    close = '}';
  } else if (o instanceof Set) {
    if (depth < 0) return '[Set]';
    parts = [...o].map((val) => inspect(val, intro, depth - 1, next));
    open = `Set(${o.size}) {`;
    close = '}';
  } else {
    const name = ctorName(o);
    if (depth < 0) return name === 'Object' ? '[Object]' : `[${name}]`;
    const keys = Reflect.ownKeys(o).filter((k) => Object.getOwnPropertyDescriptor(o, k)?.enumerable);
    parts = keys.map((k) => {
      const label = typeof k === 'symbol' ? `[${k.toString()}]` : IDENT.test(k) ? k : quote(k);
      return `${label}: ${inspect(readOwn(o, k), intro, depth - 1, next)}`;
    });
    open = name === 'Object' ? '{' : `${name} {`;
    close = '}';
  }
  if (parts.length === 0) return open.endsWith('{') ? `${open}}` : `${open}${close}`;
  const single = `${open} ${parts.join(', ')} ${close}`;
  if (single.length <= 72 && !single.includes('\n')) return single;
  const pad = '  '.repeat(seen.length + 1);
  return `${open}\n${parts.map((x) => pad + x).join(`,\n`)}\n${'  '.repeat(seen.length)}${close}`;
}

/** console.log-style formatting with printf specifiers (%s %d %i %f %j %o %O %c %%). */
export function formatArgs(args: unknown[], intro: ValueIntrospection): string {
  const out: string[] = [];
  let rest = args;
  if (typeof args[0] === 'string' && args[0].includes('%') && args.length > 1) {
    let i = 1;
    const fmt = args[0].replace(/%([sdifjoOc%])/g, (m, c: string) => {
      if (c === '%') return '%';
      if (i >= args.length) return m;
      const a = args[i++];
      switch (c) {
        case 's':
          return typeof a === 'string' ? a : typeof a === 'object' && a !== null ? inspect(a, intro, 1) : String(a);
        case 'd':
        case 'i': {
          if (typeof a === 'bigint') return `${a}n`;
          const n = Number(a);
          return String(c === 'i' ? Math.trunc(n) : n);
        }
        case 'f':
          return String(parseFloat(String(a)));
        case 'j':
          try {
            return JSON.stringify(a);
          } catch {
            return '[Circular]';
          }
        case 'c':
          return '';
        default:
          return inspect(a, intro, 4);
      }
    });
    out.push(fmt);
    rest = args.slice(i);
  } else if (typeof args[0] === 'string') {
    out.push(args[0]);
    rest = args.slice(1);
  }
  for (const a of rest) out.push(typeof a === 'string' ? a : inspect(a, intro));
  return out.join(' ');
}
