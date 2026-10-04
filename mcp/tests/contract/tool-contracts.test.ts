import { beforeAll, describe, expect, it } from "vitest";
import { createHandler, type McpEnv } from "../../src/mcp/index";
import { isAllowedPublicTool, TOOL_REGISTRY } from "../../src/mcp/tool-registry";
import { TestD1 } from "../helpers/d1-shim";
import { FixedClock } from "../helpers/fixtures";

/**
 * 規格 10 §7 contract snapshot：工具名稱、版本、說明、input/output schema、風險、資料分級、唯讀。
 * 任何變動都會讓快照不符；確認是刻意的契約變更後，以 `npx vitest run tests/contract -u` 更新並在 PR 說明。
 * 說明文字會影響模型選工具，因此也是契約的一部分（規格 07 §12）。
 */
let tools: any[];

beforeAll(async () => {
  const env: McpEnv = { DB: new TestD1().asD1(), ENVIRONMENT: "test" };
  const res = await createHandler(new FixedClock()).fetch(
    new Request("https://mcp.test/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    }),
    env,
  );
  tools = ((await res.json()) as any).result.tools;
});

describe("tool contracts", () => {
  it("exposes exactly the registered tools", () => {
    expect(tools.map((t) => t.name).sort()).toEqual(TOOL_REGISTRY.map((t) => t.name).sort());
  });

  it("every exposed tool passes the public v1 policy (R0, L0, read-only, no scopes)", () => {
    for (const t of tools) {
      expect(isAllowedPublicTool(t.name), t.name).toBe(true);
      expect(t.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, openWorldHint: false });
    }
    expect(isAllowedPublicTool("execute_sql")).toBe(false);
    expect(isAllowedPublicTool("fetch_url")).toBe(false);
  });

  it("matches the reviewed contract snapshot", () => {
    const contracts = tools
      .map((t) => ({
        registry: TOOL_REGISTRY.find((r) => r.name === t.name),
        title: t.title,
        description: t.description,
        inputSchema: t.inputSchema,
        outputSchema: t.outputSchema,
        annotations: t.annotations,
      }))
      .sort((a, b) => a.registry!.name.localeCompare(b.registry!.name));
    expect(contracts).toMatchSnapshot();
  });
});
