# 客户端连接生产发布

发布日期：2026-10-12（Asia/Shanghai）。入口：[知小汇 bot](http://192.168.1.34:18088/app?view=bot)。

执行位置面板只展示云端、本地电脑下拉框和液态玻璃「连接本地」按钮。配对码、服务器地址与说明区已移除；本地工作区统一放在下拉框，删除连接仅在选项悬停或键盘聚焦时显示。按钮在点击时请求 `dsh://open`，同时打开连接窗口；选择工作区并确认账号后，网页自动选中新连接。

桌面端需要安装 [dsh-plugin-team-hub 0.1.0-alpha.23](http://192.168.1.34:18088/downloads/dsh-plugin-team-hub-0.1.0-alpha.23.tgz)，完全退出并重启 Harness。公开下载文件与本地已验证插件包字节相同，SHA-256 为 `0ad9cc15e09f7caaddc0dda7155d3056e0a6e8d539abbf1f3496a52b2a0dc305`。

发布版本：`desktop-connection-20261012-091435`。API 与 Worker 镜像：`sha256:1996eae259d518c1fd1a3951a7cd44d692317f5d38fe08192cd5aa400ab84e3b`。数据库从 schema 9 升至 10，新增 `bot_connections`，保留原表与所有记录。发布前后均为 1 个企业、37 个用户、4 个知识空间、5 份文档、4 个创作资产和 23 个 bot 任务；模型配置 revision 10 与密文摘要一致。环境配置、数据卷及既有 Agent/处理器字节已核对一致。

网关的 `connect-src` 仅新增 `http://127.0.0.1:18765–18769`。本次重建 gateway，使配置文件绑定挂载实际读取新版 Caddyfile；只执行 reload 无法更新此前已替换文件留下的旧挂载。回滚脚本同样重建 gateway。数据卷核对按挂载路径排序比较，避免 Docker 返回顺序变化造成误判。

Linux SQLite 和隔离 PostgreSQL 各 5 项连接/本地任务测试通过。生产页面验证了 12 项 bot、9 项首页浏览器用例，并在更新网关后复验连接确认和自动发现；41 个发布文件字节校验全部匹配。真实管理员登录、新界面、连接窗口、320px 布局、过期请求拒绝和插件下载通过；API 健康、Worker 运行、重启计数均为 0。验证没有创建生产任务或调用模型。浏览器测试拦截了操作系统协议动作，Windows 实机唤起仍未验证。

备份目录：`/work/project/atlas-knowledge/backups/desktop-connection-20261012-091435`，包含受权限保护的数据库快照和源代码/配置归档。初次 schema 9 快照另存为 `database-schema9.dump`。应用回滚保留当前数据库及新增业务数据：

```bash
python3 /work/project/atlas-knowledge/releases/desktop-connection-20261012-091435/rollback.py desktop-connection-20261012-091435
```

证据见 [生产验证记录](bot-connection-production-verification.json)。
