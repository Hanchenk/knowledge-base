import { useEffect, useId, useRef, useState } from "react";
import { LoaderCircle, RefreshCw } from "lucide-react";
import { api } from "./api";

type Provider = {
  enabled: boolean;
  base_url: string;
  model: string;
  dimensions: number;
  has_api_key: boolean;
  api_key?: string;
  clear_api_key?: boolean;
};
export function ModelPicker({
  kind,
  configId,
  provider,
  revision,
  disabled,
  placeholder,
  onChange,
}: {
  kind: string;
  configId?: string;
  provider: Provider;
  revision: number;
  disabled: boolean;
  placeholder: string;
  onChange: (model: string) => void;
}) {
  const field = useId();
  const [models, setModels] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [manual, setManual] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const previousRefresh = useRef(0);
  const { base_url, api_key, has_api_key, clear_api_key } = provider;
  useEffect(() => {
    const immediate = previousRefresh.current !== refresh;
    previousRefresh.current = refresh;
    const controller = new AbortController();
    setModels([]);
    setError("");
    setLoading(false);
    let valid = false;
    try {
      valid = ["http:", "https:"].includes(new URL(base_url).protocol);
    } catch {
      /* Wait for a complete address. */
    }
    if (!valid || (!api_key?.trim() && !has_api_key && !refresh)) return;
    const timer = window.setTimeout(
      async () => {
        setLoading(true);
        try {
          const result = await api<{ models: string[] }>(
            "/api/models/discover",
            {
              method: "POST",
              signal: controller.signal,
              body: JSON.stringify({
                kind,
                config_id: configId,
                revision,
                config: {
                  enabled: false,
                  base_url,
                  model: "",
                  api_key: api_key || undefined,
                  clear_api_key: clear_api_key || false,
                },
              }),
            },
          );
          if (!controller.signal.aborted) {
            setModels(result.models);
            if (!result.models.length)
              setError("服务商列表为空，可手动填写模型名称");
          }
        } catch (error) {
          if (!controller.signal.aborted) setError((error as Error).message);
        } finally {
          if (!controller.signal.aborted) setLoading(false);
        }
      },
      immediate ? 0 : 700,
    );
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [
    kind,
    configId,
    revision,
    base_url,
    api_key,
    has_api_key,
    clear_api_key,
    refresh,
  ]);
  return (
    <div className="model-picker">
      <label htmlFor={field}>模型名称</label>
      {models.length && !manual ? (
        <select
          id={field}
          disabled={disabled}
          value={provider.model}
          onChange={(event) => onChange(event.target.value)}
        >
          <option value="">选择对应能力的模型</option>
          {!!provider.model && !models.includes(provider.model) && (
            <option value={provider.model}>{provider.model}（当前配置）</option>
          )}
          {models.map((model) => (
            <option key={model} value={model}>
              {model}
            </option>
          ))}
        </select>
      ) : (
        <input
          id={field}
          disabled={disabled}
          value={provider.model}
          placeholder={placeholder}
          onChange={(event) => onChange(event.target.value)}
        />
      )}
      <div className="model-picker-actions">
        <button
          type="button"
          className="text-button"
          disabled={disabled || loading || !base_url.trim()}
          onClick={() => setRefresh((value) => value + 1)}
        >
          {loading ? (
            <LoaderCircle size={13} className="spin" />
          ) : (
            <RefreshCw size={13} />
          )}{" "}
          {loading ? "正在获取模型…" : "刷新模型列表"}
        </button>
        {!!models.length && (
          <button
            type="button"
            className="text-button"
            disabled={disabled}
            onClick={() => setManual((value) => !value)}
          >
            {manual ? "从列表选择" : "手动填写"}
          </button>
        )}
      </div>
      {error && (
        <small className="model-discovery-error" role="status">
          {error}。也可手动填写。
        </small>
      )}
      {!error && !!models.length && (
        <small>已获取 {models.length} 个模型，请选择支持此用途的模型。</small>
      )}
    </div>
  );
}
