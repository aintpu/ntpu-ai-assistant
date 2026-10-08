import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { ReadRepository } from "../db/read-repository";
import { assertRegistryValid, SOURCES } from "../ingestion/source-registry";
import { systemClock, type Clock } from "../shared/clock";
import { AnnouncementService } from "./announcement-service";
import { AttachmentService } from "./attachment-service";
import { FaqService, RegulationService } from "./manual-service";
import { PageService } from "./page-service";
import { TOOL_REGISTRY } from "./tool-registry";
import { createMcpServer, SERVICE_NAME, SERVICE_VERSION, type McpServices } from "./tools";

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

async function handleMcp(request: Request, services: McpServices): Promise<Response> {
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
  const server = createMcpServer(services, traceId);
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
      const repo = new ReadRepository(env.DB);
      const service = new AnnouncementService(repo, clock);
      const services: McpServices = {
        announcements: service,
        pages: new PageService(repo),
        regulations: new RegulationService(repo),
        faqs: new FaqService(repo),
        attachments: new AttachmentService(repo),
      };

      if (pathname === "/mcp") return handleMcp(request, services);

      if (pathname === "/health") {
        const sources = await Promise.all(
          (["announcement", "page", "regulation", "faq"] as const).map((t) => service.freshness(undefined, t)),
        )
          .then((groups) => groups.flat())
          .catch(() => null);
        if (!sources) return json({ status: "degraded", service: SERVICE_NAME, error: "DEPENDENCY_UNAVAILABLE" }, 503);
        return json({
          // ok：全部來源都在時限內完整成功；degraded：最近一次執行不完整；stale：超過時限沒有完整成功。
          status: sources.some((s) => s.state !== "fresh")
            ? "stale"
            : sources.some((s) => s.lastRunStatus !== "success")
              ? "degraded"
              : "ok",
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
          description:
            "國立臺北大學處室公開資料的唯讀 MCP server。公告與介紹頁由排程抓取官網；法規與常見問答來自人工整理檔（manual_verified）。查詢時不即時爬網站。",
          endpoint: "/mcp",
          transport: "streamable-http (stateless, JSON response)",
          readOnly: true,
          dataClass: "L0 (public)",
          tools: TOOL_REGISTRY.map((t) => t.name),
          // 規格 07 §10：工具登記表（風險等級、資料分級、唯讀、負責人）。
          toolRegistry: TOOL_REGISTRY,
          owners: {
            dataOwner: "盧信廷",
            technicalOwner: "盧信廷",
            securityReviewer: "盧信廷",
            productionOperator: "盧信廷",
            note: "官網公告內容由各處室發布，本服務負責同步；法規與常見問答人工整理檔由盧信廷維護。",
          },
          sources: SOURCES.map((s) => ({ id: s.id, unit: s.sourceUnit, url: s.homepageUrl, type: s.sourceType })),
        });
      }

      return json({ error: "NOT_FOUND" }, 404);
    },
  };
}

export default createHandler() satisfies ExportedHandler<McpEnv>;
