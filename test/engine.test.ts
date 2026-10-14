import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { execute } from '../src/engine/runtime/execute';
import type { RuntimeMode, TraceEvent } from '../src/engine/types';

const run = (source: string, mode: RuntimeMode = 'node', limits = {}) => execute({ source, mode, limits });
const out = (source: string, mode: RuntimeMode = 'node') => run(source, mode).console.map((c) => c.text);
const kinds = (events: TraceEvent[], kind: TraceEvent['kind']) => events.filter((e) => e.kind === kind);

const tmp = mkdtempSync(join(tmpdir(), 'jsrl-'));
/** Runs the same program in real Node.js and returns its stdout lines. */
function realNode(source: string): string[] {
  const file = join(tmp, `p${Math.random().toString(36).slice(2)}.js`);
  writeFileSync(file, source);
  const r = spawnSync('node', [file], { encoding: 'utf8', timeout: 10_000 });
  return r.stdout.split('\n').filter((l) => l.length > 0);
}

export const REQUIRED_EXAMPLE = `const fs = require('fs');

fs.readFile(__filename, () => {
    setTimeout(() => console.log('1. setTimeout'), 0);

    setImmediate(() => {
        console.log('2. setImmediate');

        process.nextTick(() =>
            console.log('3. nextTick inside setImmediate')
        );

        Promise.resolve().then(() =>
            console.log('4. Promise inside setImmediate')
        );
    });

    process.nextTick(() => console.log('5. nextTick'));

    Promise.resolve().then(() => console.log('6. Promise'));
});`;

