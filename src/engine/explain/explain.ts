import type { QueueId, StmtMeta, TaskInfo, TraceEvent } from '../types';
import { fmtMs, PHASE_LABEL, QUEUE_LABEL, svShort } from '../trace/format';
import type { TraceIndex } from '../trace/model';

/**
 * Deterministic explanations derived from trace events and AST metadata.
 * No model is involved: every sentence comes from the rules below.
 */

export type Tone = 'active' | 'promise' | 'timer' | 'tick' | 'io' | 'check' | 'done' | 'error' | 'neutral';

export interface Insight {
  question: string;
  answer: string;
}

export interface Explanation {
  title: string;
  what: string;
  why: string;
  next: string;
  insight?: Insight;
  tone: Tone;
}

const q = (s: string) => `“${s}”`;

function taskTone(task: Pick<TaskInfo, 'kind'>): Tone {
  switch (task.kind) {
    case 'timeout':
    case 'interval':
      return 'timer';
    case 'promise':
    case 'await':
    case 'thenable':
    case 'microtask':
      return 'promise';
    case 'nextTick':
      return 'tick';
    case 'io':
    case 'raf':
      return 'io';
    case 'immediate':
      return 'check';
    default:
      return 'active';
  }
}

function stmtLine(m: StmtMeta | undefined): string {
  if (!m) return 'Next statement';
  const d = m.detail;
  switch (d.kind) {
    case 'declare':
      return `${d.declKind} ${d.names?.join(', ') ?? ''}${d.text ? ` = ${d.text}` : ''}`;
    case 'call':
      return `Call ${d.text ?? m.snippet}`;
    case 'assign':
      return d.text ?? m.snippet;
    case 'if':
      return `if (${d.text ?? '…'})`;
    case 'await':
      return `await ${d.text ?? ''}`;
    case 'return':
      return d.text ? `return ${d.text}` : m.snippet;
    default:
      return m.snippet;
  }
}

/** One-line description for the timeline. */
export function summarize(ix: TraceIndex, ev: TraceEvent): string {
  const label = (id: number) => ix.taskLabel(id);
  switch (ev.kind) {
    case 'run-start':
      return ev.mode === 'node' ? 'Node.js loads the main module' : 'The browser runs the script';
    case 'step':
      return stmtLine(ix.result.meta.statements[ev.stmtId]);
    case 'enter':
      if (ev.frame.kind === 'main') return ev.mergedFrameId === undefined ? 'Create the global execution context' : 'Main script frame starts';
      return `Call ${ev.frame.name}(${(ev.frame.args ?? []).map((a) => svShort(a.value, 14)).join(', ')})`;
    case 'exit':
      if (ix.frames.get(ev.frameId)?.kind === 'task') return `${ix.frameName(ev.frameId)} finished`;
      return ev.reason === 'return' ? `${ix.frameName(ev.frameId)} returns ${svShort(ev.value, 24)}` : `${ix.frameName(ev.frameId)} unwinds (exception)`;
    case 'suspend':
      return ev.reason === 'await' ? `${ix.frameName(ev.frameId)} pauses at await` : `${ix.frameName(ev.frameId)} yields ${svShort(ev.value, 20)}`;
    case 'resume':
      return `${ix.frameName(ev.frameId)} resumes`;
    case 'catch':
      return `catch receives ${svShort(ev.error, 30)}`;
    case 'schedule':
      return ev.target === 'webapi'
        ? `${ev.api}: ${ev.task.label}${ev.task.delay !== undefined && ev.task.kind !== 'io' ? ` (${ev.task.delay} ms)` : ''}`
        : `${ev.api}: ${ev.task.label} → ${QUEUE_LABEL[ev.target]}`;
    case 'enqueue':
      return `${label(ev.id)} → ${QUEUE_LABEL[ev.queue]}`;
    case 'cancel':
      return `${ev.api} cancels ${label(ev.id)}`;
    case 'task-start':
      return ev.queue === 'main' ? 'Run the main script' : `Run ${ev.task.label}`;
    case 'task-end':
      return `${label(ev.id)} done${ev.status === 'error' ? ' (threw)' : ''}`;
    case 'phase':
      return `${PHASE_LABEL[ev.phase]} phase${ev.empty ? ' — nothing to run' : ''}`;
    case 'checkpoint':
      return ev.state === 'start'
        ? `Drain the ${ev.queue === 'nextTick' ? 'nextTick' : 'microtask'} queue`
        : `${ev.queue === 'nextTick' ? 'nextTick' : 'Microtask'} queue empty`;
    case 'idle':
      return `Wait ${fmtMs(ev.to - ev.from)} ms (nothing ready)`;
    case 'console':
      return `${ev.api}: ${ev.text.split('\n')[0]}`;
    case 'promise':
      return ev.op === 'create' ? `Promise #${ev.promise.id} created` : `Promise #${ev.promise.id} ${ev.promise.state}`;
    case 'error':
      return ev.source === 'syntax' ? ev.error.message : `Uncaught ${ev.error.name}: ${ev.error.message}`;
    case 'limit':
      return 'Execution stopped by a safety limit';
    case 'note':
      return 'Timing-dependent order';
    case 'run-end':
      return ev.status === 'completed' ? 'Program finished' : `Program ${ev.status} (exit code ${ev.exitCode})`;
  }
}

