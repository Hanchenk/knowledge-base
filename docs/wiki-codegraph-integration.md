# Wiki 与 CodeGraph 接入

实现对应 TencentDB-Agent-Memory `274e549069ad780e411d70e6fff51f6a977d81d3` 的 MemoryKnowledge v3 API。知小汇保存私有知识资产、来源版本和构建队列；Wiki 提炼、页面检索、代码建图与调用关系查询实际交给 MemoryKnowledge。接口未配置时资产列表正常返回，创建明确返回 503；不会生成假索引或把当前知识库检索结果伪装成 Wiki / CodeGraph。

## 使用

在 bot 的记忆与知识管理中创建知识资产。Wiki 选择已有资料；CodeGraph 填写公开 GitHub 仓库的 HTTPS 地址。等待状态从 `queued`、`building` 变为 `ready` 后，可在管理页检索或查看页面、代码符号、调用者、被调用者和影响范围。任务选择知识资产后，Pi 与 DeepSeek Harness 使用同一组后端工具。

Wiki 来源限定为用户当前有权读取的资料，最多 20 份，总解析文本不超过 4 MB。上传内容来自当前版本的已解析 chunks，包含原始文档 ID、版本与页码；文件拆分按 UTF-8 边界，分批调用 `wiki/raw/write`，再调用 `wiki/ingest`，后台轮询 `wiki/get`。同步重建 Wiki，以免旧原文或派生页面残留。文档更新后旧 Wiki 检索返回 409，必须同步；资料删除或授权撤销后检索被阻止，调用服务期间发生的撤权也会在返回内容前再次检查。

CodeGraph 首期只支持 `https://github.com/组织/仓库[.git]`。拒绝 SSH、凭据、查询参数、任意域名、IP 和 localhost。后台通过固定 GitHub API 验证仓库公开性、当前 clone URL 与默认分支，再调用 `code-graph/create`。同一用户不能重复添加尚未完成删除的同一仓库。同步默认调用 `code-graph/sync`；默认分支改变时重建。读取代码时验证仓库公开性，成功检查缓存 30 秒以减少 GitHub API 限流；构建和同步始终重新检查。初期不支持私有仓库，也不会转发用户访问令牌。

所有资产均按 `tenant_id + user_id` 私有隔离。上游 service namespace 固定为服务端配置，team / user / agent 身份由后端哈希生成；客户端只能提交知小汇自己的资产 ID。MemoryKnowledge 的知识 ID、工具调用 URL、资料身份都不能由浏览器指定。资源删除先写 tombstone，立即停止检索，再后台调用上游 delete；服务故障时持续重试清理。

远端创建请求发出前先保存待确认回执。创建响应超时或丢失时，后台用本人 team 下的唯一 Wiki 名称或仓库与分支核验真实资源，再删除已确认的资源。上游列表暂时为空不会被视为清理成功；此时保留 `deleting` 与待核验提示，避免原创建稍后完成而遗漏清理。队列每 30 秒续约，长时间构建不会让另一 worker 接管仍在执行的任务。

## 服务配置

已有独立服务时设置：

```dotenv
MEMORY_CORE_URL=https://内部记忆网关
MEMORY_CORE_TOKEN=服务端访问令牌
MEMORY_KNOWLEDGE_URL=https://内部知识网关
MEMORY_KNOWLEDGE_TOKEN=服务端访问令牌
MEMORY_SERVICE_ID=zhixiaohui
```

URL 是服务根地址，不包含 `/v3`；后端追加实际 API 路径。可使用内部 HTTP 地址，浏览器不连接这些地址。API 与独立 worker 必须使用同一份配置。MemoryKnowledge 的 Wiki ingest 需要可用模型；单纯 CodeGraph 无需模型。

