// WS relay plumbing test: raw socket handshake through /tt-ws.
// Target is a non-WS path on an allowed host; TikTok nginx should answer 400,
// which proves the handshake was forwarded and the response piped back.
const net = require('net');
const crypto = require('crypto');
const PORT = Number(process.env.PORT || 8081);
const key = crypto.randomBytes(16).toString('base64');
const req =
  'GET /tt-ws?url=' + encodeURIComponent('wss://www.tiktok.com/ws-probe') + ' HTTP/1.1\r\n' +
  'Host: 127.0.0.1:' + PORT + '\r\n' +
  'Upgrade: websocket\r\n' +
  'Connection: Upgrade\r\n' +
  'Sec-WebSocket-Key: ' + key + '\r\n' +
  'Sec-WebSocket-Version: 13\r\n' +
  'Origin: http://127.0.0.1:' + PORT + '\r\n\r\n';
const s = net.connect(PORT, '127.0.0.1', () => s.write(req));
let data = '';
const timer = setTimeout(() => {
  console.log('TIMEOUT, got so far:', JSON.stringify(data.slice(0, 200)));
  process.exit(2);
}, 25000);
s.on('data', (c) => {
  data += c.toString('utf8');
  if (data.includes('\r\n\r\n') || data.length > 400) {
    clearTimeout(timer);
    console.log('GOT RESPONSE HEAD:');
    console.log(data.slice(0, 300));
    s.destroy();
    process.exit(0);
  }
});
s.on('error', (e) => { clearTimeout(timer); console.log('SOCKET ERROR:', e.message); process.exit(1); });
s.on('close', () => { clearTimeout(timer); console.log('CLOSED, got:', JSON.stringify(data.slice(0, 200))); process.exit(3); });
