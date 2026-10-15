import { useState } from "react";
import { Cloud, Database, ImagePlus, Settings2, Sparkles } from "lucide-react";
import { StorageSettings } from "./StorageSettings";
import { ModelSettings } from "./ModelSettings";
import { MediaModelSettings } from "./MediaModelSettings";
import { CloudSettings } from "./CloudSettings";
import type { Feedback } from "./App";

export function SettingsPage({
  initialSection = "rag",
  feedback,
  onSaved,
}: {
  initialSection?: "rag" | "studio";
  feedback: Feedback;
  onSaved: () => Promise<void>;
}) {
  const [section, setSection] = useState<
    "rag" | "studio" | "storage" | "cloud"
  >(initialSection);
  const [dirty, setDirty] = useState(false);
  const [notice, setNotice] = useState("");
  const choose = (next: "rag" | "studio" | "storage" | "cloud") => {
    if (next === section) return;
    if (dirty) {
      setNotice("请先保存配置或放弃修改，再切换设置分类。");
      return;
    }
    setNotice("");
    setSection(next);
  };
  return (
    <>
      <div className="page-heading">
        <div>
          <h1>设置</h1>
          <p>统一管理模型、对象存储与云端服务，供知识问答、检索与创作使用。</p>
        </div>
        <span className="tiny-pill">
          <Settings2 size={13} />
          企业设置
        </span>
      </div>
      <div className="settings-model-tabs" role="tablist" aria-label="模型分类">
        <button
          role="tab"
          aria-selected={section === "rag"}
          aria-controls="settings-model-content"
          className={section === "rag" ? "active" : ""}
          onClick={() => choose("rag")}
        >
          <Sparkles size={17} />
          <span>
            问答与检索<small>问答 · 向量 · 视觉</small>
          </span>
        </button>
        <button
          role="tab"
          aria-selected={section === "studio"}
          aria-controls="settings-model-content"
          className={section === "studio" ? "active" : ""}
          onClick={() => choose("studio")}
        >
          <ImagePlus size={17} />
          <span>
            生图与视频<small>多组模型 · 默认配置</small>
          </span>
        </button>
        <button
          role="tab"
          aria-selected={section === "cloud"}
          aria-controls="settings-model-content"
          className={section === "cloud" ? "active" : ""}
          onClick={() => choose("cloud")}
        >
          <Cloud size={17} />
          <span>
            云端服务<small>运行环境 · 版本维护</small>
          </span>
        </button>
        <button
          role="tab"
          aria-selected={section === "storage"}
          aria-controls="settings-model-content"
          className={section === "storage" ? "active" : ""}
          onClick={() => choose("storage")}
        >
          <Database size={17} />
          <span>
            对象存储<small>MinIO · S3</small>
          </span>
        </button>
      </div>
      {notice && dirty && (
        <p className="model-notice" role="alert">
          {notice}
        </p>
      )}
      <div
        id="settings-model-content"
        role="tabpanel"
        aria-label={
          section === "rag"
            ? "问答与检索"
            : section === "studio"
              ? "生图与视频"
              : section === "cloud"
                ? "云端服务"
                : "对象存储"
        }
      >
        {section === "rag" ? (
          <ModelSettings
            feedback={feedback}
            onSaved={onSaved}
            onDirtyChange={setDirty}
          />
        ) : section === "cloud" ? (
          <CloudSettings feedback={feedback} />
        ) : section === "storage" ? (
          <StorageSettings
            feedback={feedback}
            onSaved={onSaved}
            onDirtyChange={setDirty}
          />
        ) : (
          <MediaModelSettings
            feedback={feedback}
            onSaved={onSaved}
            onDirtyChange={setDirty}
          />
        )}
      </div>
    </>
  );
}
