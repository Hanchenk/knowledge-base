import { useEffect, useState } from "react";
import {
  CircleCheck,
  Film,
  ImagePlus,
  LoaderCircle,
  Plus,
  Save,
  Star,
  Trash2,
  X,
} from "lucide-react";
import { api, post } from "./api";
import { randomUuid } from "./ids";
import { ModelPicker } from "./ModelPicker";
import type { Feedback } from "./App";

type Provider = {
  enabled: boolean;
  base_url: string;
  model: string;
  dimensions: number;
  has_api_key: boolean;
  api_key?: string;
  clear_api_key?: boolean;
};
type MediaModel = {
  id: string;
  name: string;
  kind: "image" | "video";
  config: Provider;
};
type Settings = {
  revision: number;
  can_save: boolean;
  source: string;
  chat: Provider;
  embedding: Provider;
  vision: Provider;
  media_models: MediaModel[];
  default_image_id: string | null;
  default_video_id: string | null;
};
type TestResult = { success: boolean; message: string; latency_ms: number };
const blank = (kind: "image" | "video"): MediaModel => ({
  id: randomUuid(),
  name: kind === "image" ? "生图模型" : "视频模型",
  kind,
  config: {
    enabled: false,
    base_url: "",
    model: "",
    dimensions: 0,
    has_api_key: false,
  },
});
const input = (provider: Provider) => ({
  enabled: provider.enabled,
  base_url: provider.base_url,
  model: provider.model,
  dimensions: provider.dimensions,
  api_key: provider.api_key || undefined,
  clear_api_key: provider.clear_api_key || false,
});