const DIFFERENTIAL: Record<string, string> = {
  'thenables, pass-through and finally': `
const thenable = { then(resolve) { console.log('then() called'); resolve('T'); } };
(async () => { const v = await thenable; console.log('awaited', v); })();
Promise.resolve(thenable).then((v) => console.log('resolved', v));
Promise.resolve(1).then(2).then((v) => console.log('pass-through', v));
Promise.reject(new Error('r')).then(() => console.log('skipped')).catch((e) => console.log('caught', e.message)).finally(() => console.log('fin'));
new Promise((res) => { res('first'); res('second'); }).then((v) => console.log('settles once:', v));
console.log('sync end');`,
  'async loops with timers': `
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function worker(name, ms) { for (let i = 0; i < 3; i++) { await sleep(ms); console.log(name, i); } return name; }
Promise.all([worker('A', 10), worker('B', 50)]).then((r) => console.log('done', r.join('+')));`,
  'generators and classes': `
function* ids() { let i = 0; while (true) { const reset = yield ++i; if (reset) i = 0; } }
const gen = ids();
console.log(gen.next().value, gen.next().value, gen.next(true).value);
const first3 = []; for (const id of ids()) { if (id > 3) break; first3.push(id); }
console.log(first3);
class Animal { constructor(name) { this.name = name; } speak() { return this.name + ' makes a sound'; } get upper() { return this.name.toUpperCase(); } static create(n) { return new this(n); } }
class Dog extends Animal { speak() { return super.speak() + ' (woof)'; } }
const d = Dog.create('rex');
console.log(d.speak(), d.upper, d instanceof Animal);`,
  'this binding in a CommonJS module': `
var name = 'module scope';
function plain() { return String(this === globalThis) + ' ' + String(this.name); }
const obj = { name: 'obj', method: plain, arrow: () => typeof this };
console.log(plain());
console.log(obj.method());
console.log(obj.arrow(), this === module.exports);
console.log(plain.call({ name: 'explicit' }));`,
  'timers lists: blocked loop interleaving': `
const start = Date.now();
setTimeout(() => console.log('a (10ms, created first)'), 10);
setTimeout(() => console.log('c (5ms)'), 5);
setTimeout(() => console.log('b (10ms)'), 10);
while (Date.now() - start < 30) {}
setTimeout(() => console.log('late 1ms'), 1);`,
  'async/await interview classic': `
async function async1() { console.log('async1 start'); await async2(); console.log('async1 end'); }
async function async2() { console.log('async2'); }
console.log('script start');
setTimeout(() => console.log('setTimeout'), 0);
async1();
new Promise((resolve) => { console.log('promise1'); resolve(); }).then(() => console.log('promise2'));
console.log('script end');`,
  'return promise costs extra ticks': `
async function f() { return Promise.resolve(1); }
async function g() { return await Promise.resolve(2); }
f().then(() => console.log('f'));
g().then(() => console.log('g'));
Promise.resolve().then(() => console.log('a')).then(() => console.log('b')).then(() => console.log('c')).then(() => console.log('d'));`,
  'nextTick vs microtasks nesting': `
Promise.resolve().then(() => { console.log('p1'); process.nextTick(() => console.log('tick from p1')); });
process.nextTick(() => { console.log('t1'); Promise.resolve().then(() => console.log('p from t1')); process.nextTick(() => console.log('t2')); });
queueMicrotask(() => console.log('qm'));
console.log('sync');`,
  'timers ordering and intervals': `
let n = 0;
const id = setInterval(() => { n++; console.log('tick', n); if (n === 3) clearInterval(id); }, 10);
setTimeout(() => console.log('t25'), 25);
setTimeout(() => console.log('t5'), 5);
setTimeout(() => console.log('t0'), 0);`,
  'immediate inside I/O and nested immediates': `
const fs = require('fs');
fs.readFile(__filename, 'utf8', (err, data) => {
  console.log('read ok', typeof data, err === null);
  setTimeout(() => console.log('timeout'), 20);
  setImmediate(() => { console.log('imm1'); setImmediate(() => console.log('imm-nested')); process.nextTick(() => console.log('tick after imm1')); });
  setImmediate(() => console.log('imm2'));
});`,
  'promise combinators and errors': `
const wait = (ms, v, fail) => new Promise((res, rej) => setTimeout(() => (fail ? rej(new Error(v)) : res(v)), ms));
Promise.all([wait(20, 'a'), wait(10, 'b')]).then((v) => console.log('all', v.join(',')));
Promise.race([wait(30, 'slow'), wait(5, 'fast')]).then((v) => console.log('race', v));
Promise.allSettled([wait(1, 'ok'), wait(2, 'bad', true)]).then((r) => console.log('settled', r.map((x) => x.status).join(',')));
Promise.any([wait(3, 'x', true), wait(4, 'y')]).then((v) => console.log('any', v));
(async () => { try { await wait(1, 'boom', true); } catch (e) { console.log('caught', e.message); } finally { console.log('finally'); } })();`,
  'closures, recursion, this': `
function makeCounter() { let count = 0; return { inc: () => ++count, get value() { return count; } }; }
const c = makeCounter(); c.inc(); c.inc();
console.log('count', c.value);
const fib = (n) => (n < 2 ? n : fib(n - 1) + fib(n - 2));
console.log('fib', fib(10));
const obj = { name: 'obj', regular() { return this.name; }, arrow: () => typeof this };
console.log(obj.regular(), obj.arrow());
for (var i = 0; i < 3; i++) setTimeout(() => console.log('var i', i));
for (let j = 0; j < 3; j++) setTimeout(() => console.log('let j', j));`,
  'EventEmitter is synchronous': `
const EventEmitter = require('events');
const bus = new EventEmitter();
bus.on('ping', (x) => console.log('listener A', x));
bus.once('ping', (x) => console.log('listener B (once)', x));
console.log('before emit');
bus.emit('ping', 1);
bus.emit('ping', 2);
console.log('after emit', bus.listenerCount('ping'));`,
  'console formatting': `
console.log({ a: 1, b: 'two', c: [1, 2, { d: null }], e: { f: { g: { h: 1 } } } });
console.log('%s has %d items', 'list', 3, 'extra');
console.log([undefined, null, true, -0, 10n, Symbol('s')]);
console.log(new Map([['k', 1]]), new Set([1, 2]));
class Point { constructor(x, y) { this.x = x; this.y = y; } }
console.log(new Point(1, 2), [function named() {}, () => {}, async function af() {}]);
console.log(Promise.resolve(42), Promise.reject(new Error('x')).catch(() => {}) && 'ok');`,
};

