# 部署与运维

## 当前部署方案

业务数据正式保存在 **PostgreSQL 17**，文本向量在 **Qdrant 1.15.4**，原文件与生成媒体存入 **MinIO**。API 与独立 Worker 使用同一个镜像，Caddy 提供 Web 和 API 入口。Rust + React + Pi Agent 的结构保持不变。

`compose.yaml` 面向服务器，数据库、Qdrant 和 MinIO 均只在容器网络内可达。应用使用仅能读写删除 `atlas` bucket 的独立服务账号，Bucket 默认私有。数据使用具名卷持久化，不依赖容器文件层。

## 服务器部署

```bash
mkdir -p /work/project/atlas-knowledge
cd /work/project/atlas-knowledge
# 放入项目文件后，复制并填写独立密钥：
cp deploy/production.env.example .env
chmod 600 .env
docker compose -p atlas-knowledge up -d --build
docker compose -p atlas-knowledge ps
```

每个环境使用不同的数据库、MinIO、Qdrant 密钥。`MODEL_CONFIG_ENCRYPTION_KEY` 为 32 个随机字节的 Base64，例如 `openssl rand -base64 32`。Bootstrap 字段只在企业标识尚不存在时创建管理员，不会在重启时重置密码；生产不创建示例账号。

默认企业标识为 `Yemast`（区分大小写），管理员邮箱为 `admin@yemast.com`。管理员密码通过服务器 `.env` 的 `BOOTSTRAP_ADMIN_PASSWORD` 配置，不写入前端或公开配置模板。当前服务器登录信息保存在本地 `deploy/server-credentials.md`（权限 600）。已有部署修改企业标识时，应更新原企业记录并保留 tenant ID，同时同步 Bootstrap 和 OIDC 配置；修改管理员密码后注销其旧会话。本地已切换为 Yemast 企业，`SEED_DEMO=false`，不会在重启时重新创建示例企业。

本次内网部署地址为 `http://192.168.1.34:18088`，目录 `/work/project/atlas-knowledge`。采用独立 Compose 项目 `atlas-knowledge`，不占用该服务器已有的 80/443/9000/9001 端口。`ALLOW_INSECURE_HTTP=true` 显式允许内网 HTTP，并使浏览器会话在该入口正常工作。

公网或已有域名使用 HTTPS：设置 `.env` 的 `PUBLIC_URL=https://your-domain`、`DOMAIN=your-domain`、`ALLOW_INSECURE_HTTP=false`，再启动：

```bash
docker compose -p atlas-knowledge -f compose.yaml -f deploy/compose.https.yaml up -d --build
```

HTTPS 版本要求 80/443 可用，或将本项目接入现有反向代理。上传入口限制为 500 MiB 文件加 2 MiB multipart 开销。

## 本地正式数据库

`compose.local.yaml` 只启动基础设施，Rust 和 Vite 继续在宿主机运行：

```bash
docker compose --env-file .env.local-services -f compose.local.yaml up -d
./scripts/dev.sh
```

`.env.local-services` 保存基础设施凭据，权限 600；应用 `.env` 的数据库地址指向 `127.0.0.1:15432`，Qdrant 为 `http://127.0.0.1:16333`，MinIO 为 `http://127.0.0.1:19000`。MinIO 管理台在 `http://127.0.0.1:19001`，root 凭据在 `.env.local-services`；应用使用独立服务账号。

本次迁移保留原 SQLite 数据库，并先创建 `data/backups/atlas-before-postgres-*.db`。迁移脚本仅接受静态快照和空的、已初始化的 PostgreSQL 数据库；保留用户、权限、文档版本、会话、审计、模型加密配置及创作记录的原 ID。层级关系在全部人员/部门插入后恢复，所有数据在一个事务中导入，任何失败均回滚。

```bash
python3 scripts/migrate_sqlite_to_postgres.py data/backups/your-snapshot.db --container atlas-local-postgres-1
```

已有本地文件继续从原目录读取，新文件写入 MinIO。迁移数据库不会自动搬走文件；部署到新机器需要同时复制文件目录及配置加密密钥，或按原存储配置恢复对应对象。

