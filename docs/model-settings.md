# 页面配置 RAG 模型

管理员打开「设置 → 问答与检索」，分别配置问答、向量和视觉模型。页面仅管理当前企业；普通成员和 API Key 不能读、改或测试模型配置。

1. 填写服务地址（通常以 `/v1` 结尾）和 API Key 后自动获取模型列表，选择模型；服务不支持 `/models` 时可手动填写名称。三个模型可使用不同服务商，向量模型必须填写实际输出维度。
2. 点击各模型的「测试连接」。无需先启用或保存；测试采用当前表单内容，不改变运行配置。问答测试调用 `/chat/completions`，向量测试调用 `/embeddings` 并检查非零有限向量和实际维度，视觉测试发送真实 PNG 图片到 `/chat/completions`。
3. 测试显示通过 / 失败、耗时，认证失败、限流、接口不存在、空响应、维度不匹配、网络异常和 30 秒超时会有明确提示。测试使用少量 tokens，可能产生模型服务费用；上游错误正文和生成内容不会回传，以免泄露密钥。
4. 勾选「启用」并保存。配置在下一次请求 / 索引任务读取时生效，独立 Worker 无需重启。正在运行的任务继续使用开始时的配置快照。
5. 更换向量或视觉配置后，在文档管理中对已有资料重新索引。旧向量不会与新服务 / 模型 / 维度产生的向量混合；在重新索引完成前仍可使用关键词检索。

API Key 留空表示保留原密钥。「清除密钥」表示移除认证头，适用于无需认证的内网服务。关闭模型后保留配置，但不再使用该能力。页面的模型状态表示启用且已填配置；只有「测试通过」表示对应表单刚刚完成实际调用，不代表持续可用或企业资料效果已验收。编辑后会清除旧测试结果。

填写配置、测试成功和启用是三个独立状态。测试不会自动勾选启用；需要勾选模型卡片右上角的「启用」并保存才会用于 RAG。已填写但关闭的模型会显示提示，系统状态和原文回答也会明确说明「已配置但未启用」，不会误报成未配置。

保存的配置优先于环境默认值，并按企业保存在 `tenant_model_configs`。默认配置仍来源于 `AI_BASE_URL`、`AI_API_KEY`、`CHAT_MODEL`、`EMBEDDING_MODEL`、`EMBEDDING_DIMENSIONS`、`VISION_MODEL`、`VISION_BASE_URL`、`VISION_API_KEY`。首次将环境配置保存到页面时也应重新索引向量。并发编辑通过 revision 校验，返回 409 时重新加载配置后再修改。

## 加密与部署

配置使用 AES-256-GCM 加密，随机 nonce，企业 ID 作为认证附加数据。已保存密钥不会出现在配置读取接口、测试结果或审计日志。模型调用不跟随重定向；支持 HTTP/HTTPS 内网地址，以适配私有模型部署。

本地开发自动生成 `STORAGE_PATH/.model-config-key`，Unix 权限为 0600；该文件与数据库一起保留才能在重启后解密，切勿删除。生产环境必须给 API 和 Worker 设置同一个 `MODEL_CONFIG_ENCRYPTION_KEY`，例如用 `openssl rand -base64 32` 生成一次后填入部署环境文件；未设置时页面保存禁用，环境默认模型仍可使用。不要在已有加密配置后直接更换加密密钥。数据库备份和加密密钥需分别保管，并在恢复时配套使用。

正式部署使用 Qdrant，集合按服务地址、模型与维度的指纹隔离，更换维度后重新索引即可，无需迁移 PostgreSQL 列。页面的 `postgres_dimensions` 在 Qdrant 模式返回 null。仅未配置 Qdrant 的旧 pgvector 模式固定数据库向量列维度，修改时仍需迁移列及 HNSW 索引。

## 接口

- `GET /api/models`：读取脱敏配置、revision、配置来源、是否可保存和 PostgreSQL 维度。
- `PUT /api/models`：带 revision 保存配置（原三项必填，image/video 可选；省略时保留旧创作配置），返回脱敏配置及 `reindex_required`。
- `POST /api/models/discover`：发送 `{kind, revision, config}`，从服务商 `GET /models` 获取去重、排序后的模型 ID；kind 支持 chat/embedding/vision/image/video。旧密钥仅在原地址使用；换地址须输入新 Key 或明确清除旧 Key。发现失败可手填。
- `POST /api/models/test`：发送 `{kind, revision, config}`，返回 `{success, message, latency_ms, dimensions}`；模型调用失败仍返回 HTTP 200 和 `success:false`，配置字段无效返回 400，权限不足返回 403，版本冲突返回 409。

完整请求结构见 `docs/openapi.json`。

生图与视频配置位于「设置 → 生图与视频」，复用同一加密与 revision 机制。媒体模型测试只验证列表与模型存在，不提交付费生成；详见 [创作台](studio.md)。

## 统一设置与多创作模型

所有模型入口统一在侧边栏「设置」；「问答与检索」管理问答、向量、视觉三类，「生图与视频」管理媒体模型目录，「对象存储」配置 MinIO。系统状态只展示能力，创作台只切换使用中的模型。切换分类前若有未保存编辑，会提示先保存或放弃修改，避免丢失表单。

`GET/PUT /api/models` 增加 `media_models`（最多 40 项 `{id,name,kind,config}`）、`default_image_id` 与 `default_video_id`。媒体秘密按配置 ID 加密保存，不回传；`POST /api/models/discover` 和 `/test` 通过可选 `config_id` 使用该配置的已保存密钥，新的 UUID 无密钥时不继承别的模型。原 `image/video` 字段作为默认配置兼容保留。旧请求省略目录时保留目录，旧密文加载自动兼容，省略旧字段并提交目录则由目录决定默认配置。
