import { useEffect, useState } from "react";
import {
  Cloud,
  Download,
  Eye,
  FileText,
  History,
  Loader2,
  Power,
  RefreshCw,
} from "lucide-react";
import { Modal } from "./components";
import { bytes, date } from "./api";
import { cloudApi, type CloudFile, type useCloudComputer } from "./cloud-api";
import "./bot-cloud.css";

export function BotCloud({
  cloud,
  onClose,
  onSessions,
}: {
  cloud: ReturnType<typeof useCloudComputer>;
  onClose: () => void;
  onSessions: () => void;
}) {
  const [files, setFiles] = useState<CloudFile[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [more, setMore] = useState(false);
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const load = async (append = false) => {
    const offset = append ? nextOffset : 0;
    if (offset === null) return;
    setLoading(true);
    setError("");
    try {
      const result = await cloudApi.files(offset);
      setFiles(append ? [...files, ...result.files] : result.files);
      const next =
        result.next_offset === undefined
          ? result.has_more
            ? result.offset + result.limit
            : null
          : result.next_offset;
      setNextOffset(next);
      setMore(result.has_more && next !== null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    void load();
  }, []);
  const status = cloud.status;
  return (
    <Modal title="云端电脑" onClose={onClose} wide>
      <section className="bot-cloud-manager">
        <div className="bot-cloud-summary">
          <Cloud size={25} />
          <div>
            <h3>
              {status?.connected
                ? "云端电脑已连接"
                : status?.available
                  ? "云端电脑未连接"
                  : "云端服务暂不可用"}
            </h3>
            <p>
              {status?.active_tasks || status?.pending_tasks
                ? [
                    status.active_tasks &&
                      `${status.active_tasks} 个任务正在运行`,
                    status.pending_tasks &&
                      `${status.pending_tasks} 个任务等待执行`,
                  ]
                    .filter(Boolean)
                    .join(" · ")
                : status?.connected
                  ? "可以继续处理任务与文件"
                  : "连接后继续使用已保存的插件、会话与文件"}
            </p>
          </div>
          <button
            className="button primary"
            disabled={cloud.busy || !status?.available}
            onClick={() =>
              void cloud.act(status?.connected ? "disconnect" : "connect")
            }
          >
            {cloud.busy ? (
              <Loader2 size={14} className="spin" />
            ) : (
              <Power size={14} />
            )}
            {status?.connected ? "断开连接" : "连接云端电脑"}
          </button>
        </div>
        <p className="bot-cloud-persistence">
          空闲 30
          分钟后自动断开。插件、会话和文件会保留；再次连接即可继续，正在执行的任务不受影响。
        </p>
        {(cloud.error || status?.error) && (
          <p className="harness-error" role="alert">
            {cloud.error || status?.error}
          </p>
        )}
        <div className="bot-cloud-file-heading">
          <h3>
            <FileText size={17} /> 云端文件
          </h3>
          <div>
            <button className="button" onClick={onSessions}>
              <History size={14} /> 查看会话
            </button>
            <button
              className="button"
              disabled={loading}
              onClick={() => void load()}
            >
              <RefreshCw size={14} /> 刷新文件
            </button>
          </div>
        </div>
        {error && (
          <p className="harness-error" role="alert">
            {error}
          </p>
        )}
        {loading && !files.length ? (
          <p role="status">正在加载文件…</p>
        ) : files.length ? (
          <div className="bot-cloud-files">
            {files.map((file) => (
              <article key={file.id}>
                <FileText size={19} />
                <div>
                  <strong>{file.name}</strong>
                  <small>
                    {file.task_title} · {bytes(file.size)} ·{" "}
                    {date(file.created_at)}
                  </small>
                </div>
                <div className="bot-cloud-file-actions">
                  {file.previewable && file.preview_url && (
                    <a
                      className="button"
                      href={file.preview_url || undefined}
                      target="_blank"
                      rel="noopener noreferrer"
                      aria-label={`查看 ${file.name}`}
                    >
                      <Eye size={14} />
                      <span>查看</span>
                    </a>
                  )}
                  <a
                    className="button"
                    href={file.download_url}
                    aria-label={`下载 ${file.name}`}
                  >
                    <Download size={14} />
                    <span>下载</span>
                  </a>
                </div>
              </article>
            ))}
          </div>
        ) : (
          <p className="bot-cloud-empty">
            完成任务后，成果文件会保存在这里。断开云端电脑仍可查看和下载。
          </p>
        )}
        {more && (
          <button
            className="button"
            disabled={loading}
            onClick={() => void load(true)}
          >
            加载更多文件
          </button>
        )}
      </section>
    </Modal>
  );
}
