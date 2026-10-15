import { api, post } from "./api";

export type FeishuStatus = {
  available: boolean;
  connected: boolean;
  connector_id?: string;
  needs_reconnect: boolean;
  message?: string;
};

export type FeishuDraft = {
  version: 1;
  userId: string;
  createdAt: number;
  taskId: string;
  prompt: string;
  allowWeb: boolean;
  allowCode: boolean;
  memoryEnabled: boolean;
  docIds: string[];
  skillIds: string[];
  connectorIds: string[];
  pluginIds: string[];
  knowledgeAssetIds: string[];
  deviceId: string;
};

const draftKey = (userId: string) => `zhihui.bot.feishu-draft.${userId}`;
const maxDraftAge = 10 * 60 * 1000;
const listLimits = {
  docIds: 10,
  skillIds: 5,
  connectorIds: 10,
  pluginIds: 20,
  knowledgeAssetIds: 10,
} as const;

export const feishuApi = {
  status: () => api<FeishuStatus>("/api/bot/connectors/feishu/status"),
  authorize: () =>
    post<{ authorization_url: string }>(
      "/api/bot/connectors/feishu/authorize",
      {},
    ),
};

export function officialFeishuAuthorizationUrl(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("飞书授权地址未通过校验，请重试连接。");
  }
  if (
    url.protocol !== "https:" ||
    url.hostname !== "accounts.feishu.cn" ||
    url.pathname !== "/oauth/v2/mcp/authorize" ||
    url.port ||
    url.username ||
    url.password ||
    url.hash
  ) {
    throw new Error("飞书授权地址未通过校验，请重试连接。");
  }
  return url.href;
}

export function saveFeishuDraft(draft: FeishuDraft) {
  try {
    const serialized = JSON.stringify(draft);
    sessionStorage.setItem(draftKey(draft.userId), serialized);
    if (sessionStorage.getItem(draftKey(draft.userId)) !== serialized)
      throw new Error("Draft storage failed");
  } catch {
    throw new Error(
      "浏览器无法暂存当前输入，尚未跳转飞书。请允许此网站使用会话存储后重试；当前输入仍在页面中。",
    );
  }
}

export function clearFeishuDraft(userId: string) {
  try {
    sessionStorage.removeItem(draftKey(userId));
  } catch {
    /* The stored draft is ignored after its short expiry; no credentials. */
  }
}

export function readFeishuReturn(userId: string): {
  result: "connected" | "cancelled" | "error" | null;
  draft?: FeishuDraft;
  draftError?: string;
} {
  const result = new URLSearchParams(location.search).get("feishu");
  if (!result || !["connected", "cancelled", "error"].includes(result))
    return { result: null };
  const outcome = result as "connected" | "cancelled" | "error";
  try {
    const raw = sessionStorage.getItem(draftKey(userId));
    if (!raw) return { result: outcome };
    if (raw.length > 64000) throw new Error("Draft is too large");
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object") throw new Error("Invalid draft");
    const draft = value as FeishuDraft;
    if (
      draft.version !== 1 ||
      draft.userId !== userId ||
      !Number.isFinite(draft.createdAt) ||
      Date.now() - draft.createdAt > maxDraftAge ||
      draft.createdAt > Date.now() + 5000 ||
      typeof draft.taskId !== "string" ||
      draft.taskId.length > 200 ||
      typeof draft.prompt !== "string" ||
      draft.prompt.length > 6000 ||
      typeof draft.deviceId !== "string" ||
      draft.deviceId.length > 200 ||
      [draft.allowWeb, draft.allowCode, draft.memoryEnabled].some(
        (v) => typeof v !== "boolean",
      ) ||
      (Object.keys(listLimits) as (keyof typeof listLimits)[]).some(
        (key) =>
          !Array.isArray(draft[key]) ||
          draft[key].length > listLimits[key] ||
          new Set(draft[key]).size !== draft[key].length ||
          draft[key].some((v) => typeof v !== "string" || !v || v.length > 512),
      )
    )
      throw new Error("Invalid or expired draft");
    return { result: outcome, draft };
  } catch {
    return {
      result: outcome,
      draftError: "授权前的输入暂存已过期或无法读取，请核对当前任务后继续。",
    };
  }
}
