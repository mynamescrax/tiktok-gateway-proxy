# TikTok HAR findings (`scratch/www.tiktok.com_Archive [26-09-07 21-59-33].har`)

494 entries. Page: `https://www.tiktok.com/foryou?lang=en` (446 KB HTML SPA, 63 scripts).

## Host map (requests)

| Host | # | What |
|---|---|---|
| `sf16-website-login.neutral.tiktokcdn-eu.com` | 218 | Webapp JS/CSS bundles (React desktop build) |
| `mon-i18n.tiktokv.com` | 74 | Telemetry / CSP reports (can drop) |
| `www.tiktok.com` | 48 | Document + `/api/*` JSON (signed) |
| `mcs16-normal-no1a.tiktokw.eu`, `mcs-ie.tiktokw.eu`, `mcs-ie2.tiktokw.eu` | 61 | Telemetry `/v1/list` (can drop) |
| `mon16-normal-no1a.tiktokv.eu`, `mon.tiktokv.com`, `mon16-normal-useastred.tiktokv.eu` | 24 | Telemetry (can drop) |
| `p16-common-sign.tiktokcdn-eu.com`, `p19-common-sign.tiktokcdn-eu.com` | 12 | Images/avatars (must proxy) |
| `sf16-website-login.neutral.ttwstatic.com` | 7 | Captcha / secsdk / slardar antibot JS (must proxy) |
| `v16-webapp-prime.tiktok.com` (6), `v16-webapp.tiktokcdn-eu.com` (1) | 7 | **Video mp4** `video/tos/...?a=1988&bti=...&bt=...&ft=...&mime_type=video_mp4&rc=...` (signed, Range requests) |
| `login-no1a.www.tiktok.com`, `web-sg.tiktok.com`, `us.tiktok.com` | 22 | Passport/login/region (auth; login flow out of scope) |
| `webcast.tiktok.com` | 8 | LIVE (feed returns 0/blocked in this capture) |
| `im-ws.tiktok.com` (wss, 101), `im-api.tiktok.com` | 3 | Chat websocket + REST |
| `libraweb-ttp2`, `starling-ttp2`, `webmssdk16-*`, `verification16-*` | 4 | Telemetry/AB-test (can drop) |
| `accounts.google.com`, `www.googleapis.com` | 3 | Google login — leave direct, do NOT proxy |

No HLS in this capture — video is progressive mp4. 174 POST / 307 GET / 13 OPTIONS.

## Hard parts (why naive proxying breaks)

1. **Signed API calls.** `/api/recommend/item_list/` etc. carry `X-Bogus`, `msToken`,
   `X-Dynosaur`/`X-Gnarly`-style query params generated in JS (sladar/secsdk).
   The recommend POST body is **gzipped JSON** (`content-encoding: gzip` on the request).
   Signatures cover path+query as the app sees it.
   Consequence: the proxy must rewrite URLs **at fetch time on the final signed URL**
   (preserving path+query exactly), never rewrite relative API paths inside JS sources.
2. **Rotating cookies.** 73 `Set-Cookie` in the capture, `Domain=tiktok.com`
   (`msToken` rotates constantly, `ttwid`, `sid_tt`, `sessionid`, `odin_tt`, ...).
   Proxy must strip `Domain`, forward cookies back, and tolerate name collisions
   across upstream hosts sharing one site origin.
3. **Signed media URLs.** Video mp4 + image URLs from API JSON are time-limited
   signed queries — proxy must forward the query untouched and support `Range`/`206`.
4. **Antibot JS.** `slardar.web.pre.js`, `secsdk-*.umd.js`, goofy-captcha run
   fingerprinting; server-side fetches (wrong TLS fingerprint, no cookies) may get
   challenged. Residential egress helps.
5. **CSP/frame headers.** Document sends `X-Frame-Options: SAMEORIGIN` + a huge
   `content-security-policy` with `report-uri https://mon-i18n...` — both must be
   stripped server-side or the iframe embed + proxied hosts get blocked/reported.
6. **WebSocket.** `wss://im-ws.tiktok.com/ws/v2?...&access_key=...` with
   `Sec-WebSocket-Protocol: binary, base64, pbbp2` + cookies — needs a WS relay
   that replays the handshake with rewritten `Host`/`Origin`.

## Proxy strategy used here

