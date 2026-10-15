# DeepSeek Harness 云端运行与插件

知小汇 bot 可通过官方 `@deepseek-ai/dsh-sdk-client` 启动 DeepSeek Harness，使用 Cordis profile 加载插件，并把平台知识库与任务工具接入原生工具注册表。普通页面提供「云端电脑」、插件市场、安装、启停、配置和任务选择；引擎版本与升级入口集中在管理员「设置 → 云端服务」。创作台对话目前继续使用 Pi。

## 云端电脑生命周期

服务器在用户连接或提交 Harness 云端任务时，自动启动该账号专属的 Docker 容器。同一租户、用户的后续任务复用该容器，每个任务在独立工作目录与原生会话中执行。不同账号不共享容器、插件 profile 或会话目录。

空闲时间为 **30 分钟**，独立 Worker 每 60 秒检查一次，因此正常回收发生在截止时间后的一个检查周期内。用户主动操作和任务执行续期；页面后台轮询状态不会续期。正在运行的任务受到数据库 worker token 与进程租约保护；手动断开还会检查排队任务。取消仅停止对应任务的进程组，不影响同账号其他任务。Worker 意外退出后，过期租约依据数据库中的准确任务与执行 token 清理，避免遗留进程永远占用容器。

回收只移除容器。插件依赖、加密配置、任务原生 home、工作目录、平台消息与检查点保留在持久卷和数据库中，再次连接可以恢复。容器内任务不挂载生命周期元数据、其他账号目录、供应商密钥或宿主 Docker socket。历史知识库证据的当前权限与文档版本重新校验；无权恢复的原生任务缓存移入不挂载的隔离目录，恢复授权后可以移回。权限同步需要容器没有运行任务；繁忙时拒绝新的连接或任务并等待已有任务结束，不能追缴已下载副本。

前端「云端文件」沿用 MinIO 私有成果，断开电脑后仍可查看和下载。每次预览或下载重新验证账号归属及知识库证据权限，不公开 bucket。文本、常见图片和 PDF 可在线预览；HTML、SVG 及其他格式仅下载。

## 版本与兼容范围

初始依赖固定为 `0.2.0-rc.2`。页面从 npm 官方 `@deepseek-ai/dsh/latest` 查询最新发布版本；管理员点击「同步最新版本」会真实安装该版本并验证 SDK 会话接口，再激活新版本。版本查询失败会保留当前引擎。

引擎 release 和活动版本属于整个部署的共享目录；同一部署中的任一租户管理员更新后，会影响该部署后续任务，正在运行的容器继续使用启动时的 release。插件 profile 与配置则按租户和用户隔离。当前实现没有后台定时更新；「最新」以 npm `latest` 标签为准。更新失败保留原活动版本，界面展示错误。

云端适配保留官方 SDK 协议与 Cordis 插件加载机制，同时使用 `HarnessSdkJsonRpcServer.createSession` 扩展入口和 `AgentRegistry.resume` 恢复原生会话。此扩展入口不是跨所有未来版本的稳定性承诺；更新时检查入口存在，后续上游行为或 profile 变化仍需要回归验证。原生文件、shell、技能和子代理在任务容器内运行；交互式本地终端、桌面控制与宿主 Docker 管理不属于云端接口。

## 部署

在完成生产环境变量配置后，使用隔离 Docker daemon 覆盖文件启动：

```sh
docker compose -f compose.yaml -f compose.bot-code.yaml up -d --build
```

`sandbox` 使用独立 Docker daemon 与客户端 TLS 证书；不要挂载生产宿主 Docker socket。`harness-init` 为共享目录设置应用 UID `10001`，优先使用这个 daemon 已有的 `BOT_HARNESS_IMAGE`，缺失时再拉取。API、worker 和 sandbox 必须把同一个 `harness_data` 卷挂到同一个 `/app/data/harness` 路径，任务容器才能读取引擎、个人 profile 与工作目录。

如果嵌套 daemon 无法连接 Docker Hub，可把宿主机已准备的官方镜像导入沙箱；只在宿主机执行 `docker pull` 不会让嵌套 daemon 自动获得镜像：

```sh
docker save node:22-bookworm-slim | docker compose exec -T sandbox docker load
```

| 环境变量 | 默认值与作用 |
| --- | --- |
| `BOT_HARNESS_ENABLED` | `true`；允许 Harness 云端执行 |
| `BOT_HARNESS_PATH` | 本地开发为 `data/harness`；Compose 固定为 `/app/data/harness` |
| `BOT_HARNESS_IMAGE` | `node:22-bookworm-slim`；需要被配置的 Docker daemon 预先拉取 |
| `BOT_HARNESS_BRIDGE_HOST` | 本地开发为 `host.docker.internal`；Compose 覆盖文件分别设为 `api-harness`、`worker-harness` |
| `BOT_CODE_ENABLED` | 全局代码执行开关；隔离覆盖文件启用此开关 |
| `AGENT_WEB_ENABLED` | 平台联网工具全局开关 |

桥接端点在 API/worker 的临时端口监听，采用每任务随机 bearer token。模型请求也经过该端点转发，真实供应商密钥保留在 API/worker 进程；任务容器的 `DSH_API_KEY` 仅包含本次任务的短时 token，任务结束后失效。供应商响应及任务错误会对模型密钥和插件配置中的凭据字段脱敏。Compose 使用仅属于 `sandbox` 网络的 `api-harness`、`worker-harness` 别名，使解析结果固定为 DinD 可访问的服务 IP；直接使用同时属于多个网络的 `api`、`worker` 可能解析到另一隔离网络，导致任务无法回连。自定义拓扑必须保证任务容器能到达相应地址，不能简单把嵌套 daemon 的 `host.docker.internal` 当作 API 地址。

