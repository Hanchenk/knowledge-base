import { useEffect, useRef } from "react";
import type { ReactNode } from "react";
import {
  CheckCircle2,
  FileText,
  Image,
  LoaderCircle,
  X,
  AlertCircle,
} from "lucide-react";
export function Modal({
  title,
  children,
  onClose,
  wide = false,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, []);
  return (
    <dialog
      className={`modal ${wide ? "wide" : ""}`}
      ref={ref}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      aria-label={title}
    >
      <div className="modal-head">
        <h2>{title}</h2>
        <button className="icon-button" onClick={onClose} aria-label="关闭">
          <X size={20} />
        </button>
      </div>
      <div className="modal-body">{children}</div>
    </dialog>
  );
}
export function Empty({
  title,
  text,
  children,
}: {
  title: string;
  text?: string;
  children?: ReactNode;
}) {
  return (
    <div className="empty">
      <div className="empty-icon">
        <FileText size={28} />
      </div>
      <h3>{title}</h3>
      {text && <p>{text}</p>}
      {children}
    </div>
  );
}
export function Status({ value }: { value: string }) {
  const labels: Record<string, string> = {
    ready: "已索引",
    queued: "等待索引",
    processing: "索引中",
    failed: "索引失败",
    done: "已完成",
    superseded: "已被替代",
  };
  return (
    <span className={`status ${value}`}>
      {["ready", "done"].includes(value) ? (
        <CheckCircle2 size={13} />
      ) : ["queued", "processing"].includes(value) ? (
        <LoaderCircle
          size={13}
          className={value === "processing" ? "spin" : ""}
        />
      ) : value === "failed" ? (
        <AlertCircle size={13} />
      ) : null}
      {labels[value] || value}
    </span>
  );
}
export function FileIcon({ mime, size = 20 }: { mime: string; size?: number }) {
  return (
    <div
      className={`file-icon ${mime.startsWith("image/") ? "image" : mime.includes("pdf") ? "pdf" : mime.includes("sheet") ? "sheet" : ""}`}
    >
      {mime.startsWith("image/") ? (
        <Image size={size} />
      ) : (
        <FileText size={size} />
      )}
    </div>
  );
}
export function Submit({
  busy,
  children,
}: {
  busy: boolean;
  children: ReactNode;
}) {
  return (
    <button className="button primary" type="submit" disabled={busy}>
      {busy && <LoaderCircle size={16} className="spin" />}
      {children}
    </button>
  );
}
