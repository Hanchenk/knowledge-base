# 知小汇 bot 生产部署

入口：http://192.168.1.34:18088/app?view=bot 。发布日期：2026-10-10（Asia/Shanghai）。

当前排行榜版本：`atlas-knowledge:zhixiaohui-leaderboard-20261010-175044`。后续首页同步镜像 ID：`sha256:77503830f7cbe502533eb099437bcaa47707c51031e04fc0916291cc20e132f5`，已再次验证企业排行榜。API 与独立 Worker 使用同一镜像，API 健康。底层仍为 Pi Agent；DeepSeek Harness 尚处于接口评估阶段。

最新更新：游戏结束自动弹出企业灵感榜，云端保存个人最高成绩，展示企业前 10 位与自己的名次，同分并列。游戏铺满对话内容区，仍保持约 60 帧/秒。详见 [排行榜发布记录](bot-leaderboard-deployment.md) 和 [动画与游戏发布记录](bot-motion-deployment.md)。

## 本次研究循环修复

原研究任务取消前运行 20 分 12 秒，106 次工具调用、15 次上下文压缩、0 个成果；相同来源重读 13–14 次，仍停在第一步。

本次增加网页分页、已读覆盖缓存、跨压缩事实与引用、语义无进展检测以及研究到交付的阶段控制。实际保存文件的 ID 与名称单独保留；只有进入最后交付步骤并读回全文后才关闭重复取材，中间文件不会提前结束研究。修正 PostgreSQL 检查点与续租行锁死锁，长报告生成使用 300 秒请求期限和 15 秒协议心跳。正常工具调用没有固定总次数上限。

保留已发布的简约界面、bloub 动画与互动、输入栏选择器、侧边栏拖动以及公开文字 SSE。此前界面发布见 [UI 与流式输出](bot-ui-stream-deployment.md)。

## 验证与范围

24 项 Node 测试、4 项 Rust 单元测试、35 项真实 PostgreSQL/Qdrant/MinIO 集成测试和 Clippy 检查通过。最终镜像与本地运行时、前端构建哈希一致，生产页面的 12 项浏览器回归通过（业务 API 使用 fixture，不创建生产任务）。真实生产管理员登录、退出、页面、资源与 bot 能力接口通过。

最终候选在隔离数据库和模拟模型中，由独立 Worker 完成 41 轮请求、39 次工具调用、36 次自动压缩、3 次执行尝试，验证崩溃恢复、时间片续接、真实 Docker Python 隔离与成果下载。

真实 `gpt-6.1-sol` 使用原任务已授权归档证据，在隔离环境生成并修订报告、读回全文，完成计划和最终答复。最终检查点续跑耗时 346 秒、8 轮模型请求、3 次压缩；修订报告 8993 字、21387 字节，13 个引用编号与原始工具回执匹配。公开网页未重新独立核验，报告明确披露证据限制。此结果验证检查点恢复与交付，不表示从零完整研究的耗时或成功率已经验证。

原生产任务仍为 `cancelled`，attempt 2、125 条事件、0 个成果，未恢复或写入测试报告。详细证据见 [验证记录](bot-convergence-verification.json)。

## 数据与环境

当前保留 1 个企业、37 个用户、4 个空间、5 份文档、4 个创作资产，数据库 schema 9，模型配置 revision 10。发布前后业务计数、模型配置密文指纹、环境文件、数据卷和基础设施镜像一致。

`compose.override.yaml` 继续链接 `compose.bot-code.yaml`。Docker 29 DinD 通过 TLS 供 API/Worker 使用，只读挂载客户端证书，不挂载生产宿主 Docker socket。原有 PostgreSQL、Qdrant、MinIO、Caddy 与文件存储数据卷保留。

## 备份与回滚

备份目录：`/work/project/atlas-knowledge/backups/zhixiaohui-convergence-20261010-165120`。数据库快照、源码/配置归档权限为 600。回滚镜像：`atlas-knowledge:before-zhixiaohui-convergence-20261010-165120`，ID `sha256:be45222fca45290577c7e170e8ee8128b4c883770ef1ef5f8fb83af9179fa18f`，保留前一版流式界面与互动功能。

```bash
cd /work/project/atlas-knowledge
tar -xzf backups/zhixiaohui-convergence-20261010-165120/source-and-config.tar.gz -C . Cargo.toml Cargo.lock Dockerfile .dockerignore compose.yaml compose.bot-code.yaml backend frontend agent-runtime scripts processor
docker tag atlas-knowledge:before-zhixiaohui-convergence-20261010-165120 atlas-knowledge:local
docker compose -p atlas-knowledge up -d --no-deps --no-build --wait --wait-timeout 180 api
docker compose -p atlas-knowledge up -d --no-deps --no-build worker
```

回滚保留当前数据库、schema 7、密钥、数据卷和沙箱覆盖；不恢复数据库快照，不使用 `down -v`。
