import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type WheelEvent as ReactWheelEvent,
} from 'react';

const STICK_THRESHOLD = 70;
const JUMP_THRESHOLD = 140;
const SPRING_DAMPING = 0.7;
const SPRING_STIFFNESS = 0.05;
const SPRING_MASS = 1.25;
const SPRING_FRAME_MS = 1000 / 60;
const SPRING_MAX_CATCHUP_FRAMES = 8;
const SPRING_GROWTH_EMA = 0.12;
const SPRING_CHASE_MAX_LEAD = 32;

interface SpringState {
  velocity: number;
  targetVelocity: number;
  lastTarget: number | null;
  lastTime: number | null;
}

function distanceFromBottom(thread: HTMLDivElement) {
  return Math.max(0, thread.scrollHeight - thread.scrollTop - thread.clientHeight);
}

function reducedMotion() {
  return typeof window !== 'undefined'
    && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
}

/**
 * One owner for transcript follow intent. Content growth is consumed by a
 * feed-forward spring; only real user input breaks the pin. A short runway
 * below the latest content keeps the first part of a new answer from forcing
 * an immediate viewport jump.
 */
export function useTranscriptFollow(key: string | null, active = false) {
  const threadRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);
  const spring = useRef<SpringState>({
    velocity: 0,
    targetVelocity: 0,
    lastTarget: null,
    lastTime: null,
  });
  const frameRef = useRef<number | null>(null);
  const programmaticUntil = useRef(0);
  const lastScrollHeight = useRef(0);
  const lastDistance = useRef(0);
  const runwayRef = useRef(0);
  const initialRunwayBase = useRef<number | null>(null);
  const initialRunway = useRef(0);
  const measureRef = useRef<() => void>(() => undefined);
  const activeRef = useRef(active);
  activeRef.current = active;
  const [pinned, setPinned] = useState(true);
  const [showJump, setShowJump] = useState(false);
  const [runway, setRunway] = useState(0);

  const stopFrame = useCallback(() => {
    if (frameRef.current !== null) {
      cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    }
  }, []);

  const markProgrammatic = useCallback((durationMs = 80) => {
    programmaticUntil.current = performance.now() + durationMs;
  }, []);

  const setPinnedState = useCallback((next: boolean) => {
    pinnedRef.current = next;
    setPinned(current => current === next ? current : next);
    if (!next) {
      spring.current.lastTarget = null;
      spring.current.lastTime = null;
    } else setShowJump(false);
  }, []);

  const step = useCallback(function stepSpring(now: number) {
    frameRef.current = null;
    const thread = threadRef.current;
    if (!thread || !pinnedRef.current) return;
    if (reducedMotion()) {
      markProgrammatic();
      thread.scrollTop = thread.scrollHeight;
      return;
    }

    const state = spring.current;
    const target = thread.scrollHeight;
    const elapsed = state.lastTime === null ? SPRING_FRAME_MS : now - state.lastTime;
    const frames = Math.min(SPRING_MAX_CATCHUP_FRAMES, Math.max(0.25, elapsed / SPRING_FRAME_MS));
    state.lastTime = now;

    const grew = state.lastTarget === null ? 0 : target - state.lastTarget;
    state.lastTarget = target;
    if (grew < -1) state.targetVelocity = 0;
    else {
      const observed = Math.max(0, grew) / frames;
      state.targetVelocity += SPRING_GROWTH_EMA * (observed - state.targetVelocity);
    }

    const chase = target - Math.min(SPRING_CHASE_MAX_LEAD, state.targetVelocity * 9);
    let position = thread.scrollTop;
    let velocity = state.velocity;
    const diff = Math.max(0, chase - position);
    velocity += ((SPRING_DAMPING * velocity + SPRING_STIFFNESS * diff) / SPRING_MASS - velocity) * frames;
    position = Math.min(target, position + (velocity + state.targetVelocity) * frames);
    state.velocity = velocity;

    markProgrammatic();
    thread.scrollTop = target - position <= 0.5 ? target : position;
    lastScrollHeight.current = thread.scrollHeight;
    lastDistance.current = distanceFromBottom(thread);
    if (lastDistance.current > 0.5) frameRef.current = requestAnimationFrame(stepSpring);
  }, [markProgrammatic]);

  const wake = useCallback(() => {
    if (!pinnedRef.current || frameRef.current !== null) return;
    frameRef.current = requestAnimationFrame(step);
  }, [step]);

  const scrollToLatest = useCallback((behavior: ScrollBehavior = 'auto') => {
    setPinnedState(true);
    setShowJump(false);
    stopFrame();
    const thread = threadRef.current;
    if (!thread) return;
    markProgrammatic(behavior === 'smooth' ? 450 : 120);
    if (behavior === 'smooth' && !reducedMotion()) {
      thread.scrollTo({ top: thread.scrollHeight, behavior });
      return;
    }
    thread.scrollTop = thread.scrollHeight;
    lastScrollHeight.current = thread.scrollHeight;
    lastDistance.current = 0;
  }, [markProgrammatic, setPinnedState, stopFrame]);

  const onWheel = useCallback((event: ReactWheelEvent<HTMLDivElement>) => {
    const thread = threadRef.current;
    if (!thread) return;
    lastScrollHeight.current = thread.scrollHeight;
    const distance = distanceFromBottom(thread);
    if (event.deltaY < 0) {
      setPinnedState(false);
      setShowJump(distance > JUMP_THRESHOLD);
      stopFrame();
      return;
    }
    if (event.deltaY > 0 && distance <= STICK_THRESHOLD) {
      setPinnedState(true);
      setShowJump(false);
      wake();
    }
  }, [setPinnedState, stopFrame, wake]);

  const onTouchStart = useCallback(() => {
    setPinnedState(false);
    stopFrame();
  }, [setPinnedState, stopFrame]);

  const onScroll = useCallback(() => {
    const thread = threadRef.current;
    if (!thread) return;
    const distance = distanceFromBottom(thread);
    const growth = thread.scrollHeight - lastScrollHeight.current;
    lastScrollHeight.current = thread.scrollHeight;
    if (programmaticUntil.current > performance.now()) return;
    // Layout growth is not user intent. Do not unpin merely because the tail
    // grew under a viewport that was intentionally following it.
    if (growth > 1) {
      lastDistance.current = distance;
      return;
    }
    if (distance > STICK_THRESHOLD) setPinnedState(false);
    else if (distance < lastDistance.current - 0.5) setPinnedState(true);
    setShowJump(!pinnedRef.current && distance > JUMP_THRESHOLD);
    lastDistance.current = distance;
  }, [setPinnedState]);

  useLayoutEffect(() => {
    pinnedRef.current = true;
    setPinned(true);
    setShowJump(false);
    setRunway(0);
    runwayRef.current = 0;
    initialRunwayBase.current = null;
    initialRunway.current = 0;
    spring.current = { velocity: 0, targetVelocity: 0, lastTarget: null, lastTime: null };
    if (!key) return;
    const thread = threadRef.current;
    const content = contentRef.current;
    if (!thread || !content) return;

    const measure = () => {
      if (!activeRef.current) {
        if (runwayRef.current !== 0) {
          runwayRef.current = 0;
          setRunway(0);
        }
        if (pinnedRef.current) wake();
        return;
      }
      const baseHeight = Math.max(0, content.scrollHeight - runwayRef.current);
      if (initialRunwayBase.current === null) {
        initialRunwayBase.current = baseHeight;
        initialRunway.current = pinnedRef.current
          ? Math.max(0, Math.min(360, thread.clientHeight - baseHeight - 2))
          : 0;
      }
      const consumed = Math.max(0, baseHeight - initialRunwayBase.current);
      const next = Math.max(0, initialRunway.current - consumed);
      if (Math.abs(next - runwayRef.current) > 1) {
        runwayRef.current = next;
        setRunway(next);
      }
      if (pinnedRef.current && baseHeight < thread.clientHeight) wake();
    };
    measureRef.current = measure;
    const observer = new ResizeObserver(measure);
    observer.observe(content);
    observer.observe(thread);
    measure();
    return () => {
      measureRef.current = () => undefined;
      observer.disconnect();
      stopFrame();
    };
  }, [key, stopFrame, wake]);

  useEffect(() => {
    if (active) {
      initialRunwayBase.current = null;
      initialRunway.current = 0;
      requestAnimationFrame(() => measureRef.current());
      return;
    }
    runwayRef.current = 0;
    initialRunwayBase.current = null;
    initialRunway.current = 0;
    setRunway(0);
  }, [active]);

  useEffect(() => () => {
    stopFrame();
  }, [stopFrame]);

  return {
    threadRef,
    contentRef,
    pinned,
    showJump,
    runway,
    onScroll,
    onWheel,
    onTouchStart,
    scrollToLatest,
  };
}
