import { useCallback, useEffect, useState } from "react";
import { api, post } from "./api";

export type HarnessStatus = {
  available: boolean;
  installed_version: string | null;
  latest_version: string | null;
  update_available: boolean;
  engine: "deepseek-harness";
  registry: string;
  is_admin: boolean;
  features: { sdk: boolean; plugins: boolean; mcp: boolean; skills: boolean };
  error?: string;
  version_error?: string;
};

export type HarnessPlugin = {
  id: string;
  name: string;
  description: string;
  version: string;
  source: string;
  marketplace?: string;
  has_config?: boolean;
  config_rows?: { id: string; name: string }[];
  category: string;
  installed: boolean;
  enabled: boolean;
  homepage?: string;
  author?: string;
};

export type HarnessMarketplace = {
  id: string;
  name: string;
  source: string;
  builtin: boolean;
};

export type HarnessCatalog = {
  plugins: HarnessPlugin[];
  marketplaces: HarnessMarketplace[];
  error?: string;
};

export type HarnessConfigInfo = {
  has_config: boolean;
  rows: { id: string; name: string }[];
};

export const harnessApi = {
  status: () => api<HarnessStatus>("/api/bot/harness"),
  catalog: (query = "", marketplace = "", signal?: AbortSignal) => {
    const params = new URLSearchParams();
    if (query.trim()) params.set("q", query.trim());
    if (marketplace) params.set("marketplace", marketplace);
    return api<HarnessCatalog>(
      `/api/bot/plugins/catalog${params.size ? `?${params}` : ""}`,
      { signal },
    );
  },
  install: (source: string, marketplace?: string) =>
    post<HarnessPlugin>("/api/bot/plugins/install", {
      source: source.trim(),
      ...(marketplace ? { marketplace } : {}),
    }),
  enable: (id: string, enabled: boolean) =>
    post<HarnessPlugin>(`/api/bot/plugins/${encodeURIComponent(id)}/enable`, {
      enabled,
    }),
  uninstall: (id: string) =>
    api<{ ok: boolean }>(`/api/bot/plugins/${encodeURIComponent(id)}`, {
      method: "DELETE",
    }),
  addMarketplace: (source: string, name: string) =>
    post<HarnessMarketplace>("/api/bot/plugins/marketplaces", {
      source: source.trim(),
      ...(name.trim() ? { name: name.trim() } : {}),
    }),
  removeMarketplace: (id: string) =>
    api<{ ok: boolean }>(
      `/api/bot/plugins/marketplaces/${encodeURIComponent(id)}`,
      { method: "DELETE" },
    ),
  configInfo: (id: string) =>
    api<HarnessConfigInfo>(`/api/bot/plugins/${encodeURIComponent(id)}/config`),
  configure: (id: string, config: Record<string, object>) =>
    post<{ ok: boolean; has_config?: boolean }>(
      `/api/bot/plugins/${encodeURIComponent(id)}/config`,
      { config },
    ),
  update: () =>
    post<{
      ok: boolean;
      installed_version: string;
      latest_version: string;
      update_available: boolean;
      application: "next-task";
    }>("/api/bot/harness/update", {}),
};

export function useHarnessPlugins() {
  const [catalog, setCatalog] = useState<HarnessCatalog>();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const refresh = useCallback(async () => {
    try {
      setCatalog(await harnessApi.catalog());
      setError("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { catalog, error, loading, refresh };
}
