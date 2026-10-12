import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { BotEngine } from "./vendor/bloub/engine";
import { EXPRESSION_BY_ID } from "./vendor/bloub/expressions";
import { RAYON, DEMI_VIEWBOX as VB } from "./vendor/bloub/repere";
import { STATE_BY_ID, type StateId } from "./vendor/bloub/states";
import { onAnimationFrame } from "./animationLoop";
import { bloubRenderer } from "./bloubRenderer";

export type BotMood =
  | "idle"
  | "listening"
  | "thinking"
  | "working"
  | "waiting"
  | "success"
  | "error"
  | "sleep";
const poses: Record<BotMood, StateId> = {
  idle: "idle",
  listening: "idle",
  thinking: "thinking",
  working: "orbit",
  waiting: "notify",
  success: "wink",
  error: "alert",
  sleep: "sleep",
};
const expressions: Record<BotMood, string> = {
  idle: "neutre",
  listening: "attentif",
  thinking: "curieux",
  working: "attentif",
  waiting: "curieux",
  success: "heureux",
  error: "triste",
  sleep: "somnolent",
};
const labels: Record<BotMood, string> = {
  idle: "知小汇待命",
  listening: "知小汇正在聆听",
  thinking: "知小汇正在思考",
  working: "知小汇正在执行任务",
  waiting: "知小汇等待你的确认",
  success: "知小汇已完成任务",
  error: "知小汇需要处理执行问题",
  sleep: "知小汇休息中",
};

