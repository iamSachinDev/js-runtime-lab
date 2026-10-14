# JS Runtime Lab

A frontend-only app that runs your JavaScript and shows exactly how it executes: the call stack, Web/Node APIs, every queue, the event loop's phases, variables, closures and console output. Everything is replayable step by step, forwards and backwards.

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # 77 tests, including differential tests against real Node.js
npm run build      # typecheck + production build into dist/
```

Requires Node.js 20.19+ (Vite 8). No server, database or API keys: everything runs in the browser.

## How it works

```
source ──► Babel instrumenter ──► disposable Web Worker ──► trace (typed events) ──► replay UI
            (AST analysis +         runs the real code with      run-start, step, enter,     snapshot index:
             hooks per statement,   virtual Promise, timers,     schedule, enqueue,          O(25) random access,
             call, await, yield)    nextTick, setImmediate,      task-start, phase,          step backward,
                                    fs, fetch, Date              checkpoint, console …       breakpoints
```

1. **Instrumentation** (`src/engine/instrument`). Babel parses the code, resolves scopes and closures, then injects hooks for statements, function entry and exit, `catch`, `await` and `yield`. Async functions become generators driven by a spec-compliant driver, so every suspension and resumption is observable. Unsupported constructs (`eval`, `new Function`, `with`, async generators, `for await`, dynamic `import()`) are rejected with explanations, never faked.
2. **Execution** (`src/engine/runtime`). Your code really runs. Only the asynchronous primitives are replaced:
   - **Promise.** ECMA-262 §27.2 is implemented step for step on the simulated microtask queue, so tick counts match V8 (for example `return promise` costing two extra ticks).
   - **Node.js mode.** libuv's phases (timers → pending → idle/prepare → poll → check → close) are mirrored, along with Node's per-duration timer lists from `lib/internal/timers.js` and `processTicksAndRejections` after every callback.
   - **Browser mode.** Follows the HTML event loop: one task, a microtask checkpoint, and rendering opportunities at 60 Hz. Scripts run as real global code, so top-level `var` and sloppy-mode `this` behave as they do in a browser.
   - **Virtual time.** Each operation costs 1 µs, and waits are skipped. Runs are deterministic and long timers replay instantly.
3. **Trace model** (`src/engine/trace`). A reducer turns events into runtime state, snapshotting every 25 events. Seeking anywhere costs at most 25 re-applies, which is what makes step-backward and timeline jumps instant.
4. **Explanations** (`src/engine/explain`). Deterministic rules over trace events and AST metadata produce "what happened", "why", "what happens next" and interview insights. No AI model is involved.
5. **UI** (`src/components`). The trace drives everything:
   - Queue-to-stack moves are shared-layout animations keyed by task identity; await continuations travel back as the suspended frame itself.
   - Tokens fly from the editor line to the target queue.
   - The SVG event-loop ring tracks the active phase.

## Correctness

| Suite | Coverage |
|---|---|
| `test/engine.test.ts` (38) | **15 differential tests: the same program runs in the simulator and in the real `node` binary, and outputs must match.** Also covered: the required example, race detection, errors and crashes, every safety limit, frame and task balancing, closures, TDZ, await suspension. |
| `test/trace.test.ts` (31) | Random access equals full replay. Token and frame identity across queues. All 25 examples run cleanly, and **all 17 deterministic Node examples match real Node.js stdout.** |
| `test/ui.test.tsx` (8) | jsdom render of the real app: replays every event of every example, plus the timeline scrolling mid-step, breakpoints, inspector tabs and the React Flow graph, the example library, error notices, and the presentation and mobile layouts. Monaco and the worker transport are mocked; results still cross a `structuredClone` boundary. |

**Honest nondeterminism.** Some orderings are genuinely racy in real Node.js, for example `setTimeout(0)` vs `setImmediate` in the main module. When the simulator detects one, it shows one valid order and marks the race in the timeline instead of presenting it as the only answer.

## Security model

- User code runs only in a **disposable module Web Worker**, one per run and never in the page.
- **Results are protected.** Each run uses a random nonce, and `postMessage` is shadowed while user code runs, so programs can't forge results.
- **Budgets:**

  | Limit | Value |
  |---|---|
  | Operations | 5M |
  | CPU time | 3 s |
  | Trace events | 25k |
  | Callbacks | 2k |
  | Microtasks per checkpoint | 5k |
  | Virtual time | 10 min |
  | Console lines | 1k |

- **Watchdog.** An 8-second wall-clock timer terminates the worker. This catches native hangs that instrumentation can't interrupt, such as catastrophic regular expressions. An infinite loop never freezes the UI.
- **Production headers.** `public/_headers` (Netlify / Cloudflare Pages format) ships a CSP with `connect-src 'none'`, which blocks all network access from the page and the sandbox. `fetch` is simulated with built-in fixtures (`/api/user`, `/api/users`, `/api/todos`, `/api/slow`, `/api/error`). `'unsafe-eval'` is required because instrumented code is compiled at runtime. The dev server doesn't apply these headers.

## Limitations

- **Single file.** No `import` or `export`, and no npm packages. In Node mode only `fs` (in-memory), `events`, `util`, `path`, `timers` and `timers/promises` are available.
- **Idealized virtual time.** Real-world timer drift isn't modelled.
- **Strict-mode browser scripts.** With `"use strict"`, top-level `var` doesn't become a `window` property, because of indirect-eval semantics.
- **Method source.** `toString()` on class and object methods shows instrumented source. Plain functions show the original source.
- **Host-native promises.** Promises returned by other host APIs aren't traced.

## Project layout

```
src/engine/types.ts               typed trace event schema (single source of truth)
src/engine/instrument/            Babel analysis + instrumentation
src/engine/runtime/               tracer, event loops, Promise, Node/Web APIs, serializer
src/engine/trace/                 reducer + snapshot index, labels and formatting
src/engine/explain/               explanation rules
src/sandbox/                      worker entry + client (nonce, watchdog, termination)
src/store/store.ts                Zustand: runs, playback, breakpoints, persistence
src/components/                   Board, Inspector, Editor, Timeline, Chrome, ui
src/examples/                     25 examples across Beginner → Interview challenge
```

**Keyboard shortcuts:**

| Key | Action |
|---|---|
| Ctrl/⌘ + Enter | Run |
| Space | Play or pause |
| ← / → | Step backward or forward |
| Home / End | Jump to start or end |
| F | Presentation mode |
| Esc | Exit presentation mode |
