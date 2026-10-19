import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowUp,
  Brush,
  Check,
  ChevronDown,
  Download,
  Expand,
  Eraser,
  Film,
  FolderOpen,
  Globe2,
  ImagePlus,
  LoaderCircle,
  MessageSquare,
  PanelLeft,
  Plus,
  Palette,
  Paperclip,
  ScanLine,
  Search,
  RefreshCw,
  SlidersHorizontal,
  Sparkles,
  WandSparkles,
  X,
} from "lucide-react";
import { api, post, bytes } from "./api";
import { randomUuid } from "./ids";
import { ImagePreview } from "./ImagePreview";
import { ProductLogo } from "./ProductLogo";
import { StudioOptionsPopover } from "./StudioOptionsPopover";
import { StudioAttachments, useStudioAttachments } from "./StudioAttachments";
import { StudioMaskEditor } from "./StudioMaskEditor";
import {
  removeStudioAttachment,
  reuseStudioAsset,
  studioAttachmentUrl,
  uploadStudioAttachment,
  type StudioAttachment,
  type StudioOperation,
  type StudioUploadPolicy,
} from "./studio-api";
import "./studio.css";
import type { User } from "./types";
import {
  StudioConversation,
  type StudioMessage,
  type StudioJob as Job,
  type StudioAsset as Asset,
} from "./StudioConversation";
import type { Feedback } from "./App";

