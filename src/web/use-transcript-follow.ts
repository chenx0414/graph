import { useCallback, useEffect, useRef, useState } from 'react';

const STICK_THRESHOLD = 96;
const JUMP_THRESHOLD = 140;

function jumpToBottom(thread: HTMLDivElement, behavior: ScrollBehavior) {
  if (behavior === 'smooth') {
    thread.scrollTo({ top: thread.scrollHeight, behavior });
    return;
  }
  const previous = thread.style.scrollBehavior;
  thread.style.scrollBehavior = 'auto';
  thread.scrollTop = thread.scrollHeight;
  thread.style.scrollBehavior = previous;
}

/**
 * One owner for transcript follow intent. Content growth keeps the viewport
 * pinned while the reader stays near the bottom; an intentional upward scroll
 * releases it until they return or explicitly jump back.
 */
export function useTranscriptFollow(key: string | null) {
  const threadRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);
  const frameRef = useRef<number | null>(null);
  const programmaticRef = useRef(false);
  const programmaticTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [pinned, setPinned] = useState(true);
  const [showJump, setShowJump] = useState(false);

  const markProgrammatic = useCallback((durationMs: number) => {
    programmaticRef.current = true;
    if (programmaticTimer.current) clearTimeout(programmaticTimer.current);
    programmaticTimer.current = setTimeout(() => {
      programmaticTimer.current = null;
      programmaticRef.current = false;
    }, durationMs);
  }, []);

  const cancelFrame = useCallback(() => {
    if (frameRef.current !== null) {
      cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    }
  }, []);

  const scrollToLatest = useCallback((behavior: ScrollBehavior = 'auto') => {
    pinnedRef.current = true;
    setPinned(true);
    setShowJump(false);
    cancelFrame();
    markProgrammatic(behavior === 'smooth' ? 450 : 120);
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null;
      const thread = threadRef.current;
      if (thread) jumpToBottom(thread, behavior);
    });
  }, [cancelFrame, markProgrammatic]);

  const onScroll = useCallback(() => {
    if (programmaticRef.current) return;
    const thread = threadRef.current;
    if (!thread) return;
    const distance = Math.max(0, thread.scrollHeight - thread.scrollTop - thread.clientHeight);
    const nextPinned = distance <= STICK_THRESHOLD;
    pinnedRef.current = nextPinned;
    setPinned(current => current === nextPinned ? current : nextPinned);
    const nextShowJump = !nextPinned && distance > JUMP_THRESHOLD;
    setShowJump(current => current === nextShowJump ? current : nextShowJump);
  }, []);

  useEffect(() => {
    pinnedRef.current = true;
    setPinned(true);
    setShowJump(false);
    if (!key) return;
    const thread = threadRef.current;
    const content = contentRef.current;
    if (!thread || !content) return;

    const follow = () => {
      if (!pinnedRef.current) return;
      cancelFrame();
      markProgrammatic(120);
      frameRef.current = requestAnimationFrame(() => {
        frameRef.current = null;
        if (!pinnedRef.current) return;
        jumpToBottom(thread, 'auto');
      });
    };
    follow();

    const observer = new ResizeObserver(follow);
    observer.observe(content);
    observer.observe(thread);
    return () => {
      observer.disconnect();
      cancelFrame();
      if (programmaticTimer.current) clearTimeout(programmaticTimer.current);
      programmaticTimer.current = null;
      programmaticRef.current = false;
    };
  }, [cancelFrame, key, markProgrammatic]);

  useEffect(() => () => {
    cancelFrame();
    if (programmaticTimer.current) clearTimeout(programmaticTimer.current);
  }, [cancelFrame]);

  return {
    threadRef,
    contentRef,
    pinned,
    showJump,
    onScroll,
    scrollToLatest,
  };
}
