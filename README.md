# 知汇 Atlas · 企业知识库

基于 **Rust + React** 的可私有化部署知识库。Rust 服务实现权限、REST / MCP、索引任务与 RAG；独立 Python 子进程负责 PDF 与 Office 文件解析；Pi Agent Core 作为问答与创作主 Agent，由独立 Node.js 子进程运行。

## 已实现

| 能力 | 实现 |
| --- | --- |
| AI Agent 接入 | MCP Streamable HTTP `/mcp`、REST API、OpenAPI，5 个知识工具 |
| 企业组织 | 多租户、部门树、直属上级、管理员 / 成员、停用与密码重置 |
| 精细权限 | 空间的查看 / 创建 / 管理，部门及下属继承，用户授权，显式拒绝优先 |
| 图文 RAG | 视觉模型解析图片 / PDF 图表，文本及图片查询、混合检索、页码 / 版本 / 原图引用 |
| 主 Agent 问答 | Pi Agent Core、按需调用授权知识工具、可选联网搜索 / 网页读取、多轮对话、工具记录和网页来源 |
| 报表检索 | 表头与完整数据行、年月与报告范围、规则重排、各场站月累计快照与来源行号 |
| 页面模型配置 | 企业管理员独立配置问答 / 向量 / 视觉 / 生图 / 视频服务，URL + Key 自动获取模型列表，密钥加密保存 |
| 创作台 | Pi Agent 调用图片 / 视频工具、异步任务与进度、私有作品预览 / 播放 / 下载、创作历史 |
| 个人知识库 | 本人私有空间，图片 / 视频创作自动入库开关，默认关闭 |
| 对象存储设置 | MinIO 页面配置、上传 / 读取 / 删除测试，密钥加密与历史对象位置保留 |
| 文档管理 | 上传、Markdown 创建、搜索、原文件下载、版本、删除与文件清理、重新索引 |
| 可靠索引 | 数据库持久队列、独立 Worker、租约续期、自动重试、版本一致性发布 |
| 认证与审计 | Argon2id、HttpOnly 会话、API Key scope / 过期 / 撤销、OIDC SSO、访问及变更日志 |
| 私有部署 | Docker Compose、PostgreSQL + Qdrant、MinIO、Caddy 内网 HTTP / 域名 HTTPS |
| 管理界面 | 中文 React Web、桌面 / 移动端、知识问答、组织授权、Agent 配置及审计 |

**默认开发模式无需模型密钥**，使用真实关键词检索和原文片段；不会假装启用语义或生成能力。图文语义检索需要接入视觉与向量模型。首版跨模态检索通过视觉描述与 OCR 内容连接文本向量，未实现 CLIP 原生图像向量。

## 本地启动

需要 Rust 1.99+、Node.js 22.19+、[uv](https://docs.astral.sh/uv/) 与 Python 3.11+。`uv` 可自动准备解析器的 Python 环境。

```bash
cp .env.example .env
./scripts/dev.sh
```

官网首页：[http://127.0.0.1:5173](http://127.0.0.1:5173)。工作台：[http://127.0.0.1:5173/app](http://127.0.0.1:5173/app)，登录入口为 `/login`。首页按 Today AI 的自然光影风格设计，支持桌面与移动端。API 在 [http://127.0.0.1:8000](http://127.0.0.1:8000)，OpenAPI 在 `/api/openapi.json`。示例环境登录页可一键填入账号。

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

当前本地和服务器均使用 PostgreSQL + Qdrant + MinIO：PostgreSQL 持久化业务数据，Qdrant 提供向量检索，MinIO 保存新上传文件和生成媒体。原本地文件仍可读取，SQLite 仅保留为可选示例环境。部署默认企业标识为 `Yemast`，管理员邮箱为 `admin@yemast.com`；服务器登录信息保存在权限为 600 的 `deploy/server-credentials.md`，初始化密码仅配置在私有 `.env` 中。

## 知小汇 bot

侧边栏打开 **知小汇 bot**，交办研究、会议纪要、数据分析与文档任务。支持步骤和工具记录、后台执行、取消 / 重试、私有成果下载及继续对话；可选择授权资料、工作流技能和应用连接器。POST 外部操作在任务中展示准确请求并等待确认。bloub SVG 角色动画跟随任务状态，支持手机与减少动态效果。

复用问答模型配置；无模型时交付原文检索报告。连接器需配置 `BOT_CONNECTOR_HOSTS` 和应用凭据，隔离 Python 使用 `BOT_CODE_ENABLED` 与 Docker。产品规划、部署及权限边界见 [知小汇 bot](docs/zhixiaohui-bot.md)。

## 创作台

侧边栏打开 **创作台**，管理员在「设置 → 生图与视频」填写生图 / 视频服务的 Base URL 和 API Key，自动获取模型列表，选择模型、勾选启用并保存。Pi 复用已启用的问答模型作为主智能体，整理创作要求并实际调用生成工具；页面支持生图、视频或 Agent 自主选择、画幅 / 时长、可选联网素材检索。

作品异步生成，保存创作记录与进度，支持图片预览、视频播放和下载，仅创建者账号可读取。支持 OpenAI 兼容 `/images/generations` 和 `/videos` 提交 / 查询 / 下载协议，以及 Grok / Sub2API 的 JSON `/videos/generations` 视频协议，按 Grok 模型 ID 自动选择。媒体模型「测试连接」只读取模型列表，不提交付费生成；实际生成能力需要在创作台验证。API 或独立 Worker 执行持久任务，复用现有 SQLite / PostgreSQL 与本地 / MinIO 存储。详见 [创作台与媒体模型](docs/studio.md)。

创作台以居中输入卡片、灵感快捷卡片和最近作品网格组织页面，桌面创作记录可收起。产品 Logo 统一使用提供的透明图稿，覆盖侧栏、登录页、加载状态、助手及浏览器图标；React 组件为 `frontend/src/ProductLogo.tsx`，原图裁切后的显示资源为 `frontend/src/assets/product-logo.png`。

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

[部署文档](docs/deployment.md) 包含 Compose、首次管理员、SSO、备份及向量维度迁移说明。

```bash
cargo test --workspace --locked
cargo clippy --workspace --all-targets --locked -- -D warnings
npm run build --prefix frontend
processor/.venv/bin/python -m unittest discover -s processor -p 'test_*.py'
# 后端、前端开发服务运行时：
npm run test:e2e --prefix frontend
# Docker 启动后，以临时容器验证 PostgreSQL + Qdrant + MinIO：
processor/.venv/bin/python scripts/verify_services.py
```

浏览器测试默认使用本机 Chrome；可以通过 `PW_CHANNEL` 选择已安装的 Playwright 浏览器通道。后端测试使用临时数据库，模型部分使用测试服务验证协议和检索链路；真实模型效果需要用企业自己的评估集验收。

## 目录

```text
backend/        Rust API、MCP、权限与 Worker
frontend/       React + TypeScript Web、浏览器测试
processor/      独立文档解析器与解析测试
docs/           架构、API、Agent、部署、验证与截图
scripts/        本地启动、OpenAPI 生成、真实服务验证
deploy/         TLS 入口和对象存储权限配置
```

此版本是可运行、可扩展的首版。第三方知识同步（飞书 / 钉钉 / SharePoint 等）、SCIM、行业 reranker、WORM 合规存储、原生图像向量与高负载压测暂未包含；各解析格式的支持边界见架构说明。