MemoryKnowledge 上游的 `KNOWLEDGE_SERVICE_KEY` 只保护写操作，其只读 API 默认放行。因此必须通过受鉴权的内部网关访问，并避免把上游容器端口直接发布到宿主机或公网。本项目附带的 Caddy 网关对全部数据路由检查服务 Bearer Token；仅 `/health` 放行。

## 可选 Docker Compose 部署

先取得固定版本源码：

```bash
git clone https://github.com/TencentCloud/TencentDB-Agent-Memory.git /srv/TencentDB-Agent-Memory
git -C /srv/TencentDB-Agent-Memory checkout 274e549069ad780e411d70e6fff51f6a977d81d3
```

在现有部署 `.env` 中增加（令牌使用独立随机值）：

```dotenv
TENCENTDB_AGENT_MEMORY_SOURCE=/srv/TencentDB-Agent-Memory
MEMORY_CORE_TOKEN=填写独立随机令牌
MEMORY_KNOWLEDGE_TOKEN=填写另一个独立随机令牌
MEMORY_SERVICE_ID=zhixiaohui
MEMORY_LLM_BASE_URL=https://模型服务/v1
MEMORY_LLM_API_KEY=填写模型凭据
MEMORY_LLM_MODEL=填写可用模型名
```

```bash
docker compose -f compose.yaml -f deploy/compose.tencent-memory.yaml config --quiet
docker compose -f compose.yaml -f deploy/compose.tencent-memory.yaml up -d --build
```

附加部署启动 MemoryCore、MemoryKnowledge、受鉴权的内部 Caddy 网关，给 API / worker 注入对应地址，并持久化两个上游数据卷。上游不发布宿主端口。持久化卷需要随知小汇数据库一同备份，否则数据库中的资产 ID 可能指向已经丢失的上游资源。

Git 配置关闭 HTTP 重定向并仅允许 HTTPS 协议，禁用交互凭据与系统 / 用户 Git 配置。部署侧应限制知识服务出口到 GitHub 和管理员配置的模型地址；知小汇 URL 白名单不替代网络出口规则。此覆盖文件提供独立出口网络，实际出口白名单应由部署网络策略实现。

当前个人记忆接入使用 MemoryCore 持久化审核后的记忆，召回排序仍由知小汇的关键词规则完成；即使配置 MemoryCore 的 embedding 服务，也不会自动启用知小汇的向量混合召回。未来接入混合召回需要补充查询适配层，并按上游配置挂载 `tdai-gateway.yaml`、设置真实的 embedding 服务、模型及维度。API 的向量设置不会自动传递给 MemoryCore。上游实例内队列属于单机模式；多个 MemoryCore / MemoryKnowledge 副本共享数据卷并不构成可靠的生产集群。

## 接口与验证

知小汇接口：

| 操作 | 接口 |
| --- | --- |
| 列表 / 创建 | `GET / POST /api/bot/knowledge/assets` |
| 详情 / 删除 | `GET / DELETE /api/bot/knowledge/assets/{id}` |
| 重新同步 | `POST /api/bot/knowledge/assets/{id}/sync` |
| 关键词检索 | `POST /api/bot/knowledge/assets/{id}/search`，`{query}` |
| 只读查询工具 | `POST /api/bot/knowledge/assets/{id}/tools`，`{name,arguments}` |

任务工具为 `wiki_search`、`wiki_read`、`code_graph_search`、`code_graph_read`、`code_graph_callers`、`code_graph_callees`、`code_graph_impact`，都需要当前任务选中的 `asset_id`。知识工具结果是外部资料，不能扩大执行权限。

集成测试使用真正的本地 HTTP provider fixture 验证 v3 请求、服务令牌、隔离身份、Wiki 当前版本内容上传、所有权、任务选择限制、撤权发生在查询途中、来源更新、tombstone 和远端删除失败重试。仓库 URL 与只读参数另有边界测试。完整上游模型提炼、真实仓库建图耗时和实际部署镜像构建仍需配置服务后执行验收；测试 fixture 不代表这些模型或索引效果已验证。
