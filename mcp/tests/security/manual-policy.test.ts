import { describe, expect, it } from "vitest";
import { fetchSource } from "../../src/ingestion/fetch-source";
import { assertManualPath, R2ManualInbox } from "../../src/ingestion/manual-inbox";
import { assertRegistryValid, getSource } from "../../src/ingestion/source-registry";
import type { SourceDefinition } from "../../src/ingestion/types";
import { validateSourceDefinition } from "../../src/ingestion/url-policy";
import { FixedClock } from "../helpers/fixtures";
import { MemoryManualInbox } from "../helpers/manual-fixtures";

const osa = getSource("osa-regulations")!;
const OSA_FILE = "crawler_data/osa_regulations.md";
const clock = new FixedClock();
const noNetwork = async (): Promise<Response> => {
  throw new Error("manual sources must never use the network");
};

function deps(inbox?: MemoryManualInbox) {
  return { fetch: noNetwork, clock, manual: inbox };
}

describe("manual file paths", () => {
  it.each(["../wrangler.mcp.jsonc", "crawler_data/../.env", "crawler_data/a b.md", "secrets/x.md", "crawler_data/x.sh", "/etc/passwd", "crawler_data/"])(
    "rejects %s",
    (path) => {
      expect(() => assertManualPath(path)).toThrow(/not allowed/);
    },
  );

  it("accepts registered-style paths", () => {
    expect(() => assertManualPath(OSA_FILE)).not.toThrow();
    expect(() => assertManualPath("derived/regulation-catalog.json")).not.toThrow();
  });

  it("the R2 inbox only reads under manual/", async () => {
    const keys: string[] = [];
    const bucket = { get: async (key: string) => (keys.push(key), null) } as unknown as R2Bucket;
    await new R2ManualInbox(bucket).get(OSA_FILE);
    expect(keys).toEqual([`manual/${OSA_FILE}`]);
    await expect(new R2ManualInbox(bucket).get("../raw/x.md")).rejects.toThrow(/not allowed/);
  });
});

describe("reading a manual file", () => {
  it("never touches the network and refuses files the source did not register", async () => {
    const inbox = new MemoryManualInbox();
    inbox.set("crawler_data/ord_faq.md", "### 問題\n回答");
    await expect(fetchSource(osa, { target: "x", path: "crawler_data/ord_faq.md" }, deps(inbox))).rejects.toMatchObject({
      code: "URL_NOT_ALLOWED",
    });
    expect(inbox.reads).toEqual([]);
  });

  it("refuses query strings or request bodies on manual files", async () => {
    const inbox = new MemoryManualInbox();
    inbox.set(OSA_FILE, "## 辦法\n內容");
    await expect(fetchSource(osa, { target: "x", path: OSA_FILE, query: { a: "1" } }, deps(inbox))).rejects.toMatchObject({ code: "URL_NOT_ALLOWED" });
    await expect(fetchSource(osa, { target: "x", path: OSA_FILE, body: "{}" }, deps(inbox))).rejects.toMatchObject({ code: "URL_NOT_ALLOWED" });
  });

  it("enforces content type and size, and reports a missing inbox or upload", async () => {
    const inbox = new MemoryManualInbox();
    inbox.set(OSA_FILE, "<script>alert(1)</script>", "text/html");
    await expect(fetchSource(osa, { target: "x", path: OSA_FILE }, deps(inbox))).rejects.toMatchObject({ code: "CONTENT_TYPE_REJECTED" });

    inbox.set(OSA_FILE, "x".repeat(osa.fetch.maxResponseBytes + 1));
    await expect(fetchSource(osa, { target: "x", path: OSA_FILE }, deps(inbox))).rejects.toMatchObject({ code: "FETCH_TOO_LARGE" });

    await expect(fetchSource(osa, { target: "x", path: OSA_FILE }, deps())).rejects.toMatchObject({ code: "DEPENDENCY_UNAVAILABLE" });
    await expect(fetchSource(osa, { target: "x", path: OSA_FILE }, deps(new MemoryManualInbox()))).rejects.toMatchObject({
      code: "FETCH_HTTP_ERROR",
    });
  });

  it("returns a raw snapshot that records where the file came from", async () => {
    const inbox = new MemoryManualInbox();
    inbox.set(OSA_FILE, "## 辦法\n內容");
    const snap = await fetchSource(osa, { target: OSA_FILE, path: OSA_FILE }, deps(inbox));
    expect(snap).toMatchObject({ requestedUrl: `r2:manual/${OSA_FILE}`, httpStatus: 200, sourceId: "osa-regulations" });
    expect(snap.rawHash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("manual source definitions", () => {
  const variant = (patch: Partial<SourceDefinition>): SourceDefinition => ({ ...osa, ...patch });

  it("the shipped registry is valid", () => {
    expect(() => assertRegistryValid()).not.toThrow();
  });

  it("must be labeled manual_verified / verified, never official", () => {
    expect(() => validateSourceDefinition(variant({ sourceType: "official_web" }))).toThrow(/manual_verified/);
    expect(() => validateSourceDefinition(variant({ trustLevel: "official" }))).toThrow(/verified/);
  });

  it("rejects unsafe entrypoints and adapter files that are not registered", () => {
    expect(() => validateSourceDefinition(variant({ entrypoints: ["derived/regulation-catalog.json", "../.env"] }))).toThrow(/not allowed/);
    expect(() =>
      validateSourceDefinition(variant({ entrypoints: ["derived/regulation-catalog.json"] })),
    ).toThrow(/not in entrypoints/);
  });

  it("only allows GET and no redirects", () => {
    expect(() => validateSourceDefinition(variant({ fetch: { ...osa.fetch, methods: ["POST"] } }))).toThrow(/GET/);
    expect(() => validateSourceDefinition(variant({ fetch: { ...osa.fetch, followRedirects: true, maxRedirects: 1 } }))).toThrow(/redirect/);
  });
});
