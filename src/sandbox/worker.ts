/**
 * Disposable execution sandbox: one worker per run. User code runs here, never in the
 * page. The page enforces a wall-clock watchdog and terminates the worker on timeout.
 */
import { execute } from '../engine/runtime/execute';
import type { RunOptions } from '../engine/types';

interface RunRequest {
  nonce: string;
  options: RunOptions;
}

// Captured before user code runs: the run shadows postMessage so programs can't forge results.
const send = self.postMessage.bind(self) as (message: unknown) => void;
const scope = self as unknown as { onmessage: ((e: MessageEvent<RunRequest>) => void) | null };

scope.onmessage = (e) => {
  const { nonce, options } = e.data ?? ({} as RunRequest);
  if (typeof nonce !== 'string' || !options) return;
  scope.onmessage = null;
  try {
    const result = execute(options);
    send({ nonce, type: 'result', result });
  } catch (err) {
    send({ nonce, type: 'crash', message: err instanceof Error ? `${err.name}: ${err.message}` : String(err) });
  }
};
