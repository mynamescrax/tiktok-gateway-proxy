// End-to-end: load the launcher in headless Chrome, inspect the proxied feed.
// Usage: node e2e.mjs   (server.mjs must be running on 8081)
//   CHROME_PATH=/path/to/chrome   override the browser binary
//   TT_E2E_H2_OFF=1               also disable h2/QUIC (transport isolation)
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import assert from 'node:assert/strict';

const BASE = 'http://127.0.0.1:' + (process.env.PORT || 8081);
const CHROME = process.env.CHROME_PATH || (process.platform === 'win32'
  ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
  : '/usr/bin/google-chrome');
const args = [
  '--no-sandbox',
  '--disable-blink-features=AutomationControlled',
  // Chrome bypasses an outbound proxy for loopback; everything else fails
  // closed, which is exactly what this test asserts.
  '--proxy-server=http://127.0.0.1:9',
  '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
];
// Opt-in only: a passing run should describe the same browser config README.md
// tells users to start, not a transport-debug variant.
if (process.env.TT_E2E_H2_OFF === '1') args.push('--disable-quic', '--disable-http2');
const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  protocolTimeout: 60000,
  args,
});
const page = await browser.newPage();
page.setDefaultNavigationTimeout(30000);
page.setDefaultTimeout(20000);
await page.setViewport({ width: 1280, height: 900 });

const consoleMsgs = [];
const pageErrors = [];
const failedReqs = [];
const badResp = [];
const videoResponses = [];
let apiJsonSample = null;
const cdp = await page.createCDPSession();
await cdp.send('Network.enable');
// External traffic must never leave the browser. CSP-blocked requests are fine
// (Chrome refuses them before any connection); anything "sent" or failing at the
// transport layer is a real leak and fails the run.
const externalReq = new Map(); // requestId -> { method, type, url, outcome }
const externalWebSockets = [];
// App document loads. The launcher auto-retry must not reload a healthy feed
// (it once matched the i18n string "Something went wrong" inside <script>).
const appDocumentLoads = [];
cdp.on('Network.webSocketCreated', ({ url }) => {
  const origin = new URL(url).origin;
  if (origin !== BASE.replace(/^http/, 'ws')) externalWebSockets.push(url.slice(0, 200));
});
// Track initiators so a failing request can be attributed (page vs worker vs
// preflight). This is how the residual ALPN POSTs get pinned to a subsystem.
const reqMeta = new Map();
cdp.on('Network.requestWillBeSent', ({ requestId, request, type, initiator }) => {
  if (reqMeta.size > 5000) reqMeta.clear();
  const kind = (initiator && initiator.type) || 'other';
  const where = (initiator && (initiator.url || (initiator.stack && 'stack'))) || '';
  reqMeta.set(requestId, {
    method: request.method,
    url: request.url,
    initiator: where ? `${kind} ${where}` : kind,
  });
  try {
    const u = new URL(request.url);
    if (['http:', 'https:'].includes(u.protocol) && u.origin !== BASE) {
      externalReq.set(requestId, {
        method: request.method,
        type,
        url: request.url,
        outcome: 'pending',
      });
    } else if (type === 'Document' && request.url.startsWith(BASE) && request.url !== BASE + '/') {
      appDocumentLoads.push(request.url.slice(0, 140));
    }
  } catch {}
});
cdp.on('Network.responseReceived', ({ requestId }) => {
  const entry = externalReq.get(requestId);
  if (entry) entry.outcome = 'sent';
});
cdp.on('Network.loadingFinished', ({ requestId }) => {
  const entry = externalReq.get(requestId);
  if (entry) entry.outcome = 'sent';
});
cdp.on('Network.loadingFailed', ({ requestId, errorText, blockedReason }) => {
  const entry = externalReq.get(requestId);
  if (entry) entry.outcome = blockedReason ? `blocked:${blockedReason}` : `failed:${errorText}`;
  if (failedReqs.length >= 30) return;
  const meta = reqMeta.get(requestId) || {};
  failedReqs.push(
    `${meta.method || '?'} ${String(meta.url || '').slice(0, 380)} :: ${errorText}` +
    (blockedReason ? ` (${blockedReason})` : '') +
    ` initiator=${meta.initiator || 'unknown'}`,
  );
});
page.on('console', (m) => {
  if (consoleMsgs.length < 60) consoleMsgs.push(`[${m.type()}] ${m.text().slice(0, 220)}`);
});
page.on('pageerror', (e) => {
  if (pageErrors.length < 20) {
    const stack = e && e.stack ? String(e.stack).slice(0, 500) : String(e).slice(0, 300);
    pageErrors.push(stack);
  }
});
page.on('response', (r) => {
  const u = r.url();
  if (u.startsWith(BASE + '/tt?') && r.ok() && r.headers()['content-type']?.startsWith('video/')) {
    videoResponses.push(r.status());
  }
  if (r.status() >= 400 && u.startsWith(BASE) && badResp.length < 25) {
    badResp.push(`${r.status()} ${u.slice(0, 420)}`);
  }
  // API JSON must reach the app byte-identical (signed/opaque URLs such as the
  // QR-login `qrcode_index_url`). Rewriting it in the server used to break QR.
  if (apiJsonSample === null && /item_list/.test(u)) {
    apiJsonSample = '';
    r.text().then((body) => {
      apiJsonSample = {
        len: body.length,
        hasGatewayRewrite: /\/tt\?url=/.test(body),
        head: body.slice(0, 60),
      };
    }).catch(() => { apiJsonSample = { error: true }; });
  }
});

