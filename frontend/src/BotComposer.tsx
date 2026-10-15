import { useEffect, useId, useRef, useState } from "react";
import type { RefObject } from "react";
import {
  ArrowRight,
  ArrowLeft,
  BookOpen,
  Brain,
  Check,
  ChevronRight,
  Cloud,
  Code2,
  FileText,
  Globe2,
  Loader2,
  LayoutGrid,
  Plus,
  Plug,
  Package,
  Search,
  Settings2,
  Sparkles,
  X,
} from "lucide-react";
import type { Document } from "./types";
import type { LocalDevice } from "./bot-types";
import { BotExecution } from "./BotExecution";
import { BotFeishu, type FeishuConnectionProps } from "./BotFeishu";

type Resource = { id: string; name: string; description: string };
type Panel = "documents" | "connectors" | "skills" | "knowledge" | "cloud";
type Props = {
  prompt: string;
  onPrompt: (value: string) => void;
  inputRef?: RefObject<HTMLTextAreaElement | null>;
  busy: boolean;
  disabled?: boolean;
  submitLabel?: string;
  followup?: boolean;
  onSubmit: () => void;
  docs: Document[];
  skills: Resource[];
  connectors: (Resource & {
    method: string;
    provider?: "feishu" | "generic";
    status?: "connected" | "reconnect_required";
  })[];
  feishu?: FeishuConnectionProps;
  docIds: string[];
  skillIds: string[];
  connectorIds: string[];
  plugins?: Resource[];
  pluginIds?: string[];
  onPlugins?: (ids: string[]) => void;
  onManagePlugins?: () => void;
  memoryEnabled?: boolean;
  onMemory?: (enabled: boolean) => void;
  knowledgeAssets?: Resource[];
  knowledgeAssetIds?: string[];
  onKnowledgeAssets?: (ids: string[]) => void;
  knowledgeError?: string;
  onManageMemory?: () => void;
  harnessEnabled?: boolean;
  onDocs: (ids: string[]) => void;
  onSkills: (ids: string[]) => void;
  onConnectors: (ids: string[]) => void;
  allowWeb: boolean;
  allowCode: boolean;
  onWeb: (value: boolean) => void;
  onCode: (value: boolean) => void;
  caps?: {
    agent: boolean;
    web: boolean;
    code: boolean;
    code_configured?: boolean;
    worker: boolean;
  };
  onManage: (library: "connectors" | "skills") => void;
  onUpload: () => void;
  onRefresh: () => void;
  devices: LocalDevice[];
  deviceId: string;
  onDevice: (id: string) => void;
};

const panels = [
  { id: "documents", title: "资料", icon: FileText, limit: 10 },
  { id: "connectors", title: "应用连接器", icon: Plug, limit: 10 },
  { id: "skills", title: "技能", icon: Sparkles, limit: 5 },
  { id: "knowledge", title: "项目知识", icon: BookOpen, limit: 10 },
  { id: "cloud", title: "云端", icon: Cloud, limit: 0 },
] as const;

