import '@fontsource/ibm-plex-sans/400.css';
import '@fontsource/ibm-plex-sans/500.css';
import '@fontsource/ibm-plex-sans/600.css';
import '@fontsource-variable/jetbrains-mono';
import './styles.css';
import EditorWorker from 'monaco-editor/editor/editor.worker?worker';
import TsWorker from 'monaco-editor/languages/features/typescript/ts.worker?worker';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';

// Monaco's own workers (syntax checks, completions, formatting). User code never runs in these.
(self as unknown as { MonacoEnvironment: unknown }).MonacoEnvironment = {
  getWorker: (_id: string, label: string) => (label === 'typescript' || label === 'javascript' ? new TsWorker() : new EditorWorker()),
};

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