## 对象存储页面配置

管理员打开「设置 → 对象存储」，填写 Endpoint、Bucket、Access Key、Secret Key、Region。内网 Docker 使用 `http://minio:9000`，宿主机开发使用 `http://127.0.0.1:19000`。测试会实际上传、读取并删除一个临时对象。测试不保存配置，保存后无需重启 API/Worker。

Secret Key 加密保存，GET 不返回明文。留空沿用原密钥。新配置具有独立存储 profile，文件记录绑定上传时的 profile；切换服务或关闭 MinIO 后，旧文件仍使用原位置和原凭据。旧 profile 应保留，旧服务与 Bucket 也需继续可达。关闭 MinIO 时新文件使用 API/Worker 共享的 `local_files` 卷。

## 向量持久化与重建

配置 `QDRANT_URL` 即使用 Qdrant；Compose 已自动设置。`QDRANT_API_KEY` 只供服务器内部使用。集合名包含配置 identity 哈希与维度，更换向量模型不会比较不兼容的向量。

文档发布/删除在 PostgreSQL 事务内写入 `vector_jobs`。Worker 以文档写锁同步 Qdrant，失败记录错误并自动重试。PostgreSQL 保存片段文本及向量 JSON，因此 Qdrant 可重建。启动时已有 ready 文档会重新加入同步任务；集合丢失时自动创建并重新填充。

恢复 Qdrant 后重启本项目 Worker 可发起重建：

```bash
docker compose -p atlas-knowledge restart worker
```

检索在 Qdrant 先限定租户、可查看空间与文档，再按 PostgreSQL 的当前版本、删除状态和权限检查结果。删除后即使向量服务暂时断开，也不会重新暴露被删内容。更改模型后需在文档页重新索引，生成新向量。

未设置 Qdrant 的旧 PostgreSQL 环境仍可使用 pgvector（需安装扩展并保持原固定维度），SQLite 只作为可选的简易开发模式。正式 Compose 不依赖 pgvector 扩展。

## 自动归档与删除

个人中心「创作内容自动入库」默认关闭。开启后，新完成的图片/视频与提示词、模型、尺寸、时长等信息进入本人个人知识库；视频按提示词和元数据检索，尚未解析视频画面。配置视觉模型后图片也建立视觉描述索引。关闭后不再归档新作品，已归档内容保留。

个人知识库不继承企业管理员的共享空间权限，也不能配置共享授权。归档与媒体任务完成同一事务提交，asset ID 唯一约束保证不重复。删除归档文档只删归档副本，不删除创作台原作品。

文档列表和详情均提供删除。删除事务立即隐藏文档、清除文本片段并取消未完成索引；原文件/历史版本/解析图片以及 Qdrant 向量通过持久化任务清理，存储暂不可用时自动重试。审计与文档基本记录保留。

## 备份、升级与检查

- PostgreSQL：`pg_dump` 备份业务数据，包括权限、用户、密钥密文、片段、任务、个人偏好与存储 profile。
- MinIO：备份对象和 Bucket；配置切换后的历史 Bucket 同样需要备份。
- Qdrant：快照可加速恢复，或从 PostgreSQL 保存的向量重建。
- 配置：加密保存 `.env`、`MODEL_CONFIG_ENCRYPTION_KEY` 和需保留的本地文件卷；丢失加密密钥会导致模型与存储凭据无法解密。

升级前备份，更新源码后执行 `docker compose -p atlas-knowledge up -d --build`。不要使用 `down -v`，该选项会删除数据卷。数据库迁移受 advisory lock 保护，当前 schema 版本为 10，包含无配对码客户端连接请求表。

```bash
docker compose -p atlas-knowledge logs --tail 100 api worker
curl http://192.168.1.34:18088/api/health
python3 scripts/verify_services.py
```

验证脚本使用随机名称和临时凭据创建 PostgreSQL、Qdrant、MinIO 容器，运行完整后端测试后删除临时容器，不修改本地正式或服务器数据卷。图像/视频模型在验证中使用协议 fixture，不产生付费调用。