await page.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 30000 });
// wait for the launcher iframe to exist and point at the gateway
await page.waitForSelector('#frame', { timeout: 10000 });
await page.waitForFunction(
  () => document.getElementById('frame')?.src.includes('/tt?url='),
  { timeout: 10000 },
);
// give the app time to boot + fetch feed (bounded)
await new Promise((r) => setTimeout(r, 15000));

const frames = page.frames();
// The app frame masks its URL to the upstream path after boot, so detect it
// by the hook marker instead of the gateway URL.
let app = null;
for (const f of frames) {
  try {
    // eslint-disable-next-line no-await-in-loop
    if (await f.evaluate(() => !!window.__TT_INIT__)) {
      app = f;
      break;
    }
  } catch {}
}
const report = {
  frameCount: frames.length,
  appFrame: app ? app.url().slice(0, 140) : null,
};
if (app) {
  report.frameEval = await app.evaluate(() => ({
    href: location.href.slice(0, 140),
    target: (window.__TT_TARGET__ || null)?.slice?.(0, 120) || null,
    hook: !!window.__TT_INIT__,
    videos: document.querySelectorAll('video').length,
    images: document.querySelectorAll('img').length,
    imagesLoaded: [...document.images].filter((i) => i.complete && i.naturalWidth > 0).length,
    scripts: document.querySelectorAll('script[src]').length,
    bodyText: document.body ? document.body.innerText.slice(0, 300) : null,
    title: document.title,
  })).catch((e) => ({ evalError: String(e).slice(0, 200) }));
  // unit-check the concat repair + basic mapping inside the live page
  report.mapping = await app.evaluate(() => {
    const proxify = window.__ttProxify;
    if (!proxify) return { seam: false };
    const base = 'https://sf16-website-login.neutral.tiktokcdn-eu.com/obj/tiktok_web_login_static_eu/tiktok/webapp/main/react-v18/webapp-desktop/';
    const glued = '/tt?url=' + encodeURIComponent(base) +
      '&referer=' + encodeURIComponent('https://www.tiktok.com/foryou?lang=en') +
      '&tt=1' + 'static/js/async/82403.abcd1234.js';
    const out = proxify(glued);
    const img = document.createElement('img');
    const candidate = 'https://www.tiktok.com/favicon.ico';
    img.setAttribute('srcset', candidate + ' 1x, ' + candidate + ' 2x');
    let inner = null;
    try {
      inner = decodeURIComponent(new URL(out, location.href).searchParams.get('url'));
    } catch {}
    return {
      seam: true,
      repaired: out,
      inner,
      srcset: img.getAttribute('srcset') === proxify(candidate) + ' 1x, ' + proxify(candidate) + ' 2x',
      relativeApi: proxify('/api/recommend/item_list/').slice(0, 120),
      // The app sometimes absolutises our gateway path with a hardcoded https:.
      // That must come back scheme-less (same origin), not as a dead https URL.
      wrongScheme: location.protocol === 'http:'
        ? proxify('https://' + location.host + '/tt?url=' + encodeURIComponent(candidate) + '&tt=1')
        : null,
      wrongSchemeWs: location.protocol === 'http:'
        ? proxify('https://' + location.host + '/tt-ws?url=' + encodeURIComponent('wss://www.tiktok.com/x'))
        : null,
      // App code resolves a rewritten URL against the upstream origin and
      // appends its own params. That must stay a single gateway URL.
      absolutisedGateway: proxify(
        'https://www.tiktok.com/tt?WebIdLastTime=1&url=' +
        encodeURIComponent('https://www.tiktok.com/shorten/') + '&tt=1',
      ),
    };
  }).catch((e) => ({ evalError: String(e).slice(0, 200) }));
  // Regression check: non-TikTok URLs must be left alone by the hook. Mapping
  // them used to turn ordinary links/fetches into gateway 403s.
  report.cookieWrite = await app.evaluate(() => {
    // Exactly how TikTok's cookie-consent banner writes its decision.
    const value = JSON.stringify({ v: 1, t: Date.now() });
    document.cookie = 'tt_probe_consent=' + encodeURIComponent(value) +
      '; expires=Wed, 10 Nov 2027 00:00:00 GMT; path=/; domain=.tiktok.com; secure; SameSite=None';
    const stored = document.cookie.split(';').some((c) => c.trim().startsWith('tt_probe_consent='));
    const roundTrip = stored &&
      decodeURIComponent((document.cookie.match(/tt_probe_consent=([^;]*)/) || [])[1] || '') === value;
    document.cookie = 'tt_probe_consent=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/';
    return { stored, roundTrip };
  }).catch((e) => ({ evalError: String(e).slice(0, 200) }));
  report.externalLinks = await app.evaluate(() => {
    const a = document.createElement('a');
    document.body.appendChild(a);
    a.setAttribute('href', 'https://example.com/terms');
    const viaAttribute = a.getAttribute('href');
    a.href = 'https://example.org/store';
    const viaProperty = a.getAttribute('href');
    a.setAttribute('href', 'https://www.tiktok.com/@someone');
    const tiktok = a.getAttribute('href');
    a.remove();
    return {
      viaAttribute,
      viaProperty,
      tiktokProxied: /^\/tt\?url=/.test(tiktok) && tiktok.indexOf(encodeURIComponent('www.tiktok.com')) !== -1,
      externalFetch: String(window.__ttProxify('https://example.com/api')),
    };
  }).catch((e) => ({ evalError: String(e).slice(0, 200) }));
  report.pushState = await app.evaluate(() => {
    // same-page mapping check (fake routes would trigger router fetches)
    const before = location.href;
    history.pushState({ t: 1 }, '', '/foryou?lang=en');
    return {
      before: before.slice(0, 120),
      after: location.href.slice(0, 160),
      target: String(window.__TT_TARGET__ || '').slice(0, 120),
    };
  }).catch((e) => ({ evalError: String(e).slice(0, 200) }));
  // media check: are real video bytes flowing through the gateway?
  report.media = await app.evaluate(() => {
    const vids = [...document.querySelectorAll('video')].map((v) => ({
      readyState: v.readyState,
      currentTime: Math.round(v.currentTime * 10) / 10,
      src: (v.currentSrc || v.src || '').slice(0, 130),
    }));
    const res = performance.getEntriesByType('resource')
      .filter((r) => /tt\?url=/.test(r.name) && (/mp4|video|image|cdn|tos/i.test(r.name)))
      .map((r) => ({
        bytes: r.transferSize || r.decodedBodySize || 0,
        name: decodeURIComponent(r.name).slice(0, 110),
      }))
      .sort((a, b) => b.bytes - a.bytes)
      .slice(0, 8);
    return { videos: vids, topResources: res };
  }).catch((e) => ({ evalError: String(e).slice(0, 200) }));
  // A profile page must not trip the launcher retry loop: it has no <video> and
  // can legitimately show an upstream error card for its post list. One
  // navigation = one document load; a retry loop adds two more.
  const docsBeforeProfile = appDocumentLoads.length;
  report.feedDocLoads = docsBeforeProfile;
  await app.goto(
    BASE + '/tt?url=' + encodeURIComponent('https://www.tiktok.com/@tiktok?lang=en') + '&tt=1',
    { waitUntil: 'domcontentloaded', timeout: 30000 },
  ).catch(() => {});
  await new Promise((r) => setTimeout(r, 9000));
  report.profileDocLoads = appDocumentLoads.length - docsBeforeProfile;
}
await page.screenshot({ path: 'e2e-top.png', timeout: 15000 }).catch(() => {});
report.console = consoleMsgs;
report.pageErrors = pageErrors;
report.failedReqs = failedReqs;
report.badResp = badResp;
report.externalOrigins = [...new Set([...externalReq.values()].map((e) => new URL(e.url).origin))];
report.externalRequests = [...externalReq.values()].map(
  (e) => `${e.method} ${e.type} ${e.url.slice(0, 160)} -> ${e.outcome}`,
);
report.externalLeaks = [...externalReq.values()]
  .filter((e) => e.outcome !== 'blocked:csp' && !e.outcome.startsWith('blocked:'))
  .map((e) => `${e.url} -> ${e.outcome}`);
