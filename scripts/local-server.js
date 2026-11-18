// 本機伺服器：開網頁，並讓網頁把求解交給「原生多執行緒求解器」（用滿所有 CPU 核心）。
//   npm run local          → http://localhost:8765
// 只綁在 127.0.0.1（別的電腦連不到）；網頁偵測到 /api/health 就會在「設定」分頁出現原生選項。
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const Native = require('../src/solver_native.js');

const HTML = path.join(__dirname, '..', 'infalsus_solver.html');
const okHost = (h) => /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(h || ''); // 擋 DNS rebinding

function createServer() { return http.createServer((req, res) => {
  if (!okHost(req.headers.host)) { res.statusCode = 403; return res.end('forbidden'); }
  const url = req.url.split('?')[0];
  if (req.method === 'GET' && (url === '/' || url === '/index.html')) {
    res.setHeader('content-type', 'text/html; charset=utf-8'); res.setHeader('cache-control', 'no-store');
    return fs.createReadStream(HTML).pipe(res);
  }
  if (req.method === 'GET' && url === '/api/health') {
    res.setHeader('content-type', 'application/json');
    return res.end(JSON.stringify({ native: Native.available(), cores: Native.cores() }));
  }
  if (req.method === 'POST' && url === '/api/solve') {
    let body = '';
    req.on('data', (d) => { body += d; if (body.length > 64 << 20) req.destroy(); });
    req.on('end', async () => {
      let m; try { m = JSON.parse(body); } catch (e) { res.statusCode = 400; return res.end('bad json'); }
      const ac = new AbortController();
      res.on('close', () => { if (!res.writableFinished) ac.abort(); }); // 網頁按停止或關掉 → 結束原生程序
      res.setHeader('content-type', 'application/x-ndjson'); res.setHeader('cache-control', 'no-store');
      const send = (o) => { if (!res.writableEnded) res.write(JSON.stringify(o) + '\n'); };
      try {
        const threads = Math.max(1, Math.min(Native.cores() * 2, +m.threads || Native.cores()));
        const r = await Native.solveAsync(m.prob, { threads, timeLimitMs: m.timeLimitMs, signal: ac.signal, onImprove: (b) => send({ type: 'improve', b }) });
        if (r) send({ type: 'done', r });
      } catch (e) { send({ type: 'error', message: String(e && e.message || e) }); }
      res.end();
    });
    return;
  }
  res.statusCode = 404; res.end('not found');
}); }
module.exports = { createServer };
if (require.main === module) {
  const PORT = +process.env.PORT || 8765;
  createServer().listen(PORT, '127.0.0.1', () => {
    console.log('本機網站：http://localhost:' + PORT);
    console.log(Native.available() ? '原生多執行緒求解器：可用（' + Native.cores() + ' 個邏輯核心）' : '找不到原生求解器，請先執行 npm run build:native（需要 Rust）；網頁會改用 WASM。');
  });
}
