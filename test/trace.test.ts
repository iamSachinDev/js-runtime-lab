import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { explain, summarize } from '../src/engine/explain/explain';
import { execute } from '../src/engine/runtime/execute';
import { apply, initialState, TraceIndex } from '../src/engine/trace/model';
import { EXAMPLES } from '../src/examples';

const tmp = mkdtempSync(join(tmpdir(), 'jsrl-ex-'));
function realNodeStdout(source: string): string[] {
  const file = join(tmp, `e${Math.random().toString(36).slice(2)}.js`);
  writeFileSync(file, source);
  const r = spawnSync('node', [file], { encoding: 'utf8', timeout: 10_000 });
  return r.stdout.split('\n').filter((l) => l.length > 0);
}

const byId = (id: string) => EXAMPLES.find((e) => e.id === id)!;

describe('TraceIndex', () => {
  it('random access matches a full sequential replay', () => {
    const r = execute({ source: byId('promise-chain').code, mode: 'node' });
    const ix = new TraceIndex(r);
    const seqs = [0, 1, 7, r.events.length - 1, 40, 39, 3, 26, 25, 24, 80, 2];
    for (const seq of seqs) {
      const s = initialState(r.mode);
      const frames = new Map();
      for (const e of r.events) if (e.kind === 'enter') frames.set(e.frame.id, e.frame);
      for (let i = 0; i <= Math.min(seq, r.events.length - 1); i++) apply(s, r.events[i]!, { frames });
      expect(ix.stateAt(seq)).toEqual(s);
    }
  });

  it('moves the promise token through the microtask queue into the call stack', () => {
    const r = execute({ source: byId('node-event-loop-phases').code, mode: 'node' });
    const ix = new TraceIndex(r);
    const scheduled = r.events.find((e) => e.kind === 'schedule' && e.task.label.includes("'6. Promise'"))!;
    const s = ix.stateAt(scheduled.seq);
    expect(s.queues.microtask.map((t) => t.label)).toContain("() => console.log('6. Promise')");
    expect(s.queues.nextTick.length).toBe(1);
    const started = r.events.find((e) => e.kind === 'task-start' && e.task.id === (scheduled.kind === 'schedule' ? scheduled.task.id : -1))!;
    const after = ix.stateAt(started.seq);
    expect(after.queues.microtask.length).toBe(0);
    expect(after.stack.at(-1)?.layoutKey).toBe(`task-${scheduled.kind === 'schedule' ? scheduled.task.id : 0}`);
    expect(after.phase).toBe('poll');
    expect(after.checkpoint).toBe('microtask');
  });

  it('ends with an empty stack and empty queues', () => {
    for (const ex of EXAMPLES) {
      const ix = new TraceIndex(execute({ source: ex.code, mode: ex.mode }));
      const end = ix.stateAt(ix.length - 1);
      expect(end.done).toBe(true);
      expect(end.stack).toEqual([]);
      if (end.status === 'completed') {
        expect(Object.values(end.queues).flat()).toEqual([]);
        expect(end.webapis).toEqual([]);
      }
    }
  });

  it('keeps await continuations on the same layout identity as the suspended frame', () => {
    const r = execute({ source: 'async function f() { await null; console.log("x"); }\nf();', mode: 'node' });
    const ix = new TraceIndex(r);
    const suspend = r.events.find((e) => e.kind === 'suspend')!;
    const key = ix.stateAt(suspend.seq).suspended[0]!.layoutKey;
    const sched = r.events.find((e) => e.kind === 'schedule' && e.api === 'await')!;
    expect(ix.stateAt(sched.seq).queues.microtask[0]!.layoutKey).toBe(key);
    const resume = r.events.find((e) => e.kind === 'resume')!;
    expect(ix.stateAt(resume.seq).stack.at(-1)!.layoutKey).toBe(key);
  });
});

describe('Example library', () => {
  for (const ex of EXAMPLES) {
    it(`${ex.mode}: ${ex.title}`, () => {
      const r = execute({ source: ex.code, mode: ex.mode });
      expect(r.diagnostics).toEqual([]);
      expect(r.events.filter((e) => e.kind === 'limit')).toEqual([]);
      const ix = new TraceIndex(r);
      for (let i = 0; i < r.events.length; i++) {
        expect(summarize(ix, r.events[i]!).length).toBeGreaterThan(0);
        const e = explain(ix, i);
        expect(e.what.length).toBeGreaterThan(0);
        expect(e.why.length).toBeGreaterThan(0);
      }
      if (ex.compare) {
        const stdout = r.console.filter((c) => c.level === 'log' || c.level === 'info' || c.level === 'debug').map((c) => c.text);
        expect(stdout).toEqual(realNodeStdout(ex.code));
      }
    });
  }

  it('has every difficulty level and both modes', () => {
    expect(new Set(EXAMPLES.map((e) => e.difficulty)).size).toBe(4);
    expect(new Set(EXAMPLES.map((e) => e.mode)).size).toBe(2);
    expect(new Set(EXAMPLES.map((e) => e.id)).size).toBe(EXAMPLES.length);
  });

  it('produces the documented browser outputs', () => {
    const out = (id: string) => execute({ source: byId(id).code, mode: 'browser' }).console.map((c) => c.text);
    expect(out('timeout-zero')).toEqual(['1: script start', '2: script end', '3: promise', '4: timeout']);
    expect(out('this-binding')).toEqual(['Ada', 'window', 'Ada', 'window', 'window', 'arrow inside a callback: Ada']);
    expect(out('debounce')).toEqual(['saved: Hello']);
    expect(out('microtasks-vs-tasks')).toEqual(['microtask 1', 'queueMicrotask', 'microtask 2', 'timeout 1', 'microtask from timeout 1', 'timeout 2']);
  });
});
