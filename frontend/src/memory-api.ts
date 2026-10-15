import { api, post } from "./api";

export type MemoryKind = "preference" | "constraint" | "experience";
export type PersonalMemory = {
  id: string;
  content: string;
  kind: MemoryKind;
  status: "active" | "pending" | "deleted";
  source_task_id?: string | null;
  provider_status?: string | null;
  source_available?: boolean;
  created_at: number;
  updated_at: number;
};
export type MemorySettings = {
  enabled: boolean;
  capture: boolean;
  skill_capture: boolean;
};
export type MemoryLibrary = {
  items: PersonalMemory[];
  settings: MemorySettings;
  provider: { configured: boolean; status?: string; error?: string };
};
export type MemoryProvider = {
  core: { configured: boolean; available?: boolean };
  knowledge: { configured: boolean; available?: boolean };
};
export type SkillCandidate = {
  id: string;
  task_id: string;
  name: string;
  description: string;
  instructions: string;
  status: "pending" | "approved" | "rejected";
  skill_id?: string | null;
  review_note?: string | null;
  source_valid?: boolean;
  origin?: "manual" | "model" | "agent" | "memory_core";
  extraction_state?: "queued" | "ready" | "failed";
  extraction_error?: string | null;
  version: number;
  created_at: number;
  updated_at: number;
};
export type KnowledgeAsset = {
  id: string;
  kind: "wiki" | "code_graph";
  name: string;
  status: "queued" | "building" | "ready" | "failed" | "deleting" | "deleted";
  document_ids: string[];
  repository_url?: string | null;
  error?: string | null;
  metadata?: {
    page_count?: number;
    stats?: unknown;
    commit_hash?: string;
    version?: string | number;
  };
  created_at: number;
  updated_at: number;
};
export type KnowledgeResult = {
  asset_id: string;
  kind: KnowledgeAsset["kind"];
  result: unknown;
  sources?: { document_id: string; version: number; title: string }[];
  repository_url?: string;
};

async function list<T>(path: string, signal?: AbortSignal): Promise<T[]> {
  const result = await api<T[] | { items: T[] }>(path, { signal });
  // Both list forms are accepted while deployed clients migrate together.
  return Array.isArray(result) ? result : result.items;
}

const memoryPath = "/api/bot/memories";
const candidatePath = "/api/bot/skill-candidates";
const assetPath = "/api/bot/knowledge/assets";
const key = (id: string) => encodeURIComponent(id);
export const memoryApi = {
  library: (signal?: AbortSignal) => api<MemoryLibrary>(memoryPath, { signal }),
  provider: (signal?: AbortSignal) =>
    api<MemoryProvider>("/api/bot/memory/providers", { signal }),
  getSettings: (signal?: AbortSignal) =>
    api<MemorySettings>("/api/bot/memory/settings", { signal }),
  settings: (value: Partial<MemorySettings>) =>
    api<MemorySettings>("/api/bot/memory/settings", {
      method: "PUT",
      body: JSON.stringify(value),
    }),
  create: (value: { content: string; kind: MemoryKind }) =>
    post<PersonalMemory>(memoryPath, value),
  edit: (id: string, value: { content: string; kind: MemoryKind }) =>
    api<PersonalMemory>(`${memoryPath}/${key(id)}`, {
      method: "PUT",
      body: JSON.stringify(value),
    }),
  review: (id: string, decision: "approve" | "reject") =>
    post(`${memoryPath}/${key(id)}/review`, { decision }),
  remove: (id?: string) =>
    id
      ? api(`${memoryPath}/${key(id)}`, { method: "DELETE" })
      : post(`${memoryPath}/forget`, {}),
  candidates: (signal?: AbortSignal) =>
    list<SkillCandidate>(candidatePath, signal),
  proposeSkill: (value: {
    task_id: string;
    name?: string;
    description?: string;
    instructions?: string;
  }) => post<SkillCandidate>(candidatePath, value),
  editSkill: (
    id: string,
    value: {
      name: string;
      description: string;
      instructions: string;
      version?: number;
    },
  ) =>
    api<SkillCandidate>(`${candidatePath}/${key(id)}`, {
      method: "PUT",
      body: JSON.stringify(value),
    }),
  reviewSkill: (
    id: string,
    decision: "approve" | "reject",
    note?: string,
    version?: number,
  ) =>
    post<SkillCandidate>(`${candidatePath}/${key(id)}/review`, {
      decision,
      note,
      version,
    }),
  removeSkill: (id: string) =>
    api(`${candidatePath}/${key(id)}`, { method: "DELETE" }),
  assets: (signal?: AbortSignal) => list<KnowledgeAsset>(assetPath, signal),
  asset: (id: string) => api<KnowledgeAsset>(`${assetPath}/${key(id)}`),
  createAsset: (value: {
    kind: KnowledgeAsset["kind"];
    name: string;
    document_ids?: string[];
    repository_url?: string;
  }) => post<KnowledgeAsset>(assetPath, value),
  syncAsset: (id: string) =>
    post<KnowledgeAsset>(`${assetPath}/${key(id)}/sync`, {}),
  removeAsset: (id: string) =>
    api(`${assetPath}/${key(id)}`, { method: "DELETE" }),
  searchAsset: (id: string, query: string) =>
    post<KnowledgeResult>(`${assetPath}/${key(id)}/search`, { query }),
  assetTool: (id: string, name: string, args: Record<string, unknown>) =>
    post<KnowledgeResult>(`${assetPath}/${key(id)}/tools`, {
      name,
      arguments: args,
    }),
};
