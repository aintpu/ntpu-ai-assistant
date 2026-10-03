import { describe, expect, it } from "vitest";
import { fetchSource } from "../../src/ingestion/fetch-source";
import { getSource, assertRegistryValid, SOURCES } from "../../src/ingestion/source-registry";
import { isDeniedHost, resolveEntrypoint, validateSourceDefinition } from "../../src/ingestion/url-policy";
import type { SourceDefinition } from "../../src/ingestion/types";
import { FixedClock } from "../helpers/fixtures";

const ord = getSource("ord-announcements")!;
const clock = new FixedClock();
const req = { target: "/strapi#page=0", path: "/strapi", body: "{}" };
const jsonResponse = (body: BodyInit, headers: Record<string, string> = {}) =>
  new Response(body, { status: 200, headers: { "content-type": "application/json", ...headers } });

function withSource(overrides: Partial<SourceDefinition>): SourceDefinition {
  return { ...ord, ...overrides, fetch: { ...ord.fetch, ...(overrides.fetch ?? {}) } };
}

describe("source registry", () => {
  it("the shipped registry is valid", () => {
    expect(() => assertRegistryValid()).not.toThrow();
    expect(SOURCES.every((s) => s.origin.startsWith("https://"))).toBe(true);
  });

  it.each([
    ["http origin", { origin: "http://api-carrier.ntpu.edu.tw" }],
    ["credentials", { origin: "https://user:pw@api-carrier.ntpu.edu.tw" }],
    ["loopback", { origin: "https://127.0.0.1" }],
    ["metadata", { origin: "https://169.254.169.254" }],
    ["root prefix", { allowedPathPrefixes: ["/"] }],
    ["wildcard prefix", { allowedPathPrefixes: ["/*"] }],
    ["entrypoint outside prefix", { entrypoints: ["/admin"] }],
    ["unknown parser", { parser: "llm-extract" }],
    ["no size limit", { fetch: { ...ord.fetch, maxResponseBytes: 0 } }],
  ])("rejects a source with %s", (_name, overrides) => {
    expect(() => validateSourceDefinition(withSource(overrides as Partial<SourceDefinition>))).toThrow();
  });
});

describe("T-007 SSRF and URL allowlist", () => {
  it.each(["localhost", "127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "::1", "[fe80::1]",
    "metadata.google.internal", "2130706433", "0x7f000001", "100.64.0.1"])("denies %s", (host) => {
    expect(isDeniedHost(host)).toBe(true);
  });

  it("allows the registered public host", () => {
    expect(isDeniedHost("api-carrier.ntpu.edu.tw")).toBe(false);
  });

  it("only registered entrypoints can be fetched; arbitrary URLs never reach fetch", async () => {
    let called = 0;
    const fetch = async () => {
      called++;
      return jsonResponse("{}");
    };
    for (const path of ["/other", "https://evil.example/strapi", "//evil.example/strapi", "/strapi/../admin"]) {
      await expect(fetchSource(ord, { ...req, path }, { fetch, clock })).rejects.toMatchObject({ code: "URL_NOT_ALLOWED" });
    }
    expect(called).toBe(0);
    expect(() => resolveEntrypoint(ord, "/strapi")).not.toThrow();
  });

  it("rejects redirects to internal destinations before following them", async () => {
    const source = withSource({ fetch: { ...ord.fetch, followRedirects: true, maxRedirects: 3 } });
    const seen: string[] = [];
    const fetch = async (r: Request) => {
      seen.push(r.url);
      return new Response(null, { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data" } });
    };
    await expect(fetchSource(source, req, { fetch, clock })).rejects.toMatchObject({ code: "REDIRECT_REJECTED" });
    expect(seen).toEqual(["https://api-carrier.ntpu.edu.tw/strapi"]);
  });

  it("rejects any redirect when the source does not allow redirects", async () => {
    const fetch = async () => new Response(null, { status: 301, headers: { location: "/strapi" } });
    await expect(fetchSource(ord, req, { fetch, clock })).rejects.toMatchObject({ code: "REDIRECT_REJECTED" });
  });
});

describe("T-008 response limits", () => {
  it("rejects an oversized declared content-length", async () => {
    const fetch = async () => jsonResponse("{}", { "content-length": String(ord.fetch.maxResponseBytes + 1) });
    await expect(fetchSource(ord, req, { fetch, clock })).rejects.toMatchObject({ code: "FETCH_TOO_LARGE" });
  });

  it("aborts a streamed body that exceeds the limit", async () => {
    const small = withSource({ fetch: { ...ord.fetch, maxResponseBytes: 1024 } });
    const fetch = async () => jsonResponse(new Blob(["x".repeat(4096)]).stream());
    await expect(fetchSource(small, req, { fetch, clock })).rejects.toMatchObject({ code: "FETCH_TOO_LARGE" });
  });

  it("rejects unexpected content types", async () => {
    const fetch = async () => new Response("<html>", { status: 200, headers: { "content-type": "text/html" } });
    await expect(fetchSource(ord, req, { fetch, clock })).rejects.toMatchObject({ code: "CONTENT_TYPE_REJECTED" });
  });

  it("times out", async () => {
    const fast = withSource({ fetch: { ...ord.fetch, timeoutMs: 20 } });
    const fetch = (r: Request) =>
      new Promise<Response>((_, reject) => r.signal.addEventListener("abort", () => reject(new Error("aborted"))));
    await expect(fetchSource(fast, req, { fetch, clock })).rejects.toMatchObject({ code: "FETCH_TIMEOUT" });
  });

  it("does not keep cookies in the raw snapshot metadata", async () => {
    const fetch = async () => jsonResponse("{}", { "set-cookie": "session=secret", etag: '"abc"' });
    const snapshot = await fetchSource(ord, req, { fetch, clock });
    expect(snapshot.headers).toEqual({ "content-type": "application/json", etag: '"abc"' });
  });
});
