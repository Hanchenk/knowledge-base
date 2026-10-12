export type Rights = {
  can_view: boolean;
  can_create: boolean;
  can_manage: boolean;
};
export type User = {
  id: string;
  tenant_id: string;
  name: string;
  email: string;
  role: string;
  department_id: string | null;
  manager_id: string | null;
  active: boolean;
};
export type Department = { id: string; name: string; parent_id: string | null };
export type Space = {
  id: string;
  name: string;
  description: string;
  color: string;
  document_count: number;
  permissions: Rights;
};
export type Document = {
  id: string;
  space_id: string;
  title: string;
  filename: string;
  mime_type: string;
  size: number;
  version: number;
  status: string;
  error: string | null;
  author: string;
  created_by: string;
  space_name: string;
  updated_at: number;
  tags: string;
};
export type Citation = {
  chunk_id: string;
  citation_number?: number;
  referenced?: boolean;
  document_id: string;
  space_id: string;
  title: string;
  text: string;
  page: number;
  kind: string;
  image_url: string | null;
  source_url: string;
  version: number;
};
export type WebSource = {
  title: string;
  url: string;
  citation_number?: number;
  referenced?: boolean;
};
export type ToolCall = { name: string; success: boolean; duration_ms?: number };
export type Message = {
  id: string;
  role: string;
  content: string;
  citations: Citation[];
  warnings?: string[];
  engine?: string;
  web_sources?: WebSource[];
  tool_calls?: ToolCall[];
};
export type Stats = {
  counts: {
    documents: number;
    chunks: number;
    images: number;
    pending: number;
  };
  spaces: number;
  capabilities: {
    semantic: boolean;
    vision: boolean;
    chat: boolean;
    agent?: boolean;
    web?: boolean;
    sso: boolean;
    database: string;
    storage: string;
    models: { embedding: string; vision: string; chat: string };
  };
  mcp_url: string;
};
export type Grant = {
  id?: string;
  principal_type: string;
  principal_id: string;
  include_descendants: number | boolean;
  can_view: number | boolean;
  can_create: number | boolean;
  can_manage: number | boolean;
  effect: string;
};
export type ApiKey = {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  expires_at: number;
  revoked: number;
  last_used_at: number | null;
};
