type FrameListener = (stamp: number) => void;
const listeners = new Set<FrameListener>();
let raf = 0;

function tick(stamp: number) {
  raf = 0;
  listeners.forEach((listener) => listener(stamp));
  if (listeners.size) raf = requestAnimationFrame(tick);
}

/** Share display timing without scheduling React renders for animation frames. */
export function onAnimationFrame(listener: FrameListener) {
  listeners.add(listener);
  if (!raf) raf = requestAnimationFrame(tick);
  return () => {
    listeners.delete(listener);
    if (!listeners.size) {
      cancelAnimationFrame(raf);
      raf = 0;
    }
  };
}
