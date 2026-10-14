import {
  BookOpen,
  Braces,
  Cpu,
  Globe,
  Info,
  LoaderCircle,
  Maximize2,
  Minimize2,
  Pause,
  Play,
  RotateCcw,
  Search,
  Server,
  StepBack,
  StepForward,
  TriangleAlert,
  Workflow,
  X,
  Zap,
} from 'lucide-react';
import { useEffect, useRef, useState, type ComponentType, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { Tone } from '../engine/trace/format';
import type { RuntimeMode } from '../engine/types';
import { DIFFICULTIES, EXAMPLES, type Difficulty } from '../examples';
import { SPEEDS, useStore, type MobileView, type Speed } from '../store/store';
import { CodeEditor, formatCode } from './Editor';
import { Empty, IconButton, Toggle, TONE_VAR } from './ui';

type Icon = ComponentType<{ size?: number; className?: string }>;

/* ------------------------------------------------------------------ toolbar */

function Brand({ compact }: { compact?: boolean }) {
  return (
    <div className="flex flex-none items-center gap-2 pr-1">
      <svg width="22" height="22" viewBox="0 0 32 32" aria-hidden>
        <circle cx="16" cy="16" r="11" fill="none" stroke="var(--color-ink-500)" strokeWidth="3" />
        <path d="M16 5 A11 11 0 0 1 26.5 12.5" fill="none" stroke="var(--color-cyan)" strokeWidth="3" strokeLinecap="round" />
        <circle cx="27" cy="16" r="2.6" fill="var(--color-amber)" />
      </svg>
      {!compact && <span className="text-[13.5px] font-semibold tracking-[-0.01em] text-text">JS Runtime Lab</span>}
    </div>
  );
}

const MODES: { id: RuntimeMode; label: string; icon: Icon; tip: string }[] = [
  {
    id: 'node',
    label: 'Node.js',
    icon: Server,
    tip: 'Node.js educational simulation: libuv event loop phases, process.nextTick, setImmediate and an in-memory fs. Ordering is verified against real Node.js.',
  },
  {
    id: 'browser',
    label: 'Browser',
    icon: Globe,
    tip: 'Browser runtime in a sandboxed Web Worker: tasks, microtasks and animation frames, following the HTML event loop.',
  },
];

function ModeSwitch() {
  const mode = useStore((s) => s.mode);
  const setMode = useStore((s) => s.setMode);
  return (
    <div role="radiogroup" aria-label="Runtime" className="flex flex-none rounded-lg border border-line bg-ink-900/60 p-0.5">
      {MODES.map(({ id, label, icon: ModeIcon, tip }) => (
        <button
          key={id}
          type="button"
          role="radio"
          aria-checked={mode === id}
          title={tip}
          onClick={() => setMode(id)}
          className={`flex h-7 items-center gap-1.5 rounded-md px-2.5 text-[12px] transition-colors ${mode === id ? 'bg-ink-700 text-text' : 'text-muted hover:text-text'}`}
        >
          <ModeIcon size={14} />
          {label}
        </button>
      ))}
    </div>
  );
}

function RunButton() {
  const running = useStore((s) => s.running);
  const run = useStore((s) => s.run);
  return (
    <button
      type="button"
      onClick={() => void run()}
      disabled={running}
      title="Run (Ctrl or ⌘ + Enter)"
      className="inline-flex h-8 flex-none items-center gap-1.5 rounded-md bg-cyan px-3 text-[12.5px] font-semibold text-ink-950 shadow-[0_0_18px_-4px_var(--color-cyan)] transition hover:brightness-110 disabled:opacity-70"
    >
      {running ? <LoaderCircle size={15} className="animate-spin" /> : <Zap size={15} />}
      Run
    </button>
  );
}

export function Transport({ showPosition = true }: { showPosition?: boolean }) {
  const index = useStore((s) => s.index);
  const cursor = useStore((s) => s.cursor);
  const playing = useStore((s) => s.playing);
  const speed = useStore((s) => s.speed);
  const { restart, stepBackward, togglePlay, stepForward, setSpeed } = useStore.getState();
  const len = index?.length ?? 0;
  const PlayIcon = playing ? Pause : Play;
  return (
    <div className="flex items-center gap-0.5">
      <IconButton label="Restart" shortcut="Home" onClick={restart} disabled={!index}>
        <RotateCcw size={16} />
      </IconButton>
      <IconButton label="Step backward" shortcut="←" onClick={stepBackward} disabled={!index || cursor <= 0}>
        <StepBack size={16} />
      </IconButton>
      <IconButton label={playing ? 'Pause' : 'Play'} shortcut="Space" onClick={togglePlay} disabled={!index} className="text-text">
        <PlayIcon size={17} />
      </IconButton>
      <IconButton label="Step forward" shortcut="→" onClick={stepForward} disabled={!index || cursor >= len - 1}>
        <StepForward size={16} />
      </IconButton>
      <label className="ml-1 flex items-center">
        <span className="sr-only">Playback speed</span>
        <select
          value={speed}
          onChange={(e) => setSpeed(Number(e.target.value) as Speed)}
          className="h-7 rounded-md border border-line bg-ink-900 px-1.5 text-[12px] text-text"
          title="Playback speed"
        >
          {SPEEDS.map((s) => (
            <option key={s} value={s}>
              {s}×
            </option>
          ))}
        </select>
      </label>
      {showPosition && index && (
        <span className="ml-2 hidden font-mono text-[11px] text-faint xl:inline">
          {cursor + 1} / {len}
        </span>
      )}
    </div>
  );
}

export function Toolbar({ variant = 'full' }: { variant?: 'full' | 'compact' | 'present' }) {
  const setUi = useStore((s) => s.setUi);
  const compact = variant === 'compact';
  return (
    <header className="flex h-12 flex-none items-center gap-2 border-b border-line bg-ink-950/70 px-3 backdrop-blur-md">
      <Brand compact={compact} />
      {variant !== 'present' && <ModeSwitch />}
      {variant !== 'present' && (
        <IconButton label="Example library" onClick={() => setUi({ examplesOpen: true })} className={compact ? '' : 'text-text'}>
          <BookOpen size={16} />
          {!compact && <span className="text-[12px]">Examples</span>}
        </IconButton>
      )}
      <div className="mx-auto flex items-center gap-2">
        <RunButton />
        {!compact && <Transport />}
      </div>
      <div className="flex items-center gap-0.5">
        {variant === 'full' && (
          <IconButton label="Format code" onClick={formatCode}>
            <Braces size={16} />
          </IconButton>
        )}
        {variant === 'present' ? (
          <IconButton label="Exit presentation mode" shortcut="Esc" onClick={() => setUi({ presenting: false })} className="text-text">
            <Minimize2 size={16} />
          </IconButton>
        ) : (
          !compact && (
            <IconButton label="Presentation mode" shortcut="F" onClick={() => setUi({ presenting: true })}>
              <Maximize2 size={16} />
            </IconButton>
          )
        )}
        <IconButton label="How this works" onClick={() => setUi({ aboutOpen: true })}>
          <Info size={16} />
        </IconButton>
      </div>
    </header>
  );
}

/* ------------------------------------------------------------------ editor panel */

export function EditorPanel() {
  const exampleId = useStore((s) => s.exampleId);
  const code = useStore((s) => s.code);
  const breakpoints = useStore((s) => s.breakpoints);
  const clearBreakpoints = useStore((s) => s.clearBreakpoints);
  const example = EXAMPLES.find((e) => e.id === exampleId);
  const subtitle = example ? (example.code === code ? example.title : `${example.title} (edited)`) : 'Your program';
  return (
    <section className="glass flex h-full min-h-0 flex-col overflow-hidden rounded-[10px]" aria-label="Code editor">
      <div className="flex min-h-[37px] items-center gap-2 border-b border-line px-3 py-1.5">
        <h3 className="panel-title">Code</h3>
        <span className="min-w-0 truncate text-[11.5px] text-faint">{subtitle}</span>
        {breakpoints.length > 0 && (
          <button type="button" onClick={clearBreakpoints} className="ml-auto flex-none text-[11.5px] text-muted hover:text-text">
            Clear {breakpoints.length} breakpoint{breakpoints.length === 1 ? '' : 's'}
          </button>
        )}
      </div>
      <div className="min-h-0 flex-1">
        <CodeEditor />
      </div>
      <div className="border-t border-line px-3 py-1 text-[11px] text-faint">Click the gutter to set a breakpoint. Ctrl or ⌘ + Enter runs.</div>
    </section>
  );
}

/* ------------------------------------------------------------------ notices */

function Notice({ tone, title, body, action }: { tone: Tone; title: string; body?: string; action?: [string, () => void] }) {
  return (
    <div className="glass flex items-start gap-2.5 rounded-[10px] px-3 py-2" style={{ borderLeft: `3px solid ${TONE_VAR[tone]}` }} role="status">
      <TriangleAlert size={15} className="mt-0.5 flex-none" style={{ color: TONE_VAR[tone] }} />
      <div className="min-w-0 flex-1">
        <div className="text-[12.5px] font-medium text-text">{title}</div>
        {body && <div className="mt-0.5 text-[12px] leading-snug text-muted">{body}</div>}
      </div>
      {action && (
        <button type="button" onClick={action[1]} className="flex-none rounded-md border border-line px-2 py-1 text-[11.5px] text-text hover:bg-ink-700">
          {action[0]}
        </button>
      )}
    </div>
  );
}

export function BoardNotices() {
  const running = useStore((s) => s.running);
  const sandboxError = useStore((s) => s.sandboxError);
  const index = useStore((s) => s.index);
  const code = useStore((s) => s.code);
  const runCode = useStore((s) => s.runCode);
  const mode = useStore((s) => s.mode);
  const runMode = useStore((s) => s.runMode);
  const { run, seek } = useStore.getState();
  const stale = index !== null && (runCode !== code || runMode !== mode);
  const diag = index?.result.diagnostics[0];
  const limit = index?.result.events.find((e) => e.kind === 'limit');
  const note = index?.result.events.find((e) => e.kind === 'note');
  const items: ReactNode[] = [];
  if (sandboxError) items.push(<Notice key="sandbox" tone="coral" title="The sandbox stopped" body={sandboxError} />);
  if (diag && !stale)
    items.push(<Notice key="diag" tone="coral" title={`Line ${diag.line}: ${diag.message}`} body={diag.hint ?? 'Nothing ran. Fix the code and press Run again.'} />);
  if (limit && limit.kind === 'limit' && !stale)
    items.push(<Notice key="limit" tone="coral" title="Execution stopped by a safety limit" body={limit.message} action={['Show', () => seek(limit.seq)]} />);
  if (stale && !running)
    items.push(
      <Notice
        key="stale"
        tone="amber"
        title={runMode !== mode ? 'The runtime changed since this trace was recorded' : 'The code changed since this trace was recorded'}
        body="Press Run to trace the current version."
        action={['Run', () => void run()]}
      />,
    );
  if (note && !stale)
    items.push(
      <Notice
        key="note"
        tone="amber"
        title="Timing-dependent order"
        body="In real Node.js part of this program can run in a different order. The timeline marks where."
        action={['Show', () => seek(note.seq)]}
      />,
    );
  if (!items.length) return null;
  return <div className="flex flex-none flex-col gap-2 px-3 pt-3">{items}</div>;
}

/* ------------------------------------------------------------------ splitter */

export function Splitter({ orientation, label, onDrag }: { orientation: 'vertical' | 'horizontal'; label: string; onDrag: (delta: number) => void }) {
  const vertical = orientation === 'vertical';
  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    let last = vertical ? e.clientX : e.clientY;
    const move = (ev: PointerEvent) => {
      const p = vertical ? ev.clientX : ev.clientY;
      onDrag(p - last);
      last = p;
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    document.body.style.cursor = vertical ? 'col-resize' : 'row-resize';
    document.body.style.userSelect = 'none';
  };
  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const keys = vertical ? ['ArrowLeft', 'ArrowRight'] : ['ArrowUp', 'ArrowDown'];
    if (!keys.includes(e.key)) return;
    e.preventDefault();
    onDrag(e.key === keys[0] ? -24 : 24);
  };
  return (
    <div
      role="separator"
      aria-orientation={vertical ? 'vertical' : 'horizontal'}
      aria-label={label}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
      className={vertical ? 'splitter-v' : 'splitter-h'}
    />
  );
}

