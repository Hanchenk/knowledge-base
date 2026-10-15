import { useCallback, useEffect, useRef, useState } from "react";
import { api, post } from "./api";

export type CloudStatus = {
  available: boolean;
  connected: boolean;
  state: "running" | "stopped" | "unavailable";
  idle_timeout_seconds: number;
  last_activity_at: number | null;
  expires_at: number | null;
  active_tasks: number;
  pending_tasks: number;
  persistent: boolean;
  error?: string;
};
export type CloudFile = {
  id: string;
  task_id: string;
  task_title: string;
  name: string;
  kind: string;
  size: number;
  created_at: number;
  url: string;
  download_url: string;
  preview_url: string | null;
  previewable: boolean;
  content_type: string;
};
export const cloudApi = {
  status: () => api<CloudStatus>("/api/bot/cloud"),
  connect: () => post<CloudStatus>("/api/bot/cloud/connect", {}),
  disconnect: () => post<CloudStatus>("/api/bot/cloud/disconnect", {}),
  heartbeat: () => post<CloudStatus>("/api/bot/cloud/heartbeat", {}),
  files: (offset = 0) =>
    api<{
      files: CloudFile[];
      has_more: boolean;
      offset: number;
      limit: number;
      next_offset: number | null;
    }>(`/api/bot/cloud/files?limit=100&offset=${offset}`),
};

export function useCloudComputer() {
  const [status, setStatus] = useState<CloudStatus>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const current = useRef(status);
  const lastHeartbeat = useRef(0);
  const heartbeatPending = useRef(false);
  const mutationPending = useRef(false);
  const revision = useRef(0);
  current.current = status;
  const refresh = useCallback(async () => {
    const expected = revision.current;
    try {
      const value = await cloudApi.status();
      if (expected === revision.current) {
        setStatus(value);
        setError("");
      }
    } catch (reason) {
      if (expected === revision.current)
        setError(reason instanceof Error ? reason.message : String(reason));
    }
  }, []);
  useEffect(() => {
    void refresh();
    // Reading status never extends the lease. An open, idle tab can expire.
    const timer = window.setInterval(() => {
      if (!document.hidden) void refresh();
    }, 30000);
    return () => window.clearInterval(timer);
  }, [refresh]);
  const act = async (action: "connect" | "disconnect") => {
    if (mutationPending.current) return;
    mutationPending.current = true;
    revision.current += 1;
    setBusy(true);
    setError("");
    try {
      const value = await cloudApi[action]();
      setStatus(value);
      lastHeartbeat.current = Date.now();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      mutationPending.current = false;
      setBusy(false);
    }
  };
  const recordActivity = (event: { isTrusted: boolean }) => {
    if (
      !event.isTrusted ||
      !current.current?.connected ||
      mutationPending.current ||
      heartbeatPending.current ||
      Date.now() - lastHeartbeat.current < 60000
    )
      return;
    lastHeartbeat.current = Date.now();
    heartbeatPending.current = true;
    const expected = revision.current;
    void cloudApi
      .heartbeat()
      .then((value) => {
        if (expected === revision.current) setStatus(value);
      })
      .catch(() => {
        // The next read reports availability without keeping an idle lease alive.
      })
      .finally(() => {
        heartbeatPending.current = false;
      });
  };
  return { status, error, busy, refresh, act, recordActivity };
}
