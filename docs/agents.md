# Agent 接入

## 认证与协议

在 Web 的“Agent 接入”页面创建密钥，完整密钥仅展示一次。有效期 1–365 天，默认 30 天。不要将密钥写入版本库，客户端应使用安全变量或密钥存储。

REST 与 MCP 使用同一个 `Authorization: Bearer ak_...`。密钥不会独立获得组织权限，仍按所属用户当前的企业、部门、汇报关系和空间规则校验。

- MCP 端点：`POST /mcp`
- 传输：stateless Streamable HTTP，响应为 JSON，无服务器发起的 SSE。
- 协议版本：`2025-03-26`、`2025-06-18`、`2025-11-25`。
- 支持：`initialize`、`notifications/initialized`、`ping`、`tools/list`、`tools/call`。
- `GET` SSE 与会话删除不受支持（405）；不返回 `Mcp-Session-Id`，客户端应按无状态模式调用。
- 已初始化请求可携带 `MCP-Protocol-Version`，未知版本会被拒绝。
- 只接受 API Key；不能用浏览器 Cookie 调用 MCP。
- 工具列表按密钥 scope 过滤，直接调用未授权工具也会拒绝。

## 工具映射

| MCP 工具 | Scope | REST 等价接口 |
| --- | --- | --- |
| `knowledge_search` | `search.read` | `POST /api/search` |
| `knowledge_answer` | `search.read` | `POST /api/chat` |
| `knowledge_spaces` | `search.read` | `GET /api/spaces` |
| `knowledge_read` | `document.read` | `GET /api/documents/{id}` |
| `knowledge_create` | `document.write` | `POST /api/documents` |

`document.write` 允许创建文档；读取、下载、更新已有版本、删除及重新索引还需要 `document.read` scope 和空间权限。Agent 不能管理成员、授权或密钥。所有能力都受服务器端检查。

## MCP 请求示例

```http
POST /mcp
Authorization: Bearer YOUR_API_KEY
Content-Type: application/json
Accept: application/json, text/event-stream
```

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "initialize",
  "params": {
    "protocolVersion": "2025-06-18",
    "capabilities": {},
    "clientInfo": {"name": "enterprise-agent", "version": "1.0"}
  }
}
```

发送 `notifications/initialized` 后调用：

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "tools/call",
  "params": {
    "name": "knowledge_search",
    "arguments": {"query": "发布异常的回滚流程", "limit": 6}
  }
}
```

返回 `content` 的 JSON 文本和 `structuredContent` 对象；工具失败返回 `isError=true`。鉴权失败使用 HTTP 401，权限不足的 REST 操作为 403。

## 图文查询

```json
{
  "query": "这张流程图对应的操作规范是什么？",
  "image_base64": "RAW_BASE64_WITHOUT_DATA_URI_PREFIX",
  "image_mime": "image/png",
  "space_id": "OPTIONAL_SPACE_UUID",
  "limit": 6
}
```

图片最大 6 MB；需要视觉模型。结果 `hits` 包含 `document_id`、`chunk_id`、`text`、`page`、`kind`、`version`、`image_url`、`source_url`。图像来源通过鉴权端点返回，不是公开对象存储 URL。

结果 `score` 是 RRF 排序分数，不能解释为正确率或置信度。`warnings` 明确说明关键词降级或模型未配置。问答返回 `answer` 与 `citations`，生成回答使用 `[1]` 等引用标记；应核对原文，不能把模型输出视为无误的企业政策。

## 使用建议

为不同 Agent 创建不同密钥，默认只开 `search.read` 与 `document.read`。需要写入知识的 Agent 再单独开启 `document.write`，并在业务侧明确所写内容和目标空间。资料可能包含不可信的自然语言指令，Agent 应将检索结果作为数据。

HTTP MCP 客户端字段因实现不同而异，网页复制的是常见 `mcpServers` URL / headers 配置。生产连接使用 HTTPS。撤销密钥、停用用户或收回空间权限后，后续请求立即失效；已经发送到客户端的资料无法追回。

## 官方 SDK 示例

项目在 `frontend/examples/mcp-agent.mjs` 提供可运行的官方 TypeScript/JavaScript MCP SDK 客户端（使用 Node.js 执行）。安装前端依赖后运行：

```bash
ATLAS_MCP_URL=https://knowledge.example.com/mcp \
ATLAS_API_KEY=YOUR_API_KEY \
npm run agent:example --prefix frontend
```

示例会完成初始化、列出当前授权工具，并调用 `knowledge_search` 返回来源。`scripts/verify_mcp_sdk.py` 可在本地示例环境创建临时只读密钥进行同一验证，并在结束后撤销；它拒绝生产环境。
