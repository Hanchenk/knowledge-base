import { useEffect, useState } from "react";
import {
  CircleCheck,
  ImagePlus,
  LoaderCircle,
  RefreshCw,
  Save,
  Search,
  Sparkles,
  X,
} from "lucide-react";
import { api, post } from "./api";
import type { Feedback } from "./App";
import { ModelPicker } from "./ModelPicker";

type Kind = "chat" | "embedding" | "vision";
type Provider = {
  enabled: boolean;
  base_url: string;
  model: string;
  dimensions: number;
  has_api_key: boolean;
  api_key?: string;
  clear_api_key?: boolean;
};
type Settings = Record<Kind, Provider> & {
  revision: number;
  source: string;
  can_save: boolean;
  postgres_dimensions: number | null;
  reindex_required?: boolean;
};
type TestResult = {
  success: boolean;
  message: string;
  latency_ms: number;
  dimensions: number | null;
};
const models = [
  {
    kind: "chat" as const,
    title: "问答模型",
    icon: Sparkles,
    description: "根据检索到的资料生成带引用的回答。",
    placeholder: "填写服务商提供的问答模型名称",
  },
  {
    kind: "embedding" as const,
    title: "向量模型",
    icon: Search,
    description: "将文档与问题转换为向量，用于语义检索。",
    placeholder: "填写服务商提供的文本向量模型名称",
  },
  {
    kind: "vision" as const,
    title: "视觉模型",
    icon: ImagePlus,
    description: "提取图片、扫描件与图表中的文字和内容。",
    placeholder: "填写支持图片输入的模型名称",
  },
];

