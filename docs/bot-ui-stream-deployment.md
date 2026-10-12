# 知小汇 UI 与流式输出生产发布

入口：http://192.168.1.34:18088/app?view=bot 。部署时间：2026-10-10 16:26:48（Asia/Shanghai）。

生产版本：`atlas-knowledge:zhixiaohui-ui-stream-20261010-161935`。镜像 ID：`sha256:76be73f12a1335c30dbb027dfaf2c416da95b13c7d7f6c2419aa35ba1be94acd`。API 和独立 Worker 使用同一镜像，API 健康，两个容器均无重启。

## 已上线内容

- 简约对话页面，移除“从知识到行动”能力卡片。应用连接器、技能、云端工具及资料统一在输入栏选择。
- 左侧连续对话、右侧蓝色至浅桃色渐变 bot 工作区；工作区可以收起，浏览器记住选择。
- 执行过程默认折叠，展开后的记录限定高度。模型公开文字通过 SSE 增量显示，数据库持久化，刷新和断线重连后恢复。私密推理及工具参数不会作为文字输出。
- 系统侧边栏增加边缘拖动手柄，可左右拖动、点击及键盘操作；拖动时跟随指针，松开后平滑收展，桌面记住状态。手机支持触摸，导航覆盖页面；支持减少动态效果。
- PostgreSQL schema 7 新增 `bot_messages`，保留原有任务、事件和成果。权限撤销时隐藏已有输出，取消后的旧 Worker 无法继续写入文字。

本次从已验证生产版本提取 UI 与流式修改独立构建；研究任务循环修复候选不包含在此发布中。既有运行时依赖、模型配置、密钥、Compose 沙箱覆盖和数据卷保留。

## 验证

服务器候选镜像在无网络、无生产数据库访问的隔离容器中使用实际 Pi 协议 fixture 与独立 Worker 验证：模型完成前即收到文字、输出持久化、SSE 重连恢复、私密推理排除及 OpenAPI 契约均通过。模拟接口不调用真实付费模型。

SQLite 与 PostgreSQL/Qdrant 分别 9 项 bot 后端测试通过，12 项 Node 运行时测试通过。上线后的 12 项 bot/个人偏好浏览器回归及 1 项创作台宽屏布局测试通过，包括真实 HTTP SSE 字节增量、侧边栏鼠标/键盘/触摸和个人偏好。

生产管理员登录/退出及实际页面交互验证通过：桌面、390/320px 手机无横向溢出，输入栏资源选择、工作区收展与持久化、侧边栏拖动/键盘/触摸、减少动态效果正常。12 个前端页面/资源文件与发布构建逐字节一致，浏览器无异常和失败资源。生产账户无任务可用于 SSE 内容回放，因此生产验证检查认证后的 stream 路由及 OpenAPI；完整模型至浏览器流式链路由隔离候选和浏览器 SSE 测试覆盖，没有新建生产任务。

业务数量保持：1 个企业、37 个用户、4 个空间、5 份文档、3 个创作资产。模型配置 revision 10、密文指纹、环境文件和所有数据卷挂载与发布前一致。

证据：`bot-ui-stream-verification.json`。真实生产截图：`screenshots/bot-production-desktop.png`、`screenshots/bot-production-collapsed.png`、`screenshots/bot-production-mobile.png`。

## 备份与回滚

发布目录：`/work/project/atlas-knowledge/releases/zhixiaohui-ui-stream-20261010-161935`。

备份目录：`/work/project/atlas-knowledge/backups/zhixiaohui-ui-stream-20261010-161935`，数据库快照和源码/配置备份权限为 600；切换前额外刷新数据库快照。回滚镜像：`atlas-knowledge:before-zhixiaohui-ui-stream-20261010-161935`，ID：`sha256:4260c1a53d83ad19fac1afeb7456c88d7e3acee40924fde459218dd934829bb8`。

```bash
python3 /work/project/atlas-knowledge/releases/zhixiaohui-ui-stream-20261010-161935/rollback.py zhixiaohui-ui-stream-20261010-161935
```

回滚只恢复本次修改的源码、前端构建及 API/Worker 镜像；保留当前数据库、schema 7、数据卷、模型密钥和沙箱配置。旧服务可忽略新增消息表，无需回退数据库。不要使用 `down -v`。
