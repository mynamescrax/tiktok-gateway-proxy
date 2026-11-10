// HAR triage for this proxy: document timeline, reload loops, external egress,
// repeated upstream targets, failures. Dependency-free.
//
//   node har-triage.mjs "C:\Users\me\Downloads\127.0.0.1_Archive [..].har"
//
// Works with Chrome and Firefox exports (Firefox has no _resourceType, so
// documents are detected from the response MIME type / Accept header).
import fs from "node:fs";

const file = process.argv[2];
if (!file) {
  console.error("usage: node har-triage.mjs <file.har>");
  process.exit(2);
}

const har = JSON.parse(fs.readFileSync(file, "utf8"));
const entries = (har.log.entries || []).slice().sort(
  (a, b) => Date.parse(a.startedDateTime) - Date.parse(b.startedDateTime),
);
const pages = har.log.pages || [];
if (!entries.length) {
  console.error("no entries in " + file);
  process.exit(2);
}
const t0 = Date.parse(entries[0].startedDateTime);
const rel = (t) => ((Date.parse(t) - t0) / 1000).toFixed(2) + "s";
const strip = (u, n = 130) => String(u || "").slice(0, n);
const innerTarget = (url) => {
  try {
    const u = new URL(url);
    return u.pathname.endsWith("/tt") || u.pathname === "/tt" ? u.searchParams.get("url") || "" : "";
  } catch {
    return "";
  }
};
const header = (e, name) => {
  const h = (e.request.headers || []).find((x) => x.name.toLowerCase() === name);
  return h ? String(h.value) : "";
};
const isDocument = (e) => {
  if (e._resourceType === "document") return true;
  const dest = header(e, "sec-fetch-dest").toLowerCase();
  if (dest) return dest === "document" || dest === "iframe" || dest === "frame";
  const mime = (e.response.content?.mimeType || "").toLowerCase();
  return mime.includes("text/html") && header(e, "upgrade-insecure-requests") === "1";
};

const out = [];
out.push(`file: ${file}`);
out.push(`creator=${har.log.creator?.name} entries=${entries.length} pages=${pages.length} window=${rel(entries[0].startedDateTime)}..${rel(entries.at(-1).startedDateTime)}`);
for (const p of pages) {
  out.push(`page ${p.id} "${String(p.title || "").slice(0, 60)}" onLoad=${p.pageTimings?.onLoad}ms`);
}

const status = {};
for (const e of entries) status[e.response.status || "none"] = (status[e.response.status || "none"] || 0) + 1;
out.push(`status: ${JSON.stringify(status)}`);

out.push("\n== document timeline ==");
const docUrls = [];
for (const e of entries.filter(isDocument)) {
  docUrls.push(e.request.url);
  out.push(`  ${rel(e.startedDateTime)} ${e.response.status} ${e.response.content?.size || 0}b ${strip(e.request.url)}`);
}
const repeats = docUrls.filter((u, i) => docUrls.indexOf(u) !== i);
if (repeats.length) out.push(`  !! repeated document loads (reload loop?): ${JSON.stringify(repeats)}`);

out.push("\n== failures ==");
const grouped = new Map();
for (const e of entries) {
  if (e.response.status && e.response.status < 400) continue;
  const key = `${e.response.status || "none"} ${strip(e.request.url, 150)}`;
  grouped.set(key, (grouped.get(key) || 0) + 1);
}
if (!grouped.size) out.push("  none");
for (const [k, n] of [...grouped.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15)) out.push(`  x${n} ${k}`);

out.push("\n== external egress (not 127.0.0.1) ==");
const ext = entries.filter((e) => /^https?:\/\//i.test(e.request.url) && !/^https?:\/\/127\.0\.0\.1/i.test(e.request.url));
if (!ext.length) out.push("  none");
for (const e of ext.slice(0, 20)) {
  out.push(`  ${rel(e.startedDateTime)} ${e.response.status || "none"} ${strip(e.request.url, 150)}`);
}

out.push("\n== repeated upstream targets ==");
const targets = new Map();
for (const e of entries) {
  const t = innerTarget(e.request.url);
  if (t) targets.set(t.slice(0, 150), (targets.get(t.slice(0, 150)) || 0) + 1);
}
for (const [t, n] of [...targets.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)) out.push(`  x${n} ${t}`);

out.push("\n== slowest ==");
for (const e of entries.slice().sort((a, b) => (b.time || 0) - (a.time || 0)).slice(0, 8)) {
  out.push(`  ${rel(e.startedDateTime)} ${Math.round(e.time)}ms ${e.response.status} ${strip(e.request.url, 120)}`);
}

console.log(out.join("\n"));
