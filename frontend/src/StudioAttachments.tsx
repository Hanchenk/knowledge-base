import { useCallback, useEffect, useRef, useState } from "react";
import { FileText, ImagePlus, LoaderCircle, RotateCcw, X } from "lucide-react";
import { bytes } from "./api";
import { randomUuid } from "./ids";
import {
  removeStudioAttachment,
  studioAttachmentUrl,
  uploadStudioAttachment,
  type StudioAttachment,
  type StudioUploadPolicy,
} from "./studio-api";

export type AttachmentDraft = {
  key: string;
  file?: File;
  preview?: string;
  attachment?: StudioAttachment;
  status: "uploading" | "ready" | "failed";
  error?: string;
};

export function useStudioAttachments(policy?: StudioUploadPolicy) {
  const [items, setItems] = useState<AttachmentDraft[]>([]);
  const [error, setError] = useState("");
  const controllers = useRef(new Map<string, AbortController>());
  const previews = useRef(new Set<string>());
  const drafts = useRef(items);
  drafts.current = items;
  useEffect(
    () => () => {
      controllers.current.forEach((controller) => controller.abort());
      previews.current.forEach((url) => URL.revokeObjectURL(url));
      drafts.current.forEach((item) => {
        if (item.attachment)
          void removeStudioAttachment(item.attachment.id).catch(
            () => undefined,
          );
      });
    },
    [],
  );
  const upload = useCallback(async (item: AttachmentDraft) => {
    if (!item.file) return;
    const controller = new AbortController();
    controllers.current.set(item.key, controller);
    setItems((current) =>
      current.map((row) =>
        row.key === item.key
          ? { ...row, status: "uploading", error: undefined }
          : row,
      ),
    );
    try {
      const attachment = await uploadStudioAttachment(
        item.file,
        controller.signal,
      );
      if (controller.signal.aborted) {
        void removeStudioAttachment(attachment.id).catch(() => undefined);
        return;
      }
      setItems((current) =>
        current.map((row) =>
          row.key === item.key ? { ...row, attachment, status: "ready" } : row,
        ),
      );
    } catch (cause) {
      if (!controller.signal.aborted)
        setItems((current) =>
          current.map((row) =>
            row.key === item.key
              ? { ...row, status: "failed", error: (cause as Error).message }
              : row,
          ),
        );
    } finally {
      controllers.current.delete(item.key);
    }
  }, []);
  const addFiles = (files: File[]) => {
    if (!policy?.enabled) return;
    setError("");
    const incoming: AttachmentDraft[] = [];
    const problems: string[] = [];
    for (const file of files) {
      if (drafts.current.length + incoming.length >= policy.max_files) {
        problems.push(`每次最多添加 ${policy.max_files} 个参考文件`);
        break;
      }
      const supported = policy.accept.some((type) =>
        type.startsWith(".")
          ? file.name.toLowerCase().endsWith(type)
          : type.endsWith("/*")
            ? file.type.startsWith(type.slice(0, -1))
            : type === file.type,
      );
      if (!supported) {
        problems.push(`${file.name}：暂不支持此格式`);
        continue;
      }
      const image = file.type.startsWith("image/");
      const text = /\.(txt|md|csv|json)$/i.test(file.name);
      const limit = text
        ? Math.min(policy.max_size_bytes, 2 * 1024 * 1024)
        : policy.max_size_bytes;
      if (!file.size || file.size > limit) {
        problems.push(`${file.name}：文件需为 1 B–${bytes(limit)}`);
        continue;
      }
      if (
        [...drafts.current, ...incoming].some(
          (item) =>
            item.file?.name === file.name &&
            item.file.size === file.size &&
            item.file.lastModified === file.lastModified,
        )
      )
        continue;
      const preview = image ? URL.createObjectURL(file) : undefined;
      if (preview) previews.current.add(preview);
      incoming.push({ key: randomUuid(), file, preview, status: "uploading" });
    }
    const next = [...drafts.current, ...incoming];
    drafts.current = next;
    setItems(next);
    if (problems.length) setError(problems.join("；"));
    incoming.forEach((item) => void upload(item));
  };
  const addReference = (attachment: StudioAttachment) => {
    if (drafts.current.length >= (policy?.max_files || 8)) {
      setError(`每次最多添加 ${policy?.max_files || 8} 个参考文件`);
      void removeStudioAttachment(attachment.id).catch(() => undefined);
      return;
    }
    if (drafts.current.some((item) => item.attachment?.id === attachment.id))
      return;
    const next = [
      ...drafts.current,
      { key: randomUuid(), attachment, status: "ready" as const },
    ];
    drafts.current = next;
    setItems(next);
  };
  const remove = (key: string) => {
    const item = drafts.current.find((row) => row.key === key);
    controllers.current.get(key)?.abort();
    if (item?.preview) {
      URL.revokeObjectURL(item.preview);
      previews.current.delete(item.preview);
    }
    if (item?.attachment)
      void removeStudioAttachment(item.attachment.id).catch((cause) =>
        setError((cause as Error).message),
      );
    drafts.current = drafts.current.filter((row) => row.key !== key);
    setItems(drafts.current);
  };
  const clear = (discard = false) => {
    drafts.current.forEach((item) => {
      controllers.current.get(item.key)?.abort();
      if (item.preview) {
        URL.revokeObjectURL(item.preview);
        previews.current.delete(item.preview);
      }
      if (discard && item.attachment)
        void removeStudioAttachment(item.attachment.id).catch(() => undefined);
    });
    drafts.current = [];
    setItems([]);
    setError("");
  };
  return {
    items,
    error,
    addFiles,
    addReference,
    remove,
    clear,
    retry: upload,
    uploading: items.some((item) => item.status === "uploading"),
    failed: items.some((item) => item.status === "failed"),
    ready: items.flatMap((item) => (item.attachment ? [item.attachment] : [])),
  };
}

