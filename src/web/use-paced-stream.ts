import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

const FRAME_MS = 1000 / 60;
const TARGET_DRAIN_SECONDS = 1.2;
const MIN_CHARACTERS_PER_SECOND = 65;
const MAX_CHARACTERS_PER_SECOND = 1_400;

export function visualRevealCount(revealed: number, targetLength: number, elapsedMs: number) {
  const backlog = Math.max(0, targetLength - revealed);
  if (backlog === 0) return targetLength;
  const charactersPerSecond = Math.min(
    MAX_CHARACTERS_PER_SECOND,
    Math.max(MIN_CHARACTERS_PER_SECOND, backlog / TARGET_DRAIN_SECONDS),
  );
  return Math.min(targetLength, revealed + charactersPerSecond * elapsedMs / 1_000);
}

function reducedMotion() {
  return typeof window !== 'undefined'
    && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
}

export function usePacedStreamText(target: string, key: string, active: boolean, attached = false) {
  const keyRef = useRef(key);
  const targetRef = useRef(target);
  const revealedRef = useRef(active && !attached ? 0 : target.length);
  const lastFrameRef = useRef<number | null>(null);
  const frameRef = useRef<number | null>(null);
  const [visibleLength, setVisibleLength] = useState(() => active && !attached ? 0 : target.length);

  const stop = useCallback(() => {
    if (frameRef.current !== null) {
      cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    }
    lastFrameRef.current = null;
  }, []);

  const tick = useCallback(function tickReveal(now: number) {
    frameRef.current = null;
    const elapsed = lastFrameRef.current === null
      ? FRAME_MS
      : Math.min(80, Math.max(1, now - lastFrameRef.current));
    lastFrameRef.current = now;
    const currentTarget = targetRef.current;

    if (reducedMotion()) {
      revealedRef.current = currentTarget.length;
      setVisibleLength(currentTarget.length);
      stop();
      return;
    }

    revealedRef.current = visualRevealCount(revealedRef.current, currentTarget.length, elapsed);
    const nextVisible = Math.min(currentTarget.length, Math.floor(revealedRef.current));
    setVisibleLength(current => current === nextVisible ? current : nextVisible);
    if (revealedRef.current < currentTarget.length) {
      frameRef.current = requestAnimationFrame(tickReveal);
    } else {
      lastFrameRef.current = null;
    }
  }, [stop]);

  useLayoutEffect(() => {
    if (keyRef.current !== key) {
      keyRef.current = key;
      targetRef.current = target;
      const initial = active && !attached ? 0 : target.length;
      revealedRef.current = initial;
      stop();
      setVisibleLength(initial);
    } else {
      targetRef.current = target;
      if (revealedRef.current > target.length) {
        revealedRef.current = target.length;
        setVisibleLength(target.length);
      }
    }

    if (!reducedMotion() && revealedRef.current < targetRef.current.length && frameRef.current === null) {
      lastFrameRef.current = null;
      frameRef.current = requestAnimationFrame(tick);
    }
  }, [active, attached, key, stop, target, tick]);

  useEffect(() => stop, [stop]);

  const length = Math.min(visibleLength, target.length);
  return {
    text: target.slice(0, length),
    revealing: length < target.length,
    length,
    targetLength: target.length,
  };
}
