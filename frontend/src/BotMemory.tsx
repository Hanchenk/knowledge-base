import { useCallback, useEffect, useRef, useState } from "react";
import {
  BookOpen,
  Brain,
  Check,
  Code2,
  ExternalLink,
  FileText,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { api, date } from "./api";
import type { Confirm, Feedback } from "./App";
import type { Task } from "./bot-types";
import type { Document } from "./types";
import { Modal } from "./components";
import {
  memoryApi,
  type KnowledgeAsset,
  type KnowledgeResult,
  type MemoryKind,
  type MemoryLibrary,
  type MemoryProvider,
  type MemorySettings,
  type SkillCandidate,
} from "./memory-api";
import "./bot-memory.css";

type Tab = "memory" | "skills" | "knowledge";

export function PersonalMemoryCenter({
  onClose,
  onTask,
  onDocument,
  onChanged,
  feedback,
  confirm,
}: {
  onClose: () => void;
  onTask: (id: string) => void;
  onDocument: (id: string) => void;
  onChanged: () => void;
  feedback: Feedback;
  confirm: Confirm;
}) {
  const [context, setContext] = useState<{ tasks: Task[]; docs: Document[] }>();
  const [error, setError] = useState("");
  const load = useCallback(async (signal?: AbortSignal) => {
    const [tasks, docs] = await Promise.all([
      api<Task[]>("/api/bot/tasks", { signal }),
      api<{ items: Document[] }>("/api/documents?limit=100", { signal }),
    ]);
    setContext({
      tasks,
      docs: docs.items.filter((doc) => doc.status === "ready"),
    });
    setError("");
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal).catch((reason: Error) => {
      if (!controller.signal.aborted) setError(reason.message);
    });
    return () => controller.abort();
  }, [load]);
  if (!context) {
    return (
      <Modal title="记忆与经验" onClose={onClose} wide>
        {error ? (
          <>
            <p role="alert" className="notice error-notice">
              {error}
            </p>
            <button
              type="button"
              className="button"
              onClick={() =>
                void load().catch((reason: Error) => setError(reason.message))
              }
            >
              重新加载
            </button>
          </>
        ) : (
          <div className="loading-panel">正在加载记忆与经验…</div>
        )}
      </Modal>
    );
  }
  return (
    <BotMemory
      tasks={context.tasks}
      docs={context.docs}
      selectedTaskId={new URLSearchParams(location.search).get("task") || ""}
      onClose={onClose}
      onTask={onTask}
      onDocument={onDocument}
      onChanged={async () => {
        await load();
        onChanged();
      }}
      feedback={feedback}
      confirm={confirm}
    />
  );
}
type Run = (
  key: string,
  action: () => Promise<unknown>,
  message: string,
) => Promise<void>;
const tabs = [
  { id: "memory", title: "我的记忆", icon: Brain },
  { id: "skills", title: "技能审核", icon: ShieldCheck },
  { id: "knowledge", title: "Wiki 与代码", icon: BookOpen },
] as const;
const kindNames: Record<MemoryKind, string> = {
  preference: "工作偏好",
  constraint: "长期约定",
  experience: "项目经验",
};
const syncNames: Record<string, string> = {
  local: "保存在知小汇",
  pending: "等待服务同步",
  synced: "已同步到记忆服务",
};
const stateNames: Record<string, string> = {
  active: "已生效",
  pending: "待审核",
  approved: "已入技能库",
  rejected: "已拒绝",
  queued: "等待构建",
  building: "构建中",
  ready: "可用",
  failed: "构建失败",
  deleting: "删除中",
};
function State({ value }: { value: string }) {
  return (
    <span className={`bot-memory-state ${value}`}>
      {stateNames[value] || value}
    </span>
  );
}
function SourceTask({
  id,
  tasks,
  onTask,
}: {
  id?: string | null;
  tasks: Task[];
  onTask: (id: string) => void;
}) {
  if (!id) return null;
  return (
    <button
      type="button"
      className="text-button bot-memory-source"
      onClick={() => onTask(id)}
    >
      <ExternalLink size={12} /> 来源：
      {tasks.find((task) => task.id === id)?.title || "历史任务"}
    </button>
  );
}
function Empty({
  icon: Icon,
  title,
  text,
}: {
  icon: typeof Brain;
  title: string;
  text: string;
}) {
  return (
    <div className="bot-memory-empty">
      <Icon size={28} />
      <strong>{title}</strong>
      <p>{text}</p>
    </div>
  );
}