function queueWhy(queue: QueueId | 'main' | 'internal', task: TaskInfo, ix: TraceIndex): string {
  const node = ix.mode === 'node';
  switch (queue) {
    case 'main':
      return node
        ? 'Node wraps your file in a module function and runs it synchronously. Nothing asynchronous can run until it finishes.'
        : 'A script runs as one task. The event loop can’t run anything else until it completes.';
    case 'nextTick':
      return 'After every callback, Node empties the nextTick queue first, then the microtask queue.';
    case 'microtask':
      return task.kind === 'await'
        ? 'The awaited value settled earlier; the continuation waited in the microtask queue and the call stack is now empty.'
        : node
          ? 'The call stack is empty and the nextTick queue is drained, so microtasks run in FIFO order.'
          : 'The call stack is empty, so the microtask queue is drained in FIFO order before anything else.';
    case 'timers':
      return `It was scheduled at t=${fmtMs(task.createdAt)} ms with a ${task.delay} ms delay, so it became due at t=${fmtMs(task.dueAt ?? 0)} ms.`;
    case 'poll':
      return 'Its operation finished, so libuv delivers the result in the poll phase.';
    case 'check':
      return 'The check phase runs setImmediate callbacks in the order they were queued.';
    case 'task':
      return task.kind === 'io'
        ? 'The response arrived, the call stack is empty and no microtasks are pending, so the event loop takes this task.'
        : 'Its timer expired, the call stack is empty and no microtasks are pending, so the event loop takes this task.';
    case 'raf':
      return 'The browser is about to render a frame, so it runs animation frame callbacks first.';
    case 'internal':
      return 'Node emits a process event and calls its listeners synchronously.';
  }
}

function nextText(ix: TraceIndex, seq: number): string {
  const next = ix.events[seq + 1];
  if (!next) return 'Nothing. The trace has ended.';
  const s = summarize(ix, next);
  if (next.kind === 'task-start') return `${s}. ${queueWhy(next.queue, next.task, ix)}`;
  if (next.kind === 'phase') return `${s}. The event loop moves on to its next phase.`;
  if (next.kind === 'idle') return `${s}. ${next.reason}`;
  if (next.kind === 'checkpoint' && next.state === 'start')
    return `${s}. The callback finished, so pending ${next.queue === 'nextTick' ? 'process.nextTick callbacks' : 'microtasks'} run before the event loop continues.`;
  return `${s}.`;
}