export function ModelSettings({
  feedback,
  onSaved,
  onDirtyChange,
}: {
  feedback: Feedback;
  onSaved: () => Promise<void>;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const [settings, setSettings] = useState<Settings>();
  const [dirty, setDirty] = useState(false);
  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState<Kind>();
  const [results, setResults] = useState<Partial<Record<Kind, TestResult>>>({});
  const [loadError, setLoadError] = useState("");
  const [reindex, setReindex] = useState(false);
  const [loading, setLoading] = useState(true);
  const load = async () => {
    setLoading(true);
    setLoadError("");
    try {
      setSettings(await api<Settings>("/api/models"));
      setDirty(false);
      setResults({});
    } catch (e) {
      setLoadError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    void load();
  }, []);
  const edit = (kind: Kind, patch: Partial<Provider>) => {
    setSettings((current) =>
      current
        ? { ...current, [kind]: { ...current[kind], ...patch } }
        : current,
    );
    setDirty(true);
    setResults((current) => ({ ...current, [kind]: undefined }));
  };
  const input = (p: Provider) => ({
    enabled: p.enabled,
    base_url: p.base_url,
    model: p.model,
    dimensions: p.dimensions,
    api_key: p.api_key || undefined,
    clear_api_key: p.clear_api_key || false,
  });
  const test = async (kind: Kind) => {
    if (!settings) return;
    setTesting(kind);
    setResults((current) => ({ ...current, [kind]: undefined }));
    try {
      const result = await post<TestResult>("/api/models/test", {
        kind,
        revision: settings.revision,
        config: input(settings[kind]),
      });
      setResults((current) => ({ ...current, [kind]: result }));
    } catch (e) {
      setResults((current) => ({
        ...current,
        [kind]: {
          success: false,
          message: (e as Error).message,
          latency_ms: 0,
          dimensions: null,
        },
      }));
    } finally {
      setTesting(undefined);
    }
  };
  const save = async () => {
    if (!settings) return;
    setSaving(true);
    try {
      const next = await api<Settings>("/api/models", {
        method: "PUT",
        body: JSON.stringify({
          revision: settings.revision,
          chat: input(settings.chat),
          embedding: input(settings.embedding),
          vision: input(settings.vision),
        }),
      });
      setSettings(next);
      setDirty(false);
      setReindex(!!next.reindex_required);
      feedback("模型配置已保存并生效");
      await onSaved();
    } catch (e) {
      feedback((e as Error).message, true);
    } finally {
      setSaving(false);
    }
  };
  const busy = saving || !!testing || loading;
  return (
    <section className="panel model-config" aria-label="RAG 模型配置">
      <div className="model-config-heading">
        <div>
          <h2>RAG 模型配置</h2>
          <p>
            分别连接兼容 OpenAI
            的模型服务，保存后立即生效。填写地址与密钥后自动获取模型列表，测试会实际调用模型。
          </p>
        </div>
        <span className={`model-save-state ${dirty ? "unsaved" : ""}`}>
          {dirty
            ? "有未保存的修改"
            : settings?.source === "database"
              ? "使用已保存配置"
              : "使用环境默认配置"}
        </span>
      </div>
      {loading && <p role="status">正在加载模型配置…</p>}
      {loadError && (
        <div className="model-test-result failed" role="alert">
          <span>{loadError}</span>
          <button className="text-button" onClick={() => void load()}>
            重新加载
          </button>
        </div>
      )}
      {settings && !loading && (
        <>
          {!settings.can_save && (
            <div className="model-notice" role="alert">
              请由部署管理员设置配置加密密钥后启用保存。你仍可测试模型连接。
            </div>
          )}
          <div className="model-provider-grid">
            {models.map(
              ({ kind, title, icon: Icon, description, placeholder }) => {
                const p = settings[kind];
                const result = results[kind];
                return (
                  <article
                    className="model-provider"
                    key={kind}
                    aria-label={title}
                  >
                    <div className="model-provider-heading">
                      <h3>
                        <Icon size={18} />
                        {title}
                      </h3>
                      <label className="model-enable">
                        <input
                          type="checkbox"
                          checked={p.enabled}
                          disabled={busy}
                          onChange={(e) =>
                            edit(kind, { enabled: e.target.checked })
                          }
                        />
                        启用
                      </label>
                    </div>
                    <p>{description}</p>
                    {!p.enabled && p.base_url.trim() && p.model.trim() && (
                      <div className="model-provider-disabled">
                        已填写配置，尚未启用。勾选上方“启用”并保存后生效。
                      </div>
                    )}
                    <label>
                      服务地址（Base URL）
                      <input
                        type="url"
                        value={p.base_url}
                        disabled={busy}
                        placeholder="https://your-provider.example/v1"
                        onChange={(e) =>
                          edit(kind, { base_url: e.target.value })
                        }
                      />
                    </label>
                    <ModelPicker
                      kind={kind}
                      provider={p}
                      revision={settings.revision}
                      disabled={busy}
                      placeholder={placeholder}
                      onChange={(model) => edit(kind, { model })}
                    />
                    <label>
                      API Key
                      <input
                        type="password"
                        autoComplete="new-password"
                        value={p.api_key || ""}
                        disabled={busy || p.clear_api_key}
                        placeholder={
                          p.has_api_key
                            ? "已保存密钥，留空保留原密钥"
                            : "输入密钥；本地无认证服务可留空"
                        }
                        onChange={(e) =>
                          edit(kind, { api_key: e.target.value })
                        }
                      />
                    </label>
                    <div className="model-key-note">
                      <span>
                        {p.clear_api_key
                          ? "保存时将清除密钥"
                          : p.has_api_key
                            ? "已配置密钥 · 不回传原值"
                            : "未保存密钥"}
                      </span>
                      {p.has_api_key && (
                        <label>
                          <input
                            type="checkbox"
                            disabled={busy}
                            checked={p.clear_api_key || false}
                            onChange={(e) =>
                              edit(kind, {
                                clear_api_key: e.target.checked,
                                api_key: "",
                              })
                            }
                          />
                          清除密钥
                        </label>
                      )}
                    </div>
                    {kind === "embedding" && (
                      <label>
                        向量维度
                        <input
                          type="number"
                          min={1}
                          max={2000}
                          value={p.dimensions}
                          disabled={busy}
                          onChange={(e) =>
                            edit(kind, { dimensions: Number(e.target.value) })
                          }
                        />
                        <small>
                          {settings.postgres_dimensions
                            ? `当前数据库维度：${settings.postgres_dimensions}，保存时需保持一致。`
                            : "填写模型实际输出维度；测试将检查是否匹配。"}
                        </small>
                      </label>
                    )}
                    <button
                      className="button model-test-button"
                      type="button"
                      disabled={busy || !p.base_url.trim() || !p.model.trim()}
                      onClick={() => void test(kind)}
                    >
                      {testing === kind ? (
                        <LoaderCircle size={15} className="spin" />
                      ) : (
                        <CircleCheck size={15} />
                      )}
                      {testing === kind ? "测试中…" : "测试连接"}
                    </button>
                    {result && (
                      <div
                        className={`model-test-result ${result.success ? "passed" : "failed"}`}
                        role="status"
                      >
                        <div>
                          {result.success ? (
                            <CircleCheck size={16} />
                          ) : (
                            <X size={16} />
                          )}
                          <strong>
                            {result.success ? "测试通过" : "测试失败"}
                          </strong>
                          {result.latency_ms > 0 && (
                            <span>{result.latency_ms} ms</span>
                          )}
                        </div>
                        <p>
                          {result.message}
                          {result.success &&
                            !p.enabled &&
                            " · 测试通过不会自动启用，请勾选“启用”并保存。"}
                          {result.dimensions != null &&
                            ` · ${result.dimensions} 维`}
                        </p>
                      </div>
                    )}
                  </article>
                );
              },
            )}
          </div>
          {reindex && (
            <div className="model-notice" role="status">
              向量或视觉配置已变更。请在文档管理中对已有文档重新索引，以更新向量和图片解析结果。
            </div>
          )}
          <div className="model-config-footer">
            <p>
              密钥加密保存，不回传浏览器；留空保留已有密钥。更换向量或视觉模型后请重新索引已有资料。
            </p>
            <div>
              <button
                className="button"
                disabled={busy || !dirty}
                onClick={() => void load()}
              >
                <RefreshCw size={15} />
                放弃修改
              </button>
              <button
                className="button primary"
                disabled={busy || !dirty || !settings.can_save}
                onClick={() => void save()}
              >
                {saving ? (
                  <LoaderCircle size={15} className="spin" />
                ) : (
                  <Save size={15} />
                )}
                {saving ? "保存中…" : "保存配置"}
              </button>
            </div>
          </div>
        </>
      )}
    </section>
  );
}