export function BotComposer(props: Props) {
  const {
    prompt,
    onPrompt,
    inputRef,
    busy,
    disabled,
    submitLabel,
    followup,
    onSubmit,
    docs,
    skills,
    connectors,
    docIds,
    skillIds,
    connectorIds,
    onDocs,
    onSkills,
    onConnectors,
    allowWeb,
    allowCode,
    onWeb,
    onCode,
    onManage,
    onUpload,
    onRefresh,
  } = props;
  const [panel, setPanel] = useState<Panel | null>(null);
  const [moreOpen, setMoreOpen] = useState(false);
  const [query, setQuery] = useState("");
  const root = useRef<HTMLFormElement>(null);
  const popover = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const moreFocus = useRef<Panel | "web">("web");
  const localInput = useRef<HTMLTextAreaElement>(null);
  const id = useId();
  const promptId = `${id}-prompt`;
  const panelId = `${id}-panel`;
  const moreId = `${id}-more`;
  const webDisabledReason = props.deviceId
    ? "当前使用本地设备，请在本地 Harness 中配置联网能力"
    : !props.caps
      ? "正在检测联网能力"
      : !props.caps.web
        ? "管理员暂未启用联网能力"
        : "";
  const webActive = allowWeb && !webDisabledReason;

  useEffect(() => {
    if (!panel && !moreOpen) return;
    const frame = requestAnimationFrame(() => {
      const target = moreOpen
        ? popover.current?.querySelector<HTMLButtonElement>(
            `[data-composer-option="${moreFocus.current}"]:not(:disabled)`,
          ) ||
          popover.current?.querySelector<HTMLButtonElement>(
            ".bot-more-option:not(:disabled)",
          )
        : popover.current?.querySelector<HTMLInputElement>(
            "input:not(:disabled)",
          ) ||
          popover.current?.querySelector<HTMLButtonElement>(
            "button:not(:disabled)",
          );
      target?.focus();
    });
    const dismiss = (event: PointerEvent) => {
      if (
        !popover.current?.contains(event.target as Node) &&
        !trigger.current?.contains(event.target as Node)
      ) {
        setPanel(null);
        setMoreOpen(false);
      }
    };
    document.addEventListener("pointerdown", dismiss);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("pointerdown", dismiss);
    };
  }, [panel, moreOpen]);

  const close = () => {
    setPanel(null);
    setMoreOpen(false);
    trigger.current?.focus();
  };
  const returnToMore = () => {
    setPanel(null);
    setMoreOpen(true);
  };
  const selected = {
    documents: docIds,
    connectors: connectorIds,
    skills: skillIds,
    knowledge: props.knowledgeAssetIds || [],
    cloud: [webActive && "web", allowCode && "code"].filter(Boolean),
  };
  const items =
    panel === "documents"
      ? docs.map((d) => ({
          id: d.id,
          name: d.title,
          description: d.space_name || "知识库资料",
        }))
      : panel === "connectors"
        ? connectors.map((c) => ({
            ...c,
            description:
              c.provider === "feishu" && c.status === "reconnect_required"
                ? "需要重新授权后使用"
                : `${c.method === "GET" ? "读取数据" : "写入前确认"}${c.description ? ` · ${c.description}` : ""}`,
          }))
        : panel === "skills"
          ? skills
          : panel === "knowledge"
            ? props.knowledgeAssets || []
            : [];
  const filtered = items.filter((item) =>
    `${item.name} ${item.description}`
      .toLocaleLowerCase()
      .includes(query.trim().toLocaleLowerCase()),
  );
  const config = panels.find((item) => item.id === panel);
  const chips = [
    ...(props.pluginIds || []).map((key) => ({
      key: `plugin-${key}`,
      name: props.plugins?.find((plugin) => plugin.id === key)?.name || key,
      icon: Package,
      remove: () =>
        props.onPlugins?.((props.pluginIds || []).filter((id) => id !== key)),
    })),
    ...docIds.map((key) => ({
      key: `doc-${key}`,
      name: docs.find((d) => d.id === key)?.title || "已授权资料",
      icon: FileText,
      remove: () => onDocs(docIds.filter((v) => v !== key)),
    })),
    ...connectorIds.map((key) => ({
      key: `app-${key}`,
      name: connectors.find((c) => c.id === key)?.name || "已授权应用",
      icon: Plug,
      remove: () => onConnectors(connectorIds.filter((v) => v !== key)),
    })),
    ...skillIds.map((key) => ({
      key: `skill-${key}`,
      name: skills.find((s) => s.id === key)?.name || "已选技能",
      icon: Sparkles,
      remove: () => onSkills(skillIds.filter((v) => v !== key)),
    })),
    ...(props.knowledgeAssetIds || []).map((key) => ({
      key: `knowledge-${key}`,
      name:
        props.knowledgeAssets?.find((asset) => asset.id === key)?.name ||
        "已选项目知识",
      icon: BookOpen,
      remove: () =>
        props.onKnowledgeAssets?.(
          (props.knowledgeAssetIds || []).filter((id) => id !== key),
        ),
    })),
    ...(webActive
      ? [
          {
            key: "web",
            name: "联网搜索",
            icon: Globe2,
            remove: () => onWeb(false),
          },
        ]
      : []),
    ...(allowCode
      ? [
          {
            key: "code",
            name: "代码执行",
            icon: Code2,
            remove: () => onCode(false),
          },
        ]
      : []),
  ];

  return (
    <form
      ref={root}
      className={`bot-composer ${followup ? "bot-followup" : ""} ${prompt.trim() ? "has-prompt" : ""} ${busy ? "is-busy" : ""}`}
      onSubmit={(event) => {
        event.preventDefault();
        if (!prompt.trim() || busy || disabled) return;
        setPanel(null);
        setMoreOpen(false);
        onSubmit();
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape" && (panel || moreOpen)) {
          event.preventDefault();
          event.stopPropagation();
          close();
        }
      }}
      onBlur={(event) => {
        if (
          event.relatedTarget &&
          !event.currentTarget.contains(event.relatedTarget)
        ) {
          setPanel(null);
          setMoreOpen(false);
        }
      }}
    >
      <label htmlFor={promptId} className="sr-only">
        {followup ? "继续对话" : "任务描述"}
      </label>
      <textarea
        id={promptId}
        ref={inputRef || localInput}
        value={prompt}
        maxLength={6000}
        onChange={(event) => onPrompt(event.target.value)}
        placeholder={
          followup
            ? "继续提问，或告诉我如何调整成果…"
            : "描述你的任务，或带上资料一起开始…"
        }
        onKeyDown={(event) => {
          if (
            event.key === "Enter" &&
            (event.metaKey || event.ctrlKey) &&
            !event.nativeEvent.isComposing
          ) {
            event.preventDefault();
            root.current?.requestSubmit();
          }
        }}
        required
      />
      <div className="bot-composer-tools">
        <div className="bot-tool-triggers" aria-label="任务资料与工具">
          <button
            ref={trigger}
            type="button"
            className={`bot-tool-trigger bot-more-trigger ${moreOpen || panel ? "open" : ""}`}
            aria-label="更多"
            aria-expanded={moreOpen || !!panel}
            aria-controls={moreOpen ? moreId : panel ? panelId : undefined}
            aria-haspopup="dialog"
            onClick={() => {
              const opening = !moreOpen && !panel;
              setPanel(null);
              moreFocus.current = "web";
              setMoreOpen(opening);
            }}
          >
            <LayoutGrid size={16} />
            <span>更多</span>
            {!!chips.length && <small>{chips.length}</small>}
          </button>
        </div>
        {!!chips.length && (
          <div className="bot-selection" aria-label="已选资料与工具">
            {chips.map((chip) => (
              <span className="bot-selection-chip" key={chip.key}>
                <chip.icon size={13} />
                <span title={chip.name}>{chip.name}</span>
                <button
                  type="button"
                  aria-label={`移除 ${chip.name}`}
                  onClick={chip.remove}
                >
                  <X size={12} />
                </button>
              </span>
            ))}
          </div>
        )}
        <button
          type="submit"
          className="bot-submit"
          disabled={busy || disabled || !prompt.trim()}
          title="⌘ / Ctrl + Enter 提交"
        >
          <span>
            {busy
              ? "正在交办"
              : submitLabel || (followup ? "继续对话" : "开始任务")}
          </span>
          {busy ? (
            <Loader2 className="spin" size={17} />
          ) : (
            <ArrowRight size={17} />
          )}
        </button>
      </div>
      {moreOpen && (
        <div
          className="bot-tool-panel bot-more-panel"
          ref={popover}
          id={moreId}
          role="dialog"
          aria-label="更多功能"
        >
          <div className="bot-tool-panel-head">
            <span className="bot-tool-panel-icon">
              <LayoutGrid size={17} />
            </span>
            <div>
              <h3>更多功能</h3>
              <p>为这次对话选择能力与资料</p>
            </div>
            <button
              type="button"
              className="icon-button"
              aria-label="关闭更多功能"
              onClick={close}
            >
              <X size={16} />
            </button>
          </div>
          <div className="bot-more-options">
            <button
              type="button"
              role="switch"
              aria-label="联网搜索"
              aria-checked={webActive}
              data-composer-option="web"
              className="bot-more-option"
              disabled={!!webDisabledReason}
              title={webDisabledReason || "查询公开网页，补充资料来源"}
              onClick={() => onWeb(!allowWeb)}
            >
              <Globe2 size={17} />
              <span>联网搜索</span>
              <small>
                {props.deviceId
                  ? "本地"
                  : !props.caps
                    ? "检测中"
                    : !props.caps.web
                      ? "未启用"
                      : webActive
                        ? "开"
                        : "关"}
              </small>
              <span className="bot-more-switch" aria-hidden="true" />
            </button>
            {webDisabledReason && (
              <p className="bot-more-help">{webDisabledReason}</p>
            )}
            <button
              type="button"
              role="switch"
              aria-label="本任务使用个人记忆"
              aria-checked={props.memoryEnabled !== false}
              className="bot-more-option"
              title="本任务可以读取已审核的个人记忆"
              onClick={() => props.onMemory?.(props.memoryEnabled === false)}
            >
              <Brain size={17} />
              <span>个人记忆</span>
              <small>{props.memoryEnabled !== false ? "开" : "关"}</small>
              <span className="bot-more-switch" aria-hidden="true" />
            </button>
            <div className="bot-more-divider" />
            {props.onManagePlugins && (
              <button
                type="button"
                className="bot-more-option"
                aria-label="插件市场与任务插件"
                aria-haspopup="dialog"
                onClick={() => {
                  close();
                  props.onManagePlugins?.();
                }}
              >
                <Package size={17} />
                <span>插件</span>
                {!!props.pluginIds?.length && (
                  <small>{props.pluginIds.length} 个已选</small>
                )}
                <ChevronRight size={14} />
              </button>
            )}
            {panels.map((item) => (
              <button
                type="button"
                key={item.id}
                className="bot-more-option"
                data-composer-option={item.id}
                aria-label={item.title}
                aria-haspopup="dialog"
                onClick={() => {
                  moreFocus.current = item.id;
                  setQuery("");
                  setMoreOpen(false);
                  setPanel(item.id);
                }}
              >
                <item.icon size={17} />
                <span>
                  {item.id === "cloud" && props.deviceId
                    ? "本地执行"
                    : item.title}
                </span>
                {!!selected[item.id].length && (
                  <small>{selected[item.id].length} 项</small>
                )}
                <ChevronRight size={14} />
              </button>
            ))}
          </div>
        </div>
      )}
      {panel && config && (
        <div
          className={`bot-tool-panel ${panel === "cloud" ? "bot-execution-panel" : ""}`}
          ref={popover}
          id={panelId}
          role="dialog"
          aria-label={`选择${config.title}`}
          key={panel}
        >
          <div className="bot-tool-panel-head">
            <button
              type="button"
              className="icon-button bot-panel-back"
              aria-label="返回更多功能"
              onClick={returnToMore}
            >
              <ArrowLeft size={16} />
            </button>
            <span className="bot-tool-panel-icon">
              <config.icon size={17} />
            </span>
            <div>
              <h3>{panel === "cloud" ? "执行位置" : `选择${config.title}`}</h3>
              {panel !== "cloud" && (
                <p>
                  已选 {selected[panel].length} / {config.limit}
                </p>
              )}
            </div>
            <button
              type="button"
              className="icon-button"
              aria-label="关闭选择面板"
              onClick={close}
            >
              <X size={16} />
            </button>
          </div>
          {panel === "cloud" ? (
            <div className="bot-cloud-options">
              <BotExecution
                devices={props.devices}
                deviceId={props.deviceId}
                onSelect={props.onDevice}
                onRefresh={onRefresh}
              />
              <div className="bot-cloud-permissions" aria-label="云端任务权限">
                <label
                  className={`bot-cloud-option ${props.deviceId || !props.caps?.web ? "unavailable" : ""}`}
                >
                  <Globe2 size={17} />
                  <span>
                    <strong>联网检索</strong>
                    <small>
                      {webDisabledReason || "查询公开网页，补充资料来源"}
                    </small>
                  </span>
                  <input
                    type="checkbox"
                    checked={webActive}
                    disabled={!!webDisabledReason}
                    onChange={(event) => onWeb(event.target.checked)}
                  />
                  <span className="bot-switch" aria-hidden="true" />
                </label>
                <label
                  className={`bot-cloud-option ${props.deviceId || !(props.caps?.code || (props.harnessEnabled && props.caps?.code_configured)) ? "unavailable" : ""}`}
                >
                  <Code2 size={17} />
                  <span>
                    <strong>代码执行</strong>
                    <small>
                      {props.caps?.code ||
                      (props.harnessEnabled && props.caps?.code_configured)
                        ? "在隔离环境中分析数据、处理文件"
                        : "云端代码环境尚未就绪"}
                    </small>
                  </span>
                  <input
                    type="checkbox"
                    checked={allowCode && !props.deviceId}
                    disabled={
                      !!props.deviceId ||
                      !(
                        props.caps?.code ||
                        (props.harnessEnabled && props.caps?.code_configured)
                      )
                    }
                    onChange={(event) => onCode(event.target.checked)}
                  />
                  <span className="bot-switch" aria-hidden="true" />
                </label>
              </div>
            </div>
          ) : (
            <>
              {panel === "connectors" && props.feishu && (
                <BotFeishu {...props.feishu} compact />
              )}
              <label className="bot-resource-search">
                <Search size={15} />
                <input
                  type="search"
                  aria-label={`搜索${config.title}`}
                  placeholder={`搜索${config.title}…`}
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") event.preventDefault();
                  }}
                />
              </label>
              <div className="bot-picker">
                {filtered.map((item) => {
                  const ids =
                    panel === "documents"
                      ? docIds
                      : panel === "skills"
                        ? skillIds
                        : panel === "knowledge"
                          ? props.knowledgeAssetIds || []
                          : connectorIds;
                  const setIds =
                    panel === "documents"
                      ? onDocs
                      : panel === "skills"
                        ? onSkills
                        : panel === "knowledge"
                          ? (ids: string[]) => props.onKnowledgeAssets?.(ids)
                          : onConnectors;
                  const checked = ids.includes(item.id);
                  const needsReconnect =
                    panel === "connectors" &&
                    connectors.find((c) => c.id === item.id)?.status ===
                      "reconnect_required";
                  const disabled =
                    !checked && (ids.length >= config.limit || needsReconnect);
                  return (
                    <label
                      key={item.id}
                      className={disabled ? "unavailable" : ""}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={disabled}
                        onChange={() =>
                          setIds(
                            checked
                              ? ids.filter((key) => key !== item.id)
                              : [...ids, item.id],
                          )
                        }
                      />
                      <span className="bot-option-icon">
                        <config.icon size={17} />
                      </span>
                      <span className="bot-option-text">
                        <strong>{item.name}</strong>
                        <small>{item.description}</small>
                      </span>
                      <span className="bot-option-check" aria-hidden="true">
                        {checked && <Check size={13} />}
                      </span>
                    </label>
                  );
                })}
                {!filtered.length && (
                  <div className="bot-picker-empty">
                    <config.icon size={26} />
                    <strong>
                      {query
                        ? "没有找到匹配项"
                        : panel === "documents"
                          ? "还没有可用资料"
                          : panel === "connectors"
                            ? "连接你的第一个应用"
                            : panel === "knowledge"
                              ? props.knowledgeError
                                ? "暂无法加载项目知识"
                                : "还没有就绪的项目知识"
                              : "添加你的第一个技能"}
                    </strong>
                    <p>
                      {query
                        ? "试试其他关键词"
                        : panel === "documents"
                          ? "上传资料，或直接从知识库开始"
                          : panel === "connectors"
                            ? "把日常工作应用带进这个任务"
                            : panel === "knowledge"
                              ? props.knowledgeError ||
                                "在记忆与经验中构建 Wiki 或代码关系图"
                              : "导入常用方法，让任务更顺手"}
                    </p>
                  </div>
                )}
              </div>
              {selected[panel].length >= config.limit && (
                <p className="bot-panel-help" role="status">
                  已达到选择上限，可先移除已选项。
                </p>
              )}
              <div className="bot-tool-panel-foot">
                {panel === "documents" ? (
                  <>
                    <button
                      type="button"
                      className="text-button"
                      onClick={() => {
                        close();
                        onUpload();
                      }}
                    >
                      <Plus size={14} />
                      上传资料
                    </button>
                    <button
                      type="button"
                      className="text-button"
                      disabled={busy}
                      onClick={onRefresh}
                    >
                      刷新列表
                    </button>
                  </>
                ) : panel === "knowledge" ? (
                  <button
                    type="button"
                    className="text-button"
                    onClick={() => {
                      close();
                      props.onManageMemory?.();
                    }}
                  >
                    <Settings2 size={14} />
                    管理项目知识
                  </button>
                ) : (
                  <button
                    type="button"
                    className="text-button"
                    onClick={() => {
                      close();
                      onManage(panel);
                    }}
                  >
                    <Settings2 size={14} />
                    {panel === "skills" ? "管理技能" : "管理连接器"}
                  </button>
                )}
                <button
                  type="button"
                  className="bot-panel-done"
                  onClick={close}
                >
                  完成
                  <Check size={13} />
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </form>
  );
}