type Capabilities = {
  agent: boolean;
  web: boolean;
  attachments?: StudioUploadPolicy;
  image_edit?: boolean;
  models: {
    id: string;
    name: string;
    kind: "image" | "video";
    model: string;
  }[];
  default_image_id: string | null;
  default_video_id: string | null;
  image: { enabled: boolean; model: string };
  video: { enabled: boolean; model: string };
};
type ProjectView = {
  project: { id: string; title: string };
  messages: StudioMessage[];
  jobs: Job[];
  assets: Asset[];
};
const STYLES = [
  { id: "", name: "不指定风格", color: "#e9eef8" },
  { id: "portrait", name: "人像摄影", color: "#d9c4af" },
  { id: "cinematic", name: "电影写真", color: "#2e4b62" },
  { id: "chinese", name: "中国风", color: "#a75944" },
  { id: "anime", name: "动漫", color: "#b6b8ef" },
  { id: "3d", name: "3D 渲染", color: "#a8d8cd" },
  { id: "cyberpunk", name: "赛博朋克", color: "#aa69c4" },
  { id: "cg", name: "CG 动画", color: "#4baac2" },
  { id: "ink", name: "水墨画", color: "#8b9691" },
  { id: "oil", name: "油画", color: "#ca9b62" },
  { id: "classic", name: "古典", color: "#8a7770" },
  { id: "watercolor", name: "水彩画", color: "#efb8cc" },
  { id: "cartoon", name: "卡通", color: "#edca72" },
];
const OPERATIONS = [
  {
    id: "generate" as const,
    name: "自由创作",
    icon: Sparkles,
    instruction: "",
    description: "从描述、参考图或资料开始",
  },
  {
    id: "remove_background" as const,
    name: "AI 抠图",
    icon: ScanLine,
    instruction: "去除参考图背景，完整保留主体和边缘细节，输出透明背景。",
    description: "分离主体，去除背景",
  },
  {
    id: "erase" as const,
    name: "擦除",
    icon: Eraser,
    instruction:
      "擦除参考图中标记的区域，并根据周围画面自然补全，保留其他内容。",
    description: "涂抹去除多余对象",
  },
  {
    id: "edit" as const,
    name: "标记改图",
    icon: Brush,
    instruction: "按要求修改参考图中标记的区域，尽量保留未标记的区域。",
    description: "局部调整画面与内容",
  },
  {
    id: "expand" as const,
    name: "扩图",
    icon: Expand,
    instruction:
      "将参考图扩展至选择的画幅，自然补全原画面边缘外的内容，保留主体与原有风格。",
    description: "延伸画面，适配新画幅",
  },
  {
    id: "upscale" as const,
    name: "变清晰",
    icon: WandSparkles,
    instruction:
      "提高参考图清晰度，修复模糊和噪点，保留主体、构图和原始细节，不添加多余内容。",
    description: "改善模糊与细节",
  },
];
const readDraft = (userId: string): Record<string, unknown> => {
  try {
    return JSON.parse(
      localStorage.getItem(`atlas:studio:draft:${userId}`) || "{}",
    );
  } catch {
    return {};
  }
};
/** 管理私人创作对话、乐观消息与生成作品，发送后立即进入对话。 */
export function StudioPage({
  user,
  feedback,
  onDocument,
  onConfigureAgent,
  onConfigureModels,
}: {
  user: User;
  feedback: Feedback;
  onDocument: (id: string) => void;
  onConfigureAgent: () => void;
  onConfigureModels: () => void;
}) {
  const [capabilities, setCapabilities] = useState<Capabilities>();
  const [projects, setProjects] = useState<{ id: string; title: string }[]>([]);
  const [selected, setSelected] = useState("");
  const [historyOpen, setHistoryOpen] = useState(false);
  const [view, setView] = useState<ProjectView>();
  const [recentViews, setRecentViews] = useState<ProjectView[]>([]);
  const [recentError, setRecentError] = useState(false);
  const [recentLoading, setRecentLoading] = useState(false);
  const works = useRef<HTMLDivElement>(null);
  const promptInput = useRef<HTMLTextAreaElement>(null);
  const [prompt, setPrompt] = useState(() => {
    const value = readDraft(user.id).prompt;
    return typeof value === "string" ? value : "";
  });
  const [kind, setKind] = useState<"image" | "video" | "auto">("image");
  const [imageSize, setImageSize] = useState("1024x1024");
  const [videoSize, setVideoSize] = useState("1280x720");
  const [seconds, setSeconds] = useState(4);
  const [allowWeb, setAllowWeb] = useState(false);
  const [options, setOptions] = useState<"models" | "parameters" | "styles">();
  const [style, setStyle] = useState(() => {
    const value = readDraft(user.id).style;
    return typeof value === "string" && STYLES.some((row) => row.id === value)
      ? value
      : "";
  });
  const [quality, setQuality] = useState("auto");
  const [operation, setOperation] = useState<StudioOperation>("generate");
  const attachments = useStudioAttachments(capabilities?.attachments);
  const fileInput = useRef<HTMLInputElement>(null);
  const dragDepth = useRef(0);
  const [dragging, setDragging] = useState(false);
  const [mask, setMask] = useState<{
    attachment: StudioAttachment;
    sourceId: string;
  }>();
  const maskRef = useRef(mask);
  maskRef.current = mask;
  useEffect(
    () => () => {
      if (maskRef.current)
        void removeStudioAttachment(maskRef.current.attachment.id).catch(
          () => undefined,
        );
    },
    [],
  );
  const [maskEditor, setMaskEditor] = useState(false);
  const [reusing, setReusing] = useState("");
  const [workSearch, setWorkSearch] = useState("");
  const [workFilter, setWorkFilter] = useState("all");
  const mainImage = attachments.ready.find((item) => item.kind === "image");
  const currentOperation = OPERATIONS.find((row) => row.id === operation)!;
  const maskValid = !!mask && mask.sourceId === mainImage?.id;
  const editReady =
    operation === "generate" ||
    (!!capabilities?.image_edit &&
      !!mainImage &&
      (!["erase", "edit"].includes(operation) || maskValid));
  const submittedPrompt = prompt.trim() || currentOperation.instruction;
  useEffect(() => {
    const timer = window.setTimeout(() => {
      try {
        localStorage.setItem(
          `atlas:studio:draft:${user.id}`,
          JSON.stringify({ prompt, style }),
        );
      } catch {
        /* Browser storage can be restricted. */
      }
    }, 350);
    return () => window.clearTimeout(timer);
  }, [prompt, style, user.id]);
  useEffect(() => {
    if (mask && mask.sourceId !== mainImage?.id) {
      void removeStudioAttachment(mask.attachment.id).catch(() => undefined);
      setMask(undefined);
    }
  }, [mainImage?.id, mask]);
  const closeOptions = useCallback(() => setOptions(undefined), []);
  const [busy, setBusy] = useState(false);
  const sending = useRef(false);
  const [optimistic, setOptimistic] = useState<StudioMessage>();
  const [worksOpen, setWorksOpen] = useState(false);
  const conversationActive = !!selected || !!optimistic;
  const conversationScroll = useRef<HTMLDivElement>(null);
  const followConversation = useRef(true);
  const [preview, setPreview] = useState<{ asset: Asset; prompt: string }>();
  const preferenceKey = `atlas:studio:models:${user.id}`;
  const [modelIds, setModelIds] = useState<{ image: string; video: string }>(
    () => {
      try {
        const saved = JSON.parse(localStorage.getItem(preferenceKey) || "{}");
        return {
          image: typeof saved.image === "string" ? saved.image : "",
          video: typeof saved.video === "string" ? saved.video : "",
        };
      } catch {
        return { image: "", video: "" };
      }
    },
  );
  const modelsFor = (kind: "image" | "video") =>
    capabilities?.models?.filter((model) => model.kind === kind) || [];
  const selectedModel = (kind: "image" | "video") =>
    modelsFor(kind).find((model) => model.id === modelIds[kind]);
  const activeModels = (["image", "video"] as const)
    .filter((modelKind) => kind === "auto" || kind === modelKind)
    .flatMap((modelKind) => {
      const model = selectedModel(modelKind);
      return model ? [model] : [];
    });
  useEffect(() => {
    closeOptions();
  }, [kind, selected, busy, closeOptions]);
  useEffect(() => {
    try {
      localStorage.setItem(preferenceKey, JSON.stringify(modelIds));
    } catch {
      /* Storage may be unavailable in a restricted browser. */
    }
  }, [preferenceKey, modelIds]);
  const [error, setError] = useState("");
  const [loadError, setLoadError] = useState("");
  const request = useRef<{ signature: string; id: string } | undefined>(
    undefined,
  );
  const current = useRef(selected);
  current.current = selected;
  const refresh = async () => {
    const [caps, history] = await Promise.all([
      api<Capabilities>("/api/studio/capabilities"),
      api<typeof projects>("/api/studio/projects"),
    ]);
    setCapabilities(caps);
    setModelIds((current) => {
      const next = { ...current };
      for (const kind of ["image", "video"] as const) {
        const rows = caps.models?.filter((row) => row.kind === kind) || [];
        if (!rows.some((row) => row.id === current[kind]))
          next[kind] =
            rows.find((row) => row.id === caps[`default_${kind}_id`])?.id ||
            rows[0]?.id ||
            "";
      }
      return next;
    });
    setProjects(history);
    setLoadError("");
  };
  useEffect(() => {
    void refresh().catch((error) => setLoadError((error as Error).message));
  }, []);
  useEffect(() => {
    if (selected) return;
    const controller = new AbortController();
    setRecentLoading(projects.length > 0);
    void Promise.allSettled(
      projects.slice(0, 8).map((project) =>
        api<ProjectView>(`/api/studio/projects/${project.id}`, {
          signal: controller.signal,
        }),
      ),
    ).then((results) => {
      if (controller.signal.aborted) return;
      setRecentViews(
        results.flatMap((result) =>
          result.status === "fulfilled" ? [result.value] : [],
        ),
      );
      setRecentError(results.some((result) => result.status === "rejected"));
      setRecentLoading(false);
    });
    return () => controller.abort();
  }, [projects, selected]);
  const pending = !!view?.jobs.some((job) =>
    ["queued", "running"].includes(job.status),
  );
  useEffect(() => {
    if (!selected) return;
    const controller = new AbortController();
    const load = async () => {
      try {
        const next = await api<ProjectView>(
          `/api/studio/projects/${selected}`,
          { signal: controller.signal },
        );
        if (!controller.signal.aborted) {
          setView(next);
          setLoadError("");
        }
      } catch (error) {
        if (!controller.signal.aborted) setLoadError((error as Error).message);
      }
    };
    void load();
    const interval =
      busy || pending ? window.setInterval(() => void load(), 2500) : undefined;
    return () => {
      controller.abort();
      if (interval) window.clearInterval(interval);
    };
  }, [selected, busy, pending]);
  const ready =
    capabilities?.agent &&
    (kind === "auto"
      ? capabilities.image.enabled || capabilities.video.enabled
      : capabilities[kind].enabled) &&
    (kind === "auto"
      ? !!(selectedModel("image") || selectedModel("video"))
      : !!selectedModel(kind));
  /** 先展示原始消息，再调用后台；失败保留请求编号，且不覆盖等待期间的新草稿。 */
  const ask = async () => {
    if (
      sending.current ||
      busy ||
      !submittedPrompt ||
      !ready ||
      !editReady ||
      attachments.uploading ||
      attachments.failed ||
      (kind === "video" &&
        attachments.ready.filter((row) => row.kind === "image").length > 1)
    )
      return;
    const original = prompt;
    const parameters = {
      prompt: submittedPrompt,
      kind,
      image_size: imageSize,
      video_size: videoSize,
      seconds,
      allow_web: allowWeb,
      attachment_ids: attachments.ready.map((row) => row.id),
      operation,
      style,
      image_quality: quality,
      mask_attachment_id: maskValid ? mask?.attachment.id : undefined,
      image_model_id:
        kind !== "video" ? modelIds.image || undefined : undefined,
      video_model_id:
        kind !== "image" ? modelIds.video || undefined : undefined,
    };
    const signature = JSON.stringify({ ...parameters, project_id: selected });
    if (request.current?.signature !== signature)
      request.current = { signature, id: randomUuid() };
    const requestId = request.current.id;
    sending.current = true;
    followConversation.current = true;
    setWorksOpen(false);
    setOptimistic({
      id: `local-${requestId}`,
      request_id: requestId,
      role: "user",
      content: submittedPrompt,
      citations: [],
      attachments: [...attachments.ready],
    });
    setBusy(true);
    setError("");
    setPrompt("");
    let projectId = selected;
    try {
      if (!projectId) {
        const created = await post<{ id: string; title: string }>(
          "/api/studio/projects",
          {
            title: original || currentOperation.name,
          },
        );
        projectId = created.id;
        // 创建成功即更新历史选项，不必等待整次回复完成。
        setProjects((history) => [
          created,
          ...history.filter((item) => item.id !== created.id),
        ]);
        current.current = projectId;
        setSelected(projectId);
      }
      // 新会话创建后更新签名，失败重试继续使用相同编号，避免重复计费。
      request.current = {
        signature: JSON.stringify({ ...parameters, project_id: projectId }),
        id: requestId,
      };
      await post("/api/studio/chat", {
        ...parameters,
        project_id: projectId,
        request_id: requestId,
      });
      request.current = undefined;
      setMask(undefined);
      attachments.clear();
    } catch (error) {
      setError((error as Error).message);
      // 用户可在等待期间输入下一条消息，失败时只恢复空白草稿。
      setPrompt((draft) => draft || original);
    } finally {
      if (projectId) {
        try {
          const next = await api<ProjectView>(
            `/api/studio/projects/${projectId}`,
          );
          if (current.current === projectId) setView(next);
        } catch (error) {
          setLoadError((error as Error).message);
        }
      }
      sending.current = false;
      setBusy(false);
      void refresh().catch((error) => setLoadError((error as Error).message));
    }
  };
  const renderAsset = (asset: Asset, assetPrompt: string) => (
    <div key={asset.id} className="studio-asset">
      {asset.kind === "image" ? (
        <button
          className="studio-image-open"
          type="button"
          aria-label="放大查看图片"
          title="点击放大查看"
          onClick={() => setPreview({ asset, prompt: assetPrompt })}
        >
          <img
            src={`/api/studio/assets/${asset.id}`}
            alt={assetPrompt}
            loading="lazy"
          />
          <span>点击放大</span>
        </button>
      ) : (
        <video
          src={`/api/studio/assets/${asset.id}`}
          controls
          playsInline
          preload="metadata"
        />
      )}
      {asset.kind === "video" && (
        <button
          className="button studio-video-open"
          type="button"
          onClick={(event) => {
            event.currentTarget.parentElement?.querySelector("video")?.pause();
            setPreview({ asset, prompt: assetPrompt });
          }}
        >
          <Expand size={14} aria-hidden="true" />
          查看视频详情
        </button>
      )}
      <a
        className="button"
        href={`/api/studio/assets/${asset.id}`}
        download={`creation-${asset.id}.${asset.mime_type.split("/")[1].replace("jpeg", "jpg")}`}
      >
        <Download size={14} />
        下载{asset.kind === "image" ? "图片" : "视频"}
        <small>{bytes(asset.size)}</small>
      </a>
      {asset.kind === "image" && capabilities?.attachments?.enabled && (
        <button
          type="button"
          className="text-button studio-use-reference"
          disabled={
            busy ||
            !!reusing ||
            attachments.items.length >= capabilities.attachments.max_files
          }
          onClick={async () => {
            setReusing(asset.id);
            setError("");
            try {
              attachments.addReference(await reuseStudioAsset(asset.id));
              setKind("image");
              promptInput.current?.focus();
              promptInput.current?.scrollIntoView({
                behavior: "smooth",
                block: "center",
              });
            } catch (cause) {
              setError((cause as Error).message);
            } finally {
              setReusing("");
            }
          }}
        >
          {reusing === asset.id ? (
            <LoaderCircle size={13} className="spin" />
          ) : (
            <ImagePlus size={13} />
          )}
          用作参考图
        </button>
      )}
    </div>
  );
  /** 开始全新创作并清理上次会话的本地消息和作品筛选。 */
  const newCreation = () => {
    setOptimistic(undefined);
    setWorksOpen(false);
    setSelected("");
    setView(undefined);
    setPrompt("");
    setError("");
    setAllowWeb(false);
    setOperation("generate");
    if (mask)
      void removeStudioAttachment(mask.attachment.id).catch(() => undefined);
    setMask(undefined);
    attachments.clear(true);
    setWorkSearch("");
    setWorkFilter("all");
    request.current = undefined;
  };
  const matchesWork = (
    row: { kind: string; prompt?: string; model?: string; status?: string },
    title = "",
  ) => {
    const text =
      `${title} ${row.prompt || ""} ${row.model || ""}`.toLowerCase();
    return (
      (!workSearch.trim() || text.includes(workSearch.trim().toLowerCase())) &&
      (workFilter === "all" ||
        row.kind === workFilter ||
        (workFilter === "pending" &&
          ["queued", "running"].includes(row.status || "")) ||
        (workFilter === "failed" && row.status === "failed"))
    );
  };
  const recentWorks = recentViews
    .flatMap((recent) =>
      recent.assets.map((asset) => ({
        recent,
        asset,
        job: recent.jobs.find((job) => job.id === asset.job_id),
      })),
    )
    .filter(({ recent, asset, job }) =>
      matchesWork({ ...job, kind: asset.kind }, recent.project.title),
    );
  const filteredJobs =
    view?.jobs.filter((job) => matchesWork(job, view.project.title)) || [];
  const workControls = (
    <div className="studio-work-controls">
      <label className="studio-work-search">
        <Search size={15} />
        <input
          aria-label="搜索创作作品"
          placeholder="搜索作品、提示词或模型"
          value={workSearch}
          onChange={(event) => setWorkSearch(event.target.value)}
        />
      </label>
      <select
        aria-label="筛选创作作品"
        value={workFilter}
        onChange={(event) => setWorkFilter(event.target.value)}
      >
        <option value="all">全部作品</option>
        <option value="image">图片</option>
        <option value="video">视频</option>
        {selected && (
          <>
            <option value="pending">生成中</option>
            <option value="failed">失败任务</option>
          </>
        )}
      </select>
    </div>
  );
  // 服务端消息到达后去掉乐观副本；兼容尚无 request_id 的历史记录。
  const optimisticVisible =
    optimistic &&
    !view?.messages.some(
      (message) =>
        message.request_id === optimistic.request_id ||
        (message.role === "user" &&
          !message.request_id &&
          message.content === optimistic.content),
    )
      ? optimistic
      : undefined;
  const conversationMessages = [
    ...(view?.messages || []),
    ...(optimisticVisible ? [optimisticVisible] : []),
  ];
  /** 服务端确认消息后清理乐观副本，失败且未落库时继续保留原话。 */
  useEffect(() => {
    if (!busy && optimistic && !optimisticVisible) setOptimistic(undefined);
  }, [busy, optimistic, optimisticVisible]);
  /** 仅在用户接近底部时跟随新消息，避免打断阅读较早的内容。 */
  useEffect(() => {
    const container = conversationScroll.current;
    if (container && followConversation.current)
      container.scrollTop = container.scrollHeight;
  }, [view, optimistic, busy]);
  /** 按需打开作品列表后定位到列表，保持输入栏固定。 */
  useEffect(() => {
    if (worksOpen)
      works.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [worksOpen]);
  return (
    <div
      className={`studio-layout ${historyOpen ? "history-open" : ""} ${conversationActive ? "is-conversation" : ""}`}
    >
      <aside className="studio-history" id="studio-history">
        <button className="button" disabled={busy} onClick={newCreation}>
          <Plus size={16} />
          新的创作
        </button>
        <div className="nav-label">最近创作</div>
        {projects.map((project) => (
          <button
            key={project.id}
            className={`history-item ${selected === project.id ? "active" : ""}`}
            disabled={busy}
            onClick={() => {
              /** 切换历史时清理本地占位，避免显示上一个会话的消息。 */
              if (selected === project.id) return;
              setOptimistic(undefined);
              setWorksOpen(false);
              setSelected(project.id);
              setView(undefined);
              setError("");
              request.current = undefined;
            }}
          >
            <MessageSquare size={14} />
            <span>{project.title}</span>
          </button>
        ))}
        {!projects.length && (
          <p className="history-empty">你的灵感与作品会保存在这里</p>
        )}
        <p className="studio-private">创作记录和作品仅当前账号可访问</p>
      </aside>
      <section className="studio-main">
        <select
          className="studio-mobile-history"
          aria-label="创作记录"
          value={selected}
          disabled={busy}
          onChange={(event) => {
            /** 移动端切换创作记录时重置本地对话状态。 */
            setOptimistic(undefined);
            setWorksOpen(false);
            setSelected(event.target.value);
            setView(undefined);
            setPrompt("");
            setError("");
            request.current = undefined;
          }}
        >
          <option value="">新的创作</option>
          {projects.map((project) => (
            <option key={project.id} value={project.id}>
              {project.title}
            </option>
          ))}
        </select>
        <div className="studio-heading">
          <div>
            <button
              className="icon-button studio-history-toggle"
              aria-label={historyOpen ? "收起创作记录" : "打开创作记录"}
              aria-expanded={historyOpen}
              aria-controls="studio-history"
              onClick={() => setHistoryOpen(!historyOpen)}
            >
              <PanelLeft size={18} />
            </button>
            <ProductLogo decorative />
            <strong>创作台</strong>
          </div>
          <div className="studio-heading-actions">
            {conversationActive && (
              <button
                className="icon-button"
                aria-label="新的创作"
                disabled={busy}
                onClick={newCreation}
              >
                <Plus size={18} />
              </button>
            )}
            <button
              className="button studio-works-link"
              onClick={() => {
                /** 在对话内按需展开作品，在首页定位最近作品。 */
                if (conversationActive) setWorksOpen((open) => !open);
                else
                  works.current?.scrollIntoView({
                    behavior: "smooth",
                    block: "start",
                  });
              }}
              aria-expanded={conversationActive ? worksOpen : undefined}
            >
              <FolderOpen size={15} />
              我的作品
            </button>
          </div>
        </div>
        {loadError && (
          <div className="studio-notice" role="alert">
            {loadError}
            <button
              className="text-button"
              onClick={() =>
                void refresh().catch((error) =>
                  setLoadError((error as Error).message),
                )
              }
            >
              重新加载
            </button>
          </div>
        )}
        {capabilities && !capabilities.agent && (
          <div className="studio-notice">
            先启用支持工具调用的问答模型，开始与创作助手协作。
            {user.role === "admin" && (
              <button className="text-button" onClick={onConfigureAgent}>
                配置对话模型
              </button>
            )}
          </div>
        )}
        {capabilities &&
          !capabilities.image.enabled &&
          !capabilities.video.enabled && (
            <div className="studio-notice">
              {user.role === "admin"
                ? "连接并启用生图或视频模型，让灵感变成作品。"
                : "请联系管理员配置生图或视频模型。"}
              {user.role === "admin" && (
                <button className="text-button" onClick={onConfigureModels}>
                  前往模型设置
                </button>
              )}
            </div>
          )}
        <div className="studio-content">
          {!conversationActive && (
            <div className={`studio-welcome ${selected ? "continuing" : ""}`}>
              <h1>
                <ProductLogo decorative />
                {selected ? view?.project.title || "继续创作" : "AI 创作"}
              </h1>
              <p>
                {selected
                  ? "从一个新想法出发，继续完善你的作品"
                  : "让想法，成为作品。"}
              </p>
            </div>
          )}
          {conversationActive && (
            <div
              className="studio-conversation"
              ref={conversationScroll}
              onScroll={(event) => {
                /** 记录阅读位置，向上浏览时暂停自动滚动。 */
                const container = event.currentTarget;
                followConversation.current =
                  container.scrollHeight -
                    container.scrollTop -
                    container.clientHeight <
                  80;
              }}
            >
              <StudioConversation
                messages={conversationMessages}
                jobs={view?.jobs || []}
                assets={view?.assets || []}
                busyRequestId={busy ? optimistic?.request_id : undefined}
                renderAsset={renderAsset}
                onDocument={onDocument}
              />
              {worksOpen && !!view?.jobs.length && (
                <div className="studio-gallery" ref={works}>
                  <div className="section-heading">
                    <h2>
                      作品与任务 <span>{view.jobs.length}</span>
                    </h2>
                    {pending && (
                      <span>
                        <LoaderCircle size={14} className="spin" />
                        自动更新进度
                      </span>
                    )}
                  </div>
                  {workControls}
                  <div className="studio-art-grid">
                    {filteredJobs.map((job) => {
                      const assets = view.assets.filter(
                        (asset) => asset.job_id === job.id,
                      );
                      return (
                        <article className="studio-art-card" key={job.id}>
                          <div className="studio-art-heading">
                            <strong>
                              {job.kind === "image" ? (
                                <ImagePlus size={15} />
                              ) : (
                                <Film size={15} />
                              )}{" "}
                              {job.kind === "image" ? "图片作品" : "视频作品"}
                            </strong>
                            <span className={`studio-job-status ${job.status}`}>
                              {{
                                queued: "等待生成",
                                running: "生成中",
                                completed: "已完成",
                                failed: "生成失败",
                              }[job.status] || job.status}
                            </span>
                          </div>
                          {assets.map((asset) =>
                            renderAsset(asset, job.prompt),
                          )}
                          {!assets.length && (
                            <div
                              className={`studio-generation ${job.status === "failed" ? "failed" : ""}`}
                            >
                              {job.status === "failed" ? (
                                <RefreshCw size={25} />
                              ) : job.status === "completed" ? (
                                <Check size={25} />
                              ) : (
                                <LoaderCircle size={25} className="spin" />
                              )}
                              <span>
                                {job.error ||
                                  (job.status === "queued"
                                    ? "正在生成，请稍候"
                                    : job.status === "completed"
                                      ? "作品已生成"
                                      : "正在生成，请稍候")}
                              </span>
                              {job.kind === "video" &&
                                job.status === "running" && (
                                  <progress value={job.progress} max={100} />
                                )}
                            </div>
                          )}
                          <div className="studio-art-meta">
                            <span>
                              {job.size}
                              {job.seconds ? ` · ${job.seconds} 秒` : ""}
                            </span>
                            <span title={job.model}>{job.model}</span>
                          </div>
                          <details className="studio-prompt">
                            <summary>查看提示词</summary>
                            <p>{job.prompt}</p>
                          </details>
                          <button
                            className="text-button"
                            disabled={busy}
                            onClick={() => {
                              setPrompt(job.prompt);
                              setKind(job.kind);
                              setOperation("generate");
                              if (job.kind === "image") setImageSize(job.size);
                              else {
                                setVideoSize(job.size);
                                setSeconds(job.seconds || 4);
                              }
                              setError("");
                              request.current = undefined;
                              promptInput.current?.focus();
                              promptInput.current?.scrollIntoView({
                                behavior: "smooth",
                                block: "center",
                              });
                            }}
                          >
                            以此为基础继续创作
                          </button>
                        </article>
                      );
                    })}
                  </div>
                  {!filteredJobs.length && (
                    <p className="studio-gallery-state">
                      没有符合条件的作品或任务。
                    </p>
                  )}
                </div>
              )}
            </div>
          )}
          <div className="studio-compose-wrap">
            <form
              className={`studio-composer ${dragging ? "is-dragging" : ""}`}
              onPaste={(event) => {
                const files = Array.from(event.clipboardData.files);
                if (
                  !files.length ||
                  busy ||
                  !capabilities?.attachments?.enabled
                )
                  return;
                event.preventDefault();
                attachments.addFiles(files);
              }}
              onDragEnter={(event) => {
                if (
                  !event.dataTransfer.types.includes("Files") ||
                  busy ||
                  !capabilities?.attachments?.enabled
                )
                  return;
                event.preventDefault();
                dragDepth.current += 1;
                setDragging(true);
              }}
              onDragOver={(event) => {
                if (!event.dataTransfer.types.includes("Files")) return;
                event.preventDefault();
                event.dataTransfer.dropEffect =
                  busy || !capabilities?.attachments?.enabled ? "none" : "copy";
              }}
              onDragLeave={(event) => {
                event.preventDefault();
                dragDepth.current = Math.max(0, dragDepth.current - 1);
                if (!dragDepth.current) setDragging(false);
              }}
              onDrop={(event) => {
                event.preventDefault();
                dragDepth.current = 0;
                setDragging(false);
                if (!busy && capabilities?.attachments?.enabled)
                  attachments.addFiles(Array.from(event.dataTransfer.files));
              }}
              onSubmit={(event) => {
                event.preventDefault();
                void ask();
              }}
            >
              <input
                ref={fileInput}
                className="studio-file-input"
                type="file"
                multiple
                accept={capabilities?.attachments?.accept.join(",")}
                aria-label="上传创作参考文件"
                disabled={busy || !capabilities?.attachments?.enabled}
                onChange={(event) => {
                  attachments.addFiles(Array.from(event.target.files || []));
                  event.target.value = "";
                }}
              />
              {dragging && (
                <div className="studio-drop-overlay">
                  <Paperclip size={24} />
                  <strong>松开以添加参考文件</strong>
                  <span>图片或文本资料</span>
                </div>
              )}
              <StudioAttachments
                items={busy ? [] : attachments.items}
                disabled={busy}
                onRemove={attachments.remove}
                onRetry={(item) => void attachments.retry(item)}
              />
              {operation !== "generate" && (
                <div className="studio-operation-context">
                  <currentOperation.icon size={15} />
                  <strong>{currentOperation.name}</strong>
                  <span>{currentOperation.description}</span>
                  <button
                    type="button"
                    className="icon-button"
                    aria-label="取消图片编辑"
                    disabled={busy}
                    onClick={() => setOperation("generate")}
                  >
                    <X size={13} />
                  </button>
                </div>
              )}
              <textarea
                ref={promptInput}
                aria-label="创作要求"
                placeholder={
                  operation !== "generate"
                    ? operation === "edit"
                      ? "标记区域后，描述你想怎样修改，例如：换成红色外套…"
                      : `${currentOperation.instruction} 可补充具体要求…`
                    : kind === "video"
                      ? "描述你想创作的视频、镜头与氛围…"
                      : "描述你想要的画面，让灵感在这里发生…"
                }
                maxLength={4000}
                rows={2}
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
                onKeyDown={(event) => {
                  if (
                    event.key === "Enter" &&
                    !event.shiftKey &&
                    !event.nativeEvent.isComposing
                  ) {
                    event.preventDefault();
                    void ask();
                  }
                }}
              />
              <div className="studio-composer-extras">
                <button
                  type="button"
                  className="studio-extra-button"
                  disabled={
                    busy ||
                    !capabilities?.attachments?.enabled ||
                    attachments.items.length >=
                      (capabilities?.attachments?.max_files || 8)
                  }
                  title="添加图片或文本资料，也可直接粘贴或拖拽"
                  onClick={() => fileInput.current?.click()}
                >
                  <Paperclip size={15} /> 添加参考
                </button>
                <StudioOptionsPopover
                  label="创作风格"
                  summary={
                    STYLES.find((row) => row.id === style)?.name || "不指定风格"
                  }
                  icon={<Palette size={14} />}
                  className="studio-style-trigger"
                  open={options === "styles"}
                  disabled={busy}
                  onToggle={() =>
                    setOptions((value) =>
                      value === "styles" ? undefined : "styles",
                    )
                  }
                  onClose={closeOptions}
                >
                  <div
                    className="studio-style-grid"
                    role="group"
                    aria-label="风格选择"
                  >
                    {STYLES.map((row) => (
                      <button
                        type="button"
                        key={row.id}
                        aria-pressed={style === row.id}
                        className={style === row.id ? "active" : ""}
                        onClick={() => {
                          setStyle(row.id);
                          closeOptions();
                        }}
                      >
                        <span style={{ background: row.color }} />
                        <strong>{row.name}</strong>
                        {style === row.id && <Check size={13} />}
                      </button>
                    ))}
                  </div>
                </StudioOptionsPopover>
                <button
                  type="button"
                  className="studio-extra-button"
                  disabled={busy}
                  onClick={() => {
                    const template =
                      kind === "video"
                        ? "主体：\n场景：\n镜头运动：\n动作与节奏：\n光线与氛围：\n避免出现："
                        : "主体：\n场景与用途：\n构图：\n光线与配色：\n需要保留的细节：\n避免出现：";
                    setPrompt((value) =>
                      value.trim()
                        ? `${value}\n\n${template}`.slice(0, 4000)
                        : template,
                    );
                    promptInput.current?.focus();
                  }}
                >
                  <WandSparkles size={14} /> 提示词模板
                </button>
                {["erase", "edit"].includes(operation) && (
                  <button
                    type="button"
                    className={`studio-extra-button ${maskValid ? "marked" : ""}`}
                    disabled={busy || !mainImage || attachments.uploading}
                    onClick={() => setMaskEditor(true)}
                  >
                    <Brush size={14} />
                    {maskValid ? "修改标记" : "标记区域"}
                  </button>
                )}
                <span className="studio-prompt-count">
                  {prompt.length}/4000
                </span>
              </div>
              <div className="studio-composer-toolbar">
                <div className="studio-controls">
                  <div
                    className="studio-mode-tabs"
                    role="group"
                    aria-label="创作类型"
                  >
                    {[
                      { kind: "image" as const, name: "生图", icon: ImagePlus },
                      { kind: "video" as const, name: "视频", icon: Film },
                      {
                        kind: "auto" as const,
                        name: "智能选择",
                        icon: Sparkles,
                      },
                    ].map((item) => (
                      <button
                        type="button"
                        key={item.kind}
                        aria-pressed={kind === item.kind}
                        aria-label={item.name}
                        title={
                          item.kind === "auto"
                            ? "根据对话选择图片或视频"
                            : item.name
                        }
                        className={kind === item.kind ? "active" : ""}
                        disabled={busy}
                        onClick={() => {
                          setKind(item.kind);
                          if (item.kind === "video") setOperation("generate");
                        }}
                      >
                        <item.icon size={15} />
                        {item.kind === "auto" ? "智能" : item.name}
                      </button>
                    ))}
                  </div>
                  <StudioOptionsPopover
                    label="模型选择"
                    caption="模型"
                    summary={
                      activeModels.length > 1
                        ? `${activeModels.length} 个模型`
                        : activeModels[0]?.model || "未选择模型"
                    }
                    title={
                      activeModels
                        .map((model) => `${model.name} · ${model.model}`)
                        .join(" · ") || "选择已启用的生图或视频模型"
                    }
                    icon={<Sparkles size={14} aria-hidden="true" />}
                    className="studio-model-trigger"
                    open={options === "models"}
                    disabled={busy}
                    onToggle={() =>
                      setOptions((current) =>
                        current === "models" ? undefined : "models",
                      )
                    }
                    onClose={closeOptions}
                  >
                    {(["image", "video"] as const)
                      .filter(
                        (modelKind) => kind === "auto" || kind === modelKind,
                      )
                      .map((modelKind) => (
                        <label className="studio-option-field" key={modelKind}>
                          <span>
                            {modelKind === "image" ? "生图模型" : "视频模型"}
                          </span>
                          <select
                            className="studio-model-select"
                            aria-label={
                              modelKind === "image"
                                ? "选择生图模型"
                                : "选择视频模型"
                            }
                            value={modelIds[modelKind]}
                            title={
                              selectedModel(modelKind)
                                ? `${selectedModel(modelKind)?.name} · ${selectedModel(modelKind)?.model}`
                                : "请在设置中配置并启用模型"
                            }
                            disabled={busy || !modelsFor(modelKind).length}
                            onChange={(event) =>
                              setModelIds((current) => ({
                                ...current,
                                [modelKind]: event.target.value,
                              }))
                            }
                          >
                            {!modelsFor(modelKind).length && (
                              <option value="">
                                {modelKind === "image"
                                  ? "暂无可用生图模型"
                                  : "暂无可用视频模型"}
                              </option>
                            )}
                            {modelsFor(modelKind).map((model) => (
                              <option key={model.id} value={model.id}>
                                {model.model}
                                {modelsFor(modelKind).filter(
                                  (row) => row.model === model.model,
                                ).length > 1
                                  ? ` · ${model.name}`
                                  : ""}
                              </option>
                            ))}
                          </select>
                        </label>
                      ))}
                  </StudioOptionsPopover>
                  <StudioOptionsPopover
                    label="生成参数"
                    summary="参数"
                    title={
                      kind === "image"
                        ? `图片尺寸 ${imageSize}`
                        : kind === "video"
                          ? `视频画幅 ${videoSize} · ${seconds} 秒`
                          : `图片 ${imageSize} · 视频 ${videoSize} · ${seconds} 秒`
                    }
                    icon={<SlidersHorizontal size={14} aria-hidden="true" />}
                    className="studio-parameters-trigger"
                    open={options === "parameters"}
                    disabled={busy}
                    onToggle={() =>
                      setOptions((current) =>
                        current === "parameters" ? undefined : "parameters",
                      )
                    }
                    onClose={closeOptions}
                  >
                    {kind !== "video" && (
                      <>
                        <label className="studio-option-field">
                          <span>图片画幅</span>
                          <select
                            aria-label="图片尺寸"
                            value={imageSize}
                            disabled={busy}
                            onChange={(event) =>
                              setImageSize(event.target.value)
                            }
                          >
                            <option value="1024x1024">
                              方形 · 1024 × 1024
                            </option>
                            <option value="1536x1024">
                              横版 · 1536 × 1024
                            </option>
                            <option value="1024x1536">
                              竖版 · 1024 × 1536
                            </option>
                            <option value="1792x1024">
                              宽幅 · 1792 × 1024
                            </option>
                            <option value="1024x1792">
                              长图 · 1024 × 1792
                            </option>
                          </select>
                        </label>
                        <label className="studio-option-field">
                          <span>图片质量</span>
                          <select
                            aria-label="图片质量"
                            value={quality}
                            disabled={busy}
                            onChange={(event) => setQuality(event.target.value)}
                          >
                            <option value="auto">自动 · 由模型决定</option>
                            <option value="low">低 · 更快</option>
                            <option value="medium">中 · 均衡</option>
                            <option value="high">高 · 更精细</option>
                          </select>
                        </label>
                      </>
                    )}
                    {kind !== "image" && (
                      <>
                        <label className="studio-option-field">
                          <span>视频画幅</span>
                          <select
                            aria-label="视频画幅"
                            value={videoSize}
                            disabled={busy}
                            onChange={(event) =>
                              setVideoSize(event.target.value)
                            }
                          >
                            <option value="1280x720">横版 · 16:9</option>
                            <option value="720x1280">竖版 · 9:16</option>
                          </select>
                        </label>
                        <label className="studio-option-field">
                          <span>视频时长</span>
                          <select
                            aria-label="视频时长"
                            value={seconds}
                            disabled={busy}
                            onChange={(event) =>
                              setSeconds(Number(event.target.value))
                            }
                          >
                            {[4, 8, 12].map((value) => (
                              <option key={value} value={value}>
                                {value} 秒
                              </option>
                            ))}
                          </select>
                        </label>
                      </>
                    )}
                  </StudioOptionsPopover>
                </div>
                <div className="studio-composer-actions">
                  {capabilities?.web && (
                    <label className={`studio-web ${allowWeb ? "active" : ""}`}>
                      <Globe2 size={14} aria-hidden="true" />
                      <input
                        aria-label="联网素材检索"
                        type="checkbox"
                        checked={allowWeb}
                        disabled={busy}
                        onChange={(event) => setAllowWeb(event.target.checked)}
                      />
                      <span className="studio-web-caption">联网检索</span>
                    </label>
                  )}
                  <button
                    className="send-button"
                    aria-label="开始创作"
                    disabled={
                      busy ||
                      !submittedPrompt ||
                      !ready ||
                      !editReady ||
                      attachments.uploading ||
                      attachments.failed ||
                      (kind === "video" &&
                        attachments.ready.filter((row) => row.kind === "image")
                          .length > 1)
                    }
                  >
                    <ArrowUp size={21} />
                  </button>
                </div>
              </div>
            </form>
            {attachments.error && (
              <p className="studio-error" role="alert">
                {attachments.error}
              </p>
            )}
            {operation !== "generate" && !mainImage && (
              <p className="studio-input-hint">
                添加一张参考图，开始{currentOperation.name}。
              </p>
            )}
            {["erase", "edit"].includes(operation) &&
              mainImage &&
              !maskValid && (
                <p className="studio-input-hint">
                  点击「标记区域」，涂抹希望
                  {operation === "erase" ? "擦除" : "修改"}的位置。
                </p>
              )}
            {kind === "video" &&
              attachments.ready.filter((row) => row.kind === "image").length >
                1 && (
                <p className="studio-error" role="alert">
                  图生视频需要一张参考图，请移除多余图片。
                </p>
              )}
            {operation !== "generate" && mainImage && (
              <p className="studio-input-hint">
                图片编辑通过所选模型的编辑接口执行，具体效果和格式支持取决于服务商。
              </p>
            )}
            {error && (
              <p className="studio-error" role="alert">
                {error}
              </p>
            )}
            <small className="composer-note">
              {capabilities?.attachments?.enabled
                ? "支持粘贴、拖拽图片与文档 · "
                : ""}
              生成会调用所选服务商，可能产生费用。作品自动保存。
            </small>
          </div>
          {!conversationActive && (
            <div
              className="studio-edit-tools"
              role="group"
              aria-label="图片创作工具"
            >
              {OPERATIONS.map((item) => (
                <button
                  type="button"
                  key={item.id}
                  aria-pressed={operation === item.id}
                  className={operation === item.id ? "active" : ""}
                  disabled={
                    busy ||
                    (item.id !== "generate" && !capabilities?.image_edit)
                  }
                  title={
                    item.id !== "generate" && !capabilities?.image_edit
                      ? "当前服务尚未启用图片编辑能力"
                      : item.description
                  }
                  onClick={() => {
                    setOperation(item.id);
                    if (item.id !== "generate") setKind("image");
                    setError("");
                    promptInput.current?.focus();
                  }}
                >
                  <item.icon size={18} />
                  <span>{item.name}</span>
                </button>
              ))}
            </div>
          )}

          {!conversationActive && (
            <>
              <div className="studio-inspirations" aria-label="创作灵感">
                {[
                  {
                    icon: ImagePlus,
                    title: "品牌海报",
                    tag: "DESIGN",
                    color: "peach",
                    kind: "image" as const,
                    text: "生成一张企业知识库产品海报，蓝白配色，简洁留白，突出知识连接与团队协作，不包含文字。",
                  },
                  {
                    icon: ImagePlus,
                    title: "场景摄影",
                    tag: "PHOTO",
                    color: "mint",
                    kind: "image" as const,
                    text: "生成一张自然光下的现代咖啡馆摄影作品，暖色木质家具，窗边绿植，午后柔和光影，真实细腻的质感，不包含文字。",
                  },
                  {
                    icon: Sparkles,
                    title: "产品插画",
                    tag: "ILLUSTRATION",
                    color: "lavender",
                    kind: "image" as const,
                    text: "生成一张知识管理产品的概念插画，立体几何造型，蓝紫渐变，知识节点彼此连接，纯色背景，干净简约，不包含文字。",
                  },
                  {
                    icon: Film,
                    title: "产品短片",
                    tag: "MOTION",
                    color: "sky",
                    kind: "video" as const,
                    text: "生成一段产品概念短片：散落的知识光点汇聚为蓝色网络，镜头缓慢推进，简洁科技感，不包含文字。",
                  },
                ].map((item) => (
                  <button
                    key={item.title}
                    disabled={busy}
                    onClick={() => {
                      setKind(item.kind);
                      setPrompt(item.text);
                      promptInput.current?.focus();
                    }}
                  >
                    <span className="studio-inspiration-copy">
                      <strong>{item.title}</strong>
                      <small>
                        {item.kind === "image" ? "图片灵感" : "视频灵感"}
                      </small>
                    </span>
                    <span
                      className={`studio-inspiration-art ${item.color}`}
                      aria-hidden="true"
                    >
                      <item.icon size={24} />
                      <span>{item.tag}</span>
                    </span>
                  </button>
                ))}
              </div>
              <div className="studio-gallery studio-recent-gallery" ref={works}>
                <div className="section-heading">
                  <h2>最近作品</h2>
                  <span>仅你可见 · 自动保存</span>
                </div>
                {workControls}
                {recentLoading ? (
                  <p className="studio-gallery-state" role="status">
                    <LoaderCircle size={17} className="spin" />
                    正在加载作品…
                  </p>
                ) : (
                  <>
                    {recentError && (
                      <p className="studio-error" role="alert">
                        部分作品暂时无法加载。
                        <button
                          className="text-button"
                          onClick={() =>
                            void refresh().catch((error) =>
                              setLoadError((error as Error).message),
                            )
                          }
                        >
                          重新加载
                        </button>
                      </p>
                    )}
                    <div className="studio-art-grid">
                      {recentWorks.map(({ recent, asset, job }) => {
                        return (
                          <article
                            className="studio-art-card studio-recent-card"
                            key={asset.id}
                          >
                            {renderAsset(
                              asset,
                              job?.prompt || recent.project.title,
                            )}
                            <div className="studio-recent-caption">
                              <strong>{recent.project.title}</strong>
                              <span>
                                {asset.kind === "image" ? "图片" : "视频"} ·{" "}
                                {job?.size}
                              </span>
                            </div>
                            <button
                              className="text-button"
                              disabled={busy}
                              onClick={() => {
                                /** 从最近作品进入对应对话，清理上次的临时消息。 */
                                setOptimistic(undefined);
                                setWorksOpen(false);
                                setSelected(recent.project.id);
                                setView(undefined);
                                setError("");
                                request.current = undefined;
                              }}
                            >
                              继续创作 <ArrowUp size={13} />
                            </button>
                          </article>
                        );
                      })}
                    </div>
                    {!recentViews.some((recent) => recent.assets.length) &&
                      !recentError && (
                        <div className="studio-gallery-empty">
                          <ProductLogo decorative />
                          <h3>第一份作品，从一个想法开始</h3>
                          <p>
                            描述画面或选择上面的灵感，生成的图片和视频会展示在这里。
                          </p>
                        </div>
                      )}
                    {!!recentViews.some((recent) => recent.assets.length) &&
                      !recentWorks.length && (
                        <p className="studio-gallery-state">
                          没有符合条件的作品。试试其他关键词或筛选条件。
                        </p>
                      )}
                  </>
                )}
              </div>
            </>
          )}
        </div>
      </section>
      {preview && (
        <ImagePreview
          id={preview.asset.id}
          prompt={preview.prompt}
          kind={preview.asset.kind === "image" ? "image" : "video"}
          extension={preview.asset.mime_type
            .split("/")[1]
            .replace("jpeg", "jpg")}
          onClose={() => setPreview(undefined)}
        />
      )}
      {maskEditor && mainImage && (
        <StudioMaskEditor
          src={studioAttachmentUrl(mainImage.id)}
          onClose={() => setMaskEditor(false)}
          onApply={async (file) => {
            const next = await uploadStudioAttachment(file);
            if (mask)
              void removeStudioAttachment(mask.attachment.id).catch(
                () => undefined,
              );
            setMask({ attachment: next, sourceId: mainImage.id });
          }}
        />
      )}
    </div>
  );
}
