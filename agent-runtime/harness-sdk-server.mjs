// Preserve the upstream SDK wire and its event/lifecycle behavior while adding
// persisted root-session resume through the official AgentRegistry.resume API.
// The SDK's createSession hook is pinned to the installed release and checked
// before updates are activated; a changed hook fails closed.
import { HarnessSdkJsonRpcServer } from "@deepseek-ai/dsh-sdk-jsonrpc-server";
import { JsonRpcLineTransport } from "@deepseek-ai/dsh-sdk-protocol";

export const name = "zhixiaohui-sdk-server";
export const inject = [
  "agents",
  "sessionPersistence",
  "sdkAppStartup",
  "loader",
  "tools",
];
export class CloudSdkServer extends HarnessSdkJsonRpcServer {
  async createSession(sessionId) {
    if (
      typeof HarnessSdkJsonRpcServer.prototype.createSession !== "function" ||
      !(this.sessions instanceof Map)
    )
      throw new Error("当前Harness SDK版本的持久会话接口不兼容");
    const agentOptions = {
      provider: this.provider,
      model: this.model,
      ...(this.reasoningEffort === undefined
        ? {}
        : { reasoningEffort: this.reasoningEffort }),
      ...(this.maxTokens === undefined ? {} : { maxTokens: this.maxTokens }),
    };
    const stored = await this.ctx.sessionPersistence.stat(sessionId);
    const handle = stored
      ? await this.ctx.agents.resume({
          resumeSessionId: sessionId,
          agentOptions,
        })
      : await this.ctx.agents.create({
          sessionId,
          meta: { cwd: this.cwd },
          agentOptions,
        });
    const record = { handle };
    this.sessions.set(sessionId, record);
    return record;
  }
}
export function apply(ctx) {
  const transport = new JsonRpcLineTransport(process.stdin, process.stdout);
  const server = new CloudSdkServer(ctx, transport, {
    maxTokensAsSuccess: false,
  });
  let exitTask;
  transport.onRequest(async (method, params) => {
    if (method === "initialize") {
      await ctx.loader.await();
      if (!ctx.tools.get("knowledge_search"))
        throw new Error("知小汇平台工具未能加载，停止Harness任务");
    }
    const result = await server.handleRequest(method, params);
    if (method === "shutdown")
      setImmediate(() => {
        exitTask ??= (async () => {
          await transport.flush();
          await ctx.root.fiber.dispose();
          process.exit(0);
        })();
      });
    return result;
  });
  ctx.effect(() => {
    transport.start();
    return async () => {
      await server.shutdown();
      transport.close();
    };
  }, "cloud-sdk.serve");
}
