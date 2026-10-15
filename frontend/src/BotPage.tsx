import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowRight,
  Cloud,
  History,
  PanelRightClose,
  PanelRightOpen,
  Clock3,
  Plus,
  Plug,
  Package,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { api, date, post } from "./api";
import { randomUuid } from "./ids";
import type { Document, User } from "./types";
import {
  Badge,
  activeStates,
  type Caps,
  type Skill,
  type Connector,
  type Task,
  type Detail,
  type LocalDevice,
} from "./bot-types";
import { BotConversation } from "./BotConversation";
import { InspirationGame } from "./BotCompanion";
import { BotWorkspace } from "./BotWorkspace";
import type { Confirm, Feedback } from "./App";
import { Modal } from "./components";
import { BloubAvatar, type BotMood } from "./BloubAvatar";
import { BotComposer } from "./BotComposer";
import { BotFeishu } from "./BotFeishu";
import {
  clearFeishuDraft,
  feishuApi,
  officialFeishuAuthorizationUrl,
  readFeishuReturn,
  saveFeishuDraft,
  type FeishuDraft,
  type FeishuStatus,
} from "./feishu-api";
import { BotPlugins } from "./BotPlugins";
import { BotMemory } from "./BotMemory";
import { memoryApi, type KnowledgeAsset } from "./memory-api";
import { useHarnessPlugins } from "./harness-api";
import { useCloudComputer } from "./cloud-api";
import { BotCloud } from "./BotCloud";
import { useBotStream } from "./useBotStream";
import { readHomepageDraft, clearHomepageDraft } from "./homepageDraft";
import "./bot.css";
import "./bot-conversation.css";

