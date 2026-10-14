import { useEffect, useState } from 'react';
import { ConsolePanel, FlightLayer, RuntimeBoard } from './components/Board';
import { AboutDialog, BoardNotices, EditorPanel, ExamplesDialog, MobileNav, MobileTransport, Splitter, Toolbar } from './components/Chrome';
import { ExplanationCard, Inspector } from './components/Inspector';
import { Timeline } from './components/Timeline';
import { eventDuration, useStore } from './store/store';

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/** Advances the cursor one event at a time; each event stays on screen for its own duration. */
function usePlayback() {
  const playing = useStore((s) => s.playing);
  const cursor = useStore((s) => s.cursor);
  const speed = useStore((s) => s.speed);
  const index = useStore((s) => s.index);
  useEffect(() => {
    if (!playing || !index) return;
    const ev = index.events[Math.max(0, cursor)];
    const t = window.setTimeout(() => useStore.getState().advance(), (ev ? eventDuration(ev) : 300) / speed);
    return () => window.clearTimeout(t);
  }, [playing, cursor, speed, index]);
}

function useKeyboard() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const s = useStore.getState();
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        void s.run();
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.closest('.monaco-editor') || /^(INPUT|TEXTAREA|SELECT|BUTTON)$/.test(t.tagName) || t.isContentEditable)) return;
      if (s.examplesOpen || s.aboutOpen) return;
      switch (e.key) {
        case ' ':
          e.preventDefault();
          s.togglePlay();
          break;
        case 'ArrowRight':
          e.preventDefault();
          s.stepForward();
          break;
        case 'ArrowLeft':
          e.preventDefault();
          s.stepBackward();
          break;
        case 'Home':
          s.restart();
          break;
        case 'End':
          if (s.index) s.seek(s.index.length - 1);
          break;
        case 'f':
        case 'F':
          s.setUi({ presenting: !s.presenting });
          break;
        case 'Escape':
          if (s.presenting) s.setUi({ presenting: false });
          break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}

function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const on = () => setMatches(mq.matches);
    mq.addEventListener('change', on);
    on();
    return () => mq.removeEventListener('change', on);
  }, [query]);
  return matches;
}

/** Presentation mode also asks for browser fullscreen; leaving fullscreen leaves presentation mode. */
function useFullscreen(presenting: boolean) {
  useEffect(() => {
    const root = document.documentElement;
    if (presenting && !document.fullscreenElement) root.requestFullscreen?.().catch(() => undefined);
    if (!presenting && document.fullscreenElement) document.exitFullscreen?.().catch(() => undefined);
  }, [presenting]);
  useEffect(() => {
    const on = () => {
      if (!document.fullscreenElement && useStore.getState().presenting) useStore.getState().setUi({ presenting: false });
    };
    document.addEventListener('fullscreenchange', on);
    return () => document.removeEventListener('fullscreenchange', on);
  }, []);
}

function DesktopLayout() {
  const editorWidth = useStore((s) => s.editorWidth);
  const inspectorWidth = useStore((s) => s.inspectorWidth);
  const timelineHeight = useStore((s) => s.timelineHeight);
  return (
    <div className="flex h-full flex-col">
      <Toolbar />
      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-[260px] flex-col py-3 pl-3" style={{ width: `${editorWidth * 100}%` }}>
          <EditorPanel />
        </div>
        <Splitter
          orientation="vertical"
          label="Resize the editor"
          onDrag={(dx) => useStore.setState((s) => ({ editorWidth: clamp(s.editorWidth + dx / window.innerWidth, 0.18, 0.5) }))}
        />
        <main className="flex min-w-0 flex-1 flex-col">
          <BoardNotices />
          <div className="min-h-0 flex-1">
            <RuntimeBoard />
          </div>
          <div className="h-[128px] flex-none px-3 pb-3">
            <ConsolePanel />
          </div>
        </main>
        <Splitter
          orientation="vertical"
          label="Resize the inspector"
          onDrag={(dx) => useStore.setState((s) => ({ inspectorWidth: clamp(s.inspectorWidth - dx / window.innerWidth, 0.16, 0.4) }))}
        />
        <aside className="flex min-w-[270px] flex-col py-3 pr-3" style={{ width: `${inspectorWidth * 100}%` }}>
          <Inspector />
        </aside>
      </div>
      <Splitter
        orientation="horizontal"
        label="Resize the timeline"
        onDrag={(dy) => useStore.setState((s) => ({ timelineHeight: clamp(s.timelineHeight - dy, 120, 520) }))}
      />
      <div className="flex-none px-3 pb-3" style={{ height: timelineHeight }}>
        <Timeline />
      </div>
    </div>
  );
}

function PresentationLayout() {
  return (
    <div className="flex h-full flex-col">
      <Toolbar variant="present" />
      <div className="flex min-h-0 flex-1">
        <div className="flex w-[31%] min-w-[280px] flex-col py-3 pl-3">
          <EditorPanel />
        </div>
        <main className="min-w-0 flex-1">
          <RuntimeBoard />
        </main>
      </div>
      <div className="grid h-[164px] flex-none grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)] gap-3 px-3 pb-3">
        <ExplanationCard compact />
        <ConsolePanel />
      </div>
    </div>
  );
}

function MobileLayout() {
  const view = useStore((s) => s.mobileView);
  return (
    <div className="flex h-full flex-col">
      <Toolbar variant="compact" />
      <BoardNotices />
      <div className="min-h-0 flex-1 p-2">
        {view === 'code' && <EditorPanel />}
        {view === 'runtime' && (
          <div className="flex h-full flex-col gap-2">
            <div className="min-h-0 flex-1">
              <RuntimeBoard />
            </div>
            <div className="h-[112px] flex-none">
              <ConsolePanel />
            </div>
          </div>
        )}
        {view === 'explain' && <Inspector />}
        {view === 'timeline' && <Timeline />}
      </div>
      <MobileTransport />
      <MobileNav />
    </div>
  );
}

export function App() {
  usePlayback();
  useKeyboard();
  const presenting = useStore((s) => s.presenting);
  useFullscreen(presenting);
  const mobile = useMediaQuery('(max-width: 899px)');
  useEffect(() => {
    void useStore.getState().run({ autoplay: false });
  }, []);
  return (
    <>
      {presenting ? <PresentationLayout /> : mobile ? <MobileLayout /> : <DesktopLayout />}
      <FlightLayer />
      <ExamplesDialog />
      <AboutDialog />
    </>
  );
}