report.externalWebSockets = externalWebSockets;
report.appDocumentLoads = appDocumentLoads;
report.apiJson = apiJsonSample;
report.videoResponses = videoResponses;
fs.writeFileSync('e2e-report.json', JSON.stringify(report, null, 1));
console.log(JSON.stringify({ ...report, console: `${consoleMsgs.length} msgs` }, null, 1).slice(0, 3000));
await browser.close();
assert.deepEqual(report.externalLeaks, [], 'Browser sent a request to an external origin');
assert.deepEqual(report.externalWebSockets, [], 'Browser opened an external WebSocket');
assert.equal(report.feedDocLoads, 1,
  'Feed document loaded more than once (launcher reload loop): ' + JSON.stringify(report.appDocumentLoads));
assert.equal(report.profileDocLoads, 1,
  'Profile page was reloaded by the launcher retry loop: ' + report.profileDocLoads);
assert.ok(report.frameEval?.hook, 'TikTok client hook did not load');
assert.equal(report.externalLinks?.viaAttribute, 'https://example.com/terms',
  'External link was rewritten to the gateway');
assert.equal(report.externalLinks?.viaProperty, 'https://example.org/store',
  'External link set via .href was rewritten to the gateway');
assert.equal(report.externalLinks?.externalFetch, 'https://example.com/api',
  'External fetch was rewritten to the gateway');