/* ------------------------------------------------------------------ dialogs */

function Modal({ label, onClose, children }: { label: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-ink-950/70 p-4 pt-[7vh] backdrop-blur-sm"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div role="dialog" aria-modal="true" aria-label={label} className="glass w-full max-w-[700px] overflow-hidden rounded-xl shadow-2xl">
        {children}
      </div>
    </div>,
    document.body,
  );
}

const DIFF_TONE: Record<Difficulty, Tone> = { Beginner: 'green', Intermediate: 'sky', Advanced: 'violet', Interview: 'amber' };

export function ExamplesDialog() {
  const open = useStore((s) => s.examplesOpen);
  const currentId = useStore((s) => s.exampleId);
  const { setUi, loadExample } = useStore.getState();
  const [query, setQuery] = useState('');
  const [level, setLevel] = useState<Difficulty | 'all'>('all');
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (open) window.setTimeout(() => input.current?.focus(), 20);
  }, [open]);
  if (!open) return null;
  const q = query.trim().toLowerCase();
  const list = EXAMPLES.filter(
    (e) => (level === 'all' || e.difficulty === level) && (!q || [e.title, e.description, e.mode, e.difficulty, ...e.tags].join(' ').toLowerCase().includes(q)),
  );
  const close = () => setUi({ examplesOpen: false });
  return (
    <Modal label="Example library" onClose={close}>
      <div className="flex items-center gap-2 border-b border-line px-3 py-2">
        <Search size={15} className="flex-none text-faint" />
        <input
          ref={input}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search: closures, nextTick, await, this…"
          aria-label="Search examples"
          className="h-8 min-w-0 flex-1 bg-transparent text-[13px] text-text outline-none placeholder:text-faint"
        />
        <IconButton label="Close" onClick={close}>
          <X size={16} />
        </IconButton>
      </div>
      <div className="flex flex-wrap gap-1.5 border-b border-line px-3 py-2">
        {(['all', ...DIFFICULTIES] as const).map((d) => (
          <Toggle key={d} on={level === d} onClick={() => setLevel(d)}>
            {d === 'all' ? 'All levels' : d === 'Interview' ? 'Interview challenge' : d}
          </Toggle>
        ))}
      </div>
      <div className="max-h-[62vh] overflow-y-auto p-2">
        {list.map((e) => (
          <button
            key={e.id}
            type="button"
            onClick={() => loadExample(e.id)}
            className={`w-full rounded-lg px-3 py-2.5 text-left transition-colors hover:bg-ink-700/60 ${e.id === currentId ? 'bg-ink-700/40' : ''}`}
          >
            <div className="flex items-center gap-2">
              <span className="min-w-0 truncate text-[13px] font-medium text-text">{e.title}</span>
              <span className="ml-auto flex-none text-[11px] text-faint">{e.mode === 'node' ? 'Node.js' : 'Browser'}</span>
              <span className="flex-none rounded px-1.5 py-0.5 text-[10.5px]" style={{ color: TONE_VAR[DIFF_TONE[e.difficulty]], background: 'rgb(140 170 230 / 0.08)' }}>
                {e.difficulty === 'Interview' ? 'Interview challenge' : e.difficulty}
              </span>
            </div>
            <p className="mt-0.5 text-[12px] leading-snug text-muted">{e.description}</p>
            <div className="mt-1.5 flex flex-wrap gap-1">
              {e.tags.map((t) => (
                <span key={t} className="rounded bg-ink-950/50 px-1.5 py-px text-[10.5px] text-faint">
                  {t}
                </span>
              ))}
            </div>
          </button>
        ))}
        {!list.length && (
          <div className="p-6 text-center">
            <Empty>No examples match “{query}”.</Empty>
          </div>
        )}
      </div>
    </Modal>
  );
}

