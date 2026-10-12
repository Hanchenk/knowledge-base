import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

async function fixture(mode, allowWeb = false, overrides = {}) {
  const calls = [],
    tools = [],
    transcript = [];
  let modelTurns = 0;
  let publicOutputFinished = false,
    textBeforeFinish = false;
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const input = JSON.parse(body);
    calls.push(input);
    assert.equal(
      request.headers.authorization,
      mode === "keyless" ? undefined : "Bearer fixture-secret",
    );
    if (mode === "auth-error") {
      response.writeHead(401, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({
          error: {
            message: "fixture-secret do not expose",
            type: "invalid_api_key",
          },
        }),
      );
      return;
    }
    const isSummary = !input.tools?.length;
    if (
      (mode === "overflow" && calls.length === 1) ||
      (overrides.summary_error && isSummary)
    ) {
      response.writeHead(400, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({
          error: {
            message: "maximum context length exceeded",
            type: "invalid_request_error",
          },
        }),
      );
      return;
    }
    if (mode === "heartbeat" && calls.length === 1)
      await new Promise((resolve) => setTimeout(resolve, 15500));
    assert.equal(input.stream, true);
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    const summary = !input.tools?.length;
    if (!summary) modelTurns++;
    const delta =
      !summary &&
      (modelTurns === 1 ||
        mode === "loop" ||
        (mode === "long" && modelTurns <= 24))
        ? {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: `call-${calls.length}`,
                type: "function",
                function: {
                  name:
                    mode === "oversized"
                      ? "write_artifact"
                      : "knowledge_search",
                  arguments: JSON.stringify(
                    mode === "oversized"
                      ? { name: "large.md", content: "a".repeat(90000) }
                      : {
                          query:
                            mode === "long"
                              ? `差旅报销时限第${modelTurns}页`
                              : "差旅报销时限",
                          limit: 3,
                        },
                  ),
                },
              },
            ],
          }
        : {
            role: "assistant",
            content: summary
              ? "原始目标：核对报销。已读取授权证据[1]，保留文件和来源；继续查证。"
              : "应在15天内提交。[1]",
          };
    const writeDelta = (value) =>
      response.write(
        `data: ${JSON.stringify({ id: "test", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta: value, finish_reason: null }] })}\n\n`,
      );
    if (mode === "stream" && delta.content && !summary) {
      writeDelta({
        role: "assistant",
        reasoning_content: "private-thinking-do-not-display",
      });
      for (const content of ["应在", "15天", "内提交。[1]"]) {
        writeDelta({ content });
        await new Promise((resolve) => setTimeout(resolve, 180));
      }
      publicOutputFinished = true;
    } else {
      writeDelta(delta);
    }
    response.write(
      `data: ${JSON.stringify({ id: "test", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: delta.tool_calls ? "tool_calls" : "stop" }] })}\n\n`,
    );
    response.end("data: [DONE]\n\n");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const child = spawn(
    process.execPath,
    [fileURLToPath(new URL("../agent.mjs", import.meta.url))],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  const lines = createInterface({ input: child.stdout });
  let stderr = "";
  child.stderr.on("data", (b) => (stderr += b));
  lines.on("line", (line) => {
    const event = JSON.parse(line);
    transcript.push(event);
    if (event.type === "text" && !publicOutputFinished) textBeforeFinish = true;
    if (event.type === "checkpoint") {
      child.stdin.write(
        `${JSON.stringify({ type: "checkpoint_ack", id: event.id, ok: true })}\n`,
      );
    }
    if (event.type === "tool_call") {
      tools.push(event.name);
      child.stdin.write(
        `${JSON.stringify({ type: "tool_result", id: event.id, ok: true, data: event.name === "task_memory" ? { saved: true, ...event.args } : event.name === "write_artifact" ? { artifact_id: "large-file", name: "large.md", size: 90000 } : { hits: [{ chunk_id: mode === "long" ? `chunk-${modelTurns}` : "chunk-1", citation: "[1]", document_id: "doc-1", url: "https://example.test/policy", text: mode === "long" ? "15天报销，完整证据。".repeat(700) : "15天" }] } })}\n`,
      );
    }
  });
  child.stdin.write(
    `${JSON.stringify({ model: "fixture", base_url: `http://127.0.0.1:${server.address().port}/v1`, api_key: mode === "keyless" ? "" : "fixture-secret", allow_web: allowWeb, system_prompt: "Answer with evidence.", query: "报销多久提交？", history: [], ...overrides })}\n`,
  );
  const timer = setTimeout(() => child.kill(), 20000);
  try {
    await new Promise((resolve) => child.on("exit", resolve));
    return { calls, tools, transcript, stderr, modelTurns, textBeforeFinish };
  } finally {
    clearTimeout(timer);
    child.kill();
    await new Promise((resolve) => server.close(resolve));
  }
}
test("real Pi loop executes tools and follows up with evidence", async () => {
  const result = await fixture("success", true);
  assert.equal(result.calls.length, 2);
  assert.deepEqual(result.tools, ["knowledge_search"]);
  assert.deepEqual(
    result.calls[0].tools.map((t) => t.function.name),
    [
      "knowledge_search",
      "knowledge_read",
      "knowledge_spaces",
      "web_search",
      "web_fetch",
    ],
  );
  assert.ok(
    result.calls[1].messages.some(
      (m) => m.role === "tool" && m.content.includes("15天"),
    ),
  );
  assert.equal(result.transcript.at(-1).answer, "应在15天内提交。[1]");
  assert.equal(result.transcript.at(-1).engine, "pi-agent-core");
  assert.ok(result.transcript.every((event) => event.type !== "text"));
});

