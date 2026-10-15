# 知汇 Atlas · 企业知识库

基于 **Rust + React** 的可私有化部署企业知识库与 AI 工作台，集成权限检索、知小汇 bot、云端电脑、个人记忆和图片 / 视频创作。Rust 服务负责权限、REST / MCP、索引与任务调度；独立 Python 子进程解析 PDF / Office；Node.js 运行 Pi Agent Core 与官方 DeepSeek Harness。

## 本次更新

- **云端电脑与插件**：按账号隔离的持久工作环境、连接 / 断开、历史会话与成果文件，支持 npm 插件市场、自定义来源及插件配置；空闲 30 分钟自动回收容器。
- **记忆与经验**：个人中心统一管理跨任务记忆、经验采集和技能提炼；候选需审核后使用，支持可选腾讯 MemoryCore、Wiki 与公开 GitHub 仓库 CodeGraph。
- **创作台增强**：粘贴 / 拖拽附件、参考图、选区编辑、抠图 / 扩图 / 清晰增强、图生视频，以及风格、质量、模板与草稿恢复。
- **任务与成果体验**：整合输入栏「更多」菜单，优化桌面 / 手机布局、引用来源与文件预览，HTML / SVG 成果可在隔离预览中交互；修复登录跳转丢失目标页面与任务草稿入口的问题。
- **飞书连接器**：实现官方远程 MCP 的 OAuth 动态注册与 PKCE 流程，保留草稿和任务选项。现有生产回调被飞书返回 `invalid_redirect_uri`，真实授权与文档读取仍待联通，详见 [接入状态](docs/feishu-connector.md)。

## 已实现

| 能力 | 实现 |
| --- | --- |
| AI Agent 接入 | MCP Streamable HTTP `/mcp`、REST API、OpenAPI，5 个知识工具 |
| 企业组织 | 多租户、部门树、直属上级、管理员 / 成员、停用与密码重置 |
| 精细权限 | 空间的查看 / 创建 / 管理，部门及下属继承，用户授权，显式拒绝优先 |
| 图文 RAG | 视觉模型解析图片 / PDF 图表，文本及图片查询、混合检索、页码 / 版本 / 原图引用 |
| 主 Agent 问答 | Pi Agent Core、按需调用授权知识工具、可选联网搜索 / 网页读取、多轮对话、工具记录和网页来源 |
| 知小汇 bot | 后台任务、计划与工具记录、流式回复、取消 / 重试、外部操作确认、云端 / 已连接本地设备执行 |
| 报表检索 | 表头与完整数据行、年月与报告范围、规则重排、各场站月累计快照与来源行号 |
| 页面模型配置 | 企业管理员独立配置问答 / 向量 / 视觉 / 生图 / 视频服务，URL + Key 自动获取模型列表，密钥加密保存 |
| 创作台 | 文件选择 / 粘贴 / 拖拽、参考图 / 文档、选区改图 / 抠图 / 扩图 / 清晰增强、图生视频、风格与质量、异步任务、私有作品管理 |
| Harness 云端与插件 | 官方 DeepSeek Harness SDK、隔离云端执行、npm 插件市场与自定义来源、安装 / 启停 / 卸载、任务插件选择、同步最新发布版本 |
| 个人记忆与技能 | 账号独立开关、跨任务记忆召回、候选审核、已完成任务技能提炼、来源权限与版本校验 |
| Wiki / CodeGraph | 授权文档 Wiki、公开 GitHub 仓库建图、检索 / 调用关系 / 影响分析，需配置 MemoryKnowledge |
| 成果与引用 | 私有成果下载、HTML / SVG 隔离交互预览、Markdown / 图片 / PDF / 代码预览、按实际引用显示来源 |
| 应用连接器 | 自定义 GET / POST 连接器、POST 精确请求确认；飞书只读 MCP 流程已实现，真实授权待联通 |
| 个人知识库 | 本人私有空间，图片 / 视频创作自动入库开关，默认关闭 |
| 对象存储设置 | MinIO 页面配置、上传 / 读取 / 删除测试，密钥加密与历史对象位置保留 |
| 文档管理 | 上传、Markdown 创建、搜索、原文件下载、版本、删除与文件清理、重新索引 |
| 可靠索引 | 数据库持久队列、独立 Worker、租约续期、自动重试、版本一致性发布 |
| 认证与审计 | Argon2id、HttpOnly 会话、API Key scope / 过期 / 撤销、OIDC SSO、访问及变更日志 |
| 私有部署 | Docker Compose、PostgreSQL + Qdrant、MinIO、Caddy 内网 HTTP / 域名 HTTPS |
| 管理界面 | 中文 React Web、桌面 / 移动端、知识问答、组织授权、Agent 配置及审计 |

