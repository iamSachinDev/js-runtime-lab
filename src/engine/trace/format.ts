import type { Phase, QueueId, RuntimeMode, SV, TaskKind } from '../types';

const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

/** Compact single-line rendering of a serialized value. */
export function svShort(v: SV | undefined, max = 48): string {
  return clip(preview(v, 2), max);
}

function preview(v: SV | undefined, depth: number): string {
  if (!v) return 'undefined';
  switch (v.t) {
    case 'undefined':
    case 'null':
      return v.t;
    case 'boolean':
      return String(v.v);
    case 'number':
    case 'bigint':
    case 'symbol':
    case 'date':
    case 'regexp':
      return v.v;
    case 'string':
      return `'${v.v}${v.trunc ? '…' : ''}'`;
    case 'tdz':
      return '<uninitialized>';
    case 'function':
      return `${v.cls ? 'class' : v.async ? 'async ƒ' : v.generator ? 'ƒ*' : 'ƒ'} ${v.name || 'anonymous'}`;
    case 'array':
      if (depth <= 0) return `Array(${v.len})`;
      return `[${v.items.map((i) => preview(i, depth - 1)).join(', ')}${v.more ? ', …' : ''}]`;
    case 'object': {
      const head = v.ctor === 'Object' ? '' : `${v.ctor} `;
      if (depth <= 0 || !v.entries.length) return `${head}{${v.entries.length ? '…' : ''}}`;
      return `${head}{ ${v.entries.map(([k, x]) => `${k}: ${preview(x, depth - 1)}`).join(', ')}${v.more ? ', …' : ''} }`;
    }
    case 'map':
      return `Map(${v.size})`;
    case 'set':
      return `Set(${v.size})`;
    case 'promise':
      return v.state === 'pending' ? `Promise <pending>` : `Promise <${v.state}: ${preview(v.value, depth - 1)}>`;
    case 'error':
      return `${v.name}: ${v.message}`;
    case 'ref':
      return v.kind === 'circular' ? '[Circular]' : `[${v.kind}]`;
  }
}

export const QUEUE_LABEL: Record<QueueId, string> = {
  nextTick: 'nextTick queue',
  microtask: 'microtask queue',
  timers: 'timers queue',
  poll: 'poll (I/O) queue',
  check: 'check queue',
  task: 'task queue',
  raf: 'animation frame callbacks',
};

export const PHASE_LABEL: Record<Phase, string> = {
  main: 'Main script',
  timers: 'Timers',
  pending: 'Pending callbacks',
  idle: 'Idle, prepare',
  poll: 'Poll',
  check: 'Check',
  close: 'Close callbacks',
  task: 'Task',
  render: 'Render',
};

export const KIND_LABEL: Record<TaskKind, string> = {
  main: 'main script',
  timeout: 'setTimeout callback',
  interval: 'setInterval callback',
  immediate: 'setImmediate callback',
  nextTick: 'nextTick callback',
  promise: 'promise reaction',
  await: 'await continuation',
  thenable: 'thenable job',
  microtask: 'queueMicrotask callback',
  io: 'I/O callback',
  raf: 'animation frame callback',
  event: 'event listener',
};

export const hostLabel = (mode: RuntimeMode) => (mode === 'node' ? 'Node APIs (libuv)' : 'Web APIs');

export type Tone = 'cyan' | 'violet' | 'amber' | 'green' | 'coral' | 'fuchsia' | 'sky' | 'mint' | 'slate';

export function kindTone(kind: TaskKind): Tone {
  switch (kind) {
    case 'timeout':
    case 'interval':
      return 'amber';
    case 'promise':
    case 'await':
    case 'thenable':
    case 'microtask':
      return 'violet';
    case 'nextTick':
      return 'fuchsia';
    case 'immediate':
      return 'mint';
    case 'io':
    case 'raf':
      return 'sky';
    case 'main':
      return 'cyan';
    default:
      return 'slate';
  }
}

export const fmtMs = (ms: number) => (Number.isInteger(ms) ? `${ms}` : ms.toFixed(ms < 10 ? 3 : 2).replace(/0+$/, '').replace(/\.$/, ''));
