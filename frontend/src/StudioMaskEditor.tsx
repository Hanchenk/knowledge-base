import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Eraser, LoaderCircle, Undo2, X } from "lucide-react";

type Point = { x: number; y: number };
type Stroke = { points: Point[]; width: number };

export function StudioMaskEditor({
  src,
  onApply,
  onClose,
}: {
  src: string;
  onApply: (file: File) => Promise<void>;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [dimensions, setDimensions] = useState<{
    width: number;
    height: number;
  }>();
  const [strokes, setStrokes] = useState<Stroke[]>([]);
  const [brush, setBrush] = useState(5);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const active = useRef<Stroke | undefined>(undefined);
  const strokeHistory = useRef(strokes);
  strokeHistory.current = strokes;
  const draw = (rows: Stroke[]) => {
    const target = canvas.current;
    const context = target?.getContext("2d");
    if (!target || !context) return;
    context.clearRect(0, 0, target.width, target.height);
    context.strokeStyle = "rgba(245, 75, 108, 0.58)";
    context.fillStyle = "rgba(245, 75, 108, 0.58)";
    context.lineCap = "round";
    context.lineJoin = "round";
    for (const stroke of rows) {
      context.lineWidth = stroke.width;
      context.beginPath();
      context.moveTo(stroke.points[0].x, stroke.points[0].y);
      stroke.points.forEach((point) => context.lineTo(point.x, point.y));
      context.stroke();
      if (stroke.points.length === 1) {
        context.beginPath();
        context.arc(
          stroke.points[0].x,
          stroke.points[0].y,
          stroke.width / 2,
          0,
          Math.PI * 2,
        );
        context.fill();
      }
    }
  };
  useEffect(() => draw(strokes), [strokes, dimensions]);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    dialog.current?.querySelector<HTMLButtonElement>("button")?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !saving) {
        event.preventDefault();
        onClose();
      }
      if (event.key !== "Tab") return;
      const focusable = Array.from(
        dialog.current?.querySelectorAll<HTMLElement>(
          "button:not(:disabled),input:not(:disabled)",
        ) || [],
      );
      if (!focusable.length) return;
      if (event.shiftKey && document.activeElement === focusable[0]) {
        event.preventDefault();
        focusable.at(-1)?.focus();
      } else if (
        !event.shiftKey &&
        document.activeElement === focusable.at(-1)
      ) {
        event.preventDefault();
        focusable[0]?.focus();
      }
    };
    document.addEventListener("keydown", keydown);
    return () => {
      document.removeEventListener("keydown", keydown);
      document.body.style.overflow = previousOverflow;
      previous?.focus();
    };
  }, [onClose, saving]);
  const point = (event: React.PointerEvent<HTMLCanvasElement>): Point => {
    const bounds = event.currentTarget.getBoundingClientRect();
    return {
      x:
        ((event.clientX - bounds.left) / bounds.width) *
        event.currentTarget.width,
      y:
        ((event.clientY - bounds.top) / bounds.height) *
        event.currentTarget.height,
    };
  };
  const apply = async () => {
    if (!dimensions || !strokes.length || saving) return;
    setSaving(true);
    setError("");
    try {
      const mask = document.createElement("canvas");
      mask.width = dimensions.width;
      mask.height = dimensions.height;
      const context = mask.getContext("2d");
      if (!context) throw new Error("浏览器无法创建标记图片");
      context.fillStyle = "#fff";
      context.fillRect(0, 0, mask.width, mask.height);
      context.globalCompositeOperation = "destination-out";
      context.lineCap = "round";
      context.lineJoin = "round";
      for (const stroke of strokes) {
        context.lineWidth = stroke.width;
        context.beginPath();
        context.moveTo(stroke.points[0].x, stroke.points[0].y);
        stroke.points.forEach((p) => context.lineTo(p.x, p.y));
        context.stroke();
        context.beginPath();
        context.arc(
          stroke.points[0].x,
          stroke.points[0].y,
          stroke.width / 2,
          0,
          Math.PI * 2,
        );
        context.fill();
      }
      const blob = await new Promise<Blob>((resolve, reject) =>
        mask.toBlob(
          (value) =>
            value ? resolve(value) : reject(new Error("标记图片导出失败")),
          "image/png",
        ),
      );
      await onApply(new File([blob], "edit-mask.png", { type: "image/png" }));
      onClose();
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setSaving(false);
    }
  };
  return createPortal(
    <div className="studio-mask-backdrop">
      <div
        className="studio-mask-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="studio-mask-title"
        ref={dialog}
      >
        <div className="studio-mask-heading">
          <div>
            <strong id="studio-mask-title">标记要修改的区域</strong>
            <p>涂抹的红色区域会交给模型编辑，其余区域尽量保留。</p>
          </div>
          <button
            type="button"
            className="icon-button"
            aria-label="关闭区域标记"
            disabled={saving}
            onClick={onClose}
          >
            <X size={18} />
          </button>
        </div>
        <div className="studio-mask-stage">
          <div
            className="studio-mask-canvas"
            style={
              dimensions
                ? {
                    aspectRatio: `${dimensions.width} / ${dimensions.height}`,
                    width: `min(650px, calc(55dvh * ${dimensions.width / dimensions.height}))`,
                  }
                : undefined
            }
          >
            <img
              src={src}
              alt="待标记的参考图"
              onLoad={(event) => {
                const image = event.currentTarget;
                if (image.naturalWidth * image.naturalHeight > 25_000_000) {
                  setError("图片像素过大，请先缩小到 2500 万像素以内再标记");
                  return;
                }
                setDimensions({
                  width: image.naturalWidth,
                  height: image.naturalHeight,
                });
              }}
              onError={() => setError("参考图加载失败，请重新上传后重试")}
            />
            {dimensions && (
              <canvas
                ref={canvas}
                width={dimensions.width}
                height={dimensions.height}
                aria-label="涂抹编辑区域画布"
                onPointerDown={(event) => {
                  if (saving || strokes.length >= 120) return;
                  event.currentTarget.setPointerCapture(event.pointerId);
                  active.current = {
                    points: [point(event)],
                    width:
                      (Math.min(dimensions.width, dimensions.height) * brush) /
                      100,
                  };
                  draw([...strokeHistory.current, active.current]);
                }}
                onPointerMove={(event) => {
                  if (!active.current) return;
                  active.current.points.push(point(event));
                  draw([...strokeHistory.current, active.current]);
                }}
                onPointerUp={() => {
                  const stroke = active.current;
                  if (stroke) setStrokes((rows) => [...rows, stroke]);
                  active.current = undefined;
                }}
                onPointerCancel={() => {
                  active.current = undefined;
                  draw(strokeHistory.current);
                }}
              />
            )}
          </div>
        </div>
        <div className="studio-mask-toolbar">
          <label>
            <Eraser size={15} /> 画笔大小
            <input
              aria-label="标记画笔大小"
              type="range"
              min={1}
              max={20}
              value={brush}
              disabled={saving}
              onChange={(event) => setBrush(Number(event.target.value))}
            />
          </label>
          <button
            type="button"
            className="button"
            disabled={saving || !strokes.length}
            onClick={() => setStrokes((rows) => rows.slice(0, -1))}
          >
            <Undo2 size={14} /> 撤销
          </button>
          <button
            type="button"
            className="text-button"
            disabled={saving || !strokes.length}
            onClick={() => setStrokes([])}
          >
            清空
          </button>
          <button
            type="button"
            className="button primary"
            disabled={saving || !strokes.length}
            onClick={() => void apply()}
          >
            {saving && <LoaderCircle size={14} className="spin" />} 保存标记
          </button>
        </div>
        {error && (
          <p className="studio-error" role="alert">
            {error}
          </p>
        )}
      </div>
    </div>,
    document.body,
  );
}
