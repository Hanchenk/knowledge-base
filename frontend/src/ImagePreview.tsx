import { useEffect, useRef, useState } from "react";
import { Download, Expand, RotateCcw, X, ZoomIn, ZoomOut } from "lucide-react";

export function ImagePreview({
  id,
  prompt,
  extension,
  kind = "image",
  onClose,
}: {
  id: string;
  prompt: string;
  extension: string;
  kind?: "image" | "video";
  onClose: () => void;
}) {
  const label = kind === "image" ? "图片" : "视频";
  const dialog = useRef<HTMLDialogElement>(null);
  const canvas = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState({ width: 0, height: 0 });
  const [natural, setNatural] = useState({ width: 0, height: 0 });
  const [zoom, setZoom] = useState(1);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    const observer = new ResizeObserver(([entry]) =>
      setViewport({
        width: entry.contentRect.width,
        height: entry.contentRect.height,
      }),
    );
    if (canvas.current) observer.observe(canvas.current);
    return () => {
      observer.disconnect();
      element?.close();
    };
  }, []);
  const fit = natural.width
    ? Math.min(
        1,
        Math.max(1, viewport.width - 32) / natural.width,
        Math.max(1, viewport.height - 32) / natural.height,
      )
    : 1;
  const width = natural.width * fit * zoom,
    height = natural.height * fit * zoom;
  const resize = (next: number) => setZoom(Math.max(0.25, Math.min(16, next)));
  return (
    <dialog
      className="image-preview"
      ref={dialog}
      aria-label={`${label}预览`}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="image-preview-toolbar">
        <strong>{label}预览</strong>
        <div>
          {kind === "image" && (
            <>
              <button
                className="icon-button"
                aria-label="缩小图片"
                title="缩小"
                disabled={!natural.width || zoom <= 0.25}
                onClick={() => resize(zoom / 1.25)}
              >
                <ZoomOut aria-hidden="true" size={19} />
              </button>
              <span className="image-preview-scale">
                {Math.round(fit * zoom * 100)}%
              </span>
              <button
                className="icon-button"
                aria-label="放大图片"
                title="放大"
                disabled={!natural.width || zoom >= 16}
                onClick={() => resize(zoom * 1.25)}
              >
                <ZoomIn aria-hidden="true" size={19} />
              </button>
              <button
                className="button"
                disabled={!natural.width}
                onClick={() => setZoom(1)}
              >
                <RotateCcw aria-hidden="true" size={15} />
                适应窗口
              </button>
              <button
                className="button"
                disabled={!natural.width}
                onClick={() => setZoom(1 / fit)}
              >
                <Expand aria-hidden="true" size={15} />
                原始尺寸
              </button>
            </>
          )}
          <a
            className="button primary"
            href={`/api/studio/assets/${id}`}
            download={`creation-${id}.${extension}`}
          >
            <Download aria-hidden="true" size={15} />
            下载{label}
          </a>
          <button
            className="icon-button"
            aria-label={`关闭${label}预览`}
            title="关闭"
            onClick={onClose}
          >
            <X aria-hidden="true" size={22} />
          </button>
        </div>
      </div>
      <div className="image-preview-canvas" ref={canvas}>
        {failed ? (
          <p className="image-preview-error" role="alert">
            {label}无法加载，请关闭后重试。
          </p>
        ) : kind === "video" ? (
          <div className="image-preview-video-stage">
            <video
              src={`/api/studio/assets/${id}`}
              aria-label={prompt}
              controls
              playsInline
              preload="metadata"
              onError={() => setFailed(true)}
            />
          </div>
        ) : (
          <div
            className="image-preview-stage"
            style={{
              width: Math.max(viewport.width, width + 32),
              height: Math.max(viewport.height, height + 32),
            }}
          >
            <img
              src={`/api/studio/assets/${id}`}
              alt={prompt}
              draggable={false}
              onLoad={(event) => {
                const image = event.currentTarget;
                setNatural({
                  width: image.naturalWidth,
                  height: image.naturalHeight,
                });
              }}
              onError={() => setFailed(true)}
              style={{ width: width || undefined, height: height || undefined }}
            />
          </div>
        )}
      </div>
      <p className="image-preview-caption">{prompt}</p>
    </dialog>
  );
}
