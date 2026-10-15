import {
  ArrowRight,
  Cloud,
  FileText,
  Globe2,
  PanelRightClose,
} from "lucide-react";
import { ArtifactMarkdown } from "./ArtifactMarkdown";
import { BotArtifactFiles } from "./BotArtifactFiles";
import type { BotArtifact } from "./artifact-preview";
import { BloubAvatar, type BotMood } from "./BloubAvatar";
import { Badge, type Detail } from "./bot-types";
import { visibleCitationSources } from "./citation-sources";

export function BotWorkspace({
  detail,
  mood,
  tab,
  onTab,
  onClose,
  onDocument,
  selectedArtifactId,
  previewArtifact,
  previewArtifacts,
  onArtifact,
}: {
  detail?: Detail;
  mood: BotMood;
  tab: "result" | "files";
  onTab: (value: "result" | "files") => void;
  onClose: () => void;
  onDocument: (id: string) => void;
  selectedArtifactId?: string;
  previewArtifact?: BotArtifact;
  previewArtifacts?: BotArtifact[];
  onArtifact: (id: string) => void;
}) {
  const latest = detail?.messages?.at(-1);
  const artifacts = detail?.evidence_available ? detail.artifacts : [];
  const active = ["running", "queued"].includes(detail?.task.status || "");
  const text = active
    ? latest?.content || detail?.task.result
    : detail?.task.result || latest?.content;
  const sources = visibleCitationSources(
    text || "",
    detail?.evidence_available === false ? [] : detail?.task.citations || [],
    detail?.evidence_available === false ? [] : detail?.task.web_sources || [],
  );
  return (
    <aside className="bot-workspace-pane" aria-label="bot 工作区">
      <header className="bot-workspace-header">
        <span>
          <Cloud size={16} />
          bot 工作区
        </span>
        <button
          className="icon-button"
          aria-label="收起工作区"
          onClick={onClose}
        >
          <PanelRightClose size={18} />
        </button>
      </header>
      <div
        className="bot-workspace-tabs"
        role="tablist"
        aria-label="工作区内容"
      >
        <button
          role="tab"
          id="bot-result-tab"
          aria-selected={tab === "result"}
          aria-controls="bot-workspace-content"
          onClick={() => onTab("result")}
        >
          成果
        </button>
        <button
          role="tab"
          id="bot-files-tab"
          aria-selected={tab === "files"}
          aria-controls="bot-workspace-content"
          onClick={() => onTab("files")}
        >
          文件
          {artifacts.length ? <small>{artifacts.length}</small> : null}
        </button>
      </div>
      <div
        className="bot-workspace-scroll"
        id="bot-workspace-content"
        role="tabpanel"
        aria-labelledby={tab === "result" ? "bot-result-tab" : "bot-files-tab"}
      >
        {detail && (
          <div className="bot-workspace-task">
            <span>{detail.task.title}</span>
            <Badge status={detail.task.status} />
          </div>
        )}
        {tab === "result" && text ? (
          <section className="bot-result">
            <div className="bot-section-title">
              <h3>
                <FileText size={16} />
                {active
                  ? "正在生成"
                  : detail?.task.status === "waiting"
                    ? "当前进展"
                    : "任务成果"}
              </h3>
              {active && latest?.status === "streaming" && (
                <span className="bot-output-status">
                  <i />
                  实时输出
                </span>
              )}
            </div>
            <div className="markdown">
              <ArtifactMarkdown artifacts={artifacts} onArtifact={onArtifact}>
                {text}
              </ArtifactMarkdown>
            </div>
            {!!sources.citations.length && (
              <div className="bot-sources">
                <h4>知识来源</h4>
                {sources.citations.map((source, index) => (
                  <button
                    key={`${source.chunk_id}-${index}`}
                    onClick={() => onDocument(source.document_id)}
                  >
                    <FileText size={14} />
                    <span>
                      [{source.citation_number}] {source.title} · 第{" "}
                      {source.page} 页
                    </span>
                    <ArrowRight size={13} />
                  </button>
                ))}
              </div>
            )}
            {!!sources.webSources.length && (
              <div className="bot-sources">
                <h4>公开来源</h4>
                {sources.webSources.map((source) => (
                  <a
                    key={source.url}
                    href={source.url}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    <Globe2 size={14} />
                    [W{source.citation_number}] {source.title}
                  </a>
                ))}
              </div>
            )}
          </section>
        ) : tab === "files" && (artifacts.length || previewArtifact) ? (
          <section className="bot-files">
            <h3>
              <Cloud size={16} />
              成果文件
            </h3>
            <BotArtifactFiles
              artifacts={artifacts}
              selectedArtifactId={selectedArtifactId}
              previewArtifact={previewArtifact}
              previewArtifacts={previewArtifacts}
              onArtifact={onArtifact}
            />
          </section>
        ) : (
          <div className="bot-workspace-empty">
            <BloubAvatar mood={mood} size={100} decorative />
            <h3>{tab === "files" ? "文件会保存在这里" : "成果会在这里展开"}</h3>
            <p>
              {active
                ? "知小汇正在处理，内容生成后会实时显示。"
                : tab === "files"
                  ? "报告、表格与文档，随时查看和下载。"
                  : "从左侧开始对话，把想法变成一份完成的工作。"}
            </p>
          </div>
        )}
      </div>
      <footer className="bot-workspace-footer">
        <span />
        私有任务空间 · 自动保存
      </footer>
    </aside>
  );
}