export function BotMemory({
  tasks,
  docs,
  selectedTaskId,
  initialTab = "memory",
  onClose,
  onChanged,
  onTask,
  onDocument,
  feedback,
  confirm,
}: {
  tasks: Task[];
  docs: Document[];
  selectedTaskId: string;
  initialTab?: Tab;
  onClose: () => void;
  onChanged: () => Promise<void>;
  onTask: (id: string) => void;
  onDocument: (id: string) => void;
  feedback: Feedback;
  confirm: Confirm;
}) {
  const previousFocus = useRef(document.activeElement as HTMLElement | null);
  useEffect(
    () => () => {
      const element = previousFocus.current;
      requestAnimationFrame(() => {
        if (element?.isConnected) element.focus({ preventScroll: true });
      });
    },
    [],
  );
  const [tab, setTab] = useState<Tab>(initialTab);
  const [memory, setMemory] = useState<MemoryLibrary>();
  const [settings, setSettings] = useState<MemorySettings>();
  const [candidates, setCandidates] = useState<SkillCandidate[]>([]);
  const [assets, setAssets] = useState<KnowledgeAsset[]>([]);
  const [provider, setProvider] = useState<MemoryProvider>();
  const [providerError, setProviderError] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const load = useCallback(
    async (signal?: AbortSignal) => {
      if (tab === "memory") {
        const library = await memoryApi.library(signal);
        setMemory(library);
        setSettings(library.settings);
      } else if (tab === "skills") {
        const [items, preferences] = await Promise.all([
          memoryApi.candidates(signal),
          memoryApi.getSettings(signal),
        ]);
        setCandidates(items);
        setSettings(preferences);
      } else setAssets(await memoryApi.assets(signal));
    },
    [tab],
  );
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    void load(controller.signal)
      .catch((reason: Error) => {
        if (!controller.signal.aborted) setError(reason.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [load]);
  useEffect(() => {
    const controller = new AbortController();
    void memoryApi
      .provider(controller.signal)
      .then(setProvider)
      .catch((reason: Error) => {
        if (!controller.signal.aborted) setProviderError(reason.message);
      });
    return () => controller.abort();
  }, []);
  const processing =
    tab === "knowledge"
      ? assets.some((asset) =>
          ["queued", "building", "deleting"].includes(asset.status),
        )
      : tab === "skills" &&
        candidates.some((candidate) => candidate.extraction_state === "queued");
  useEffect(() => {
    if (!processing) return;
    const controller = new AbortController();
    let inFlight = false;
    const timer = window.setInterval(() => {
      if (document.hidden || inFlight) return;
      inFlight = true;
      void load(controller.signal)
        .then(onChanged)
        .catch((reason: Error) => {
          if (!controller.signal.aborted) setError(reason.message);
        })
        .finally(() => {
          inFlight = false;
        });
    }, 4000);
    return () => {
      clearInterval(timer);
      controller.abort();
    };
  }, [load, onChanged, processing, tab]);
  const run: Run = async (key, action, message) => {
    if (busy) return;
    setBusy(key);
    setError("");
    try {
      await action();
      await load();
      await onChanged();
      if (message) feedback(message);
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason);
      setError(message);
      feedback(message, true);
    } finally {
      setBusy("");
    }
  };
  const selectedProvider =
    tab === "knowledge" ? provider?.knowledge : provider?.core;
  return (
    <Modal title="记忆与经验" onClose={onClose} wide>
      <section className="bot-memory-library">
        <p className="bot-memory-intro">
          把长期偏好、验证过的方法与项目知识带到下一次任务。
        </p>
        <div
          className="bot-memory-tabs"
          role="tablist"
          aria-label="记忆与经验分类"
        >
          {tabs.map(({ id, title, icon: Icon }) => (
            <button
              key={id}
              type="button"
              role="tab"
              id={`experience-tab-${id}`}
              aria-selected={tab === id}
              aria-controls="experience-panel"
              className={tab === id ? "active" : ""}
              onClick={() => {
                if (id !== tab) {
                  setLoading(true);
                  setTab(id);
                }
              }}
            >
              <Icon size={15} />
              {title}
            </button>
          ))}
        </div>
        <div className="bot-memory-provider" role="status">
          <span
            className={`bot-memory-provider-dot ${selectedProvider?.configured && selectedProvider.available !== false ? "configured" : ""}`}
          />
          {selectedProvider
            ? selectedProvider.configured
              ? selectedProvider.available === false
                ? "服务暂时不可用，请稍后重试"
                : "记忆服务已配置"
              : tab === "knowledge"
                ? "Wiki 与代码服务未配置，请联系管理员配置 Agent Memory"
                : "长期记忆服务未配置，个人记忆保存在知小汇中"
            : providerError
              ? "服务状态暂无法读取"
              : "正在读取服务状态…"}
          <button
            type="button"
            className="text-button"
            disabled={!!busy || loading}
            onClick={() =>
              void run(
                "refresh",
                async () => {
                  const result = await memoryApi.provider();
                  setProvider(result);
                  setProviderError("");
                },
                "已刷新记忆与经验",
              )
            }
          >
            <RefreshCw size={13} className={busy === "refresh" ? "spin" : ""} />
            刷新
          </button>
        </div>
        {error && (
          <div className="bot-notice error" role="alert">
            {error}
          </div>
        )}
        {tab === "memory" && memory?.provider.error && (
          <p className="bot-memory-help" role="status">
            服务同步暂未完成：{memory.provider.error}
          </p>
        )}
        <div
          role="tabpanel"
          id="experience-panel"
          aria-labelledby={`experience-tab-${tab}`}
          aria-busy={loading}
        >
          {loading ? (
            <div className="bot-memory-loading">
              <Loader2 size={20} className="spin" />
              正在加载…
            </div>
          ) : tab === "memory" ? (
            <PersonalMemories
              memory={memory}
              tasks={tasks}
              run={run}
              busy={busy}
              confirm={confirm}
              onTask={onTask}
            />
          ) : tab === "skills" ? (
            <SkillReview
              captureEnabled={settings?.skill_capture === true}
              candidates={candidates}
              tasks={tasks}
              selectedTaskId={selectedTaskId}
              run={run}
              busy={busy}
              confirm={confirm}
              onTask={onTask}
            />
          ) : (
            <KnowledgeLibrary
              assets={assets}
              docs={docs}
              provider={provider?.knowledge}
              run={run}
              busy={busy}
              confirm={confirm}
              onDocument={onDocument}
            />
          )}
        </div>
      </section>
    </Modal>
  );
}

function PersonalMemories({
  memory,
  tasks,
  run,
  busy,
  confirm,
  onTask,
}: {
  memory?: MemoryLibrary;
  tasks: Task[];
  run: Run;
  busy: string;
  confirm: Confirm;
  onTask: (id: string) => void;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const [content, setContent] = useState("");
  const [kind, setKind] = useState<MemoryKind>("preference");
  const [query, setQuery] = useState("");
  const [pendingOnly, setPendingOnly] = useState(false);
  const items = memory?.items.filter((item) => item.status !== "deleted") || [];
  const visible = items.filter(
    (item) =>
      (!pendingOnly || item.status === "pending") &&
      item.content
        .toLocaleLowerCase()
        .includes(query.trim().toLocaleLowerCase()),
  );
  const save = () =>
    run(
      "memory-save",
      async () => {
        const value = { content: content.trim(), kind };
        if (editing) await memoryApi.edit(editing, value);
        else await memoryApi.create(value);
        setEditing(null);
        setContent("");
      },
      editing ? "记忆已更新" : "个人记忆已保存",
    );
  return (
    <>
      <div className="bot-memory-toolbar">
        <label className="bot-memory-search">
          <Search size={15} />
          <input
            type="search"
            aria-label="搜索个人记忆"
            placeholder="搜索个人记忆…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <label className="bot-memory-filter">
          <input
            type="checkbox"
            checked={pendingOnly}
            onChange={(event) => setPendingOnly(event.target.checked)}
          />
          只看待审核
        </label>
        <button
          type="button"
          className="button"
          disabled={!!busy}
          onClick={() => {
            setEditing("");
            setContent("");
            setKind("preference");
          }}
        >
          <Plus size={14} />
          添加记忆
        </button>
      </div>
      {editing !== null && (
        <form
          className="bot-memory-editor"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <h3>{editing ? "编辑个人记忆" : "添加个人记忆"}</h3>
          <label>
            记忆类型
            <select
              value={kind}
              onChange={(event) => setKind(event.target.value as MemoryKind)}
            >
              {Object.entries(kindNames).map(([value, name]) => (
                <option key={value} value={value}>
                  {name}
                </option>
              ))}
            </select>
          </label>
          <label>
            记忆内容
            <textarea
              aria-label="记忆内容"
              value={content}
              maxLength={2000}
              required
              rows={4}
              onChange={(event) => setContent(event.target.value)}
              placeholder="例如：研究报告先给结论，再列出来源和证据。"
            />
          </label>
          <div className="bot-memory-actions">
            <button
              className="button primary"
              type="submit"
              disabled={!!busy || !content.trim()}
            >
              {busy === "memory-save" ? (
                <Loader2 size={14} className="spin" />
              ) : (
                <Check size={14} />
              )}
              保存记忆
            </button>
            <button
              type="button"
              className="text-button"
              onClick={() => setEditing(null)}
            >
              取消
            </button>
          </div>
        </form>
      )}
      <div className="bot-memory-list">
        {visible.map((item) => (
          <article className="bot-memory-card" key={item.id}>
            <div className="bot-memory-card-head">
              <span className="bot-memory-kind">
                {kindNames[item.kind] || item.kind}
              </span>
              <State value={item.status} />
            </div>
            <p className="bot-memory-content">{item.content}</p>
            <div className="bot-memory-card-meta">
              <time>{date(item.updated_at)}</time>
              {item.provider_status && (
                <small>
                  {syncNames[item.provider_status] || item.provider_status}
                </small>
              )}
            </div>
            <SourceTask
              id={item.source_task_id}
              tasks={tasks}
              onTask={onTask}
            />
            {item.source_available === false && (
              <p className="bot-memory-help">
                来源任务未完成或资料已变化，暂不可审核和编辑。
              </p>
            )}
            <div className="bot-memory-actions">
              {item.status === "pending" && (
                <>
                  <button
                    type="button"
                    className="button small primary"
                    disabled={!!busy || item.source_available === false}
                    onClick={() =>
                      void run(
                        `approve-${item.id}`,
                        () => memoryApi.review(item.id, "approve"),
                        "候选记忆已生效",
                      )
                    }
                  >
                    <Check size={13} />
                    审核通过
                  </button>
                  <button
                    type="button"
                    className="text-button"
                    disabled={!!busy}
                    onClick={() =>
                      void run(
                        `reject-${item.id}`,
                        () => memoryApi.review(item.id, "reject"),
                        "候选记忆已拒绝",
                      )
                    }
                  >
                    拒绝
                  </button>
                </>
              )}
              <button
                type="button"
                className="text-button"
                disabled={!!busy || item.source_available === false}
                onClick={() => {
                  setEditing(item.id);
                  setContent(item.content);
                  setKind(item.kind);
                }}
              >
                <Pencil size={13} />
                编辑
              </button>
              <button
                type="button"
                className="text-button danger"
                disabled={!!busy}
                onClick={() =>
                  confirm(
                    "删除这条个人记忆？以后任务将不再使用它，受其影响的旧成果会隐藏。",
                    () =>
                      run(
                        `delete-${item.id}`,
                        () => memoryApi.remove(item.id),
                        "记忆已删除",
                      ),
                  )
                }
              >
                <Trash2 size={13} />
                删除
              </button>
            </div>
          </article>
        ))}
      </div>
      {!visible.length && (
        <Empty
          icon={Brain}
          title={query || pendingOnly ? "没有匹配的记忆" : "还没有个人记忆"}
          text={
            query || pendingOnly
              ? "调整筛选条件，或添加一条记忆。"
              : "保存工作偏好与长期约定，下次任务就能继续沿用。"
          }
        />
      )}
      {!!items.length && (
        <div className="bot-memory-forget">
          <p>你可以随时管理记忆，或让知小汇忘记全部个人记忆。</p>
          <button
            type="button"
            className="text-button danger"
            disabled={!!busy}
            onClick={() =>
              confirm(
                "忘记全部个人记忆？这会清空已审核和待审核的记忆，并关闭候选记忆采集。原任务记录仍保留；依赖这些记忆的旧成果会隐藏。",
                () =>
                  run("forget", () => memoryApi.remove(), "个人记忆已全部删除"),
              )
            }
          >
            <Trash2 size={13} />
            忘记全部记忆
          </button>
        </div>
      )}
    </>
  );
}

function SkillReview({
  captureEnabled,
  candidates,
  tasks,
  selectedTaskId,
  run,
  busy,
  confirm,
  onTask,
}: {
  captureEnabled: boolean;
  candidates: SkillCandidate[];
  tasks: Task[];
  selectedTaskId: string;
  run: Run;
  busy: string;
  confirm: Confirm;
  onTask: (id: string) => void;
}) {
  const completed = tasks.filter((task) => task.status === "completed");
  const [creating, setCreating] = useState(false);
  const [taskId, setTaskId] = useState(
    completed.some((task) => task.id === selectedTaskId)
      ? selectedTaskId
      : completed[0]?.id || "",
  );
  const [manual, setManual] = useState(false);
  const [draft, setDraft] = useState({
    name: "",
    description: "",
    instructions: "",
  });
  const [editing, setEditing] = useState<SkillCandidate>();
  const [reviewNotes, setReviewNotes] = useState<Record<string, string>>({});
  const [filter, setFilter] = useState("pending");
  const visible = candidates.filter(
    (candidate) => filter === "all" || candidate.status === filter,
  );
  return (
    <>
      <div className="bot-memory-section-head">
        <div>
          <h3>把成功任务沉淀为技能</h3>
          <p>候选技能经你审核后，才会进入个人技能库供新任务选择。</p>
          {!captureEnabled && (
            <p>技能提炼已关闭，可在个人中心开启；已有候选仍可审核。</p>
          )}
        </div>
        <button
          type="button"
          className="button"
          disabled={!!busy || !completed.length || !captureEnabled}
          onClick={() => {
            setCreating(true);
            setEditing(undefined);
            setDraft({ name: "", description: "", instructions: "" });
          }}
        >
          <Plus size={14} />
          从任务提炼
        </button>
      </div>
      {!completed.length && (
        <p className="bot-memory-help">
          完成一个任务后，可以从其过程与结果提炼可复用的方法。
        </p>
      )}
      {creating && (
        <form
          className="bot-memory-editor"
          onSubmit={(event) => {
            event.preventDefault();
            if (!captureEnabled) return;
            void run(
              "propose-skill",
              async () => {
                await memoryApi.proposeSkill({
                  task_id: taskId,
                  ...(manual
                    ? {
                        name: draft.name.trim(),
                        description: draft.description.trim(),
                        instructions: draft.instructions.trim(),
                      }
                    : {}),
                });
                setCreating(false);
              },
              manual
                ? "候选技能已保存，请审核后加入技能库"
                : "技能提炼已提交，草稿完成后请审核",
            );
          }}
        >
          <h3>提炼候选技能</h3>
          <label>
            来源任务
            <select
              aria-label="技能来源任务"
              value={taskId}
              required
              onChange={(event) => setTaskId(event.target.value)}
            >
              <option value="" disabled>
                选择已完成任务
              </option>
              {completed.map((task) => (
                <option key={task.id} value={task.id}>
                  {task.title}
                </option>
              ))}
            </select>
          </label>
          <label className="bot-memory-inline">
            <input
              type="checkbox"
              checked={manual}
              onChange={(event) => setManual(event.target.checked)}
            />
            手动填写技能草稿
          </label>
          {manual ? (
            <SkillFields draft={draft} onDraft={setDraft} />
          ) : (
            <p className="bot-memory-help">
              知小汇会分析此任务的过程与结果，生成可编辑的技能草稿。
            </p>
          )}
          <div className="bot-memory-actions">
            <button
              type="submit"
              className="button primary"
              disabled={
                !!busy ||
                !taskId ||
                !captureEnabled ||
                (manual && (!draft.name.trim() || !draft.instructions.trim()))
              }
            >
              {busy === "propose-skill" ? (
                <Loader2 size={14} className="spin" />
              ) : (
                <Sparkles size={14} />
              )}
              {manual ? "保存候选技能" : "生成技能草稿"}
            </button>
            <button
              type="button"
              className="text-button"
              onClick={() => setCreating(false)}
            >
              取消
            </button>
          </div>
        </form>
      )}
      {editing && (
        <form
          className="bot-memory-editor"
          onSubmit={(event) => {
            event.preventDefault();
            void run(
              "edit-skill",
              async () => {
                await memoryApi.editSkill(editing.id, {
                  name: draft.name.trim(),
                  description: draft.description.trim(),
                  instructions: draft.instructions.trim(),
                  version: editing.version,
                });
                setEditing(undefined);
              },
              "候选技能已更新",
            );
          }}
        >
          <h3>编辑候选技能</h3>
          <SkillFields draft={draft} onDraft={setDraft} />
          <div className="bot-memory-actions">
            <button
              type="submit"
              className="button primary"
              disabled={
                !!busy || !draft.name.trim() || !draft.instructions.trim()
              }
            >
              保存草稿
            </button>
            <button
              type="button"
              className="text-button"
              onClick={() => setEditing(undefined)}
            >
              取消
            </button>
          </div>
        </form>
      )}
      <div className="bot-memory-toolbar">
        <label className="bot-memory-inline">
          审核状态
          <select
            aria-label="技能审核状态"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
          >
            <option value="pending">待审核</option>
            <option value="approved">已入库</option>
            <option value="rejected">已拒绝</option>
            <option value="all">全部</option>
          </select>
        </label>
        <span className="bot-memory-count">{visible.length} 个候选技能</span>
      </div>
      <div className="bot-memory-list">
        {visible.map((candidate) => (
          <article className="bot-memory-card" key={candidate.id}>
            <div className="bot-memory-card-head">
              <h3>{candidate.name || "来源不可用的候选技能"}</h3>
              <State value={candidate.status} />
            </div>
            <p>{candidate.description}</p>
            <SourceTask id={candidate.task_id} tasks={tasks} onTask={onTask} />
            {candidate.source_valid === false && (
              <p className="bot-memory-asset-error">
                来源资料已更新或权限已变化，无法审核通过。请重新提炼技能。
              </p>
            )}
            {candidate.extraction_state === "queued" && (
              <p className="bot-memory-help" role="status">
                <Loader2 size={12} className="spin" />{" "}
                技能正在提炼中，完成后可审核。
              </p>
            )}
            {candidate.extraction_error && (
              <p className="bot-memory-asset-error">
                提炼失败：{candidate.extraction_error}
              </p>
            )}
            <details className="bot-memory-instructions">
              <summary>查看技能步骤 · v{candidate.version}</summary>
              <div className="markdown">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>
                  {candidate.instructions}
                </ReactMarkdown>
              </div>
            </details>
            {candidate.review_note && (
              <p className="bot-memory-help">
                审核意见：{candidate.review_note}
              </p>
            )}
            {candidate.status === "pending" && (
              <label className="bot-memory-note">
                审核意见（可选）
                <input
                  aria-label={`审核意见 ${candidate.name}`}
                  maxLength={2000}
                  value={reviewNotes[candidate.id] || ""}
                  onChange={(event) =>
                    setReviewNotes({
                      ...reviewNotes,
                      [candidate.id]: event.target.value,
                    })
                  }
                  placeholder="说明适用范围或需要注意的地方"
                />
              </label>
            )}
            <div className="bot-memory-actions">
              {candidate.status === "pending" && (
                <>
                  <button
                    type="button"
                    className="button small primary"
                    disabled={
                      !!busy ||
                      candidate.source_valid === false ||
                      candidate.extraction_state === "queued" ||
                      !candidate.instructions.trim()
                    }
                    onClick={() =>
                      void run(
                        `approve-skill-${candidate.id}`,
                        () =>
                          memoryApi.reviewSkill(
                            candidate.id,
                            "approve",
                            reviewNotes[candidate.id]?.trim(),
                            candidate.version,
                          ),
                        "技能审核通过，已加入个人技能库",
                      )
                    }
                  >
                    <Check size={13} />
                    审核并加入技能库
                  </button>
                  <button
                    type="button"
                    className="text-button"
                    disabled={!!busy}
                    onClick={() =>
                      void run(
                        `reject-skill-${candidate.id}`,
                        () =>
                          memoryApi.reviewSkill(
                            candidate.id,
                            "reject",
                            reviewNotes[candidate.id]?.trim(),
                            candidate.version,
                          ),
                        "候选技能已拒绝",
                      )
                    }
                  >
                    拒绝
                  </button>
                  <button
                    type="button"
                    className="text-button"
                    disabled={!!busy || candidate.source_valid === false}
                    onClick={() => {
                      setCreating(false);
                      setEditing(candidate);
                      setDraft({
                        name: candidate.name,
                        description: candidate.description,
                        instructions: candidate.instructions,
                      });
                    }}
                  >
                    <Pencil size={13} />
                    编辑草稿
                  </button>
                </>
              )}
              <button
                type="button"
                className="text-button danger"
                disabled={!!busy}
                onClick={() =>
                  confirm(
                    candidate.status === "approved"
                      ? `删除「${candidate.name}」的审核记录并撤回技能？新任务将不能再选择此技能，相关旧成果会隐藏。`
                      : `删除「${candidate.name || "来源不可用的技能"}」的候选记录？`,
                    () =>
                      run(
                        `delete-skill-${candidate.id}`,
                        () => memoryApi.removeSkill(candidate.id),
                        candidate.status === "approved"
                          ? "技能已撤回"
                          : "候选记录已删除",
                      ),
                  )
                }
              >
                <Trash2 size={13} />
                {candidate.status === "approved" ? "撤回技能" : "删除"}
              </button>
            </div>
            <div className="bot-memory-card-meta">
              <time>{date(candidate.updated_at)}</time>
            </div>
          </article>
        ))}
      </div>
      {!visible.length && (
        <Empty
          icon={ShieldCheck}
          title="暂无此状态的候选技能"
          text="从已完成任务提炼草稿，检查步骤与适用范围后再入库。"
        />
      )}
    </>
  );
}

function SkillFields({
  draft,
  onDraft,
}: {
  draft: { name: string; description: string; instructions: string };
  onDraft: (value: {
    name: string;
    description: string;
    instructions: string;
  }) => void;
}) {
  return (
    <>
      <label>
        技能名称
        <input
          aria-label="候选技能名称"
          required
          maxLength={60}
          value={draft.name}
          onChange={(event) => onDraft({ ...draft, name: event.target.value })}
        />
      </label>
      <label>
        适用场景
        <input
          aria-label="候选技能适用场景"
          maxLength={500}
          value={draft.description}
          onChange={(event) =>
            onDraft({ ...draft, description: event.target.value })
          }
        />
      </label>
      <label>
        操作步骤
        <textarea
          aria-label="候选技能操作步骤"
          required
          rows={7}
          maxLength={12000}
          value={draft.instructions}
          onChange={(event) =>
            onDraft({ ...draft, instructions: event.target.value })
          }
          placeholder="写明前提、具体步骤、如何校验结果，以及不适用的情况。"
        />
      </label>
    </>
  );
}

function KnowledgeLibrary({
  assets,
  docs,
  provider,
  run,
  busy,
  confirm,
  onDocument,
}: {
  assets: KnowledgeAsset[];
  docs: Document[];
  provider?: MemoryProvider["knowledge"];
  run: Run;
  busy: string;
  confirm: Confirm;
  onDocument: (id: string) => void;
}) {
  const [creating, setCreating] = useState(false);
  const [kind, setKind] = useState<KnowledgeAsset["kind"]>("wiki");
  const [name, setName] = useState("");
  const [documentIds, setDocumentIds] = useState<string[]>([]);
  const [repositoryUrl, setRepositoryUrl] = useState("");
  const [selected, setSelected] = useState<KnowledgeAsset>();
  const [query, setQuery] = useState("");
  const [result, setResult] = useState<KnowledgeResult>();
  const [tool, setTool] = useState("explore");
  const [reference, setReference] = useState("");
  const available = !!provider?.configured && provider.available !== false;
  const open = (asset: KnowledgeAsset) =>
    void run(
      `asset-${asset.id}`,
      async () => {
        const detail = await memoryApi.asset(asset.id);
        setSelected(detail);
        setQuery("");
        setReference("");
        setResult(undefined);
        setTool("explore");
      },
      "",
    );
  const current = assets.find((asset) => asset.id === selected?.id);
  const ready = current?.status === "ready" && available;
  const search = () =>
    selected &&
    run(
      "asset-search",
      async () => {
        setResult(undefined);
        setResult(await memoryApi.searchAsset(selected.id, query.trim()));
      },
      "",
    );
  const invoke = (name: string, args: Record<string, unknown>) =>
    selected &&
    run(
      "asset-tool",
      async () => {
        setResult(undefined);
        setResult(await memoryApi.assetTool(selected.id, name, args));
      },
      "",
    );
  return (
    <>
      <div className="bot-memory-section-head">
        <div>
          <h3>项目知识资产</h3>
          <p>用授权资料构建 Wiki，或为代码仓库建立可检索的关系图。</p>
        </div>
        <button
          type="button"
          className="button"
          disabled={!!busy || !available}
          onClick={() => setCreating(true)}
        >
          <Plus size={14} />
          创建知识资产
        </button>
      </div>
      {!available && (
        <p className="bot-memory-help">
          服务配置并可用后，才能构建、同步和检索知识资产。
        </p>
      )}
      {creating && (
        <form
          className="bot-memory-editor"
          onSubmit={(event) => {
            event.preventDefault();
            void run(
              "create-asset",
              async () => {
                await memoryApi.createAsset({
                  kind,
                  name: name.trim(),
                  ...(kind === "wiki"
                    ? { document_ids: documentIds }
                    : { repository_url: repositoryUrl.trim() }),
                });
                setCreating(false);
                setName("");
                setDocumentIds([]);
                setRepositoryUrl("");
              },
              "知识资产已提交构建，完成后可在任务中选择",
            );
          }}
        >
          <h3>创建知识资产</h3>
          <label>
            类型
            <select
              aria-label="知识资产类型"
              value={kind}
              onChange={(event) =>
                setKind(event.target.value as KnowledgeAsset["kind"])
              }
            >
              <option value="wiki">Wiki · 授权资料</option>
              <option value="code_graph">CodeGraph · 代码仓库</option>
            </select>
          </label>
          <label>
            名称
            <input
              aria-label="知识资产名称"
              required
              maxLength={120}
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder={
                kind === "wiki" ? "例如：产品研究 Wiki" : "例如：知小汇代码图"
              }
            />
          </label>
          {kind === "wiki" ? (
            <fieldset className="bot-memory-docs">
              <legend>选择授权资料 · 已选 {documentIds.length}</legend>
              {docs.map((doc) => (
                <label key={doc.id}>
                  <input
                    type="checkbox"
                    checked={documentIds.includes(doc.id)}
                    disabled={
                      !documentIds.includes(doc.id) && documentIds.length >= 20
                    }
                    onChange={(event) =>
                      setDocumentIds(
                        event.target.checked
                          ? [...documentIds, doc.id]
                          : documentIds.filter((id) => id !== doc.id),
                      )
                    }
                  />
                  <FileText size={14} />
                  <span>
                    {doc.title}
                    <small>{doc.space_name}</small>
                  </span>
                </label>
              ))}
              {!docs.length && (
                <p className="bot-memory-help">
                  暂无可用资料，请先上传资料并等待索引完成。
                </p>
              )}
              {documentIds.length >= 20 && (
                <p className="bot-memory-help">
                  每个 Wiki 最多选择 20 份资料。
                </p>
              )}
            </fieldset>
          ) : (
            <label>
              仓库地址
              <input
                type="url"
                aria-label="代码仓库地址"
                required
                value={repositoryUrl}
                onChange={(event) => setRepositoryUrl(event.target.value)}
                placeholder="https://github.com/org/repository.git"
              />
              <small>首期支持无凭据的公开 HTTPS GitHub 仓库。</small>
            </label>
          )}
          <div className="bot-memory-actions">
            <button
              type="submit"
              className="button primary"
              disabled={
                !!busy ||
                !available ||
                !name.trim() ||
                (kind === "wiki" ? !documentIds.length : !repositoryUrl.trim())
              }
            >
              {busy === "create-asset" && (
                <Loader2 size={14} className="spin" />
              )}
              开始构建
            </button>
            <button
              type="button"
              className="text-button"
              onClick={() => setCreating(false)}
            >
              取消
            </button>
          </div>
        </form>
      )}
      <div className="bot-memory-asset-grid">
        {assets
          .filter((asset) => asset.status !== "deleted")
          .map((asset) => (
            <article
              className={`bot-memory-card ${selected?.id === asset.id ? "selected" : ""}`}
              key={asset.id}
            >
              <div className="bot-memory-card-head">
                <span className="bot-memory-kind">
                  {asset.kind === "wiki" ? (
                    <BookOpen size={15} />
                  ) : (
                    <Code2 size={15} />
                  )}
                  {asset.kind === "wiki" ? "Wiki" : "CodeGraph"}
                </span>
                <State value={asset.status} />
              </div>
              <h3>{asset.name}</h3>
              <p className="bot-memory-asset-source">
                {asset.kind === "wiki"
                  ? `${asset.document_ids.length} 份授权资料`
                  : asset.repository_url}
              </p>
              {asset.error && (
                <p className="bot-memory-asset-error">{asset.error}</p>
              )}
              <div className="bot-memory-card-meta">
                <time>{date(asset.updated_at)}</time>
              </div>
              <div className="bot-memory-actions">
                <button
                  type="button"
                  className="text-button"
                  disabled={!!busy}
                  onClick={() => open(asset)}
                >
                  <Search size={13} />
                  查看与检索
                </button>
                <button
                  type="button"
                  className="text-button"
                  disabled={
                    !!busy ||
                    !available ||
                    ["queued", "building", "deleting"].includes(asset.status)
                  }
                  onClick={() =>
                    void run(
                      `sync-${asset.id}`,
                      () => memoryApi.syncAsset(asset.id),
                      "已请求同步知识资产",
                    )
                  }
                >
                  <RefreshCw size={13} />
                  同步
                </button>
                <button
                  type="button"
                  className="text-button danger"
                  disabled={!!busy || asset.status === "deleting"}
                  onClick={() =>
                    confirm(
                      `删除「${asset.name}」及其派生知识？来源资料会保留，依赖此资产的旧成果会隐藏。`,
                      () =>
                        run(
                          `delete-asset-${asset.id}`,
                          async () => {
                            await memoryApi.removeAsset(asset.id);
                            if (selected?.id === asset.id) {
                              setSelected(undefined);
                              setResult(undefined);
                            }
                          },
                          "知识资产已删除",
                        ),
                    )
                  }
                >
                  <Trash2 size={13} />
                  删除
                </button>
              </div>
            </article>
          ))}
      </div>
      {!assets.filter((asset) => asset.status !== "deleted").length && (
        <Empty
          icon={BookOpen}
          title="还没有项目知识资产"
          text="从资料构建 Wiki，或接入一个代码仓库；构建完成后可授权给任务。"
        />
      )}
      {selected && current && (
        <section
          className="bot-memory-asset-detail"
          aria-label={`知识资产详情 ${selected.name}`}
        >
          <div className="bot-memory-section-head">
            <div>
              <h3>{selected.name}</h3>
              <p>
                {selected.kind === "wiki"
                  ? "检索 Wiki 页面，回看生成页面与来源资料。"
                  : "检索代码关系、调用链与变更影响。"}
              </p>
            </div>
            <button
              type="button"
              className="icon-button"
              aria-label="关闭知识资产详情"
              onClick={() => {
                setSelected(undefined);
                setResult(undefined);
              }}
            >
              <X size={16} />
            </button>
          </div>
          {selected.metadata && (
            <div className="bot-memory-card-meta">
              {selected.metadata.page_count !== undefined && (
                <span>{selected.metadata.page_count} 个页面</span>
              )}
              {selected.metadata.commit_hash && (
                <span>版本 {selected.metadata.commit_hash.slice(0, 12)}</span>
              )}
            </div>
          )}
          <div className="bot-memory-source-list">
            {selected.document_ids.map((id) => (
              <button
                type="button"
                className="text-button"
                key={id}
                onClick={() => onDocument(id)}
              >
                <FileText size={12} />
                {docs.find((doc) => doc.id === id)?.title || "来源资料"}
              </button>
            ))}
          </div>
          <form
            className="bot-memory-asset-search"
            onSubmit={(event) => {
              event.preventDefault();
              void search();
            }}
          >
            <label className="bot-memory-search">
              <Search size={15} />
              <input
                type="search"
                aria-label="检索知识资产"
                placeholder={
                  selected.kind === "wiki"
                    ? "查找 Wiki 中的主题与结论…"
                    : "搜索函数、类或模块…"
                }
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </label>
            <button
              type="submit"
              className="button primary"
              disabled={!!busy || !ready || !query.trim()}
            >
              检索
            </button>
          </form>
          {!ready && (
            <p className="bot-memory-help">
              知识资产与服务均就绪后可执行检索。
            </p>
          )}
          {selected.kind === "wiki" ? (
            <div className="bot-memory-knowledge-tools">
              <button
                type="button"
                className="text-button"
                disabled={!!busy || !ready}
                onClick={() => void invoke("list_pages", {})}
              >
                查看 Wiki 目录
              </button>
              <button
                type="button"
                className="text-button"
                disabled={!!busy || !ready}
                onClick={() => void invoke("get_graph", {})}
              >
                查看页面关系
              </button>
              <label>
                页面引用
                <input
                  aria-label="Wiki 页面引用"
                  value={reference}
                  onChange={(event) => setReference(event.target.value)}
                  placeholder="从检索结果或目录复制引用"
                />
              </label>
              <button
                type="button"
                className="button small"
                disabled={!!busy || !ready || !reference.trim()}
                onClick={() =>
                  void invoke("read_page", { refs: [reference.trim()] })
                }
              >
                读取页面
              </button>
            </div>
          ) : (
            <form
              className="bot-memory-knowledge-tools"
              onSubmit={(event) => {
                event.preventDefault();
                void invoke(
                  tool,
                  tool === "explore"
                    ? { query: reference.trim() }
                    : tool === "files"
                      ? { path: reference.trim() }
                      : { symbol: reference.trim() },
                );
              }}
            >
              <label>
                分析方式
                <select
                  aria-label="代码图分析方式"
                  value={tool}
                  onChange={(event) => setTool(event.target.value)}
                >
                  <option value="explore">探索代码</option>
                  <option value="callers">查找调用方</option>
                  <option value="callees">查找被调用方</option>
                  <option value="impact">变更影响</option>
                  <option value="node">节点详情</option>
                  <option value="files">关联文件</option>
                </select>
              </label>
              <label>
                分析对象
                <input
                  aria-label="代码图分析对象"
                  value={reference}
                  onChange={(event) => setReference(event.target.value)}
                  placeholder="函数、类或模块"
                />
              </label>
              <button
                type="submit"
                className="button small"
                disabled={!!busy || !ready || !reference.trim()}
              >
                分析
              </button>
            </form>
          )}
          {(busy === "asset-search" || busy === "asset-tool") && (
            <div role="status" className="bot-memory-loading">
              <Loader2 size={18} className="spin" />
              正在读取知识资产…
            </div>
          )}
          {result && (
            <KnowledgeOutput result={result} onDocument={onDocument} />
          )}
        </section>
      )}
    </>
  );
}

function resultText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(resultText).join("\n\n");
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    if (typeof object.text === "string") return object.text;
    if (object.content !== undefined) return resultText(object.content);
  }
  return JSON.stringify(value, null, 2) || "没有返回内容。";
}
function KnowledgeOutput({
  result,
  onDocument,
}: {
  result: KnowledgeResult;
  onDocument: (id: string) => void;
}) {
  const value = result.result;
  const isError = !!(
    value &&
    typeof value === "object" &&
    "isError" in value &&
    value.isError
  );
  return (
    <div className="bot-memory-output" aria-live="polite">
      <h4>{isError ? "查询未完成" : "查询结果"}</h4>
      <div className="markdown">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>
          {resultText(value)}
        </ReactMarkdown>
      </div>
      {!!result.sources?.length && (
        <div className="bot-memory-source-list" aria-label="结果来源">
          {result.sources.map((source) => (
            <button
              key={`${source.document_id}-${source.version}`}
              type="button"
              className="text-button"
              onClick={() => onDocument(source.document_id)}
            >
              <FileText size={12} />
              {source.title} · v{source.version}
            </button>
          ))}
        </div>
      )}
      {result.repository_url && (
        <p className="bot-memory-help">代码来源：{result.repository_url}</p>
      )}
    </div>
  );
}
