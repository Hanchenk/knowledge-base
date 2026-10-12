import { useEffect, useLayoutEffect, useRef, useState, useId } from "react";
import type { KeyboardEvent, PointerEvent } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Pause,
  Play,
  RotateCcw,
  Sparkles,
  Star,
  Trophy,
} from "lucide-react";
import { BloubAvatar, type BotMood } from "./BloubAvatar";
import { onAnimationFrame } from "./animationLoop";
import { api } from "./api";
import {
  InspirationLeaderboard,
  type InspirationStandings,
} from "./InspirationLeaderboard";
import "./bot-companion.css";

const DURATION = 15;
const GAME_API = "/api/bot/game/inspiration";
const clamp = (x: number) => Math.max(0.09, Math.min(0.91, x));
type Phase = "ready" | "playing" | "paused" | "finished";
type Light = { x: number; y: number; speed: number };
type Burst = { x: number; life: number };
const freshWorld = () => ({
  elapsed: 0,
  nextSpawn: 0.55,
  x: 0.5,
  score: 0,
  lights: [{ x: 0.5, y: -0.06, speed: 0.36 }] as Light[],
  bursts: [] as Burst[],
});
const LIGHT_SLOTS = Array.from({ length: 24 }, (_, i) => i);
const BURST_SLOTS = Array.from({ length: 8 }, (_, i) => i);

