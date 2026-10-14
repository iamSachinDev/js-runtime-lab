import { ChevronDown, ChevronRight } from 'lucide-react';
import { useState, type CSSProperties, type ReactNode } from 'react';
import { svShort, type Tone } from '../engine/trace/format';
import type { SV } from '../engine/types';

export const TONE_VAR: Record<Tone, string> = {
  cyan: 'var(--color-cyan)',
  violet: 'var(--color-violet)',
  amber: 'var(--color-amber)',
  green: 'var(--color-green)',
  coral: 'var(--color-coral)',
  fuchsia: 'var(--color-fuchsia)',
  sky: 'var(--color-sky)',
  mint: 'var(--color-mint)',
  slate: 'var(--color-slate)',
};

export const toneStyle = (tone: Tone): CSSProperties => ({ ['--tone' as string]: TONE_VAR[tone] }) as CSSProperties;

export function IconButton(props: {
  label: string;
  onClick?: () => void;
  disabled?: boolean;
  active?: boolean;
  shortcut?: string;
  className?: string;
  children: ReactNode;
}) {
  const { label, onClick, disabled, active, shortcut, className = '', children } = props;
  return (
    <button
      type="button"
      aria-label={label}
      title={shortcut ? `${label} (${shortcut})` : label}
      onClick={onClick}
      disabled={disabled}
      aria-pressed={active}
      className={`inline-flex h-8 min-w-8 items-center justify-center gap-1.5 rounded-md px-2 text-muted transition-colors hover:bg-ink-700 hover:text-text disabled:opacity-35 disabled:hover:bg-transparent disabled:hover:text-muted ${active ? 'bg-ink-700 text-text' : ''} ${className}`}
    >
      {children}
    </button>
  );
}

export function PanelHead({ title, count, hint, children }: { title: string; count?: number; hint?: string; children?: ReactNode }) {
  return (
    <div className="mb-2 flex min-h-[20px] items-center gap-2">
      <h3 className="panel-title" title={hint}>
        {title}
      </h3>
      {count !== undefined && count > 0 && <span className="count-badge">{count}</span>}
      {children && <div className="ml-auto flex items-center gap-1">{children}</div>}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <span className="text-[11.5px] leading-snug text-faint">{children}</span>;
}

export function Toggle({ on, onClick, children, label }: { on: boolean; onClick: () => void; children: ReactNode; label?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={on}
      title={label}
      className={`h-6 rounded-md border px-2 text-[11.5px] transition-colors ${on ? 'border-cyan/50 bg-cyan/10 text-cyan' : 'border-line text-muted hover:text-text'}`}
    >
      {children}
    </button>
  );
}

const fnText = (v: Extract<SV, { t: 'function' }>) => `${v.cls ? 'class' : v.async ? 'async ƒ' : v.generator ? 'ƒ*' : 'ƒ'} ${v.name || 'anonymous'}`;

/** Renders a serialized runtime value, with expandable objects and arrays. */
export function ValueView({ v, depth = 0 }: { v: SV; depth?: number }) {
  const [open, setOpen] = useState(false);
  switch (v.t) {
    case 'undefined':
    case 'null':
      return <span className="text-faint italic">{v.t}</span>;
    case 'boolean':
      return <span className="text-[#c9b8f5]">{String(v.v)}</span>;
    case 'number':
    case 'bigint':
      return <span className="text-[#9adbff]">{v.v}</span>;
    case 'string':
      return (
        <span className="break-all text-[#e6c99a]">
          '{v.v}
          {v.trunc ? '…' : ''}'
        </span>
      );
    case 'symbol':
    case 'date':
    case 'regexp':
      return <span className="text-[#9fe0d2]">{v.v}</span>;
    case 'tdz':
      return (
        <span className="text-coral/80 italic" title="Temporal dead zone: hoisted but not initialized yet">
          ‹uninitialized›
        </span>
      );
    case 'function':
      return <span className="text-[#9fe0d2]">{fnText(v)}</span>;
    case 'promise':
      return (
        <span className="text-violet">
          Promise ‹{v.state}›
          {v.value && v.state !== 'pending' ? (
            <>
              <span className="text-faint">: </span>
              <ValueView v={v.value} depth={depth + 1} />
            </>
          ) : null}
        </span>
      );
    case 'error':
      return (
        <span className="text-coral">
          {v.name}: {v.message}
        </span>
      );
    case 'ref':
      return <span className="text-faint">{v.kind === 'circular' ? '[Circular]' : `[${v.kind}]`}</span>;
    default: {
      const entries: [string, SV][] =
        v.t === 'array'
          ? v.items.map((x, i) => [String(i), x])
          : v.t === 'object'
            ? v.entries
            : v.t === 'map'
              ? v.entries.map(([k, x]) => [svShort(k, 24), x])
              : v.items.map((x, i) => [String(i), x]);
      const summary = svShort(v, 64);
      if (!entries.length || depth >= 3) return <span className="text-text">{summary}</span>;
      return (
        <span>
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            aria-expanded={open}
            className="inline-flex max-w-full items-center gap-0.5 text-left text-text hover:text-cyan"
          >
            {open ? <ChevronDown size={12} className="flex-none" /> : <ChevronRight size={12} className="flex-none" />}
            <span className="truncate">{summary}</span>
          </button>
          {open && (
            <div className="ml-1.5 border-l border-line pl-2">
              {entries.map(([k, x]) => (
                <div key={k} className="min-w-0">
                  <span className="text-muted">{k}</span>
                  <span className="text-faint">: </span>
                  <ValueView v={x} depth={depth + 1} />
                </div>
              ))}
              {'more' in v && v.more && <div className="text-faint">…</div>}
            </div>
          )}
        </span>
      );
    }
  }
}