describe('Node.js simulation — ordering', () => {
  it('runs the required fs.readFile example in the documented order', () => {
    expect(out(REQUIRED_EXAMPLE)).toEqual([
      '5. nextTick',
      '6. Promise',
      '2. setImmediate',
      '3. nextTick inside setImmediate',
      '4. Promise inside setImmediate',
      '1. setTimeout',
    ]);
  });

  it('shows the I/O callback in the poll phase and its microtask checkpoints', () => {
    const { events } = run(REQUIRED_EXAMPLE);
    const io = events.find((e) => e.kind === 'task-start' && e.queue === 'poll');
    expect(io).toBeDefined();
    const after = events.slice(io!.seq);
    const order = after
      .filter((e) => e.kind === 'checkpoint' || (e.kind === 'phase' && !e.empty) || e.kind === 'console')
      .map((e) => (e.kind === 'console' ? e.text : e.kind === 'phase' ? `phase:${e.phase}` : e.kind === 'checkpoint' ? `${e.queue}:${e.state}` : ''));
    expect(order.slice(0, 6)).toEqual(['nextTick:start', '5. nextTick', 'nextTick:end', 'microtask:start', '6. Promise', 'microtask:end']);
    expect(order).toContain('phase:check');
    expect(order.indexOf('phase:check')).toBeLessThan(order.indexOf('1. setTimeout'));
  });

  for (const [name, source] of Object.entries(DIFFERENTIAL)) {
    it(`matches real Node.js: ${name}`, () => {
      expect(out(source)).toEqual(realNode(source));
    });
  }

  it('warns about the main-module setTimeout/setImmediate race', () => {
    const r = run(`setTimeout(() => console.log('timeout'), 0); setImmediate(() => console.log('immediate'));`);
    expect(r.console.map((c) => c.text).sort()).toEqual(['immediate', 'timeout']);
    expect(r.warnings[0]).toMatch(/non-deterministic/);
  });

  it('flags timer/setImmediate races instead of guessing silently', () => {
    const r = run(`const fs = require('fs');
fs.readFile(__filename, () => {
  setTimeout(() => console.log('timeout'), 0);
  setImmediate(() => { console.log('imm1'); setImmediate(() => console.log('imm-nested')); });
});`);
    expect(r.console.map((c) => c.text)).toEqual(['imm1', 'imm-nested', 'timeout']);
    expect(r.warnings[0]).toMatch(/non-deterministic/);
    expect(kinds(r.events, 'note').length).toBe(1);
    // The documented example has no race: the immediate runs before the timer, always.
    expect(run(REQUIRED_EXAMPLE).warnings).toEqual([]);
  });

  it('returns original source from fn.toString()', () => {
    expect(out(`function add(a, b) { return a + b; }\nconst double = (x) => x * 2;\nconsole.log(add.toString());\nconsole.log(String(double));`)).toEqual([
      'function add(a, b) { return a + b; }',
      '(x) => x * 2',
    ]);
  });

  it('restores host globals after a run', () => {
    const before = globalThis.setTimeout;
    run(`setTimeout(() => {}, 5)`);
    run(`setTimeout(() => {}, 5)`, 'browser');
    expect(globalThis.setTimeout).toBe(before);
    expect(typeof process.nextTick).toBe('function');
    expect(Function.prototype.toString.call(function f() {})).toBe('function f() {}');
  });

  it('uses virtual CPU time so busy-waits finish', () => {
    const r = run(`const s = Date.now(); while (Date.now() - s < 30) {} console.log('waited', Date.now() - s >= 30);`);
    expect(r.status).toBe('completed');
    expect(r.console[0]!.text).toBe('waited true');
  });
});

describe('Browser runtime', () => {
  it('orders sync, microtasks, timers and animation frames', () => {
    const src = `
console.log('script');
setTimeout(() => console.log('timeout'), 0);
requestAnimationFrame(() => console.log('raf'));
Promise.resolve().then(() => console.log('microtask'));
queueMicrotask(() => console.log('queueMicrotask'));`;
    expect(out(src, 'browser')).toEqual(['script', 'microtask', 'queueMicrotask', 'timeout', 'raf']);
  });

  it('keeps running after an uncaught error and reports unhandled rejections', () => {
    const r = run(`setTimeout(() => { throw new Error('boom'); }); setTimeout(() => console.log('still alive'), 5); Promise.reject(new Error('nope'));`, 'browser');
    expect(r.status).toBe('completed');
    expect(r.console.map((c) => c.text)).toEqual(['Uncaught (in promise) Error: nope', 'Uncaught Error: boom', 'still alive']);
  });

  it('runs scripts as global code: top-level var and sloppy this', () => {
    const src = `var greetingG1 = 'hello from window';
function showG1() { return this.greetingG1; }
const holder = { greetingG1: 'hello from holder', showG1 };
console.log(showG1());
console.log(holder.showG1());
console.log(this === window, typeof window.showG1);`;
    expect(out(src, 'browser')).toEqual(['hello from window', 'hello from holder', 'true function']);
  });

  it('does not expose Node globals', () => {
    expect(out(`console.log(typeof setImmediate, typeof process, typeof require)`, 'browser')[0]).toBe('undefined undefined undefined');
  });

  it('simulates fetch fixtures with async/await', () => {
    const src = `(async () => { const r = await fetch('/api/user'); const u = await r.json(); console.log(r.status, u.name); })();
fetch('https://example.com/x').catch((e) => console.log(e.name));`;
    expect(out(src, 'browser')).toEqual(['TypeError', '200 Ada Lovelace']);
  });
});