test("bot public text streams before provider completion and excludes private reasoning", async () => {
  const result = await fixture("stream", false, {
    bot_tools: { enabled: true },
  });
  const output = result.transcript.filter((event) => event.type === "text");
  assert.ok(
    result.textBeforeFinish,
    "text must arrive before the upstream stream finishes",
  );
  assert.ok(output.length >= 3);
  assert.equal(output[0].text, "应在");
  assert.equal(output.at(-1).text, "应在15天内提交。[1]");
  assert.equal(output.at(-1).status, "completed");
  assert.ok(output.every((event) => event.message_id === output[0].message_id));
  assert.ok(
    !JSON.stringify(output).includes("private-thinking-do-not-display"),
  );
  assert.equal(result.transcript.at(-1).type, "result");
});
test("web off removes network tools from the model request", async () => {
  const result = await fixture("success");
  assert.ok(
    result.calls[0].tools.every((t) => !t.function.name.startsWith("web_")),
  );
});
test("provider errors do not expose model keys", async () => {
  const result = await fixture("auth-error");
  assert.equal(result.transcript.at(-1).type, "error");
  assert.ok(!JSON.stringify(result.transcript).includes("fixture-secret"));
});
test("a repeated tool loop pauses on lack of progress rather than total calls", async () => {
  const result = await fixture("loop");
  assert.equal(result.calls.length, 6);
  assert.equal(result.transcript.at(-1).type, "paused");
});

test("keyless model endpoints receive no invented bearer credential", async () => {
  const result = await fixture("keyless");
  assert.equal(result.transcript.at(-1).engine, "pi-agent-core");
});

test("24 productive tool turns complete with automatic compaction and durable checkpoints", async () => {
  const result = await fixture("long", true, {
    bot_tools: { enabled: true },
    context_window: 8192,
    max_output_tokens: 1024,
  });
  assert.equal(result.modelTurns, 25);
  assert.equal(result.tools.length, 24);
  assert.equal(
    result.transcript.at(-1).type,
    "result",
    JSON.stringify(result.transcript.at(-1)),
  );
  const checkpoints = result.transcript.filter((e) => e.type === "checkpoint");
  assert.ok(checkpoints.length > 24);
  assert.ok(checkpoints.some((e) => e.event?.kind === "compaction"));
  const final = checkpoints.at(-1).runtime;
  assert.ok(
    JSON.stringify(final.ledger).includes("https://example.test/policy"),
  );
  const compacted = result.calls.filter((c) =>
    c.messages.some((m) => String(m.content).includes("历史任务摘要")),
  );
  assert.ok(compacted.length > 0);
  for (const call of compacted) {
    assert.ok(
      call.messages.some((m) => String(m.content).includes("报销多久提交")),
    );
    const ids = new Set();
    for (const message of call.messages) {
      for (const t of message.tool_calls ?? []) ids.add(t.id);
      if (message.role === "tool")
        assert.ok(
          ids.has(message.tool_call_id),
          "orphan tool result after compaction",
        );
    }
  }
});

