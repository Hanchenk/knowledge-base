import { useEffect, useRef, useState } from "react";
import {
  ArrowUp,
  Check,
  Cloud,
  Download,
  FileText,
  PanelRightClose,
  PanelRightOpen,
  RotateCcw,
} from "lucide-react";
import { BloubAvatar } from "./BloubAvatar";
import { BotCompanion, InspirationGame } from "./BotCompanion";
import { readHomepageDraft, saveHomepageDraft } from "./homepageDraft";
import "./landing-bot.css";

const tasks = [
  {
    title: "整理会议纪要",
    prompt: "把这次产品评审整理成会议纪要，列出决策与行动项。",
    file: "产品评审会议纪要.md",
    heading: "产品评审 · 决策与下一步",
    reply:
      "已把会议记录整理为三项决策与对应行动。仍需补充的信息标为待确认，便于团队继续跟进。",
    steps: ["阅读会议记录", "梳理决策与行动项", "整理纪要与待确认事项"],
    sections: [
      ["01 / 本次决策", "先完成知识检索流程的小范围试点，再根据反馈扩展。"],
      ["02 / 行动清单", "产品整理需求，研发核对方案；负责人和完成日期待确认。"],
      ["03 / 待确认", "试点团队、验收标准和下一次评审时间。"],
    ],
  },
  {
    title: "研究一个课题",
    prompt: "如何让团队知识更容易被使用？请整理一份研究提纲。",
    file: "团队知识使用研究提纲.md",
    heading: "让团队知识更容易被使用",
    reply:
      "已整理三个研究方向：统一资料入口、建立可追溯的回答，以及把知识转成行动。可从一个团队的日常问题开始验证。",
    steps: ["明确课题与范围", "组织问题与证据", "整理研究提纲"],
    sections: [
      [
        "01 / 统一资料入口",
        "把制度、项目文档与会议记录放在团队可访问的知识空间。",
      ],
      [
        "02 / 建立可追溯的回答",
        "为关键结论附上资料引用，缺失的信息明确标为待确认。",
      ],
      [
        "03 / 把知识变成行动",
        "从会议纪要和研究报告开始，明确负责人、下一步与交付时间。",
      ],
    ],
  },
  {
    title: "分析业务报表",
    prompt: "帮我梳理业务报表的分析思路，核对口径并列出检查项。",
    file: "业务报表分析检查清单.md",
    heading: "业务报表 · 从数据到判断",
    reply:
      "已整理一份分析检查清单。先核对时间范围和指标口径，再查看变化与异常；缺少原始数据时不推断具体业绩。",
    steps: ["核对统计口径", "梳理趋势与异常", "生成分析检查清单"],
    sections: [
      ["01 / 核对口径", "确认报表周期、业务范围，以及收入和成本的统计定义。"],
      ["02 / 查看变化", "对比同口径的环比与同比，记录需要回查的异常。"],
      ["03 / 形成建议", "将结论对应到原始数据；证据不足的地方保留待核实说明。"],
    ],
  },
];

