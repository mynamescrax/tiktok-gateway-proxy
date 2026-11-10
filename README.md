# TikTok gateway proxy — concept / reference implementation

A same-origin gateway that loads `www.tiktok.com` inside an iframe, so a network
filter that blocks TikTok domains sees only this host. It is a **concept /
research prototype**, not a product: its value is the documented map of what
TikTok's web app actually requires (signing, chunk loading, cookies, WS, QR
login) and the small amount of code that satisfies it. `FINDINGS.md` is the HAR
analysis behind every rule here.

It currently runs the full desktop web app in a real browser: feed, video,
lazy chunks, chat WebSocket, and QR login end to end.

Zero runtime dependencies — plain Node 18+ (`node server.mjs`).
`puppeteer-core` (dev, drives system Chrome) is only needed for the tests.

## Files

| File | What |
|---|---|
| `server.mjs` | HTTP gateway `/tt?url=&referer=&tt=1`, WS relay `/tt-ws?url=`, serves the rest |
| `tt-client.js` | Browser hook injected into every proxied HTML page |
| `cookies.mjs` | Cookie parsing/rewriting + the scope-aware jar |
| `cookies.test.mjs` | Unit tests for `cookies.mjs` (`npm test`) |
| `index.html` | Launcher UI (iframe + URL box + feed-only error-page auto-retry) at `/` |
| `FINDINGS.md` | HAR host map + why naive proxying breaks (signing, cookies, antibot) |
| `e2e.mjs` | Full browser test (feed boot, mapping unit checks, cookie/link regressions, media bytes, screenshot) |
| `verify.js`, `verify-ws.js` | Curl-level gateway checks + WS relay plumbing |
| `har-triage.mjs` | Reads a browser HAR: document timeline, reload loops, external egress, failures |
| `scratch/` | Investigation probes (`probe*`, `analyze*`, `check*`, `audit`, `netlog-*`) + the original 26-09-07 HAR capture |

## Run

```sh
cd tiktokproxy
npm start                  # http://127.0.0.1:8081  (PORT= env to change)
TT_ALLOW_TELEMETRY=1 node server.mjs   # also proxy telemetry (default: stub it)
TT_DEBUG=1 node server.mjs             # per-request gateway log to stderr
TT_NO_COOKIE_SCOPE=1 node server.mjs   # diagnostic: forward the whole cookie jar

npm test                   # cookie unit tests, no server needed
npm run verify             # gateway checks (server must be up)
npm run verify:ws          # WS relay plumbing
npm run test:e2e           # headless Chrome run, writes e2e-report.json + e2e-top.png
```

`e2e.mjs` honours `CHROME_PATH` (browser binary) and `PORT`. `TT_E2E_H2_OFF=1`
also disables h2/QUIC, which is only useful when isolating transport quirks —
the default run matches the browser command below.

When a browser misbehaves, capture a HAR and run
`node har-triage.mjs "<file.har>"`: it prints the document timeline (so a
launcher reload loop shows up as the same URL loaded several times), external
egress, failures and the most-repeated upstream targets.

Open `http://127.0.0.1:8081`, TikTok loads in the iframe. For a phone/tablet on
the same LAN, serve on `0.0.0.0` (edit `listen`) — but then `Secure` cookies are
stripped, so login persistence may suffer; localhost keeps them.

### Backend-only browsing

The gateway adds a same-origin Content Security Policy to pages and worker
responses, disables DNS prefetch, and restricts the launcher iframe's popups
and top-level navigation. URLs that the client misses are blocked by the browser
where those policies apply. External login helpers such as Google are blocked.

For browser-side HTTP and WebSocket egress enforcement on Windows, start a
separate Chrome profile with an unused loopback port as its outbound proxy.
Chrome reaches the localhost gateway via its implicit loopback bypass. The
Node backend uses its own network connection.

