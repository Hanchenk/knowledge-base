import { useEffect, useRef, useState } from "react";
import {
  ArrowDown,
  ArrowRight,
  Check,
  CheckCircle2,
  ChevronRight,
  Circle,
  FileText,
  Loader2,
  RefreshCw,
  ShieldCheck,
  Square,
  Workflow,
  X,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { date } from "./api";
import { type BotMood } from "./BloubAvatar";
import { BotCompanion } from "./BotCompanion";
import {
  activeStates,
  Badge,
  statusNames,
  toolNames,
  type Detail,
} from "./bot-types";

type Props = {
  detail?: Detail;
  ancestors: Detail[];
  mood: BotMood;
  busy: boolean;
  onCancel: () => void;
  onRetry: () => void;
  onApprove: (id: string) => void;
  onReject: (id: string) => void;
  onFiles: () => void;
  onPlay: () => void;
  gameOpen: boolean;
};

function Reply({ detail, live = false }: { detail: Detail; live?: boolean }) {
  const latest = detail.messages?.at(-1);
  const active = ["running", "queued"].includes(detail.task.status);
  const output =
    live && active
      ? latest?.content || detail.task.result
      : detail.task.result || latest?.content;
  const streaming =
    live && detail.task.status === "running" && latest?.status === "streaming";
  if (!output) return null;
  return (
    <div className={`bot-chat-reply ${streaming ? "is-streaming" : ""}`}>
      <div className="bot-reply-label">
        <span />
        知小汇{streaming && <small>正在输出</small>}
      </div>
      <div className="markdown">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{output}</ReactMarkdown>
        {streaming && <span className="bot-stream-cursor" aria-hidden="true" />}
      </div>
    </div>
  );
}

export function BotConversation({
  detail,
  ancestors,
  mood,
  busy,
  onCancel,
  onRetry,
  onApprove,
  onReject,
  onFiles,
  onPlay,
  gameOpen,
}: Props) {
  const scroll = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const [showLatest, setShowLatest] = useState(false);
  const task = detail?.task;
  const latest = detail?.messages?.at(-1);
  const active = !!task && activeStates.includes(task.status);
  const lastEvent = detail?.events.at(-1);
  const progress =
    lastEvent?.content.message ||
    toolNames[lastEvent?.content.name || ""] ||
    "正在准备任务";
  useEffect(() => {
    follow.current = true;
    setShowLatest(false);
  }, [task?.id]);
  useEffect(() => {
    if (!follow.current) return;
    const frame = requestAnimationFrame(() => {
      if (scroll.current)
        scroll.current.scrollTop = scroll.current.scrollHeight;
    });
    return () => cancelAnimationFrame(frame);
  }, [task?.id, task?.result, task?.status, latest?.content, ancestors.length]);
  return (
    <div className="bot-conversation">
      <div
        className="bot-chat-scroll"
        ref={scroll}
        role="log"
        aria-label="与知小汇的对话"
        aria-relevant="additions"
        onScroll={() => {
          if (!scroll.current) return;
          const element = scroll.current;
          follow.current =
            element.scrollHeight - element.scrollTop - element.clientHeight <
            90;
          setShowLatest(!follow.current);
        }}
      >
        {!task ? (
          <section className="bot-welcome">
            <BotCompanion mood={mood} onPlay={onPlay} suspended={gameOpen} />
            <div className="bot-welcome-label">
              <span className="bot-presence" />
              知小汇，随时待命
            </div>
            <h2>这次，让我来帮你完成。</h2>
            <p>把想法说出来，我们一起把它做好。</p>
          </section>
        ) : (
          <div className="bot-chat-thread">
            {(detail?.evidence_available ? ancestors : []).map((previous) => (
              <div className="bot-chat-turn" key={previous.task.id}>
                <div className="bot-chat-date">
                  {date(previous.task.created_at)}
                </div>
                <div className="bot-chat-user">
                  <p>{previous.task.prompt}</p>
                </div>
                <Reply detail={previous} />
              </div>
            ))}
            <div className="bot-chat-turn" key={task.id}>
              <div className="bot-chat-date">{date(task.created_at)}</div>
              <div className="bot-chat-user">
                <p>{task.prompt}</p>
              </div>
              <details className="bot-process">
                <summary>
                  <ChevronRight size={13} />
                  {["running", "queued"].includes(task.status) ? (
                    <Loader2 size={12} className="spin" />
                  ) : (
                    <Workflow size={12} />
                  )}
                  <span>{active ? progress : "执行过程"}</span>
                  <small>{detail!.events.length} 条记录</small>
                  <Badge status={task.status} />
                </summary>
                <div className="bot-process-body">
                  {!!task.plan.length && (
                    <section className="bot-plan">
                      <h3>
                        <Workflow size={15} />
                        任务步骤
                      </h3>
                      {task.plan.map((step, index) => (
                        <div key={index} className={step.status}>
                          {step.status === "completed" ? (
                            <CheckCircle2 size={16} />
                          ) : step.status === "running" &&
                            task.status === "running" ? (
                            <Loader2 size={16} className="spin" />
                          ) : (
                            <Circle size={16} />
                          )}
                          <span>{step.title}</span>
                          <small>
                            {step.status === "completed"
                              ? "完成"
                              : step.status === "running"
                                ? "处理中"
                                : "待执行"}
                          </small>
                        </div>
                      ))}
                    </section>
                  )}
                  {(detail!.messages || []).slice(0, -1).map((message) => (
                    <div
                      className="bot-process-message markdown"
                      key={message.id}
                    >
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>
                        {message.content}
                      </ReactMarkdown>
                    </div>
                  ))}
                  <section className="bot-events">
                    <h3>
                      执行记录 <small>{detail!.events.length}</small>
                    </h3>
                    {detail!.events.map((event) => (
                      <div key={event.id}>
                        <span
                          className={
                            event.content.success === false ? "failed" : ""
                          }
                        />
                        <p>
                          {event.content.message ||
                            toolNames[event.content.name || ""] ||
                            `外部操作：${statusNames[event.content.status || ""] || event.content.status}`}
                          {event.content.success === false && " · 未成功"}
                        </p>
                        <time>{date(event.created_at)}</time>
                      </div>
                    ))}
                  </section>
                </div>
              </details>
              {detail!.actions.map((action) => (
                <section className="bot-approval" key={action.id}>
                  <div className="bot-section-title">
                    <h3>
                      <ShieldCheck size={16} />
                      {action.name} · 外部操作
                    </h3>
                    <Badge status={action.status} />
                  </div>
                  <p>
                    {action.status === "pending"
                      ? "确认后将向下面的地址提交此请求。"
                      : action.status === "uncertain"
                        ? "请求未获得确定结果，请在外部系统核实。"
                        : "该操作的执行状态和请求已保留。"}
                  </p>
                  <code>
                    {action.payload.method} {action.payload.url}
                  </code>
                  <pre>{JSON.stringify(action.payload.input, null, 2)}</pre>
                  {action.result && (
                    <details>
                      <summary>查看真实返回结果</summary>
                      <pre>{action.result}</pre>
                    </details>
                  )}
                  {action.status === "pending" && task.status === "waiting" && (
                    <div>
                      <button
                        className="button primary"
                        disabled={busy}
                        onClick={() => onApprove(action.id)}
                      >
                        <Check size={14} />
                        确认执行
                      </button>
                      <button
                        className="button"
                        disabled={busy}
                        onClick={() => onReject(action.id)}
                      >
                        <X size={14} />
                        拒绝
                      </button>
                    </div>
                  )}
                </section>
              ))}
              <Reply detail={detail!} live />
              {!task.result &&
                !latest?.content &&
                ["queued", "running"].includes(task.status) && (
                  <div className="bot-chat-pending">
                    <span />
                    <span />
                    <span />
                    <small>正在准备回复</small>
                  </div>
                )}
              {!!task.error && (
                <div className="bot-notice error" role="alert">
                  {task.error}
                </div>
              )}
              {!!detail!.artifacts.length && (
                <button className="bot-chat-file-link" onClick={onFiles}>
                  <FileText size={15} />
                  {detail!.artifacts.length} 个成果文件
                  <ArrowRight size={13} />
                </button>
              )}
              <div className="bot-chat-task-actions">
                {active && (
                  <button
                    className="text-button"
                    disabled={busy}
                    onClick={onCancel}
                  >
                    <Square size={12} />
                    取消任务
                  </button>
                )}
                {["failed", "cancelled", "paused"].includes(task.status) &&
                  detail!.evidence_available &&
                  !task.options?.local_device_id && (
                    <button
                      className="text-button"
                      disabled={busy}
                      onClick={onRetry}
                    >
                      <RefreshCw size={13} />
                      从保存进度继续
                    </button>
                  )}
                <span>
                  {task.status === "completed"
                    ? "任务已完成，可以继续对话"
                    : task.status === "waiting"
                      ? task.options?.local_device_id
                        ? "请在 DeepSeek Harness 桌面端确认后继续"
                        : "确认操作后，任务将继续"
                      : active
                        ? task.options?.local_device_id
                          ? "任务在本地 Harness 执行，进度自动同步"
                          : "任务在云端执行，进度自动保存"
                        : "任务进度已保留"}
                </span>
              </div>
            </div>
          </div>
        )}
      </div>
      {showLatest && (
        <button
          className="bot-jump-latest"
          onClick={() => {
            follow.current = true;
            scroll.current?.scrollTo({
              top: scroll.current.scrollHeight,
              behavior: window.matchMedia("(prefers-reduced-motion: reduce)")
                .matches
                ? "instant"
                : "smooth",
            });
            setShowLatest(false);
          }}
        >
          <ArrowDown size={14} />
          回到最新
        </button>
      )}
    </div>
  );
}
