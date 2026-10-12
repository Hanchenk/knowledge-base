# 知小汇机器人视线与小游戏发布

生产入口：http://192.168.1.34:18088/app?view=bot 。部署时间：2026-10-10 16:45:53（Asia/Shanghai）。版本：`atlas-knowledge:zhixiaohui-companion-20261010-164158`，镜像 ID：`sha256:be45222fca45290577c7e170e8ee8128b4c883770ef1ef5f8fb83af9179fa18f`。

中间欢迎机器人沿水平方向平滑跟随鼠标视线；鼠标离开窗口或窗口失去焦点时回正。保留原有表情和眨眼。开启减少动态效果时视线直接更新，停用装饰动画。

点击中间机器人打开「接住灵感」，每轮 15 秒。通过鼠标、触摸或方向键移动知小汇，接住落下的星光得分。支持暂停、继续、重玩和回到对话，本浏览器保存最佳成绩。切换窗口或隐藏页面自动暂停，退出后焦点回到中间机器人；小游戏不会创建 bot 任务或调用模型。

本次只发布四个前端组件/样式文件及对应浏览器测试，继承上一生产版本的后端与 Agent 运行时。API/Worker 使用同一镜像，环境配置、数据库 schema 7、模型配置和数据卷均保留。

## 验证

生产构建及文件格式检查通过；本地 11 项完整 bot 浏览器测试和生产入口上的 2 项互动测试通过。覆盖鼠标视线、回正、实际接星光、键盘/触摸、暂停续玩、计时结束、最佳成绩、重玩、减少动态效果和关闭后的焦点恢复。新交互未影响流式输出、工作区收展、侧边栏拖动和输入栏工具选择。

服务器候选在隔离容器中验证页面、静态资源字节、小游戏构建内容和原有 SSE 契约。真实生产管理员验证视线跟随、接星光得分、方向键、暂停、Escape 退出、退出后继续输入、390/320px 手机和触摸通过，12 个新构建资源逐字节匹配，浏览器无异常；没有创建生产任务或调用付费模型。发布前后业务数量、模型密文、环境文件和数据卷挂载相同。

记录：`bot-companion-verification.json`。截图：`screenshots/bot-companion-production-desktop.png` 与 `screenshots/bot-companion-production-mobile.png`。

## 备份与回滚

备份：`/work/project/atlas-knowledge/backups/zhixiaohui-companion-20261010-164158`，包括切换前数据库快照及源码/配置备份，权限 600。发布目录：`/work/project/atlas-knowledge/releases/zhixiaohui-companion-20261010-164158`。上一版本镜像：`atlas-knowledge:before-zhixiaohui-companion-20261010-164158`。

```bash
python3 /work/project/atlas-knowledge/releases/zhixiaohui-companion-20261010-164158/rollback.py zhixiaohui-companion-20261010-164158
```

回滚恢复这次修改的前端源码、构建和 API/Worker 镜像，保留数据库、配置、密钥、沙箱与数据卷。
