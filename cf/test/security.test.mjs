import assert from "node:assert/strict";
import test from "node:test";

import {
  CONTENT_SECURITY_POLICY,
  redirectProductionHttp,
  withSecurityHeaders,
} from "../src/security.js";

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
