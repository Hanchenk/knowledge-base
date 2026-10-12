import { Loader2 } from "lucide-react";
import type { Citation, WebSource } from "./types";
export type Caps = {
  agent: boolean;
  model: string;
  web: boolean;
  code: boolean;
  code_configured: boolean;
  connectors_enabled: boolean;
  connector_hosts: string[];
  worker: boolean;
};
export type Skill = {
  id: string;
  name: string;
  description: string;
  instructions: string;
  builtin?: boolean;
};
export type Connector = {
  id: string;
  name: string;
  description: string;
  url: string;
  method: string;
  has_token: boolean;
};
export type LocalDevice = {
  id: string;
  name: string;
  workspace_id: string;
  workspace_title: string;
  online: boolean;
  last_seen: number;
};
export type Task = {
  id: string;
  title: string;
  prompt: string;
  status: string;
  result: string;
  error: string | null;
  created_at: number;
  updated_at: number;
  attempt: number;
  options: {
    allow_web: boolean;
    allow_code: boolean;
    connector_ids: string[];
    skill_ids: string[];
    document_ids: string[];
    parent_task_id?: string;
    local_device_id?: string;
  };
  plan: { title: string; status: string }[];
  citations: Citation[];
  web_sources: WebSource[];
};
export type Detail = {
  messages?: {
    id: string;
    content: string;
    status: string;
    created_at: number;
    updated_at?: number;
  }[];
  task: Task;
  evidence_available: boolean;
  events: {
    id: string;
    kind: string;
    content: {
      message?: string;
      name?: string;
      success?: boolean;
      status?: string;
    };
    created_at: number;
  }[];
  artifacts: { id: string; name: string; size: number }[];
  actions: {
    id: string;
    name: string;
    status: string;
    payload: { url: string; method: string; input: unknown };
    result: string;
  }[];
};
export const statusNames: Record<string, string> = {
  queued: "排队中",
  running: "执行中",
  waiting: "等待确认",
  completed: "已完成",
  failed: "执行失败",
  paused: "已暂停",
  cancelled: "已取消",
  pending: "待确认",
  rejected: "已拒绝",
  uncertain: "结果待核实",
};
export const toolNames: Record<string, string> = {
  task_memory: "保存证据笔记",
  runtime_recall: "读取历史执行结果",
  knowledge_search: "检索知识库",
  knowledge_read: "读取资料",
  knowledge_spaces: "查看知识空间",
  web_search: "搜索公开资料",
  web_fetch: "读取网页",
  task_plan: "更新任务步骤",
  write_artifact: "保存成果文件",
  run_python: "运行隔离 Python",
  connector_call: "调用应用连接器",
};
export const activeStates = ["queued", "running", "waiting"];
export function Badge({ status }: { status: string }) {
  return (
    <span className={`bot-badge ${status}`}>
      {status === "running" && <Loader2 size={12} className="spin" />}
      {statusNames[status] || status}
    </span>
  );
}
