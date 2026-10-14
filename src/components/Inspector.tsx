import { Background, Controls, Handle, Position, ReactFlow, ReactFlowProvider, useReactFlow, type Edge, type Node, type NodeProps } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useEffect, useMemo } from 'react';
import { explain, type Tone as ExplainTone } from '../engine/explain/explain';
import { KIND_LABEL, kindTone, svShort, type Tone } from '../engine/trace/format';
import type { ScopeView, TraceIndex } from '../engine/trace/model';
import type { TaskInfo, TaskKind } from '../engine/types';
import { useRuntime, useStore, type InspectorTab } from '../store/store';
import { Empty, TONE_VAR, toneStyle, ValueView } from './ui';

const EXPLAIN_TONE: Record<ExplainTone, Tone> = {
  active: 'cyan',
  promise: 'violet',
  timer: 'amber',
  tick: 'fuchsia',
  io: 'sky',
  check: 'mint',
  done: 'green',
  error: 'coral',
  neutral: 'slate',
};

/* ------------------------------------------------------------------ explanation */

export function ExplanationCard({ compact = false }: { compact?: boolean }) {
  const { index, cursor } = useRuntime();
  const e = useMemo(() => (index ? explain(index, cursor) : null), [index, cursor]);
  if (!index || !e)
    return (
      <section className="glass rounded-[10px] p-3.5">
        <h2 className="text-[13.5px] font-semibold text-text">See your code run</h2>
        <p className="mt-1.5 text-[12.5px] leading-relaxed text-muted">
          Write a program or open an example, then press Run. Every call, scheduled callback and queue movement is recorded, then replayed here
          step by step with an explanation of what happened and why.
        </p>
      </section>
    );
  const tone = TONE_VAR[EXPLAIN_TONE[e.tone]];
  return (
    <section className={`glass flex min-h-0 flex-col rounded-[10px] p-3.5 ${compact ? '' : 'max-h-[58%]'}`} aria-live="polite" aria-label="Explanation">
      <div className="mb-2.5 flex items-start gap-2.5">
        <span className="mt-[5px] h-2 w-2 flex-none rounded-full" style={{ background: tone, boxShadow: `0 0 10px ${tone}` }} />
        <h2 className="min-w-0 text-[13.5px] leading-snug font-semibold break-words text-text">{e.title}</h2>
        <span className="ml-auto flex-none font-mono text-[11px] text-faint">
          {cursor + 1}/{index.length}
        </span>
      </div>
      <div className="min-h-0 space-y-2.5 overflow-y-auto pr-1 text-[12.5px] leading-relaxed">
        <Section label="What happened">{e.what}</Section>
        {!compact && <Section label="Why">{e.why}</Section>}
        {!compact && <Section label="What happens next">{e.next}</Section>}
        {e.insight && !compact && (
          <div className="insight">
            <div className="text-[11.5px] font-medium text-amber">Interview insight</div>
            <div className="mt-1 font-medium text-text">{e.insight.question}</div>
            <div className="mt-1 text-muted">{e.insight.answer}</div>
          </div>
        )}
      </div>
    </section>
  );
}

function Section({ label, children }: { label: string; children: string }) {
  return (
    <div>
      <div className="text-[11.5px] font-medium text-faint">{label}</div>
      <p className="mt-0.5 text-text/90">{children}</p>
    </div>
  );
}

/* ------------------------------------------------------------------ variables */

const STATUS_TEXT: Record<string, [string, Tone]> = {
  running: ['running', 'cyan'],
  waiting: ['waiting for a call to return', 'slate'],
  suspended: ['paused at await', 'violet'],
  closure: ['kept alive by a closure', 'mint'],
  global: ['global', 'slate'],
};