/** React owns the shell; the engine paints pooled SVG nodes at display cadence. */
export function BloubAvatar({
  mood = "idle",
  size = 84,
  decorative = false,
  followPointer = false,
  color = "#293a55",
  paper = "#ffffff",
  suspended = false,
}: {
  mood?: BotMood;
  size?: number;
  decorative?: boolean;
  followPointer?: boolean;
  color?: string;
  paper?: string;
  suspended?: boolean;
}) {
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const root = useRef<SVGSVGElement>(null);
  const engine = useRef<BotEngine | null>(null);
  if (!engine.current) engine.current = new BotEngine(RAYON, poses[mood]);
  const renderer = useRef<ReturnType<typeof bloubRenderer> | null>(null);
  const clock = useRef(0);
  const targetYaw = useRef(0);
  const [reduced, setReduced] = useState(
    () => window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  const [visible, setVisible] = useState(true);
  const [hidden, setHidden] = useState(() => document.hidden);
  useLayoutEffect(() => {
    const paint = bloubRenderer(root.current!, uid, color, paper);
    renderer.current = paint;
    paint.paint(engine.current!.sample(clock.current));
    return () => {
      paint.dispose();
      renderer.current = null;
    };
  }, [uid, color, paper]);
  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const change = () => setReduced(media.matches);
    const page = () => setHidden(document.hidden);
    media.addEventListener("change", change);
    document.addEventListener("visibilitychange", page);
    const observer = new IntersectionObserver(([entry]) =>
      setVisible(entry.isIntersecting),
    );
    if (root.current) observer.observe(root.current);
    return () => {
      media.removeEventListener("change", change);
      document.removeEventListener("visibilitychange", page);
      observer.disconnect();
    };
  }, []);
  useEffect(() => {
    const bot = engine.current!;
    const expression = EXPRESSION_BY_ID.get(expressions[mood]) || null;
    if (reduced) {
      bot.reset(poses[mood], 0);
      bot.setExpression(expression, 0);
      clock.current = mood === "working" ? 1.8 : 1.1;
      if (followPointer)
        bot.setLook(
          { yaw: targetYaw.current, pitch: 0, mix: 1, spin: 0, wander: 0 },
          clock.current,
          0.001,
        );
      renderer.current?.paint(bot.sample(clock.current + 0.002));
      return;
    }
    bot.setExpression(expression, clock.current);
    bot.setState(poses[mood], clock.current);
    renderer.current?.paint(bot.sample(clock.current));
    if (!visible || hidden || suspended) return;
    let previous = 0,
      stateAt = clock.current;
    return onAnimationFrame((stamp) => {
      if (previous) clock.current += Math.min((stamp - previous) / 1000, 0.08);
      previous = stamp;
      const elapsed = clock.current - stateAt;
      if (
        mood === "working" &&
        elapsed >= STATE_BY_ID.get(bot.state)!.duration
      ) {
        bot.setState(
          bot.state === "orbit" ? "thinking" : "orbit",
          clock.current,
        );
        stateAt = clock.current;
      } else if (mood === "success" && bot.state === "wink" && elapsed > 2.2)
        bot.setState("idle", clock.current);
      renderer.current?.paint(bot.sample(clock.current));
    });
  }, [mood, reduced, visible, hidden, suspended, followPointer]);
  useEffect(() => {
    if (!followPointer || !visible || hidden || suspended) return;
    const bot = engine.current!;
    // Pointer events never read layout. Refresh the center when the pane moves.
    let centerX = 0,
      range = 180;
    let pointerX: number | null = null;
    const look = (yaw: number) => {
      if (targetYaw.current === yaw && yaw !== 0) return;
      targetYaw.current = yaw;
      bot.setLook(
        { yaw, pitch: 0, mix: 1, spin: 0, wander: 0 },
        clock.current,
        reduced ? 0.001 : BotEngine.LOOK_MORPH,
      );
      if (reduced) renderer.current?.paint(bot.sample(clock.current + 0.002));
    };
    const follow = () => {
      if (pointerX !== null)
        look(Math.max(-1, Math.min(1, (pointerX - centerX) / range)) * 48);
    };
    const bounds = () => {
      const rect = root.current!.getBoundingClientRect();
      centerX = rect.left + rect.width / 2;
      range = Math.max(180, innerWidth * 0.28);
      follow();
    };
    bounds();
    const observer = new ResizeObserver(bounds);
    observer.observe(root.current!);
    const pane = root.current!.closest(".bot-chat-pane");
    if (pane) observer.observe(pane);
    const move = (event: globalThis.PointerEvent) => {
      if (event.pointerType === "touch") return;
      pointerX = event.clientX;
      follow();
    };
    const center = () => {
      pointerX = null;
      look(0);
    };
    center();
    window.addEventListener("pointermove", move, { passive: true });
    window.addEventListener("resize", bounds, { passive: true });
    window.addEventListener("scroll", bounds, { passive: true, capture: true });
    window.addEventListener("blur", center);
    document.documentElement.addEventListener("pointerleave", center);
    return () => {
      observer.disconnect();
      window.removeEventListener("pointermove", move);
      window.removeEventListener("resize", bounds);
      window.removeEventListener("scroll", bounds, true);
      window.removeEventListener("blur", center);
      document.documentElement.removeEventListener("pointerleave", center);
      bot.setLook(null, clock.current, reduced ? 0.001 : BotEngine.LOOK_MORPH);
    };
  }, [followPointer, visible, hidden, reduced, suspended]);
  return (
    <svg
      ref={root}
      className="bloub-avatar"
      data-mood={mood}
      data-motion={reduced ? "reduced" : suspended ? "paused" : "animated"}
      data-follow-pointer={followPointer || undefined}
      width={size}
      height={size}
      viewBox={`${-VB} ${-VB} ${VB * 2} ${VB * 2}`}
      role={decorative ? undefined : "img"}
      aria-hidden={decorative || undefined}
      aria-label={decorative ? undefined : labels[mood]}
    >
      <defs>
        <mask
          id={`bloub-${uid}`}
          data-part="mask"
          maskUnits="userSpaceOnUse"
          x={-VB}
          y={-VB}
          width={VB * 2}
          height={VB * 2}
        />
        <g data-part="gradients" />
      </defs>
      <g data-part="arcs-back" fill="none" strokeLinecap="round" />
      <g data-part="dots-back" />
      <g data-part="body" />
      <g data-part="dots-front" />
      <g data-part="notification" />
      <g data-part="arcs-front" fill="none" strokeLinecap="round" />
    </svg>
  );
}
