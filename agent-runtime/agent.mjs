import { createHarness, cleanMessages } from "./harness.mjs";
import { createTextOutput } from "./stream-output.mjs";
import { Agent } from "@earendil-works/pi-agent-core";
import { createModels, createProvider } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { createPlatformTools } from "./platform-tools.mjs";
import { createInterface } from "node:readline";

const input = createInterface({ input: process.stdin, terminal: false });
const pending = new Map();
const ioController = new AbortController();
let activeAgent;
let activeHarness;
process.stdout.on("error", () => process.exit(1));
input.on("close", () => {
  ioController.abort();
  activeAgent?.abort();
});
let initialized = false;
function output(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}
function request(type, data, signal) {
  signal = AbortSignal.any([ioController.signal, ...(signal ? [signal] : [])]);
  return new Promise((resolve, reject) => {
    const id = crypto.randomUUID();
    const cancel = () => {
      pending.delete(id);
      reject(new Error("Agent cancelled"));
    };
    if (signal?.aborted) {
      cancel();
      return;
    }
    signal?.addEventListener("abort", cancel, { once: true });
    pending.set(id, (result) => {
      signal?.removeEventListener("abort", cancel);
      resolve(result);
    });
    output({ type, id, ...data });
  });
}
function tool(name, description, parameters) {
  return {
    name,
    label: name,
    description,
    parameters,
    executionMode: "sequential",
    execute: async (_id, args, signal) => {
      const cached = await activeHarness?.cached(name, args, _id, signal);
      if (cached) return cached;
      const result = await request(
        "tool_call",
        { call_id: _id, name, args },
        signal,
      );
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result.data ?? { error: result.error }),
          },
        ],
        details: {},
        isError: !result.ok,
      };
    },
  };
}
async function run(config) {
  if (config.resume?.runtime?.engine === "deepseek-harness") {
    throw new Error("Existing checkpoint belongs to DeepSeek Harness");
  }
  const model = {
    id: config.model,
    name: config.model,
    provider: "atlas",
    api: "openai-completions",
    baseUrl: config.base_url,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: config.context_window ?? 32768,
    maxTokens: config.max_output_tokens ?? 5000,
    compat: {
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
      maxTokensField: "max_tokens",
      supportsUsageInStreaming: false,
    },
  };
  const models = createModels();
  models.setProvider(
    createProvider({
      id: "atlas",
      name: "Atlas configured model",
      baseUrl: config.base_url,
      auth: {
        apiKey: {
          name: "Atlas",
          resolve: async () => ({
            auth: { apiKey: config.api_key || "keyless" },
          }),
        },
      },
      models: [model],
      api: openAICompletionsApi(),
    }),
  );
  const tools = createPlatformTools(config, tool);
  const messages = (config.history ?? []).map((m) =>
    m.role === "user"
      ? { role: "user", content: m.content, timestamp: Date.now() }
      : {
          role: "assistant",
          content: [{ type: "text", text: m.content }],
          api: model.api,
          provider: model.provider,
          model: model.id,
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              total: 0,
            },
          },
          stopReason: "stop",
          timestamp: Date.now(),
        },
  );
  const requestOptions = (signal) => ({
    signal: AbortSignal.any([
      ...(signal ? [signal] : []),
      AbortSignal.timeout(config.bot_tools?.enabled ? 300000 : 120000),
    ]),
    maxTokens: model.maxTokens,
    temperature: 0.1,
    ...(config.api_key
      ? {}
      : {
          transformHeaders: (headers) => ({ ...headers, Authorization: null }),
        }),
  });
  const harness = createHarness({
    config,
    model,
    models,
    request,
    options: requestOptions,
    tools,
  });
  const agent = new Agent({
    initialState: {
      systemPrompt: config.system_prompt,
      model,
      tools,
      messages: config.resume
        ? cleanMessages(config.resume.runtime.messages ?? [])
        : messages,
      thinkingLevel: "off",
    },
    toolExecution: "sequential",
    streamFn: (model, context, options) =>
      models.streamSimple(model, context, {
        ...options,
        ...requestOptions(options?.signal),
      }),
    prepareRequest: harness.prepareRequest,
    afterToolCall: harness.afterToolCall,
    finishTurn: harness.finishTurn,
  });
  activeAgent = agent;
  activeHarness = harness;
  harness.attach(agent);
  const textOutput = createTextOutput(
    output,
    Boolean(config.bot_tools?.enabled),
  );
  agent.subscribe(textOutput.onEvent);
  agent.subscribe(harness.onEvent);
  const heartbeat = config.bot_tools?.enabled
    ? setInterval(() => output({ type: "heartbeat" }), 15000)
    : null;
  const timer = config.bot_tools?.enabled
    ? null
    : setTimeout(() => agent.abort(), 240000);
  try {
    if (config.resume) {
      await harness.restorePending(AbortSignal.timeout(180000));
      // Fresh approval outcomes and current artifact directory are server-owned data.
      if (
        config.resume_note ||
        agent.state.messages.at(-1)?.role === "assistant"
      )
        await agent.prompt(
          config.resume_note ||
            "从已保存进度继续完成原始任务；已完成的操作不要重复。",
        );
      else await agent.continue();
    } else await agent.prompt(config.query);
    let last = agent.state.messages
      .filter((m) => m.role === "assistant")
      .at(-1);
    if (
      last?.stopReason === "error" &&
      /context.{0,30}(length|window|limit)|maximum context|too many tokens|token.{0,20}limit/i.test(
        last.errorMessage ?? "",
      )
    ) {
      await harness.overflowRetry(
        AbortSignal.timeout(config.bot_tools?.enabled ? 300000 : 120000),
        last.errorMessage ?? "",
      );
      await agent.continue();
      last = agent.state.messages.filter((m) => m.role === "assistant").at(-1);
    }
    if (harness.paused || harness.yielded) {
      output({
        type: harness.paused ? "paused" : "yield",
        reason: harness.paused
          ? "工具重复调用且没有新增进展，已保存进度，请调整任务后继续。"
          : "已保存进度，任务将自动续接。",
        turns: harness.turns,
      });
      return;
    }
    if (!last || ["error", "aborted"].includes(last.stopReason)) {
      if (config.diagnostics)
        output({
          type: "diagnostic",
          stop_reason: last?.stopReason,
          timeout: /abort|timeout|timed out/i.test(last?.errorMessage ?? ""),
          context_overflow:
            /context.{0,30}(length|window|limit)|too many tokens/i.test(
              last?.errorMessage ?? "",
            ),
          tool_format: /tool|function|schema|parameter/i.test(
            last?.errorMessage ?? "",
          ),
          usage: last?.usage
            ? {
                input: last.usage.input,
                output: last.usage.output,
                totalTokens: last.usage.totalTokens,
              }
            : null,
        });
      throw new Error("Agent inference failed");
    }
    const answer = last.content
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("\n")
      .trim();
    if (!answer || last.content.some((c) => c.type === "toolCall"))
      throw new Error("Agent did not finish an answer");
    output({
      type: "result",
      answer,
      turns: harness.turns,
      compactions: harness.compactions,
      engine: "pi-agent-core",
    });
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    textOutput.dispose();
    if (timer) clearTimeout(timer);
    input.close();
  }
}
input.on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    output({ type: "error", error: "Agent protocol error" });
    input.close();
    return;
  }
  if (!initialized) {
    initialized = true;
    run(message).catch(() => {
      output({
        type: "error",
        error:
          "Pi Agent 问答未完成，请检查模型是否支持流式输出和工具调用，或稍后重试",
      });
      input.close();
    });
  } else if (["tool_result", "checkpoint_ack"].includes(message.type)) {
    const resolve = pending.get(message.id);
    pending.delete(message.id);
    resolve?.(message);
  }
});