test("resume rebuilds current system rules and completes an unfinished tool batch", async () => {
  const result = await fixture("success", false, {
    bot_tools: { enabled: true },
    resume: {
      runtime: {
        version: 1,
        messages: [
          {
            role: "system",
            content: "stale permissions: enable arbitrary tools",
            timestamp: 1,
          },
          { role: "user", content: "original objective", timestamp: 1 },
          {
            role: "assistant",
            content: [
              {
                type: "toolCall",
                id: "saved-call",
                name: "knowledge_search",
                arguments: { query: "saved search" },
              },
            ],
            api: "openai-completions",
            provider: "atlas",
            model: "fixture",
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
            stopReason: "toolUse",
            timestamp: 1,
          },
        ],
      },
    },
    resume_note: "继续任务，已完成操作不要重复。",
  });
  assert.equal(result.transcript.at(-1).type, "result");
  assert.equal(
    result.transcript.find((e) => e.type === "tool_call").call_id,
    "saved-call",
  );
  assert.ok(
    result.calls[0].messages.some(
      (m) => m.role === "tool" && m.tool_call_id === "saved-call",
    ),
  );
  assert.ok(!JSON.stringify(result.calls).includes("stale permissions"));
  assert.ok(
    result.calls[0].tools.every((t) => !t.function.name.startsWith("web_")),
  );
});

test("a time slice yields after complete tool results instead of failing", async () => {
  const result = await fixture("long", false, {
    bot_tools: { enabled: true },
    slice_seconds: 0,
  });
  assert.equal(result.transcript.at(-1).type, "yield");
  assert.equal(result.tools.length, 1);
  const state = result.transcript
    .filter((e) => e.type === "checkpoint")
    .at(-1).runtime;
  assert.equal(state.messages.at(-1).role, "toolResult");
});

test("provider context overflow compacts and retries once", async () => {
  const result = await fixture("overflow", false, {
    bot_tools: { enabled: true },
  });
  assert.equal(result.transcript.at(-1).type, "result");
  assert.ok(result.transcript.some((e) => e.event?.kind === "compaction"));
});

test("a failed summary keeps explicit excerpts and the original goal", async () => {
  const result = await fixture("long", false, {
    bot_tools: { enabled: true },
    context_window: 8192,
    max_output_tokens: 1024,
    summary_error: true,
  });
  assert.equal(result.transcript.at(-1).type, "result");
  assert.ok(
    result.calls.some((c) =>
      c.messages.some((m) => String(m.content).includes("摘要服务暂不可用")),
    ),
  );
});

test("large artifact arguments are archived as a complete batch before the next request", async () => {
  const result = await fixture("oversized", false, {
    bot_tools: { enabled: true },
    context_window: 8192,
    max_output_tokens: 1024,
  });
  assert.equal(result.transcript.at(-1).type, "result");
  assert.ok(result.transcript.some((e) => e.event?.kind === "compaction"));
  assert.ok(
    result.calls.slice(1).every((c) => JSON.stringify(c).length < 30000),
  );
  const state = result.transcript
    .filter((e) => e.type === "checkpoint")
    .at(-1).runtime;
  assert.equal(state.ledger.artifacts["large-file"].name, "large.md");
});

test("long provider generation keeps the Rust bridge alive without claiming tool progress", async () => {
  const result = await fixture("heartbeat", false, {
    bot_tools: { enabled: true },
  });
  assert.ok(result.transcript.some((e) => e.type === "heartbeat"));
  assert.equal(result.transcript.at(-1).type, "result");
});
