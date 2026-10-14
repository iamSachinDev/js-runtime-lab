import type { RunOptions, RunResult } from '../engine/types';
import SandboxWorker from './worker?worker';

export type SandboxErrorCode = 'timeout' | 'crash' | 'cancelled';

export class SandboxError extends Error {
  constructor(
    readonly code: SandboxErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'SandboxError';
  }
}

/** Wall-clock watchdog. The engine's own budgets normally stop runaway code much earlier. */
export const SANDBOX_TIMEOUT_MS = 8_000;

const makeNonce = () =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;

export interface SandboxRun {
  promise: Promise<RunResult>;
  cancel(): void;
}

export function runInSandbox(options: RunOptions, timeoutMs = SANDBOX_TIMEOUT_MS): SandboxRun {
  const worker = new SandboxWorker({ name: 'js-runtime-lab-sandbox' });
  const nonce = makeNonce();
  let settled = false;
  let rejectRun: (err: SandboxError) => void = () => {};
  let timer: ReturnType<typeof setTimeout> | undefined;

  const finish = (fn: () => void) => {
    if (settled) return;
    settled = true;
    if (timer !== undefined) clearTimeout(timer);
    worker.terminate();
    fn();
  };

  const promise = new Promise<RunResult>((resolve, reject) => {
    rejectRun = reject;
    timer = setTimeout(
      () =>
        finish(() =>
          reject(
            new SandboxError(
              'timeout',
              `The program ran for more than ${timeoutMs / 1000} seconds without finishing, so the sandbox was stopped. A single native operation can't be interrupted (for example a catastrophic regular expression or a huge string), so it hit the watchdog.`,
            ),
          ),
        ),
      timeoutMs,
    );
    worker.onmessage = (e: MessageEvent) => {
      const data = e.data as { nonce?: string; type?: string; result?: RunResult; message?: string } | null;
      if (!data || data.nonce !== nonce) return;
      if (data.type === 'result' && data.result) finish(() => resolve(data.result!));
      else finish(() => reject(new SandboxError('crash', `The simulator failed: ${data.message ?? 'unknown error'}`)));
    };
    worker.onerror = (e) => {
      e.preventDefault();
      finish(() =>
        reject(new SandboxError('crash', e.message ? `The sandbox crashed: ${e.message}` : 'The sandbox crashed, most likely by running out of memory.')),
      );
    };
    worker.onmessageerror = () => finish(() => reject(new SandboxError('crash', 'The trace could not be transferred out of the sandbox.')));
    worker.postMessage({ nonce, options });
  });

  return {
    promise,
    cancel: () => finish(() => rejectRun(new SandboxError('cancelled', 'Run cancelled.'))),
  };
}