- Query gateway `/tt?url=<upstream>&referer=<page>&tt=1` (a common relay-proxy
  pattern), so no DNS/Caddy changes are needed for tests.
  The trailing `&tt=1` is a sentinel: webpack-style loaders glue chunk paths
  after our query string (`import()` can't be hooked), and the sentinel marks
  the exact split point for client repair + server reattach.
- Runtime client hook (`tt-client.js`) maps absolute + relative URLs to the gateway
  **after** the app signs them; static absolute asset URLs are rewritten
  server-side in HTML/JS/CSS — but never inside JSON. API payloads carry opaque
  values (`qrcode_index_url`, migration tickets, signed media URLs) that must
  stay byte-identical; rewriting them broke QR login by pointing the payload at
  `http://127.0.0.1/tt?url=...`.
- SPA masking: gateway URLs are `replaceState`d to upstream paths so the
  router boots on real routes; unknown same-origin paths fall back to
  `www.tiktok.com` server-side (also fixes reloads + `location.origin` APIs).
- Telemetry allowlist is narrow (only `mon*` hosts + `/monitor_browser|_web`
  are stubbed) — SDK/config hosts stay proxied, otherwise secsdk init breaks.
- `accounts.google.com` / `googleapis.com` are never rewritten (stay direct);
  CSP `default-src 'self'` refuses those subresources before any connection, and
  the e2e asserts nothing external actually leaves the browser.
- Cookies are rewritten for our origin (`Domain` dropped, `Path=/`) but scoped
  per upstream host when forwarded — see "Cookie scoping" below.

## Browser-verified 2026-11-10 (headless Chrome, residential IP)

Feed renders, video plays (`readyState 4`, time advancing, MBs of signed
`v16-webapp-prime` mp4 through the gateway), lazy chunks load, chat WS opens,
feed API signing works, `msToken` persists (after `SameSite=None`→`Lax`
downgrade on plain HTTP — Chrome excludes `SameSite=None` on insecure origins).
Screenshot: `e2e-top.png`. Full report: `e2e-report.json` via `e2e.mjs`.

## Open mystery: pre-send ALPN failures on plain HTTP

~6 auxiliary POSTs (`ppf eligibility`, `csp pa_prompt`, `graphql` footer,
`prefetch`, `app_open_times`, wallet) die in headless Chrome **before any byte
reaches the proxy** (`ERR_ALPN_NEGOTIATION_FAILED`, no OPTIONS preflight ever
issued, nothing in server logs). Isolated with netlog + targeted probes
(`probe5`–`probe12`): identical-shaped manual fetches — same method, custom
headers, gzip bodies, keepalive, cache modes, under saturation — all return 200
through the same gateway. Preflights to the gateway work (curl + manual).
Not load, not body, not headers, not cache mode, not system proxy
(`--no-proxy-server` changes nothing), not h2/QUIC (`--disable-quic
--disable-http2` changes nothing). Non-fatal (feed/video/chat unaffected), and
the launcher auto-retries the error page if the feed call itself flakes.
Hypothesis: plain-HTTP edge in headless Chrome — must retest over https
(the production target is https-only, where `SameSite=None` cookies also work
natively).

### Follow-up 2026-11-10 (post-fix run)

Did not reproduce: the e2e run recorded 0 `ERR_ALPN_NEGOTIATION_FAILED` and 30
`net::ERR_ABORTED` lazy-chunk cancellations, with the feed, the signed
`item_list` POST and video playback all healthy. What changed since the capture
above: upstream `Alt-Svc` is stripped, requests now carry an initiator in the
report, app headers are forwarded instead of an allowlist, and cookies are
scoped per upstream host. Attribution is no longer guesswork — `e2e.mjs` logs
`initiator=script|parser|other` for every failure, which is how a worker-scoped
regression would show up (worker `fetch` is unhooked and CSP-blocked).

### QR login: why `/shorten/` mattered (2026-11-10)

The login micro-frontend (`tiktok_fe_login_vmok`) builds the QR payload in two
steps: `POST https://www.tiktok.com/shorten/` with
`{belong:"tiktok-webapp-qrcode", targets:[scan_index_url]}`, then
`qrCodeUrl = response.data[0].short_url ?? scan_index_url`.

The URL is a **hardcoded absolute string inside the bundle**, so server-side
rewriting turned it into `/tt?url=…shorten/…&tt=1`; the app then resolved that
against `www.tiktok.com` and appended its own params, producing
`https://www.tiktok.com/tt?<params>&url=…shorten/…` — a *nested* gateway URL.
TikTok answered with its SPA 404 page (HTML, 70 KB), `short_url` became
`undefined`, and the QR fell back to the ~230-char `scan_index` URL: a much
denser QR that phones struggle to read. After keeping already-proxied URLs
same-origin in `tt-client.js`, the POST returns
`{"code":0,…,"data":[{"status":"success","short_url":"https://www.tiktok.com/t/ZN8Pye2uE/"}]}`
and the QR encodes the short link.

Note the same bundles also assign absolute URLs to `location.href`
(`/logout`, `/foryou` after login), which is why they cannot simply be left
unrewritten — the guard has to live in the hook, not in the rewriter.

### Profile video list returns an empty body (2026-11-10)

`GET /api/post/item_list/` — the profile "Videos" grid — comes back as
`200 application/json` with `Content-Length: 0` and a freshly rotated `msToken`
`Set-Cookie`. Every other signed endpoint on the same connection works
(`recommend/item_list` 160 KB, `repost/item_list` 690 KB, `explore` 700 KB), and
the request itself is well-formed: replaying it verbatim from the HAR (URL,
`X-Dynosaur`/`X-Gnarly`, `msToken`, UA, cookies) produces the same empty body
when sent **directly** to TikTok over HTTP/1.1 and HTTP/2, and through the
gateway with three different `Referer` headers. Disabling per-host cookie
scoping (`TT_NO_COOKIE_SCOPE=1`) changes nothing.

That is TikTok's edge declining the call (the 200-empty + new `msToken` shape is
its soft-block response for scrape-sensitive endpoints), not a proxy rewrite
bug. **Confirmed on real tiktok.com**: an unproxied capture
(`www.tiktok.com_Archive [26-11-10 20-28-20].har`, a `/@user/video/…` page where
the profile was opened) shows the same thing —

