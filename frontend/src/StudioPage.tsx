import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowUp,
  Check,
  ChevronDown,
  CircleAlert,
  Download,
  Expand,
  Film,
  FolderOpen,
  Globe2,
  ImagePlus,
  LoaderCircle,
  MessageSquare,
  PanelLeft,
  Plus,
  RefreshCw,
  SlidersHorizontal,
  Sparkles,
  Wrench,
} from "lucide-react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { api, post, bytes } from "./api";
import { randomUuid } from "./ids";
import { ImagePreview } from "./ImagePreview";
import { ProductLogo } from "./ProductLogo";
import { StudioOptionsPopover } from "./StudioOptionsPopover";
import type { Message, User } from "./types";
import type { Feedback } from "./App";

type Capabilities = {
  agent: boolean;
  web: boolean;
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
type Job = {
  id: string;
  kind: "image" | "video";
  prompt: string;
  model: string;
  size: string;
  seconds: number;
  status: string;
  progress: number;
  error?: string;
  created_at: number;
};
type Asset = {
  id: string;
  job_id: string;
  kind: string;
  mime_type: string;
  size: number;
};
type ProjectView = {
  project: { id: string; title: string };
  messages: Message[];
  jobs: Job[];
  assets: Asset[];
};
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
  const [prompt, setPrompt] = useState("");
  const [kind, setKind] = useState<"image" | "video" | "auto">("image");
  const [imageSize, setImageSize] = useState("1024x1024");
  const [videoSize, setVideoSize] = useState("1280x720");
  const [seconds, setSeconds] = useState(4);
  const [allowWeb, setAllowWeb] = useState(false);
  const [options, setOptions] = useState<"models" | "parameters">();
  const closeOptions = useCallback(() => setOptions(undefined), []);
  const [busy, setBusy] = useState(false);
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
  const ask = async () => {
    if (busy || !prompt.trim() || !ready) return;
    const original = prompt;
    setBusy(true);
    setError("");
    setPrompt("");
    let projectId = selected;
    try {
      if (!projectId) {
        const created = await post<{ id: string }>("/api/studio/projects", {
          title: original,
        });
        projectId = created.id;
        current.current = projectId;
        setSelected(projectId);
      }
      const parameters = {
        project_id: projectId,
        prompt: original,
        kind,
        image_size: imageSize,
        video_size: videoSize,
        seconds,
        allow_web: allowWeb,
        image_model_id:
          kind !== "video" ? modelIds.image || undefined : undefined,
        video_model_id:
          kind !== "image" ? modelIds.video || undefined : undefined,
      };
      const signature = JSON.stringify(parameters);
      if (request.current?.signature !== signature)
        request.current = { signature, id: randomUuid() };
      await post("/api/studio/chat", {
        ...parameters,
        request_id: request.current.id,
      });
      request.current = undefined;
    } catch (error) {
      setError((error as Error).message);
      setPrompt(original);
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
    </div>
  );
  const newCreation = () => {
    setSelected("");
    setView(undefined);
    setPrompt("");
    setError("");
    setAllowWeb(false);
    request.current = undefined;
  };
  return (
    <div className={`studio-layout ${historyOpen ? "history-open" : ""}`}>
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
              if (selected === project.id) return;
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
            {selected && (
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
              onClick={() =>
                works.current?.scrollIntoView({
                  behavior: "smooth",
                  block: "start",
                })
              }
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
                配置主智能体
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
          <div className="studio-compose-wrap">
            <form
              className="studio-composer"
              onSubmit={(event) => {
                event.preventDefault();
                void ask();
              }}
            >
              <textarea
                ref={promptInput}
                aria-label="创作要求"
                placeholder={
                  kind === "video"
                    ? "描述你想创作的视频、镜头与氛围…"
                    : "描述你想要的画面，让灵感在这里发生…"
                }
                maxLength={4000}
                rows={2}
                value={prompt}
                disabled={busy}
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
                        name: "Agent 自主选择",
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
                            ? "让 Agent 自主选择图片或视频工具"
                            : item.name
                        }
                        className={kind === item.kind ? "active" : ""}
                        disabled={busy}
                        onClick={() => setKind(item.kind)}
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
                      <label className="studio-option-field">
                        <span>图片画幅</span>
                        <select
                          aria-label="图片尺寸"
                          value={imageSize}
                          disabled={busy}
                          onChange={(event) => setImageSize(event.target.value)}
                        >
                          <option value="1024x1024">方形 · 1024 × 1024</option>
                          <option value="1536x1024">横版 · 1536 × 1024</option>
                          <option value="1024x1536">竖版 · 1024 × 1536</option>
                          <option value="1792x1024">宽幅 · 1792 × 1024</option>
                          <option value="1024x1792">长图 · 1024 × 1792</option>
                        </select>
                      </label>
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
                    disabled={busy || !prompt.trim() || !ready}
                  >
                    {busy ? (
                      <LoaderCircle size={18} className="spin" />
                    ) : (
                      <ArrowUp size={21} />
                    )}
                  </button>
                </div>
              </div>
            </form>
            {error && (
              <p className="studio-error" role="alert">
                {error}。可重试当前请求；已提交的任务会继续生成。
              </p>
            )}
            <small className="composer-note">
              生成会调用所选服务商，可能产生费用。作品自动保存，可稍后返回查看。
            </small>
          </div>

          {!selected ? (
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
                      {recentViews.flatMap((recent) =>
                        recent.assets.slice(0, 4).map((asset) => {
                          const job = recent.jobs.find(
                            (job) => job.id === asset.job_id,
                          );
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
                        }),
                      )}
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
                  </>
                )}
              </div>
            </>
          ) : (
            <>
              {!!view?.jobs.length && (
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
                  <div className="studio-art-grid">
                    {view.jobs.map((job) => {
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
                                    ? "已提交任务，等待生成"
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
                              setError("");
                              request.current = undefined;
                            }}
                          >
                            以此为基础继续创作
                          </button>
                        </article>
                      );
                    })}
                  </div>
                </div>
              )}
              <details className="studio-dialogue">
                <summary>
                  <span className="studio-dialogue-title">
                    <MessageSquare size={17} aria-hidden="true" />
                    <strong>创作对话</strong>
                    <span className="studio-dialogue-count">
                      {view?.messages.length || 0} 条
                    </span>
                  </span>
                  <span className="studio-dialogue-toggle">
                    <span className="when-closed">展开</span>
                    <span className="when-open">收起</span>
                    <ChevronDown size={15} aria-hidden="true" />
                  </span>
                </summary>
                <div className="studio-message-list">
                  {view?.messages.map((message) => (
                    <article
                      key={message.id}
                      className={`studio-message ${message.role}`}
                    >
                      <div className="studio-message-avatar" aria-hidden="true">
                        {message.role === "assistant" ? (
                          <ProductLogo decorative />
                        ) : (
                          <span>{user.name.slice(-1)}</span>
                        )}
                      </div>
                      <div className="studio-message-body">
                        <small className="studio-message-author">
                          {message.role === "assistant" ? "创作助手" : "你"}
                        </small>
                        <div className="markdown">
                          <Markdown remarkPlugins={[remarkGfm]}>
                            {message.content}
                          </Markdown>
                        </div>
                        {!!message.citations.length && (
                          <div
                            className="studio-evidence"
                            aria-label="引用资料"
                          >
                            {message.citations.map((citation, index) => (
                              <button
                                key={citation.chunk_id}
                                onClick={() => onDocument(citation.document_id)}
                              >
                                [{index + 1}] {citation.title} · 第{" "}
                                {citation.page} 页
                              </button>
                            ))}
                          </div>
                        )}
                        {!!message.tool_calls?.length && (
                          <details className="tool-trace studio-tools">
                            <summary>
                              <Wrench size={13} aria-hidden="true" />
                              <span>
                                工具调用 · {message.tool_calls.length} 次
                              </span>
                              <ChevronDown size={13} aria-hidden="true" />
                            </summary>
                            <ul>
                              {message.tool_calls.map((tool, index) => (
                                <li
                                  key={index}
                                  className={
                                    tool.success ? "success" : "failed"
                                  }
                                >
                                  <span className="studio-tool-name">
                                    {tool.success ? (
                                      <Check size={13} aria-hidden="true" />
                                    ) : (
                                      <CircleAlert
                                        size={13}
                                        aria-hidden="true"
                                      />
                                    )}
                                    {{
                                      generate_image: "图片生成",
                                      generate_video: "视频生成",
                                      creation_status: "生成进度",
                                      knowledge_search: "知识库检索",
                                      knowledge_read: "文档读取",
                                      knowledge_spaces: "空间查询",
                                      web_search: "联网搜索",
                                      web_fetch: "网页读取",
                                    }[tool.name] || tool.name}
                                  </span>
                                  <span className="studio-tool-status">
                                    {tool.success ? "已完成调用" : "调用失败"}
                                  </span>
                                </li>
                              ))}
                            </ul>
                          </details>
                        )}
                      </div>
                    </article>
                  ))}
                  {!view?.messages.length && (
                    <p className="studio-dialogue-empty">
                      暂无对话，提交创作要求后会显示在这里。
                    </p>
                  )}
                </div>
              </details>
            </>
          )}
          {busy && (
            <p className="studio-thinking" role="status">
              <LoaderCircle size={15} className="spin" />
              Pi Agent 正在整理要求并调用创作工具…
            </p>
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
    </div>
  );
}
