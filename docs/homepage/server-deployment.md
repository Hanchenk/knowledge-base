# A 版首页服务器部署

## 沉浸式首页与登录页更新（当前版本）

发布日期：2026-10-10（Asia/Shanghai）。发布版本：`atlas-knowledge:homepage-login-20261010-175804`；镜像 ID：`sha256:77503830f7cbe502533eb099437bcaa47707c51031e04fc0916291cc20e132f5`。

移除首屏「互动体验 / 界面截图」切换和外层容器边框、背景、阴影；对话区透明，直接融入视频背景。保留机器人、固定任务示例和成果工作区。输入栏改为真实 textarea：聚焦和编辑不跳转，发送按钮或 Enter 提交后进入 `/login?view=bot`，Shift + Enter 换行，空白提交不跳转。草稿仅存同标签页 sessionStorage，30 分钟有效，不进入 URL；登录成功后恢复到 bot 输入栏并清除暂存，由用户再发送才创建正式任务。

登录页采用首页同一 WebM / MP4 光影背景、品牌字体、浅色半透明表单和知小汇欢迎语；保留账号登录、SSO、错误反馈和返回官网。减少动态效果时使用静态封面，390 / 320px 适配。

基于服务器最新 `zhixiaohui-leaderboard-20261010-175044` 合并构建，保留已上线的排行榜后端与前端。首页小游戏使用显式访客模式，不请求企业排行榜或登记游戏记录；已登录平台沿用正式排行榜流程。本地设备功能等其他开发改动保留，没有覆盖到服务器。`atlas-server` 与 `agent.mjs` 发布前后哈希相同，环境配置校验一致。

备份：`/work/project/atlas-knowledge/backups/homepage-login-20261010-175804`（数据库快照、前端和配置归档，权限 600）。发布目录：`/work/project/atlas-knowledge/releases/homepage-login-20261010-175804`。前一镜像：`sha256:955e4d7143a83eb2067e921004dcf24eb213d499312f687e98cbea680447ddea`，回滚标签：`atlas-knowledge:before-homepage-login-20261010-175804`。

验证：本地与线上首页各 9 项、已登录排行榜 3 项浏览器测试通过，构建与本轮文件格式检查通过。线上实际登录、草稿恢复、刷新、退出、手机布局、视频和减少动态效果的证据见 `server-login-verification.json`。验证过程不创建生产任务，不调用模型。

回滚应用镜像（保留业务数据）：

```bash
cd /work/project/atlas-knowledge
docker tag atlas-knowledge:before-homepage-login-20261010-175804 atlas-knowledge:local
docker compose -p atlas-knowledge up -d --no-deps --no-build --wait --wait-timeout 180 api
docker compose -p atlas-knowledge up -d --no-deps --no-build worker
```

后续重新构建旧版前，应从归档恢复对应源文件，勿恢复数据库快照或覆盖环境配置。

## 知小汇 bot 首页更新（历史版本）

发布日期：2026-10-10（Asia/Shanghai）。发布版本：`atlas-knowledge:homepage-bot-20261010-173449`；镜像 ID：`sha256:6a3cc80a6d3f7df9915e5224b3bc75fb21b59a086ab1d7f0f459389a9ed603c1`。

官网首屏主打知小汇 bot：标题「这里是知汇」按 160ms 间隔逐字入场，保留上传字体、动态光影背景；减少动态效果时直接显示全部文字。首屏、导航、介绍、收尾与页面元信息调整为 AI 工作搭档定位，主要协作入口指向 `/app?view=bot`。

首屏提供「互动体验 / 界面截图」切换。截图来自服务器当时已上线的 bot 前端，使用隔离的示例账号和空任务历史截取。互动展示使用现有 BloubAvatar、BotCompanion 与 InspirationGame 组件，支持视线跟随和接星光、三个固定任务示例的阶段切换、工作区收展、成果/文件切换、实际示例 Markdown 下载。示例明确标为演示，不发送业务 API，不创建正式任务或调用模型；真实协作通过平台登录入口进行。

