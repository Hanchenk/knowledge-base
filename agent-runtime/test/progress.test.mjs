import { test } from "node:test";
import assert from "node:assert/strict";
import { createProgress } from "../progress.mjs";
import { createHarness } from "../harness.mjs";
const result = (data) => ({
  content: [{ type: "text", text: JSON.stringify(data) }],
  isError: false,
});
const call = (id, name, args) => ({ id, name, arguments: args });

test("alternating sources and rewritten plans cannot hide repeated evidence, including after restore", () => {
  let progress = createProgress();
  for (let n = 0; n < 5; n++)
    progress.observe(
      call(`first-${n}`, "web_fetch", { url: `https://example.test/${n}` }),
      result({
        url: `https://example.test/${n}`,
        content: "source facts",
        start: 0,
        next_start: null,
      }),
    );
  for (let n = 0; n < 8; n++) {
    progress.observe(
      call(`plan-${n}`, "task_plan", {
        steps: [{ title: `核验材料${n}`, status: "running" }],
      }),
      result({ saved: true }),
    );
    assert.ok(
      progress.cached(
        "web_fetch",
        { url: `https://example.test/${n % 5}` },
        `repeat-${n}`,
      ),
    );
    if (n === 3) progress = createProgress(progress.serialize());
  }
  assert.equal(progress.phase, "finalize");
  assert.match(progress.instruction(), /分析、比较与交付/);
  const deferred = progress.cached(
    "web_fetch",
    { url: "https://example.test/unread" },
    "deferred",
  );
  assert.equal(deferred.isError, false);
  assert.equal(JSON.parse(deferred.content[0].text).deferred, true);
  assert.equal(progress.endTurn(true), false);
  assert.equal(progress.endTurn(true), false);
  assert.equal(progress.endTurn(true), true);
  // Real new paragraphs can unblock work; this is not a total-call cap.
  progress.observe(
    call("tail", "web_fetch", { url: "https://example.test/0", start: 12 }),
    result({
      url: "https://example.test/0",
      content: "new tail facts",
      start: 12,
      next_start: null,
    }),
  );
  assert.equal(progress.phase, "research");
  assert.equal(progress.endTurn(true), false);
});

test("query/limit changes, empty pages, failed reads and archive recalls do not manufacture novelty", () => {
  const progress = createProgress();
  for (let n = 0; n < 4; n++)
    progress.observe(
      call(`query-${n}`, "knowledge_search", { query: `variation ${n}` }),
      result({ hits: [{ chunk_id: "same", text: "same fact" }] }),
    );
  assert.equal(progress.phase, "synthesize");
  progress.observe(
    call("head", "web_fetch", {
      url: "https://example.test/full",
      limit: 6000,
    }),
    result({ content: "abcdef", start: 0 }),
  );
  progress.observe(
    call("short", "web_fetch", {
      url: "https://example.test/full",
      limit: 1000,
    }),
    result({ content: "abc", start: 0 }),
  );
  progress.observe(
    call("empty", "web_fetch", { url: "https://example.test/full", start: 6 }),
    result({ content: "", start: 6 }),
  );
  progress.observe(
    call("recall", "runtime_recall", { call_id: "head" }),
    result({ content: '{"data":{"content":"abcdef"}}' }),
  );
  assert.equal(progress.phase, "synthesize");
  progress.observe(
    call("failure", "web_fetch", { url: "https://example.test/fail" }),
    { ...result({ error: "HTTP 404" }), isError: true },
  );
  assert.equal(
    progress.cached("web_fetch", { url: "https://example.test/fail" }, "retry")
      .isError,
    true,
  );
});

test("legacy journal seeds read cache with original archive IDs and honest coverage", () => {
  const progress = createProgress({}, [
    {
      call_id: "old-full",
      name: "web_fetch",
      args: { url: "https://example.test/a#fragment" },
      data: { content: "full source" },
    },
    {
      call_id: "old-head",
      name: "web_fetch",
      args: { url: "https://example.test/b" },
      data: { content: "a".repeat(16000) },
    },
  ]);
  const a = JSON.parse(
    progress.cached("web_fetch", { url: "https://example.test/a" }, "new-a")
      .content[0].text,
  );
  assert.equal(a.archive_call_id, "old-full");
  assert.equal(a.next_start, null);
  const b = JSON.parse(
    progress.cached("web_fetch", { url: "https://example.test/b" }, "new-b")
      .content[0].text,
  );
  assert.equal(b.next_start, 16000);
});

test("cached evidence must pass the authorization checkpoint before reaching the model", async () => {
  const harness = createHarness({
    config: {
      query: "test",
      bot_tools: { enabled: true },
      read_history: [
        {
          call_id: "original",
          name: "knowledge_read",
          args: { document_id: "revoked" },
          data: { hits: [{ chunk_id: "x", text: "private" }] },
        },
      ],
    },
    model: {},
    models: {},
    options: () => ({}),
    tools: [],
    request: async () => ({ ok: false }),
  });
  harness.attach({ state: { messages: [] } });
  await assert.rejects(
    harness.cached("knowledge_read", { document_id: "revoked" }, "repeat"),
    /Checkpoint unavailable/,
  );
});

