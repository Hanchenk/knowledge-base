import { useEffect, useId, useRef, useState } from "react";
import type { RefObject } from "react";
import {
  ArrowRight,
  Check,
  ChevronDown,
  Cloud,
  Code2,
  FileText,
  Globe2,
  Loader2,
  Plus,
  Plug,
  Search,
  Settings2,
  Sparkles,
  X,
} from "lucide-react";
import type { Document } from "./types";
import type { LocalDevice } from "./bot-types";
import { BotExecution } from "./BotExecution";

type Resource = { id: string; name: string; description: string };
type Panel = "documents" | "connectors" | "skills" | "cloud";
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
  connectors: (Resource & { method: string })[];
  docIds: string[];
  skillIds: string[];
  connectorIds: string[];
  onDocs: (ids: string[]) => void;
  onSkills: (ids: string[]) => void;
  onConnectors: (ids: string[]) => void;
  allowWeb: boolean;
  allowCode: boolean;
  onWeb: (value: boolean) => void;
  onCode: (value: boolean) => void;
  caps?: { agent: boolean; web: boolean; code: boolean; worker: boolean };
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
  const [query, setQuery] = useState("");
  const root = useRef<HTMLFormElement>(null);
  const popover = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const localInput = useRef<HTMLTextAreaElement>(null);
  const id = useId();
  const promptId = `${id}-prompt`;
  const panelId = `${id}-panel`;

  useEffect(() => {
    if (!panel) return;
    const frame = requestAnimationFrame(() => {
      popover.current
        ?.querySelector<HTMLInputElement>("input:not(:disabled)")
        ?.focus();
    });
    const dismiss = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setPanel(null);
    };
    document.addEventListener("pointerdown", dismiss);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("pointerdown", dismiss);
    };
  }, [panel]);

  const close = () => {
    setPanel(null);
    trigger.current?.focus();
  };
  const selected = {
    documents: docIds,
    connectors: connectorIds,
    skills: skillIds,
    cloud: [allowWeb && "web", allowCode && "code"].filter(Boolean),
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
            description: `${c.method === "GET" ? "读取数据" : "写入前确认"}${c.description ? ` · ${c.description}` : ""}`,
          }))
        : panel === "skills"
          ? skills
          : [];
  const filtered = items.filter((item) =>
    `${item.name} ${item.description}`
      .toLocaleLowerCase()
      .includes(query.trim().toLocaleLowerCase()),
  );
  const config = panels.find((item) => item.id === panel);
  const chips = [
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
    ...(allowWeb
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
        onSubmit();
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape" && panel) {
          event.preventDefault();
          event.stopPropagation();
          close();
        }
      }}
      onBlur={(event) => {
        if (
          event.relatedTarget &&
          !event.currentTarget.contains(event.relatedTarget)
        )
          setPanel(null);
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
      <div className="bot-composer-tools">
        <div className="bot-tool-triggers" aria-label="任务资料与工具">
          {panels.map((item) => (
            <button
              type="button"
              key={item.id}
              className={`bot-tool-trigger ${panel === item.id ? "open" : ""} ${selected[item.id].length ? "selected" : ""}`}
              aria-label={item.title}
              aria-expanded={panel === item.id}
              aria-controls={panel === item.id ? panelId : undefined}
              aria-haspopup="dialog"
              onClick={(event) => {
                trigger.current = event.currentTarget;
                setQuery("");
                setPanel(panel === item.id ? null : item.id);
              }}
            >
              <item.icon size={16} />
              <span>
                {item.id === "cloud" && props.deviceId ? "本地" : item.title}
              </span>
              {selected[item.id].length > 0 ? (
                <small>{selected[item.id].length}</small>
              ) : (
                <ChevronDown className="bot-tool-chevron" size={12} />
              )}
            </button>
          ))}
        </div>
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
            </div>
          ) : (
            <>
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
                        : connectorIds;
                  const setIds =
                    panel === "documents"
                      ? onDocs
                      : panel === "skills"
                        ? onSkills
                        : onConnectors;
                  const checked = ids.includes(item.id);
                  const disabled = !checked && ids.length >= config.limit;
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
                            : "添加你的第一个技能"}
                    </strong>
                    <p>
                      {query
                        ? "试试其他关键词"
                        : panel === "documents"
                          ? "上传资料，或直接从知识库开始"
                          : panel === "connectors"
                            ? "把日常工作应用带进这个任务"
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
                      onClick={onUpload}
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
