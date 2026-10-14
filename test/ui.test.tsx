// @vitest-environment jsdom
/**
 * UI smoke tests in jsdom: the real React app, store, engine and traces. Only Monaco (needs real
 * layout) and the Worker transport (jsdom has no workers) are replaced; the result still crosses a
 * structuredClone boundary like postMessage.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('monaco-editor', () => {
  class Range {
    constructor(
      public startLineNumber: number,
      public startColumn: number,
      public endLineNumber: number,
      public endColumn: number,
    ) {}
  }
  const create = (el: HTMLElement, opts: { value: string }) => {
    let value = opts.value;
    const listeners: (() => void)[] = [];
    const model = {
      getValue: () => value,
      getLineCount: () => value.split('\n').length,
      getFullModelRange: () => new Range(1, 1, 1, 1),
      pushEditOperations: (_s: unknown, ops: { text: string }[]) => {
        value = ops[0]!.text;
        listeners.forEach((l) => l());
        return null;
      },
    };
    return {
      getValue: () => value,
      getModel: () => model,
      onDidChangeModelContent: (fn: () => void) => (listeners.push(fn), { dispose() {} }),
      onMouseDown: () => ({ dispose() {} }),
      addCommand: () => null,
      getDomNode: () => el,
      getOption: () => 20,
      getTopForLineNumber: (l: number) => (l - 1) * 20,
      getScrollTop: () => 0,
      getLayoutInfo: () => ({ contentLeft: 40, contentWidth: 400 }),
      createDecorationsCollection: () => ({ set: () => undefined }),
      revealLineInCenterIfOutsideViewport: () => undefined,
      pushUndoStop: () => undefined,
      getAction: () => ({ run: async () => undefined }),
      dispose: () => undefined,
    };
  };
  return {
    editor: {
      create,
      defineTheme: () => undefined,
      setModelMarkers: () => undefined,
      MouseTargetType: { GUTTER_GLYPH_MARGIN: 2, GUTTER_LINE_DECORATIONS: 4 },
      EditorOption: { lineHeight: 75 },
      ScrollType: { Smooth: 0 },
    },
    Range,
    MarkerSeverity: { Error: 8 },
    KeyMod: { CtrlCmd: 2048 },
    KeyCode: { Enter: 3 },
    typescript: { javascriptDefaults: { setDiagnosticsOptions: () => undefined, addExtraLib: () => undefined } },
  };
});

vi.mock('../src/sandbox/client', async () => {
  const { execute } = await import('../src/engine/runtime/execute');
  class SandboxError extends Error {
    constructor(
      readonly code: string,
      message: string,
    ) {
      super(message);
    }
  }
  return {
    SandboxError,
    SANDBOX_TIMEOUT_MS: 8000,
    runInSandbox: (options: { source: string; mode: 'node' | 'browser' }) => ({
      promise: Promise.resolve().then(() => structuredClone(execute(options))),
      cancel: () => undefined,
    }),
  };
});

import { App } from '../src/App';
import { EXAMPLES } from '../src/examples';
import { useStore } from '../src/store/store';

let mobile = false;

beforeAll(() => {
  window.matchMedia = ((query: string) => ({
    matches: query.includes('max-width') ? mobile : false,
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  if (!('DOMMatrixReadOnly' in globalThis))
    (globalThis as Record<string, unknown>).DOMMatrixReadOnly = class {
      m22 = 1;
    };
});

afterEach(() => {
  cleanup();
  mobile = false;
  act(() => useStore.setState({ presenting: false, examplesOpen: false, aboutOpen: false, mobileView: 'runtime', playing: false, inspectorTab: 'variables' }));
});

async function mountAndRun() {
  render(<App />);
  await waitFor(() => expect(useStore.getState().index).not.toBeNull());
  await waitFor(() => expect(useStore.getState().running).toBe(false));
  act(() => useStore.getState().pause());
}

async function load(id: string) {
  await act(async () => useStore.getState().loadExample(id));
  await waitFor(() => expect(useStore.getState().running).toBe(false));
  await waitFor(() => expect(useStore.getState().runCode).toBe(EXAMPLES.find((e) => e.id === id)!.code));
  act(() => useStore.getState().pause());
}

describe('App in jsdom', () => {
  it('runs the preloaded example and replays it forward and backward', async () => {
    await mountAndRun();
    const { index } = useStore.getState();
    expect(index!.result.console.map((c) => c.text)).toEqual([
      '5. nextTick',
      '6. Promise',
      '2. setImmediate',
      '3. nextTick inside setImmediate',
      '4. Promise inside setImmediate',
      '1. setTimeout',
    ]);
    for (let i = 1; i < index!.length; i++) act(() => useStore.getState().stepForward());
    expect(useStore.getState().cursor).toBe(index!.length - 1);
    expect(screen.getAllByText('1. setTimeout').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Done').length).toBeGreaterThan(0);
    for (let i = 0; i < 30; i++) act(() => useStore.getState().stepBackward());
    act(() => useStore.getState().seek(3));
    expect(screen.getByRole('log').textContent).not.toContain('1. setTimeout');
  });

  it('replays every event of every example without errors', async () => {
    await mountAndRun();
    for (const ex of EXAMPLES) {
      await load(ex.id);
      const { index } = useStore.getState();
      for (let i = 1; i < index!.length; i++) act(() => useStore.getState().stepForward());
      expect(useStore.getState().cursor).toBe(index!.length - 1);
    }
  }, 180_000);

  it('survives the timeline scrolling while a step is still rendering', async () => {
    // Follow mode scrolls the timeline as the cursor moves. With an update already pending, React
    // runs the scroll's state updater later, after the synthetic event's currentTarget is cleared.
    await mountAndRun();
    const scroller = screen.getByRole('region', { name: 'Execution timeline' }).querySelector('.overflow-y-auto')!;
    act(() => {
      useStore.getState().stepForward();
      fireEvent.scroll(scroller, { target: { scrollTop: 260 } });
    });
    expect(screen.getByRole('region', { name: 'Execution timeline' })).toBeTruthy();
  });

  it('stops playback at a breakpoint', async () => {
    await mountAndRun();
    await load('closures-counter');
    act(() => {
      useStore.setState({ breakpoints: [10] });
      useStore.getState().restart();
      useStore.setState({ playing: true });
    });
    for (let guard = 0; useStore.getState().playing && guard < 5000; guard++) act(() => useStore.getState().advance());
    const { index, cursor } = useStore.getState();
    expect(index!.events[cursor]).toMatchObject({ kind: 'step', line: 10 });
    act(() => useStore.setState({ breakpoints: [] }));
  });

  it('renders the inspector tabs, including the React Flow task graph', async () => {
    await mountAndRun();
    fireEvent.click(screen.getByRole('tab', { name: 'Task graph' }));
    for (let i = 0; i < 60; i++) act(() => useStore.getState().stepForward());
    fireEvent.click(screen.getByRole('tab', { name: 'Promises' }));
    for (let i = 0; i < 10; i++) act(() => useStore.getState().stepForward());
    fireEvent.click(screen.getByRole('tab', { name: 'Variables' }));
    expect(screen.getByRole('tab', { name: 'Variables' }).getAttribute('aria-selected')).toBe('true');
  });

  it('searches and loads an example from the library', async () => {
    await mountAndRun();
    fireEvent.click(screen.getByRole('button', { name: 'Example library' }));
    fireEvent.change(screen.getByLabelText('Search examples'), { target: { value: 'debounce' } });
    fireEvent.click(screen.getByText('Build a debounce'));
    await waitFor(() => expect(useStore.getState().runCode).toContain('function debounce'));
    expect(useStore.getState().mode).toBe('browser');
    act(() => useStore.getState().pause());
  });

  it('shows syntax errors and safety-limit stops as notices', async () => {
    await mountAndRun();
    act(() => useStore.getState().setCode('const = 1;'));
    await act(async () => useStore.getState().run());
    await waitFor(() => expect(screen.getByText(/Line 1: SyntaxError/)).toBeTruthy());
    act(() => useStore.getState().setCode('let i = 0;\nwhile (true) { i++; }'));
    await act(async () => useStore.getState().run({ autoplay: false }));
    await waitFor(() => expect(screen.getByText('Execution stopped by a safety limit')).toBeTruthy());
  });

  it('renders presentation, about and mobile layouts', async () => {
    await mountAndRun();
    act(() => useStore.getState().setUi({ presenting: true }));
    for (let i = 0; i < 25; i++) act(() => useStore.getState().stepForward());
    expect(screen.getByRole('button', { name: 'Exit presentation mode' })).toBeTruthy();
    act(() => useStore.getState().setUi({ presenting: false, aboutOpen: true }));
    expect(screen.getByRole('dialog', { name: 'How JS Runtime Lab works' })).toBeTruthy();
    cleanup();
    mobile = true;
    render(<App />);
    for (const name of ['Code', 'Explain', 'Timeline', 'Runtime']) {
      fireEvent.click(screen.getByRole('button', { name }));
      act(() => useStore.getState().stepForward());
    }
    expect(screen.getByRole('navigation', { name: 'Views' })).toBeTruthy();
  });
});
