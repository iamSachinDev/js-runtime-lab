import * as monaco from 'monaco-editor';
import { useEffect, useMemo, useRef } from 'react';
import { setLineRectProvider } from '../lib/zones';
import { useRuntime, useStore } from '../store/store';

const NODE_GLOBALS = `
declare function require(id: string): any;
declare const module: { exports: any };
declare let exports: any;
declare const __filename: string;
declare const __dirname: string;
declare const process: any;
declare const Buffer: any;
declare function setImmediate(callback: (...args: any[]) => void, ...args: any[]): any;
declare function clearImmediate(handle: any): void;
`;

type JsDefaults = {
  setDiagnosticsOptions?: (o: Record<string, unknown>) => void;
  addExtraLib?: (content: string, path?: string) => unknown;
};

let configured = false;
let editorInstance: monaco.editor.IStandaloneCodeEditor | null = null;

function configureMonaco(): void {
  if (configured) return;
  configured = true;
  monaco.editor.defineTheme('runtime-lab', {
    base: 'vs-dark',
    inherit: true,
    rules: [
      { token: 'comment', foreground: '64799F', fontStyle: 'italic' },
      { token: 'keyword', foreground: 'C4A7FF' },
      { token: 'string', foreground: 'E6C99A' },
      { token: 'number', foreground: '9ADBFF' },
      { token: 'regexp', foreground: 'F0A6CA' },
      { token: 'type', foreground: '7FE3D3' },
      { token: 'delimiter', foreground: '8EA3C8' },
      { token: 'identifier', foreground: 'DCE7FA' },
    ],
    colors: {
      'editor.background': '#0B1629',
      'editor.foreground': '#DCE7FA',
      'editorLineNumber.foreground': '#3F5276',
      'editorLineNumber.activeForeground': '#9FB3D9',
      'editorCursor.foreground': '#22D3EE',
      'editor.selectionBackground': '#22D3EE30',
      'editor.inactiveSelectionBackground': '#22D3EE18',
      'editorIndentGuide.background1': '#1A2A48',
      'editorIndentGuide.activeBackground1': '#2E4775',
      'editorGutter.background': '#0B1629',
      'editorWidget.background': '#0F1D35',
      'editorWidget.border': '#22385F',
      'editorSuggestWidget.background': '#0F1D35',
      'editorSuggestWidget.selectedBackground': '#182B4D',
      'editorHoverWidget.background': '#0F1D35',
      'editorBracketMatch.background': '#22D3EE20',
      'editorBracketMatch.border': '#22D3EE60',
      'scrollbarSlider.background': '#22385F80',
    },
  });
  const ts = (monaco as unknown as { typescript?: { javascriptDefaults?: JsDefaults } }).typescript;
  ts?.javascriptDefaults?.setDiagnosticsOptions?.({ noSemanticValidation: true, noSyntaxValidation: false });
  ts?.javascriptDefaults?.addExtraLib?.(NODE_GLOBALS, 'file:///node-globals.d.ts');
}

/** Toolbar action: format the document with the JavaScript language service. */
export function formatCode(): void {
  void editorInstance?.getAction('editor.action.formatDocument')?.run();
}