type Library = "connectors" | "skills";
const starters = [
  {
    skill: "research",
    title: "研究一个课题",
    prompt: "请研究以下课题，核对资料来源，比较不同观点，并输出完整研究报告：",
  },
  {
    skill: "meeting",
    title: "整理会议纪要",
    prompt:
      "请根据我选择的会议资料，整理会议纪要和行动项清单。缺少的信息标为待确认。",
  },
  {
    skill: "analysis",
    title: "分析业务报表",
    prompt:
      "请分析我选择的业务报表，核对统计口径，整理关键指标、异常和建议，并保存分析报告。",
  },
];
export function BotPage({
  user,
  feedback,
  confirm,
  onDocument,
  onUpload,
  onConfigure,
  taskRequest,
  experienceRevision = 0,
}: {
  user: User;
  feedback: Feedback;
  confirm: Confirm;
  onDocument: (id: string) => void;
  onUpload: () => void;
  onConfigure: () => void;
  taskRequest?: { id: string; revision: number };
  experienceRevision?: number;
}) {
  const [feishuReturn] = useState(() => readFeishuReturn(user.id));
  const feishuDraftRestored = useRef(false);
  const feishuReturnHandled = useRef(false);
  const [feishuStatus, setFeishuStatus] = useState<FeishuStatus>();
  const [feishuError, setFeishuError] = useState("");
  const [feishuBusy, setFeishuBusy] = useState(false);
  const [library, setLibrary] = useState<Library | null>(null);
  const [pluginsOpen, setPluginsOpen] = useState(false);
  const pluginFocus = useRef<HTMLElement | null>(null);
  const openPlugins = () => {
    pluginFocus.current = document.activeElement as HTMLElement;
    setPluginsOpen(true);
  };
  const closePlugins = () => {
    const target = pluginFocus.current;
    setPluginsOpen(false);
    requestAnimationFrame(() => {
      if (target?.isConnected) target.focus({ preventScroll: true });
    });
  };
  const [memoryTab, setMemoryTab] = useState<
    "memory" | "skills" | "knowledge" | null
  >(null);
  const [memoryEnabled, setMemoryEnabled] = useState(true);
  const [knowledgeAssets, setKnowledgeAssets] = useState<KnowledgeAsset[]>([]);
  const [knowledgeAssetIds, setKnowledgeAssetIds] = useState<string[]>([]);
  const [knowledgeError, setKnowledgeError] = useState("");
  const [assetsLoaded, setAssetsLoaded] = useState(false);
  const harness = useHarnessPlugins();
  const cloud = useCloudComputer();
  const [cloudOpen, setCloudOpen] = useState(false);
  const [pluginIds, setPluginIds] = useState<string[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [gameOpen, setGameOpen] = useState(false);
  const [gameMounted, setGameMounted] = useState(false);
  const gameFocus = useRef<HTMLElement | null>(null);
  const openGame = () => {
    gameFocus.current = document.activeElement as HTMLElement;
    setGameMounted(true);
    setGameOpen(true);
  };
  useEffect(() => {
    if (gameOpen || !gameMounted) return;
    const reduced = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    const timer = window.setTimeout(
      () => {
        setGameMounted(false);
        const target = gameFocus.current?.isConnected
          ? gameFocus.current
          : input.current;
        target?.focus({ preventScroll: true });
      },
      reduced ? 0 : 380,
    );
    return () => clearTimeout(timer);
  }, [gameOpen, gameMounted]);
  useEffect(() => {
    if (!gameOpen) return;
    const exit = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      setGameOpen(false);
    };
    window.addEventListener("keydown", exit);
    return () => window.removeEventListener("keydown", exit);
  }, [gameOpen]);

  const [workspaceOpen, setWorkspaceOpen] = useState(() => {
    try {
      const value = localStorage.getItem("zhihui.bot.workspace-open");
      if (value !== null) return value === "1";
    } catch {
      /* Browser storage is optional. */
    }
    return window.matchMedia("(min-width: 1000px)").matches;
  });
  const [workspaceTab, setWorkspaceTab] = useState<"result" | "files">(
    "result",
  );
  const [selectedArtifactId, setSelectedArtifactId] = useState<string>();
  const [ancestors, setAncestors] = useState<Detail[]>([]);
  const [caps, setCaps] = useState<Caps>();
  const [devices, setDevices] = useState<LocalDevice[]>([]);
  const [deviceId, setDeviceId] = useState(() => {
    try {
      return localStorage.getItem(`zhihui.bot.device.${user.id}`) || "";
    } catch {
      return "";
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(`zhihui.bot.device.${user.id}`, deviceId);
    } catch {
      /* optional browser storage */
    }
  }, [deviceId, user.id]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [skills, setSkills] = useState<Skill[]>([]);
  const [connectors, setConnectors] = useState<Connector[]>([]);
  const [docs, setDocs] = useState<Document[]>([]);
  const [selected, setSelected] = useState(
    () =>
      feishuReturn.draft?.taskId ||
      new URLSearchParams(location.search).get("task") ||
      "",
  );
  const [detail, setDetail] = useState<Detail>();
  useEffect(() => {
    if (taskRequest) {
      setSelected(taskRequest.id);
      setPrompt("");
    }
  }, [taskRequest]);
  const previewDetail = detail?.evidence_available
    ? [detail, ...ancestors]
        .filter((value): value is Detail => !!value && value.evidence_available)
        .find((value) =>
          value.artifacts.some((file) => file.id === selectedArtifactId),
        )
    : undefined;
  const previewArtifact = previewDetail?.artifacts.find(
    (file) => file.id === selectedArtifactId,
  );
  useEffect(() => {
    setSelectedArtifactId(undefined);
  }, [selected]);
  useEffect(() => {
    if (selectedArtifactId && detail && !previewArtifact)
      setSelectedArtifactId(undefined);
  }, [selectedArtifactId, detail, previewArtifact]);
  const openArtifact = (id: string) => {
    setSelectedArtifactId(id);
    setWorkspaceTab("files");
    setWorkspaceOpen(true);
  };
  const streamConnected = useBotStream(
    selected,
    detail?.task.status,
    setDetail,
  );
  const [prompt, setPrompt] = useState(
    () => feishuReturn.draft?.prompt ?? readHomepageDraft(),
  );
  useEffect(() => {
    clearHomepageDraft();
  }, []);
  const [allowWeb, setAllowWeb] = useState(false);
  const [allowCode, setAllowCode] = useState(false);
  const selectPlugins = (ids: string[]) => {
    const addedWebPlugin = ids.some(
      (id) =>
        !pluginIds.includes(id) &&
        /^(?:@[^/]+\/)?dsh-web-(?:search|fetch)(?:-|$)/.test(id),
    );
    setPluginIds(ids);
    if (addedWebPlugin && !deviceId && caps?.web) {
      setAllowWeb(true);
      feedback("已加入联网插件，并开启本任务联网搜索");
    }
  };
  const [skillIds, setSkillIds] = useState<string[]>([]);
  const [connectorIds, setConnectorIds] = useState<string[]>([]);
  const [docIds, setDocIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [connectorForm, setConnectorForm] = useState(false);
  const [skillForm, setSkillForm] = useState(false);
  const [preview, setPreview] = useState<Skill>();
  const [cDraft, setCDraft] = useState({
    name: "",
    description: "",
    url: "",
    method: "GET",
    token: "",
  });
  const [sDraft, setSDraft] = useState({
    name: "",
    description: "",
    instructions: "",
  });
  const pollError = useRef(false);
  const selection = useRef(selected);
  const input = useRef<HTMLTextAreaElement>(null);
  const requestId = useRef<string>("");
  const requestSignature = useRef("");
  const optionsTask = useRef("");
  const refreshFeishu = useCallback(async () => {
    try {
      const status = await feishuApi.status();
      setFeishuStatus(status);
      setFeishuError("");
      return status;
    } catch (reason) {
      setFeishuError(
        reason instanceof Error
          ? reason.message
          : "飞书连接暂不可用，请稍后重试。",
      );
      throw reason;
    }
  }, []);
  const refresh = useCallback(async () => {
    const [c, t, s, cs, d, ds] = await Promise.all([
      api<Caps>("/api/bot/capabilities"),
      api<Task[]>("/api/bot/tasks"),
      api<Skill[]>("/api/bot/skills"),
      api<Connector[]>("/api/bot/connectors"),
      api<{ items: Document[] }>("/api/documents?limit=100"),
      api<LocalDevice[]>("/api/bot/devices"),
    ]);
    setCaps(c);
    setDevices(ds);
    setTasks(t);
    setSkills(s);
    setConnectors(cs);
    setDocs(d.items.filter((v) => v.status === "ready"));
    setLoaded(true);
    setError("");
    return cs;
  }, []);
  const refreshAssets = useCallback(async () => {
    try {
      const assets = await memoryApi.assets();
      const ready = assets.filter((asset) => asset.status === "ready");
      setKnowledgeAssets(ready);
      setKnowledgeAssetIds((ids) =>
        ids.filter((id) => ready.some((asset) => asset.id === id)),
      );
      setKnowledgeError("");
    } catch (reason) {
      setKnowledgeAssets([]);
      setKnowledgeError(
        reason instanceof Error ? reason.message : String(reason),
      );
    } finally {
      setAssetsLoaded(true);
    }
  }, []);
  const refreshExperience = useCallback(async () => {
    await Promise.all([refresh(), refreshAssets()]);
  }, [refresh, refreshAssets]);
  useEffect(() => {
    if (experienceRevision)
      void refreshExperience().catch((reason: Error) =>
        setError(reason.message),
      );
  }, [experienceRevision, refreshExperience]);
  useEffect(() => {
    void refreshAssets();
  }, [refreshAssets]);
  useEffect(() => {
    void refreshFeishu().catch(() => {});
  }, [refreshFeishu]);
  useEffect(() => {
    if (!feishuReturn.result) return;
    // Keep the initializer read-only; StrictMode may invoke it more than once.
    if (feishuReturn.draftError) clearFeishuDraft(user.id);
    const url = new URL(location.href);
    url.searchParams.delete("feishu");
    history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
  }, [feishuReturn, user.id]);
  useEffect(() => {
    let live = true;
    refresh().catch((e) => {
      if (live) {
        setLoaded(true);
        setError((e as Error).message);
      }
    });
    return () => {
      live = false;
    };
  }, [refresh]);
  useEffect(() => {
    selection.current = selected;
    setDetail(undefined);
    setError("");
    const url = new URL(location.href);
    url.searchParams.set("view", "bot");
    if (selected) url.searchParams.set("task", selected);
    else url.searchParams.delete("task");
    history.replaceState(null, "", `${url.pathname}${url.search}`);
    if (!selected) return;
    let live = true;
    const get = () =>
      api<Detail>(`/api/bot/tasks/${selected}`)
        .then((v) => {
          if (live) setDetail(v);
        })
        .catch((e) => {
          if (live) setError((e as Error).message);
        });
    void get();
    return () => {
      live = false;
    };
  }, [selected]);
  useEffect(() => {
    const controller = new AbortController();
    let inFlight = false;
    const tick = async () => {
      if (document.hidden || inFlight) return;
      inFlight = true;
      const key = selection.current;
      try {
        const [list, d, ds] = await Promise.all([
          api<Task[]>("/api/bot/tasks", { signal: controller.signal }),
          key && !streamConnected.current
            ? api<Detail>(`/api/bot/tasks/${key}`, {
                signal: controller.signal,
              })
            : Promise.resolve(undefined),
          api<LocalDevice[]>("/api/bot/devices", { signal: controller.signal }),
        ]);
        if (controller.signal.aborted) return;
        setTasks(list);
        setDevices(ds);
        if (key === selection.current && d && !streamConnected.current)
          setDetail(d);
        pollError.current = false;
      } catch (e) {
        if (!controller.signal.aborted && !pollError.current) {
          feedback(`同步暂时失败：${(e as Error).message}`, true);
          pollError.current = true;
        }
      } finally {
        inFlight = false;
      }
    };
    const timer = window.setInterval(() => void tick(), 3000);
    const visible = () => {
      if (!document.hidden) void tick();
    };
    document.addEventListener("visibilitychange", visible);
    return () => {
      clearInterval(timer);
      controller.abort();
      document.removeEventListener("visibilitychange", visible);
    };
  }, [feedback, streamConnected]);
  useEffect(() => {
    if (!selected) {
      optionsTask.current = "";
      return;
    }
    if (
      !detail ||
      detail.task.id !== selected ||
      optionsTask.current === selected
    )
      return;
    optionsTask.current = selected;
    const options = detail.task.options;
    setDocIds(options?.document_ids || []);
    setSkillIds(options?.skill_ids || []);
    setConnectorIds(options?.connector_ids || []);
    setPluginIds(options?.plugin_ids || []);
    setAllowWeb(options?.allow_web || false);
    setAllowCode(options?.allow_code || false);
    setDeviceId(options?.local_device_id || "");
    setMemoryEnabled(options?.memory_enabled !== false);
    setKnowledgeAssetIds(options?.knowledge_asset_ids || []);
  }, [selected, detail]);
  useEffect(() => {
    const draft = feishuReturn.draft;
    if (
      !draft ||
      draft.userId !== user.id ||
      feishuDraftRestored.current ||
      !loaded ||
      !assetsLoaded ||
      selected !== draft.taskId ||
      (selected && detail?.task.id !== selected)
    )
      return;
    feishuDraftRestored.current = true;
    setAllowWeb(draft.allowWeb);
    setAllowCode(draft.allowCode);
    setMemoryEnabled(draft.memoryEnabled);
    setDocIds(draft.docIds);
    setSkillIds(draft.skillIds);
    setConnectorIds(draft.connectorIds);
    setPluginIds(draft.pluginIds);
    setKnowledgeAssetIds(draft.knowledgeAssetIds);
    setDeviceId(draft.deviceId);
    clearFeishuDraft(user.id);
  }, [feishuReturn, loaded, assetsLoaded, selected, detail, user.id]);
  useEffect(() => {
    if (!feishuReturn.result || feishuReturnHandled.current || !loaded) return;
    feishuReturnHandled.current = true;
    const draftNotice = feishuReturn.draftError
      ? `${feishuReturn.draftError} `
      : "";
    if (feishuReturn.result !== "connected") {
      feedback(
        draftNotice +
          (feishuReturn.result === "cancelled"
            ? "已取消飞书授权，可继续编辑当前任务。"
            : "飞书授权未完成，可继续编辑当前任务或重试连接。"),
        feishuReturn.result === "error" || !!feishuReturn.draftError,
      );
      return;
    }
    void Promise.all([refreshFeishu(), refresh()])
      .then(([status, currentConnectors]) => {
        setLibrary("connectors");
        const verified =
          status.connected &&
          !status.needs_reconnect &&
          currentConnectors.some(
            (connector) =>
              connector.id === status.connector_id &&
              connector.provider === "feishu" &&
              connector.status !== "reconnect_required",
          );
        feedback(
          draftNotice +
            (verified
              ? "飞书已连接。请在应用连接器中选择飞书供当前任务使用。"
              : "尚未确认飞书连接，请重试或重新授权。当前任务未自动使用飞书。"),
          !verified || !!feishuReturn.draftError,
        );
      })
      .catch(() => {
        setLibrary("connectors");
        feedback(
          draftNotice + "暂无法确认飞书连接，请重试。请核对当前任务输入。",
          true,
        );
      });
  }, [feishuReturn, loaded, refreshFeishu, refresh, feedback]);

  const latestFeishuDraft = useRef<FeishuDraft | null>(null);
  latestFeishuDraft.current = {
    version: 1,
    userId: user.id,
    createdAt: Date.now(),
    taskId: selected,
    prompt,
    allowWeb,
    allowCode,
    memoryEnabled,
    docIds,
    skillIds,
    connectorIds,
    pluginIds,
    knowledgeAssetIds,
    deviceId,
  };
  const connectFeishu = async () => {
    if (feishuBusy) return;
    setFeishuBusy(true);
    setFeishuError("");
    try {
      saveFeishuDraft(latestFeishuDraft.current!);
      const { authorization_url } = await feishuApi.authorize();
      const target = officialFeishuAuthorizationUrl(authorization_url);
      const latest = latestFeishuDraft.current!;
      if (latest.userId !== user.id)
        throw new Error("登录账号已变化，请重新连接飞书。");
      // Keep edits made while the authorization request was in flight.
      saveFeishuDraft({ ...latest, createdAt: Date.now() });
      location.assign(target);
    } catch (reason) {
      clearFeishuDraft(user.id);
      setFeishuError(
        reason instanceof Error
          ? reason.message
          : "飞书授权暂未准备好，请重试。",
      );
      setFeishuBusy(false);
    }
  };
  useEffect(() => {
    try {
      localStorage.setItem(
        "zhihui.bot.workspace-open",
        workspaceOpen ? "1" : "0",
      );
    } catch {
      /* Browser storage is optional. */
    }
  }, [workspaceOpen]);
  useEffect(() => {
    setAncestors([]);
    const controller = new AbortController();
    const parent = detail?.task.options?.parent_task_id;
    if (!parent || !detail?.evidence_available) return;
    const restore = async () => {
      const earlier: Detail[] = [];
      const seen = new Set([selected]);
      let key: string | undefined = parent;
      while (key && !seen.has(key) && earlier.length < 100) {
        seen.add(key);
        const previous: Detail = await api<Detail>(
          `/api/bot/tasks/${encodeURIComponent(key)}`,
          { signal: controller.signal },
        );
        earlier.unshift(previous);
        key = previous.task.options?.parent_task_id;
      }
      if (!controller.signal.aborted) setAncestors(earlier);
    };
    void restore().catch(() => {
      if (!controller.signal.aborted)
        feedback("较早的对话暂未恢复，可刷新重试。", true);
    });
    return () => controller.abort();
  }, [
    selected,
    detail?.task.options?.parent_task_id,
    detail?.evidence_available,
    feedback,
  ]);
  const run = async (action: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    try {
      await action();
      setError("");
    } catch (e) {
      const text = (e as Error).message;
      setError(text);
      feedback(text, true);
    } finally {
      setBusy(false);
    }
  };
  const reloadDetail = async () => {
    await refresh();
    const key = selection.current;
    if (key) {
      const value = await api<Detail>(`/api/bot/tasks/${key}`);
      if (key === selection.current) setDetail(value);
    }
  };
  const submit = (parent?: Task) =>
    run(async () => {
      if (deviceId && !devices.some((d) => d.id === deviceId))
        throw new Error("本地设备连接已解除，请重新选择执行位置");
      if (!deviceId && !cloud.status && !cloud.error)
        throw new Error("正在连接云端服务，请稍候再提交");
      const useHarness = !deviceId && !!cloud.status?.available;
      if (!deviceId && pluginIds.length && !useHarness)
        throw new Error("云端服务暂不可用，请稍后重试或联系管理员");
      const invalidPlugins = pluginIds.filter(
        (id) =>
          !harness.catalog?.plugins.some(
            (plugin) => plugin.id === id && plugin.installed && plugin.enabled,
          ),
      );
      if (useHarness && invalidPlugins.length)
        throw new Error("所选插件已停用或卸载，请在插件面板重新选择");
      const options = {
        ...(deviceId ? { local_device_id: deviceId } : {}),
        allow_web: deviceId ? false : allowWeb,
        allow_code: deviceId ? false : allowCode,
        skill_ids: skillIds,
        connector_ids: deviceId ? [] : connectorIds,
        document_ids: docIds,
        plugin_ids: useHarness ? pluginIds : [],
        memory_enabled: memoryEnabled,
        knowledge_asset_ids: knowledgeAssetIds,
        ...(!deviceId
          ? { runtime: useHarness ? "deepseek-harness" : "pi-agent-core" }
          : {}),
        ...(parent ? { parent_task_id: parent.id } : {}),
      };
      const body = { prompt: prompt.trim(), options };
      const signature = JSON.stringify(body);
      if (signature !== requestSignature.current || !requestId.current) {
        requestId.current = randomUuid();
        requestSignature.current = signature;
      }
      const response = await post<{ id: string }>("/api/bot/tasks", {
        ...body,
        request_id: requestId.current,
      });
      requestId.current = "";
      void cloud.refresh();
      setSelected(response.id);
      setPrompt("");
      await refresh();
    });
  const useSkill = (skill: Skill) => {
    setSelected("");
    setLibrary(null);
    setSkillIds([skill.id]);
    setPrompt(`请使用「${skill.name}」完成以下任务：`);
    requestAnimationFrame(() => input.current?.focus());
  };
  const mood: BotMood = busy
    ? "thinking"
    : !selected
      ? prompt.trim()
        ? "listening"
        : "idle"
      : (
          {
            queued: "thinking",
            running: "working",
            waiting: "waiting",
            completed: "success",
            failed: "error",
            paused: "waiting",
            cancelled: "sleep",
          } as Record<string, BotMood>
        )[detail?.task.status || ""] || "thinking";
  return (
    <div
      className={`bot-page bot-chat-shell ${workspaceOpen ? "workspace-is-open" : ""}`}
      onPointerDown={(event) => {
        if (!deviceId || cloudOpen) cloud.recordActivity(event);
      }}
      onKeyDown={(event) => {
        if (!deviceId || cloudOpen) cloud.recordActivity(event);
      }}
    >
      <section className="bot-chat-pane" aria-label="对话页面">
        <header className="bot-heading">
          <div className="bot-heading-main">
            <div className="bot-avatar">
              <BloubAvatar mood={mood} size={72} />
            </div>
            <div>
              <h1>
                知小汇 <span>bot</span>
              </h1>
              <p>你的 AI 工作搭档</p>
            </div>
          </div>
          <div className="bot-heading-right">
            <button
              className="bot-cloud-entry"
              aria-label="云端电脑"
              aria-haspopup="dialog"
              aria-expanded={cloudOpen}
              onClick={() => setCloudOpen(true)}
            >
              <Cloud size={14} />
              <span>云端电脑</span>
              <i className={cloud.status?.connected ? "online" : ""} />
              <span className="bot-cloud-entry-status">
                {cloud.status?.connected ? "已连接" : "未连接"}
              </span>
            </button>
            <button
              className="bot-plugins-entry"
              aria-label="插件市场"
              aria-haspopup="dialog"
              aria-expanded={pluginsOpen}
              onClick={openPlugins}
            >
              <Package size={14} />
              插件
              {!!pluginIds.length && <small>{pluginIds.length}</small>}
            </button>
            <button
              className="icon-button"
              aria-label="任务历史"
              aria-expanded={historyOpen}
              aria-haspopup="dialog"
              onClick={() => setHistoryOpen((value) => !value)}
            >
              <History size={17} />
            </button>
            <button
              className="icon-button"
              title="刷新任务"
              disabled={busy}
              onClick={() => void run(reloadDetail)}
            >
              <RefreshCw size={16} className={busy ? "spin" : undefined} />
            </button>
            <button
              className="icon-button"
              aria-label="新建任务"
              onClick={() => {
                setGameOpen(false);
                setSelected("");
                setPrompt("");
                setPluginIds([]);
                setKnowledgeAssetIds([]);
                setMemoryEnabled(true);
                setHistoryOpen(false);
                requestAnimationFrame(() => input.current?.focus());
              }}
            >
              <Plus size={19} />
            </button>
            <button
              className="icon-button bot-workspace-toggle"
              aria-label={workspaceOpen ? "切换为纯对话" : "展开工作区"}
              aria-expanded={workspaceOpen}
              onClick={() => setWorkspaceOpen((value) => !value)}
            >
              {workspaceOpen ? (
                <PanelRightClose size={18} />
              ) : (
                <PanelRightOpen size={18} />
              )}
            </button>
          </div>
        </header>
        {historyOpen && (
          <div className="bot-history-menu" role="dialog" aria-label="任务历史">
            <div className="bot-section-title">
              <h2>
                我的任务 <small>{tasks.length}</small>
              </h2>
              <button
                className="icon-button"
                aria-label="关闭任务历史"
                onClick={() => setHistoryOpen(false)}
              >
                <X size={15} />
              </button>
            </div>
            <div className="bot-history-list">
              {tasks.map((task) => (
                <button
                  key={task.id}
                  className={`bot-history-item ${selected === task.id ? "active" : ""}`}
                  onClick={() => {
                    setGameOpen(false);
                    setSelected(task.id);
                    setPrompt("");
                    setHistoryOpen(false);
                  }}
                >
                  <strong>{task.title}</strong>
                  <span>
                    <Badge status={task.status} />
                    <time>{date(task.created_at)}</time>
                  </span>
                </button>
              ))}
              {!tasks.length && (
                <div className="bot-history-empty">
                  <Clock3 size={22} />
                  <p>交办的任务会保存在这里</p>
                </div>
              )}
            </div>
          </div>
        )}
        {error && (
          <div className="bot-notice error" role="alert">
            {error}
            <button
              className="text-button"
              onClick={() => void run(reloadDetail)}
            >
              重新加载
            </button>
          </div>
        )}
        <div
          className={`bot-chat-main ${gameOpen ? "is-gaming" : ""} ${gameMounted && !gameOpen ? "is-game-leaving" : ""}`}
        >
          <div
            className="bot-chat-conversation"
            inert={gameOpen}
            aria-hidden={gameOpen || undefined}
          >
            {!loaded || (selected && !detail && !error) ? (
              <div className="loading-panel">正在连接任务空间…</div>
            ) : (
              <BotConversation
                onPlay={openGame}
                gameOpen={gameOpen}
                detail={detail}
                ancestors={ancestors}
                onArtifact={openArtifact}
                mood={mood}
                busy={busy}
                onCancel={() =>
                  confirm(
                    "取消当前任务？已确认并执行的外部操作会保留。",
                    async () => {
                      await post(`/api/bot/tasks/${selected}/cancel`, {});
                      await reloadDetail();
                    },
                  )
                }
                onRetry={() =>
                  void run(async () => {
                    await post(`/api/bot/tasks/${selected}/retry`, {});
                    await reloadDetail();
                  })
                }
                onApprove={(id) =>
                  void run(async () => {
                    await post(`/api/bot/actions/${id}/approve`, {});
                    await reloadDetail();
                  })
                }
                onReject={(id) =>
                  void run(async () => {
                    await post(`/api/bot/actions/${id}/reject`, {});
                    await reloadDetail();
                  })
                }
                onFiles={() => {
                  setWorkspaceTab("files");
                  setWorkspaceOpen(true);
                }}
              />
            )}
          </div>
          <div
            className="bot-chat-composer"
            inert={gameOpen}
            aria-hidden={gameOpen || undefined}
          >
            {!selected && (
              <div className="bot-starters">
                {starters.map((starter) => (
                  <button
                    key={starter.skill}
                    onClick={() => {
                      setPrompt(starter.prompt);
                      setSkillIds(
                        skills.some((skill) => skill.id === starter.skill)
                          ? [starter.skill]
                          : [],
                      );
                      requestAnimationFrame(() => input.current?.focus());
                    }}
                  >
                    <strong>{starter.title}</strong>
                    <ArrowRight size={12} />
                  </button>
                ))}
              </div>
            )}
            {loaded && !caps?.agent && !selected && !deviceId && (
              <div className="bot-notice">
                <Sparkles size={14} />
                <span>当前使用原文检索。配置模型后可执行完整任务。</span>
                {user.role === "admin" && (
                  <button className="text-button" onClick={onConfigure}>
                    配置模型
                  </button>
                )}
              </div>
            )}
            <BotComposer
              prompt={prompt}
              onPrompt={setPrompt}
              inputRef={input}
              busy={busy}
              followup={!!selected}
              disabled={
                feishuBusy ||
                (!deviceId && !cloud.status && !cloud.error) ||
                (!!selected &&
                  (detail?.task.status !== "completed" ||
                    !detail.evidence_available))
              }
              submitLabel={
                !deviceId && !cloud.status && !cloud.error
                  ? "正在连接服务"
                  : selected && detail?.task.status !== "completed"
                    ? detail?.task.status === "waiting"
                      ? "等待确认"
                      : activeStates.includes(detail?.task.status || "")
                        ? "任务执行中"
                        : "请先恢复任务"
                    : undefined
              }
              onSubmit={() =>
                void submit(
                  detail?.task.status === "completed" ? detail.task : undefined,
                )
              }
              docs={docs}
              skills={skills}
              connectors={connectors}
              feishu={{
                status: feishuStatus,
                error: feishuError,
                busy: feishuBusy,
                onConnect: () => void connectFeishu(),
                onRefresh: () => void refreshFeishu().catch(() => {}),
              }}
              docIds={docIds}
              skillIds={skillIds}
              connectorIds={connectorIds}
              plugins={
                harness.catalog?.plugins.filter(
                  (plugin) => plugin.installed && plugin.enabled,
                ) || []
              }
              pluginIds={deviceId ? [] : pluginIds}
              onPlugins={selectPlugins}
              onManagePlugins={openPlugins}
              memoryEnabled={memoryEnabled}
              onMemory={setMemoryEnabled}
              knowledgeAssets={knowledgeAssets.map((asset) => ({
                id: asset.id,
                name: asset.name,
                description:
                  asset.kind === "wiki"
                    ? "Wiki · 已授权资料"
                    : "CodeGraph · 代码关系图",
              }))}
              knowledgeAssetIds={knowledgeAssetIds}
              onKnowledgeAssets={setKnowledgeAssetIds}
              knowledgeError={knowledgeError}
              onManageMemory={() => setMemoryTab("knowledge")}
              harnessEnabled={!!cloud.status?.available && !deviceId}
              onDocs={setDocIds}
              onSkills={setSkillIds}
              onConnectors={setConnectorIds}
              allowWeb={allowWeb}
              allowCode={allowCode}
              onWeb={setAllowWeb}
              onCode={setAllowCode}
              caps={caps}
              devices={devices}
              deviceId={deviceId}
              onDevice={(id) => {
                setDeviceId(id);
                if (id) {
                  setConnectorIds([]);
                  setPluginIds([]);
                }
              }}
              onManage={setLibrary}
              onUpload={onUpload}
              onRefresh={() => void run(refresh)}
            />
            <div className="bot-composer-note">
              <ShieldCheck size={11} />
              仅使用已授权的资料与应用<span>⌘ / Ctrl + Enter</span>
            </div>
          </div>
          {gameMounted && (
            <div
              className="bot-game-layer"
              inert={!gameOpen}
              aria-hidden={!gameOpen || undefined}
            >
              <InspirationGame
                active={gameOpen}
                onClose={() => setGameOpen(false)}
              />
            </div>
          )}
        </div>
      </section>
      {workspaceOpen && (
        <>
          <button
            className="bot-workspace-scrim"
            aria-label="关闭工作区遮罩"
            onClick={() => setWorkspaceOpen(false)}
          />
          <BotWorkspace
            detail={detail}
            selectedArtifactId={selectedArtifactId}
            previewArtifact={previewArtifact}
            previewArtifacts={previewDetail?.artifacts}
            onArtifact={openArtifact}
            mood={mood}
            tab={workspaceTab}
            onTab={setWorkspaceTab}
            onClose={() => setWorkspaceOpen(false)}
            onDocument={onDocument}
          />
        </>
      )}
      {pluginsOpen && (
        <BotPlugins
          available={!!cloud.status?.available}
          catalog={harness.catalog}
          loading={harness.loading}
          error={harness.error}
          pluginIds={pluginIds}
          local={!!deviceId}
          onPlugins={selectPlugins}
          onRefresh={harness.refresh}
          onClose={closePlugins}
          feedback={feedback}
        />
      )}
      {memoryTab !== null && (
        <BotMemory
          tasks={tasks}
          docs={docs}
          selectedTaskId={selected}
          initialTab={memoryTab}
          onClose={() => setMemoryTab(null)}
          onChanged={refreshExperience}
          onTask={(id) => {
            setSelected(id);
            setPrompt("");
            setMemoryTab(null);
          }}
          onDocument={(id) => {
            setMemoryTab(null);
            onDocument(id);
          }}
          feedback={feedback}
          confirm={confirm}
        />
      )}
      {cloudOpen && (
        <BotCloud
          cloud={cloud}
          onClose={() => setCloudOpen(false)}
          onSessions={() => {
            setCloudOpen(false);
            setHistoryOpen(true);
          }}
        />
      )}
      {loaded && (
        <>
          {library === "connectors" && (
            <Modal title="管理应用连接器" onClose={() => setLibrary(null)} wide>
              <section className="bot-library">
                <div className="bot-library-heading">
                  <div>
                    <h2>应用连接器</h2>
                    <p>授权飞书，或添加自己的 API 服务供任务使用。</p>
                  </div>
                  <button
                    className="button"
                    onClick={() => {
                      setLibrary(null);
                      setConnectorForm(true);
                    }}
                  >
                    <Plus size={16} />
                    自定义连接器
                  </button>
                </div>
                <BotFeishu
                  status={feishuStatus}
                  error={feishuError}
                  busy={feishuBusy}
                  onConnect={() => void connectFeishu()}
                  onRefresh={() => void refreshFeishu().catch(() => {})}
                  onTest={
                    feishuStatus?.connector_id
                      ? () =>
                          void run(async () => {
                            const result = await post<{ message: string }>(
                              `/api/bot/connectors/${feishuStatus.connector_id}/test`,
                              {},
                            );
                            feedback(result.message);
                            await refreshFeishu();
                          })
                      : undefined
                  }
                  onDisconnect={
                    feishuStatus?.connector_id
                      ? () => {
                          const id = feishuStatus.connector_id!;
                          confirm(
                            "断开飞书？之后的新任务将不能使用这项连接。",
                            async () => {
                              await api(`/api/bot/connectors/${id}`, {
                                method: "DELETE",
                              });
                              setConnectorIds((ids) =>
                                ids.filter((value) => value !== id),
                              );
                              await Promise.all([refresh(), refreshFeishu()]);
                            },
                          );
                        }
                      : undefined
                  }
                />
                <div className="bot-notice">
                  <ShieldCheck size={17} />
                  <span>
                    凭据加密保存。只使用任务中明确选择的连接器，POST
                    请求执行前展示完整内容。
                  </span>
                </div>
                {connectors.some((c) => c.provider !== "feishu") ? (
                  <div className="bot-library-grid">
                    {connectors
                      .filter((c) => c.provider !== "feishu")
                      .map((c) => (
                        <article className="bot-library-card" key={c.id}>
                          <div className="bot-section-title">
                            <span className="bot-card-icon">
                              <Plug size={21} />
                            </span>
                            <Badge
                              status={
                                c.method === "GET" ? "completed" : "pending"
                              }
                            />
                          </div>
                          <h3>{c.name}</h3>
                          <p>{c.description || "自定义应用连接器"}</p>
                          <code>{c.url}</code>
                          <small>
                            {c.method === "GET"
                              ? "GET · 读取数据"
                              : "POST · 写入前确认"}
                            {c.has_token ? " · 已保存凭据" : ""}
                          </small>
                          <div className="bot-card-footer">
                            <button
                              className="text-button"
                              disabled={busy}
                              onClick={() =>
                                void run(async () => {
                                  const result = await post<{
                                    message: string;
                                  }>(`/api/bot/connectors/${c.id}/test`, {});
                                  feedback(result.message);
                                })
                              }
                            >
                              测试配置
                            </button>
                            <button
                              className="icon-button"
                              title={`移除 ${c.name}`}
                              onClick={() =>
                                confirm(
                                  `移除「${c.name}」？它将停止供新任务使用。`,
                                  async () => {
                                    await api(`/api/bot/connectors/${c.id}`, {
                                      method: "DELETE",
                                    });
                                    await refresh();
                                    setConnectorIds((ids) =>
                                      ids.filter((id) => id !== c.id),
                                    );
                                  },
                                )
                              }
                            >
                              <Trash2 size={15} />
                            </button>
                          </div>
                        </article>
                      ))}
                  </div>
                ) : (
                  <div className="bot-empty">
                    <Plug size={38} />
                    <h3>也可以连接自己的 API</h3>
                    <p>通过上方“自定义连接器”添加固定服务地址。</p>
                  </div>
                )}
              </section>
            </Modal>
          )}
          {library === "skills" && (
            <Modal title="管理技能" onClose={() => setLibrary(null)} wide>
              <section className="bot-library">
                <div className="bot-library-heading">
                  <div>
                    <h2>技能库</h2>
                    <p>选择工作流，或导入社区的 SKILL.md，作为任务执行偏好。</p>
                  </div>
                  <button
                    className="button primary"
                    onClick={() => {
                      setLibrary(null);
                      setSkillForm(true);
                    }}
                  >
                    <Plus size={16} />
                    导入 / 创建技能
                  </button>
                </div>
                <div className="bot-library-grid">
                  {skills.map((s) => (
                    <article className="bot-library-card" key={s.id}>
                      <div className="bot-section-title">
                        <span className="bot-card-icon violet">
                          <Sparkles size={21} />
                        </span>
                        <span className="bot-label">
                          {s.builtin ? "内置" : "个人导入"}
                        </span>
                      </div>
                      <h3>{s.name}</h3>
                      <p>{s.description}</p>
                      <div className="bot-card-footer">
                        <button
                          className="text-button"
                          onClick={() => useSkill(s)}
                        >
                          使用技能 <ArrowRight size={14} />
                        </button>
                        <button
                          className="text-button"
                          onClick={() => {
                            setLibrary(null);
                            setPreview(s);
                          }}
                        >
                          查看
                        </button>
                        {!s.builtin && (
                          <button
                            className="icon-button"
                            title={`删除 ${s.name}`}
                            onClick={() =>
                              confirm(
                                `删除「${s.name}」？已经交办的任务会保留自己的技能快照。`,
                                async () => {
                                  await api(`/api/bot/skills/${s.id}`, {
                                    method: "DELETE",
                                  });
                                  setSkillIds((ids) =>
                                    ids.filter((id) => id !== s.id),
                                  );
                                  await refresh();
                                },
                              )
                            }
                          >
                            <Trash2 size={15} />
                          </button>
                        )}
                      </div>
                    </article>
                  ))}
                </div>
              </section>
            </Modal>
          )}
        </>
      )}
      {connectorForm && (
        <Modal title="添加应用连接器" onClose={() => setConnectorForm(false)}>
          <form
            className="bot-modal-form"
            onSubmit={(e) => {
              e.preventDefault();
              void run(async () => {
                await post("/api/bot/connectors", cDraft);
                setConnectorForm(false);
                setCDraft({
                  name: "",
                  description: "",
                  url: "",
                  method: "GET",
                  token: "",
                });
                await refresh();
                setLibrary("connectors");
                feedback("连接器已加密保存");
              });
            }}
          >
            <label>
              连接器名称
              <input
                required
                maxLength={60}
                placeholder="例如：项目任务、团队日历"
                value={cDraft.name}
                onChange={(e) => setCDraft({ ...cDraft, name: e.target.value })}
              />
            </label>
            <label>
              用途描述
              <textarea
                maxLength={500}
                placeholder="说明 API 用途和 input 所需参数，帮助 bot 正确调用"
                value={cDraft.description}
                onChange={(e) =>
                  setCDraft({ ...cDraft, description: e.target.value })
                }
              />
            </label>
            <label>
              固定 API 地址
              <input
                required
                type="url"
                placeholder="https://your-app.example/api/tasks"
                value={cDraft.url}
                onChange={(e) => setCDraft({ ...cDraft, url: e.target.value })}
              />
            </label>
            <label>
              操作方式
              <select
                value={cDraft.method}
                onChange={(e) =>
                  setCDraft({ ...cDraft, method: e.target.value })
                }
              >
                <option value="GET">GET · 读取（input 转为查询参数）</option>
                <option value="POST">
                  POST · 写入（input 作为 JSON，需要确认）
                </option>
              </select>
            </label>
            <label>
              Bearer Token
              <input
                type="password"
                autoComplete="new-password"
                maxLength={4096}
                placeholder="可选，保存后不回传浏览器"
                value={cDraft.token}
                onChange={(e) =>
                  setCDraft({ ...cDraft, token: e.target.value })
                }
              />
            </label>
            <p className="bot-form-help">
              {caps?.connector_hosts.length
                ? `允许的服务：${caps.connector_hosts.join("、")}`
                : "部署管理员需先在 BOT_CONNECTOR_HOSTS 中配置允许的 host:port。"}
            </p>
            <button
              className="button primary"
              disabled={busy || !caps?.connectors_enabled}
            >
              {busy ? "正在保存…" : "保存连接器"}
            </button>
          </form>
        </Modal>
      )}
      {skillForm && (
        <Modal title="导入或创建技能" onClose={() => setSkillForm(false)}>
          <form
            className="bot-modal-form"
            onSubmit={(e) => {
              e.preventDefault();
              void run(async () => {
                await post("/api/bot/skills", sDraft);
                setSkillForm(false);
                setSDraft({ name: "", description: "", instructions: "" });
                await refresh();
                setLibrary("skills");
                feedback("技能已加入个人技能库");
              });
            }}
          >
            <label className="bot-import">
              导入 Markdown / SKILL.md
              <input
                type="file"
                accept=".md,.txt,text/markdown,text/plain"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (!file) return;
                  void run(async () => {
                    if (file.size > 100000)
                      throw new Error("技能文件最多 100 KB");
                    const raw = await file.text();
                    const instructions = raw.replace(
                      /^---\s*\n[\s\S]*?\n---\s*/,
                      "",
                    );
                    if ([...instructions].length > 12000)
                      throw new Error("技能指令超过 12000 字，请精简后导入。");
                    const front = raw.match(/^---\s*\n([\s\S]*?)\n---/);
                    const field = (name: string) =>
                      front?.[1]
                        .match(new RegExp(`^${name}:\\s*(.+)$`, "m"))?.[1]
                        .trim()
                        .replace(/^["']|["']$/g, "") || "";
                    setSDraft({
                      name:
                        field("name") || file.name.replace(/\.(md|txt)$/i, ""),
                      description: field("description"),
                      instructions,
                    });
                  });
                }}
              />
            </label>
            <label>
              技能名称
              <input
                required
                maxLength={60}
                value={sDraft.name}
                onChange={(e) => setSDraft({ ...sDraft, name: e.target.value })}
              />
            </label>
            <label>
              一句话说明
              <input
                maxLength={500}
                value={sDraft.description}
                onChange={(e) =>
                  setSDraft({ ...sDraft, description: e.target.value })
                }
              />
            </label>
            <label>
              工作流指令
              <textarea
                required
                maxLength={12000}
                rows={9}
                value={sDraft.instructions}
                placeholder="描述任务步骤、输出格式和核对要求。"
                onChange={(e) =>
                  setSDraft({ ...sDraft, instructions: e.target.value })
                }
              />
            </label>
            <p className="bot-form-help">
              导入后可以检查和编辑。技能提供工作流文本；仓库中的脚本及其他文件不会被导入或执行。
            </p>
            <button className="button primary" disabled={busy}>
              保存技能
            </button>
          </form>
        </Modal>
      )}
      {preview && (
        <Modal title={preview.name} onClose={() => setPreview(undefined)}>
          <div className="bot-skill-preview markdown">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>
              {preview.instructions}
            </ReactMarkdown>
          </div>
          <button
            className="button primary"
            onClick={() => {
              useSkill(preview);
              setPreview(undefined);
            }}
          >
            使用这个技能 <ArrowRight size={15} />
          </button>
        </Modal>
      )}
    </div>
  );
}
