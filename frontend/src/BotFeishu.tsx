import { Check, ExternalLink, Loader2, Plug, RefreshCw } from "lucide-react";
import type { FeishuStatus } from "./feishu-api";
import "./bot-feishu.css";

export type FeishuConnectionProps = {
  status?: FeishuStatus;
  error?: string;
  busy: boolean;
  onConnect: () => void;
  onRefresh: () => void;
};

export function BotFeishu({
  status,
  error,
  busy,
  onConnect,
  onRefresh,
  compact = false,
  onTest,
  onDisconnect,
}: FeishuConnectionProps & {
  compact?: boolean;
  onTest?: () => void;
  onDisconnect?: () => void;
}) {
  const connected = !!status?.connected && !status.needs_reconnect;
  const reconnect = !!status?.needs_reconnect;
  return (
    <section
      className={`bot-feishu-card ${compact ? "compact" : ""}`}
      aria-label="飞书连接"
    >
      <div className="bot-feishu-brand">
        <span className="bot-feishu-icon" aria-hidden="true">
          <Plug size={compact ? 19 : 23} />
        </span>
        <div>
          <h3>飞书</h3>
          <p>授权后自动完成连接，可用于检索和读取飞书文档</p>
        </div>
      </div>
      <div className="bot-feishu-actions">
        {connected ? (
          <span className="bot-feishu-connected" role="status">
            <Check size={14} />
            已连接
          </span>
        ) : error ? (
          <button
            type="button"
            className="button"
            disabled={busy}
            onClick={onRefresh}
          >
            <RefreshCw size={14} />
            重试飞书连接
          </button>
        ) : (
          <button
            type="button"
            className="button primary"
            disabled={busy || !status?.available}
            onClick={onConnect}
          >
            {busy || !status ? (
              <Loader2 size={14} className="spin" />
            ) : (
              <ExternalLink size={14} />
            )}
            {busy
              ? "正在准备授权…"
              : !status
                ? "正在加载飞书…"
                : reconnect
                  ? "重新授权飞书"
                  : "连接飞书"}
          </button>
        )}
        {connected && onTest && (
          <button type="button" className="text-button" onClick={onTest}>
            测试连接
          </button>
        )}
        {(status?.connector_id || connected) && onDisconnect && (
          <button
            type="button"
            className="text-button"
            disabled={busy}
            onClick={onDisconnect}
          >
            断开飞书
          </button>
        )}
      </div>
      {(error || reconnect || (status && !status.available)) && (
        <p className="bot-feishu-message" role={error ? "alert" : "status"}>
          {error ||
            status?.message ||
            (reconnect
              ? "飞书授权已失效，请重新授权后使用。"
              : "飞书连接暂不可用，请稍后重试。")}
        </p>
      )}
      {!compact && (
        <p className="bot-feishu-help">
          连接后，在任务中选择飞书才会使用；仅访问你在飞书中有权限的文档。
        </p>
      )}
    </section>
  );
}
