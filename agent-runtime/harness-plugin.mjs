import { readFile } from "node:fs/promises";
import { createPlatformTools } from "./platform-tools.mjs";

export const name = "zhixiaohui-platform-tools";
export const inject = ["tools"];
// DSH deliberately accepts a smaller schema subset than TypeBox. Rust remains
// authoritative for bounds and permissions; the shared descriptors keep names consistent.
export function harnessSchema(schema) {
  const result = {};
  for (const key of [
    "type",
    "description",
    "title",
    "default",
    "enum",
    "const",
    "required",
    "additionalProperties",
  ]) {
    if (schema[key] !== undefined && typeof schema[key] !== "object")
      result[key] = schema[key];
    else if (["enum", "required"].includes(key) && Array.isArray(schema[key]))
      result[key] = schema[key];
  }
  if (schema.properties)
    result.properties = Object.fromEntries(
      Object.entries(schema.properties).map(([key, value]) => [
        key,
        harnessSchema(value),
      ]),
    );
  if (schema.items) result.items = harnessSchema(schema.items);
  if (schema.oneOf || schema.anyOf)
    result.oneOf = (schema.oneOf ?? schema.anyOf).map(harnessSchema);
  if (schema.patternProperties) result.additionalProperties = true;
  return result;
}
export async function apply(ctx) {
  const config = JSON.parse(
    await readFile(process.env.ZXH_TASK_CONFIG, "utf8"),
  );
  for (const definition of createPlatformTools(
    config,
    (name, description, parameters) => ({ name, description, parameters }),
  )) {
    ctx.tools.register({
      ...definition,
      // Upstream native web tools consume Cordis provider plugins. Keep those
      // names available and expose the platform's audited web bridge separately.
      name: ["web_search", "web_fetch"].includes(definition.name)
        ? `platform_${definition.name}`
        : definition.name,
      parameters: harnessSchema(definition.parameters),
      output: {
        schema: {},
        render: (_args, value) => [
          { type: "text", text: JSON.stringify(value) },
        ],
      },
      execute: async (args, exec) => {
        const response = await fetch(`${process.env.ZXH_BRIDGE_URL}/tool`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${process.env.ZXH_BRIDGE_TOKEN}`,
          },
          body: JSON.stringify({
            name: definition.name,
            args,
            call_id: String(exec.callId),
          }),
          signal: exec.signal,
        });
        if (!response.ok)
          throw new Error(`平台工具桥接失败(${response.status})`);
        const reply = await response.json();
        if (!reply.ok) throw new Error(reply.error || "平台工具失败");
        return reply.data;
      },
    });
  }
}
