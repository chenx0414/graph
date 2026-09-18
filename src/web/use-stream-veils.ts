import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { MarkdownVeil } from './markdown-blocks.ts';

export const VEIL_EMA_SEED_MS = 160;
export const VEIL_MIN_FADE_MS = 120;
export const VEIL_MAX_FADE_MS = 400;

interface VeilChunk {
  start: number;
  end: number;
  startedAt: number;
  durationMs: number;
}

interface VeilState {
  previous: string;
  chunks: VeilChunk[];
  emaMs: number;
  lastAppendAt: number | null;
  frame: number | null;
}

export function commonPrefixLength(left: string, right: string) {
  const limit = Math.min(left.length, right.length);
  let index = 0;
  while (index < limit && left[index] === right[index]) index += 1;
  return index;
}

function frameBoost(activeChunks: number) {
  return 1 + 0.3 * Math.max(0, activeChunks - 2);
}

/**
 * Fade only the exact suffix that arrived since the previous render. The text
 * itself is committed immediately, so opacity changes never participate in
 * layout. Multiple fast chunks can fade concurrently and never reanimate.
 */
export function useStreamVeils(text: string, key: string, active: boolean): MarkdownVeil[] {
  const [, setFrame] = useState(0);
  const keyRef = useRef(key);
  const state = useRef<VeilState>({
    previous: text,
    chunks: [],
    emaMs: VEIL_EMA_SEED_MS,
    lastAppendAt: null,
    frame: null,
  });

  const stop = useCallback(() => {
    if (state.current.frame !== null) {
      cancelAnimationFrame(state.current.frame);
      state.current.frame = null;
    }
  }, []);

  const tick = useCallback(() => {
    state.current.frame = null;
    const now = performance.now();
    state.current.chunks = state.current.chunks.filter(chunk => {
      const boost = frameBoost(state.current.chunks.length);
      const progress = ((now - chunk.startedAt) * boost) / chunk.durationMs;
      return progress < 1;
    });
    setFrame(current => current + 1);
    if (state.current.chunks.length) state.current.frame = requestAnimationFrame(tick);
  }, []);

  useLayoutEffect(() => {
    const current = state.current;
    if (keyRef.current !== key) {
      keyRef.current = key;
      current.previous = text;
      current.chunks = [];
      current.lastAppendAt = null;
      current.emaMs = VEIL_EMA_SEED_MS;
      stop();
      return;
    }
    if (!active) {
      current.previous = text;
      current.chunks = [];
      current.lastAppendAt = null;
      stop();
      return;
    }
    if (text === current.previous) return;

    const prefix = commonPrefixLength(current.previous, text);
    current.chunks = current.chunks.flatMap(chunk => {
      const end = Math.min(chunk.end, prefix);
      return chunk.start < end ? [{ ...chunk, end }] : [];
    });
    if (text.length > prefix) {
      const now = performance.now();
      if (current.lastAppendAt !== null) {
        const gap = Math.min(1000, now - current.lastAppendAt);
        current.emaMs = current.emaMs * 0.7 + gap * 0.3;
      }
      current.lastAppendAt = now;
      const durationMs = Math.max(VEIL_MIN_FADE_MS, Math.min(VEIL_MAX_FADE_MS, current.emaMs * 3));
      current.chunks.push({ start: prefix, end: text.length, startedAt: now, durationMs });
    }
    current.previous = text;
    if (current.chunks.length && current.frame === null) current.frame = requestAnimationFrame(tick);
  }, [active, key, stop, text, tick]);

  useEffect(() => stop, [stop]);

  const now = performance.now();
  return state.current.chunks.map(chunk => {
    const boost = frameBoost(state.current.chunks.length);
    const progress = Math.max(0, Math.min(1, ((now - chunk.startedAt) * boost) / chunk.durationMs));
    return {
      start: chunk.start,
      end: chunk.end,
      opacity: 1 - Math.pow(1 - progress, 1.6),
    };
  });
}
