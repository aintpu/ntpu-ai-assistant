import assert from "node:assert/strict";
import test from "node:test";

import {
  CONTENT_SECURITY_POLICY,
  buildContentSecurityPolicy,
  redirectProductionHttp,
  withSecurityHeaders,
} from "../src/security.js";
import { cspHash, extractInline, findBlockedInlineAttributes } from "../scripts/csp-hashes.mjs";

function directive(policy, name) {
  return policy.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${name} `));
}

test("HTML responses receive CSP and anti-clickjacking headers", async () => {
  const secured = withSecurityHeaders(new Response("<!doctype html>", {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  }));

  assert.equal(secured.headers.get("x-frame-options"), "DENY");
  assert.equal(secured.headers.get("x-content-type-options"), "nosniff");
  assert.equal(
    secured.headers.get("strict-transport-security"),
    "max-age=31536000; includeSubDomains",
  );
  assert.equal(secured.headers.get("content-security-policy"), CONTENT_SECURITY_POLICY);
  assert.match(CONTENT_SECURITY_POLICY, /frame-ancestors 'none'/);
  assert.equal(await secured.text(), "<!doctype html>");
});

test("CSP never allows unsafe-inline, unsafe-eval or unsafe-hashes", () => {
  const policy = buildContentSecurityPolicy({
    scriptHashes: [cspHash("console.log(1)")],
    styleHashes: [cspHash("body{margin:0}")],
  });
  assert.doesNotMatch(policy, /unsafe-inline|unsafe-eval|unsafe-hashes/);
  assert.match(directive(policy, "script-src"), /'sha256-[A-Za-z0-9+/]+=*'/);
  assert.match(directive(policy, "style-src"), /'sha256-[A-Za-z0-9+/]+=*'/);
});

test("custom CSP is applied to HTML responses", () => {
  const policy = buildContentSecurityPolicy({ scriptHashes: [cspHash("x()")] });
  const secured = withSecurityHeaders(
    new Response("<p>", { headers: { "Content-Type": "text/html" } }),
    policy,
  );
  assert.equal(secured.headers.get("content-security-policy"), policy);
});

test("CSP hashes match the browser's sha256 of inline element text", () => {
  // Known value: sha256("alert('Hello, world.');") from the CSP Level 2 spec example.
  assert.equal(cspHash("alert('Hello, world.');"), "'sha256-qznLcsROx4GACP2dm0UCKCzCG+HiZ1guq6ZZDob/Tng='");

  const html = [
    "<script>(self.a=1)</script>",
    '<script src="/x.js" async=""></script>',
    '<script type="application/ld+json">{"a":1}</script>',
    '<script type="module">m()</script>',
    "<style>body{margin:0}</style>",
  ].join("");
  const { scripts, styles } = extractInline(html);
  assert.deepEqual(scripts, ["(self.a=1)", "m()"]);
  assert.deepEqual(styles, ["body{margin:0}"]);
});

test("inline attributes that hashes cannot authorize are reported", () => {
  const problems = findBlockedInlineAttributes(
    '<div style="color:red"></div><button onclick="x()"></button><a href="javascript:void(0)">x</a>'
      + '<script>const s = "<div style=\\"ok-inside-script\\">";</script><p class="ok"></p>',
  );
  assert.equal(problems.length, 3);
  assert.match(problems[0], /style attribute/);
  assert.match(problems[1], /onclick/);
  assert.match(problems[2], /javascript:/);
});

test("API responses receive transport and MIME hardening without document CSP", () => {
  const secured = withSecurityHeaders(Response.json({ status: "ok" }));

  assert.equal(secured.headers.get("x-frame-options"), "DENY");
  assert.equal(secured.headers.get("x-content-type-options"), "nosniff");
  assert.equal(secured.headers.get("content-security-policy"), null);
});

test("production HTTP requests redirect to HTTPS and local development does not", () => {
  const redirected = redirectProductionHttp(new Request("http://aia.ntpu.ai/about?x=1"));
  assert.equal(redirected.status, 308);
  assert.equal(redirected.headers.get("location"), "https://aia.ntpu.ai/about?x=1");

  assert.equal(
    redirectProductionHttp(new Request("http://127.0.0.1:8787/about")),
    null,
  );
});

test("WebSocket upgrade responses pass through untouched", () => {
  const upgrade = { status: 101, webSocket: {}, headers: new Headers() };
  assert.equal(withSecurityHeaders(upgrade), upgrade);
});

test("bodyless 304 responses keep their status", () => {
  const secured = withSecurityHeaders(new Response(null, { status: 304 }));
  assert.equal(secured.status, 304);
  assert.equal(secured.headers.get("x-content-type-options"), "nosniff");
});
