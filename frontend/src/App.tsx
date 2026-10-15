import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  Activity,
  ArrowRight,
  BookOpen,
  Bot,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  Command,
  Database,
  FileText,
  FolderOpen,
  LayoutDashboard,
  LogOut,
  Menu,
  Plus,
  Search,
  Settings2,
  ShieldCheck,
  Sparkles,
  Upload,
  Users,
  X,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { api, post, date } from "./api";
import type { Document, Space, Stats, User } from "./types";
import { Empty, FileIcon, Modal, Status } from "./components";
import { AccountMenu, PersonalCenter } from "./AccountMenu";
import { ProductName } from "./ProductName";
import { ProductLogo } from "./ProductLogo";
import { StartupScreen } from "./StartupScreen";
import "./styles.css";
import "./login.css";
import { DaylightBackground } from "./DaylightBackground";
import { BloubAvatar } from "./BloubAvatar";
import { readHomepageDraft } from "./homepageDraft";
import { DesktopConnection } from "./DesktopConnection";
import { SidebarHandle, useSidebar } from "./SidebarHandle";
const StudioPage = lazy(() =>
  import("./StudioPage").then((module) => ({ default: module.StudioPage })),
);
const BotPage = lazy(() =>
  import("./BotPage").then((module) => ({ default: module.BotPage })),
);
const PersonalMemoryCenter = lazy(() =>
  import("./BotMemory").then((module) => ({
    default: module.PersonalMemoryCenter,
  })),
);
const SettingsPage = lazy(() =>
  import("./SettingsPage").then((module) => ({ default: module.SettingsPage })),
);
import {
  DocumentDialog,
  GrantDialog,
  NewDocumentDialog,
  SpaceDialog,
  UploadDialog,
} from "./dialogs";
import {
  ChatPage,
  DocumentsPage,
  IntegrationPage,
  OrganizationPage,
  RecordsPage,
  SystemPage,
} from "./pages";

type Page =
  | "home"
  | "spaces"
  | "chat"
  | "studio"
  | "bot"
  | "documents"
  | "organization"
  | "integration"
  | "jobs"
  | "audit"
  | "system"
  | "settings";
