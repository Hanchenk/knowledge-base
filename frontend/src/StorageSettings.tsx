import { useEffect, useState } from "react";
import { Database, LoaderCircle, Save } from "lucide-react";
import { api, post } from "./api";
import type { Feedback } from "./App";
type StorageConfig = {
  endpoint: string;
  bucket: string;
  access_key: string;
  region: string;
  has_secret: boolean;
  secret_key?: string;
};
type Settings = {
  config: StorageConfig;
  enabled: boolean;
  revision: number;
  can_save: boolean;
};
export function StorageSettings({
  feedback,
  onSaved,
  onDirtyChange,
}: {
  feedback: Feedback;
  onSaved: () => Promise<void>;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const [settings, setSettings] = useState<Settings>();
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState("");
  const load = async () => {
    try {
      setSettings(await api<Settings>("/api/settings/storage"));
      setDirty(false);
      onDirtyChange(false);
      setResult("");
    } catch (e) {
      feedback((e as Error).message, true);
    }
  };
  useEffect(() => {
    void load();
  }, []);
  if (!settings) return <p role="status">正在加载对象存储配置…</p>;
  const edit = (patch: Partial<StorageConfig>) => {
    setSettings({ ...settings, config: { ...settings.config, ...patch } });
    setDirty(true);
    onDirtyChange(true);
    setResult("");
  };
  const input = {
    ...settings.config,
    revision: settings.revision,
    enabled: settings.enabled,
  };
  return (
    <section
      className="model-settings panel storage-settings"
      aria-label="对象存储配置"
    >
      <div className="model-settings-heading">
        <div>
          <h2>
            <Database size={20} /> 对象存储
          </h2>
          <p>MinIO 兼容 S3，用于保存文档原件、解析图片与创作作品。</p>
        </div>
      </div>
      <article className="model-provider">
        <div className="model-provider-heading">
          <h3>MinIO</h3>
          <label className="model-enable">
            <input
              type="checkbox"
              checked={settings.enabled}
              disabled={busy}
              onChange={(e) => {
                setSettings({ ...settings, enabled: e.target.checked });
                setDirty(true);
                onDirtyChange(true);
                setResult("");
              }}
            />
            启用 MinIO
          </label>
        </div>
        <p>
          配置立即用于新文件；已有文件继续从原存储读取。Bucket
          需要提前创建并授予读写、删除权限。
        </p>
        <div className="storage-fields">
          <label>
            Endpoint
            <input
              type="url"
              value={settings.config.endpoint}
              placeholder="http://minio:9000"
              disabled={busy}
              onChange={(e) => edit({ endpoint: e.target.value })}
            />
          </label>
          <label>
            Bucket
            <input
              value={settings.config.bucket}
              placeholder="atlas"
              disabled={busy}
              onChange={(e) => edit({ bucket: e.target.value })}
            />
          </label>
          <label>
            Access Key
            <input
              value={settings.config.access_key}
              autoComplete="off"
              disabled={busy}
              onChange={(e) => edit({ access_key: e.target.value })}
            />
          </label>
          <label>
            Secret Key
            <input
              type="password"
              value={settings.config.secret_key || ""}
              autoComplete="new-password"
              placeholder={
                settings.config.has_secret
                  ? "已保存，留空保留原密钥"
                  : "输入 Secret Key"
              }
              disabled={busy}
              onChange={(e) => edit({ secret_key: e.target.value })}
            />
          </label>
          <label>
            Region
            <input
              value={settings.config.region || "us-east-1"}
              disabled={busy}
              onChange={(e) => edit({ region: e.target.value })}
            />
          </label>
        </div>
        {result && (
          <p role="status" className="model-notice">
            {result}
          </p>
        )}
        <div className="form-actions">
          <span className="section-note">
            {dirty ? "有未保存的修改" : "使用已保存配置"}
          </span>
          <button
            className="button"
            disabled={busy || !settings.enabled}
            onClick={async () => {
              setBusy(true);
              try {
                const r = await post<{ message: string }>(
                  "/api/settings/storage/test",
                  input,
                );
                setResult(r.message);
              } catch (e) {
                setResult((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            测试读写
          </button>
          <button
            className="button"
            disabled={busy || !dirty}
            onClick={() => void load()}
          >
            放弃修改
          </button>
          <button
            className="button primary"
            disabled={busy || !dirty || !settings.can_save}
            onClick={async () => {
              setBusy(true);
              try {
                setSettings(
                  await api<Settings>("/api/settings/storage", {
                    method: "PUT",
                    body: JSON.stringify(input),
                  }),
                );
                setDirty(false);
                onDirtyChange(false);
                setResult("");
                feedback("对象存储配置已保存并生效");
                await onSaved();
              } catch (e) {
                feedback((e as Error).message, true);
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? (
              <LoaderCircle size={16} className="spin" />
            ) : (
              <Save size={16} />
            )}
            保存配置
          </button>
        </div>
      </article>
    </section>
  );
}