assert.ok(report.externalLinks?.tiktokProxied, 'TikTok link was not mapped to the gateway');
assert.ok(report.mapping?.srcset, 'Responsive image candidates did not map to the gateway');
assert.ok(report.frameEval?.imagesLoaded > 0,
  'No <img> loaded through the gateway (images: ' + JSON.stringify(report.frameEval) + ')');
assert.ok(!report.apiJson || report.apiJson.error || report.apiJson.hasGatewayRewrite === false,
  'API JSON was rewritten by the server: ' + JSON.stringify(report.apiJson));
assert.ok(!report.mapping?.wrongScheme || report.mapping.wrongScheme.startsWith('/tt?'),
  'https-absolutised gateway URL was not kept same-origin: ' + report.mapping?.wrongScheme);
assert.ok(!report.mapping?.wrongSchemeWs || report.mapping.wrongSchemeWs.startsWith('/tt-ws?'),
  'https-absolutised WS gateway URL was not kept same-origin: ' + report.mapping?.wrongSchemeWs);
assert.ok(report.mapping?.absolutisedGateway?.startsWith('/tt?'),
  'Absolutised gateway URL was proxied twice: ' + report.mapping?.absolutisedGateway);
assert.ok(report.cookieWrite?.roundTrip,
  'JS cookie write with Secure/SameSite=None on http was dropped: ' + JSON.stringify(report.cookieWrite));
assert.ok(report.videoResponses.length, 'Gateway did not return video data');
assert.ok(report.media?.videos.some((v) => v.readyState >= 2 && v.currentTime > 0),
  'No TikTok video played through the gateway');
