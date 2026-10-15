# 飞书应用连接器

知小汇已部署飞书官方远程 MCP 的 OAuth 动态注册与 PKCE 连接流程。用户无需填写 App ID、App Secret、API 地址或 Token。

当前生产连接尚未联通：飞书动态注册接口拒绝当前内网回调，返回 HTTP 400 `invalid_redirect_uri`。知小汇目前没有既有 HTTPS 地址，需要先确认飞书接受的回调地址以及浏览器可达性，再验证完整授权流程；仅使用 HTTPS 不能保证连接成功。本次部署保留原网络与配置。

## 使用

以下步骤以部署已具备飞书接受的回调地址为前提，当前生产仍停在注册阶段。

1. 在输入栏打开「更多」→「应用连接器」，点击「连接飞书」。
2. 浏览器跳转到飞书官方授权页面，由本人确认授权。
3. 授权后返回知小汇，系统自动保存连接。原任务、草稿和已选项恢复。
4. 在任务的应用连接器中选择飞书，再要求 bot 检索或读取飞书文档。

连接不会自动授权所有任务使用飞书，也不会自动提交草稿。取消或连接失败时，返回页面仍保留原草稿。授权前需要浏览器会话存储可用，避免跳转后丢失输入。

首期开放文档搜索、读取正文、列举文档与知识库节点，以及当前飞书用户信息。实际工具名称与参数以飞书返回的工具目录为准。飞书本身的文档权限仍然生效；当前不提供发送消息、修改文档或日程写入。

连接失效后点击「重新授权」；断开连接会禁用连接器并删除本地保存的令牌。现有自定义连接器保留为次级入口，原有外部写入审核规则继续适用。

## 接入方式

官方发现接口：

- [受保护资源元数据](https://mcp.feishu.cn/.well-known/oauth-protected-resource/mcp)
- [授权服务器元数据](https://accounts.feishu.cn/.well-known/oauth-authorization-server/mcp)
- [飞书 MCP 说明](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/mcp_integration/mcp_introduction)
- [支持的工具](https://open.feishu.cn/document/mcp_open_tools/supported-tools)

固定资源为 `https://mcp.feishu.cn/mcp`，授权入口为 `https://accounts.feishu.cn/oauth/v2/mcp/authorize`，令牌接口为 `https://accounts.feishu.cn/oauth/v3/token`，客户端动态注册接口为 `https://open.feishu.cn/open-apis/app/v1/dcr`。采用 Public Client、S256 PKCE 和授权码流程，不使用自建应用密钥。

回调地址由部署的 `PUBLIC_URL` 加 `/api/bot/connectors/feishu/callback` 生成。回跳由用户浏览器完成，浏览器需要能访问知小汇所在内网。飞书是否接受具体回调地址，以动态注册与授权结果为准；公开 metadata 本身不能证明授权已经完成。

只申请 `offline_access`、`mcp-tool:common:get-user`、`mcp-tool:docs:search-doc`、`mcp-tool:docs:fetch-doc`、`mcp-tool:docs:list-docs-v2`。工具端采用确认过的只读名称白名单；远端 annotations 或工具内容不能扩大权限。Token 仅用于飞书 MCP，不作为普通飞书 OpenAPI 用户令牌使用。

## 数据与验证边界

动态注册的客户端按企业及固定回调保存。OAuth state 短时有效、单次消费，并绑定知小汇用户、企业和浏览器会话；PKCE verifier 保存在服务端。授权与刷新令牌加密保存，不回传浏览器或模型，刷新串行处理旋转令牌。OAuth 初次 callback 按协议携带 code/state；处理后最终回到 `/app` 的地址不包含飞书令牌或授权码。

工具调用仍需当前任务明确选择连接器，并校验所有者。服务端只连接固定飞书官方 HTTPS 主机，不接收任意 MCP 地址或工具名称，不自动跟随重定向。接口支持有界 JSON 与 SSE 响应。

自动化验证使用隔离账户和模拟飞书服务；实际用户授权需要本人在飞书页面完成。生产部署和四种界面检查已通过，但真实注册被拒；尚未打开官方授权页，也未验证生产取消回调、个人授权、授权码兑换或文档读取。生产验证边界另见发布记录。