export function CodeEditor() {
  const host = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const decoRef = useRef<monaco.editor.IEditorDecorationsCollection | null>(null);
  const code = useStore((s) => s.code);
  const breakpoints = useStore((s) => s.breakpoints);
  const runCode = useStore((s) => s.runCode);
  const mode = useStore((s) => s.mode);
  const runMode = useStore((s) => s.runMode);
  const { index, state, event, cursor } = useRuntime();
  const stale = !index || runCode !== code || runMode !== mode;

  useEffect(() => {
    configureMonaco();
    const el = host.current;
    if (!el) return;
    const editor = monaco.editor.create(el, {
      value: useStore.getState().code,
      language: 'javascript',
      theme: 'runtime-lab',
      automaticLayout: true,
      fontFamily: '"JetBrains Mono Variable", "JetBrains Mono", ui-monospace, monospace',
      fontSize: 13,
      lineHeight: 20,
      minimap: { enabled: false },
      glyphMargin: true,
      lineNumbersMinChars: 3,
      folding: false,
      scrollBeyondLastLine: false,
      renderLineHighlight: 'none',
      padding: { top: 12, bottom: 12 },
      tabSize: 2,
      smoothScrolling: true,
      bracketPairColorization: { enabled: true },
      fixedOverflowWidgets: true,
      overviewRulerLanes: 0,
      scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10 },
      ariaLabel: 'JavaScript code editor. Ctrl or Cmd + Enter runs the code.',
    });
    editorRef.current = editor;
    editorInstance = editor;
    decoRef.current = editor.createDecorationsCollection();
    const changes = editor.onDidChangeModelContent(() => useStore.getState().setCode(editor.getValue()));
    const clicks = editor.onMouseDown((e) => {
      const t = e.target.type;
      if (t === monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN || t === monaco.editor.MouseTargetType.GUTTER_LINE_DECORATIONS) {
        const line = e.target.position?.lineNumber;
        if (line) useStore.getState().toggleBreakpoint(line);
      }
    });
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => void useStore.getState().run());
    setLineRectProvider((line) => {
      const dom = editor.getDomNode();
      const model = editor.getModel();
      if (!dom || !model || line < 1 || line > model.getLineCount()) return null;
      const box = dom.getBoundingClientRect();
      const lh = editor.getOption(monaco.editor.EditorOption.lineHeight);
      const top = editor.getTopForLineNumber(line) - editor.getScrollTop();
      if (top < 0 || top + lh > box.height || box.width === 0) return null;
      const layout = editor.getLayoutInfo();
      return new DOMRect(box.left + layout.contentLeft, box.top + top, Math.max(40, layout.contentWidth * 0.4), lh);
    });
    return () => {
      changes.dispose();
      clicks.dispose();
      setLineRectProvider(null);
      if (editorInstance === editor) editorInstance = null;
      editor.dispose();
      editorRef.current = null;
    };
  }, []);

  // External updates (examples): replace the text but keep undo history.
  useEffect(() => {
    const ed = editorRef.current;
    const model = ed?.getModel();
    if (!ed || !model || model.getValue() === code) return;
    ed.pushUndoStop();
    model.pushEditOperations([], [{ range: model.getFullModelRange(), text: code }], () => null);
    ed.pushUndoStop();
  }, [code]);

  const line = stale ? undefined : state?.line;
  const isError = event?.kind === 'error' || (event?.kind === 'task-end' && event.status === 'error');
  const validLines = useMemo(() => (index && !stale ? new Set(index.result.meta.statements.map((s) => s.line)) : null), [index, stale]);
  const errorLines = useMemo(() => {
    if (!index || stale) return [] as number[];
    const lines = new Set<number>();
    for (let i = 0; i <= cursor && i < index.length; i++) {
      const ev = index.events[i]!;
      if (ev.kind === 'error' && ev.line) lines.add(ev.line);
    }
    return [...lines];
  }, [index, cursor, stale]);

  useEffect(() => {
    const ed = editorRef.current;
    const deco = decoRef.current;
    const model = ed?.getModel();
    if (!ed || !deco || !model) return;
    const count = model.getLineCount();
    const decs: monaco.editor.IModelDeltaDecoration[] = [];
    for (const bp of breakpoints) {
      if (bp > count) continue;
      const invalid = validLines !== null && !validLines.has(bp);
      decs.push({
        range: new monaco.Range(bp, 1, bp, 1),
        options: {
          glyphMarginClassName: `rl-bp${bp === line ? ' is-hit' : ''}${invalid ? ' is-invalid' : ''}`,
          glyphMarginHoverMessage: { value: invalid ? 'No statement on this line, so playback never stops here.' : 'Breakpoint: playback pauses here. Click to remove.' },
        },
      });
    }
    for (const l of errorLines) if (l <= count) decs.push({ range: new monaco.Range(l, 1, l, 1), options: { isWholeLine: true, className: 'rl-error-line' } });
    if (line && line <= count)
      decs.push({
        range: new monaco.Range(line, 1, line, 1),
        options: { isWholeLine: true, className: isError ? 'rl-error-line' : 'rl-active-line', linesDecorationsClassName: 'rl-active-gutter' },
      });
    deco.set(decs);
    if (line && line <= count) ed.revealLineInCenterIfOutsideViewport(line, monaco.editor.ScrollType.Smooth);
  }, [breakpoints, line, isError, errorLines, validLines]);

  useEffect(() => {
    const model = editorRef.current?.getModel();
    if (!model) return;
    const diags = index && !stale ? index.result.diagnostics : [];
    monaco.editor.setModelMarkers(
      model,
      'runtime-lab',
      diags.map((d) => ({
        severity: monaco.MarkerSeverity.Error,
        message: d.hint ? `${d.message}\n${d.hint}` : d.message,
        startLineNumber: d.line,
        startColumn: d.column,
        endLineNumber: d.line,
        endColumn: d.column + 1,
      })),
    );
  }, [index, stale]);

  return <div ref={host} className="h-full w-full" />;
}