```
19.25s 200 application/json  2379b  /api/user/detail/          status=0
19.29s 200 application/json     0b  /api/post/item_list/      (empty)
19.46s 200 application/json 698443b  /api/repost/item_list/   status=0 items=30
20.73s 200 application/json     0b  /api/post/item_list/      (empty)
```

— so the empty "Videos" grid is TikTok's own current behaviour (their web app
bug or an account/region-level block), not something the gateway causes. The
profile shell still renders; only the post grid shows "Something went wrong".
Cover images, tabs and the rest of the app are unaffected.

The launcher used to auto-retry any page showing `Something went wrong` — which
turned this upstream block into a 3× reload loop on profiles (each reload
aborting ~40 in-flight requests). The retry is now restricted to the For You
feed.

### Cookie consent banner (why it kept coming back)

TikTok's cookie-consent micro-frontend (`pns/tiktok-cookie-banner`) persists its
decision with:

```js
ht.set("cookie-consent", JSON.stringify(state),
       { expires: 390, domain: ".tiktok.com", secure: true, sameSite: "None" });
setTimeout(() => { if (ht.get("cookie-consent") !== state) Jn("cookie_banner_save_cookie_failed") }, 100);
```

`Set-Cookie` headers are rewritten server-side (`cookies.mjs` drops `Domain`,
`Secure`, downgrades `SameSite=None`), but this is a **JS write**, so it bypassed
that logic: on plain HTTP the browser rejects a `Secure`/`SameSite=None` cookie
outright, `ht.get()` returns `undefined`, the banner reports
`cookie_banner_save_cookie_failed` and re-renders on the next load. The client
hook now applies the same rules inside its `document.cookie` setter, so the
consent cookie round-trips (covered by an e2e assertion that writes the exact
consent-banner cookie string).

### Cookie scoping (why one jar is not enough)

494 HAR entries show `Set-Cookie` from `www.tiktok.com`, `login-no1a.www.tiktok.com`
and the CDN hosts. In a real browser those land in *different* jars (registrable
domains differ). Proxied under one origin they all land in ours, so forwarding
the browser's `Cookie` header verbatim sends `sessionid`/`ttwid` to
`*.tiktokcdn-eu.com` — something a browser can never do. `cookies.mjs` records
the original `Domain` per cookie (and host-only vs domain-scoped) and rebuilds
the header per upstream host; cookies it has not learned yet (page-JS writes)
still pass through.