```powershell
& "${env:ProgramFiles}\Google\Chrome\Application\chrome.exe" `
  "--user-data-dir=$env:LOCALAPPDATA\TikTokProxyChrome" `
  "--proxy-server=http://127.0.0.1:9" `
  "--force-webrtc-ip-handling-policy=disable_non_proxied_udp" `
  "http://127.0.0.1:8081/"
```

## How it works

- **HTTP:** `/tt?url=<upstream>&referer=<page>&tt=1` forwards method/headers/body,
  follows ≤5 redirects (re-validated), strips `CSP`/`X-Frame-Options`/`Link`/
  `Alt-Svc`/etc., adds CORS `*`, rewrites absolute TikTok URLs in HTML/JS/CSS
  (never in JSON — see below), injects `tt-client.js`. Binary
  (video/images/`206`) streams raw with `Range` intact. App headers are forwarded
  as-is (denylist, not allowlist), so `x-secsdk-csrf-token`, `x-tt-*` and
  conditional headers survive; text responses keep upstream
  `Cache-Control`/`Expires` (body is rewritten, so ETags are dropped rather than
  replayed).
- **JSON is opaque:** API payloads are passed through byte-for-byte. They carry
  signed URLs and opaque tokens (`qrcode_index_url` for QR login,
  `ttwid_migration_ticket`, X-Bogus'd media URLs) that must reach the app exactly
  as issued — rewriting them produced gateway URLs the phone cannot reach and
  broke QR login. URLs the app actually uses are mapped by the client hook at
  fetch/assign time instead.
- **Cookies (`cookies.mjs`):** `Set-Cookie` from *every* hop (including the 302s
  login flows use) is rewritten for our origin — `Domain` dropped, `Path=/`
  forced so gateway requests actually send it back, `Secure` kept only when the
  gateway is TLS, `SameSite=None`→`Lax` on plain HTTP. The browser jar is shared
  (one origin), so the server remembers each cookie's original scope and rebuilds
  a per-host `Cookie` header: a `*.tiktokcdn.com` host never sees a `*.tiktok.com`
  session cookie. Cookies it has not learned yet (page-JS writes) pass through.
  The client hook applies the same rules to `document.cookie` writes, because
  apps write cookies their own way — TikTok's cookie-consent banner stores its
  decision as `cookie-consent; Domain=.tiktok.com; Secure; SameSite=None`, which
  a browser silently rejects on plain HTTP (no cookie → banner on every load).
- **Signing-safe:** JS sources keep relative paths; the client hook maps URLs to
  the gateway at `fetch`/XHR/WS time, *after* the app computes `X-Bogus`-style
  signatures over the upstream URL. Path+query are forwarded untouched. Only
  TikTok-family hosts are mapped — external links stay external, and the few
  same-origin absolute URLs the app builds (`https://<our host>/ttwid/check/`) are
  treated as default-host upstream paths.
- **Never proxy a gateway URL twice:** bundles contain absolute page/API URLs
  (`https://www.tiktok.com/shorten/`, `/logout`, `/foryou`) that must be rewritten
  so app code can navigate to them through the gateway. But the same strings are
  also used as *request targets*, and the app appends its own query params and
  resolves them against `www.tiktok.com`. The client hook therefore recognises a
  URL whose path is already `/tt?url=…` (even on an upstream host, even with
  extra params) and keeps it same-origin instead of proxying it again. Nesting
  made TikTok answer with its SPA 404 page — which broke QR login (the QR is
  built from `POST /shorten/` → `short_url`, so a 404 yields a dense raw URL).
- **SPA masking:** the hook `replaceState`s the gateway URL to the upstream path
  (`/foryou`), so TikTok's router sees real routes instead of redirecting `/tt`
  to its 404 page. Unknown same-origin paths are served by a server fallback as
  `www.tiktok.com` pages (also fixes reloads + `location.origin`-based API paths
  like `/ttwid/check/`).
- **Chunk glue (`&tt=1` sentinel):** webpack-style loaders concatenate chunk
  paths onto rewritten base URLs, and `import()` can't be hooked. The trailing
  sentinel marks the exact split point for client repair + server reattach.
  Trails starting with `&` are same-level params and left alone.
- **WS:** `/tt-ws?url=<wss-url>` replays the handshake with rewritten
  `Host`/`Origin`, then pipes TCP both ways (covers `im-ws.tiktok.com` chat —
  verified `ws.opened` in-browser).
- **Blocked:** `accounts.google.com`/`googleapis.com` (external login helpers) —
  the request is not proxied; CSP (`script-src 'self'`) refuses it before Chrome
  connects. Pure telemetry (`mon*` hosts, `/monitor_browser`, `/monitor_web`)
  gets `204` (or `{}` for JSON callers); SDK/config hosts (`mcs`, `webmssdk`,
  `verification`, `libraweb`, `starling`) ARE proxied — blocking them breaks
  secsdk init.

## Verified in headless Chrome (local, residential IP, 2026-11-10)

- Feed renders (real authors, counts, SSR + hydrated), router title correct
- Video **plays**: `readyState 4`, `currentTime` advancing, 1MB+ signed mp4
  bytes from `v16-webapp-prime.tiktok.com` through the gateway (`Range`/`206` OK)
- Dozens of lazy chunks load via sentinel reattach; no `ChunkLoadError`
- Chat WS `ws.opened` through `/tt-ws`; feed API signing works (`item_list` 200)
- `msToken` persists (SameSite downgrade on plain HTTP)
- **No external egress**: every non-gateway request Chrome attempted was
  CSP-blocked (the Google GSI script), no external WebSocket was opened, and the
  residual `ERR_ALPN_NEGOTIATION_FAILED` POSTs did not reproduce (0 in the run)
- Cookie regression checks: gateway `Set-Cookie` has `Domain` stripped and
  `Path=/`; `*.tiktok.com` cookies are withheld from `tiktokcdn*` hosts
- External links (`<a>` via attribute and via `.href`) and external `fetch` are
  left untouched instead of being mapped into a gateway 403
- QR login: `POST /shorten/` returns `{"code":0,…,"short_url":"https://www.tiktok.com/t/…"}`
  through the gateway (single proxy, no nesting), and the QR canvas renders
- **QR login completed in a real browser** (Firefox): session cookies
  (`sessionid`, `sid_guard`, `uid_tt`, `multi_sids`) come back through the
  gateway and the logged-in app loads (`im-api` chat, personalised feed)
- JS cookie writes with `Secure; SameSite=None; Domain=.tiktok.com` (TikTok's
  consent banner pattern) round-trip on plain HTTP after the hook rewrite
- Host-allowlist audit against a real (unproxied) tiktok.com HAR: all 23 hosts
  TikTok contacted are covered by `BASE_DOMAINS`, so nothing is being 403'd
- Profile "Videos" grid empty reproduced on real tiktok.com (`post/item_list`
  200 + 0 B) — upstream, see Known residual issues
- `npm test` (9 cookie unit tests) + `npm run verify` (10 curl-level checks) +
  `npm run verify:ws` pass

Run yourself: `npm test`, `npm run verify`, `npm run verify:ws`,
`npm run test:e2e` (server up first; the e2e writes `e2e-report.json` and
`e2e-top.png`, attributes failed requests to an initiator, and fails if Chrome
sends anything to an external origin or playback fails).

## Known residual issues

- Historical: ~6 auxiliary POSTs (`ppf eligibility`, `csp pa_prompt`, `graphql`
  footer, `prefetch`, `app_open_times`, wallet) used to die **in headless Chrome
  before sending** (`ERR_ALPN_NEGOTIATION_FAILED`, nothing in server logs). They
  did not reproduce on 2026-11-10 (0 ALPN failures; all recorded request
  failures were `net::ERR_ABORTED` lazy-chunk cancellations), so the `Alt-Svc`
  stripping + header/cookie changes may have removed the trigger. `e2e.mjs` now
  records an initiator per failure, so a reappearance can be attributed.
  Non-fatal either way (feed/video/chat unaffected); the launcher auto-retries the
  error page (max 2, counted across reloads to avoid a loop).
- Upstream version drift 404s (`common-monitors.1.1x.js`, cookie-banner ESM) —
  TikTok's own stale references, also 404 in production.
- PNS privacy-framework JSONP (`core.js`) resolves against the wrong base —
  benign (that endpoint 302→404 in the original HAR capture too).
- Login/captcha flows: QR login works, email/password and captcha were not
  tested. Cookies are scoped per upstream host server-side, but the browser jar is
  still one namespace: two hosts that set the same cookie name with different
  values collide (last write wins); no collisions were observed in the HARs.
- A few image requests can still miss the hook (CSS `background-image`/`image-set`
  set from JS is not intercepted). CSP blocks them, so they fail locally instead
  of leaking; cosmetic only, no egress.
- **Profile "Videos" tab is empty** (`Something went wrong` in the grid): TikTok
  answers `GET /api/post/item_list/` with `200` + an **empty body** (and a fresh
  `msToken` cookie). Not a routing/params problem: the same request replayed from
  the HAR (same URL, headers, cookies, UA) returns the same empty body
  **directly**, over **HTTP/1.1 and HTTP/2**, through the gateway with different
  `Referer`s, and with cookie scoping disabled — while `recommend`, `repost` and
  `explore` return 160–700 KB on the same connection. **Confirmed on real
  tiktok.com**: an unproxied HAR shows the identical `200`/`0 B` response for
  `post/item_list` next to a `698 KB` `repost/item_list`. The profile shell
  renders (header, counters, bio); only the post grid is affected — upstream
  behaviour, not the gateway.
- The launcher retry now only fires on the For You feed (`/`, `/foryou`). Profile,
  search and watch pages have no `<video>` and can show their own error cards, so
  retrying them just re-downloaded ~400 KB and aborted every in-flight API call
  (that was the source of the 3 document loads + 119 aborted requests in the
  `20-12-07` HAR).
- `https://m.tiktok.com/whale/heartbeat` 502s at TikTok's own edge on every load
  (two calls); harmless, but it is not stubbed as telemetry yet.
- `tiktok/v1/csp/pa_prompt` intermittently 502s through the gateway (upstream
  closes the connection); non-fatal.
- No HLS seen in captures (progressive mp4 only); `.m3u8` rewrite exists but is
  untested against TikTok.
- The server trusts `X-Forwarded-Proto` only from a loopback peer, so a TLS
  terminator must be on the same machine.

## If this were ever taken further

These are notes for a hypothetical follow-up, not a roadmap — the point of the
prototype is the mechanism, not the deployment.

1. Retest from a VPS (datacenter IPs are more likely to be challenged) and over
   **https** (native `SameSite=None` cookies; `cookies.mjs` keeps `Secure` when
   `req.socket.encrypted` or a loopback `X-Forwarded-Proto: https` is present).
2. Browser matrix: search, profiles, LIVE, settings, email login; capture failing
   requests with iPad/Safari UAs.
3. Injecting the URL-mapping bootstrap into workers (worker `fetch`/XHR are
   currently unhooked and CSP-blocked).
4. Port shape, if it were ever wired up for real: a query-param relay
   (`/proxy?url=…`) behind a reverse proxy, mounted under an **isolated hostname**
   with its own cookie jar — not root-routed on a shared origin.

## Legal and responsible use

This is a research prototype. It is not affiliated with, endorsed by, or
supported by TikTok. Running it means:

- **TikTok's Terms of Service** still apply to the account and content you use it
  with; proxying does not grant rights you don't have (e.g. redistributing
  content or bypassing regional availability).
- **Network filters** are often there for a reason. Using this to get around an
  employer/school/ISP policy can violate that policy regardless of the code.
- **Do not expose the gateway publicly.** It is an unauthenticated relay: anyone
  who can reach it can issue requests as themselves through it. Bind it to
  loopback (the default) or put authentication, per-user isolation and TLS in
  front of it.
- Content and credentials you load through it stay in that browser profile;
  don't reuse a profile you care about for experiments.
