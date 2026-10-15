# 知识引用与成果在线预览修复

2026-10-12 已部署到 [知小汇 bot](http://192.168.1.34:18088/app?view=bot)，发布标识 `citation-preview-20261012-155400`。

## 文件预览

此前右侧成果列表仅提供下载；回答中的 `./pelican-bike.html` 被浏览器当作站内相对路由，点击后返回首页。现在回答中的文件名和右侧文件卡片都选择当前任务真实成果，在右侧预览，保留会话地址，下载有独立入口。未知或存在歧义的相对文件链接不会导航。

支持自包含 HTML/HTM/SVG 交互预览、Markdown、常见图片、PDF，以及文本和代码。HTML 和 Markdown 可切换原始源码；预览提供刷新与失败重载，切换文件会取消旧请求并释放 Blob URL。Office 文档、压缩包等其他格式显示下载提示，尚未增加格式转换服务；多文件网页项目不会自动打包其依赖资源。

HTML/SVG 使用授权 `/api/bot/artifacts/{id}/render` 地址，iframe 仅允许脚本，响应 CSP 保持不透明来源，禁止父页面、Cookie/存储、网络及顶层跳转。`/preview` 继续返回惰性纯文本。网关对 render 单独设置策略，以延迟 Set 保证只有一个 CSP 响应头；主页面保持 `script-src 'self'`，仅增加同站与 Blob iframe 支持，供独立 HTML 和原生 PDF 使用。

预览、下载及云端文件列表保留租户、本人所有权、全部知识依赖权限和文档版本检查。当前及祖先成果均受证据可见性控制，撤权后移除预览，不公开 MinIO 地址。

## 知识来源

通用创作任务此前会先强制检索整个企业知识库，将召回片段作为知识来源展示，即使回答没有引用。现在 Agent 未明确选取资料时按需调用检索工具；明确选取资料及关闭 Agent 时的原文摘录路径保持检索。

页面只显示当前正文实际出现的 `[n]`、`[Wn]` 或精确 HTTP(S) 来源链接，排除代码、HTML、图片和普通链接标签中的编号；保留原始来源编号。完整依赖数组继续持久化，用于权限、版本及恢复校验，因此旧任务无需数据迁移。

## 验证

- 最终 Linux 镜像 63 项 Rust 测试全部通过；6 项引用与 5 项成果浏览器用例通过。前端构建、共享仓库 TypeScript 与格式检查通过。
- 使用生产快照恢复到隔离 PostgreSQL，在内部 Docker 网络启动候选 API 和实际生产 Caddy 镜像，无公开端口。验证 inert preview、render 响应内容、单一独立 CSP、匿名与跨用户拒绝、主页面策略及原数据/模型密文保留，临时环境已清理。
- 生产浏览器打开用户现有任务 `e4619fd1-9291-4f11-8979-788bd8af07e1`，直接使用已保存的 `pelican-bike.html`。确认 SVG 动画、播放/暂停、文件名与卡片点击保留会话 URL、源码切换、原文件名下载、桌面/手机布局、零页面脚本错误，以及未引用来源隐藏。临时验证会话已删除，未创建或重试业务任务，未调用付费模型。
- 切换后 API 健康，44 个静态文件及 20 个运行时文件匹配；schema 12，37 用户、4 空间、9 文档、8 创作资产、33 任务、3 成果、32 消息。环境、模型配置、基础设施容器及持久卷均保留。以上计数为切换快照。

[桌面预览](screenshots/citation-artifact-preview-production-desktop.png) · [手机预览](screenshots/citation-artifact-preview-production-mobile.png) · [完整验收数据](citation-artifact-preview-production-verification.json)

## 发布与回滚

候选镜像：`sha256:6b303fc37ca744844e7cd7b24a4cc9fe12f3fbcc6c47f0748b29066a0743fa21`。

上一镜像：`sha256:7e59d734f033849264ffc4d57e291f9715ee6faa5e56f89e1bebe1f1c07412a7`。

备份目录：`/work/project/atlas-knowledge/backups/citation-preview-20261012-155400`，包含切换前数据库、相关源码、网关配置及前端。回滚恢复上一应用、源码、配置及前端，保留现有数据库和持久数据。

```sh
python3 /work/project/atlas-knowledge/releases/citation-preview-20261012-155400/release-control.py rollback
```
