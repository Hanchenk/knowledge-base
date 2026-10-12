import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const key = process.env.ATLAS_API_KEY;
if (!key) {
  console.error("Set ATLAS_API_KEY to a scoped Atlas API key.");
  process.exit(1);
}
const client = new Client({ name: "atlas-example-agent", version: "1.0.0" });
try {
  await client.connect(
    new StreamableHTTPClientTransport(
      new URL(process.env.ATLAS_MCP_URL || "http://127.0.0.1:8000/mcp"),
      { requestInit: { headers: { Authorization: `Bearer ${key}` } } },
    ),
  );
  const { tools } = await client.listTools();
  console.log("Available tools:", tools.map((t) => t.name).join(", "));
  const result = await client.callTool({
    name: "knowledge_search",
    arguments: { query: process.env.ATLAS_QUERY || "报销流程", limit: 3 },
  });
  if (result.isError)
    throw new Error(
      result.content?.find((c) => c.type === "text")?.text ||
        "Knowledge tool failed",
    );
  const data =
    result.structuredContent ||
    JSON.parse(result.content.find((c) => c.type === "text").text);
  console.log("Retrieval mode:", data.mode);
  console.log(
    "Sources:",
    data.hits.map((h) => ({
      title: h.title,
      page: h.page,
      version: h.version,
      document_id: h.document_id,
    })),
  );
} catch (error) {
  console.error("MCP request failed:", error.message);
  process.exitCode = 1;
} finally {
  await client.close();
}
