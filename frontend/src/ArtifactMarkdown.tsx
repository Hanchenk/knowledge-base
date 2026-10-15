import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import { linkedArtifact, type BotArtifact } from "./artifact-preview";
import "./bot-artifact-preview.css";

export function ArtifactMarkdown({
  children,
  artifacts,
  onArtifact,
}: {
  children: string;
  artifacts: BotArtifact[];
  onArtifact: (id: string) => void;
}) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      urlTransform={(url, key) =>
        key === "href" && linkedArtifact(url, artifacts)
          ? url
          : defaultUrlTransform(url)
      }
      components={{
        a: ({ href = "", children }) => {
          const file = linkedArtifact(href, artifacts);
          if (file)
            return (
              <button
                type="button"
                className="bot-artifact-markdown-link"
                onClick={() => onArtifact(file.id)}
                title={`预览 ${file.name}`}
              >
                {children}
              </button>
            );
          if (href.startsWith("#")) return <a href={href}>{children}</a>;
          if (/^https?:\/\//i.test(href) || /^mailto:/i.test(href))
            return (
              <a href={href} target="_blank" rel="noopener noreferrer">
                {children}
              </a>
            );
          return <span title="文件尚未保存到当前任务">{children}</span>;
        },
      }}
    >
      {children}
    </ReactMarkdown>
  );
}
