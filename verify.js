// Gateway verification suite (runs against local server on 8081).
const BASE = 'http://127.0.0.1:' + (process.env.PORT || 8081);
const FEED = 'https://www.tiktok.com/foryou?lang=en';

function gw(url, referer) {
  return BASE + '/tt?url=' + encodeURIComponent(url) +
    (referer ? '&referer=' + encodeURIComponent(referer) : '') + '&tt=1';
}
const results = [];
async function test(name, fn) {
  try {
    const info = await fn();
    results.push(['PASS', name, info]);
  } catch (e) {
    results.push(['FAIL', name, String(e.message).slice(0, 200)]);
  }
}

/* eslint-disable no-await-in-loop */
(async () => {
  const page = await fetch(gw(FEED), {
    headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36' },
  });
  if (!page.ok) throw new Error('Feed status ' + page.status);
  if (!page.headers.get('content-security-policy')?.includes("default-src 'self'")) {
    throw new Error('Feed is missing its same-origin content policy');
  }
  const doc = await page.text();
  const found = [...doc.matchAll(/\/tt\?url=([^&"'<>\\ ]+)/g)]
    .map((m) => decodeURIComponent(m[1]));
  const jsAsset = found.find((u) => new URL(u).pathname.endsWith('.js'));

  await test('js asset via gateway', async () => {
    const r = await fetch(gw(jsAsset, 'https://www.tiktok.com/foryou?lang=en'));
    const t = await r.text();
    if (r.status !== 200) throw new Error('status ' + r.status);
    const ct = r.headers.get('content-type');
    if (!/javascript/.test(ct || '')) throw new Error('ctype ' + ct);
    return `${r.status} ${ct} len=${t.length} rewritten=${(t.match(/\/tt\?url=/g) || []).length}`;
  });

  await test('telemetry blocked (204)', async () => {
    const r = await fetch(gw('https://mon-i18n.tiktokv.com/monitor_web/settings/browser-settings?bid=x'));
    if (r.status !== 204) throw new Error('status ' + r.status);
    return '204 ok';
  });

  await test('non-tiktok host blocked (403)', async () => {
    const r = await fetch(gw('https://example.com/'));
    if (r.status !== 403) throw new Error('status ' + r.status);
    return '403 ok';
  });

  await test('private IP blocked (403)', async () => {
    const r = await fetch(gw('http://192.168.1.1/'));
    if (r.status !== 403) throw new Error('status ' + r.status);
    return '403 ok';
  });

  await test('OPTIONS preflight', async () => {
    const r = await fetch(gw('https://www.tiktok.com/api/compliance/settings/'), { method: 'OPTIONS' });
    if (r.status !== 204) throw new Error('status ' + r.status);
    return `204 cors=${r.headers.get('access-control-allow-origin')}`;
  });

  await test('client hook served', async () => {
    const r = await fetch(BASE + '/tt-client.js');
    const t = await r.text();
    if (!t.includes('__TT_TARGET__') || !t.includes('/tt-ws')) throw new Error('hook incomplete');
    return `${r.status} len=${t.length}`;
  });

  await test('set-cookie scoped to the gateway origin', async () => {
    const list = page.headers.getSetCookie ? page.headers.getSetCookie() : [];
    if (!list.length) return 'upstream sent no cookies this time';
    for (const c of list) {
      if (/;\s*domain=/i.test(c)) throw new Error('Domain leaked: ' + c.slice(0, 90));
      if (!/;\s*path=\//i.test(c)) throw new Error('Path is not /: ' + c.slice(0, 90));
    }
    return `${list.length} cookie(s), Domain stripped, Path=/`;
  });

  await test('rewritten text keeps an accurate content-length', async () => {
    const r = await fetch(gw(jsAsset, FEED));
    const body = await r.text();
    const declared = Number(r.headers.get('content-length'));
    const actual = Buffer.byteLength(body, 'utf8');
    if (!Number.isFinite(declared) || declared !== actual) {
      throw new Error(`content-length ${declared} != ${actual}`);
    }
    return `${declared} bytes, cache-control=${r.headers.get('cache-control') || 'none'}`;
  });

  await test('API JSON is passed through unmodified', async () => {
    // The server used to rewrite absolute TikTok URLs inside JSON, which turned
    // opaque payloads such as the QR-login `qrcode_index_url` into
    // http://127.0.0.1/tt?url=... and broke QR creation.
    const r = await fetch(gw('https://www.tiktok.com/api/compliance/settings/?aid=1988&app_name=tiktok_web', FEED));
    const body = await r.text();
    if (r.status !== 200) throw new Error('status ' + r.status);
    const rewrites = (body.match(/\/tt\?url=/g) || []).length;
    if (rewrites) throw new Error(`${rewrites} gateway URL(s) found in JSON payload`);
    return `${body.length} bytes, 0 rewrites`;
  });

  await test('HEAD passthrough', async () => {
    const r = await fetch(gw(FEED), { method: 'HEAD' });
    if (r.status !== 200) throw new Error('status ' + r.status);
    return `200 len=${r.headers.get('content-length') || 'none'}`;
  });

  console.log('JS asset: ' + (jsAsset || 'NONE').slice(0, 120));
  for (const [s, n, i] of results) console.log(`${s}  ${n}  (${i})`);
  const fails = results.filter((r) => r[0] === 'FAIL').length;
  process.exit(fails ? 1 : 0);
})();