function scheduleExplain(ix: TraceIndex, ev: Extract<TraceEvent, { kind: 'schedule' }>): Pick<Explanation, 'what' | 'why' | 'insight'> {
  const node = ix.mode === 'node';
  const t = ev.task;
  const api = ev.api;
  if (api === 'setTimeout' || api === 'setInterval') {
    const clamp = node && t.delay === 1 ? ' (Node.js treats a 0 ms delay as 1 ms)' : '';
    return {
      what: `${api} hands ${q(t.label)} to the ${node ? 'libuv timer heap' : 'browser’s timer system'} with a ${t.delay} ms delay${clamp}. It is due at t=${fmtMs(t.dueAt ?? 0)} ms.`,
      why: node
        ? 'Timers don’t interrupt running code. When the delay has passed, the next timers phase runs the callback, and only once the call stack is empty.'
        : 'When the delay has passed, the browser queues a task. The event loop runs it only when the call stack is empty and every microtask is done.',
      insight:
        t.delay !== undefined && t.delay <= 1
          ? {
              question: 'Does setTimeout(fn, 0) run immediately?',
              answer: node
                ? 'No. Node clamps the delay to 1 ms, and the callback still waits for the current code, all nextTicks and microtasks, and the next timers phase.'
                : 'No. It queues a task after at least 0 ms (4 ms once timers nest more than 5 levels deep). Synchronous code and all microtasks run first.',
            }
          : undefined,
    };
  }
  if (api === 'setInterval (re-armed)')
    return {
      what: `The interval re-arms itself: ${q(t.label)} runs again at t=${fmtMs(t.dueAt ?? 0)} ms (run #${t.repeatRun}).`,
      why: node
        ? 'Node re-inserts an interval after its callback runs, measuring the next delay from when the callback started.'
        : 'An interval re-schedules itself after each run until clearInterval is called.',
    };
  if (t.kind === 'io')
    return {
      what: `${t.detail ?? api} starts in the background and takes about ${t.delay} ms.`,
      why: node
        ? api.startsWith('fs')
          ? 'File operations run on libuv’s thread pool, not on the JavaScript thread. When the work finishes, its callback is queued for the poll phase.'
          : 'The request happens outside JavaScript. When the response arrives, the poll phase delivers it.'
        : 'The network request happens outside JavaScript (this one is simulated). When the response arrives, a task is queued to settle the promise.',
      insight: node
        ? {
            question: 'Is Node.js single-threaded?',
            answer: 'Your JavaScript runs on one thread, but libuv uses a thread pool (and OS async APIs) for I/O. Callbacks always come back to the single JavaScript thread through the event loop.',
          }
        : undefined,
    };
  switch (ev.target) {
    case 'nextTick':
      return {
        what: `process.nextTick queues ${q(t.label)}.`,
        why: 'The nextTick queue isn’t an event loop phase. Node drains it as soon as the current callback finishes, before promise callbacks and before the loop moves on.',
        insight: {
          question: 'process.nextTick vs setImmediate: which runs first?',
          answer: 'nextTick, despite the names. nextTick callbacks run right after the current operation; setImmediate waits for the check phase of the event loop.',
        },
      };
    case 'microtask':
      if (api === 'await')
        return {
          what: `The awaited value settled, so the rest of ${q(t.label.replace(/^resume |\(\) after await$/g, ''))} is queued as a microtask.`,
          why: 'await always resumes asynchronously, even if the value was already available. The continuation is an ordinary promise reaction job.',
        };
      if (api === 'resolve(thenable)')
        return {
          what: 'A promise was resolved with a thenable (an object with a then method). Adopting its state is queued as a separate job.',
          why: 'The spec calls then() in a fresh microtask (NewPromiseResolveThenableJob), so resolving with a promise costs extra ticks.',
          insight: {
            question: 'Why can `return await p` be faster than `return p` in an async function?',
            answer: 'Returning a promise resolves the async function’s promise with a thenable, which takes two extra microtask ticks. Awaiting first unwraps it directly.',
          },
        };
      if (api === 'queueMicrotask')
        return { what: `queueMicrotask adds ${q(t.label)} straight to the microtask queue.`, why: 'It runs after the current code, together with promise reactions, before any timer or I/O callback.' };
      return {
        what: `${q(t.label)} is queued as a microtask${t.promiseId ? ` because promise #${t.promiseId} settled` : ''}.`,
        why: `Promise reactions never run synchronously, even for a promise that is already settled. They wait in the microtask queue, which is drained as soon as the call stack is empty${node ? ' (after the nextTick queue)' : ''}.`,
        insight: {
          question: 'Why does .then() on an already-resolved promise still run later?',
          answer: 'Reactions are always enqueued as jobs. This guarantees consistent ordering: code after .then() runs first, every time.',
        },
      };
    case 'check':
      return {
        what: `${api} queues ${q(t.label)} for the check phase.`,
        why: 'The check phase runs right after poll on every loop iteration. Immediates queued while the check phase is running wait for the next iteration.',
        insight:
          ix.tasks.get(t.parentId ?? -1)?.kind === 'io'
            ? {
                question: 'Inside an I/O callback, does setTimeout(0) or setImmediate run first?',
                answer: 'setImmediate, always: check comes right after poll, while timers must wait for the next iteration.',
              }
            : undefined,
      };
    case 'raf':
      return {
        what: `requestAnimationFrame registers ${q(t.label)} to run before the next repaint.`,
        why: 'Browsers render at most once per display frame (about every 16.7 ms at 60 Hz). Animation callbacks run in the render step, not as regular tasks.',
      };
    default:
      return {
        what: `${api} queues ${q(t.label)}${ev.target === 'webapi' ? '' : ` in the ${QUEUE_LABEL[ev.target]}`}.`,
        why: 'It will run when the event loop reaches that queue.',
      };
  }
}

