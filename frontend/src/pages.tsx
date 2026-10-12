import { useEffect, useRef, useState } from "react";
import {
  ArrowDownToLine,
  ArrowRight,
  ArrowUp,
  Bot,
  Check,
  ChevronRight,
  CircleCheck,
  Code2,
  Copy,
  ExternalLink,
  FileText,
  FolderOpen,
  Globe2,
  KeyRound,
  LoaderCircle,
  LockKeyhole,
  MessageSquare,
  Paperclip,
  Plus,
  RefreshCw,
  Search,
  Server,
  ShieldCheck,
  Sparkles,
  Trash2,
  Upload,
  Users,
  X,
} from "lucide-react";
import { ProductName } from "./ProductName";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { api, bytes, date, post } from "./api";
import { randomUuid } from "./ids";
import { Empty, FileIcon, Modal, Status, Submit } from "./components";
import type {
  ApiKey,
  Citation,
  Department,
  Document,
  Message,
  Space,
  Stats,
  User,
} from "./types";
import type { Confirm, Feedback } from "./App";
import { ProductLogo } from "./ProductLogo";
import {
  QUESTION_FILE_ACCEPT,
  useQuestionAttachments,
} from "./useQuestionAttachments";

export function DocumentsPage({
  user,
  spaces,
  selectedSpace,
  query,
  onQuery,
  revision,
  onDocument,
  onUpload,
  onCreate,
  feedback,
  confirm,
  onDeleted,
}: {
  user: User;
  confirm: Confirm;
  onDeleted: () => Promise<void>;
  spaces: Space[];
  selectedSpace: string;
  query: string;
  onQuery: (v: string) => void;
  revision: number;
  onDocument: (id: string) => void;
  onUpload: () => void;
  onCreate: () => void;
  feedback: Feedback;
}) {
  const [items, setItems] = useState<Document[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [offset, setOffset] = useState(0);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let canceled = false;
    const timeout = window.setTimeout(() => {
      setLoading(true);
      const params = new URLSearchParams({
        limit: "25",
        offset: String(offset),
        q: query,
      });
      if (selectedSpace) params.set("space_id", selectedSpace);
      api<{ items: Document[]; total: number }>(`/api/documents?${params}`)
        .then((result) => {
          if (!canceled) {
            setItems(result.items);
            setTotal(result.total);
          }
        })
        .catch((e) => {
          if (!canceled) feedback((e as Error).message, true);
        })
        .finally(() => {
          if (!canceled) setLoading(false);
        });
    }, 250);
    return () => {
      canceled = true;
      window.clearTimeout(timeout);
    };
  }, [selectedSpace, query, revision, offset, tick, feedback]);
  useEffect(() => setOffset(0), [query, selectedSpace]);
  const space = spaces.find((s) => s.id === selectedSpace);
  const writable = space
    ? space.permissions.can_create
    : spaces.some((s) => s.permissions.can_create);
  return (
    <>
      <div className="page-heading">
        <div>
          <h1>{space?.name || "文档管理"}</h1>
          <p>
            {space?.description || "让散落的资料，成为可被检索和复用的知识。"}
          </p>
        </div>
        <div className="toolbar-actions">
          <button className="button" onClick={onCreate} disabled={!writable}>
            <Plus size={16} />
            创建文档
          </button>
          <button
            className="button primary"
            onClick={onUpload}
            disabled={!writable}
          >
            <Upload size={16} />
            上传资料
          </button>
        </div>
      </div>
      <div className="panel">
        <div className="list-toolbar">
          <div className="list-title">
            全部文档 <span>{total}</span>
          </div>
          <div className="toolbar-actions">
            <div className="field-search">
              <Search size={16} />
              <input
                placeholder="搜索文档标题…"
                aria-label="搜索文档标题"
                value={query}
                onChange={(e) => onQuery(e.target.value)}
              />
              {query && (
                <button
                  className="icon-button"
                  onClick={() => onQuery("")}
                  aria-label="清除搜索"
                >
                  <X size={14} />
                </button>
              )}
            </div>
            <button
              className="icon-button"
              onClick={() => setTick((v) => v + 1)}
              title="刷新文档"
            >
              <RefreshCw size={17} />
            </button>
          </div>
        </div>
        <div className="table-scroll">
          <table className="documents-table">
            <thead>
              <tr>
                <th>文档名称</th>
                <th>知识空间</th>
                <th>索引状态</th>
                <th>创建者</th>
                <th>更新时间</th>
                <th>大小</th>
                <th className="document-actions">操作</th>
              </tr>
            </thead>
            <tbody>
              {items.map((doc) => (
                <tr key={doc.id} onClick={() => onDocument(doc.id)}>
                  <td>
                    <button
                      className="document-name"
                      onClick={(e) => {
                        e.stopPropagation();
                        onDocument(doc.id);
                      }}
                    >
                      <FileIcon mime={doc.mime_type} />
                      <span>
                        <strong>{doc.title}</strong>
                        <small>
                          {doc.filename.split(".").pop()?.toUpperCase()} · v
                          {doc.version}
                        </small>
                      </span>
                    </button>
                  </td>
                  <td>
                    <span className="muted-space">
                      <FolderOpen size={13} />
                      {doc.space_name}
                    </span>
                  </td>
                  <td>
                    <Status value={doc.status} />
                  </td>
                  <td>{doc.author}</td>
                  <td className="date">{date(doc.updated_at)}</td>
                  <td className="date">{bytes(doc.size)}</td>
                  <td className="document-actions">
                    {spaces.some(
                      (s) =>
                        s.id === doc.space_id &&
                        s.permissions.can_create &&
                        (s.permissions.can_manage ||
                          doc.created_by === user.id),
                    ) && (
                      <button
                        className="icon-button danger-text"
                        title="删除文档"
                        aria-label={`删除 ${doc.title}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          confirm(
                            `删除「${doc.title}」？删除后将移除原文件和检索内容。`,
                            async () => {
                              await api(`/api/documents/${doc.id}`, {
                                method: "DELETE",
                              });
                              setItems((v) => v.filter((d) => d.id !== doc.id));
                              setTick((v) => v + 1);
                              feedback("文档已删除");
                              await onDeleted();
                            },
                          );
                        }}
                      >
                        <Trash2 size={16} />
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {loading && !items.length ? (
          <div className="loading">
            <LoaderCircle className="spin" />
            加载文档中…
          </div>
        ) : (
          !items.length && (
            <Empty
              title={query ? "没有找到匹配的文档" : "这里还没有文档"}
              text={
                query ? "换个标题关键词试试" : "上传资料或创建第一份知识文档"
              }
            />
          )
        )}
        <div className="pagination">
          <span>
            共 {total} 份文档{loading ? " · 更新中" : ""}
          </span>
          <div>
            <button
              className="button small-button"
              disabled={offset === 0 || loading}
              onClick={() => setOffset((v) => v - 25)}
            >
              上一页
            </button>
            <span>{Math.floor(offset / 25) + 1}</span>
            <button
              className="button small-button"
              disabled={offset + 25 >= total || loading}
              onClick={() => setOffset((v) => v + 25)}
            >
              下一页
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
export function ChatPage({
  spaces,
  stats,
  onDocument,
  feedback,
}: {
  spaces: Space[];
  stats?: Stats;
  onDocument: (id: string) => void;
  feedback: Feedback;
}) {
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState("");
  const [allowWeb, setAllowWeb] = useState(false);
  const attachments = useQuestionAttachments(feedback);
  const writable = spaces.filter(
    (s) => s.permissions.can_create && s.permissions.can_view,
  );
  const [uploadSpace, setUploadSpace] = useState("");
  const [attachmentMenu, setAttachmentMenu] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const destination =
    writable.find((s) => s.id === uploadSpace)?.id ||
    writable.find((s) => s.id === scope)?.id ||
    writable[0]?.id ||
    "";
  const [messages, setMessages] = useState<Message[]>([]);
  const [busy, setBusy] = useState(false);
  const [conversation, setConversation] = useState<string>();
  const [history, setHistory] = useState<{ id: string; title: string }[]>([]);
  const queryInput = useRef<HTMLTextAreaElement>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const loadHistory = () =>
    api<typeof history>("/api/conversations")
      .then(setHistory)
      .catch((e) => feedback((e as Error).message, true));
  useEffect(() => {
    void loadHistory();
  }, []);
  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, busy]);
  useEffect(() => {
    const input = queryInput.current;
    if (!input) return;
    input.style.height = "0px";
    input.style.height = `${Math.min(120, Math.max(32, input.scrollHeight))}px`;
  }, [query]);
  const ask = async (text = query) => {
    if (
      busy ||
      attachments.blocked ||
      (!text.trim() && !attachments.items.length)
    )
      return;
    text = text.trim() || "请总结附件内容，提炼关键要点并引用来源";
    const currentAttachments = [...attachments.items];
    setBusy(true);
    setAttachmentMenu(false);
    setQuery("");
    setMessages((v) => [
      ...v,
      {
        id: randomUuid(),
        role: "user",
        content:
          text +
          (currentAttachments.length
            ? `\n\n附件：${currentAttachments.map((item) => item.name).join("、")}`
            : ""),
        citations: [],
      },
    ]);
    try {
      const answer = await post<{
        answer: string;
        citations: Citation[];
        conversation_id: string;
        warnings: string[];
        engine: string;
        web_sources: Message["web_sources"];
        tool_calls: Message["tool_calls"];
      }>("/api/chat", {
        query: text,
        space_id: currentAttachments.length ? undefined : scope || undefined,
        document_ids: currentAttachments.length
          ? currentAttachments.map((item) => item.documentId)
          : undefined,
        conversation_id: conversation,
        allow_web: allowWeb,
      });
      setConversation(answer.conversation_id);
      attachments.clear();
      setMessages((v) => [
        ...v,
        {
          id: randomUuid(),
          role: "assistant",
          engine: answer.engine,
          web_sources: answer.web_sources,
          tool_calls: answer.tool_calls,
          content: answer.answer,
          citations: answer.citations,
          warnings: answer.warnings,
        },
      ]);
      void loadHistory();
    } catch (e) {
      feedback((e as Error).message, true);
      setMessages((v) => [
        ...v,
        {
          id: randomUuid(),
          role: "assistant",
          content: `请求未完成：${(e as Error).message}。请重新提问。`,
          citations: [],
        },
      ]);
      setQuery(text);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="chat-layout">
      <aside className="chat-history">
        <button
          className="button"
          disabled={busy || attachments.uploading}
          onClick={() => {
            setMessages([]);
            setConversation(undefined);
            setAllowWeb(false);
            setQuery("");
            attachments.clear();
            setAttachmentMenu(false);
          }}
        >
          <Plus size={16} />
          开启新对话
        </button>
        <div className="nav-label">最近对话</div>
        {history.map((item) => (
          <button
            className={`history-item ${conversation === item.id ? "active" : ""}`}
            key={item.id}
            disabled={busy || attachments.uploading}
            onClick={async () => {
              try {
                setMessages(
                  await api<Message[]>(
                    `/api/conversations/${item.id}/messages`,
                  ),
                );
                setConversation(item.id);
                attachments.clear();
                setAttachmentMenu(false);
              } catch (e) {
                feedback((e as Error).message, true);
              }
            }}
          >
            <MessageSquare size={14} />
            <span>{item.title}</span>
          </button>
        ))}
        {!history.length && (
          <p className="history-empty">你的知识探索会记录在这里</p>
        )}
        <div className="chat-history-footer">
          <ShieldCheck size={16} />
          <p>
            只检索你有权访问的知识
            <br />
            每个答案都可查看来源
          </p>
        </div>
      </aside>
      <div className="chat-main">
        <div className="chat-top">
          <div>
            <Sparkles size={18} />
            <strong>
              <ProductName />
              知识助手
            </strong>
            <span className="tiny-pill">
              {stats?.capabilities.agent ? "Pi Agent + RAG" : "RAG"}
            </span>
          </div>
          <label className="scope-select">
            检索范围
            {attachments.items.length ? (
              <span className="tiny-pill">
                本次附件 · {attachments.items.length} 个
              </span>
            ) : (
              <select
                aria-label="问答检索范围"
                value={scope}
                disabled={busy}
                onChange={(e) => setScope(e.target.value)}
              >
                <option value="">全部可访问知识</option>
                {spaces
                  .filter((s) => s.permissions.can_view)
                  .map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
              </select>
            )}
          </label>
        </div>
        <div className="chat-messages">
          {!messages.length ? (
            <div className="chat-welcome">
              <div className="assistant-orb">
                <ProductLogo decorative />
              </div>
              <div className="eyebrow">ANSWERS GROUNDED IN YOUR KNOWLEDGE</div>
              <h1>团队的知识，随问随答。</h1>
              <p>从一个问题开始，找到资料中的答案与原文依据。</p>
              <div className="question-grid">
                {[
                  "差旅费用的报销流程是什么？",
                  "产品需求评审需要准备哪些材料？",
                  "新同事入职第一周有哪些安排？",
                  "发布出现异常应该如何回滚？",
                ].map((question, i) => (
                  <button key={question} onClick={() => void ask(question)}>
                    <span>
                      {["制度与流程", "产品与研发", "入职指南", "工程实践"][i]}
                    </span>
                    <strong>{question}</strong>
                    <ArrowRight size={16} />
                  </button>
                ))}
              </div>
              <div className="chat-mode">
                <CircleCheck size={14} />
                {stats?.capabilities.chat
                  ? stats.capabilities.agent
                    ? "Pi Agent 问答已启用 · 可自主调用知识库工具"
                    : "生成式问答已启用"
                  : stats?.capabilities.models.chat
                    ? "原文检索模式 · 请在模型配置中启用问答模型并保存"
                    : "原文检索模式 · 配置并启用问答模型后生成回答"}
              </div>
            </div>
          ) : (
            <div className="message-list">
              {messages.map((message) => {
                const citations = message.citations.filter(
                  (c) => c.referenced !== false,
                );
                const webSources =
                  message.web_sources?.filter((s) => s.referenced !== false) ||
                  [];
                return (
                  <article
                    key={message.id}
                    className={`message ${message.role}`}
                  >
                    <div className="message-avatar">
                      {message.role === "assistant" ? (
                        <ProductLogo decorative />
                      ) : (
                        <Users size={18} />
                      )}
                    </div>
                    <div className="message-body">
                      <div className="message-label">
                        {message.role === "assistant" ? (
                          <>
                            <ProductName />
                            知识助手
                          </>
                        ) : (
                          "你"
                        )}
                      </div>
                      <div className="markdown">
                        <Markdown remarkPlugins={[remarkGfm]}>
                          {message.content}
                        </Markdown>
                      </div>
                      {citations.length > 0 && (
                        <div className="citations">
                          <div className="citations-title">
                            <FileText size={14} />
                            参考来源 · {citations.length}
                          </div>
                          <div className="citation-grid">
                            {citations.map((c, i) => (
                              <button
                                key={`${c.chunk_id}-${i}`}
                                onClick={() => onDocument(c.document_id)}
                              >
                                <span className="citation-number">
                                  {c.citation_number ?? i + 1}
                                </span>
                                <div>
                                  <strong>{c.title}</strong>
                                  <small>
                                    第 {c.page} 页 · v{c.version} ·{" "}
                                    {c.kind === "image"
                                      ? "图像来源"
                                      : "原文片段"}
                                  </small>
                                  {c.image_url && (
                                    <img
                                      src={c.image_url}
                                      alt="引用原图"
                                      loading="lazy"
                                    />
                                  )}
                                </div>
                                <ChevronRight size={14} />
                              </button>
                            ))}
                          </div>
                        </div>
                      )}
                      {!!webSources.length && (
                        <div className="web-sources">
                          <div className="citations-title">
                            联网来源 · {webSources.length}
                          </div>
                          {webSources.map((source, index) => (
                            <a
                              key={source.url}
                              href={source.url}
                              target="_blank"
                              rel="noopener noreferrer"
                            >
                              <span>
                                [W{source.citation_number ?? index + 1}]{" "}
                                {source.title || source.url}
                              </span>
                              <small>{new URL(source.url).hostname}</small>
                            </a>
                          ))}
                        </div>
                      )}
                      {!!message.tool_calls?.length && (
                        <details className="tool-trace">
                          <summary>
                            工具调用 · {message.tool_calls.length} 次
                          </summary>
                          <ul>
                            {message.tool_calls.map((tool, index) => (
                              <li key={index}>
                                <span>
                                  {{
                                    knowledge_search: "知识库检索",
                                    knowledge_read: "文档读取",
                                    knowledge_spaces: "空间查询",
                                    web_search: "联网搜索",
                                    web_fetch: "网页读取",
                                  }[tool.name] || tool.name}
                                </span>
                                <span>
                                  {tool.success ? "完成" : "未完成"}
                                  {tool.duration_ms !== undefined &&
                                    ` · ${(tool.duration_ms / 1000).toFixed(1)} 秒`}
                                </span>
                              </li>
                            ))}
                          </ul>
                        </details>
                      )}
                      {message.warnings && (
                        <div className="answer-warnings">
                          {message.warnings.map((w) => (
                            <span key={w}>{w}</span>
                          ))}
                        </div>
                      )}
                    </div>
                  </article>
                );
              })}
              {busy && (
                <div className="message assistant">
                  <div className="message-avatar">
                    <ProductLogo decorative />
                  </div>
                  <div className="thinking">
                    <LoaderCircle size={16} className="spin" />
                    {stats?.capabilities.agent
                      ? "Agent 正在检索资料、调用工具并核对来源…"
                      : "正在检索相关知识并核对来源…"}
                  </div>
                </div>
              )}
              <div ref={bottom} />
            </div>
          )}
        </div>
        <div className="composer-wrap">
          <form
            className="composer"
            onSubmit={(e) => {
              e.preventDefault();
              void ask();
            }}
          >
            {!!attachments.items.length && (
              <div
                className="question-attachments"
                aria-label="问题附件"
                aria-live="polite"
              >
                {attachments.items.map((item) => (
                  <div
                    className={`question-attachment ${item.status === "failed" || item.status === "check_failed" ? "failed" : ""}`}
                    key={item.key}
                  >
                    <FileText size={20} />
                    <div>
                      <strong title={item.name}>{item.name}</strong>
                      <small title={item.error}>
                        {bytes(item.size)} ·{" "}
                        {{
                          uploading: "正在上传",
                          queued: "等待索引",
                          processing: "正在索引",
                          ready: "可用于问答",
                          failed: "处理失败",
                          check_failed: "状态检查失败",
                        }[item.status] || item.status}
                      </small>
                      {item.error && (
                        <small className="attachment-error">{item.error}</small>
                      )}
                    </div>
                    {["uploading", "queued", "processing"].includes(
                      item.status,
                    ) && <LoaderCircle size={15} className="spin" />}
                    {item.status === "check_failed" && (
                      <button
                        type="button"
                        className="icon-button"
                        aria-label={`重新检查 ${item.name}`}
                        onClick={() => attachments.recheck(item.key)}
                      >
                        <RefreshCw size={14} />
                      </button>
                    )}
                    <button
                      type="button"
                      className="icon-button"
                      disabled={busy || attachments.uploading}
                      aria-label={`移除附件 ${item.name}`}
                      title="从问题中移除；已上传的文件仍保留在知识空间"
                      onClick={() => attachments.remove(item.key)}
                    >
                      <X size={14} />
                    </button>
                  </div>
                ))}
                <p>附件已保存到所选知识空间；本次提问仅检索这些附件。</p>
              </div>
            )}
            <textarea
              ref={queryInput}
              rows={1}
              maxLength={2000}
              placeholder="问点什么，一起探索"
              aria-label="向知识库提问"
              onFocus={() => setAttachmentMenu(false)}
              value={query}
              disabled={busy}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (
                  e.key === "Enter" &&
                  !e.shiftKey &&
                  !e.nativeEvent.isComposing
                ) {
                  e.preventDefault();
                  void ask();
                }
              }}
            />
            <div className="composer-bottom">
              <input
                ref={fileInput}
                className="hidden"
                type="file"
                multiple
                accept={QUESTION_FILE_ACCEPT}
                aria-label="选择问答附件"
                onChange={(e) => {
                  const files = Array.from(e.target.files || []);
                  e.target.value = "";
                  if (busy) return;
                  setAttachmentMenu(false);
                  void attachments.add(files, destination);
                }}
              />
              <div className="composer-tools">
                <div className="attachment-control">
                  <button
                    type="button"
                    className={`composer-attach ${attachmentMenu ? "active" : ""}`}
                    aria-label="上传文件"
                    aria-expanded={attachmentMenu}
                    disabled={
                      busy ||
                      attachments.uploading ||
                      !writable.length ||
                      attachments.items.length >= 10
                    }
                    title={
                      writable.length
                        ? "上传文件，索引后围绕附件提问"
                        : "暂无可创建且可查看的知识空间"
                    }
                    onClick={() => setAttachmentMenu((v) => !v)}
                  >
                    <Paperclip size={20} />
                  </button>
                  {attachmentMenu && (
                    <div
                      className="attachment-menu"
                      role="region"
                      aria-label="上传问答附件"
                    >
                      <div className="attachment-menu-head">
                        <strong>添加文件</strong>
                        <button
                          type="button"
                          className="icon-button"
                          aria-label="关闭附件菜单"
                          onClick={() => setAttachmentMenu(false)}
                        >
                          <X size={15} />
                        </button>
                      </div>
                      <label>
                        保存到知识空间
                        <select
                          aria-label="附件保存空间"
                          value={destination}
                          onChange={(e) => setUploadSpace(e.target.value)}
                        >
                          {writable.map((space) => (
                            <option key={space.id} value={space.id}>
                              {space.name}
                            </option>
                          ))}
                        </select>
                      </label>
                      <p>
                        PDF、Word、Excel、PPTX、文本及图片
                        <br />
                        单个文件最大 500 MB，每次最多 10 个
                      </p>
                      <p>文件将保存至知识库，空间内有查看权限的成员可访问。</p>
                      <button
                        type="button"
                        className="button primary"
                        onClick={() => fileInput.current?.click()}
                      >
                        <Upload size={15} />
                        选择文件
                      </button>
                    </div>
                  )}
                </div>
                <div
                  className="composer-modes"
                  role="group"
                  aria-label="问答模式"
                >
                  <button
                    type="button"
                    className={`composer-pill ${!allowWeb ? "selected" : ""}`}
                    aria-pressed={!allowWeb}
                    disabled={busy}
                    title="只使用权限范围内的知识库资料"
                    onClick={() => setAllowWeb(false)}
                  >
                    <Bot size={16} />
                    知识问答
                  </button>
                  {stats?.capabilities.web && (
                    <button
                      type="button"
                      className={`composer-pill ${allowWeb ? "selected" : ""}`}
                      aria-pressed={allowWeb}
                      disabled={busy}
                      title="结合知识库与联网搜索回答，允许发送公开检索词并读取网页"
                      onClick={() => setAllowWeb(true)}
                    >
                      <Globe2 size={16} />
                      智能搜索
                    </button>
                  )}
                </div>
              </div>
              <button
                className="send-button"
                disabled={
                  busy ||
                  attachments.blocked ||
                  (!query.trim() && !attachments.items.length)
                }
                aria-label="发送问题"
              >
                {busy ? (
                  <LoaderCircle size={18} className="spin" />
                ) : (
                  <ArrowUp size={23} />
                )}
              </button>
            </div>
          </form>
          <small className="composer-note">
            回答仅供参考，请以引用原文为准。Enter 发送，Shift + Enter 换行。
          </small>
        </div>
      </div>
    </div>
  );
}
export function IntegrationPage({
  stats,
  feedback,
  confirm,
}: {
  stats?: Stats;
  feedback: Feedback;
  confirm: Confirm;
}) {
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [modal, setModal] = useState(false);
  const [newKey, setNewKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState("mcp");
  const load = () =>
    api<ApiKey[]>("/api/keys")
      .then(setKeys)
      .catch((e) => feedback((e as Error).message, true));
  useEffect(() => {
    void load();
  }, []);
  const mcp = JSON.stringify(
    {
      mcpServers: {
        atlas: {
          url: `${window.location.origin}/mcp`,
          headers: { Authorization: `Bearer ${newKey || "YOUR_API_KEY"}` },
        },
      },
    },
    null,
    2,
  );
  const rest = `curl ${window.location.origin}/api/search \\\n  -H 'Authorization: Bearer ${newKey || "YOUR_API_KEY"}' \\\n  -H 'Content-Type: application/json' \\\n  -d '{"query":"报销流程","limit":5}'`;
  const copy = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      feedback("已复制到剪贴板");
    } catch {
      feedback("复制失败，请手动选择复制", true);
    }
  };
  return (
    <>
      <div className="page-heading">
        <div>
          <h1>Agent 接入</h1>
          <p>让 AI Agent 在授权范围内，直接调用团队知识。</p>
        </div>
        <button className="button primary" onClick={() => setModal(true)}>
          <Plus size={16} />
          创建 API 密钥
        </button>
      </div>
      <div className="integration-hero">
        <div className="integration-icon">
          <Bot size={32} />
        </div>
        <div>
          <span className="eyebrow">KNOWLEDGE AS A CAPABILITY</span>
          <h2>一个接口，连接你的 AI 工作流。</h2>
          <p>
            标准 MCP Streamable HTTP 与 REST
            API，支持检索、问答、读取文档和创建知识。
          </p>
        </div>
        <span className="protocol-badge">
          <span className="live-dot" />
          MCP / REST
        </span>
      </div>
      <div className="integration-columns">
        <div className="panel code-panel">
          <div className="tabs">
            <button
              className={tab === "mcp" ? "active" : ""}
              onClick={() => setTab("mcp")}
            >
              <Code2 size={15} />
              MCP 配置
            </button>
            <button
              className={tab === "rest" ? "active" : ""}
              onClick={() => setTab("rest")}
            >
              <Server size={15} />
              REST 调用
            </button>
          </div>
          <div className="code-description">
            {tab === "mcp"
              ? "将下面的配置加入支持远程 HTTP MCP 的 Agent 客户端。"
              : "使用 Bearer 密钥调用 API，结果包含原文、页码和文档引用。"}
          </div>
          <div className="code-block">
            <button
              className="copy-code"
              onClick={() => void copy(tab === "mcp" ? mcp : rest)}
            >
              <Copy size={14} />
              复制
            </button>
            <pre>{tab === "mcp" ? mcp : rest}</pre>
          </div>
          <div className="code-links">
            <a href="/api/openapi.json" target="_blank" rel="noreferrer">
              查看 OpenAPI 规范 <ExternalLink size={13} />
            </a>
            <span>
              {stats?.capabilities.semantic
                ? "混合检索已启用"
                : "当前使用关键词检索"}
            </span>
          </div>
        </div>
        <div className="panel tool-panel">
          <h3>可调用的知识能力</h3>
          {[
            { name: "knowledge_search", text: "图文检索，返回原文与来源" },
            { name: "knowledge_answer", text: "基于授权资料回答问题" },
            { name: "knowledge_read", text: "读取文档及解析内容" },
            { name: "knowledge_spaces", text: "列出可访问的知识空间" },
            { name: "knowledge_create", text: "创建文档并建立索引" },
          ].map((tool) => (
            <div className="tool-row" key={tool.name}>
              <Check size={14} />
              <div>
                <code>{tool.name}</code>
                <small>{tool.text}</small>
              </div>
            </div>
          ))}
        </div>
      </div>
      <div className="section-heading">
        <h2>
          我的 API 密钥 <span>{keys.filter((k) => !k.revoked).length}</span>
        </h2>
        <span className="section-note">
          <ShieldCheck size={14} />
          密钥权限随账号授权实时变化
        </span>
      </div>
      <div className="panel table-scroll">
        <table>
          <thead>
            <tr>
              <th>密钥名称</th>
              <th>标识</th>
              <th>调用范围</th>
              <th>有效期</th>
              <th>最近使用</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {keys.map((key) => (
              <tr key={key.id}>
                <td>
                  <span className="key-name">
                    <KeyRound size={16} />
                    {key.name}
                    {!!key.revoked && (
                      <small className="revoked-label">已撤销</small>
                    )}
                  </span>
                </td>
                <td>
                  <code>{key.prefix}…</code>
                </td>
                <td>
                  <div className="scope-chips">
                    {key.scopes.map((s) => (
                      <span key={s}>{s}</span>
                    ))}
                  </div>
                </td>
                <td className="date">{date(key.expires_at)}</td>
                <td className="date">
                  {key.last_used_at ? date(key.last_used_at) : "尚未使用"}
                </td>
                <td>
                  <button
                    className="text-button danger-text"
                    disabled={!!key.revoked}
                    onClick={() =>
                      confirm(
                        `撤销「${key.name}」？使用此密钥的 Agent 将立即失去访问能力。`,
                        async () => {
                          await api(`/api/keys/${key.id}`, {
                            method: "DELETE",
                          });
                          feedback("API 密钥已撤销");
                          await load();
                        },
                      )
                    }
                  >
                    撤销
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!keys.length && (
          <Empty
            title="尚未创建 API 密钥"
            text="为每个 Agent 单独创建密钥，方便限定范围与追踪调用"
          />
        )}
      </div>
      {modal && (
        <Modal title="创建 API 密钥" onClose={() => setModal(false)}>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              const data = new FormData(e.currentTarget);
              setBusy(true);
              try {
                const result = await post<{ key: string }>("/api/keys", {
                  name: data.get("name"),
                  expires_days: Number(data.get("days")),
                  scopes: data.getAll("scopes"),
                });
                setNewKey(result.key);
                setModal(false);
                await load();
              } catch (e) {
                feedback((e as Error).message, true);
              } finally {
                setBusy(false);
              }
            }}
          >
            <label>
              密钥名称
              <input
                name="name"
                required
                maxLength={100}
                placeholder="例如：客服知识助手"
                autoFocus
              />
            </label>
            <label>
              有效期
              <select name="days">
                <option value="30">30 天</option>
                <option value="90">90 天</option>
                <option value="365">365 天</option>
              </select>
            </label>
            <fieldset>
              <legend>允许的调用范围</legend>
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  name="scopes"
                  value="search.read"
                  defaultChecked
                />
                搜索与知识问答
              </label>
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  name="scopes"
                  value="document.read"
                  defaultChecked
                />
                读取与下载文档
              </label>
              <label className="checkbox-label">
                <input type="checkbox" name="scopes" value="document.write" />
                创建与更新文档
              </label>
            </fieldset>
            <div className="notice">
              <ShieldCheck size={16} />
              <span>
                密钥继承你的知识权限，不能管理成员、修改授权或创建其他密钥。
              </span>
            </div>
            <div className="form-actions">
              <button
                type="button"
                className="button"
                onClick={() => setModal(false)}
              >
                取消
              </button>
              <Submit busy={busy}>创建密钥</Submit>
            </div>
          </form>
        </Modal>
      )}
      {newKey && (
        <Modal title="密钥已创建" onClose={() => setNewKey("")}>
          <div className="key-success">
            <CircleCheck size={35} />
            <h3>请现在保存你的密钥</h3>
            <p>完整密钥仅展示这一次，关闭后无法再次查看。</p>
          </div>
          <div className="secret-key">
            <code>{newKey}</code>
            <button
              className="icon-button"
              title="复制密钥"
              onClick={() => void copy(newKey)}
            >
              <Copy size={18} />
            </button>
          </div>
          <button
            className="button primary full-button"
            onClick={async () => {
              await copy(mcp);
            }}
          >
            复制完整 MCP 配置
          </button>
          <div className="form-actions">
            <button className="button" onClick={() => setNewKey("")}>
              我已保存，关闭
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}
export function OrganizationPage({
  feedback,
  confirm,
}: {
  feedback: Feedback;
  confirm: Confirm;
}) {
  const [data, setData] = useState<{
    users: User[];
    departments: Department[];
  }>({ users: [], departments: [] });
  const [modal, setModal] = useState<"user" | "department">();
  const [editing, setEditing] = useState<User>();
  const [editingDepartment, setEditingDepartment] = useState<Department>();
  const [filter, setFilter] = useState("");
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const load = () =>
    api<typeof data>("/api/organization")
      .then(setData)
      .catch((e) => feedback((e as Error).message, true));
  useEffect(() => {
    void load();
  }, []);
  const close = () => {
    setModal(undefined);
    setEditing(undefined);
    setEditingDepartment(undefined);
  };
  const renderTree = (parent: string | null, depth = 0): React.ReactNode =>
    data.departments
      .filter((d) => d.parent_id === parent)
      .map((d) => (
        <div key={d.id}>
          <div className={`department-item ${filter === d.id ? "active" : ""}`}>
            <button
              style={{ paddingLeft: 14 + depth * 18 }}
              onClick={() => setFilter(d.id)}
            >
              <FolderOpen size={15} />
              <span>{d.name}</span>
              <small>
                {data.users.filter((u) => u.department_id === d.id).length}
              </small>
            </button>
            <button
              className="icon-button"
              title={`编辑${d.name}`}
              onClick={() => {
                setEditingDepartment(d);
                setModal("department");
              }}
            >
              <SettingsMini />
            </button>
          </div>
          {renderTree(d.id, depth + 1)}
        </div>
      ));
  const shown = data.users.filter(
    (u) =>
      (!filter || u.department_id === filter) &&
      `${u.name}${u.email}`.toLowerCase().includes(query.toLowerCase()),
  );
  return (
    <>
      <div className="page-heading">
        <div>
          <h1>成员与组织</h1>
          <p>建立组织层级与汇报关系，为知识权限提供清晰的基础。</p>
        </div>
        <div className="toolbar-actions">
          <button className="button" onClick={() => setModal("department")}>
            <Plus size={16} />
            添加部门
          </button>
          <button className="button primary" onClick={() => setModal("user")}>
            <Users size={16} />
            添加成员
          </button>
        </div>
      </div>
      <div className="organization-layout">
        <aside className="panel department-tree">
          <h3>组织架构</h3>
          <button
            className={`all-members ${!filter ? "active" : ""}`}
            onClick={() => setFilter("")}
          >
            <Users size={16} />
            全部成员 <span>{data.users.length}</span>
          </button>
          {renderTree(null)}
          {!data.departments.length && (
            <p className="history-empty">添加部门以建立组织层级</p>
          )}
          <div className="tree-note">
            <ShieldCheck size={15} />
            部门授权可包含所有下级部门；汇报授权可包含直属或全部下属。
          </div>
        </aside>
        <div className="panel members-panel">
          <div className="list-toolbar">
            <div className="list-title">
              {data.departments.find((d) => d.id === filter)?.name ||
                "全部成员"}{" "}
              <span>{shown.length}</span>
            </div>
            <div className="field-search">
              <Search size={15} />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="搜索姓名或邮箱"
                aria-label="搜索成员"
              />
            </div>
          </div>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>成员</th>
                  <th>所属部门</th>
                  <th>直属上级</th>
                  <th>角色</th>
                  <th>状态</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((user) => (
                  <tr key={user.id}>
                    <td>
                      <div className="member-identity">
                        <div className="avatar">{user.name.slice(-2)}</div>
                        <span>
                          <strong>{user.name}</strong>
                          <small>{user.email}</small>
                        </span>
                      </div>
                    </td>
                    <td>
                      {data.departments.find((d) => d.id === user.department_id)
                        ?.name || "未分配"}
                    </td>
                    <td>
                      {data.users.find((u) => u.id === user.manager_id)?.name ||
                        "—"}
                    </td>
                    <td>
                      <span
                        className={`role-badge ${user.role === "admin" ? "admin" : ""}`}
                      >
                        {user.role === "admin" ? "管理员" : "成员"}
                      </span>
                    </td>
                    <td>
                      <span
                        className={`status ${user.active ? "ready" : "failed"}`}
                      >
                        {user.active ? "正常" : "已停用"}
                      </span>
                    </td>
                    <td>
                      <div className="member-actions">
                        <button
                          className="text-button"
                          onClick={() => {
                            setEditing(user);
                            setModal("user");
                          }}
                        >
                          编辑
                        </button>
                        <button
                          className="text-button danger-text"
                          onClick={() =>
                            confirm(
                              `${user.active ? "停用" : "启用"}「${user.name}」的账号？${user.active ? "停用后会话与 Agent 调用将立即失效。" : ""}`,
                              async () => {
                                await api(`/api/users/${user.id}`, {
                                  method: "PUT",
                                  body: JSON.stringify({
                                    ...user,
                                    active: !user.active,
                                  }),
                                });
                                feedback("成员状态已更新");
                                await load();
                              },
                            )
                          }
                        >
                          {user.active ? "停用" : "启用"}
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!shown.length && <Empty title="没有匹配的成员" />}
        </div>
      </div>
      {modal === "department" && (
        <Modal
          title={editingDepartment ? "编辑部门" : "添加部门"}
          onClose={close}
        >
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              const form = new FormData(e.currentTarget);
              setBusy(true);
              try {
                await api(
                  editingDepartment
                    ? `/api/departments/${editingDepartment.id}`
                    : "/api/departments",
                  {
                    method: editingDepartment ? "PUT" : "POST",
                    body: JSON.stringify({
                      name: form.get("name"),
                      parent_id: form.get("parent") || null,
                    }),
                  },
                );
                feedback("部门已保存");
                close();
                await load();
              } catch (e) {
                feedback((e as Error).message, true);
              } finally {
                setBusy(false);
              }
            }}
          >
            <label>
              部门名称
              <input
                name="name"
                defaultValue={editingDepartment?.name}
                required
                maxLength={100}
                autoFocus
              />
            </label>
            <label>
              上级部门
              <select
                name="parent"
                defaultValue={editingDepartment?.parent_id || ""}
              >
                <option value="">无，作为一级部门</option>
                {data.departments
                  .filter((d) => d.id !== editingDepartment?.id)
                  .map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name}
                    </option>
                  ))}
              </select>
            </label>
            <div className="form-actions">
              <button type="button" className="button" onClick={close}>
                取消
              </button>
              <Submit busy={busy}>保存部门</Submit>
            </div>
          </form>
        </Modal>
      )}
      {modal === "user" && (
        <Modal title={editing ? "编辑成员" : "添加企业成员"} onClose={close}>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              const form = new FormData(e.currentTarget);
              setBusy(true);
              try {
                await api(editing ? `/api/users/${editing.id}` : "/api/users", {
                  method: editing ? "PUT" : "POST",
                  body: JSON.stringify({
                    name: form.get("name"),
                    email: form.get("email"),
                    password: form.get("password") || undefined,
                    department_id: form.get("department") || null,
                    manager_id: form.get("manager") || null,
                    role: form.get("role"),
                    active: form.has("active"),
                  }),
                });
                feedback("成员信息已保存");
                close();
                await load();
              } catch (e) {
                feedback((e as Error).message, true);
              } finally {
                setBusy(false);
              }
            }}
          >
            <div className="form-grid">
              <label>
                姓名
                <input
                  name="name"
                  defaultValue={editing?.name}
                  required
                  maxLength={100}
                  autoFocus
                />
              </label>
              <label>
                角色
                <select name="role" defaultValue={editing?.role || "member"}>
                  <option value="member">企业成员</option>
                  <option value="admin">企业管理员</option>
                </select>
              </label>
            </div>
            <label>
              企业邮箱
              <input
                type="email"
                name="email"
                defaultValue={editing?.email}
                disabled={!!editing}
                required
              />
            </label>
            <label>
              {editing ? "重置密码（留空则保留）" : "初始密码"}
              <input
                type="password"
                name="password"
                minLength={1}
                maxLength={128}
                required={!editing}
                autoComplete="new-password"
                placeholder="请输入密码，长度不限（最多 128 字符）"
              />
            </label>
            <div className="form-grid">
              <label>
                所属部门
                <select
                  name="department"
                  defaultValue={editing?.department_id || filter || ""}
                >
                  <option value="">未分配</option>
                  {data.departments.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                直属上级
                <select name="manager" defaultValue={editing?.manager_id || ""}>
                  <option value="">无直属上级</option>
                  {data.users
                    .filter((u) => u.active && u.id !== editing?.id)
                    .map((u) => (
                      <option key={u.id} value={u.id}>
                        {u.name}
                      </option>
                    ))}
                </select>
              </label>
            </div>
            <label className="checkbox-label">
              <input
                type="checkbox"
                name="active"
                defaultChecked={editing?.active ?? true}
              />
              账号启用
            </label>
            <div className="form-actions">
              <button type="button" className="button" onClick={close}>
                取消
              </button>
              <Submit busy={busy}>保存成员</Submit>
            </div>
          </form>
        </Modal>
      )}
    </>
  );
}
function SettingsMini() {
  return <Code2 size={13} />;
}
const auditNames: Record<string, string> = {
  "auth.login": "账号登录",
  "space.create": "创建空间",
  "space.permissions.update": "修改权限",
  "department.create": "添加部门",
  "department.update": "更新部门",
  "user.create": "添加成员",
  "user.update": "更新成员",
  "document.create": "创建文档",
  "document.read": "读取文档",
  "document.download": "下载文档",
  "document.delete": "删除文档",
  "document.reindex": "重新索引",
  "document.version.create": "上传新版本",
  "search.query": "知识检索",
  "rag.answer": "知识问答",
  "api_key.create": "创建密钥",
  "api_key.revoke": "撤销密钥",
};
export function RecordsPage({
  kind,
  revision,
  feedback,
  onDocument,
}: {
  kind: "jobs" | "audit";
  revision: number;
  feedback: Feedback;
  onDocument: (id: string) => void;
}) {
  const [rows, setRows] = useState<Record<string, unknown>[]>([]);
  const [tick, setTick] = useState(0);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    setLoading(true);
    api<Record<string, unknown>[]>(
      `/api/${kind === "audit" ? "audit" : "jobs"}?limit=50&offset=${offset}`,
    )
      .then(setRows)
      .catch((e) => feedback((e as Error).message, true))
      .finally(() => setLoading(false));
  }, [kind, revision, tick, offset, feedback]);
  return (
    <>
      <div className="page-heading">
        <div>
          <h1>{kind === "jobs" ? "索引任务" : "审计日志"}</h1>
          <p>
            {kind === "jobs"
              ? "跟踪解析、切分与向量索引，失败任务自动重试三次。"
              : "记录知识访问、成员变更与 Agent 调用，让关键操作可追溯。"}
          </p>
        </div>
        <button className="button" onClick={() => setTick((v) => v + 1)}>
          <RefreshCw size={16} className={loading ? "spin" : ""} />
          刷新记录
        </button>
      </div>
      <div className="panel table-scroll">
        <table>
          <thead>
            <tr>
              {(kind === "jobs"
                ? ["文档", "版本", "任务状态", "尝试次数", "创建时间", "详情"]
                : ["操作", "执行成员", "来源", "时间", "详情"]
              ).map((label) => (
                <th key={label}>{label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={String(row.id)}>
                {kind === "jobs" ? (
                  <>
                    <td>
                      <button
                        className="document-name"
                        onClick={() => onDocument(String(row.document_id))}
                      >
                        <FileIcon mime="text/plain" />
                        <strong>{String(row.title)}</strong>
                      </button>
                    </td>
                    <td>v{String(row.version)}</td>
                    <td>
                      <Status value={String(row.status)} />
                    </td>
                    <td>{String(row.attempts)} / 3</td>
                    <td className="date">{date(Number(row.created_at))}</td>
                    <td
                      className="record-detail"
                      title={String(row.error || "")}
                    >
                      {row.error
                        ? String(row.error)
                        : row.finished_at
                          ? "处理完成"
                          : "等待处理"}
                    </td>
                  </>
                ) : (
                  <>
                    <td>
                      <span className="audit-action">
                        <ShieldCheck size={15} />
                        {auditNames[String(row.action)] || String(row.action)}
                      </span>
                    </td>
                    <td>{String(row.actor_name || "系统")}</td>
                    <td>
                      {(row.details as Record<string, unknown>)?.api_key_id ? (
                        <span className="role-badge">Agent API</span>
                      ) : (
                        <span className="role-badge">Web / 服务</span>
                      )}
                    </td>
                    <td className="date">{date(Number(row.created_at))}</td>
                    <td className="record-detail">
                      <code>{JSON.stringify(row.details)}</code>
                    </td>
                  </>
                )}
              </tr>
            ))}
          </tbody>
        </table>
        {!rows.length && (
          <Empty title={loading ? "正在加载记录…" : "暂无记录"} />
        )}
        <div className="pagination">
          <span>
            {kind === "jobs"
              ? "展示最近 100 条索引任务"
              : `第 ${Math.floor(offset / 50) + 1} 页 · 每页 50 条`}
          </span>
          {kind === "audit" && (
            <div>
              <button
                className="button small-button"
                disabled={offset === 0}
                onClick={() => setOffset((v) => v - 50)}
              >
                上一页
              </button>
              <button
                className="button small-button"
                disabled={rows.length < 50}
                onClick={() => setOffset((v) => v + 50)}
              >
                下一页
              </button>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
export function SystemPage({
  stats,
  isAdmin,
  onConfigureModels,
}: {
  stats?: Stats;
  isAdmin: boolean;
  onConfigureModels: () => void;
}) {
  return (
    <>
      <div className="page-heading">
        <div>
          <h1>{isAdmin ? "系统状态" : "使用说明"}</h1>
          <p>了解当前知识库能力与接入状态。</p>
        </div>
        <span className="status ready">
          <CircleCheck size={14} />
          服务已连接
        </span>
      </div>
      <div className="system-grid">
        {[
          {
            title: "数据与存储",
            icon: Server,
            rows: [
              ["数据库", stats?.capabilities.database],
              ["文件存储", stats?.capabilities.storage],
              ["组织权限", "部门树 / 汇报关系 / 用户授权"],
              ["审计", "访问与变更日志"],
            ],
          },
          {
            title: "AI 模型能力",
            icon: Sparkles,
            rows: [
              [
                "语义检索",
                stats?.capabilities.semantic
                  ? stats.capabilities.models.embedding
                  : stats?.capabilities.models.embedding
                    ? "已配置但未启用 · 使用关键词检索"
                    : "未配置 · 使用关键词检索",
              ],
              [
                "图像理解",
                stats?.capabilities.vision
                  ? stats.capabilities.models.vision
                  : stats?.capabilities.models.vision
                    ? "已配置但未启用 · 图像索引暂停"
                    : "未配置 · 图像索引暂未启用",
              ],
              [
                "知识问答",
                stats?.capabilities.chat
                  ? stats.capabilities.models.chat
                  : stats?.capabilities.models.chat
                    ? "已配置但未启用 · 展示原文片段"
                    : "未配置 · 展示原文片段",
              ],
              [
                "企业 SSO",
                stats?.capabilities.sso ? "OIDC 已配置" : "本地账号登录",
              ],
            ],
          },
        ].map((card) => (
          <section className="panel system-card" key={card.title}>
            <h2>
              <card.icon size={19} />
              {card.title}
            </h2>
            {card.rows.map(([label, value]) => (
              <div key={label}>
                <span>{label}</span>
                <strong>{value || "—"}</strong>
              </div>
            ))}
          </section>
        ))}
      </div>
      <section className="panel getting-started">
        <h2>
          开始使用
          <ProductName />
        </h2>
        <div className="guide-steps">
          {[
            {
              number: "01",
              title: "组织你的知识",
              text: "管理员创建空间，在权限设置中授权部门或成员；成员将资料上传到可创建的空间。",
            },
            {
              number: "02",
              title: "等待索引完成",
              text: "支持 PDF、Office、Markdown、表格与常见图片。任务完成后，在文档详情中核对解析结果。",
            },
            {
              number: "03",
              title: "提问与核对来源",
              text: "在智能问答中选择检索范围，输入问题。点击参考来源，查看原文、页码与图像。",
            },
            {
              number: "04",
              title: "连接 AI Agent",
              text: "创建权限受限的 API 密钥，通过 MCP 或 REST 接入。可以随时撤销密钥，停止访问。",
            },
          ].map((step) => (
            <div key={step.number}>
              <span>{step.number}</span>
              <h3>{step.title}</h3>
              <p>{step.text}</p>
            </div>
          ))}
        </div>
      </section>
      {isAdmin && (
        <div className="panel settings-entry">
          <div>
            <h3>统一模型设置</h3>
            <p>问答、向量、视觉、生图和视频模型在设置菜单中集中管理。</p>
          </div>
          <button className="button" onClick={onConfigureModels}>
            前往模型设置
          </button>
        </div>
      )}
    </>
  );
}
