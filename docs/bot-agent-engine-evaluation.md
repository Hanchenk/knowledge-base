# DeepSeek Harness 接入评估

结论：可以把 DeepSeek Harness 作为知小汇的任务执行引擎。现有 Rust 后端继续管理任务、当前账号权限、工具授权、审批、成果和浏览器 SSE，新增执行器适配层连接 DSH。生产当前仍使用已修复的 Pi Agent，尚未迁移到 DSH。

本次核对官方仓库 `master` 的提交 `d743267388641bc76f17c45ce8b4c231aed1d32c`，读取 SDK、ACP、压缩、持久化文档及 agent-loop / SDK 协议源码。Git clone 因网络停滞终止，改用 GitHub API 与固定提交的原始文件完成接口核对；没有安装依赖、运行 DSH 或做性能对比。

## 接入方式

```mermaid
flowchart LR
    UI[知小汇对话界面] --> API[Rust API 与任务队列]
    API --> Worker[独立 Worker]
    Worker --> Adapter[DSH 执行器适配层]
    Adapter --> DSH[DeepSeek Harness ACP]
    DSH --> Tools[带当前任务身份的 MCP 工具桥]
    Tools --> Services[知识库 ACL / 网页 / 沙箱 / 审批 / 成果]
```

`git clone` 取得源码后，还需要安装、构建和后台协议适配。平台继续沿用自己的界面；`dsh web` 是 DSH 自带网页应用，接入当前平台应选后台协议。

| 方式 | 已核对的能力 | 对知小汇的影响 |
|---|---|---|
| TypeScript SDK | stdio JSON-RPC；`DeepSeekHarness.run()`；会话事件与执行状态 | 接入调用简单，但当前协议没有中途取消方法、没有服务端请求客户端批准的能力；取消需要关闭进程 |
| ACP | 创建/列举/恢复/关闭会话、取消、权限请求、stdio 与 Streamable HTTP MCP、语义更新 | 更贴合现有取消、审批、授权工具和跨进程恢复需求；建议作为第一条集成路径 |

ACP 不提供 DSH 内置计划、终端等展示协议，也不提供原始模型 token 增量和历史更新重播。平台的计划、成果和审批通过授权工具桥维护；增量文字如需保留现有逐块体验，需增加受控事件插件或其他明确的输出桥。ACP 更新包含 thoughts，浏览器输出仍须仅选择公开 assistant 文本。

ACP `authenticate` 直接成功，面向可信程序。它不能代替平台登录和多租户访问控制；控制协议应保持在后台进程间使用。

## 执行与状态

DSH 的会话持久化、检查点、自动压缩可以承担原 Pi 适配器的一部分工作，但必须明确状态归属。

- Rust 的任务状态、租约和授权仍决定某次执行是否有效；取消或撤权后工具桥拒绝后续写入。
- 为每个私有任务绑定独立会话身份、工作目录和受限执行环境。知识库工具每次以当前用户和当前资料版本核验权限。
- DSH 会话存储与平台任务 ID 建立持久映射，保存会话日志，验证重启后的恢复。SDK 的 `idle` 或存在最终文字不等于任务成功，仍要检查结束原因、计划和实际成果。
- 外部写入继续使用已有操作 ID、审批和幂等控制，避免恢复后重复执行。
- 研究证据覆盖、事实笔记、无新增资料检测和交付验收仍作为平台任务策略保留。压缩解决上下文容量，不能单独保证任务推进。

## 自动压缩与模型

`dsh-compaction-basic` 支持容量压力压缩、上下文溢出恢复、近期完整消息保留，以及可选的大工具输出裁剪。官方 base profile 默认启用压缩；自定义 profile 必须确认相关插件、token 测量和持久化组成完整。

默认 `headroomTokens=65536`，小上下文模型必须调整。知小汇当前保守上下文配置是 32768，不能直接照搬该默认余量。应按实际模型适配器提供的容量、输出预留和摘要预算配置精确的模型策略。

执行引擎与模型提供商可以分别选择。DSH 提供 DeepSeek 适配器及 `llm-pi-ai` 适配层；使用 Pi 的模型接入库与使用 Pi 的智能体执行循环是不同的选择。保留现有模型需验证准确路由、工具格式、输出、容量和凭据配置。

## 迁移验收

先增加 `pi` / `deepseek-harness` 可切换的执行器选择，为新测试任务启用 DSH；旧检查点继续由原引擎恢复。通过相同研究题比较首次草稿耗时、总耗时、重复来源读取、引用准确度、完整报告交付和模型成本。

验收还需覆盖取消、撤权、服务重启、审批暂停/续接、外部写入去重、多个账号隔离和公开流式输出。当前仅完成源代码接口评估，尚不能宣称 DSH 在这些场景已通过或比现有实现更快。

官方 README 标明 developer preview、可能出现兼容性破坏；接入时固定版本和提交，保留执行器切换及回滚能力。

## 来源

- [官方 README](https://github.com/deepseek-ai/deepseek-harness/blob/d743267388641bc76f17c45ce8b4c231aed1d32c/README.md)
- [TypeScript SDK 及限制](https://github.com/deepseek-ai/deepseek-harness/blob/d743267388641bc76f17c45ce8b4c231aed1d32c/packages/sdk/client/README.md)
- [ACP 接口及限制](https://github.com/deepseek-ai/deepseek-harness/blob/d743267388641bc76f17c45ce8b4c231aed1d32c/packages/acp/acp/README.md)
- [压缩配置与默认值](https://github.com/deepseek-ai/deepseek-harness/blob/d743267388641bc76f17c45ce8b4c231aed1d32c/packages/compaction/compaction-basic/README.md)
- [会话持久化](https://github.com/deepseek-ai/deepseek-harness/blob/d743267388641bc76f17c45ce8b4c231aed1d32c/packages/session/README.md)
- [模型适配层](https://github.com/deepseek-ai/deepseek-harness/blob/d743267388641bc76f17c45ce8b4c231aed1d32c/packages/llm/llm-pi-ai/README.md)
