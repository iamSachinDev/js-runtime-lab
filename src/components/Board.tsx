import { AnimatePresence, LayoutGroup, motion, MotionConfig, useReducedMotion } from 'motion/react';
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { fmtMs, hostLabel, KIND_LABEL, kindTone, PHASE_LABEL, svShort, type Tone } from '../engine/trace/format';
import { initialState, type FrameView, type RuntimeState, type TokenView, type TraceIndex } from '../engine/trace/model';
import type { QueueId, RuntimeMode, TraceEvent } from '../engine/types';
import { lineRect, useZone, zoneRect } from '../lib/zones';
import { useRuntime, useStore } from '../store/store';
import { Empty, PanelHead, TONE_VAR, toneStyle } from './ui';

/* ------------------------------------------------------------------ board */

export function RuntimeBoard() {
  const { index, state, event } = useRuntime();
  const mode = useStore((s) => s.mode);
  const speed = useStore((s) => s.speed);
  const s = state ?? initialState(mode);
  const m: RuntimeMode = index ? s.mode : mode;
  return (
    <MotionConfig reducedMotion="user" transition={{ duration: 0.46 / Math.sqrt(speed), ease: [0.22, 1, 0.36, 1] }}>
      <LayoutGroup>
        <div className="board h-full min-h-0 overflow-y-auto p-3">
          <div className="board-grid">
            <CallStack state={s} index={index} />
            <div className="board-right">
              <HostApis state={s} mode={m} />
              <div className="board-loop">
                <EventLoopRing state={s} mode={m} event={event} />
                <Queues state={s} mode={m} />
              </div>
            </div>
          </div>
        </div>
      </LayoutGroup>
    </MotionConfig>
  );
}

/* ------------------------------------------------------------------ call stack */

