import { useEffect, useRef, useState } from "react";
import { api, MAX_UPLOAD_BYTES, MAX_UPLOAD_MB } from "./api";
import { randomUuid } from "./ids";
import type { Document } from "./types";
import type { Feedback } from "./App";

export const QUESTION_FILE_ACCEPT =
  ".pdf,.docx,.xlsx,.pptx,.md,.txt,.csv,.png,.jpg,.jpeg,.webp";

export type QuestionAttachment = {
  key: string;
  name: string;
  size: number;
  documentId?: string;
  spaceId: string;
  status: string;
  error?: string;
};

export function useQuestionAttachments(feedback: Feedback) {
  const [items, setItems] = useState<QuestionAttachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const [tick, setTick] = useState(0);
  const uploadingRef = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    const pending = items.filter(
      (item) =>
        item.documentId && ["queued", "processing"].includes(item.status),
    );
    if (!pending.length) return;
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      const results = await Promise.allSettled(
        pending.map(async (item) => {
          const document = await api<Pick<Document, "status" | "error">>(
            `/api/documents/${item.documentId}/status`,
            { signal: controller.signal },
          );
          return { key: item.key, document };
        }),
      );
      if (controller.signal.aborted) return;
      setItems((current) =>
        current.map((item) => {
          const index = pending.findIndex((p) => p.key === item.key);
          if (index < 0) return item;
          const result = results[index];
          return result.status === "fulfilled"
            ? {
                ...item,
                status: result.value.document.status,
                error: result.value.document.error || undefined,
              }
            : {
                ...item,
                status: "check_failed",
                error: (result.reason as Error).message,
              };
        }),
      );
    }, 1500);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [items, tick]);

  const add = async (files: File[], spaceId: string) => {
    if (uploadingRef.current || !files.length) return;
    if (!spaceId) {
      feedback("请选择可创建且可查看的知识空间", true);
      return;
    }
    if (items.length + files.length > 10) {
      feedback("每次提问最多添加 10 个附件", true);
      return;
    }
    if (files.some((file) => file.size > MAX_UPLOAD_BYTES)) {
      feedback(`单个文件不能超过 ${MAX_UPLOAD_MB} MB`, true);
      return;
    }
    if (
      files.some(
        (file) =>
          !file.size ||
          !QUESTION_FILE_ACCEPT.split(",").some((ext) =>
            file.name.toLowerCase().endsWith(ext),
          ),
      )
    ) {
      feedback("请选择非空的 PDF、DOCX、XLSX、PPTX、文本或图片文件", true);
      return;
    }
    const added = files.map((file) => ({
      key: randomUuid(),
      name: file.name,
      size: file.size,
      spaceId,
      status: "uploading",
    }));
    uploadingRef.current = true;
    setUploading(true);
    setItems((current) => [...current, ...added]);
    try {
      for (let i = 0; i < files.length; i++) {
        if (!mounted.current) break;
        const body = new FormData();
        body.append("space_id", spaceId);
        body.append("file", files[i]);
        try {
          const document = await api<Document>("/api/documents/upload", {
            method: "POST",
            body,
          });
          if (mounted.current)
            setItems((current) =>
              current.map((item) =>
                item.key === added[i].key
                  ? {
                      ...item,
                      documentId: document.id,
                      status: document.status,
                    }
                  : item,
              ),
            );
        } catch (error) {
          if (mounted.current)
            setItems((current) =>
              current.map((item) =>
                item.key === added[i].key
                  ? {
                      ...item,
                      status: "failed",
                      error: (error as Error).message,
                    }
                  : item,
              ),
            );
        }
      }
    } finally {
      uploadingRef.current = false;
      if (mounted.current) setUploading(false);
    }
  };

  return {
    items,
    uploading,
    blocked: uploading || items.some((item) => item.status !== "ready"),
    add,
    clear: () => setItems([]),
    remove: (key: string) =>
      setItems((current) => current.filter((item) => item.key !== key)),
    recheck: (key: string) => {
      setItems((current) =>
        current.map((item) =>
          item.key === key
            ? { ...item, status: "queued", error: undefined }
            : item,
        ),
      );
      setTick((current) => current + 1);
    },
  };
}