export function explain(ix: TraceIndex, seq: number): Explanation {
  const ev = ix.events[seq];
  if (!ev)
    return {
      title: 'Ready',
      what: 'Press Run to execute the code and record a trace.',
      why: 'Every call, scheduled callback and queue movement is recorded, then replayed here step by step.',
      next: 'Step forward to see the first event.',
      tone: 'neutral',
    };
  const node = ix.mode === 'node';
  const next = nextText(ix, seq);
  const title = summarize(ix, ev);
  const base = { title, next };
  switch (ev.kind) {
    case 'run-start':
      return {
        ...base,
        tone: 'active',
        what: node ? 'Node.js starts running your file as a CommonJS module.' : 'The browser starts running your script.',
        why: node
          ? 'Node wraps the file in a function (exports, require, module, __filename, __dirname), runs it to completion, then starts the event loop.'
          : 'The whole script runs synchronously as one task before the event loop picks anything else.',
      };
    case 'step': {
      const m = ix.result.meta.statements[ev.stmtId];
      const fn = m ? ix.result.meta.functions[m.fnId] : undefined;
      const changed = (ev.vars ?? []).filter((v) => v.value.t !== 'tdz').map((v) => `${v.name} = ${svShort(v.value, 28)}`);
      const where = fn && fn.id !== 0 ? `inside ${fn.name}` : 'in the main script';
      let why = `Execution continues line by line ${where}.`;
      let insight: Insight | undefined;
      if (m?.detail.kind === 'declare' && m.detail.declKind === 'var')
        why = 'var declarations are hoisted to the top of their function: the variable existed (as undefined) before this line. Only the assignment happens here.';
      else if (m?.detail.kind === 'declare' && (m.detail.declKind === 'let' || m.detail.declKind === 'const')) {
        why = `${m.detail.declKind} bindings are hoisted too, but stay uninitialized (the temporal dead zone) until this line runs. Reading them earlier throws a ReferenceError.`;
        if (m.tdz.length)
          insight = {
            question: 'Are let and const hoisted?',
            answer: 'Yes, but they are not initialized. Between the start of the scope and the declaration, they’re in the temporal dead zone, and any access throws.',
          };
      } else if (m?.detail.kind === 'call') why = `Calling a function pushes a new frame onto the call stack. ${q(m.detail.text ?? '')} must finish before the next line runs.`;
      else if (m?.detail.kind === 'await') why = 'The expression is evaluated first; then await pauses the function until the value settles.';
      else if (m?.detail.kind === 'throw') why = 'throw stops normal execution: frames unwind until a catch block handles the exception.';
      return {
        ...base,
        tone: 'active',
        what: `Line ${ev.line}: ${m?.snippet ?? ''}${changed.length ? `. Now ${changed.join(', ')}.` : ''}`,
        why,
        insight,
      };
    }
    case 'enter': {
      const f = ev.frame;
      if (f.kind === 'main')
        return {
          ...base,
          tone: 'active',
          what: node ? 'The module function starts: its scope holds your top-level variables.' : 'The global execution context is created for the script.',
          why: 'Before running, the engine hoists function declarations (fully) and var declarations (as undefined). let, const and class names start in the temporal dead zone.',
          insight: {
            question: 'What is hoisting?',
            answer: 'Declarations are registered when a scope is created, before any line runs. Function declarations are usable immediately; var is undefined until assigned; let, const and class throw until initialized.',
          },
        };
      const args = (f.args ?? []).map((a) => `${a.name} = ${svShort(a.value, 20)}`).join(', ');
      const recursive = ix.events.slice(0, seq).filter((e) => e.kind === 'enter' && e.frame.fnId === f.fnId).length > 0;
      return {
        ...base,
        tone: 'active',
        what: `${ev.mergedFrameId !== undefined ? 'The callback starts executing as' : 'Calls'} ${f.name}(${args ? `${args}` : ''}). A frame is pushed onto the call stack.`,
        why: `Each call gets its own execution context, with its own local variables. The frame stays on the stack until the function returns.${f.async ? ' It is an async function: it runs synchronously until its first await.' : ''}`,
        insight: recursive
          ? {
              question: 'What causes “Maximum call stack size exceeded”?',
              answer: 'Every call adds a frame. Recursion without a reachable base case keeps adding frames until the engine runs out of stack space.',
            }
          : undefined,
      };
    }
    case 'exit': {
      const name = ix.frameName(ev.frameId);
      const info = ix.frames.get(ev.frameId);
      if (info?.kind === 'task')
        return { ...base, tone: 'done', what: `${name} finished.`, why: 'The callback completed, so its frame leaves the call stack.' };
      if (ev.reason === 'unwind')
        return {
          ...base,
          tone: 'error',
          what: `${name} is abandoned: an exception propagated out of it.`,
          why: 'A function that throws without catching loses its frame, and the exception continues to its caller.',
        };
      if (info?.kind === 'main')
        return {
          ...base,
          tone: 'done',
          what: 'The main script finished running.',
          why: 'Its variables stay alive as long as any function still references them. Now queued callbacks get their turn.',
        };
      return {
        ...base,
        tone: 'done',
        what: `${name} returns ${svShort(ev.value, 40)}. Its frame is popped off the call stack.`,
        why: ev.retained
          ? 'Its variables survive the return because a function created inside it still references them. That is a closure.'
          : 'Nothing references its local variables any more, so they can be garbage-collected.',
        insight: ev.retained
          ? {
              question: 'What is a closure?',
              answer: 'A function bundled with the variables of the scope where it was created. They outlive the outer call because the inner function still references them.',
            }
          : undefined,
      };
    }
    case 'suspend':
      return ev.reason === 'await'
        ? {
            ...base,
            tone: 'promise',
            what: `${ix.frameName(ev.frameId)} reaches await ${svShort(ev.value, 30)} and pauses.`,
            why: 'await hands control back to the caller. The frame leaves the call stack with its local variables saved; the rest of the function runs later as a microtask, once the awaited value settles.',
            insight: {
              question: 'Does await block the thread?',
              answer: 'No. Only this function pauses; the caller continues immediately with a pending promise, and other code keeps running.',
            },
          }
        : {
            ...base,
            tone: 'active',
            what: `${ix.frameName(ev.frameId)} yields ${svShort(ev.value, 30)} and pauses.`,
            why: 'A generator pauses at yield until its caller asks for the next value.',
          };
    case 'resume':
      return {
        ...base,
        tone: ev.reason === 'await' ? 'promise' : 'active',
        what: `${ix.frameName(ev.frameId)} resumes${ev.reason === 'await' ? ' after await' : ''}.`,
        why: 'Its frame returns to the call stack with every local variable exactly as it was.',
      };
    case 'catch':
      return {
        ...base,
        tone: 'error',
        what: `The catch block receives ${svShort(ev.error, 40)}.`,
        why: 'try/catch stopped the exception from propagating further up the call stack.',
        insight: {
          question: 'Can try/catch catch an error thrown in a setTimeout callback?',
          answer: 'No. By the time the callback runs, the try block has finished and its frame is gone. Handle errors inside the callback, or use promises with await.',
        },
      };
    case 'schedule': {
      const r = scheduleExplain(ix, ev);
      return { ...base, ...r, tone: taskTone(ev.task) };
    }
    case 'enqueue': {
      const t = ix.tasks.get(ev.id);
      const label = t ? q(t.label) : `#${ev.id}`;
      return {
        ...base,
        tone: t ? taskTone(t) : 'neutral',
        what:
          ev.queue === 'timers'
            ? `The timer for ${label} has expired. It joins the timers queue for this phase.`
            : ev.queue === 'poll'
              ? `${t?.detail ?? 'The I/O operation'} completed. Its callback is ready to run in the poll phase.`
              : `${ev.reason === 'timer expired' ? `The timer for ${label} expired` : 'The response arrived'}, so a task is added to the task queue.`,
        why:
          ev.queue === 'timers'
            ? 'At the start of the timers phase, Node collects every timer whose delay has elapsed and runs them in order of expiry.'
            : ev.queue === 'poll'
              ? 'The poll phase picks up completed I/O and runs the callbacks.'
              : 'Expired timers and finished requests become tasks. The event loop runs one task at a time, oldest first.',
      };
    }
    case 'cancel':
      return {
        ...base,
        tone: 'neutral',
        what: `${ev.api} cancels ${q(ix.taskLabel(ev.id))}. It will never run.`,
        why: 'Cancelling removes the callback before the event loop reaches it.',
      };
    case 'task-start': {
      const t = ev.task;
      const what =
        ev.queue === 'main'
          ? 'The main script starts on the call stack.'
          : t.kind === 'await'
            ? `${t.label.replace(/^resume /, '').replace(/ after await$/, '')} resumes after await.`
            : `The ${QUEUE_LABEL[ev.queue as QueueId] ?? 'event loop'} hands ${q(t.label)} to the call stack.`;
      const insight: Insight | undefined =
        ev.queue === 'microtask' && t.kind === 'promise'
          ? {
              question: 'Microtasks vs macrotasks: what is the difference?',
              answer: 'Macrotasks (timers, I/O, events) run one per loop turn. After each one, the entire microtask queue is drained, including microtasks added during the drain.',
            }
          : ev.queue === 'check'
            ? { question: 'When should you use setImmediate?', answer: 'To run something after the current poll phase completes, for example to yield after I/O without waiting for timers.' }
            : undefined;
      return { ...base, tone: taskTone(t), what, why: queueWhy(ev.queue, t, ix), insight };
    }
    case 'task-end': {
      const t = ix.tasks.get(ev.id);
      return {
        ...base,
        tone: ev.status === 'error' ? 'error' : 'done',
        what: `${t ? q(t.label) : 'The callback'} finished${ev.status === 'error' ? ' by throwing an exception' : ''}. The call stack is empty.`,
        why: node
          ? 'After every callback, Node runs pending process.nextTick callbacks and then all microtasks, before the event loop continues.'
          : 'After every task, the browser performs a microtask checkpoint before rendering or picking the next task.',
      };
    }
    case 'phase': {
      const desc: Record<string, string> = {
        timers: 'This phase runs setTimeout and setInterval callbacks whose delay has elapsed.',
        pending: 'Runs I/O callbacks deferred from the previous iteration, such as some TCP errors. Usually empty.',
        idle: 'Internal phases libuv uses for housekeeping. No JavaScript runs here.',
        poll: 'Retrieves completed I/O and runs its callbacks. With nothing else scheduled, the loop waits here for I/O or the next timer.',
        check: 'Runs setImmediate callbacks.',
        close: "Runs close callbacks, such as socket.on('close'). Usually empty.",
        task: 'A new event loop iteration: pick the oldest runnable task.',
        render: 'A rendering opportunity: requestAnimationFrame callbacks run, then the browser may paint.',
        main: 'The main script.',
      };
      return {
        ...base,
        tone: 'neutral',
        what: `The event loop enters the ${PHASE_LABEL[ev.phase].toLowerCase()} phase${node ? ` (iteration ${ev.iteration})` : ''}.${ev.empty ? ' Nothing is waiting here, so it moves on.' : ''}`,
        why: desc[ev.phase] ?? '',
        insight:
          ev.phase === 'poll' && !ev.empty
            ? {
                question: 'Name the Node.js event loop phases in order.',
                answer: 'timers → pending callbacks → idle/prepare → poll → check → close callbacks. nextTick and microtask queues are drained between every callback, not as phases.',
              }
            : undefined,
      };
    }
    case 'checkpoint':
      if (ev.state === 'end')
        return { ...base, tone: 'neutral', what: `The ${ev.queue === 'nextTick' ? 'nextTick' : 'microtask'} queue is empty.`, why: 'Draining stops only when nothing is left, including work queued during the drain.' };
      return {
        ...base,
        tone: ev.queue === 'nextTick' ? 'tick' : 'promise',
        what: ev.queue === 'nextTick' ? 'Node drains the process.nextTick queue.' : 'The microtask queue is drained.',
        why:
          ev.queue === 'nextTick'
            ? 'Every nextTick callback runs, including ones added while draining, before any promise microtask.'
            : node
              ? 'After the nextTick queue, every microtask runs. This checkpoint happens after every single callback, not as a loop phase.'
              : 'After every task, the browser runs all microtasks before it renders or starts another task.',
        insight: {
          question: 'Can microtasks starve the event loop?',
          answer: 'Yes. A microtask that always queues another keeps the checkpoint running forever, so timers, I/O and rendering never get a turn.',
        },
      };
    case 'idle':
      return {
        ...base,
        tone: 'neutral',
        what: `Nothing is ready to run. Virtual time jumps from ${fmtMs(ev.from)} ms to ${fmtMs(ev.to)} ms.`,
        why: `${ev.reason} The simulator skips the waiting instead of sleeping, so long timers replay instantly.`,
      };
    case 'console':
      return {
        ...base,
        tone: ev.level === 'error' ? 'error' : 'active',
        what: `${ev.api} prints ${q(ev.text.length > 80 ? `${ev.text.slice(0, 79)}…` : ev.text)}.`,
        why: 'Console output happens synchronously, in the middle of the code that is running.',
      };
    case 'promise':
      return ev.op === 'create'
        ? { ...base, tone: 'promise', what: `Promise #${ev.promise.id} is created by ${ev.promise.origin}. It starts pending.`, why: 'A promise is a placeholder for a value that will be available later.' }
        : {
            ...base,
            tone: ev.promise.state === 'rejected' ? 'error' : 'promise',
            what: `Promise #${ev.promise.id} is ${ev.promise.state} with ${svShort(ev.promise.value, 40)}.`,
            why: 'Settling is final. Every reaction registered with then, catch, finally or await is queued as a microtask.',
          };
    case 'error': {
      if (ev.source === 'syntax')
        return { ...base, tone: 'error', what: ev.error.message, why: 'The code could not be parsed or isn’t supported by the simulator, so nothing ran.' };
      const rejection = ev.source === 'unhandled-rejection';
      return {
        ...base,
        tone: 'error',
        what: `${rejection ? 'Unhandled promise rejection' : 'Uncaught exception'}: ${ev.error.name}: ${ev.error.message}.`,
        why: node
          ? rejection
            ? 'No handler was attached by the end of the microtask checkpoint. Since Node.js 15 an unhandled rejection crashes the process (exit code 1), unless process.on("unhandledRejection") handles it.'
            : 'Nothing caught it before it reached the event loop. Without a process.on("uncaughtException") handler, Node prints the error and exits; remaining callbacks never run.'
          : 'The browser reports it in the console, abandons the current task and keeps running the event loop.',
        insight: rejection
          ? { question: 'How do you avoid unhandled rejections?', answer: 'Attach .catch() to every promise chain, or await inside try/catch. Floating promises are a common production bug.' }
          : undefined,
      };
    }
    case 'limit':
      return { ...base, tone: 'error', what: ev.message, why: 'Safety limits keep runaway code from freezing the page. The trace up to this point is still valid.' };
    case 'note':
      return {
        ...base,
        tone: 'timer',
        what: ev.message,
        why: 'Node schedules timers by the clock, so whether a 1 ms timer is due at a given phase depends on real elapsed time.',
        insight: {
          question: 'In the main module, does setTimeout(0) or setImmediate run first?',
          answer: 'It is non-deterministic: it depends on process performance. Inside an I/O callback, setImmediate always runs first.',
        },
      };
    case 'run-end':
      return {
        ...base,
        tone: ev.status === 'completed' ? 'done' : 'error',
        what:
          ev.status === 'completed'
            ? 'The program finished: nothing is left to run.'
            : ev.status === 'exited'
              ? `process.exit(${ev.exitCode}) ended the process.`
              : ev.status === 'crashed'
                ? 'The process crashed with exit code 1.'
                : 'Execution was stopped by a safety limit.',
        why: node
          ? 'Node exits when the event loop has no timers, pending I/O or immediates left.'
          : 'No timers, requests or animation frames are pending, so the event loop goes idle.',
      };
  }
}