export function InspirationGame({
  onClose,
  active,
  guest = false,
}: {
  guest?: boolean;
  onClose: () => void;
  active: boolean;
}) {
  const [phase, setPhase] = useState<Phase>("ready");
  const [best, setBest] = useState(0);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState("");
  const [rankingOpen, setRankingOpen] = useState(false);
  const [standings, setStandings] = useState<InspirationStandings | null>(null);
  const [rankingLoading, setRankingLoading] = useState(false);
  const [rankingError, setRankingError] = useState("");
  const run = useRef<string | null>(null);
  const startingRef = useRef(false);
  const requestVersion = useRef(0);
  const alive = useRef(true);
  const visible = useRef(active);
  visible.current = active;
  useEffect(() => {
    alive.current = true;
    const controller = new AbortController();
    if (!guest)
      api<InspirationStandings>(`${GAME_API}/leaderboard`, {
        signal: controller.signal,
      })
        .then((result) => {
          if (alive.current && !run.current) setBest(result.me?.score ?? 0);
        })
        .catch(() => {
          /* Opening a game does not require loading the board. */
        });
    return () => {
      alive.current = false;
      controller.abort();
      requestVersion.current++;
    };
  }, []);
  const instructions = useId();
  const world = useRef(freshWorld());
  const [hud, setHud] = useState({ score: 0, seconds: DURATION, happy: false });
  const lastHud = useRef(hud);
  const stage = useRef<HTMLDivElement>(null);
  const startButton = useRef<HTMLButtonElement>(null);
  const keys = useRef(new Set<string>());
  const bounds = useRef({ left: 0, width: 1, height: 1 });
  const painter = useRef<() => void>(() => {});
  const updateHud = () => {
    const w = world.current;
    const next = {
      score: w.score,
      seconds: Math.ceil(DURATION - w.elapsed),
      happy: !!w.bursts.length,
    };
    const last = lastHud.current;
    if (
      last.score !== next.score ||
      last.seconds !== next.seconds ||
      last.happy !== next.happy
    ) {
      lastHud.current = next;
      setHud(next);
    }
  };
  useLayoutEffect(() => {
    const element = stage.current!;
    const lights = Array.from(
      element.querySelectorAll<HTMLElement>(".inspiration-light"),
    );
    const bursts = Array.from(
      element.querySelectorAll<HTMLElement>(".inspiration-burst"),
    );
    const catcher = element.querySelector<HTMLElement>(".inspiration-catcher")!;
    const paint = () => {
      const w = world.current,
        { width, height } = bounds.current;
      lights.forEach((sprite, i) => {
        const light = w.lights[i];
        sprite.hidden = !light;
        if (light)
          sprite.style.transform = `translate3d(${light.x * width - 11}px, ${light.y * height - 11}px, 0)`;
      });
      bursts.forEach((sprite, i) => {
        const burst = w.bursts[i];
        sprite.hidden = !burst;
        if (burst) {
          sprite.style.transform = `translate3d(${burst.x * width - 20}px, ${height * 0.71 - 24 * (1 - burst.life / 0.6)}px, 0)`;
          sprite.style.opacity = String(burst.life / 0.6);
        }
      });
      catcher.style.transform = `translate3d(${w.x * width - 38}px, ${height * 0.86 - 38}px, 0)`;
    };
    painter.current = paint;
    const measure = () => {
      const rect = element.getBoundingClientRect();
      bounds.current = {
        left: rect.left,
        width: rect.width,
        height: rect.height,
      };
      paint();
    };
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    const pane = element.closest(".bot-chat-main");
    if (pane) observer.observe(pane);
    window.addEventListener("resize", measure, { passive: true });
    window.addEventListener("scroll", measure, {
      passive: true,
      capture: true,
    });
    measure();
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
      painter.current = () => {};
    };
  }, []);
  useEffect(() => {
    if (active && phase !== "playing" && !rankingOpen)
      startButton.current?.focus({ preventScroll: true });
  }, [phase, active, rankingOpen]);
  const start = async () => {
    if (startingRef.current) return;
    startingRef.current = true;
    setStarting(true);
    setStartError("");
    try {
      const result = guest
        ? null
        : await api<{ id: string }>(`${GAME_API}/runs`, {
            method: "POST",
            signal: AbortSignal.timeout(10000),
          });
      if (!alive.current || !visible.current) return;
      run.current = result?.id ?? null;
      setRankingOpen(false);
      setStandings(null);
      setRankingError("");
      world.current = freshWorld();
      keys.current.clear();
      updateHud();
      painter.current();
      setPhase("playing");
    } catch (error) {
      if (alive.current)
        setStartError(
          `暂时无法开始，请重试。${error instanceof Error ? error.message : "网络连接失败"}`,
        );
    } finally {
      startingRef.current = false;
      if (alive.current) setStarting(false);
    }
  };
  const saveScore = async () => {
    if (!run.current) return;
    const version = ++requestVersion.current;
    setRankingLoading(true);
    setRankingError("");
    try {
      const result = await api<InspirationStandings>(
        `${GAME_API}/runs/${run.current}/finish`,
        {
          method: "POST",
          body: JSON.stringify({ score: world.current.score }),
          signal: AbortSignal.timeout(10000),
        },
      );
      if (!alive.current || version !== requestVersion.current) return;
      setStandings(result);
      setBest(result.me?.score ?? 0);
    } catch (error) {
      if (alive.current && version === requestVersion.current)
        setRankingError(
          error instanceof Error ? error.message : "网络连接失败",
        );
    } finally {
      if (alive.current && version === requestVersion.current)
        setRankingLoading(false);
    }
  };
  useEffect(() => {
    if (phase !== "playing" || !active) {
      keys.current.clear();
      return;
    }
    stage.current?.focus({ preventScroll: true });
    // Active wall time stays accurate during slow frames, but excludes pauses.
    const startedAt = performance.now(),
      elapsedAtStart = world.current.elapsed;
    let previousElapsed = elapsedAtStart;
    const stop = onAnimationFrame((stamp) => {
      const w = world.current;
      w.elapsed = Math.min(
        DURATION,
        elapsedAtStart + (stamp - startedAt) / 1000,
      );
      const dt = Math.max(0, w.elapsed - previousElapsed);
      previousElapsed = w.elapsed;
      const oldX = w.x;
      const left = keys.current.has("ArrowLeft") || keys.current.has("a");
      const right = keys.current.has("ArrowRight") || keys.current.has("d");
      w.x = clamp(w.x + (Number(right) - Number(left)) * dt * 0.72);
      while (w.elapsed >= w.nextSpawn && w.nextSpawn < DURATION - 2.4) {
        const speed = 0.31 + Math.random() * 0.08;
        w.lights.push({
          x: 0.12 + Math.random() * 0.76,
          y: -0.06 + (w.elapsed - w.nextSpawn) * speed - dt * speed,
          speed,
        });
        w.nextSpawn += 0.65;
      }
      for (let i = w.bursts.length - 1; i >= 0; i--)
        if ((w.bursts[i].life -= dt) <= 0) w.bursts.splice(i, 1);
      for (let i = w.lights.length - 1; i >= 0; i--) {
        const light = w.lights[i],
          before = light.y;
        light.y += dt * light.speed;
        const crossing =
          dt > 0
            ? Math.max(0, Math.min(1, (0.83 - before) / (dt * light.speed)))
            : 0;
        const catcherX = oldX + (w.x - oldX) * crossing;
        if (
          before < 0.83 &&
          light.y >= 0.83 &&
          Math.abs(light.x - catcherX) <=
            Math.min(44, Math.max(28, bounds.current.width * 0.105)) /
              bounds.current.width
        ) {
          w.score++;
          w.bursts.push({ x: light.x, life: 0.6 });
          w.lights.splice(i, 1);
        } else if (light.y >= 1.04) w.lights.splice(i, 1);
      }
      painter.current();
      updateHud();
      if (w.elapsed >= DURATION) {
        stop();
        setPhase("finished");
      }
    });
    const pause = () => {
      if (document.hidden) setPhase("paused");
    };
    const blur = () => setPhase("paused");
    document.addEventListener("visibilitychange", pause);
    window.addEventListener("blur", blur);
    return () => {
      stop();
      keys.current.clear();
      document.removeEventListener("visibilitychange", pause);
      window.removeEventListener("blur", blur);
    };
  }, [phase, active]);
  useEffect(() => {
    if (phase !== "finished") return;
    if (guest) {
      setBest((value) => Math.max(value, world.current.score));
      return;
    }
    setRankingOpen(true);
    void saveScore();
  }, [phase]);
  const move = (event: PointerEvent<HTMLDivElement>) => {
    if (phase !== "playing" || !active || !event.isPrimary) return;
    world.current.x = clamp(
      (event.clientX - bounds.current.left) / bounds.current.width,
    );
  };
  const keyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (
      phase !== "playing" ||
      !["ArrowLeft", "ArrowRight", "a", "d"].includes(event.key)
    )
      return;
    event.preventDefault();
    keys.current.add(event.key);
  };
  const step = (distance: number) => {
    world.current.x = clamp(world.current.x + distance);
    painter.current();
    stage.current?.focus({ preventScroll: true });
  };
  return (
    <section
      className="inspiration-game"
      data-phase={phase}
      aria-label="接住灵感"
    >
      <header className="inspiration-heading">
        <span>
          <Sparkles size={14} /> 接住灵感
        </span>
        <button className="inspiration-back" onClick={onClose}>
          <ArrowLeft size={14} /> 回到对话 <kbd>Esc</kbd>
        </button>
      </header>
      <div className="inspiration-scoreboard">
        <span>
          <Star size={14} /> 星光{" "}
          <output aria-label="已接住的星光">{hud.score}</output>
        </span>
        <span className="inspiration-time" aria-label="剩余时间">
          {hud.seconds}
          <small>秒</small>
        </span>
        <span className="inspiration-best">最佳 {best}</span>
      </div>
      <div
        ref={stage}
        className="inspiration-stage"
        role="group"
        tabIndex={0}
        aria-label="灵感星光游戏区域"
        aria-describedby={instructions}
        onPointerMove={move}
        onPointerDown={(event) => {
          if (phase !== "playing" || !event.isPrimary || event.button !== 0)
            return;
          event.currentTarget.focus({ preventScroll: true });
          event.currentTarget.setPointerCapture(event.pointerId);
          move(event);
        }}
        onKeyDown={keyDown}
        onKeyUp={(event) => keys.current.delete(event.key)}
        onBlur={() => keys.current.clear()}
      >
        <div className="inspiration-constellation" aria-hidden="true">
          <i />
          <i />
          <i />
          <i />
          <i />
        </div>
        <div
          className="inspiration-scene"
          aria-hidden="true"
          hidden={phase === "ready" || phase === "finished"}
        >
          {LIGHT_SLOTS.map((i) => (
            <span className="inspiration-light" key={i} hidden>
              <Star size={22} />
            </span>
          ))}
          {BURST_SLOTS.map((i) => (
            <span className="inspiration-burst" key={i} hidden>
              +1
              <Sparkles size={20} />
            </span>
          ))}
          <div className={`inspiration-catcher ${hud.happy ? "is-happy" : ""}`}>
            <span className="inspiration-catch-ring" />
            <BloubAvatar
              mood={hud.happy ? "success" : "listening"}
              size={64}
              decorative
              suspended={phase !== "playing" || !active}
            />
          </div>
        </div>
        {phase !== "playing" && (
          <div className="inspiration-overlay">
            {phase !== "paused" && (
              <BloubAvatar
                mood={phase === "finished" ? "success" : "idle"}
                size={112}
                decorative
                followPointer
                suspended={!active || rankingOpen}
              />
            )}
            <h3>
              {phase === "ready"
                ? "接住一点好灵感"
                : phase === "paused"
                  ? "灵感在等你"
                  : hud.score >= 8
                    ? "今天的灵感，满格！"
                    : "一点星光，一点好心情"}
            </h3>
            <p>
              {phase === "ready"
                ? "给自己 15 秒，和知小汇玩一会儿。"
                : phase === "paused"
                  ? "休息一下，准备好再继续。"
                  : `你和知小汇接住了 ${hud.score} 颗星光。`}
            </p>
            <button
              ref={startButton}
              className="inspiration-start"
              disabled={
                starting ||
                (phase === "finished" && (rankingLoading || !!rankingError))
              }
              onClick={() =>
                phase === "paused" ? setPhase("playing") : start()
              }
            >
              {phase === "finished" ? (
                <RotateCcw size={15} />
              ) : (
                <Play size={15} />
              )}
              {starting
                ? "正在准备…"
                : phase === "ready"
                  ? "开始小游戏"
                  : phase === "paused"
                    ? "继续小游戏"
                    : "再玩一次"}
            </button>
            {startError && (
              <p className="inspiration-start-error" role="alert">
                {startError}
              </p>
            )}
            {phase === "finished" && !guest && (
              <button
                className="inspiration-return"
                onClick={() => setRankingOpen(true)}
              >
                <Trophy size={14} />
                查看企业排行榜
              </button>
            )}
          </div>
        )}
      </div>
      <div className="inspiration-controls">
        <p id={instructions}>
          鼠标 / 手指左右移动，也可以用 <kbd>←</kbd>
          <kbd>→</kbd>
        </p>
        {phase === "playing" && (
          <button onClick={() => setPhase("paused")} aria-label="暂停小游戏">
            <Pause size={14} />
          </button>
        )}
      </div>
      <div
        className="inspiration-direction-buttons"
        inert={phase !== "playing"}
        style={{ visibility: phase === "playing" ? "visible" : "hidden" }}
      >
        <button onClick={() => step(-0.12)} aria-label="向左移动">
          <ArrowLeft size={16} />
        </button>
        <span>让星光落到知小汇头上</span>
        <button onClick={() => step(0.12)} aria-label="向右移动">
          <ArrowRight size={16} />
        </button>
      </div>
      <p className="inspiration-status" role="status">
        {phase === "finished"
          ? `游戏结束，共接住 ${hud.score} 颗星光。`
          : phase === "paused"
            ? "小游戏已暂停。"
            : ""}
      </p>
      {rankingOpen && active && !guest && (
        <InspirationLeaderboard
          standings={standings}
          score={hud.score}
          loading={rankingLoading}
          error={rankingError}
          starting={starting}
          startError={startError}
          onRetry={() => void saveScore()}
          onReplay={() => void start()}
          onReturn={onClose}
          onClose={() => setRankingOpen(false)}
        />
      )}
    </section>
  );
}

export function BotCompanion({
  mood,
  onPlay,
  suspended = false,
}: {
  mood: BotMood;
  onPlay: () => void;
  suspended?: boolean;
}) {
  return (
    <button
      className="bot-welcome-orb bot-companion"
      aria-label="和知小汇玩接住灵感小游戏"
      aria-describedby="bot-companion-hint"
      onClick={onPlay}
    >
      <span className="bot-orbit" aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
      <BloubAvatar
        mood={mood}
        size={112}
        followPointer
        decorative
        suspended={suspended}
      />
      <span id="bot-companion-hint" className="bot-companion-hint">
        点我，接住一点灵感 <Sparkles size={11} />
      </span>
    </button>
  );
}