function CallStack({ state, index }: { state: RuntimeState; index: TraceIndex | null }) {
  const ref = useZone('stack');
  const frames = state.stack;
  const emptyText = state.seq < 0 ? 'Press Run to start.' : state.done ? 'Empty. The program has finished.' : 'Empty. The event loop decides what runs next.';
  return (
    <section ref={ref} className="glass flex min-h-[240px] flex-col rounded-[10px] p-2.5" aria-label="Call stack">
      <PanelHead title="Call stack" count={frames.length} hint="Functions currently executing. The top frame is running; the ones below wait for it to return." />
      <div className="relative flex min-h-0 flex-1 flex-col-reverse gap-1.5 overflow-y-auto">
        <AnimatePresence initial={false}>
          {frames.map((f, i) => (
            <StackFrame key={f.layoutKey} frame={f} top={i === frames.length - 1} index={index} mode={state.mode} />
          ))}
        </AnimatePresence>
        {frames.length === 0 && (
          <div className="absolute inset-0 grid place-items-center px-3 text-center">
            <Empty>{emptyText}</Empty>
          </div>
        )}
      </div>
      {state.suspended.length > 0 && (
        <div className="mt-2 border-t border-line pt-2">
          <div className="mb-1.5 text-[11.5px] text-muted">Paused at await or yield</div>
          <div className="flex flex-col gap-1">
            {state.suspended.map((f) => (
              <div key={`paused-${f.id}`} className="frame is-paused" style={toneStyle('violet')}>
                <div className="truncate font-mono text-[11.5px]">{f.name}</div>
                <div className="text-[10.5px] text-faint">{f.generator ? 'waits for next()' : 'waits for its microtask'}</div>
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

function StackFrame({ frame: f, top, index, mode }: { frame: FrameView; top: boolean; index: TraceIndex | null; mode: RuntimeMode }) {
  const task = f.kind === 'task' && f.taskId !== undefined ? index?.tasks.get(f.taskId) : undefined;
  const tone: Tone = task ? kindTone(task.kind) : f.async ? 'violet' : 'cyan';
  const args = (f.args ?? []).map((a) => svShort(a.value, 14)).join(', ');
  const title = f.kind === 'function' ? `${f.name}(${args})` : f.name;
  const meta =
    f.kind === 'task'
      ? task
        ? KIND_LABEL[task.kind]
        : 'callback'
      : f.kind === 'main'
        ? mode === 'node'
          ? 'module code'
          : 'global code'
        : f.async
          ? 'async function'
          : f.generator
            ? 'generator'
            : 'function';
  return (
    <motion.div
      layout
      layoutId={f.layoutKey}
      initial={{ opacity: 0, y: -10 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, x: 24, transition: { duration: 0.2 } }}
      className={`frame ${top ? 'is-top' : ''}`}
      style={toneStyle(tone)}
    >
      <div className="truncate font-mono text-[12px] text-text">{title}</div>
      <div className="mt-0.5 flex items-center justify-between gap-2 text-[10.5px] text-faint">
        <span className="truncate">{meta}</span>
        {f.line ? <span className="flex-none">line {f.line}</span> : null}
      </div>
    </motion.div>
  );
}

/* ------------------------------------------------------------------ tokens */

function Token({ token: t, now, host = false }: { token: TokenView; now: number; host?: boolean }) {
  const tone = kindTone(t.kind);
  const span = t.dueAt !== undefined ? t.dueAt - t.createdAt : 0;
  const progress = host && span > 0 ? Math.min(1, Math.max(0, (now - t.createdAt) / span)) : undefined;
  const label = host && t.kind === 'io' && t.detail ? t.detail : t.label;
  const title = [
    `#${t.id} · ${KIND_LABEL[t.kind]}`,
    t.label,
    t.api ? `via ${t.api}` : '',
    t.detail ?? '',
    t.dueAt !== undefined ? `due at t = ${fmtMs(t.dueAt)} ms` : '',
    t.line ? `scheduled on line ${t.line}` : '',
  ]
    .filter(Boolean)
    .join('\n');
  return (
    <motion.div
      layout
      layoutId={t.layoutKey}
      initial={{ opacity: 0, scale: 0.8 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.8, transition: { duration: 0.18 } }}
      className="token"
      style={toneStyle(tone)}
      title={title}
    >
      <span className="token-dot" />
      <span className="token-label">{label}</span>
      {host && t.dueAt !== undefined && <span className="token-meta">{fmtMs(t.dueAt)} ms</span>}
      <span className="token-id">#{t.id}</span>
      {progress !== undefined && <span className="token-bar" style={{ transform: `scaleX(${progress})` }} />}
    </motion.div>
  );
}

function HostApis({ state, mode }: { state: RuntimeState; mode: RuntimeMode }) {
  const ref = useZone('webapis');
  const items = state.webapis;
  const hint =
    mode === 'node'
      ? 'Timers and I/O that libuv is waiting on, outside the JavaScript thread'
      : 'Timers and requests the browser is handling, outside the JavaScript thread';
  return (
    <section ref={ref} className="glass rounded-[10px] p-2.5" aria-label={hostLabel(mode)}>
      <PanelHead title={hostLabel(mode)} count={items.length} hint={hint}>
        <span className="font-mono text-[11px] text-faint" title="Virtual time">
          t = {fmtMs(state.time)} ms
        </span>
      </PanelHead>
      <div className="flex max-h-[86px] min-h-[26px] flex-wrap content-start gap-1.5 overflow-y-auto">
        <AnimatePresence initial={false}>
          {items.slice(0, 12).map((t) => (
            <Token key={t.layoutKey} token={t} now={state.time} host />
          ))}
        </AnimatePresence>
        {items.length > 12 && <span className="self-center text-[11px] text-muted">+{items.length - 12} more</span>}
        {items.length === 0 && (
          <span className="self-center">
            <Empty>No pending timers or I/O.</Empty>
          </span>
        )}
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ queues */

interface LaneDef {
  id: QueueId;
  title: string;
  hint: string;
  tone: Tone;
}

const NODE_LANES: LaneDef[] = [
  { id: 'nextTick', title: 'process.nextTick', hint: 'drained first, after every callback', tone: 'fuchsia' },
  { id: 'microtask', title: 'Microtasks', hint: 'promise reactions and await', tone: 'violet' },
  { id: 'timers', title: 'Timers', hint: 'expired setTimeout and setInterval', tone: 'amber' },
  { id: 'poll', title: 'Poll', hint: 'completed I/O callbacks', tone: 'sky' },
  { id: 'check', title: 'Check', hint: 'setImmediate callbacks', tone: 'mint' },
];

const BROWSER_LANES: LaneDef[] = [
  { id: 'microtask', title: 'Microtasks', hint: 'promise reactions and await', tone: 'violet' },
  { id: 'task', title: 'Task queue', hint: 'timers and network, one per turn', tone: 'amber' },
  { id: 'raf', title: 'Animation frames', hint: 'requestAnimationFrame, before paint', tone: 'sky' },
];

function activeLane(s: RuntimeState): QueueId | null {
  if (s.checkpoint) return s.checkpoint === 'nextTick' ? 'nextTick' : 'microtask';
  switch (s.phase) {
    case 'timers':
    case 'poll':
    case 'check':
    case 'task':
      return s.phaseEmpty ? null : s.phase;
    case 'render':
      return 'raf';
    default:
      return null;
  }
}

function Queues({ state, mode }: { state: RuntimeState; mode: RuntimeMode }) {
  const lanes = mode === 'node' ? NODE_LANES : BROWSER_LANES;
  const active = activeLane(state);
  return (
    <section className="glass flex min-h-0 flex-col gap-2 overflow-y-auto rounded-[10px] p-2.5" aria-label="Queues">
      <PanelHead title="Queues" hint="Callbacks that are ready to run. They wait until the call stack is empty and the event loop reaches them." />
      {lanes.map((lane) => (
        <Lane key={lane.id} lane={lane} tokens={state.queues[lane.id]} active={active === lane.id} now={state.time} />
      ))}
    </section>
  );
}

function Lane({ lane, tokens, active, now }: { lane: LaneDef; tokens: TokenView[]; active: boolean; now: number }) {
  const ref = useZone(`queue-${lane.id}`);
  return (
    <div ref={ref} className={`lane ${active ? 'is-active' : ''}`} style={toneStyle(lane.tone)}>
      <div className="mb-1.5 flex min-w-0 items-center gap-2">
        <span className="lane-dot" />
        <span className="flex-none text-[12px] font-medium text-text">{lane.title}</span>
        <span className="truncate text-[11px] text-faint">{lane.hint}</span>
        {tokens.length > 0 && <span className="ml-auto flex-none text-[11px] text-muted">{tokens.length}</span>}
      </div>
      <div className="flex min-h-[24px] flex-wrap gap-1.5">
        <AnimatePresence initial={false}>
          {tokens.slice(0, 8).map((t) => (
            <Token key={t.layoutKey} token={t} now={now} />
          ))}
        </AnimatePresence>
        {tokens.length > 8 && <span className="self-center text-[11px] text-muted">+{tokens.length - 8} more</span>}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ event loop ring */

interface RingSeg {
  id: string;
  label: string;
  hint: string;
}

const NODE_RING: RingSeg[] = [
  { id: 'timers', label: 'Timers', hint: 'setTimeout and setInterval callbacks whose time has come' },
  { id: 'pending', label: 'Pending', hint: 'I/O callbacks deferred from the previous iteration' },
  { id: 'idle', label: 'Idle, prepare', hint: 'internal libuv housekeeping' },
  { id: 'poll', label: 'Poll', hint: 'completed I/O; the loop waits here when idle' },
  { id: 'check', label: 'Check', hint: 'setImmediate callbacks' },
  { id: 'close', label: 'Close', hint: "'close' event callbacks" },
];

const BROWSER_RING: RingSeg[] = [
  { id: 'task', label: 'Run a task', hint: 'the oldest runnable task' },
  { id: 'microtasks', label: 'Microtasks', hint: 'drain every microtask' },
  { id: 'render', label: 'Render', hint: 'animation frames, style, layout, paint' },
];

const C = 120;
const R = 86;
const SW = 18;

function polar(r: number, deg: number): [number, number] {
  const a = ((deg - 90) * Math.PI) / 180;
  return [C + r * Math.cos(a), C + r * Math.sin(a)];
}

function arcPath(r: number, a0: number, a1: number, reverse = false): string {
  const [x0, y0] = polar(r, reverse ? a1 : a0);
  const [x1, y1] = polar(r, reverse ? a0 : a1);
  const large = a1 - a0 > 180 ? 1 : 0;
  return `M ${x0.toFixed(2)} ${y0.toFixed(2)} A ${r} ${r} 0 ${large} ${reverse ? 0 : 1} ${x1.toFixed(2)} ${y1.toFixed(2)}`;
}

function ringActive(s: RuntimeState, mode: RuntimeMode): string | null {
  if (s.seq < 0 || s.done) return null;
  if (mode === 'browser') {
    if (s.checkpoint === 'microtask') return 'microtasks';
    if (s.phase === 'main' || s.phase === 'task') return 'task';
    return s.phase === 'render' ? 'render' : null;
  }
  return s.phase && s.phase !== 'main' ? s.phase : null;
}

function EventLoopRing({ state, mode, event }: { state: RuntimeState; mode: RuntimeMode; event?: TraceEvent }) {
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const segs = mode === 'node' ? NODE_RING : BROWSER_RING;
  const active = ringActive(state, mode);
  const step = 360 / segs.length;
  const gap = 4;
  const idx = segs.findIndex((x) => x.id === active);
  const target = idx >= 0 ? idx * step + step / 2 : null;

  // Accumulate rotation along the shortest path so the marker never spins backwards a full turn.
  const rot = useRef<{ angle: number; target: number | null }>({ angle: 0, target: null });
  if (target !== null && rot.current.target !== target) {
    const cur = ((rot.current.angle % 360) + 360) % 360;
    let d = target - cur;
    if (d > 180) d -= 360;
    if (d < -180) d += 360;
    rot.current = { angle: rot.current.angle + d, target };
  }

  const idle = event?.kind === 'idle' ? event : null;
  let big: string;
  let small: string;
  let bigTone: Tone = 'cyan';
  if (state.seq < 0) [big, small, bigTone] = ['Ready', 'press Run', 'slate'];
  else if (state.done)
    [big, small, bigTone] =
      state.status === 'completed'
        ? ['Done', 'nothing left to run', 'green']
        : [state.status === 'exited' ? 'Exited' : state.status === 'crashed' ? 'Crashed' : 'Stopped', 'see the timeline', 'coral'];
  else if (idle) [big, small, bigTone] = ['Waiting', `${fmtMs(idle.to - idle.from)} ms until the next event`, 'slate'];
  else if (state.phase === 'main') [big, small] = ['Main script', mode === 'node' ? 'loop starts afterwards' : 'the first task'];
  else if (state.phase) [big, small] = [PHASE_LABEL[state.phase], mode === 'node' ? `loop iteration ${state.iteration}` : `turn ${state.iteration}`];
  else [big, small] = ['Event loop', ''];

  const label = active ? `Event loop: ${segs[idx]?.label} phase active` : `Event loop: ${big}`;
  return (
    <section className="glass flex min-h-[230px] flex-col rounded-[10px] p-2.5" aria-label="Event loop">
      <PanelHead
        title="Event loop"
        hint={
          mode === 'node'
            ? 'libuv phases. nextTick and microtask queues are drained after every callback, between phases.'
            : 'HTML event loop: one task, then all microtasks, then possibly a render.'
        }
      />
      <div className="relative min-h-0 flex-1">
        <svg viewBox="0 0 240 240" className="absolute inset-0 h-full w-full" role="img" aria-label={label}>
          <defs>
            <filter id={`glow-${uid}`} x="-50%" y="-50%" width="200%" height="200%">
              <feGaussianBlur stdDeviation="4" result="b" />
              <feMerge>
                <feMergeNode in="b" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
            {segs.map((sg, i) => {
              const mid = i * step + step / 2;
              return <path key={sg.id} id={`txt-${uid}-${sg.id}`} d={arcPath(R, i * step + gap / 2, (i + 1) * step - gap / 2, mid > 90 && mid < 270)} />;
            })}
          </defs>
          <circle cx={C} cy={C} r={R} fill="none" stroke="var(--color-ink-950)" strokeOpacity="0.6" strokeWidth={SW + 8} />
          {segs.map((sg, i) => {
            const on = sg.id === active;
            const dim = on && mode === 'node' && state.phaseEmpty && !state.checkpoint;
            return (
              <g key={sg.id}>
                <path
                  d={arcPath(R, i * step + gap / 2, (i + 1) * step - gap / 2)}
                  fill="none"
                  stroke={on ? 'var(--color-cyan)' : 'var(--color-ink-600)'}
                  strokeOpacity={dim ? 0.45 : 1}
                  strokeWidth={SW}
                  className={on && !dim ? 'ring-active' : undefined}
                  filter={on && !dim ? `url(#glow-${uid})` : undefined}
                >
                  <title>{`${sg.label}: ${sg.hint}`}</title>
                </path>
                <text fontSize="9.5" fontWeight={on ? 600 : 500} fill={on && !dim ? 'var(--color-ink-950)' : '#b6c6e3'} dy="3.3" style={{ pointerEvents: 'none' }}>
                  <textPath href={`#txt-${uid}-${sg.id}`} startOffset="50%" textAnchor="middle">
                    {sg.label}
                  </textPath>
                </text>
              </g>
            );
          })}
          {target !== null && (
            <g
              style={{
                transform: `rotate(${rot.current.angle}deg)`,
                transformOrigin: `${C}px ${C}px`,
                transition: 'transform 0.5s cubic-bezier(0.22, 1, 0.36, 1)',
              }}
            >
              <circle cx={C} cy={C - R - SW / 2 - 7} r="4" fill="var(--color-cyan)" filter={`url(#glow-${uid})`} />
            </g>
          )}
        </svg>
        <div className="pointer-events-none absolute inset-0 grid place-items-center">
          <div className="flex max-w-[118px] flex-col items-center text-center">
            <div className="text-[14px] leading-tight font-semibold" style={{ color: TONE_VAR[bigTone] }}>
              {big}
            </div>
            {small && <div className="mt-0.5 text-[10.5px] leading-tight text-faint">{small}</div>}
            {mode === 'node' && state.seq >= 0 && !state.done && (
              <div className="mt-2 flex flex-col items-center gap-1">
                <span className={`pill ${state.checkpoint === 'nextTick' ? 'is-on' : ''}`} style={toneStyle('fuchsia')}>
                  nextTick
                </span>
                <span className={`pill ${state.checkpoint === 'microtask' ? 'is-on' : ''}`} style={toneStyle('violet')}>
                  microtasks
                </span>
                <span className="text-[9.5px] text-faint">after every callback</span>
              </div>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ flights (editor → runtime) */

interface Flight {
  id: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  label: string;
  tone: Tone;
}

export function FlightLayer() {
  const { event } = useRuntime();
  const move = useStore((s) => s.move);
  const speed = useStore((s) => s.speed);
  const reduce = useReducedMotion();
  const [flights, setFlights] = useState<Flight[]>([]);

  useEffect(() => {
    if (!event || move !== 'forward' || reduce || event.line === undefined) return;
    let zone: string | null = null;
    let label = '';
    let tone: Tone = 'cyan';
    if (event.kind === 'schedule') {
      zone = event.target === 'webapi' ? 'webapis' : `queue-${event.target}`;
      label = event.task.label;
      tone = kindTone(event.task.kind);
    } else if (event.kind === 'console') {
      zone = 'console';
      label = event.text.split('\n')[0] ?? '';
      tone = event.level === 'error' ? 'coral' : 'green';
    }
    if (!zone) return;
    const from = lineRect(event.line);
    const to = zoneRect(zone);
    if (!from || !to) return;
    const flight: Flight = {
      id: event.seq,
      x0: from.left + 28,
      y0: from.top + from.height / 2,
      x1: to.left + Math.min(36, to.width / 2),
      y1: to.top + Math.min(26, to.height / 2),
      label,
      tone,
    };
    setFlights((list) => [...list.filter((f) => f.id !== flight.id).slice(-3), flight]);
  }, [event, move, reduce]);

  const duration = 0.7 / Math.pow(speed, 0.6);
  return createPortal(
    <div className="pointer-events-none fixed inset-0 z-40" aria-hidden>
      <svg className="absolute inset-0 h-full w-full overflow-visible">
        {flights.map((f) => {
          const cx = (f.x0 + f.x1) / 2;
          const cy = Math.min(f.y0, f.y1) - 70;
          return (
            <motion.path
              key={`trail-${f.id}`}
              d={`M ${f.x0} ${f.y0} Q ${cx} ${cy} ${f.x1} ${f.y1}`}
              fill="none"
              stroke={TONE_VAR[f.tone]}
              strokeWidth={2}
              strokeLinecap="round"
              style={{ filter: `drop-shadow(0 0 5px ${TONE_VAR[f.tone]})` }}
              initial={{ pathLength: 0, opacity: 0.9 }}
              animate={{ pathLength: 1, opacity: [0.9, 0.9, 0] }}
              transition={{ duration: duration * 1.25, ease: 'easeInOut' }}
            />
          );
        })}
      </svg>
      {flights.map((f) => {
        const cx = (f.x0 + f.x1) / 2;
        const cy = Math.min(f.y0, f.y1) - 70;
        const mx = 0.25 * f.x0 + 0.5 * cx + 0.25 * f.x1;
        const my = 0.25 * f.y0 + 0.5 * cy + 0.25 * f.y1;
        return (
          <motion.div
            key={f.id}
            className="token absolute top-[-12px] left-0"
            style={{ ...toneStyle(f.tone), boxShadow: `0 0 18px -2px ${TONE_VAR[f.tone]}` }}
            initial={{ x: f.x0, y: f.y0, opacity: 0, scale: 0.7 }}
            animate={{ x: [f.x0, mx, f.x1], y: [f.y0, my, f.y1], opacity: [0, 1, 0], scale: [0.7, 1, 0.9] }}
            transition={{ duration, ease: 'easeInOut', times: [0, 0.5, 1] }}
            onAnimationComplete={() => setFlights((list) => list.filter((x) => x.id !== f.id))}
          >
            <span className="token-dot" />
            <span className="token-label max-w-[220px]">{f.label}</span>
          </motion.div>
        );
      })}
    </div>,
    document.body,
  );
}

/* ------------------------------------------------------------------ console */

export function ConsolePanel() {
  const { index, cursor } = useRuntime();
  const ref = useZone('console');
  const scroller = useRef<HTMLDivElement>(null);
  const n = index ? index.consoleCount(cursor) : 0;
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [n]);
  const seqs = index ? index.consoleSeqs.slice(Math.max(0, n - 400), n) : [];
  return (
    <section ref={ref} className="glass flex h-full min-h-0 flex-col rounded-[10px]" aria-label="Console output">
      <div className="flex items-center gap-2 border-b border-line px-3 py-1.5">
        <h3 className="panel-title">Console</h3>
        {n > 0 && <span className="count-badge">{n}</span>}
      </div>
      <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto px-3 py-1.5 font-mono text-[12px] leading-[1.55]" role="log" aria-live="polite">
        {seqs.map((seq) => {
          const ev = index!.events[seq] as Extract<TraceEvent, { kind: 'console' }>;
          return (
            <div key={seq} className={`console-line level-${ev.level} ${seq === cursor ? 'is-new' : ''}`}>
              {ev.text}
            </div>
          );
        })}
        {n === 0 && <Empty>Output appears here as the program runs.</Empty>}
      </div>
    </section>
  );
}