用户容器挂载引擎、该用户的插件依赖、已授权任务的持久化目录、工作目录和个人容器 home，不挂载其他账号的目录或 Docker socket。容器使用只读系统目录、非 root UID、限制 CPU/内存/PID 并移除 Linux capabilities。知识库访问仍经过平台工具和当前用户权限。

## 插件市场与安装

内置市场接入 npm registry 的真实搜索接口。用户可以在「市场来源」添加提供 npm `/-/v1/search` 协议的公开 HTTPS 注册源，再搜索与安装插件；页面不是预置演示卡片或独立的官方商店。

「添加插件」支持 npm 包（可带版本）、GitHub HTTPS/GitHub shorthand 和公开 HTTPS `.tgz`、`.tar.gz` 归档。安装通过官方 `runPluginCommand` 完成，并校验 Harness bundle 或 Cordis 插件声明。插件安装在按租户和用户分开的 profile 中；启停、更新、卸载和配置同样按个人隔离。

插件包管理使用 pnpm `--config.ignore-scripts=true`，不会在 API 宿主执行第三方生命周期脚本。Mac 开发环境为 Linux 容器安装对应的可选原生依赖；需要额外源码编译的第三方插件不会自动构建，可能无法运行，需要提供适配该容器的预编译包或另行扩展构建流程。依赖特定系统程序的插件也需要相应任务镜像。

「已启用」表示插件可供任务选择。个人插件使用同一持久 profile，安装、更新、启停与配置在下次任务启动时同步，无需向新容器重新安装。任务只加载明确选中的插件，最多 20 个；未选中的已安装插件不会加入任务 profile。本地设备任务不能使用这组云端插件。普通用户不再选择内部引擎；云端服务就绪时使用 Harness，兼容路径由系统选择。

插件配置以插件声明的 Cordis row ID 到配置对象的 JSON 映射保存。配置经过服务端校验，以应用加密密钥加密存储，读取接口不回显已保存配置或密钥；提交新 JSON 会替换旧配置，清空需要在弹窗内确认。任务只解密所选且仍启用的插件配置；每次执行生成唯一的临时 patch 文件，采用 `0600` 权限，并在本次执行结束后删除。

## 任务恢复与成果

每任务使用固定原生 session ID，保留其 Harness home 和工作目录。运行中同时保存平台检查点、工具回执与原生会话；重启恢复时调用官方原生 resume API，并继续使用平台操作确认与防重复回执。租户/用户禁用所选插件或隔离环境不可用时，任务明确失败，不会静默改用另一个引擎。

任务完成后自动导入 `/workspace` 下常见文档、图片、文本与代码文件，并在成果列表中提供下载。导入限制为单文件 **5 MB**、合计 **30 MB**、最多 **30 份**，跳过符号链接、隐藏文件、`node_modules` 和过深目录；超过限制的文件在回答中提示。原生插件可以直接调用平台 `write_artifact` 生成文本成果。

## 联网与代码开关边界

页面「联网检索」「代码执行」选项会随任务提交。关闭代码执行会停用 Harness 原生 bash、PowerShell 与 jobs 工具，关闭联网会停用其原生 web 工具；平台网络、Python和连接器工具继续执行各自的授权、全局配置与操作确认。

Harness 原生 `web_search`、`web_fetch` 使用 Cordis web provider，包括所选的搜索插件。平台联网桥接注册为 `platform_web_search`、`platform_web_fetch`，保留平台来源编号与校验，两组工具可以同时使用。

任意第三方 Cordis 插件本身是容器内执行的代码，可能直接访问网络或执行程序。这两个工具开关不构成对任意第三方插件的网络或程序执行封锁。当前任务容器允许出网；严格的插件网络限制需要在 Docker 网络、镜像或插件审查层实现，不能只依赖隐藏原生工具。安装和选用插件时应考虑这一运行能力。

## 验证

前端行为测试采用隔离 API fixture，验证安装失败、真实操作调用、任务选择、市场来源、启停卸载、版本更新、移动布局与配置错误恢复；它不代表模型和所有第三方插件已完成实测。后端集成与官方 SDK/Docker smoke 的执行结果应与发布验收记录一起检查，尤其是原生依赖、会话恢复和上游版本变化。

2026-10-12 本次验证中，运行时 **33 项 Node 测试全部通过**。其中 9 项 Harness 测试覆盖官方工具 schema、原生/平台 web 名称共存、私有推理过滤、凭据脱敏、二进制与链接导入边界、成果上限、用户隔离、安装来源和同版本更新不覆写 release。

可复用的真实集成 smoke 不需要模型密钥或付费调用：模型响应使用本地 SSE fixture，官方 SDK、Docker 容器、npm 安装与 Cordis 插件加载实际执行。

```sh
docker pull node:22-bookworm-slim
cd agent-runtime
npm run test:harness:smoke
```

本次 smoke 使用 Harness `0.2.0-rc.2` 和 `@aiwayds/dsh-web-search-anysearch@0.6.0`，完成 6 次模型请求。断言已通过：插件真实安装/启停/卸载、平台 `task_plan` 桥接、原生文件与 PNG 二进制成果导入、相同任务原生 session 恢复、代码关闭、原生与平台 web 工具加载，以及真实供应商密钥不进入任务容器。fixture 不调用 AnySearch 搜索服务，不代表所有第三方插件或供应商接口均已验证。
