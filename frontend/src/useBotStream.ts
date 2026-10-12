import { useEffect, useRef } from "react";
import type { Dispatch, SetStateAction } from "react";
import type { Detail } from "./bot-types";

export function useBotStream(
  selected: string,
  status: string | undefined,
  setDetail: Dispatch<SetStateAction<Detail | undefined>>,
) {
  const connected = useRef(false);
  useEffect(() => {
    if (!selected || !["queued", "running"].includes(status || "")) return;
    let source: EventSource | undefined;
    let live = true;
    const close = () => {
      source?.close();
      source = undefined;
      connected.current = false;
    };
    const connect = () => {
      close();
      if (document.hidden || !live) return;
      source = new EventSource(
        `/api/bot/tasks/${encodeURIComponent(selected)}/stream`,
      );
      source.onopen = () => {
        connected.current = true;
      };
      source.onerror = () => {
        connected.current = false;
      };
      source.addEventListener("snapshot", (event) => {
        if (!live) return;
        try {
          const detail = JSON.parse((event as MessageEvent).data) as Detail;
          if (detail.task.id === selected) setDetail(detail);
        } catch {
          /* Polling restores interrupted data. */
        }
      });
      source.addEventListener("output", (event) => {
        if (!live) return;
        try {
          const message = JSON.parse((event as MessageEvent).data) as {
            id: string;
            text: string;
            replace: boolean;
            status: string;
            created_at: number;
          };
          setDetail((detail) => {
            if (!detail || detail.task.id !== selected) return detail;
            const messages = [...(detail.messages || [])];
            const index = messages.findIndex((item) => item.id === message.id);
            const previous = index >= 0 ? messages[index] : undefined;
            const next = {
              id: message.id,
              content: message.replace
                ? message.text
                : (previous?.content || "") + message.text,
              status: message.status,
              created_at: message.created_at,
            };
            if (index >= 0) messages[index] = next;
            else messages.push(next);
            return { ...detail, messages: messages.slice(-200) };
          });
        } catch {
          /* Keep the last complete update. */
        }
      });
      source.addEventListener("end", close);
      source.addEventListener("unavailable", () => {
        close();
        if (live)
          setDetail((detail) =>
            detail?.task.id === selected
              ? {
                  ...detail,
                  evidence_available: false,
                  messages: [],
                  artifacts: [],
                  actions: [],
                  events: [],
                  task: {
                    ...detail.task,
                    result: "任务或资料权限已变化，请重新加载。",
                    citations: [],
                    web_sources: [],
                    plan: [],
                  },
                }
              : detail,
          );
      });
    };
    connect();
    document.addEventListener("visibilitychange", connect);
    return () => {
      live = false;
      close();
      document.removeEventListener("visibilitychange", connect);
    };
  }, [selected, status, setDetail]);
  return connected;
}
