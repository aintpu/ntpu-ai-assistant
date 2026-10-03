import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { ReadRepository } from "../db/read-repository";
import { assertRegistryValid, SOURCES } from "../ingestion/source-registry";
import { systemClock, type Clock } from "../shared/clock";
import { AnnouncementService } from "./announcement-service";
import { createMcpServer, SERVICE_NAME, SERVICE_VERSION } from "./tools";

export interface McpEnv {
  DB: D1Database;
  ENVIRONMENT: string;
}

const MAX_REQUEST_BYTES = 64 * 1024;

assertRegistryValid();

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    },
  });
}

async function handleMcp(request: Request, service: AnnouncementService): Promise<Response> {
  if (request.method !== "POST") {
    // Stateless 模式不提供 SSE 長連線。
    return json({ error: "METHOD_NOT_ALLOWED", message: "Use POST for MCP requests." }, 405);
  }
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_REQUEST_BYTES) {
    return json({ error: "REQUEST_TOO_LARGE" }, 413);
  }
  const body = await request.arrayBuffer();
  if (body.byteLength > MAX_REQUEST_BYTES) return json({ error: "REQUEST_TOO_LARGE" }, 413);

  const traceId = crypto.randomUUID();
  const server = createMcpServer(service, traceId);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  const response = await transport.handleRequest(
    new Request(request.url, { method: "POST", headers: request.headers, body }),
  );
  const headers = new Headers(response.headers);
  headers.set("X-Trace-Id", traceId);
  headers.set("X-Content-Type-Options", "nosniff");
  return new Response(response.body, { status: response.status, headers });
}

export function createHandler(clock: Clock = systemClock) {
  return {
    async fetch(request: Request, env: McpEnv): Promise<Response> {
      const { pathname } = new URL(request.url);
      const service = new AnnouncementService(new ReadRepository(env.DB), clock);

      if (pathname === "/mcp") return handleMcp(request, service);

      if (pathname === "/health") {
        const sources = await service.freshness().catch(() => null);
        if (!sources) return json({ status: "degraded", service: SERVICE_NAME, error: "DEPENDENCY_UNAVAILABLE" }, 503);
        return json({
          status: sources.every((s) => s.state === "fresh") ? "ok" : "stale",
          service: SERVICE_NAME,
          version: SERVICE_VERSION,
          environment: env.ENVIRONMENT,
          sources,
        });
      }

      if (pathname === "/about") {
        return json({
          service: SERVICE_NAME,
          version: SERVICE_VERSION,
          description: "國立臺北大學處室官方公開資料的唯讀 MCP server。資料由排程抓取官網後存入資料庫，查詢時不即時爬網站。",
          endpoint: "/mcp",
          transport: "streamable-http (stateless, JSON response)",
          readOnly: true,
          dataClass: "L0 (public)",
          tools: ["search_announcements", "get_announcement"],
          sources: SOURCES.map((s) => ({ id: s.id, unit: s.sourceUnit, url: s.homepageUrl, type: s.sourceType })),
        });
      }

      return json({ error: "NOT_FOUND" }, 404);
    },
  };
}

export default createHandler() satisfies ExportedHandler<McpEnv>;