test("compaction retains facts and refs independently of summary generation and uses valid bounded JSON", async () => {
  const findings = Array.from({ length: 12 }, (_, n) => ({
    fact: `事实${n}：` + "核实内容".repeat(200),
    refs: [`[${n + 1}]`],
    verified: true,
  }));
  const checkpoints = [];
  const harness = createHarness({
    config: {
      query: "研究并保存报告",
      bot_tools: { enabled: true },
      context_window: 8192,
      max_output_tokens: 1024,
      read_history: [
        {
          name: "task_memory",
          args: {},
          data: {
            saved: true,
            findings,
            open_questions: ["性能数字尚无独立验证"],
            next_action: "比较观点",
          },
        },
      ],
    },
    model: {},
    models: {
      completeSimple: async () => ({
        content: [{ type: "text", text: "压缩摘要" }],
        stopReason: "stop",
      }),
    },
    options: () => ({}),
    tools: [],
    request: async (type, data) => {
      checkpoints.push(data);
      return { ok: true };
    },
  });
  const agent = {
    state: {
      messages: [
        { role: "system", content: "以证据回答" },
        { role: "user", content: "研究并保存报告" },
        { role: "user", content: "旧记录".repeat(12000) },
      ],
    },
  };
  harness.attach(agent);
  await harness.prepareRequest({ context: { messages: agent.state.messages } });
  const last = checkpoints.at(-1).runtime;
  assert.equal(last.ledger.findings.length, 12);
  const memory = last.messages.find((m) =>
    String(m.content).startsWith("历史任务摘要"),
  );
  const structured = JSON.parse(
    memory.content.split("核验目录（数据）：\n")[1],
  );
  assert.ok(structured.findings.length > 0);
  assert.ok(structured.findings.every((f) => f.refs.length && f.verified));
  assert.ok(structured.archived_notes > 0);
  assert.ok(JSON.stringify(last.messages).length < 18000);
});

test("runtime keeps literal cited evidence without requiring a model-authored memory call, and freezes stalled research until draft", async () => {
  const checkpoints = [];
  const reads = ["knowledge_read", "web_fetch", "runtime_recall"];
  const harness = createHarness({
    config: {
      query: "研究报告",
      bot_tools: { enabled: true },
      context_window: 8192,
      max_output_tokens: 1024,
      read_history: [
        {
          call_id: "source",
          name: "knowledge_read",
          args: { document_id: "doc" },
          data: {
            hits: [
              {
                chunk_id: "chunk",
                citation: "[7]",
                text: "持久事实：先初始化环境，再增量完成特性。",
              },
            ],
          },
        },
      ],
    },
    model: {},
    models: {},
    options: () => ({}),
    tools: [...reads, "write_artifact", "task_memory"].map((name) => ({
      name,
      description: name,
      parameters: { type: "object" },
    })),
    request: async (type, data) => {
      checkpoints.push(data);
      return { ok: true };
    },
  });
  const agent = {
    state: {
      messages: [
        {
          role: "system",
          content: "执行目标",
          toolsAdded: reads.map((name) => ({
            name,
            parameters: { type: "object" },
          })),
        },
      ],
    },
  };
  harness.attach(agent);
  for (let n = 0; n < 8; n++)
    await harness.cached(
      "knowledge_read",
      { document_id: "doc" },
      "repeat-" + n,
    );
  await harness.prepareRequest({ context: { messages: agent.state.messages } });
  const memory = checkpoints.at(-1).runtime;
  assert.ok(JSON.stringify(memory.messages).includes("先初始化环境"));
  assert.equal(memory.ledger.evidence_notes[0].reference, "[7]");
  const available = agent.state.messages[0].toolsAdded.map((t) => t.name);
  assert.deepEqual(available, ["write_artifact", "task_memory"]);
  await harness.afterToolCall({
    toolCall: call("draft", "write_artifact", {
      name: "research.md",
      content: "报告[7]",
    }),
    result: result({ artifact_id: "report", name: "research.md", size: 10 }),
  });
  await harness.prepareRequest({ context: { messages: agent.state.messages } });
  assert.ok(
    agent.state.messages[0].toolsAdded.some((t) => t.name === "knowledge_read"),
  );
});

