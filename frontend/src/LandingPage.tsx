import { useEffect, useRef, useState } from "react";
import { LandingBotDemo } from "./LandingBotDemo";
import { ProductName } from "./ProductName";
import logo from "./assets/product-logo.png";
import chatScreenshot from "./assets/landing/chat.png";
import studioScreenshot from "./assets/landing/studio.png";
import heroVideo from "./assets/landing/hero-background.webm";
import heroVideoFallback from "./assets/landing/hero-background.mp4";
import heroPoster from "./assets/landing/hero-poster.jpg";
import "./landing.css";

export default function LandingPage() {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuButton = useRef<HTMLButtonElement>(null);
  const backgroundVideo = useRef<HTMLVideoElement>(null);
  const [reduceMotion, setReduceMotion] = useState(
    () => window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );

  useEffect(() => {
    const preference = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduceMotion(preference.matches);
    preference.addEventListener("change", update);
    return () => preference.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    const video = backgroundVideo.current;
    if (!video) return;
    video.load();
    if (!reduceMotion) void video.play().catch(() => {});
  }, [reduceMotion]);

  useEffect(() => {
    if (!menuOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setMenuOpen(false);
        menuButton.current?.focus();
      }
    };
    const closeOnResize = () => {
      if (window.innerWidth > 760) setMenuOpen(false);
    };
    window.addEventListener("keydown", closeOnEscape);
    window.addEventListener("resize", closeOnResize);
    return () => {
      window.removeEventListener("keydown", closeOnEscape);
      window.removeEventListener("resize", closeOnResize);
    };
  }, [menuOpen]);

  return (
    <div className="atlas-landing">
      <a className="skip-link" href="#main-content">
        跳转到主要内容
      </a>
      <header className="header">
        <a className="brand" href="#top" aria-label="知汇首页">
          <img src={logo} alt="" />
          <ProductName />
        </a>
        <nav
          className={`nav${menuOpen ? " open" : ""}`}
          onClick={() => setMenuOpen(false)}
          id="navigation"
          aria-label="主导航"
        >
          <a href="#bot">知小汇 bot</a>
          <a href="#knowledge">知识空间</a>
          <a href="#answers">智能问答</a>
          <a href="#studio">创作台</a>
          <a href="#enterprise">企业能力</a>
        </nav>
        <div className="header-right">
          <a href="/login">登录</a>
          <a className="pill" href="/app">
            进入平台 <span aria-hidden="true">↗</span>
          </a>
          <button
            className="menu-toggle"
            ref={menuButton}
            onClick={() => setMenuOpen(!menuOpen)}
            aria-label={menuOpen ? "关闭导航菜单" : "打开导航菜单"}
            aria-expanded={menuOpen}
            aria-controls="navigation"
          >
            <svg
              width="22"
              height="22"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              aria-hidden="true"
            >
              <path d="M4 7h16M4 12h16M4 17h16" />
            </svg>
          </button>
        </div>
      </header>
      <main id="main-content" tabIndex={-1}>
        <section className="hero" id="top">
          <video
            className="hero-background"
            ref={backgroundVideo}
            autoPlay={!reduceMotion}
            muted
            loop
            playsInline
            preload={reduceMotion ? "none" : "auto"}
            poster={heroPoster}
            aria-hidden="true"
          >
            {!reduceMotion && (
              <>
                <source src={heroVideo} type="video/webm" />
                <source src={heroVideoFallback} type="video/mp4" />
              </>
            )}
          </video>
          <div className="hero-inner">
            <div className="hero-copy">
              <div className="eyebrow">
                <span className="dot" aria-hidden="true"></span>
                认识你的 AI 工作搭档
              </div>
              <h1 className="hero-title" aria-label="这里是知汇">
                {Array.from("这里是知汇").map((character, index) => (
                  <span
                    className={`hero-letter${index >= 3 ? " product-name" : ""}`}
                    style={{ animationDelay: `${200 + index * 160}ms` }}
                    aria-hidden="true"
                    key={index}
                  >
                    {character}
                  </span>
                ))}
              </h1>
              <p className="hero-sub">知小汇 bot，把想法变成完成的工作</p>
              <div className="hero-actions">
                <a className="pill" href="/app?view=bot">
                  和知小汇协作{" "}
                  <span className="enter-arrow" aria-hidden="true">
                    ↗
                  </span>
                </a>
                <a className="pill secondary" href="#bot-demo">
                  <span>试试知小汇</span>
                  <span aria-hidden="true">↓</span>
                </a>
              </div>
            </div>
            <LandingBotDemo reduceMotion={reduceMotion} />
            <p className="hero-note">
              研究课题 · 整理纪要 · 分析报表 · 交付成果
            </p>
          </div>
        </section>
        <section className="intro" id="bot">
          <div className="section-kicker">MEET YOUR AI WORK COMPANION</div>
          <p>
            不止回答问题，
            <br />
            更和你一起，把事情<strong>做完</strong>。<br />
            知小汇 bot，让想法有下一步。
          </p>
          <div className="wrap feature-points bot-feature-points">
            <div>
              <h3>一句话，开始协作</h3>
              <p>
                交办研究、会议纪要、数据分析与文档任务。选择资料和技能，围绕同一个任务继续对话。
              </p>
            </div>
            <div>
              <h3>过程看得见，成果带得走</h3>
              <p>查看步骤与工具记录，跟进后台进度，在工作区预览和下载成果。</p>
            </div>
            <div>
              <h3>连接知识，也连接工具</h3>
              <p>
                结合授权知识与已配置的应用连接器。涉及外部写入时，查看准确请求并确认执行。
              </p>
            </div>
          </div>
        </section>
        <section className="feature" id="knowledge">
          <div className="feature-head">
            <span className="tag">知识空间</span>
            <h2>重要的知识，始终有处可寻</h2>
            <p>
              从制度流程到项目资料，从个人积累到团队经验。
              <br />
              在一个有序的空间里，让知识持续沉淀。
            </p>
          </div>
          <div className="wrap">
            <div className="workspace-visual">
              <div className="workspace-text">
                <h3>
                  散落在文件里的经验，
                  <br />
                  回到团队的日常里。
                </h3>
                <p>
                  上传文档、表格和图片，按业务组织知识空间。保留版本与来源，让每一次更新都有迹可循。
                </p>
                <div className="file-tags">
                  <span>PDF</span>
                  <span>Word</span>
                  <span>Excel</span>
                  <span>图片</span>
                  <span>Markdown</span>
                </div>
              </div>
              <div className="document-stack" aria-label="知识文档类型示例">
                <div className="document">
                  团队协作与工作指南 <span>全员知识</span>
                </div>
                <div className="document">
                  产品需求与技术方案 <span>产品与研发</span>
                </div>
                <div className="document">
                  业务报表与项目记录 <span>部门空间</span>
                </div>
              </div>
            </div>
            <div className="feature-points">
              <div>
                <h3>按业务组织</h3>
                <p>全员、部门与个人空间，让团队找到自己的知识入口。</p>
              </div>
              <div>
                <h3>持续积累与更新</h3>
                <p>上传或直接创建文档，保存版本，支持重新索引。</p>
              </div>
              <div>
                <h3>分享有边界</h3>
                <p>分别控制查看、创建和管理权限，适应组织协作方式。</p>
              </div>
            </div>
          </div>
        </section>
        <section className="feature" id="answers">
          <div className="feature-head">
            <span className="tag">智能问答</span>
            <h2>从「找文档」，到「有答案」</h2>
            <p>
              用自然语言向知识库提问。结合授权范围内的资料，
              <br />
              找到有来源的回答，把判断建立在证据之上。
            </p>
          </div>
          <div className="wrap">
            <div className="screenshot-frame">
              <img
                src={chatScreenshot}
                alt="知汇智能问答实际界面，展示知识助手与提问入口"
                loading="lazy"
                width="1440"
                height="1000"
              />
            </div>
            <p className="image-caption">
              产品实际界面 · 演示环境；回答基于授权知识，支持查看原文与来源。
              <a
                className="text-link"
                href="/app?view=chat"
                aria-label="进入平台向知识库提问"
              >
                进入智能问答 ↗
              </a>
            </p>
            <div className="feature-points">
              <div>
                <h3>看得见依据</h3>
                <p>引用文档、页码与版本，回到原始资料核对答案。</p>
              </div>
              <div>
                <h3>读懂文字与图表</h3>
                <p>配置视觉模型后，解析图片、扫描 PDF 和文档图表。</p>
              </div>
              <div>
                <h3>围绕问题继续探索</h3>
                <p>支持多轮对话与工具调用记录，逐步补齐需要的信息。</p>
              </div>
            </div>
          </div>
        </section>
        <section className="studio-section" id="studio">
          <div className="wrap studio-layout">
            <div>
              <span className="tag">创作台</span>
              <h2>让想法，成为作品。</h2>
              <p>
                用对话描述你的创意，让 Agent
                协助整理构图、画面与分镜，再调用已配置的模型生成图片或视频。
              </p>
              <p style={{ marginTop: 16 }}>
                查看创作进度、回顾历史，预览与下载作品。知识与创作，在同一个工作空间里衔接。
              </p>
              <a className="text-link" href="/app?view=studio">
                进入创作台 <span aria-hidden="true">↗</span>
              </a>
            </div>
            <div>
              <div className="screenshot-frame">
                <img
                  src={studioScreenshot}
                  alt="知汇创作台实际界面，支持图片、视频与 Agent 创作模式"
                  width="1440"
                  height="1000"
                  loading="lazy"
                />
              </div>
              <p className="image-caption">
                产品实际界面 · 图片与视频生成需配置对应模型服务。
              </p>
            </div>
          </div>
        </section>
        <section className="scenarios">
          <div className="wrap">
            <span className="tag">团队日常</span>
            <h2>每一种协作，都有知识在背后</h2>
            <p className="section-sub">
              把反复询问和零散查找，变成更从容的工作方式。
            </p>
            <div className="scenario-grid">
              <article className="scenario">
                <small>人力与行政</small>
                <h3>
                  新同事的第一个问题，
                  <br />
                  有了清晰的入口。
                </h3>
                <p>从入职指南到日常制度，帮助成员找到流程与要求。</p>
              </article>
              <article className="scenario">
                <small>产品与研发</small>
                <h3>
                  让过去的讨论，
                  <br />
                  成为下一次决策的依据。
                </h3>
                <p>整理需求与方案，让项目背景和团队经验持续可用。</p>
              </article>
              <article className="scenario">
                <small>业务与管理</small>
                <h3>
                  从报表里的数据，
                  <br />
                  找到有出处的信息。
                </h3>
                <p>检索业务报告与表格，查看范围、来源行与相关原文。</p>
              </article>
            </div>
          </div>
        </section>
        <section className="capabilities" id="enterprise">
          <div className="wrap">
            <span className="tag">企业能力</span>
            <h2>好用，也要放心用</h2>
            <p className="section-sub">
              从模型到知识，从组织到部署，掌握自己的工作空间。
            </p>
            <div className="cap-grid">
              <article className="cap">
                <h3>连接你的 AI Agent</h3>
                <p>通过 MCP 或 REST API，让已有的智能工作流访问授权知识。</p>
                <div className="cap-bottom">
                  <span>MCP</span>
                  <span>REST API</span>
                  <span>受限 API Key</span>
                </div>
              </article>
              <article className="cap">
                <h3>适应企业的组织方式</h3>
                <p>
                  按部门、成员与汇报关系设置空间权限。查看、创建与管理独立控制。
                </p>
                <div className="cap-bottom">
                  <span>部门继承</span>
                  <span>精细授权</span>
                </div>
              </article>
              <article className="cap">
                <h3>模型选择，由你决定</h3>
                <p>分别配置问答、向量、视觉与创作模型，连接适合业务的服务。</p>
                <div className="cap-bottom">
                  <span>独立配置</span>
                  <span>连接测试</span>
                </div>
              </article>
              <article className="cap">
                <h3>让来源与过程可追溯</h3>
                <p>保留文档版本与引用，查看工具记录、索引任务和审计日志。</p>
                <div className="cap-bottom">
                  <span>原文引用</span>
                  <span>审计记录</span>
                </div>
              </article>
              <article className="cap">
                <h3>部署在自己的环境里</h3>
                <p>
                  支持私有化部署，把知识、检索索引和文件存储放在企业环境中。
                </p>
                <div className="cap-bottom">
                  <span>Docker Compose</span>
                  <span>私有存储</span>
                </div>
              </article>
              <article className="cap">
                <h3>兼顾团队与个人</h3>
                <p>团队经验在共享空间沉淀，个人资料与创作保留在私有空间。</p>
                <div className="cap-bottom">
                  <span>团队空间</span>
                  <span>个人知识库</span>
                </div>
              </article>
            </div>
          </div>
        </section>
        <section className="faq" id="faq">
          <h2>你可能还想了解</h2>
          <details>
            <summary>
              <ProductName />
              适合怎样的团队？
            </summary>
            <p>
              适合希望统一管理文档、减少重复查找，并用 AI
              访问企业知识的团队。可以从一个部门、一个项目或一份工作指南开始积累。
            </p>
          </details>
          <details>
            <summary>必须先配置 AI 模型，才能使用吗？</summary>
            <p>
              基础文档管理、权限和关键词检索无需模型密钥。生成式问答与语义检索需要配置问答和向量模型；图片理解、图片与视频创作需要配置对应服务。
            </p>
          </details>
          <details>
            <summary>成员能访问所有企业知识吗？</summary>
            <p>
              知识访问受空间权限约束。成员与 Agent 只可读取当前被授权的知识，API
              Key 的权限不会超过所属用户的当前权限。
            </p>
          </details>
          <details>
            <summary>能部署在企业自己的服务器上吗？</summary>
            <p>
              可以。当前项目提供 Docker Compose
              部署方式，支持企业环境中的数据库、检索服务与对象存储。部署时需配置相应服务和管理员账号。
            </p>
          </details>
        </section>
        <section className="closing">
          <h2>把下一件工作，交给知小汇。</h2>
          <p>从一个想法开始，一起把它做好。</p>
          <a className="pill" href="/app?view=bot">
            <span>开始和知小汇协作</span>
            <span aria-hidden="true">↗</span>
          </a>
        </section>
      </main>
      <footer className="footer">
        <div className="wrap">
          <div className="footer-top">
            <a className="brand" href="#top">
              <img src={logo} alt="" />
              <ProductName />
            </a>
            <div className="footer-links">
              <a href="#bot">知小汇 bot</a>
              <a href="#knowledge">知识空间</a>
              <a href="#answers">智能问答</a>
              <a href="#enterprise">企业能力</a>
              <a href="#faq">常见问题</a>
            </div>
          </div>
          <div className="wordmark" aria-hidden="true">
            <ProductName />
          </div>
          <div className="footer-bottom">
            <span>
              <ProductName /> · 让知识创造价值
            </span>
            <span>
              © {new Date().getFullYear()} <ProductName />
            </span>
          </div>
        </div>
      </footer>
    </div>
  );
}