**默认开发模式无需模型密钥**，使用真实关键词检索和原文片段；不会假装启用语义或生成能力。图文语义检索需要接入视觉与向量模型。首版跨模态检索通过视觉描述与 OCR 内容连接文本向量，未实现 CLIP 原生图像向量。

## 本地启动

需要 Rust 1.99+、Node.js 22.19+、[uv](https://docs.astral.sh/uv/) 与 Python 3.11+。`uv` 可自动准备解析器的 Python 环境。最小开发环境默认使用 SQLite 与本地文件；云端电脑和隔离代码执行另需 Docker。

```bash
cp .env.example .env
./scripts/dev.sh
```

已有 `.env` 时请保留原配置，按 [环境变量示例](.env.example) 补充新选项。

官网首页：[http://127.0.0.1:5173](http://127.0.0.1:5173)。工作台：[http://127.0.0.1:5173/app](http://127.0.0.1:5173/app)，登录入口为 `/login`。API 在 [http://127.0.0.1:8000](http://127.0.0.1:8000)，OpenAPI 在 `/api/openapi.json`。示例环境登录页可一键填入账号。

也可分别启动：

```bash
uv sync --project processor --frozen
npm ci --prefix agent-runtime --ignore-scripts
cargo run --locked
# 另一个终端
npm ci --prefix frontend
npm run dev --prefix frontend
```

| 企业标识 | 示例邮箱 | 密码 | 角色与访问范围 |
| --- | --- | --- | --- |
| `atlas` | `admin@atlas.local` | `AtlasDemo123!` | 管理员，所有空间 |
| `atlas` | `lin@atlas.local` | `AtlasDemo123!` | 研发负责人，全员 + 研发 |
| `atlas` | `wang@atlas.local` | `AtlasDemo123!` | 产品成员，继承研发部门权限 |
| `atlas` | `zhou@atlas.local` | `AtlasDemo123!` | 人力成员，全员 + 人力 |

示例制度仅用于演示。只有 `SEED_DEMO=true` 才创建示例企业；生产配置禁止启用它。示例数据只在首次初始化时写入，修改权限或文档不会被启动时覆盖。

## 接入模型

推荐由企业管理员进入 **设置 → 问答与检索**，分别填写问答、向量和视觉模型的服务地址、API Key，自动获取模型列表后选择模型（不支持列表的服务可手填）；向量模型还需填写实际输出维度。每项“测试连接”会实际调用对应模型（视觉测试会发送一张测试图片），显示耗时和认证、接口、维度等错误。测试未保存的配置不会改变当前运行配置。

点击“保存配置”后立即对当前企业的检索、问答和独立索引 Worker 生效，无需重启。三个模型可连接不同服务；未启用时保留关键词检索与原文回答。已保存密钥不会回传浏览器，留空保留原密钥，勾选“清除密钥”可接入无认证的内网模型。更换向量 / 视觉配置后，请重新索引已有文档。详见 [模型配置说明](docs/model-settings.md)。

环境变量仍可作为未保存页面配置时的默认值，修改环境默认值需重启 Rust 服务：

```dotenv
AI_BASE_URL=https://your-provider.example/v1
AI_API_KEY=your-key
EMBEDDING_MODEL=your-text-embedding-model
EMBEDDING_DIMENSIONS=1536
CHAT_MODEL=your-chat-model
VISION_MODEL=your-vision-model
```

模型服务需要兼容 `/embeddings` 和 `/chat/completions`；视觉模型需接受 `image_url` 的 Data URI。国内模型服务和内网模型可使用同一适配器。`VISION_BASE_URL` / `VISION_API_KEY` 可将视觉模型连接到另一个服务，未设置时复用主服务。

例如，内网 Ollama 可配置 `AI_BASE_URL=http://ollama:11434/v1`、`AI_API_KEY=ollama`，配合已拉取的文本、视觉及向量模型；向量维度必须与实际模型一致。向量、视觉与模型测试在 Rust 服务端调用，问答由服务端 Pi 子进程调用已保存的模型；页面输入的密钥仅提交用于保存或测试，不回传已保存原值，也不发送给文档解析进程。

在启用模型或更换向量模型后，对已有文档执行重新索引。正式部署的 Qdrant 集合按模型配置指纹与维度隔离，无需修改 PostgreSQL 向量列。只有未设置 Qdrant 的旧 pgvector 部署仍需迁移固定维度的列和 HNSW 索引。详见 [部署文档](docs/deployment.md)。

图片 / 扫描 PDF 在没有视觉模型时会明确提示失败。未配置向量时仍可按文字检索图片的已解析描述；未配置问答模型时展示原文片段和来源。

## Pi 主 Agent 与联网

启用问答模型后，默认由 Pi Agent Core 0.87.0 执行问答。它可继续搜索知识库、按文档及页码读取证据、查询授权空间；页面勾选“联网搜索”后，才增加公开搜索和网页读取工具。答案分别显示知识库引用、网页来源及工具调用记录，刷新历史对话仍可查看。

复用“RAG 模型配置”中的问答模型，无需单独填写 Pi 模型。该模型需兼容流式 `/chat/completions` 和 `tools` 函数调用。管理员可用 `AGENT_WEB_ENABLED=false` 全局禁用联网；`WEB_SEARCH_URL` 可设置 SearXNG 的 JSON 搜索地址，留空使用公开 Bing RSS。`PI_AGENT_ENABLED=false` 可使用原直接 RAG 问答流程。详见 [Pi Agent 接入与边界](docs/pi-agent.md)。

正式部署使用 PostgreSQL + Qdrant + MinIO：PostgreSQL 持久化业务数据，Qdrant 提供向量检索，MinIO 保存上传文件和生成媒体。本地接入同一套服务或从 SQLite 迁移的步骤见 [部署文档](docs/deployment.md)。企业标识和首个管理员通过私有 `.env` 的 `BOOTSTRAP_*` 配置，生产必须关闭示例数据。

## 知小汇 bot

侧边栏打开 **知小汇 bot**，交办研究、会议纪要、数据分析与文档任务。支持步骤和工具记录、后台执行、取消 / 重试、私有成果下载及继续对话；可选择授权资料、工作流技能和应用连接器。POST 外部操作在任务中展示准确请求并等待确认。bloub SVG 角色动画跟随任务状态，支持手机与减少动态效果。

复用问答模型配置；无模型时交付原文检索报告。自定义连接器需配置 `BOT_CONNECTOR_HOSTS` 和应用凭据，隔离 Python 使用 `BOT_CODE_ENABLED` 与 Docker。本地执行通过配套桌面客户端连接指定工作区，模型和本地工具使用桌面端配置；本仓库提供平台接口，桌面插件另行安装。详见 [知小汇 bot](docs/zhixiaohui-bot.md) 与 [本地执行桥接](docs/bot-local-bridge.md)。

「插件」入口提供 DeepSeek Harness 插件市场、已安装列表、启停、任务选择、自定义 npm registry 与 npm / GitHub / HTTPS 插件包来源。云端服务就绪时自动使用官方 Harness；服务器按账号创建 Docker 云端电脑，空闲 30 分钟后回收容器，插件、会话与成果保持持久化。引擎版本与同步 npm `latest` 的入口集中在管理员「设置 → 云端服务」，云端文件通过现有私有 MinIO 在线预览和下载。安装失败或运行环境不可用会明确报错。详见 [Harness 云端运行](docs/harness-cloud.md)。

在 **账号菜单 → 个人中心 → 管理记忆与经验** 维护个人跨任务记忆、已完成任务的技能提炼与审核，以及绑定授权资料的 Wiki 和公开 GitHub 仓库的 CodeGraph。跨任务召回、经验采集、技能提炼有独立账号开关；任务还可单独关闭个人记忆、选择知识资产。Pi 与 DeepSeek Harness 共用权限和来源校验，来源更新或撤权后重新核验历史任务和成果。

未配置 MemoryCore 时，个人记忆保存在平台中，技能可手动起草或调用已配置的问答模型提炼；Wiki / CodeGraph 需要 MemoryKnowledge。可选服务使用 `MEMORY_CORE_URL` / `MEMORY_CORE_TOKEN`、`MEMORY_KNOWLEDGE_URL` / `MEMORY_KNOWLEDGE_TOKEN`；上游技能提炼另需 `MEMORY_CORE_ADMIN_USER_KEY`。配置与验收见 [接入说明](docs/agent-memory-integration.md) 和 [Wiki / CodeGraph 部署](docs/wiki-codegraph-integration.md)。

输入栏 **更多 → 应用连接器 → 连接飞书** 提供官方授权入口，成功连接后仍需在任务中明确选择飞书。回调使用 `PUBLIC_URL` 加 `/api/bot/connectors/feishu/callback`；需先获得飞书接受且用户浏览器可达的回调地址，再验收完整授权链路。首期仅提供文档检索、正文读取、列举和当前用户信息，当前真实接入状态见 [飞书连接器](docs/feishu-connector.md)。

## 创作台

侧边栏打开 **创作台**，管理员在「设置 → 生图与视频」填写生图 / 视频服务的 Base URL 和 API Key，自动获取模型列表，选择模型、勾选启用并保存。Pi 复用已启用的问答模型作为主智能体，整理创作要求并实际调用生成工具；页面支持生图、视频或 Agent 自主选择、画幅 / 时长、可选联网素材检索。

作品异步生成，保存创作记录与进度，支持图片预览、视频播放和下载，仅创建者账号可读取。支持 OpenAI 兼容 `/images/generations` 和 `/videos` 提交 / 查询 / 下载协议，以及 Grok / Sub2API 的 JSON `/videos/generations` 视频协议，按 Grok 模型 ID 自动选择。媒体模型「测试连接」只读取模型列表，不提交付费生成；实际生成能力需要在创作台验证。API 或独立 Worker 执行持久任务，复用现有 SQLite / PostgreSQL 与本地 / MinIO 存储。详见 [创作台与媒体模型](docs/studio.md)。

创作台提供输入卡片、灵感快捷卡片和最近作品网格，桌面创作记录可收起，支持移动端操作。

输入卡片现支持选择、粘贴和拖拽图片 / PDF / Office / 文字文件，附件私有保存，支持失败重试。图片可用作参考，配合选区画笔进行擦除或改图，也可抠图、扩图、增强清晰度；支持 12 种风格、质量设置、提示词模板、草稿恢复、作品搜索筛选和复用。参考图编辑依赖所选服务商的 `/images/edits`，图生视频支持 OpenAI / Grok 协议。能力调研与实现取舍见 [本次升级说明](docs/creative-harness-upgrade.md)。

## 授权与 Agent 接入

1. 企业管理员在“成员与组织”维护部门和汇报关系。
2. 创建知识空间，在“权限设置”选择全员、部门、具体用户或某成员的下属。
3. 分别设置查看、创建与管理权，可包含下级，也可添加显式拒绝规则。
4. 成员在“Agent 接入”创建受限 API Key，复制 MCP 配置或调用 REST。

API Key 的权限始终不超过所属用户的当前权限。查看权独立于创建权；无查看权的创建者可提交文档，但不能读取该空间已有资料。企业管理员保留企业内所有空间管理权。

```json
{
  "mcpServers": {
    "atlas": {
      "url": "https://knowledge.example.com/mcp",
      "headers": {"Authorization": "Bearer YOUR_API_KEY"}
    }
  }
}
```

本地可将 URL 改成 `http://127.0.0.1:5173/mcp`。使用支持远程 HTTP MCP 的客户端；不同客户端配置字段略有差异。协议支持 stateless JSON Streamable HTTP，不需要 stdio 子进程或客户端安装 Python。

```bash
curl http://127.0.0.1:8000/api/search \
  -H 'Authorization: Bearer YOUR_API_KEY' \
  -H 'Content-Type: application/json' \
  -d '{"query":"报销流程","limit":5}'
```

详见 [Agent 接入文档](docs/agents.md)、[OpenAPI 规范](docs/openapi.json)、[架构及权限说明](docs/architecture.md) 和 [检索与月度报表问答](docs/retrieval.md)。

## 部署与验证

[部署文档](docs/deployment.md) 包含 Compose、首次管理员、SSO、备份及向量维度迁移说明。基础服务使用 PostgreSQL 17、Qdrant 和 MinIO；需要云端电脑时叠加隔离 Docker daemon 配置：

```bash
cp deploy/production.env.example .env
# 填写域名 / 内网入口、管理员和各服务的独立密钥后启动：
docker compose -p atlas-knowledge up -d --build
# 启用 Harness 云端电脑与隔离代码执行：
docker compose -p atlas-knowledge -f compose.yaml -f compose.bot-code.yaml up -d --build
```

API 与 Worker 需要使用一致的配置和持久卷。数据库当前迁移到 **schema 18**；升级前备份 PostgreSQL、MinIO、Harness 持久卷及配置加密密钥。云端部署和可选记忆服务分别见 [Harness 云端运行](docs/harness-cloud.md) 与 [Wiki / CodeGraph 部署](docs/wiki-codegraph-integration.md)。

安装开发依赖后，可运行与 CI 对应的检查：

```bash
npm test --prefix agent-runtime
cargo fmt --all -- --check
cargo test --workspace --locked
cargo clippy --workspace --all-targets --locked -- -D warnings
npm run format:check --prefix frontend
npm run build --prefix frontend
processor/.venv/bin/python -m unittest discover -s processor -p 'test_*.py'
# 隔离示例环境的后端、前端开发服务运行时：
npm run test:e2e --prefix frontend
# Docker daemon 运行时，以临时容器验证 PostgreSQL + Qdrant + MinIO：
processor/.venv/bin/python scripts/verify_services.py
# 可选：官方 Harness SDK、Docker 与插件的真实集成 smoke：
npm run test:harness:smoke --prefix agent-runtime
# API 变更后重新生成 OpenAPI：
python3 scripts/generate_openapi.py
```

浏览器测试默认使用本机 Chrome；可以通过 `PW_CHANNEL` 选择已安装的 Playwright 浏览器通道。完整浏览器测试包含上传、删除、修改设置等操作，请使用 `SEED_DEMO=true` 的独立测试数据库与文件目录。后端测试使用临时数据库，模型及外部服务部分使用 fixture 验证协议和权限链路；真实模型效果、腾讯服务与飞书个人授权需要分别验收。CI 配置见 [.github/workflows/ci.yml](.github/workflows/ci.yml)。

## 文档导航

| 主题 | 文档 |
| --- | --- |
| 架构、权限与检索 | [架构说明](docs/architecture.md) · [检索与月度报表](docs/retrieval.md) |
| API / MCP 与模型 | [Agent 接入](docs/agents.md) · [OpenAPI](docs/openapi.json) · [模型配置](docs/model-settings.md) · [Pi Agent](docs/pi-agent.md) |
| 知小汇 bot | [产品与权限](docs/zhixiaohui-bot.md) · [本地执行](docs/bot-local-bridge.md) · [执行逻辑评审](docs/zhixiaohui-bot-logic-review-2026-10-13.md) |
| 云端电脑与插件 | [用户说明](docs/cloud-computer.md) · [Harness 运行与部署](docs/harness-cloud.md) |
| 记忆、技能与知识资产 | [记忆与经验](docs/agent-memory-integration.md) · [Wiki / CodeGraph](docs/wiki-codegraph-integration.md) |
| 飞书与创作 | [飞书连接器及当前阻点](docs/feishu-connector.md) · [创作台](docs/studio.md) · [创作台升级](docs/creative-harness-upgrade.md) |
| 部署与验收 | [部署运维](docs/deployment.md) · [验收说明](docs/verification.md) · [飞书最新发布记录](docs/feishu-connector-production-deployment.md) |

## 目录

```text
backend/        Rust API、MCP、权限与 Worker
frontend/       React + TypeScript Web、浏览器测试
agent-runtime/  Pi / Harness 运行时、插件与云端容器适配、Node 测试
processor/      独立文档解析器与解析测试
docs/           架构、API、Agent、部署、验证与截图
scripts/        本地启动、OpenAPI 生成、真实服务验证
deploy/         TLS 入口和对象存储权限配置
```

## 当前边界

飞书目前实现只读连接流程，真实授权尚未联通；第三方知识源的持续同步、钉钉 / SharePoint 集成、私有仓库 CodeGraph、SCIM、行业 reranker、WORM 合规存储、原生图像向量与高负载压测尚未提供。云端文件自动导入限制为单文件 5 MB、每次合计 30 MB / 最多 30 份；插件网络与执行能力的边界见 Harness 文档，各解析格式的支持边界见架构说明。
