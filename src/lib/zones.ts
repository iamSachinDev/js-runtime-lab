import { useCallback } from 'react';

/** DOM anchors for flight animations (editor line → Web APIs / queues / console). */
const zones = new Map<string, HTMLElement>();
let lineRectProvider: ((line: number) => DOMRect | null) | null = null;

export function useZone(id: string) {
  return useCallback(
    (el: HTMLElement | null) => {
      if (el) zones.set(id, el);
      else if (zones.get(id)) zones.delete(id);
    },
    [id],
  );
}

export function zoneRect(id: string): DOMRect | null {
  const el = zones.get(id);
  if (!el || !el.isConnected) return null;
  const r = el.getBoundingClientRect();
  return r.width && r.height ? r : null;
}

export function setLineRectProvider(fn: ((line: number) => DOMRect | null) | null): void {
  lineRectProvider = fn;
}

export function lineRect(line: number): DOMRect | null {
  return lineRectProvider?.(line) ?? null;
}