describe('Errors and safety limits', () => {
  it('crashes Node on an uncaught exception and skips remaining callbacks', () => {
    const r = run(`setTimeout(() => console.log('never'), 10); setTimeout(() => { throw new TypeError('bad'); }, 1);`);
    expect(r.status).toBe('crashed');
    expect(r.exitCode).toBe(1);
    expect(r.console.map((c) => c.text)).toEqual(['Uncaught TypeError: bad']);
    expect(kinds(r.events, 'error')[0]).toMatchObject({ fatal: true, source: 'uncaught' });
  });

  it('crashes Node on unhandled rejections unless a listener exists', () => {
    expect(run(`Promise.reject('oops'); setTimeout(() => console.log('never'));`).status).toBe('crashed');
    const handled = out(`process.on('unhandledRejection', (r) => console.log('handled', r)); Promise.reject('oops'); setTimeout(() => console.log('alive'));`);
    expect(handled).toEqual(['handled oops', 'alive']);
  });

  it('honours process.exit and exit listeners', () => {
    const r = run(`process.on('exit', (c) => console.log('exit', c)); setTimeout(() => console.log('never')); console.log('a'); process.exit(3);`);
    expect(r.status).toBe('exited');
    expect(r.exitCode).toBe(3);
    expect(r.console.map((c) => c.text)).toEqual(['a', 'exit 3']);
  });

  it('halts infinite loops without hanging', () => {
    const r = run(`let i = 0; while (true) { i++; }`, 'node', { maxOps: 200_000 });
    expect(r.status).toBe('halted');
    expect(kinds(r.events, 'limit')[0]).toMatchObject({ code: 'trace-limit' });
    const empty = run(`while (true) {}`, 'node', { maxOps: 200_000 });
    expect(kinds(empty.events, 'limit')[0]).toMatchObject({ code: 'op-limit' });
  });

  it('halts microtask starvation', () => {
    const r = run(`function spin() { Promise.resolve().then(spin); } spin(); setTimeout(() => console.log('never'));`, 'node', { maxMicrotasksPerCheckpoint: 500 });
    expect(r.status).toBe('halted');
    expect(kinds(r.events, 'limit')[0]).toMatchObject({ code: 'microtask-starvation' });
  });

  it('halts runaway intervals', () => {
    const r = run(`setInterval(() => {}, 1);`, 'node', { maxTasks: 50 });
    expect(r.status).toBe('halted');
  });

  it('reports parse errors and unsupported constructs as diagnostics', () => {
    expect(run('const = 1;').diagnostics[0]!.message).toMatch(/SyntaxError/);
    expect(run('eval("1")').diagnostics[0]!.message).toMatch(/eval/);
    expect(run('async function* g() {}').diagnostics.length).toBe(1);
  });

  it('explains unsupported modules honestly', () => {
    const r = run(`try { require('http'); } catch (e) { console.log(e.code); } try { require('lodash'); } catch (e) { console.log(e.code); }`);
    expect(r.console.map((c) => c.text)).toEqual(['ERR_SIMULATOR_UNSUPPORTED_MODULE', 'MODULE_NOT_FOUND']);
  });

  it('lets user code catch errors thrown deep in the stack and unwinds frames', () => {
    const r = run(`function a() { b(); } function b() { throw new Error('deep'); } try { a(); } catch (e) { console.log('caught', e.message); }`);
    expect(r.console[0]!.text).toBe('caught deep');
    const exits = kinds(r.events, 'exit').filter((e) => e.kind === 'exit' && e.reason === 'unwind');
    expect(exits.length).toBe(2);
  });
});

describe('Trace structure', () => {
  const traces = [REQUIRED_EXAMPLE, ...Object.values(DIFFERENTIAL)].map((s) => run(s).events);

  it('balances frames and tasks', () => {
    for (const events of traces) {
      const depth = events.reduce((d, e) => {
        if (e.kind === 'enter' && e.mergedFrameId === undefined) return d + 1;
        if (e.kind === 'task-start' && e.frameId !== undefined) return d + 1;
        if (e.kind === 'resume') return d + 1;
        if (e.kind === 'exit' || e.kind === 'suspend') return d - 1;
        return d;
      }, 0);
      expect(depth).toBe(0);
      expect(kinds(events, 'task-start').length).toBe(kinds(events, 'task-end').length);
    }
  });

  it('tracks closures and the temporal dead zone', () => {
    const { events } = run(`function makeCounter() { let count = 0; return () => ++count; }\nconst inc = makeCounter();\ninc();\ninc();\nlet late = 1;`);
    const counter = events.find((e) => e.kind === 'exit' && e.retained && e.reason === 'return');
    expect(counter).toBeDefined();
    const updates = events.flatMap((e) => ('vars' in e && e.vars ? e.vars : []));
    expect(updates.some((v) => v.name === 'count' && v.value.t === 'number' && v.value.v === '2')).toBe(true);
    expect(updates.some((v) => v.name === 'late' && v.value.t === 'tdz')).toBe(true);
  });

  it('records await suspension and resumption', () => {
    const { events } = run(`async function f() { await null; console.log('after'); } f();`);
    expect(kinds(events, 'suspend').length).toBe(1);
    expect(events.some((e) => e.kind === 'resume' && e.reason === 'await')).toBe(true);
  });
});