使用服务器前端源码快照构建，只覆盖本次首页文件和编译资产；保留同时开发中的其他本地改动，后端与 Agent 运行时从当前服务器镜像继承。发布前后 `atlas-server` 与 `agent.mjs` 的字节哈希相同，环境配置校验一致，API 与 Worker 同镜像、正常运行、重启次数 0。

备份：`/work/project/atlas-knowledge/backups/homepage-bot-20261010-173449`，包含数据库快照、前端与配置归档，文件权限 600。发布目录：`/work/project/atlas-knowledge/releases/homepage-bot-20261010-173449`。回滚镜像：`atlas-knowledge:before-homepage-bot-20261010-173449`，前一镜像 ID：`sha256:49b044a6a65409022ca0c11ad11f8505d7cee7c3c93d63f2d150792f03845a00`。

浏览器验证：逐字入场顺序、三个任务示例、文件下载、截图切换、实际接星光、暂停、Esc 后焦点恢复、减少动态效果、390/320px 无横向溢出、问答/创作旧入口和真实 bot 登录/刷新均通过。证据见 `server-bot-verification.json`；没有创建生产任务或调用付费模型，主页业务 API 请求为 0。

回滚应用镜像（保留业务数据）：

```bash
cd /work/project/atlas-knowledge
docker tag atlas-knowledge:before-homepage-bot-20261010-173449 atlas-knowledge:local
docker compose -p atlas-knowledge up -d --no-deps --no-build --wait --wait-timeout 180 api
docker compose -p atlas-knowledge up -d --no-deps --no-build worker
```

后续重新构建旧版前，可从该前端归档恢复源文件，勿恢复数据库快照或覆盖环境配置。

## 产品字体与名称更新（历史版本）

发布版本：`atlas-knowledge:homepage-brand-20261010-104745`。镜像 ID：`sha256:4fc49e38ee0ab5f4dd18d8b88f2b1f9c2a0006723375dc1848d26d06b679943c`。

产品对外名称统一为「知汇」。官网导航、首屏、按钮、介绍、常见问题、页脚，以及平台侧栏、登录页、知识助手和工作台产品名均通过 ProductName 组件使用用户上传字体。网页标题、描述与产品截图移除英文副名称。产品截图从当前界面使用示例数据重新截取。

字体来源：用户上传 `ChaoXiaoSheXiaoZuoWenJian-Shan-ZhongYuan.zip` 内 TTF，字体家族 `Joketype-WritingGB-Flash SemiBold`。提取「知汇」二字为 `frontend/src/assets/fonts/zhihui-brand.woff2`，1292 字节；字体以独立资源提供，兼容现有站点 CSP。正文继续使用原有字体。

备份目录：`/work/project/atlas-knowledge/backups/homepage-brand-20261010-104745`。前一版本镜像：`atlas-knowledge:before-homepage-brand-20261010-104745`。本次基于前一镜像仅更新前端，同步源代码；环境配置校验一致，API 与 Worker 同时更新并正常运行，重启次数为 0，业务数据卷保留。

本地和线上浏览器测试各 5 项通过。`server-brand-verification.json` 记录实际服务器验证：官网、登录、工作台、智能问答、创作台的字体均成功加载，页面没有旧英文产品名；字体资源 HTTP 200 且字节与本地字体子集完全一致；390/320px 手机无横向溢出；动态背景、真实管理员登录与退出正常；无脚本错误或资源失败。

回滚本次更新：

```bash
cd /work/project/atlas-knowledge
docker tag atlas-knowledge:before-homepage-brand-20261010-104745 atlas-knowledge:local
docker compose -p atlas-knowledge up -d --no-deps --no-build --wait --wait-timeout 180 api
docker compose -p atlas-knowledge up -d --no-deps --no-build worker
```

回滚应用镜像时保留业务数据；重新构建旧版本前需从本次源码备份恢复前端文件。

## Logo 与视频背景更新（上一版本）

发布版本：`atlas-knowledge:homepage-video-20261010-103647`。镜像 ID：`sha256:143831d1e242d2ccf6e71fc4bd1217413fe151e63172c1c09f09e7b0b5f89734`。