export function AboutDialog() {
  const open = useStore((s) => s.aboutOpen);
  const setUi = useStore((s) => s.setUi);
  if (!open) return null;
  const close = () => setUi({ aboutOpen: false });
  const keys: [string, string][] = [
    ['Ctrl / ⌘ + Enter', 'Run'],
    ['Space', 'Play or pause'],
    ['← →', 'Step backward or forward'],
    ['Home / End', 'Jump to start or end'],
    ['F', 'Presentation mode'],
  ];
  return (
    <Modal label="How JS Runtime Lab works" onClose={close}>
      <div className="flex items-center border-b border-line px-4 py-2.5">
        <h2 className="text-[14px] font-semibold text-text">How this works</h2>
        <IconButton label="Close" onClick={close} className="ml-auto">
          <X size={16} />
        </IconButton>
      </div>
      <div className="max-h-[70vh] space-y-3.5 overflow-y-auto px-4 py-3.5 text-[12.5px] leading-relaxed text-muted">
        <p>
          <span className="font-medium text-text">Your code really runs</span>, inside a disposable Web Worker sandbox, never in this page. Before it runs,
          Babel instruments it so every function call, statement and variable change is recorded.
        </p>
        <p>
          <span className="font-medium text-text">Asynchronous APIs are simulated deterministically.</span> Promises, timers, process.nextTick,
          setImmediate, file reads and fetch are replaced with traced implementations, so every callback can be followed through the queues and
          replayed. Time is virtual: waiting is skipped and each operation costs 1 µs of simulated CPU time.
        </p>
        <p>
          <span className="font-medium text-text">Node.js mode</span> is an educational simulation of libuv's phases and Node's timer lists. Its ordering is
          checked against real Node.js in the test suite. When real Node.js would be non-deterministic (for example setTimeout(0) vs setImmediate in the
          main module), the timeline says so. <span className="font-medium text-text">Browser mode</span> follows the HTML event loop: tasks, microtask
          checkpoints and animation frames.
        </p>
        <p>
          <span className="font-medium text-text">Explanations</span> are generated by deterministic rules over the trace and your code's syntax tree. No AI
          model is involved.
        </p>
        <div>
          <div className="mb-1 font-medium text-text">Not supported</div>
          <ul className="list-disc space-y-0.5 pl-5">
            <li>import / export, npm packages and Node modules other than fs, events, util, path and timers. fs and fetch use built-in sample data.</li>
            <li>eval, new Function, with, async generators and for await…of.</li>
            <li>Native promises returned by other host APIs, which aren't traced.</li>
            <li>Real timing jitter: virtual time is idealized.</li>
          </ul>
        </div>
        <div>
          <div className="mb-1 font-medium text-text">Keyboard</div>
          <div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
            {keys.map(([k, v]) => (
              <div key={k} className="contents">
                <kbd className="font-mono text-[11.5px] text-text">{k}</kbd>
                <span>{v}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------------ mobile */

const VIEWS: { id: MobileView; label: string; icon: Icon }[] = [
  { id: 'code', label: 'Code', icon: Braces },
  { id: 'runtime', label: 'Runtime', icon: Cpu },
  { id: 'explain', label: 'Explain', icon: BookOpen },
  { id: 'timeline', label: 'Timeline', icon: Workflow },
];

export function MobileNav() {
  const view = useStore((s) => s.mobileView);
  const setUi = useStore((s) => s.setUi);
  return (
    <nav className="flex flex-none border-t border-line bg-ink-950/85 pb-[env(safe-area-inset-bottom,0px)] backdrop-blur-md" aria-label="Views">
      {VIEWS.map(({ id, label, icon: ViewIcon }) => (
        <button
          key={id}
          type="button"
          onClick={() => setUi({ mobileView: id })}
          aria-current={view === id ? 'page' : undefined}
          className={`flex flex-1 flex-col items-center gap-0.5 py-2 text-[11px] ${view === id ? 'text-cyan' : 'text-muted'}`}
        >
          <ViewIcon size={18} />
          {label}
        </button>
      ))}
    </nav>
  );
}

export function MobileTransport() {
  return (
    <div className="flex flex-none justify-center border-t border-line bg-ink-950/60 px-2 py-1.5">
      <Transport showPosition={false} />
    </div>
  );
}