const navigation: {
  id: Page;
  title: string;
  icon: LucideIcon;
  admin?: boolean;
}[] = [
  { id: "home", title: "工作台", icon: LayoutDashboard },
  { id: "spaces", title: "知识空间", icon: FolderOpen },
  { id: "chat", title: "智能问答", icon: Sparkles },
  { id: "studio", title: "创作台", icon: Bot },
  { id: "bot", title: "知小汇 bot", icon: Bot },
  { id: "documents", title: "文档管理", icon: FileText },
  { id: "organization", title: "成员与组织", icon: Users, admin: true },
  { id: "integration", title: "Agent 接入", icon: Bot },
  { id: "jobs", title: "索引任务", icon: Activity, admin: true },
  { id: "audit", title: "审计日志", icon: ShieldCheck, admin: true },
  { id: "system", title: "系统状态", icon: Activity, admin: true },
  { id: "settings", title: "设置", icon: Settings2, admin: true },
];
export type Feedback = (message: string, error?: boolean) => void;
export type Confirm = (title: string, action: () => Promise<void>) => void;
export default function App() {
  const [identity, setIdentity] = useState<{
    user: User;
    tenant: { id: string; name: string; slug: string };
  } | null>();
  const [page, setPage] = useState<Page>(() => {
    const view = new URLSearchParams(window.location.search).get("view");
    return view === "chat" || view === "studio" || view === "bot"
      ? view
      : "home";
  });
  const [settingsSection, setSettingsSection] = useState<"rag" | "studio">(
    "rag",
  );
  const [selectedSpace, setSelectedSpace] = useState("");
  const [spaces, setSpaces] = useState<Space[]>([]);
  const [stats, setStats] = useState<Stats>();
  const [documents, setDocuments] = useState<Document[]>([]);
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [toast, setToast] = useState<{ text: string; error: boolean }>();
  const [modal, setModal] = useState<"upload" | "document" | "space" | null>(
    null,
  );
  const [documentId, setDocumentId] = useState<string>();
  const [grantSpace, setGrantSpace] = useState<Space>();
  const [confirmation, setConfirmation] = useState<{
    title: string;
    action: () => Promise<void>;
  }>();
  const [confirmBusy, setConfirmBusy] = useState(false);
  const [mobile, setMobile] = useState(false);
  const sidebar = useSidebar(mobile, setMobile);
  const [revision, setRevision] = useState(0);
  const [profileOpen, setProfileOpen] = useState(false);
  const [memoryOpen, setMemoryOpen] = useState(false);
  const [experienceRevision, setExperienceRevision] = useState(0);
  const [botTaskRequest, setBotTaskRequest] = useState<{
    id: string;
    revision: number;
  }>();
  useEffect(() => {
    setProfileOpen(false);
    setMemoryOpen(false);
    setBotTaskRequest(undefined);
    setExperienceRevision(0);
  }, [identity?.user.id, identity?.user.tenant_id]);
  const [logoutBusy, setLogoutBusy] = useState(false);
  const accountTrigger = useRef<HTMLButtonElement>(null);
  const closeProfile = () => {
    setProfileOpen(false);
    requestAnimationFrame(() => accountTrigger.current?.focus());
  };
  const feedback: Feedback = useCallback(
    (text, error = false) => setToast({ text, error }),
    [],
  );
  const refresh = useCallback(async () => {
    try {
      const [s, st, d] = await Promise.all([
        api<Space[]>("/api/spaces"),
        api<Stats>("/api/stats"),
        api<{ items: Document[] }>("/api/documents?limit=5"),
      ]);
      setSpaces(s);
      setStats(st);
      setDocuments(d.items);
      setRevision((v) => v + 1);
    } catch (e) {
      feedback((e as Error).message, true);
    }
  }, [feedback]);
  useEffect(() => {
    api<typeof identity>("/api/auth/me")
      .then(setIdentity)
      .catch(() => setIdentity(null));
    const out = () => {
      setIdentity(null);
      window.history.replaceState(null, "", `/login${window.location.search}`);
    };
    window.addEventListener("atlas:unauthorized", out);
    return () => window.removeEventListener("atlas:unauthorized", out);
  }, []);
  useEffect(() => {
    if (identity) {
      if (window.location.pathname !== "/app") {
        window.history.replaceState(null, "", `/app${window.location.search}`);
      }
      void refresh();
    }
  }, [identity, refresh]);
  useEffect(() => {
    document.title = identity ? "知汇 · 企业知识库" : "知汇 · 登录工作空间";
  }, [identity]);
  useEffect(() => {
    if (!toast) return;
    const timeout = window.setTimeout(() => setToast(undefined), 5000);
    return () => window.clearTimeout(timeout);
  }, [toast]);
  useEffect(() => {
    if (!identity || !stats?.counts.pending) return;
    const interval = window.setInterval(() => void refresh(), 5000);
    return () => window.clearInterval(interval);
  }, [identity, stats?.counts.pending, refresh]);
  const navigate = (next: Page, space = "") => {
    setBotTaskRequest(undefined);
    setPage(next);
    setSelectedSpace(space);
    setMobile(false);
    const query =
      next === "chat" || next === "studio" || next === "bot"
        ? `?view=${next}`
        : "";
    window.history.replaceState(null, "", `/app${query}`);
  };
  const confirm: Confirm = (title, action) =>
    setConfirmation({ title, action });
  const finish = () => {
    setModal(null);
    void refresh();
  };
  const logout = async () => {
    if (logoutBusy) return;
    setLogoutBusy(true);
    try {
      await post("/api/auth/logout", {});
      setIdentity(null);
      window.history.replaceState(null, "", "/login");
      setProfileOpen(false);
      setPage("home");
      setSelectedSpace("");
      setSearch("");
      setQuery("");
      setSpaces([]);
      setDocuments([]);
      setStats(undefined);
      setModal(null);
      setDocumentId(undefined);
      setGrantSpace(undefined);
      setConfirmation(undefined);
      setMobile(false);
      setToast(undefined);
    } catch (error) {
      feedback((error as Error).message, true);
    } finally {
      setLogoutBusy(false);
    }
  };
  if (identity === undefined) return <StartupScreen />;
  if (identity === null)
    return (
      <>
        <Login
          onLogin={async () => {
            setIdentity(await api("/api/auth/me"));
          }}
          feedback={feedback}
        />
        {toast && (
          <div className={`toast ${toast.error ? "error" : ""}`} role="alert">
            {toast.text}
          </div>
        )}
      </>
    );
  const { user, tenant } = identity;
  const connectionRequest = new URLSearchParams(window.location.search).get(
    "connect",
  );
  if (connectionRequest)
    return <DesktopConnection requestId={connectionRequest} user={user} />;
  const isAdmin = user.role === "admin";
  const active = navigation.find((v) => v.id === page)!;
  const openDocument = (id: string) => setDocumentId(id);
  return (
    <div className={sidebar.className} ref={sidebar.shell}>
      {(mobile || (!sidebar.desktop && sidebar.dragging)) && (
        <button
          className="sidebar-scrim"
          aria-label="关闭导航"
          onClick={() => setMobile(false)}
        />
      )}
      <aside
        id="system-sidebar"
        aria-label="系统导航"
        ref={sidebar.panel}
        aria-hidden={!sidebar.open}
        inert={!sidebar.open}
        className={`sidebar ${mobile ? "mobile-open" : ""}`}
      >
        <a
          className="brand"
          href="#"
          onClick={(e) => {
            e.preventDefault();
            navigate("home");
          }}
        >
          <div className="brand-mark">
            <ProductLogo />
          </div>
          <span>
            <ProductName />
          </span>
        </a>
        <div className="tenant-switch">
          <div className="tenant-avatar">知</div>
          <div>
            <strong>{tenant.name}</strong>
            <span>企业工作空间</span>
          </div>
          <ChevronDown size={14} />
        </div>
        <div className="nav-label">工作空间</div>
        <nav>
          {navigation.slice(0, 6).map((item) => (
            <button
              key={item.id}
              aria-label={item.title}
              className={page === item.id ? "nav-item active" : "nav-item"}
              onClick={() => navigate(item.id)}
            >
              <item.icon size={19} />
              <span>{item.title}</span>
              {item.id === "chat" && <span className="tiny-pill">AI</span>}
            </button>
          ))}
        </nav>
        <div className="nav-label with-action">
          我的知识空间
          {isAdmin && (
            <button
              className="icon-button"
              title="创建空间"
              onClick={() => setModal("space")}
            >
              <Plus size={15} />
            </button>
          )}
        </div>
        <nav className="space-nav">
          {spaces.map((space) => (
            <button
              className={`nav-item ${selectedSpace === space.id && page === "documents" ? "selected" : ""}`}
              onClick={() => navigate("documents", space.id)}
              key={space.id}
            >
              <span className={`space-dot ${space.color}`} />
              <span>{space.name}</span>
              <small>{space.document_count}</small>
            </button>
          ))}
        </nav>
        <div className="nav-label">管理与连接</div>
        <nav>
          {navigation
            .slice(6)
            .filter((item) => !item.admin || isAdmin)
            .map((item) => (
              <button
                key={item.id}
                aria-label={item.title}
                className={page === item.id ? "nav-item active" : "nav-item"}
                onClick={() => navigate(item.id)}
              >
                <item.icon size={18} />
                <span>{item.title}</span>
                {item.id === "jobs" && !!stats?.counts.pending && (
                  <span className="nav-count">{stats.counts.pending}</span>
                )}
              </button>
            ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="trust-badge">
            <ShieldCheck size={16} />
            <span>企业数据 · 权限保护</span>
          </div>
          <div className="user-card">
            <div className="avatar">{user.name.slice(-2)}</div>
            <div>
              <strong>{user.name}</strong>
              <small>{isAdmin ? "企业管理员" : "企业成员"}</small>
            </div>
            <button
              className="icon-button"
              title="退出登录"
              disabled={logoutBusy}
              onClick={() => confirm("确定退出当前账号？", logout)}
            >
              <LogOut size={17} />
            </button>
          </div>
        </div>
      </aside>
      <SidebarHandle {...sidebar.handle} />
      <div className="main-column">
        <header className="topbar">
          <div className="breadcrumb">
            <button
              className="icon-button mobile-menu"
              onClick={() => setMobile(true)}
              aria-label="打开导航"
            >
              <Menu size={20} />
            </button>
            <span>工作空间</span>
            <ChevronRight size={14} />
            <strong>{active.title}</strong>
            {selectedSpace && (
              <>
                <ChevronRight size={14} />
                <strong>
                  {spaces.find((s) => s.id === selectedSpace)?.name}
                </strong>
              </>
            )}
          </div>
          <form
            className="global-search"
            onSubmit={(e) => {
              e.preventDefault();
              setQuery(search);
              navigate("documents");
            }}
          >
            <Search size={16} />
            <input
              aria-label="搜索文档标题"
              placeholder="搜索知识库中的文档"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <Command size={13} />
          </form>
          <button
            className="icon-button"
            title="查看使用说明"
            onClick={() => navigate("system")}
          >
            <CircleHelp size={19} />
          </button>
          <AccountMenu
            trigger={accountTrigger}
            user={user}
            tenantName={tenant.name}
            busy={logoutBusy}
            onProfile={() => setProfileOpen(true)}
            onLogout={logout}
          />
        </header>
        <main
          className={`workspace ${page === "chat" || page === "studio" ? "chat-workspace" : ""} ${page === "bot" ? "bot-workspace" : ""}`}
        >
          {page === "home" && (
            <>
              <div className="page-heading">
                <div>
                  <div className="eyebrow">YOUR KNOWLEDGE, CONNECTED</div>
                  <h1>
                    {user.name}，欢迎回来 <span className="wave">✦</span>
                  </h1>
                  <p>让每一份经验成为团队下一次进步的起点。</p>
                </div>
                <button
                  className="button primary"
                  onClick={() => setModal("upload")}
                  disabled={!spaces.some((s) => s.permissions.can_create)}
                >
                  <Upload size={16} />
                  上传文档
                </button>
              </div>
              <section className="hero-card">
                <div>
                  <span className="hero-kicker">
                    <Sparkles size={15} />
                    企业知识助手
                  </span>
                  <h2>答案，就在团队的知识里。</h2>
                  <p>从文档到图表，连接散落的知识，找到有据可依的答案。</p>
                  <button
                    className="button hero-button"
                    onClick={() => navigate("chat")}
                  >
                    向知识库提问 <ArrowRight size={16} />
                  </button>
                </div>
                <div className="knowledge-art" aria-hidden="true">
                  <div className="orbit orbit-one" />
                  <div className="orbit orbit-two" />
                  <div className="art-node node-one">
                    <FileText />
                  </div>
                  <div className="art-node node-two">
                    <Database />
                  </div>
                  <div className="art-node node-three">
                    <Users />
                  </div>
                  <div className="art-center">
                    <ProductLogo decorative />
                  </div>
                  <div className="art-label">Connected knowledge</div>
                </div>
              </section>
              <div className="metrics">
                {[
                  {
                    label: "知识文档",
                    value: stats?.counts.documents,
                    icon: FileText,
                    note: "团队经验持续沉淀",
                  },
                  {
                    label: "知识空间",
                    value: stats?.spaces,
                    icon: FolderOpen,
                    note: "按业务组织与协作",
                  },
                  {
                    label: "检索片段",
                    value: stats?.counts.chunks,
                    icon: Database,
                    note: stats?.capabilities.semantic
                      ? "关键词 + 向量混合检索"
                      : "关键词检索已就绪",
                  },
                  {
                    label: "图像片段",
                    value: stats?.counts.images,
                    icon: Sparkles,
                    note: stats?.capabilities.vision
                      ? "视觉理解已启用"
                      : "配置视觉模型后启用",
                  },
                ].map((item) => (
                  <div className="metric-card" key={item.label}>
                    <div className="metric-top">
                      <span>{item.label}</span>
                      <item.icon size={18} />
                    </div>
                    <strong>{item.value ?? "—"}</strong>
                    <small>{item.note}</small>
                  </div>
                ))}
              </div>
              <div className="dashboard-columns">
                <div className="dashboard-main">
                  <div className="section-heading">
                    <h2>
                      团队知识空间 <span>{spaces.length}</span>
                    </h2>
                    <button
                      className="text-button"
                      onClick={() => navigate("spaces")}
                    >
                      查看全部 <ArrowRight size={14} />
                    </button>
                  </div>
                  <div className="space-grid">
                    {spaces.map((space) => (
                      <SpaceCard
                        key={space.id}
                        space={space}
                        onOpen={() => navigate("documents", space.id)}
                        onManage={
                          space.permissions.can_manage
                            ? () => setGrantSpace(space)
                            : undefined
                        }
                      />
                    ))}
                  </div>
                  {!spaces.length && (
                    <Empty
                      title="暂时没有可访问的空间"
                      text="请联系管理员分配权限"
                    />
                  )}
                  <div className="section-heading">
                    <h2>最近更新</h2>
                    <button
                      className="text-button"
                      onClick={() => navigate("documents")}
                    >
                      全部文档 <ArrowRight size={14} />
                    </button>
                  </div>
                  <div className="panel recent-docs">
                    {documents.map((doc) => (
                      <button
                        className="recent-row"
                        key={doc.id}
                        onClick={() => openDocument(doc.id)}
                      >
                        <FileIcon mime={doc.mime_type} />
                        <div>
                          <strong>{doc.title}</strong>
                          <small>
                            {doc.space_name} · {doc.author}
                          </small>
                        </div>
                        <Status value={doc.status} />
                        <span className="date">{date(doc.updated_at)}</span>
                        <ChevronRight size={16} />
                      </button>
                    ))}
                    {!documents.length && (
                      <Empty
                        title="从第一份文档开始"
                        text="上传资料，让团队知识可以被发现"
                      />
                    )}
                  </div>
                </div>
                <aside className="dashboard-aside">
                  <div className="panel quick-panel">
                    <h3>快速开始</h3>
                    {[
                      {
                        icon: Upload,
                        title: "上传已有资料",
                        text: "支持文档、表格与图片",
                        action: () => setModal("upload"),
                      },
                      {
                        icon: Plus,
                        title: "创建知识文档",
                        text: "把新的经验记录下来",
                        action: () => setModal("document"),
                      },
                      {
                        icon: Bot,
                        title: "连接你的 AI Agent",
                        text: "通过 MCP 与 API 访问知识",
                        action: () => navigate("integration"),
                      },
                    ].map((item) => (
                      <button
                        key={item.title}
                        className="quick-action"
                        onClick={item.action}
                      >
                        <div>
                          <item.icon size={18} />
                        </div>
                        <span>
                          <strong>{item.title}</strong>
                          <small>{item.text}</small>
                        </span>
                        <ChevronRight size={15} />
                      </button>
                    ))}
                  </div>
                  <div className="tip-card">
                    <div>
                      <ShieldCheck size={21} />
                      <h3>让知识在正确的范围流动</h3>
                    </div>
                    <p>
                      按部门、上下级或具体成员设置查看与创建权限。每次检索都会校验当前授权。
                    </p>
                    {isAdmin && (
                      <button
                        className="text-button"
                        onClick={() => navigate("organization")}
                      >
                        管理组织成员 <ArrowRight size={14} />
                      </button>
                    )}
                  </div>
                  <div className="system-mini">
                    <span className="live-dot" />
                    检索服务可用 <small>{stats?.capabilities.database}</small>
                  </div>
                </aside>
              </div>
            </>
          )}
          {page === "spaces" && (
            <>
              <div className="page-heading">
                <div>
                  <h1>知识空间</h1>
                  <p>按团队与业务组织知识，让协作更有秩序。</p>
                </div>
                {isAdmin && (
                  <button
                    className="button primary"
                    onClick={() => setModal("space")}
                  >
                    <Plus size={16} />
                    创建空间
                  </button>
                )}
              </div>
              <div className="space-grid all-spaces">
                {spaces.map((space) => (
                  <SpaceCard
                    key={space.id}
                    space={space}
                    onOpen={() => navigate("documents", space.id)}
                    onManage={
                      space.permissions.can_manage
                        ? () => setGrantSpace(space)
                        : undefined
                    }
                  />
                ))}
              </div>
              {!spaces.length && <Empty title="尚未分配知识空间" />}
            </>
          )}
          {page === "documents" && (
            <DocumentsPage
              onDeleted={refresh}
              confirm={confirm}
              key={selectedSpace}
              user={user}
              spaces={spaces}
              selectedSpace={selectedSpace}
              query={query}
              revision={revision}
              onQuery={setQuery}
              onDocument={openDocument}
              onUpload={() => setModal("upload")}
              onCreate={() => setModal("document")}
              feedback={feedback}
            />
          )}
          {page === "chat" && (
            <ChatPage
              spaces={spaces}
              stats={stats}
              onDocument={openDocument}
              feedback={feedback}
            />
          )}
          {page === "studio" && (
            <Suspense
              fallback={<div className="loading-panel">正在加载创作台…</div>}
            >
              <StudioPage
                user={user}
                feedback={feedback}
                onDocument={openDocument}
                onConfigureAgent={() => {
                  setSettingsSection("rag");
                  navigate("settings");
                }}
                onConfigureModels={() => {
                  setSettingsSection("studio");
                  navigate("settings");
                }}
              />
            </Suspense>
          )}
          {page === "bot" && (
            <Suspense
              fallback={
                <div className="loading-panel">正在加载知小汇 bot…</div>
              }
            >
              <BotPage
                user={user}
                feedback={feedback}
                confirm={confirm}
                taskRequest={botTaskRequest}
                experienceRevision={experienceRevision}
                onDocument={openDocument}
                onUpload={() => setModal("upload")}
                onConfigure={() => {
                  setSettingsSection("rag");
                  navigate("settings");
                }}
              />
            </Suspense>
          )}
          {page === "organization" && isAdmin && (
            <OrganizationPage feedback={feedback} confirm={confirm} />
          )}
          {page === "integration" && (
            <IntegrationPage
              stats={stats}
              feedback={feedback}
              confirm={confirm}
            />
          )}
          {(page === "jobs" || page === "audit") && isAdmin && (
            <RecordsPage
              kind={page}
              revision={revision}
              feedback={feedback}
              onDocument={openDocument}
            />
          )}
          {page === "system" && (
            <SystemPage
              stats={stats}
              isAdmin={isAdmin}
              onConfigureModels={() => {
                setSettingsSection("rag");
                navigate("settings");
              }}
            />
          )}
          {page === "settings" && isAdmin && (
            <Suspense fallback={<p role="status">正在加载设置…</p>}>
              <SettingsPage
                initialSection={settingsSection}
                feedback={feedback}
                onSaved={refresh}
              />
            </Suspense>
          )}
        </main>
        <footer className="app-footer">
          <span>
            <ProductName /> · 让知识创造价值
          </span>
          <span>
            企业知识库 <span className="footer-dot">·</span> v0.1.0
          </span>
        </footer>
      </div>
      {toast && (
        <div className={`toast ${toast.error ? "error" : ""}`} role="alert">
          {toast.text}
          <button onClick={() => setToast(undefined)} aria-label="关闭提示">
            <X size={15} />
          </button>
        </div>
      )}
      {profileOpen && (
        <PersonalCenter
          user={user}
          tenantName={tenant.name}
          onSaved={refresh}
          onClose={closeProfile}
          onMemory={() => {
            setProfileOpen(false);
            setMemoryOpen(true);
          }}
        />
      )}
      {memoryOpen && (
        <Suspense
          fallback={
            <Modal
              title="记忆与经验"
              onClose={() => {
                setMemoryOpen(false);
                setProfileOpen(true);
              }}
            >
              <div className="loading-panel">正在加载记忆与经验…</div>
            </Modal>
          }
        >
          <PersonalMemoryCenter
            onClose={() => {
              setMemoryOpen(false);
              setProfileOpen(true);
            }}
            onTask={(id) => {
              setMemoryOpen(false);
              navigate("bot");
              setBotTaskRequest({ id, revision: Date.now() });
            }}
            onDocument={(id) => {
              setMemoryOpen(false);
              openDocument(id);
            }}
            onChanged={() => setExperienceRevision((value) => value + 1)}
            feedback={feedback}
            confirm={confirm}
          />
        </Suspense>
      )}
      {modal === "upload" && (
        <UploadDialog
          spaces={spaces}
          preferred={selectedSpace}
          onClose={() => setModal(null)}
          onSuccess={finish}
          feedback={feedback}
        />
      )}
      {modal === "document" && (
        <NewDocumentDialog
          spaces={spaces}
          preferred={selectedSpace}
          onClose={() => setModal(null)}
          onSuccess={finish}
          feedback={feedback}
        />
      )}
      {modal === "space" && (
        <SpaceDialog
          onClose={() => setModal(null)}
          onSuccess={finish}
          feedback={feedback}
        />
      )}
      {documentId && (
        <DocumentDialog
          id={documentId}
          user={user}
          spaces={spaces}
          onClose={() => setDocumentId(undefined)}
          onSuccess={() => void refresh()}
          feedback={feedback}
          confirm={confirm}
        />
      )}
      {grantSpace && (
        <GrantDialog
          space={grantSpace}
          tenantId={tenant.id}
          onClose={() => setGrantSpace(undefined)}
          onSuccess={() => {
            setGrantSpace(undefined);
            void refresh();
          }}
          feedback={feedback}
        />
      )}
      {confirmation && (
        <Modal
          title="请确认"
          onClose={() => {
            if (!confirmBusy) setConfirmation(undefined);
          }}
        >
          <p className="confirm-text">{confirmation.title}</p>
          <div className="form-actions">
            <button
              className="button"
              disabled={confirmBusy}
              onClick={() => setConfirmation(undefined)}
            >
              取消
            </button>
            <button
              className="button danger"
              disabled={confirmBusy}
              onClick={async () => {
                setConfirmBusy(true);
                try {
                  await confirmation.action();
                  setConfirmation(undefined);
                } catch (e) {
                  feedback((e as Error).message, true);
                } finally {
                  setConfirmBusy(false);
                }
              }}
            >
              {confirmBusy ? "处理中…" : "确定"}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
function SpaceCard({
  space,
  onOpen,
  onManage,
}: {
  space: Space;
  onOpen: () => void;
  onManage?: () => void;
}) {
  return (
    <article className="space-card">
      <div className="space-card-top">
        <button
          className={`space-icon ${space.color}`}
          onClick={onOpen}
          aria-label={`打开${space.name}`}
        >
          <FolderOpen size={22} />
        </button>
        <span className="space-access">
          <ShieldCheck size={11} />
          {space.permissions.can_manage
            ? "可管理"
            : space.permissions.can_create
              ? "可创建"
              : "仅查看"}
        </span>
      </div>
      <button className="space-title" onClick={onOpen}>
        <h3>{space.name}</h3>
      </button>
      <p>{space.description || "团队共享的知识与经验"}</p>
      <div className="space-card-bottom">
        <span>
          <FileText size={13} />
          {space.document_count} 份文档
        </span>
        {onManage ? (
          <button className="text-button" onClick={onManage}>
            权限设置 <ChevronRight size={13} />
          </button>
        ) : (
          <button className="text-button" onClick={onOpen}>
            进入空间 <ChevronRight size={13} />
          </button>
        )}
      </div>
    </article>
  );
}
function Login({
  onLogin,
  feedback,
}: {
  onLogin: () => Promise<void>;
  feedback: Feedback;
}) {
  const [tenant, setTenant] = useState("Yemast");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [config, setConfig] = useState<{ demo: boolean; sso: boolean }>();
  useEffect(() => {
    api<{ demo: boolean; sso: boolean }>("/api/public-config")
      .then(setConfig)
      .catch(() => {});
  }, []);
  return (
    <div className="login-page daylight-login">
      <DaylightBackground />
      <header className="daylight-login-header">
        <a className="brand" href="/" aria-label="知汇首页">
          <ProductLogo />
          <ProductName />
        </a>
        <a className="login-home-link" href="/">
          <ArrowRight size={14} aria-hidden="true" />
          返回官网
        </a>
      </header>
      <div className="daylight-login-welcome">
        <BloubAvatar size={100} decorative mood="idle" />
        <span>你的 AI 工作搭档，随时待命</span>
        <h1>
          欢迎回到
          <ProductName />。
        </h1>
        <p>
          知小汇已经准备好，
          <br />
          和你一起，把想法变成完成的工作。
        </p>
      </div>
      <div className="login-side">
        <form
          className="login-form"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            try {
              await post("/api/auth/login", { tenant, email, password });
              await onLogin();
            } catch (e) {
              feedback((e as Error).message, true);
            } finally {
              setBusy(false);
            }
          }}
        >
          <h2>登录企业工作空间</h2>
          <p>
            {readHomepageDraft()
              ? "你的任务已保留，登录后继续交给知小汇。"
              : "登录后，继续与知小汇协作。"}
          </p>
          <label>
            企业标识
            <input
              required
              value={tenant}
              onChange={(e) => setTenant(e.target.value)}
              placeholder="Yemast"
              autoComplete="organization"
            />
          </label>
          <label>
            企业邮箱
            <input
              required
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="admin@yemast.com"
              autoComplete="username"
            />
          </label>
          <label>
            密码
            <input
              required
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="输入你的账号密码"
              autoComplete="current-password"
            />
          </label>
          <button className="button primary login-submit" disabled={busy}>
            {busy ? "正在登录…" : "登录工作空间"}
            <ArrowRight size={17} />
          </button>
          {config?.sso && (
            <a className="button sso-button" href="/api/auth/oidc/login">
              使用企业 SSO 登录
            </a>
          )}
          {config?.demo && (
            <div className="demo-login">
              <span>本地示例环境</span>
              <div>
                <button
                  type="button"
                  onClick={() => {
                    setTenant("atlas");
                    setEmail("admin@atlas.local");
                    setPassword("AtlasDemo123!");
                  }}
                >
                  填入管理员账号
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setTenant("atlas");
                    setEmail("wang@atlas.local");
                    setPassword("AtlasDemo123!");
                  }}
                >
                  填入产品成员账号
                </button>
              </div>
            </div>
          )}
          <small className="login-note">
            <ShieldCheck size={13} />
            安全会话 · 企业数据隔离
          </small>
        </form>
      </div>
    </div>
  );
}
