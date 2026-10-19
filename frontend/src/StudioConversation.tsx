import type { ReactNode } from "react";
import { FileText, RefreshCw } from "lucide-react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Message } from "./types";
import { visibleCitationSources } from "./citation-sources";
import { studioAttachmentUrl, type StudioAttachment } from "./studio-api";

export type StudioMessage = Message & {
  request_id?: string;
  attachments?: StudioAttachment[];
};
export type StudioJob = {
  id: string;
  request_id?: string;
  kind: "image" | "video";
  prompt: string;
  model: string;
  size: string;
  seconds: number;
  status: string;
  progress: number;
  error?: string;
  created_at: number;
};
export type StudioAsset = {
  id: string;
  job_id: string;
  kind: string;
  mime_type: string;
  size: number;
};
type Turn = {
  id: string;
  messages: StudioMessage[];
  jobs: StudioJob[];
};

/** 用错峰浮动圆点显示等待过程，同时为屏幕阅读器提供稳定的状态文字。 */
function WaitingDots({ label }: { label: string }) {
  return (
    <div className="studio-waiting" role="status">
      <span className="studio-floating-dots" aria-hidden="true">
        <i />
        <i />
        <i />
        <i />
      </span>
      <span>{label}</span>
    </div>
  );
}

/** 按请求编号组织消息与作品，兼容缺少编号的旧记录，防止结果跨轮次错位。 */
function conversationTurns(messages: StudioMessage[], jobs: StudioJob[]) {
  const turns: Turn[] = [];
  const byRequest = new Map<string, Turn>();
  for (const message of messages) {
    let turn = message.request_id
      ? byRequest.get(message.request_id)
      : undefined;
    if (!turn && message.role !== "user" && !message.request_id)
      turn = turns.at(-1);
    if (!turn) {
      turn = { id: message.request_id || message.id, messages: [], jobs: [] };
      turns.push(turn);
      if (message.request_id) byRequest.set(message.request_id, turn);
    }
    turn.messages.push(message);
  }
  // API 返回的作品按时间倒序排列，放回对话时改为从旧到新。
  for (const job of [...jobs].reverse()) {
    let turn = job.request_id ? byRequest.get(job.request_id) : undefined;
    if (!turn && !job.request_id) turn = turns.at(-1);
    if (!turn) {
      turn = { id: job.request_id || job.id, messages: [], jobs: [] };
      turns.push(turn);
      if (job.request_id) byRequest.set(job.request_id, turn);
    }
    turn.jobs.push(job);
  }
  return turns;
}

/** 将作品嵌入对应轮次，以密集浮动圆点等待生成结果，并隐藏内部工具轨迹。 */
export function StudioConversation({
  messages,
  jobs,
  assets,
  busyRequestId,
  renderAsset,
  onDocument,
}: {
  messages: StudioMessage[];
  jobs: StudioJob[];
  assets: StudioAsset[];
  busyRequestId?: string;
  renderAsset: (asset: StudioAsset, prompt: string) => ReactNode;
  onDocument: (id: string) => void;
}) {
  const turns = conversationTurns(messages, jobs);
  return (
    <section className="studio-dialogue" aria-label="创作对话">
      <div className="studio-message-list">
        {turns.map((turn) => (
          <div className="studio-turn" key={turn.id}>
            {turn.messages.map((message) => {
              /** 展示原话和有效引用，不渲染内部工具轨迹。 */
              const citations = visibleCitationSources(
                message.content,
                message.citations,
              ).citations;
              return (
                <article
                  key={message.id}
                  className={`studio-message ${message.role}`}
                >
                  <div className="studio-message-body">
                    {!!message.attachments?.length && (
                      <div
                        className="studio-message-attachments"
                        aria-label="本轮参考文件"
                      >
                        {message.attachments.map((attachment) => (
                          <a
                            key={attachment.id}
                            href={studioAttachmentUrl(attachment.id)}
                            target="_blank"
                            rel="noreferrer"
                            title={`查看 ${attachment.name}`}
                          >
                            {attachment.kind === "image" ? (
                              <img
                                src={studioAttachmentUrl(attachment.id)}
                                alt={attachment.name}
                                loading="lazy"
                              />
                            ) : (
                              <FileText size={18} />
                            )}
                            <span>{attachment.name}</span>
                          </a>
                        ))}
                      </div>
                    )}
                    {!!message.content && (
                      <div className="markdown">
                        <Markdown remarkPlugins={[remarkGfm]}>
                          {message.content}
                        </Markdown>
                      </div>
                    )}
                    {!!citations.length && (
                      <div className="studio-evidence" aria-label="引用资料">
                        {citations.map((citation) => (
                          <button
                            key={citation.chunk_id}
                            onClick={() => onDocument(citation.document_id)}
                          >
                            [{citation.citation_number}] {citation.title} · 第{" "}
                            {citation.page} 页
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                </article>
              );
            })}
            {turn.jobs.map((job) => {
              /** 作品元数据出现即替换占位，失败只展示可读的错误信息。 */
              const results = assets.filter((asset) => asset.job_id === job.id);
              const generating = ["queued", "running"].includes(job.status);
              return (
                <div className="studio-turn-result" key={job.id}>
                  {!!results.length ? (
                    results.map((asset) => renderAsset(asset, job.prompt))
                  ) : generating ? (
                    <div className="studio-image-pending" aria-busy="true">
                      <WaitingDots
                        label={
                          job.kind === "image" ? "正在生成图片" : "正在生成视频"
                        }
                      />
                      <div
                        className="studio-image-placeholder"
                        style={{ aspectRatio: job.size.replace("x", "/") }}
                        aria-hidden="true"
                      >
                        <span className="studio-particle-field">
                          {Array.from({ length: 80 }, (_, index) => (
                            <i key={index} />
                          ))}
                        </span>
                      </div>
                    </div>
                  ) : job.status === "failed" ? (
                    <p className="studio-generation-error" role="alert">
                      <RefreshCw size={16} />
                      {job.error || "生成未完成，请重试。"}
                    </p>
                  ) : (
                    <p className="studio-gallery-state">
                      作品已生成，暂时无法加载。
                    </p>
                  )}
                </div>
              );
            })}
            {turn.id === busyRequestId && !turn.jobs.length && (
              <WaitingDots label="正在回复" />
            )}
          </div>
        ))}
      </div>
    </section>
  );
}
