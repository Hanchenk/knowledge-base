import { useEffect, useRef, useState } from "react";
import {
  Download,
  FileText,
  LoaderCircle,
  Plus,
  RefreshCw,
  ShieldCheck,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { api, bytes, date, post, MAX_UPLOAD_BYTES, MAX_UPLOAD_MB } from "./api";
import { Empty, FileIcon, Modal, Status, Submit } from "./components";
import type { Department, Document, Grant, Space, User } from "./types";
import type { Confirm, Feedback } from "./App";

type Props = { onClose: () => void; onSuccess: () => void; feedback: Feedback };
export function SpaceDialog({ onClose, onSuccess, feedback }: Props) {
  const [busy, setBusy] = useState(false);
  return (
    <Modal title="创建知识空间" onClose={onClose}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          const data = new FormData(e.currentTarget);
          setBusy(true);
          try {
            await post("/api/spaces", Object.fromEntries(data));
            feedback("知识空间已创建，请配置成员权限");
            onSuccess();
          } catch (e) {
            feedback((e as Error).message, true);
          } finally {
            setBusy(false);
          }
        }}
      >
        <label>
          空间名称
          <input
            name="name"
            required
            maxLength={100}
            placeholder="例如：客户成功知识库"
            autoFocus
          />
        </label>
        <label>
          空间描述
          <textarea
            name="description"
            rows={3}
            maxLength={2000}
            placeholder="这里存放什么知识？谁会使用它？"
          />
        </label>
        <label>
          空间颜色
          <select name="color">
            <option value="blue">蓝色</option>
            <option value="purple">紫色</option>
            <option value="green">绿色</option>
            <option value="orange">橙色</option>
          </select>
        </label>
        <div className="notice">
          <ShieldCheck size={17} />
          <span>新空间默认仅企业管理员可访问。创建后可授权给部门或成员。</span>
        </div>
        <div className="form-actions">
          <button type="button" className="button" onClick={onClose}>
            取消
          </button>
          <Submit busy={busy}>创建空间</Submit>
        </div>
      </form>
    </Modal>
  );
}
function SpaceSelect({
  spaces,
  preferred,
}: {
  spaces: Space[];
  preferred: string;
}) {
  return (
    <label>
      知识空间
      <select
        name="space_id"
        required
        defaultValue={
          spaces.some((s) => s.id === preferred) ? preferred : spaces[0]?.id
        }
      >
        {spaces.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name}
          </option>
        ))}
      </select>
    </label>
  );
}
export function NewDocumentDialog({
  spaces,
  preferred,
  onClose,
  onSuccess,
  feedback,
}: Props & { spaces: Space[]; preferred: string }) {
  const [busy, setBusy] = useState(false);
  const writable = spaces.filter((s) => s.permissions.can_create);
  return (
    <Modal title="创建知识文档" onClose={onClose} wide>
      {!writable.length ? (
        <Empty
          title="没有可创建文档的空间"
          text="请联系空间管理员分配创建权限"
        />
      ) : (
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            const data = new FormData(e.currentTarget);
            setBusy(true);
            try {
              await post("/api/documents", {
                ...Object.fromEntries(data),
                tags: String(data.get("tags") || "")
                  .split(/[,，]/)
                  .map((v) => v.trim())
                  .filter(Boolean),
              });
              feedback("文档已创建，正在建立检索索引");
              onSuccess();
            } catch (e) {
              feedback((e as Error).message, true);
            } finally {
              setBusy(false);
            }
          }}
        >
          <SpaceSelect spaces={writable} preferred={preferred} />
          <label>
            标题
            <input
              name="title"
              required
              maxLength={200}
              placeholder="清晰的标题让知识更容易被发现"
              autoFocus
            />
          </label>
          <label>
            正文 <span className="label-note">支持 Markdown</span>
            <textarea
              className="markdown-input"
              name="content"
              required
              rows={12}
              placeholder={"# 概述\n\n记录适用范围、关键步骤和注意事项…"}
            />
          </label>
          <label>
            标签
            <input name="tags" placeholder="用逗号分隔，例如：流程, 新人必读" />
          </label>
          <div className="form-actions">
            <button type="button" className="button" onClick={onClose}>
              取消
            </button>
            <Submit busy={busy}>创建并索引</Submit>
          </div>
        </form>
      )}
    </Modal>
  );
}
export function UploadDialog({
  spaces,
  preferred,
  onClose,
  onSuccess,
  feedback,
}: Props & { spaces: Space[]; preferred: string }) {
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState("");
  const [drag, setDrag] = useState(false);
  const writable = spaces.filter((s) => s.permissions.can_create);
  const input = useRef<HTMLInputElement>(null);
  const add = (selected: File[]) => {
    if (selected.some((f) => f.size > MAX_UPLOAD_BYTES)) {
      feedback(`单个文件不能超过 ${MAX_UPLOAD_MB} MB`, true);
      return;
    }
    setFiles((v) => [...v, ...selected].slice(0, 10));
  };
  return (
    <Modal
      title="上传资料到知识库"
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      {!writable.length ? (
        <Empty title="没有可上传的空间" />
      ) : (
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            if (!files.length) return;
            const data = new FormData(e.currentTarget);
            setBusy(true);
            let failed = false;
            let remaining = [...files];
            for (let i = 0; i < files.length; i++) {
              setProgress(`正在上传 ${i + 1} / ${files.length}`);
              const upload = new FormData();
              upload.append("space_id", String(data.get("space_id")));
              upload.append("file", files[i]);
              try {
                await api("/api/documents/upload", {
                  method: "POST",
                  body: upload,
                });
                remaining = remaining.slice(1);
                setFiles(remaining);
              } catch (e) {
                feedback(`${files[i].name}：${(e as Error).message}`, true);
                failed = true;
                break;
              }
            }
            setBusy(false);
            setProgress("");
            if (!failed) {
              feedback("资料上传成功，索引任务已加入队列");
              onSuccess();
            }
          }}
        >
          <SpaceSelect spaces={writable} preferred={preferred} />
          <input
            className="hidden"
            ref={input}
            type="file"
            multiple
            accept=".pdf,.docx,.xlsx,.pptx,application/vnd.openxmlformats-officedocument.presentationml.presentation,.md,.txt,.csv,.png,.jpg,.jpeg,.webp"
            onChange={(e) => {
              add(Array.from(e.target.files || []));
              e.target.value = "";
            }}
          />
          <button
            type="button"
            className={`dropzone ${drag ? "drag" : ""}`}
            disabled={busy}
            onClick={() => input.current?.click()}
            onDragOver={(e) => {
              e.preventDefault();
              setDrag(true);
            }}
            onDragLeave={() => setDrag(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDrag(false);
              if (!busy) add(Array.from(e.dataTransfer.files));
            }}
          >
            <div>
              <Upload size={27} />
            </div>
            <strong>点击选择，或将文件拖到这里</strong>
            <span>PDF / DOCX / XLSX / PPTX / Markdown / 文本 / 图片</span>
            <small>单个文件最大 {MAX_UPLOAD_MB} MB，每次最多 10 个</small>
          </button>
          {files.length > 0 && (
            <div className="upload-files">
              {files.map((file, i) => (
                <div key={`${file.name}-${i}`}>
                  <FileIcon mime={file.type} />
                  <span>
                    {file.name}
                    <small>{bytes(file.size)}</small>
                  </span>
                  <button
                    type="button"
                    className="icon-button"
                    disabled={busy}
                    aria-label={`移除${file.name}`}
                    onClick={() =>
                      setFiles((v) => v.filter((_, index) => index !== i))
                    }
                  >
                    <X size={16} />
                  </button>
                </div>
              ))}
            </div>
          )}
          <div className="notice">
            <SparkleNotice />
            <span>
              索引后可检索原文并引用来源。图片与扫描件需要配置视觉模型。
            </span>
          </div>
          <div className="form-actions">
            <span className="upload-progress">{progress}</span>
            <button
              type="button"
              className="button"
              disabled={busy}
              onClick={onClose}
            >
              取消
            </button>
            <button className="button primary" disabled={busy || !files.length}>
              {busy ? (
                <LoaderCircle size={16} className="spin" />
              ) : (
                <Upload size={16} />
              )}
              上传并索引
            </button>
          </div>
        </form>
      )}
    </Modal>
  );
}
function SparkleNotice() {
  return <FileText size={17} />;
}
type Chunk = {
  id: string;
  text: string;
  page: number;
  kind: string;
  image_url: string | null;
};
export function DocumentDialog({
  id,
  user,
  spaces,
  onClose,
  onSuccess,
  feedback,
  confirm,
}: Props & { id: string; user: User; spaces: Space[]; confirm: Confirm }) {
  const [data, setData] = useState<{ document: Document; chunks: Chunk[] }>();
  const [versions, setVersions] = useState<
    { version: number; size: number; created_at: number }[]
  >([]);
  const [error, setError] = useState("");
  const [tab, setTab] = useState("content");
  const [visible, setVisible] = useState(30);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const load = () =>
    Promise.all([
      api<{ document: Document; chunks: Chunk[] }>(`/api/documents/${id}`),
      api<typeof versions>(`/api/documents/${id}/versions`),
    ])
      .then(([doc, v]) => {
        setData(doc);
        setVersions(v);
      })
      .catch((e) => setError((e as Error).message));
  useEffect(() => {
    void load();
  }, [id]);
  const permission = spaces.find(
    (s) => s.id === data?.document.space_id,
  )?.permissions;
  const writable =
    permission?.can_create &&
    (permission.can_manage || data?.document.created_by === user.id);
  return (
    <Modal title={data?.document.title || "查看文档"} onClose={onClose} wide>
      {error ? (
        <Empty title={error} />
      ) : !data ? (
        <div className="loading">
          <LoaderCircle className="spin" />
          正在加载文档…
        </div>
      ) : (
        <>
          <div className="document-meta">
            <Status value={data.document.status} />
            <span>版本 v{data.document.version}</span>
            <span>{bytes(data.document.size)}</span>
            <span>{date(data.document.updated_at)}</span>
          </div>
          {data.document.error && (
            <div className="notice error-notice">{data.document.error}</div>
          )}
          <div className="document-toolbar">
            <div className="tabs">
              <button
                className={tab === "content" ? "active" : ""}
                onClick={() => setTab("content")}
              >
                检索内容
              </button>
              <button
                className={tab === "versions" ? "active" : ""}
                onClick={() => setTab("versions")}
              >
                版本记录 <span>{versions.length}</span>
              </button>
            </div>
            <div className="toolbar-actions">
              <a
                className="button small-button"
                href={`/api/documents/${id}/file`}
              >
                <Download size={14} />
                原文件
              </a>
              {writable && (
                <>
                  <input
                    className="hidden"
                    ref={input}
                    type="file"
                    accept=".pdf,.docx,.xlsx,.pptx,application/vnd.openxmlformats-officedocument.presentationml.presentation,.txt,.md,.csv,.png,.jpg,.jpeg,.webp"
                    onChange={async (e) => {
                      const file = e.target.files?.[0];
                      e.target.value = "";
                      if (!file) return;
                      if (file.size > MAX_UPLOAD_BYTES) {
                        feedback(`单个文件不能超过 ${MAX_UPLOAD_MB} MB`, true);
                        return;
                      }
                      const body = new FormData();
                      body.append("file", file);
                      body.append("replace_id", id);
                      setBusy(true);
                      try {
                        await api("/api/documents/upload", {
                          method: "POST",
                          body,
                        });
                        feedback("新版本已上传，正在重新索引");
                        await load();
                        onSuccess();
                      } catch (e) {
                        feedback((e as Error).message, true);
                      } finally {
                        setBusy(false);
                      }
                    }}
                  />
                  <button
                    className="button small-button"
                    disabled={busy}
                    onClick={() => input.current?.click()}
                  >
                    <Upload size={14} />
                    新版本
                  </button>
                  <button
                    className="icon-button"
                    title="重新索引"
                    disabled={busy}
                    onClick={async () => {
                      setBusy(true);
                      try {
                        await post(`/api/documents/${id}/retry`, {});
                        feedback("已加入索引队列");
                        await load();
                        onSuccess();
                      } catch (e) {
                        feedback((e as Error).message, true);
                      } finally {
                        setBusy(false);
                      }
                    }}
                  >
                    <RefreshCw size={16} />
                  </button>
                  <button
                    className="icon-button danger-text"
                    title="删除文档"
                    disabled={busy}
                    onClick={() =>
                      confirm(
                        `删除「${data.document.title}」？删除后将移除原文件和检索内容。`,
                        async () => {
                          await api(`/api/documents/${id}`, {
                            method: "DELETE",
                          });
                          feedback("文档已删除");
                          onClose();
                          onSuccess();
                        },
                      )
                    }
                  >
                    <Trash2 size={16} />
                  </button>
                </>
              )}
            </div>
          </div>
          {tab === "versions" ? (
            <div className="version-list">
              {versions.map((v) => (
                <div key={v.version}>
                  <div className="version-dot" />
                  <span>
                    <strong>
                      版本 v{v.version}{" "}
                      {v.version === data.document.version && (
                        <small>当前版本</small>
                      )}
                    </strong>
                    <small>
                      {date(v.created_at)} · {bytes(v.size)}
                    </small>
                  </span>
                  <a
                    className="text-button"
                    href={`/api/documents/${id}/file?version=${v.version}`}
                  >
                    下载 <Download size={14} />
                  </a>
                </div>
              ))}
            </div>
          ) : (
            <div className="document-content">
              {data.chunks.length ? (
                data.chunks.slice(0, visible).map((chunk) => (
                  <section className="chunk-section" key={chunk.id}>
                    <div className="chunk-label">
                      第 {chunk.page} 页 ·{" "}
                      {chunk.kind === "image"
                        ? "图像解析"
                        : chunk.kind === "table_summary"
                          ? "月累计汇总"
                          : chunk.kind === "table"
                            ? "表格"
                            : "文本片段"}
                    </div>
                    {chunk.image_url && (
                      <img
                        className="source-image"
                        src={chunk.image_url}
                        alt={`文档第 ${chunk.page} 页原图`}
                        loading="lazy"
                      />
                    )}
                    <div className="markdown">
                      <Markdown remarkPlugins={[remarkGfm]}>
                        {chunk.text}
                      </Markdown>
                    </div>
                  </section>
                ))
              ) : (
                <Empty
                  title={
                    data.document.status === "failed"
                      ? "文档索引失败"
                      : "正在准备文档内容"
                  }
                  text="索引完成后可在这里查看解析内容，也可以下载原文件。"
                />
              )}
              {visible < data.chunks.length && (
                <button
                  className="button"
                  onClick={() => setVisible((v) => v + 30)}
                >
                  加载更多片段（{data.chunks.length - visible}）
                </button>
              )}
            </div>
          )}
        </>
      )}
    </Modal>
  );
}
export function GrantDialog({
  space,
  tenantId,
  onClose,
  onSuccess,
  feedback,
}: Props & { space: Space; tenantId: string }) {
  const [grants, setGrants] = useState<Grant[]>([]);
  const [principals, setPrincipals] = useState<{
    users: User[];
    departments: Department[];
  }>();
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    Promise.all([
      api<Grant[]>(`/api/spaces/${space.id}/grants`),
      api<{ users: User[]; departments: Department[] }>(
        `/api/principals?space_id=${space.id}`,
      ),
    ])
      .then(([g, p]) => {
        setGrants(g);
        setPrincipals(p);
        setLoaded(true);
      })
      .catch((e) => feedback((e as Error).message, true));
  }, [space.id, feedback]);
  const update = (i: number, patch: Partial<Grant>) =>
    setGrants((v) =>
      v.map((g, index) => (index === i ? { ...g, ...patch } : g)),
    );
  return (
    <Modal title={`${space.name} · 权限设置`} onClose={onClose} wide>
      <div className="notice">
        <ShieldCheck size={18} />
        <span>
          允许规则叠加，显式拒绝优先。部门和汇报关系可向下继承。企业管理员保留管理权。
        </span>
      </div>
      {!loaded ? (
        <div className="loading">
          <LoaderCircle className="spin" />
          加载授权对象…
        </div>
      ) : (
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            try {
              await api(`/api/spaces/${space.id}/grants`, {
                method: "PUT",
                body: JSON.stringify(
                  grants.map((g) => ({
                    ...g,
                    include_descendants: !!g.include_descendants,
                    can_view: !!g.can_view,
                    can_create: !!g.can_create,
                    can_manage: !!g.can_manage,
                  })),
                ),
              });
              feedback("权限已更新，检索和 Agent 调用同步生效");
              onSuccess();
            } catch (e) {
              feedback((e as Error).message, true);
            } finally {
              setBusy(false);
            }
          }}
        >
          <div className="grant-list">
            {grants.map((g, i) => (
              <div className="grant-row" key={i}>
                <div className="grant-target">
                  <select
                    aria-label="授权对象类型"
                    value={g.principal_type}
                    onChange={(e) => {
                      const type = e.target.value;
                      update(i, {
                        principal_type: type,
                        principal_id:
                          type === "tenant"
                            ? tenantId
                            : type === "department"
                              ? principals?.departments[0]?.id || ""
                              : principals?.users[0]?.id || "",
                        include_descendants: false,
                      });
                    }}
                  >
                    <option value="tenant">全体成员</option>
                    <option value="department">部门</option>
                    <option value="user">具体成员</option>
                    <option value="reports">某人的下属</option>
                  </select>
                  <select
                    aria-label="授权对象"
                    required
                    value={g.principal_id}
                    onChange={(e) =>
                      update(i, { principal_id: e.target.value })
                    }
                  >
                    {g.principal_type === "tenant" ? (
                      <option value={tenantId}>企业全体成员</option>
                    ) : g.principal_type === "department" ? (
                      principals?.departments.map((d) => (
                        <option value={d.id} key={d.id}>
                          {d.name}
                        </option>
                      ))
                    ) : (
                      principals?.users.map((u) => (
                        <option value={u.id} key={u.id}>
                          {u.name}
                        </option>
                      ))
                    )}
                  </select>
                  <select
                    aria-label="允许或拒绝"
                    value={g.effect}
                    onChange={(e) => update(i, { effect: e.target.value })}
                  >
                    <option value="allow">允许</option>
                    <option value="deny">拒绝</option>
                  </select>
                  <button
                    type="button"
                    className="icon-button danger-text"
                    aria-label="删除此规则"
                    onClick={() =>
                      setGrants((v) => v.filter((_, index) => index !== i))
                    }
                  >
                    <Trash2 size={15} />
                  </button>
                </div>
                <div className="grant-rights">
                  {[
                    { key: "can_view", text: "查看知识" },
                    { key: "can_create", text: "创建文档" },
                    { key: "can_manage", text: "管理空间" },
                    { key: "include_descendants", text: "包含下级" },
                  ].map((item) => (
                    <label className="checkbox-label" key={item.key}>
                      <input
                        type="checkbox"
                        checked={!!g[item.key as keyof Grant]}
                        disabled={
                          item.key === "include_descendants" &&
                          !["department", "reports"].includes(g.principal_type)
                        }
                        onChange={(e) =>
                          update(i, { [item.key]: e.target.checked })
                        }
                      />
                      {item.text}
                    </label>
                  ))}
                </div>
              </div>
            ))}
          </div>
          <button
            className="button"
            type="button"
            onClick={() =>
              setGrants((v) => [
                ...v,
                {
                  principal_type: "tenant",
                  principal_id: tenantId,
                  can_view: true,
                  can_create: false,
                  can_manage: false,
                  include_descendants: false,
                  effect: "allow",
                },
              ])
            }
          >
            <Plus size={15} />
            添加授权规则
          </button>
          <div className="form-actions">
            <button className="button" type="button" onClick={onClose}>
              取消
            </button>
            <Submit busy={busy}>保存权限</Submit>
          </div>
        </form>
      )}
    </Modal>
  );
}
