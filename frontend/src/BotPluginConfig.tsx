import { useCallback, useEffect, useState } from "react";
import { Check, Loader2, RefreshCw, Settings2, Trash2 } from "lucide-react";
import { Modal } from "./components";
import type { Feedback } from "./App";
import {
  harnessApi,
  type HarnessConfigInfo,
  type HarnessPlugin,
} from "./harness-api";

export function BotPluginConfig({
  plugin,
  onClose,
  onSaved,
  feedback,
}: {
  plugin: HarnessPlugin;
  onClose: () => void;
  onSaved: () => Promise<void>;
  feedback: Feedback;
}) {
  const [info, setInfo] = useState<HarnessConfigInfo>();
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  const [resetting, setResetting] = useState(false);
  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      setInfo(await harnessApi.configInfo(plugin.id));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoading(false);
    }
  }, [plugin.id]);
  useEffect(() => {
    void load();
  }, [load]);
  const template = JSON.stringify(
    Object.fromEntries((info?.rows || []).map((row) => [row.id, {}])),
    null,
    2,
  );

  const save = async (reset = false) => {
    if (busy || loading || !info) return;
    setError("");
    let config: Record<string, object> = {};
    if (!reset) {
      try {
        const parsed: unknown = JSON.parse(text);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
          throw new Error("配置需要是 JSON 对象");
        const rows = new Set(info.rows.map((row) => row.id));
        for (const [id, value] of Object.entries(parsed)) {
          if (!rows.has(id))
            throw new Error(`未知配置组件：${id}，请使用下面列出的组件标识`);
          if (!value || typeof value !== "object" || Array.isArray(value))
            throw new Error(`「${id}」的配置需要是 JSON 对象`);
          config[id] = value;
        }
      } catch (reason) {
        setError(
          reason instanceof SyntaxError
            ? "JSON 格式有误，请检查引号、逗号与括号"
            : reason instanceof Error
              ? reason.message
              : String(reason),
        );
        return;
      }
    }
    setBusy(true);
    try {
      await harnessApi.configure(plugin.id, config);
      setText("");
      await onSaved();
      feedback(
        reset
          ? `「${plugin.name}」的配置已清空`
          : `「${plugin.name}」的配置已保存`,
      );
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={`配置 ${plugin.name}`}
      onClose={() => {
        if (!busy) onClose();
      }}
      wide
    >
      <form
        className="harness-config"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <div className="harness-config-heading">
          <span className="harness-runtime-icon">
            <Settings2 size={22} />
          </span>
          <div>
            <h3>{plugin.name}</h3>
            <p>
              {loading
                ? "正在读取配置组件…"
                : info?.has_config
                  ? "已保存配置 · 密钥不回显"
                  : "尚未保存自定义配置"}
            </p>
          </div>
        </div>
        <p className="harness-config-help">
          按组件标识填写 JSON 配置，可设置插件所需的服务地址、API Key
          等字段。保存会替换原配置，请完整填写需要保留的字段。
        </p>
        {error && (
          <div className="harness-error" role="alert">
            {error}
            {!info && !loading && (
              <button
                type="button"
                className="text-button"
                onClick={() => void load()}
              >
                <RefreshCw size={12} />
                重新读取
              </button>
            )}
          </div>
        )}
        {loading ? (
          <div className="harness-empty" role="status">
            <Loader2 className="spin" size={25} />
            <p>正在读取插件配置组件…</p>
          </div>
        ) : (
          info && (
            <>
              <div className="harness-config-rows">
                <strong>可配置组件</strong>
                {info.rows.map((row) => (
                  <div key={row.id}>
                    <code>{row.id}</code>
                    <span>{row.name}</span>
                  </div>
                ))}
                {!info.rows.length && <p>此插件没有提供可配置组件。</p>}
              </div>
              <div className="harness-config-label">
                <label htmlFor="harness-plugin-config-json">JSON 配置</label>
                <button
                  type="button"
                  className="text-button"
                  disabled={busy}
                  onClick={() => {
                    setText(template);
                    setError("");
                  }}
                >
                  插入空白模板
                </button>
              </div>
              <textarea
                id="harness-plugin-config-json"
                className="harness-config-editor"
                value={text}
                onChange={(event) => {
                  setText(event.target.value);
                  setResetting(false);
                }}
                placeholder={template}
                rows={11}
                maxLength={32000}
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
                disabled={busy}
              />
              <small className="harness-config-note">
                配置由云端加密保存，仅在任务选择该插件时使用。已保存的配置和密钥不会返回浏览器。
              </small>
            </>
          )
        )}
        {resetting && (
          <div className="harness-remove-confirm" role="alert">
            <span>清空该插件已保存的配置？下一次任务将使用插件默认配置。</span>
            <button
              type="button"
              disabled={busy}
              onClick={() => void save(true)}
            >
              确认清空
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => setResetting(false)}
            >
              取消
            </button>
          </div>
        )}
        <footer className="harness-config-footer">
          <button
            type="button"
            className="text-button"
            disabled={busy || loading || !info?.has_config}
            onClick={() => setResetting(true)}
          >
            <Trash2 size={13} />
            清空已保存配置
          </button>
          <span />
          <button
            type="button"
            className="button"
            disabled={busy}
            onClick={onClose}
          >
            取消
          </button>
          <button
            type="submit"
            className="button primary"
            disabled={busy || loading || !info || !text.trim()}
          >
            {busy ? (
              <Loader2 size={14} className="spin" />
            ) : (
              <Check size={14} />
            )}
            保存配置
          </button>
        </footer>
      </form>
    </Modal>
  );
}
