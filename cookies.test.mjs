// Unit tests for cookies.mjs — `npm test` (node --test).
import test from "node:test";
import assert from "node:assert/strict";
import { CookieJar, parseSetCookie, toBrowserSetCookie } from "./cookies.mjs";

test("parseSetCookie splits name/value/flags", () => {
  const c = parseSetCookie("msToken=abc=def; Domain=.tiktok.com; Path=/; HttpOnly; Max-Age=3600");
  assert.equal(c.name, "msToken");
  assert.equal(c.value, "abc=def");
  assert.equal(c.attributes.domain, ".tiktok.com");
  assert.equal(c.attributes.path, "/");
  assert.equal(c.attributes.httponly, "");
  assert.equal(c.attributes["max-age"], "3600");
  assert.equal(c.deleted, false);
});

test("parseSetCookie flags deletions", () => {
  assert.equal(parseSetCookie("a=1; Max-Age=0").deleted, true);
  assert.equal(parseSetCookie("a=1; Expires=Thu, 01 Jan 1970 00:00:01 GMT").deleted, true);
  assert.equal(parseSetCookie("a=1; Max-Age=60").deleted, false);
});

test("toBrowserSetCookie scopes cookies to the gateway origin", () => {
  const out = toBrowserSetCookie(
    "sessionid=xyz; Domain=.tiktok.com; Path=/api; HttpOnly; SameSite=None; Max-Age=120",
  );
  assert.match(out, /^sessionid=xyz;/);
  assert.doesNotMatch(out, /Domain/i);
  assert.match(out, /Path=\//);
  assert.doesNotMatch(out, /Path=\/api/);
  assert.match(out, /HttpOnly/);
  assert.match(out, /Max-Age=120/);
});

test("toBrowserSetCookie adapts Secure/SameSite to the serving scheme", () => {
  const plain = toBrowserSetCookie("a=1; Secure; SameSite=None; Partitioned");
  assert.doesNotMatch(plain, /Secure/);
  assert.doesNotMatch(plain, /Partitioned/);
  assert.match(plain, /SameSite=Lax/);

  const tls = toBrowserSetCookie("a=1; Secure; SameSite=None", { secure: true });
  assert.match(tls, /Secure/);
  assert.match(tls, /SameSite=None/);
});

test("jar only sends domain-scoped cookies to matching hosts", () => {
  const jar = new CookieJar();
  jar.record(
    ["sessionid=s3cr3t; Domain=.tiktok.com; Path=/", "ttwid=w; Domain=tiktok.com; Path=/"],
    "www.tiktok.com",
  );
  const header = "sessionid=s3cr3t; ttwid=w; tt_csrf=csrf; _ga=GA1.1";
  assert.equal(jar.filter(header, "www.tiktok.com"), header);
  assert.equal(jar.filter(header, "im-api.tiktok.com"), header);
  // CDN / telemetry hosts are a different registrable domain: no session cookie
  assert.equal(jar.filter(header, "sf16-website-login.neutral.tiktokcdn-eu.com"), "tt_csrf=csrf; _ga=GA1.1");
  // suffix confusion must not match
  assert.equal(jar.filter(header, "nottiktok.com"), "tt_csrf=csrf; _ga=GA1.1");
});

test("jar keeps host-only cookies on their own host", () => {
  const jar = new CookieJar();
  jar.record(["odin_tt=o; Path=/"], "www.tiktok.com");
  assert.equal(jar.filter("odin_tt=o; other=1", "www.tiktok.com"), "odin_tt=o; other=1");
  assert.equal(jar.filter("odin_tt=o; other=1", "web-sg.tiktok.com"), "other=1");
});

test("jar lets unknown (JS-set) cookies through unchanged", () => {
  const jar = new CookieJar();
  jar.record(["known=k; Domain=.tiktok.com"], "www.tiktok.com");
  // same-host, another host, and a cold jar must all behave like before the jar
  assert.equal(jar.filter("known=k; js=1", "www.tiktok.com"), "known=k; js=1");
  assert.equal(jar.filter("js=1", "tiktokcdn-eu.com"), "js=1");
  assert.equal(new CookieJar().filter("a=1; b=2", "anything.example"), "a=1; b=2");
});

test("jar forgets deleted cookies", () => {
  const jar = new CookieJar();
  jar.record(["ttwid=w; Domain=.tiktok.com"], "www.tiktok.com");
  jar.record(["ttwid=; Domain=.tiktok.com; Max-Age=0"], "www.tiktok.com");
  // scope is gone, so it falls back to pass-through (the browser dropped it too)
  assert.equal(jar.filter("ttwid=w", "tiktokcdn-eu.com"), "ttwid=w");
});

test("jar preserves values containing '='", () => {
  const jar = new CookieJar();
  jar.record(["tt_chain_token=ab+cd==; Domain=.tiktok.com"], "www.tiktok.com");
  assert.equal(jar.filter("tt_chain_token=ab+cd==", "www.tiktok.com"), "tt_chain_token=ab+cd==");
});