function VariablesPanel() {
  const { state, event } = useRuntime();
  if (!state || state.seq < 0) return <Empty>Variables appear here while the program runs.</Empty>;
  const top = state.stack[state.stack.length - 1]?.id;
  const stackPos = new Map(state.stack.map((f, i) => [f.id, i]));
  const changed = new Set((event && 'vars' in event && event.vars ? event.vars : []).map((v) => `${v.scope}|${v.name}`));
  const statusOf = (s: ScopeView) => {
    if (s.id === top) return 'running';
    if (stackPos.has(s.id)) return 'waiting';
    if (s.status === 'suspended') return 'suspended';
    if (s.global) return 'global';
    return 'closure';
  };
  const rank = (s: ScopeView) => {
    const st = statusOf(s);
    if (st === 'running') return -1000;
    if (st === 'waiting') return -500 - (stackPos.get(s.id) ?? 0);
    if (st === 'suspended') return 0;
    if (st === 'closure') return 100 - s.id / 1e6;
    return 1000;
  };
  const scopes = state.scopes.filter((s) => s.global || s.vars.length > 0 || s.id === top).sort((a, b) => rank(a) - rank(b));
  if (!scopes.length) return <Empty>No variables in scope yet.</Empty>;
  return (
    <div className="space-y-2.5">
      {scopes.map((s) => {
        const [text, tone] = STATUS_TEXT[statusOf(s)]!;
        return (
          <div key={s.id} className="rounded-lg border border-line bg-ink-950/40" style={toneStyle(tone)}>
            <div className="flex items-center gap-2 border-b border-line px-2.5 py-1.5">
              <span className="truncate font-mono text-[12px] text-text">{s.name}</span>
              <span className="ml-auto flex-none text-[10.5px]" style={{ color: TONE_VAR[tone] }}>
                {text}
              </span>
            </div>
            <div className="px-2.5 py-1.5 font-mono text-[11.5px] leading-relaxed">
              {s.vars.length === 0 && <span className="text-faint">no variables</span>}
              {s.vars.map(([name, value]) => (
                <div key={`${name}-${changed.has(`${s.id}|${name}`) ? state.seq : 'k'}`} className={`flex min-w-0 gap-1.5 rounded px-1 -mx-1 ${changed.has(`${s.id}|${name}`) ? 'var-changed' : ''}`}>
                  <span className="flex-none text-muted">{name}</span>
                  <span className="flex-none text-faint">=</span>
                  <span className="min-w-0">
                    <ValueView v={value} />
                  </span>
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------------ promises */

function PromisesPanel() {
  const { state } = useRuntime();
  const list = state ? [...state.promises].reverse() : [];
  if (!list.length) return <Empty>Promises created by your code are listed here with their state.</Empty>;
  const toneOf = (s: string): Tone => (s === 'fulfilled' ? 'green' : s === 'rejected' ? 'coral' : 'slate');
  return (
    <div className="space-y-1.5">
      {list.map((p) => (
        <div key={p.id} className="rounded-lg border border-line bg-ink-950/40 px-2.5 py-1.5 text-[12px]">
          <div className="flex items-center gap-2">
            <span className="font-mono text-violet">#{p.id}</span>
            <span className="truncate font-mono text-muted">{p.origin}</span>
            <span className="ml-auto flex-none text-[11px]" style={{ color: TONE_VAR[toneOf(p.state)] }}>
              {p.state}
            </span>
          </div>
          {p.state !== 'pending' && (
            <div className="mt-0.5 truncate font-mono text-[11.5px]" title={svShort(p.value, 200)}>
              <ValueView v={p.value ?? { t: 'undefined' }} />
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ task graph */

type NodeStatus = 'pending' | 'running' | 'done' | 'error' | 'cancelled';
type TaskNodeData = { label: string; kind: TaskKind; status: NodeStatus; id: number; tone: Tone };
type TaskNode = Node<TaskNodeData, 'task'>;

function TaskNodeView({ data }: NodeProps<TaskNode>) {
  return (
    <div className={`graph-node is-${data.status}`} style={toneStyle(data.tone)} title={`${data.label}\n${KIND_LABEL[data.kind]} #${data.id}: ${data.status}`}>
      <Handle type="target" position={Position.Left} isConnectable={false} />
      <div className="flex min-w-0 items-center gap-1.5">
        <span className="token-dot" />
        <span className="truncate font-mono text-[11px]">{data.label}</span>
      </div>
      <div className="mt-0.5 flex justify-between text-[10.5px] text-faint">
        <span>{KIND_LABEL[data.kind]}</span>
        <span>#{data.id}</span>
      </div>
      <Handle type="source" position={Position.Right} isConnectable={false} />
    </div>
  );
}

const nodeTypes = { task: TaskNodeView };
const MAX_NODES = 150;

function buildGraph(index: TraceIndex, cursor: number): { nodes: TaskNode[]; edges: Edge[] } {
  const info = new Map<number, { task: TaskInfo; status: NodeStatus }>();
  for (let i = 0; i <= cursor && i < index.length && info.size < MAX_NODES; i++) {
    const ev = index.events[i]!;
    if (ev.kind === 'schedule' && !info.has(ev.task.id)) info.set(ev.task.id, { task: ev.task, status: 'pending' });
    else if (ev.kind === 'task-start') {
      const cur = info.get(ev.task.id);
      if (cur) cur.status = 'running';
      else info.set(ev.task.id, { task: ev.task, status: 'running' });
    } else if (ev.kind === 'task-end') {
      const cur = info.get(ev.id);
      if (cur) cur.status = ev.status === 'error' ? 'error' : 'done';
    } else if (ev.kind === 'cancel') {
      const cur = info.get(ev.id);
      if (cur) cur.status = 'cancelled';
    }
  }
  const depth = new Map<number, number>();
  const depthOf = (id: number, guard = 0): number => {
    const known = depth.get(id);
    if (known !== undefined) return known;
    const parent = info.get(id)?.task.parentId;
    const d = parent !== null && parent !== undefined && info.has(parent) && guard < 200 ? depthOf(parent, guard + 1) + 1 : 0;
    depth.set(id, d);
    return d;
  };
  const rows = new Map<number, number>();
  const nodes: TaskNode[] = [];
  const edges: Edge[] = [];
  for (const [id, { task, status }] of info) {
    const d = depthOf(id);
    const row = rows.get(d) ?? 0;
    rows.set(d, row + 1);
    nodes.push({
      id: String(id),
      type: 'task',
      position: { x: d * 250, y: row * 70 },
      data: { label: task.kind === 'io' && task.detail ? task.detail : task.label, kind: task.kind, status, id, tone: kindTone(task.kind) },
      draggable: false,
      connectable: false,
    });
    if (task.parentId !== null && info.has(task.parentId))
      edges.push({ id: `e${task.parentId}-${id}`, source: String(task.parentId), target: String(id), animated: status === 'running' });
  }
  return { nodes, edges };
}

function FitOnChange({ count }: { count: number }) {
  const { fitView } = useReactFlow();
  useEffect(() => {
    const t = window.setTimeout(() => void fitView({ padding: 0.2, duration: 250, maxZoom: 1.1 }), 30);
    return () => window.clearTimeout(t);
  }, [count, fitView]);
  return null;
}

function TaskGraph() {
  const { index, cursor } = useRuntime();
  const graph = useMemo(() => (index ? buildGraph(index, cursor) : { nodes: [], edges: [] }), [index, cursor]);
  if (!index) return <div className="p-3"><Empty>Run the program to see which callback scheduled which.</Empty></div>;
  return (
    <ReactFlowProvider>
      <ReactFlow
        nodes={graph.nodes}
        edges={graph.edges}
        nodeTypes={nodeTypes}
        colorMode="dark"
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        fitView
        minZoom={0.2}
        proOptions={{ hideAttribution: true }}
      >
        <Background gap={20} size={1} color="rgb(140 170 230 / 0.12)" />
        <Controls showInteractive={false} />
        <FitOnChange count={graph.nodes.length} />
      </ReactFlow>
    </ReactFlowProvider>
  );
}

/* ------------------------------------------------------------------ inspector */

const TABS: { id: InspectorTab; label: string }[] = [
  { id: 'variables', label: 'Variables' },
  { id: 'promises', label: 'Promises' },
  { id: 'graph', label: 'Task graph' },
];

export function Inspector() {
  const tab = useStore((s) => s.inspectorTab);
  const setUi = useStore((s) => s.setUi);
  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <ExplanationCard />
      <section className="glass flex min-h-[180px] flex-1 flex-col rounded-[10px]">
        <div role="tablist" aria-label="Inspector" className="flex gap-1 border-b border-line px-2 pt-1.5">
          {TABS.map((t) => (
            <button
              key={t.id}
              role="tab"
              type="button"
              aria-selected={tab === t.id}
              onClick={() => setUi({ inspectorTab: t.id })}
              className={`-mb-px border-b-2 px-2.5 py-1.5 text-[12px] transition-colors ${tab === t.id ? 'border-cyan text-text' : 'border-transparent text-muted hover:text-text'}`}
            >
              {t.label}
            </button>
          ))}
        </div>
        {tab === 'graph' ? (
          <div className="min-h-0 flex-1">
            <TaskGraph />
          </div>
        ) : (
          <div className="min-h-0 flex-1 overflow-y-auto p-3" role="tabpanel">
            {tab === 'variables' ? <VariablesPanel /> : <PromisesPanel />}
          </div>
        )}
      </section>
    </div>
  );
}
