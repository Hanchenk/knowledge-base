import { useEffect, useState } from "react";
import { Download, FileText, Loader2, RefreshCw } from "lucide-react";
import { ArtifactMarkdown } from "./ArtifactMarkdown";
import { bytes } from "./api";
import {
  artifactPreviewKind,
  artifactRenderUrl,
  artifactUrl,
  type BotArtifact,
} from "./artifact-preview";
import "./bot-artifact-preview.css";

type Preview = { id: string; text?: string; url?: string; error?: string };

export function BotArtifactPreview({
  file,
  artifacts,
  onArtifact,
}: {
  file: BotArtifact;
  artifacts: BotArtifact[];
  onArtifact: (id: string) => void;
}) {
  const kind = artifactPreviewKind(file.name);
  const [preview, setPreview] = useState<Preview>();
  const [reload, setReload] = useState(0);
  const [source, setSource] = useState(false);
  useEffect(() => {
    setSource(false);
  }, [file.id]);
  useEffect(() => {
    if (kind === "file") return;
    const controller = new AbortController();
    let objectUrl: string | undefined;
    setPreview(undefined);
    void (async () => {
      const response = await fetch(artifactUrl(file.id, true), {
        credentials: "same-origin",
        cache: "no-store",
        signal: controller.signal,
      });
      if (!response.ok) {
        if (response.status === 401)
          window.dispatchEvent(new Event("atlas:unauthorized"));
        let message = `预览失败 (${response.status})`;
        try {
          const result = await response.json();
          if (typeof result.error === "string") message = result.error;
        } catch {
          /* Preserve the HTTP failure for non-JSON responses. */
        }
        throw new Error(message);
      }
      const contentType = response.headers.get("content-type") || "";
      if (kind === "image" || kind === "pdf") {
        if (
          !(kind === "image"
            ? contentType.startsWith("image/")
            : contentType.startsWith("application/pdf"))
        )
          throw new Error("文件内容与预览格式不一致");
        const blob = await response.blob();
        if (kind === "pdf" && (await blob.slice(0, 5).text()) !== "%PDF-")
          throw new Error("文件内容与预览格式不一致");
        if (controller.signal.aborted) return;
        objectUrl = URL.createObjectURL(blob);
        setPreview({ id: file.id, url: objectUrl });
      } else {
        if (!contentType.startsWith("text/plain"))
          throw new Error("文件内容与预览格式不一致");
        const text = await response.text();
        if (!controller.signal.aborted) setPreview({ id: file.id, text });
      }
    })().catch((error: Error) => {
      if (!controller.signal.aborted)
        setPreview({ id: file.id, error: error.message });
    });
    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [file.id, file.size, kind, reload]);
  const current = preview?.id === file.id ? preview : undefined;
  return (
    <section
      className="bot-artifact-preview"
      aria-label={`文件预览 ${file.name}`}
    >
      <header>
        <strong>{file.name}</strong>
        <div>
          {kind !== "file" && current && !current.error && (
            <button
              type="button"
              aria-label="刷新预览"
              title="刷新预览"
              onClick={() => setReload((value) => value + 1)}
            >
              <RefreshCw size={14} />
            </button>
          )}
          {["html", "markdown"].includes(kind) && (
            <button
              type="button"
              aria-pressed={source}
              onClick={() => setSource((value) => !value)}
            >
              {source ? "预览" : "源码"}
            </button>
          )}
          <a
            href={artifactUrl(file.id)}
            download={file.name}
            aria-label={`下载 ${file.name}`}
          >
            <Download size={14} />
            下载
          </a>
        </div>
      </header>
      {kind === "file" ? (
        <p className="bot-artifact-preview-state">
          此格式暂不支持在线预览，可下载后查看。
        </p>
      ) : current?.error ? (
        <div className="bot-artifact-preview-state" role="alert">
          <p>{current.error}</p>
          <button
            type="button"
            className="button"
            onClick={() => setReload((value) => value + 1)}
          >
            <RefreshCw size={14} />
            重新加载
          </button>
        </div>
      ) : !current ? (
        <p className="bot-artifact-preview-state" role="status">
          <Loader2 size={16} className="spin" />
          正在加载预览…
        </p>
      ) : kind === "html" && !source ? (
        <iframe
          key={`${file.id}:${file.size}:${reload}`}
          title={`预览 ${file.name}`}
          className="bot-artifact-html"
          sandbox="allow-scripts"
          referrerPolicy="no-referrer"
          src={artifactRenderUrl(file.id, `${file.size}:${reload}`)}
        />
      ) : kind === "markdown" && !source ? (
        <div className="bot-artifact-text markdown">
          <ArtifactMarkdown artifacts={artifacts} onArtifact={onArtifact}>
            {current.text || ""}
          </ArtifactMarkdown>
        </div>
      ) : kind === "image" ? (
        <div className="bot-artifact-image">
          <img src={current.url} alt={file.name} />
        </div>
      ) : kind === "pdf" ? (
        <iframe
          title={`预览 ${file.name}`}
          className="bot-artifact-pdf"
          src={current.url}
          referrerPolicy="no-referrer"
        />
      ) : (
        <pre className="bot-artifact-text">
          <code>{current.text}</code>
        </pre>
      )}
    </section>
  );
}

export function BotArtifactFiles({
  artifacts,
  selectedArtifactId,
  previewArtifact,
  previewArtifacts,
  onArtifact,
}: {
  artifacts: BotArtifact[];
  selectedArtifactId?: string;
  previewArtifact?: BotArtifact;
  previewArtifacts?: BotArtifact[];
  onArtifact: (id: string) => void;
}) {
  const selected =
    previewArtifact || artifacts.find((file) => file.id === selectedArtifactId);
  return (
    <>
      <div className="bot-artifact-list">
        {artifacts.map((file) => (
          <div
            className={`bot-artifact-card ${selected?.id === file.id ? "is-selected" : ""}`}
            key={file.id}
          >
            <button
              type="button"
              onClick={() => onArtifact(file.id)}
              aria-label={`预览 ${file.name}`}
              aria-pressed={selected?.id === file.id}
            >
              <FileText size={20} />
              <span>
                <strong>{file.name}</strong>
                <small>
                  {bytes(file.size)} ·{" "}
                  {artifactPreviewKind(file.name) === "file"
                    ? "文件"
                    : "可在线预览"}
                </small>
              </span>
            </button>
            <a
              href={artifactUrl(file.id)}
              download={file.name}
              aria-label={`下载 ${file.name}`}
              title="下载文件"
            >
              <Download size={16} />
            </a>
          </div>
        ))}
      </div>
      {selected ? (
        <BotArtifactPreview
          file={selected}
          artifacts={previewArtifacts || artifacts}
          onArtifact={onArtifact}
        />
      ) : (
        <p className="bot-artifact-hint">选择文件，在线查看或下载。</p>
      )}
    </>
  );
}