export function LandingBotDemo({ reduceMotion }: { reduceMotion: boolean }) {
  const [prompt, setPrompt] = useState(readHomepageDraft);
  const [selected, setSelected] = useState<number | null>(null);
  const [progress, setProgress] = useState(0);
  const [workspaceOpen, setWorkspaceOpen] = useState(
    () => window.innerWidth > 760,
  );
  const [tab, setTab] = useState<"result" | "files">("result");
  const [gameOpen, setGameOpen] = useState(false);
  const demoRoot = useRef<HTMLDivElement>(null);
  const focusReturn = useRef<HTMLElement | null>(null);
  const task = selected === null ? null : tasks[selected];
  const running = !!task && progress < 3;

  useEffect(() => {
    if (!task || gameOpen || progress >= 3) return;
    if (reduceMotion) {
      setProgress(3);
      return;
    }
    const timer = window.setTimeout(
      () => setProgress((value) => value + 1),
      650,
    );
    return () => clearTimeout(timer);
  }, [task, progress, gameOpen, reduceMotion]);

  const closeGame = () => {
    setGameOpen(false);
    requestAnimationFrame(() => {
      const target = focusReturn.current?.isConnected
        ? focusReturn.current
        : demoRoot.current?.querySelector<HTMLButtonElement>(".bot-companion");
      target?.focus({ preventScroll: true });
    });
  };
  useEffect(() => {
    if (!gameOpen) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) {
        event.preventDefault();
        closeGame();
      }
    };
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, [gameOpen]);

  const start = (index: number) => {
    setSelected(index);
    setProgress(reduceMotion ? 3 : 0);
    setTab("result");
  };
  const reset = () => {
    setSelected(null);
    setProgress(0);
  };
  const download = () => {
    if (!task || running) return;
    const text = `# ${task.heading}\n\n${task.reply}\n\n${task.sections.map(([title, body]) => `## ${title}\n\n${body}`).join("\n\n")}\n\n> 官网功能演示，使用示例内容。\n`;
    const url = URL.createObjectURL(
      new Blob([text], { type: "text/markdown;charset=utf-8" }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = task.file;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  return (
    <div className="landing-bot" id="bot-demo" ref={demoRoot}>
      <div
        className={`lb-layout ${workspaceOpen ? "" : "lb-workspace-closed"}`}
      >
        <section className="lb-chat" aria-label="知小汇互动演示">
          <header className="lb-chat-header">
            <span>
              <BloubAvatar
                size={38}
                decorative
                mood={running ? "working" : task ? "success" : "idle"}
              />{" "}
              <strong>
                知小汇 <em>bot</em>
              </strong>
            </span>
            <div>
              {task && (
                <button onClick={reset} aria-label="重新体验任务">
                  <RotateCcw size={16} />
                </button>
              )}
              <button
                onClick={() => setWorkspaceOpen(!workspaceOpen)}
                aria-label={workspaceOpen ? "收起演示工作区" : "展开演示工作区"}
              >
                {workspaceOpen ? (
                  <PanelRightClose size={16} />
                ) : (
                  <PanelRightOpen size={16} />
                )}
              </button>
            </div>
          </header>
          {gameOpen ? (
            <div className="lb-game">
              <InspirationGame active guest onClose={closeGame} />
            </div>
          ) : (
            <>
              <div className="lb-conversation">
                {task ? (
                  <div className="lb-thread">
                    <p className="lb-user">{task.prompt}</p>
                    <div className="lb-process">
                      <span className={running ? "lb-pulse" : ""} />
                      {running ? task.steps[progress] : "示例任务已完成"}
                    </div>
                    <div
                      className="lb-reply"
                      aria-live="polite"
                      aria-atomic="true"
                    >
                      <small>知小汇 · 示例回答</small>
                      <h3>{task.heading}</h3>
                      <p>
                        {running ? "正在整理示例资料，准备成果…" : task.reply}
                      </p>
                      {!running && (
                        <button
                          onClick={() => {
                            setWorkspaceOpen(true);
                            setTab("files");
                          }}
                        >
                          <FileText size={14} /> 查看示例成果 <span>↗</span>
                        </button>
                      )}
                    </div>
                  </div>
                ) : (
                  <div className="lb-welcome">
                    <BotCompanion
                      mood="idle"
                      onPlay={() => {
                        focusReturn.current =
                          document.activeElement as HTMLElement;
                        setGameOpen(true);
                      }}
                    />
                    <p className="lb-presence">
                      <i />
                      知小汇，随时待命
                    </p>
                    <h2>这次，让我来帮你完成。</h2>
                    <p>把想法说出来，我们一起把它做好。</p>
                    <small>移动鼠标看向你，点我接住一点灵感。</small>
                  </div>
                )}
              </div>
              <div className="lb-bottom">
                <div
                  className="lb-starters"
                  role="group"
                  aria-label="选择任务示例"
                >
                  {tasks.map((item, index) => (
                    <button
                      key={item.title}
                      aria-pressed={selected === index}
                      onClick={() => start(index)}
                    >
                      {item.title}
                      <span aria-hidden="true">↗</span>
                    </button>
                  ))}
                </div>
                <form
                  className="lb-composer"
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (!prompt.trim()) return;
                    saveHomepageDraft(prompt.trim());
                    window.location.assign("/login?view=bot");
                  }}
                >
                  <textarea
                    aria-label="交给知小汇的任务"
                    placeholder="下一件工作，交给知小汇。"
                    value={prompt}
                    maxLength={6000}
                    rows={2}
                    onChange={(event) => setPrompt(event.target.value)}
                    onKeyDown={(event) => {
                      if (
                        event.key === "Enter" &&
                        !event.shiftKey &&
                        !event.nativeEvent.isComposing
                      ) {
                        event.preventDefault();
                        event.currentTarget.form?.requestSubmit();
                      }
                    }}
                  />
                  <button
                    type="submit"
                    disabled={!prompt.trim()}
                    aria-label="发送任务并登录"
                  >
                    <ArrowUp size={18} aria-hidden="true" />
                  </button>
                </form>
                <p className="lb-demo-note">
                  输入任务，登录后继续 · Shift + Enter 换行
                </p>
              </div>
            </>
          )}
        </section>
        {workspaceOpen && (
          <aside className="lb-workspace" aria-label="演示成果工作区">
            <header>
              <span>
                <Cloud size={15} /> bot 工作区
              </span>
              <button
                onClick={() => setWorkspaceOpen(false)}
                aria-label="关闭演示工作区"
              >
                <PanelRightClose size={16} />
              </button>
            </header>
            <div
              className="lb-workspace-tabs"
              role="group"
              aria-label="切换示例成果"
            >
              <button
                aria-pressed={tab === "result"}
                onClick={() => setTab("result")}
              >
                成果
              </button>
              <button
                aria-pressed={tab === "files"}
                onClick={() => setTab("files")}
              >
                文件{task && !running ? " 1" : ""}
              </button>
            </div>
            <div
              className="lb-workspace-content"
              aria-live="polite"
              aria-atomic="true"
            >
              {!task ? (
                <div className="lb-empty">
                  <BloubAvatar
                    mood="idle"
                    size={88}
                    decorative
                    color="#7f98b5"
                  />
                  <h3>成果会在这里展开</h3>
                  <p>
                    从左侧的一个任务示例开始，
                    <br />
                    把想法变成一份完成的工作。
                  </p>
                </div>
              ) : running ? (
                <div className="lb-empty">
                  <BloubAvatar mood="working" size={88} decorative />
                  <h3>一步一步，把事情做好。</h3>
                  <p>{task.steps[progress]}</p>
                  <div className="lb-progress">
                    {task.steps.map((step, index) => (
                      <span
                        key={step}
                        className={index <= progress ? "active" : ""}
                      />
                    ))}
                  </div>
                </div>
              ) : tab === "result" ? (
                <article className="lb-result">
                  <small>
                    <Check size={13} /> 示例成果已整理
                  </small>
                  <h3>{task.heading}</h3>
                  {task.sections.map(([title, body]) => (
                    <section key={title}>
                      <h4>{title}</h4>
                      <p>{body}</p>
                    </section>
                  ))}
                </article>
              ) : (
                <div className="lb-file">
                  <FileText size={26} />
                  <strong>{task.file}</strong>
                  <small>Markdown · 官网示例成果</small>
                  <button onClick={download}>
                    <Download size={14} />
                    下载示例文件
                  </button>
                </div>
              )}
            </div>
            <footer>资料 · 应用连接器 · 技能 · 云端工具</footer>
          </aside>
        )}
      </div>
    </div>
  );
}