export function StudioAttachments({
  items,
  disabled,
  onRemove,
  onRetry,
}: {
  items: AttachmentDraft[];
  disabled: boolean;
  onRemove: (key: string) => void;
  onRetry: (item: AttachmentDraft) => void;
}) {
  if (!items.length) return null;
  return (
    <div className="studio-attachments" aria-label="参考文件">
      {items.map((item) => {
        const name = item.attachment?.name || item.file?.name || "参考文件";
        const image =
          item.attachment?.kind === "image" ||
          item.file?.type.startsWith("image/");
        const src =
          item.preview ||
          (item.attachment ? studioAttachmentUrl(item.attachment.id) : "");
        return (
          <div
            className={`studio-attachment ${item.status}`}
            key={item.key}
            aria-label={`${name} · ${item.status === "uploading" ? "上传中" : item.status === "failed" ? "上传失败" : "已就绪"}`}
          >
            <span className="studio-attachment-thumbnail">
              {image && src ? (
                <img src={src} alt={name} />
              ) : image ? (
                <ImagePlus size={21} />
              ) : (
                <FileText size={21} />
              )}
            </span>
            <span className="studio-attachment-info">
              <strong title={name}>{name}</strong>
              <small>
                {item.status === "uploading" ? (
                  <>
                    <LoaderCircle size={11} className="spin" /> 上传中…
                  </>
                ) : item.status === "failed" ? (
                  <span title={item.error}>{item.error || "上传失败"}</span>
                ) : (
                  `${image ? "参考图" : "参考资料"} · ${bytes(item.attachment?.size || item.file?.size || 0)}`
                )}
              </small>
            </span>
            {item.status === "failed" && (
              <button
                type="button"
                className="icon-button"
                aria-label={`重试上传 ${name}`}
                disabled={disabled}
                onClick={() => onRetry(item)}
              >
                <RotateCcw size={13} />
              </button>
            )}
            <button
              type="button"
              className="icon-button"
              aria-label={`移除参考文件 ${name}`}
              disabled={disabled}
              onClick={() => onRemove(item.key)}
            >
              <X size={13} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