首屏采用用户提供的 Today_AI.webm，31.25 秒，静音自动循环、内联播放；另有 MP4 兼容版本及静态封面。减少动态效果设置启用时不加载视频，显示静态封面。问答和创作台截图从当前产品界面重新截取，使用演示数据和新版彩色星形 Logo，移除了旧版截图中的重复页头。

本次只更新前端，基于上个应用镜像叠加编译后的页面资产，同时同步前端源码。API 和 Worker 使用同一新镜像，均正常运行且重启次数为 0，API 健康检查通过。环境配置校验保持一致，业务数据卷继续保留。

备份：`/work/project/atlas-knowledge/backups/homepage-video-20261010-103647`，包含数据库快照和前端/配置归档，备份文件权限 600。前一版本镜像保留为 `atlas-knowledge:before-homepage-video-20261010-103647`。发布包：`/work/project/atlas-knowledge/releases/homepage-video-20261010-103647`。

本地与服务器浏览器测试各 5 项通过。实际线上验证记录见 `server-video-verification.json`：WebM、MP4 范围请求返回 206，视频正在循环播放；新版截图均加载完成；390/320px 无横向溢出；减少动态效果、真实管理员登录、创作台与退出均通过，无页面错误或资源失败。

回滚本次更新：

```bash
cd /work/project/atlas-knowledge
docker tag atlas-knowledge:before-homepage-video-20261010-103647 atlas-knowledge:local
docker compose -p atlas-knowledge up -d --no-deps --no-build --wait --wait-timeout 180 api
docker compose -p atlas-knowledge up -d --no-deps --no-build worker
```

此操作回滚应用镜像，保留业务数据。后续重新构建旧版时需从本次前端备份恢复源码。

## 首次 A 版发布记录

部署日期：2026-10-10。服务器：192.168.1.34。项目：`/work/project/atlas-knowledge`，Compose 项目名 `atlas-knowledge`。

访问入口：

- 官网：http://192.168.1.34:18088/
- 登录：http://192.168.1.34:18088/login
- 工作台：http://192.168.1.34:18088/app

发布标签：`atlas-knowledge:homepage-a-20261010-021801`。API 与 Worker 当时均运行镜像 `sha256:23408cb3fe7adcb6e1196082327401eb18a5a2763a68e18ee25fc64983514766`，并以 `atlas-knowledge:local` 作为 Compose 镜像名。

旧镜像保留为 `atlas-knowledge:before-homepage-a-20261010-021801`，原镜像 ID 为 `sha256:731d83207b9a1f865f4815c13a342a881e6a53705e16e63b601747c23f5a0f7c`。

服务器备份目录：`/work/project/atlas-knowledge/backups/homepage-a-20261010-021801`。数据库备份 `database.dump`，源码与配置备份 `source-and-config.tar.gz`；两者权限均为 600。配置 `.env` 的 SHA-256 与部署前一致，PostgreSQL、MinIO 和 Qdrant 数据卷挂载一致。核心记录数量在切换前后均为：1 个企业、2 个用户、2 个知识空间、3 个文档、0 个媒体资产。

服务器上独立构建新镜像后更新 API 与 Worker，部署包仅包含正式页面资产，不包含三方向预览。`.dockerignore` 已排除服务器备份与发布目录，避免后续构建把这些文件纳入上下文。

远程验证记录：server-verification.json。已验证官网、图片资源、390/320px 手机布局、导航、真实管理员登录、问答与创作直达、退出及返回官网。未触发生图、视频生成或模型问答。页面未发生脚本错误或资源失败；API 健康，API 与 Worker 重启次数为 0。

回滚首次 A 版发布时，在服务器执行：

```bash
cd /work/project/atlas-knowledge
docker tag atlas-knowledge:before-homepage-a-20261010-021801 atlas-knowledge:local
docker compose -p atlas-knowledge up -d --no-deps --no-build --wait --wait-timeout 180 api
docker compose -p atlas-knowledge up -d --no-deps --no-build worker
```

Worker 禁用了健康检查，应单独启动并检查运行状态；不要与 API 一起使用 `--wait`。应用镜像回滚不恢复数据库快照，部署后新增业务数据继续保留。需要重新构建旧版本时，可以从源码备份恢复到独立目录。