test("durable factual synthesis in the delivery phase gets time to write the report", () => {
  const progress = createProgress({
    phase: "finalize",
    interventions: 2,
    stale: 8,
  });
  progress.observe(
    call("notes", "task_memory", {
      findings: [
        { fact: "来源说明先建环境再增量执行", refs: ["[1]"], verified: true },
      ],
    }),
    result({ saved: true }),
  );
  assert.equal(progress.phase, "finalize");
  assert.equal(progress.endTurn(true), false);
  assert.ok(progress.restrictedReads().includes("web_fetch"));
  progress.observe(
    call("same-notes", "task_memory", {
      findings: [
        { fact: "来源说明先建环境再增量执行", refs: ["[1]"], verified: true },
      ],
    }),
    result({ saved: true }),
  );
  assert.equal(progress.endTurn(true), false);
  assert.equal(progress.endTurn(true), true);
});

test("saved file identifiers stay visible after compaction and completed plans stop reopening work", async () => {
  const progress = createProgress({
    phase: "review",
    completed: 3,
    plan_total: 3,
    deliverables: 1,
  });
  assert.match(
    progress.instruction(),
    /直接向用户作最终答复|直接向用户|直接.*最终答复/,
  );
  assert.ok(progress.restrictedReads().includes("task_plan"));
  const harness = createHarness({
    config: {
      query: "研究报告",
      bot_tools: { enabled: true },
      context_window: 8192,
      max_output_tokens: 1024,
      resume: {
        runtime: {
          ledger: {
            artifacts: { saved: { id: "saved", name: "research.md" } },
            plan: [{ title: "交付", status: "completed" }],
          },
          progress: { phase: "review", completed: 1, deliverables: 1 },
        },
      },
    },
    model: {},
    models: {
      completeSimple: async () => ({
        stopReason: "stop",
        content: [{ type: "text", text: "大量事实" }],
      }),
    },
    options: () => ({}),
    tools: [],
    request: async () => ({ ok: true }),
  });
  const agent = {
    state: {
      messages: [
        { role: "system", content: "依照证据交付" },
        { role: "user", content: "大量历史内容".repeat(10000) },
      ],
    },
  };
  harness.attach(agent);
  await harness.prepareRequest({ context: { messages: agent.state.messages } });
  const state = agent.state.messages.find((m) => m.runtime_state);
  assert.ok(state.content.includes("saved"));
  assert.ok(state.content.includes("research.md"));
});

test("after reading a saved report in full, review finishes without reopening source gathering", () => {
  const progress = createProgress({
    phase: "review",
    completed: 2,
    plan_total: 3,
    deliverables: 1,
  });
  progress.observe(
    call("read", "read_artifact", { artifact_id: "saved", start: 0 }),
    result({
      content: "已保存的完整报告与未核实项",
      total: 13,
      next_start: null,
    }),
  );
  assert.equal(progress.phase, "review");
  assert.ok(progress.restrictedReads().includes("runtime_recall"));
  assert.match(progress.instruction(), /把计划标为完成并最终答复/);
  const restored = createProgress(progress.serialize());
  assert.ok(restored.restrictedReads().includes("web_fetch"));
  restored.observe(
    call("done", "task_plan", {
      steps: [
        { title: "取材", status: "completed" },
        { title: "分析", status: "completed" },
        { title: "交付", status: "completed" },
      ],
    }),
    result({ saved: true }),
  );
  assert.ok(restored.restrictedReads().includes("task_plan"));
});

test("reading an intermediate file does not close research before the delivery step", () => {
  const progress = createProgress({
    phase: "research",
    completed: 1,
    plan_total: 4,
  });
  progress.observe(
    call("data", "write_artifact", { name: "source-data.csv" }),
    result({ artifact_id: "data", name: "source-data.csv" }),
  );
  progress.observe(
    call("check", "read_artifact", { artifact_id: "data" }),
    result({ content: "source,value\nA,12", next_start: null }),
  );
  assert.equal(progress.restrictedReads().includes("web_fetch"), false);
  assert.match(progress.instruction(), /按当前任务计划继续推进/);
});

test("cached artifact arguments cannot overwrite the name in a committed file receipt", async () => {
  const harness = createHarness({
    config: {
      query: "核对报告",
      bot_tools: { enabled: true },
      artifacts: [{ id: "saved", name: "research.md" }],
    },
    model: {},
    models: {},
    options: () => ({}),
    tools: [],
    request: async () => ({ ok: true }),
  });
  const agent = {
    state: { messages: [{ role: "system", content: "核对报告" }] },
  };
  harness.attach(agent);
  await harness.onEvent({
    type: "message_end",
    message: {
      role: "toolResult",
      toolName: "read_artifact",
      content: [
        {
          type: "text",
          text: JSON.stringify({
            cached: true,
            args: { artifact_id: "saved" },
            excerpt: "报告内容",
          }),
        },
      ],
    },
  });
  await harness.prepareRequest({ context: { messages: agent.state.messages } });
  assert.ok(
    agent.state.messages
      .find((m) => m.runtime_state)
      .content.includes("research.md"),
  );
});