export function MediaModelSettings({
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
  const [testing, setTesting] = useState("");
  const [results, setResults] = useState<Record<string, TestResult>>({});
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const load = async () => {
    setLoading(true);
    setError("");
    try {
      const next = await api<Settings>("/api/models");
      const rows = [...next.media_models];
      for (const kind of ["image", "video"] as const)
        if (!rows.some((row) => row.kind === kind)) rows.push(blank(kind));
      setSettings({ ...next, media_models: rows });
      setDirty(false);
      setResults({});
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    void load();
  }, []);
  const edit = (
    key: string,
    patch: Partial<MediaModel>,
    config?: Partial<Provider>,
  ) => {
    setSettings((current) =>
      current
        ? {
            ...current,
            media_models: current.media_models.map((row) =>
              row.id === key
                ? { ...row, ...patch, config: { ...row.config, ...config } }
                : row,
            ),
          }
        : current,
    );
    setDirty(true);
    setResults((current) => {
      const next = { ...current };
      delete next[key];
      return next;
    });
  };
  const add = (kind: "image" | "video") => {
    setSettings((current) =>
      current
        ? { ...current, media_models: [...current.media_models, blank(kind)] }
        : current,
    );
    setDirty(true);
  };
  const test = async (row: MediaModel) => {
    if (!settings) return;
    setTesting(row.id);
    try {
      setResults((current) => {
        const next = { ...current };
        delete next[row.id];
        return next;
      });
      const result = await post<TestResult>("/api/models/test", {
        kind: row.kind,
        config_id: row.id,
        revision: settings.revision,
        config: input(row.config),
      });
      setResults((current) => ({ ...current, [row.id]: result }));
    } catch (error) {
      setResults((current) => ({
        ...current,
        [row.id]: {
          success: false,
          message: (error as Error).message,
          latency_ms: 0,
        },
      }));
    } finally {
      setTesting("");
    }
  };
  const save = async () => {
    if (!settings) return;
    setSaving(true);
    try {
      const rows = settings.media_models.filter(
        (row) =>
          row.config.base_url.trim() ||
          row.config.model.trim() ||
          row.config.enabled ||
          row.config.api_key ||
          row.config.has_api_key,
      );
      const next = await api<Settings>("/api/models", {
        method: "PUT",
        body: JSON.stringify({
          revision: settings.revision,
          chat: input(settings.chat),
          embedding: input(settings.embedding),
          vision: input(settings.vision),
          media_models: rows.map((row) => ({
            id: row.id,
            name: row.name,
            kind: row.kind,
            config: input(row.config),
          })),
          default_image_id: rows.some(
            (row) => row.id === settings.default_image_id,
          )
            ? settings.default_image_id
            : null,
          default_video_id: rows.some(
            (row) => row.id === settings.default_video_id,
          )
            ? settings.default_video_id
            : null,
        }),
      });
      setSettings(next);
      setDirty(false);
      setResults({});
      feedback("创作模型配置已保存并生效");
      await onSaved();
    } catch (error) {
      feedback((error as Error).message, true);
    } finally {
      setSaving(false);
    }
  };
  const busy = loading || saving || !!testing;
  return (
    <section
      className="panel model-config studio-model-config"
      aria-label="创作模型配置"
    >
      <div className="model-config-heading">
        <div>
          <h2>创作模型配置</h2>
          <p>
            可保存多组生图与视频模型，在创作台自由切换。填写地址与密钥自动获取模型列表；连接测试只检查列表，不提交生成任务。
          </p>
        </div>
        <span className={`model-save-state ${dirty ? "unsaved" : ""}`}>
          {dirty ? "有未保存的修改" : "使用已保存配置"}
        </span>
      </div>
      {loading && <p role="status">正在加载模型配置…</p>}
      {error && (
        <div role="alert" className="model-test-result failed">
          {error}
          <button className="text-button" onClick={() => void load()}>
            重新加载
          </button>
        </div>
      )}
      {settings && !loading && (
        <>
          {!settings.can_save && (
            <p className="model-notice">
              请由部署管理员设置配置加密密钥后启用保存。
            </p>
          )}
          <div className="media-catalog-actions">
            <button
              className="button"
              disabled={busy || settings.media_models.length >= 40}
              onClick={() => add("image")}
            >
              <Plus size={15} />
              添加生图模型
            </button>
            <button
              className="button"
              disabled={busy || settings.media_models.length >= 40}
              onClick={() => add("video")}
            >
              <Plus size={15} />
              添加视频模型
            </button>
            <small>每组配置独立保存服务地址和密钥</small>
          </div>
          <div className="model-provider-grid">
            {settings.media_models.map((row) => {
              const provider = row.config,
                result = results[row.id],
                title = row.kind === "image" ? "生图模型" : "视频模型",
                Icon = row.kind === "image" ? ImagePlus : Film;
              const defaultKey =
                  row.kind === "image"
                    ? "default_image_id"
                    : "default_video_id",
                isDefault = settings[defaultKey] === row.id;
              const sameKind = settings.media_models.filter(
                (model) => model.kind === row.kind,
              ).length;
              return (
                <article
                  className="model-provider"
                  key={row.id}
                  data-kind={row.kind}
                  aria-label={sameKind === 1 ? title : `${title}：${row.name}`}
                >
                  <div className="model-provider-heading">
                    <h3>
                      <Icon size={18} />
                      {title}
                      {isDefault && <span className="tiny-pill">默认</span>}
                    </h3>
                    <label className="model-enable">
                      <input
                        type="checkbox"
                        checked={provider.enabled}
                        disabled={busy}
                        onChange={(event) =>
                          edit(row.id, {}, { enabled: event.target.checked })
                        }
                      />
                      启用
                    </label>
                  </div>
                  <label>
                    配置名称
                    <input
                      maxLength={80}
                      value={row.name}
                      disabled={busy}
                      onChange={(event) =>
                        edit(row.id, { name: event.target.value })
                      }
                      placeholder="例如：品牌海报 · 快速生图"
                    />
                  </label>
                  {!provider.enabled && provider.model && (
                    <div className="model-provider-disabled">
                      此配置尚未启用，保存后只有启用的模型可被选择。
                    </div>
                  )}
                  <label>
                    服务地址（Base URL）
                    <input
                      type="url"
                      value={provider.base_url}
                      disabled={busy}
                      placeholder="https://your-provider.example/v1"
                      onChange={(event) =>
                        edit(row.id, {}, { base_url: event.target.value })
                      }
                    />
                  </label>
                  <ModelPicker
                    kind={row.kind}
                    configId={row.id}
                    provider={provider}
                    revision={settings.revision}
                    disabled={busy}
                    placeholder={`选择或填写${title}`}
                    onChange={(model) => edit(row.id, {}, { model })}
                  />
                  <label>
                    API Key
                    <input
                      type="password"
                      autoComplete="new-password"
                      value={provider.api_key || ""}
                      disabled={busy || provider.clear_api_key}
                      placeholder={
                        provider.has_api_key
                          ? "已保存密钥，留空保留原密钥"
                          : "输入密钥；无认证服务可留空"
                      }
                      onChange={(event) =>
                        edit(row.id, {}, { api_key: event.target.value })
                      }
                    />
                  </label>
                  <div className="model-key-note">
                    <span>
                      {provider.clear_api_key
                        ? "保存时将清除密钥"
                        : provider.has_api_key
                          ? "已配置密钥 · 不回传原值"
                          : "未保存密钥"}
                    </span>
                    {provider.has_api_key && (
                      <label>
                        <input
                          type="checkbox"
                          disabled={busy}
                          checked={provider.clear_api_key || false}
                          onChange={(event) =>
                            edit(
                              row.id,
                              {},
                              {
                                clear_api_key: event.target.checked,
                                api_key: "",
                              },
                            )
                          }
                        />
                        清除密钥
                      </label>
                    )}
                  </div>
                  <div className="media-row-actions">
                    <button
                      className="button model-test-button"
                      disabled={
                        busy ||
                        !provider.base_url.trim() ||
                        !provider.model.trim()
                      }
                      onClick={() => void test(row)}
                    >
                      {testing === row.id ? (
                        <LoaderCircle size={15} className="spin" />
                      ) : (
                        <CircleCheck size={15} />
                      )}
                      测试连接
                    </button>
                    <button
                      className="text-button"
                      disabled={busy || isDefault}
                      onClick={() => {
                        setSettings({ ...settings, [defaultKey]: row.id });
                        setDirty(true);
                      }}
                    >
                      <Star size={14} />
                      {isDefault ? "默认模型" : "设为默认"}
                    </button>
                    <button
                      className="text-button danger-text"
                      disabled={busy}
                      onClick={() => {
                        setSettings({
                          ...settings,
                          media_models: settings.media_models.filter(
                            (model) => model.id !== row.id,
                          ),
                          ...(isDefault ? { [defaultKey]: null } : {}),
                        });
                        setDirty(true);
                      }}
                    >
                      <Trash2 size={14} />
                      移除
                    </button>
                  </div>
                  {result && (
                    <div
                      className={`model-test-result ${result.success ? "passed" : "failed"}`}
                      role="status"
                    >
                      <strong>
                        {result.success ? "测试通过" : "测试失败"}
                      </strong>
                      <p>{result.message}</p>
                      {result.latency_ms > 0 && (
                        <small>{result.latency_ms} ms</small>
                      )}
                    </div>
                  )}
                </article>
              );
            })}
          </div>
          {!settings.media_models.length && (
            <p className="media-catalog-empty">
              添加模型配置，连接你的生图或视频服务。
            </p>
          )}
          <div className="model-config-footer">
            <p>
              密钥加密保存，按配置独立管理。默认模型用于首次打开创作台；已有生成任务继续使用提交时的配置。
            </p>
            <div>
              <button
                className="button"
                disabled={busy || !dirty}
                onClick={() => void load()}
              >
                <X size={15} />
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
                保存配置
              </button>
            </div>
          </div>
        </>
      )}
    </section>
  );
}
