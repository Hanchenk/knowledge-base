# 企业灵感榜上线记录

后续首页更新使用镜像 `sha256:77503830f7cbe502533eb099437bcaa47707c51031e04fc0916291cc20e132f5`，继承本次排行榜。已在该当前镜像再次完成真实游戏、自动弹榜、云端最佳、刷新、重玩和移动端验证；schema 仍为 9。首页访客模式不提交企业成绩，登录成员排行榜保留。

生产入口： http://192.168.1.34:18088/app?view=bot 。
发布时间： 2026-10-10T17:55:13+0800 。版本： `atlas-knowledge:zhixiaohui-leaderboard-20261010-175044` 。镜像： `sha256:955e4d7143a83eb2067e921004dcf24eb213d499312f687e98cbea680447ddea` 。

游戏结束自动弹出企业成员排行榜，展示本次星光、个人最高成绩、企业名次。展示前 10 位成员；榜外成员单独看到自己的成绩与名次。同分并列；同分显示顺序为首次达到该最高成绩的时间、成员 ID。停用成员退出榜单。没有测试或虚构成员进入生产榜单。

弹窗可以收起和重新打开；Esc 只收起榜单，再次 Esc 退出游戏。支持重玩、回到对话和草稿恢复。成绩保存失败时保留本局成绩供重试；确认保存后可重玩。320px、390px 手机界面无横向溢出。游戏继续铺满整个对话内容区。

成绩记录存储于生产 PostgreSQL，按登录会话确认企业与成员，客户端无法指定其他成员身份。开局创建服务端 run；至少经过 15 秒才能提交 0–20 的整数成绩。每局只保存一次，重试幂等；提交后成绩不能修改。每位成员的最高成绩独立持久化。超过 24 小时的未完成局过期，下一次开局会清理该成员过期未提交记录。游戏为轻量娱乐，分数由浏览器计算，服务端验证身份、时间与分值范围。

发布源基于发布前真实生产源码，只修改排行榜模块、009 迁移、路由/迁移接入、BotCompanion、弹窗、游戏 CSS 和接口文档。未发布工作区中正在进行的本地设备 008 迁移。生产 schema 从 7 增至 9，保留 1 个企业、37 个用户、4 个空间、5 份文档、4 个创作资产及模型 revision 10。API/Worker 镜像一致，API 健康，服务均运行且无重启。环境、数据卷、模型配置与既有 Agent/处理器不变。

发布同时检测到其他任务更新 LandingBotDemo.tsx、App.tsx、landing-bot.css、BotPage.tsx。这些文件未在本次发布覆盖范围内，保留服务器上的更新；本次镜像继承发布前线上功能。

验证：Linux SQLite 和隔离 PostgreSQL 各 3 项游戏测试，覆盖未登录/API Key、成员/企业边界、提前提交、分值范围、并发重试、最高分更新、同分排名、榜外本人名次、停用成员和数据库重连。新镜像独立 SQLite 验证了 HTTP 认证、资源字节、服务重启后成绩、幂等提交和 SSE 接口保留。

隔离发布与生产资源各 14 项浏览器测试通过，覆盖结束自动弹榜、失败重试、键盘/触屏、草稿、动效、输入选择器、SSE 和侧边栏。生产 Chrome 游戏约 59.6 FPS，4 倍 CPU 限速约 59.6 FPS，无逐帧 React 重绘。真实管理员完成一局 15 秒游戏，实际接住 20 颗星光，云端最佳 20、名次 1；当前 1 位成员参与。另验证刷新保留最佳、重玩、Esc、移动端和所有 17 个当前构建资源的字节一致。验证没有发起模型任务。

证据： [验证 JSON](bot-leaderboard-verification.json) ，[桌面](screenshots/bot-leaderboard-production-desktop.png) ，[手机](screenshots/bot-leaderboard-production-mobile.png) 。

备份： `/work/project/atlas-knowledge/backups/zhixiaohui-leaderboard-20261010-175044` ，含发布前数据库快照和源码/配置归档。服务切换前再次刷新数据库快照。回滚镜像： `atlas-knowledge:before-zhixiaohui-leaderboard-20261010-175044` 。回滚只恢复本次覆盖文件、前端构建与旧镜像，保留当前数据库、新增表、数据卷、密钥和其他任务更新：

```bash
python3 /work/project/atlas-knowledge/releases/zhixiaohui-leaderboard-20261010-175044/rollback.py zhixiaohui-leaderboard-20261010-175044
```
