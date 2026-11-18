/*
 * 原生多執行緒求解器的 Node 串接層（Node 專用，瀏覽器用不到）。
 * 原生執行檔 solver_native（Rust，wasm/src/bin/solver_native.rs）：多個執行緒共用最佳值、動態分工，
 * 可以用滿所有 CPU 核心。這裡負責：prepare() → 攤平 → 寫檔 → 執行 → 解析結果 → 組成和 JS／WASM 版一樣的結果。
 *
 *   const Native = require('./solver_native.js');
 *   Native.available();                                   // 找不到執行檔就是 false（要 npm run build:native）
 *   Solver.solve(prob, { engine: Native.engineSync({ threads: 16 }), timeLimitMs: 30000 });   // 同步（測試用）
 *   await Native.solveAsync(prob, { threads, timeLimitMs, onImprove, signal });               // 非同步，可取消（本機伺服器用）
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const Solver = require('./solver.js');
const Wasm = require('./solver_wasm.js');

const EXE_NAME = process.platform === 'win32' ? 'solver_native.exe' : 'solver_native';
// 找執行檔：環境變數 → 桌面版打包時放在 resources 的 → 開發時 cargo 編出來的
const EXE = [process.env.INFALSUS_NATIVE_EXE, process.resourcesPath && path.join(process.resourcesPath, EXE_NAME), path.join(__dirname, '..', 'wasm', 'target', 'release', EXE_NAME)]
  .filter(Boolean).find((f) => fs.existsSync(f)) || path.join(__dirname, '..', 'wasm', 'target', 'release', EXE_NAME);
const available = () => fs.existsSync(EXE);
const cores = () => os.cpus().length;

function writeInput(S) {
  const { ints, floats } = Wasm.marshal(S);
  const head = Buffer.alloc(8); head.writeUInt32LE(ints.length, 0); head.writeUInt32LE(floats.length, 4);
  const file = path.join(os.tmpdir(), 'infalsus-' + process.pid + '-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8) + '.bin');
  fs.writeFileSync(file, Buffer.concat([head, Buffer.from(ints.buffer, ints.byteOffset, ints.byteLength), Buffer.from(floats.buffer, floats.byteOffset, floats.byteLength)]));
  return file;
}
const parseList = (t) => (t ? t.split(',').map((x) => { const [pid, eff] = x.split(':'); return { pid: +pid, eff: +eff }; }) : []);
const noSearch = (S) => !(S.order.length && S.M.length && !S.mustMissing.length && !S.baseUnreach);
const EMPTY = { best: null, bestVal: 0, nodes: 0, stop: false, stats: { leaves: 0, tiles: 0, extrasCalls: 0, extrasCands: 0, pruneZone: 0, pruneTile: 0 } };

// 解析最後一行：D 最佳值 節點數 停止 統計×6 | pid:效能,…
function parseDone(line) {
  const [head, list] = line.split('|');
  const f = head.trim().split(/\s+/).slice(1).map(Number);
  const best = parseList((list || '').trim());
  return {
    best: best.length ? best : null, bestVal: f[0], nodes: f[1], stop: f[2] !== 0,
    stats: { leaves: f[3], tiles: f[4], extrasCalls: f[5], extrasCands: f[6], pruneZone: f[7], pruneTile: f[8] },
  };
}

// 同步引擎（給 Solver.solve 的 opts.engine 用）。沒有執行檔或執行失敗時丟出例外
function engineSync(o) {
  o = o || {};
  return function (S, opts) {
    if (noSearch(S)) return EMPTY;
    if (!available()) throw new Error('找不到原生執行檔，請先執行 npm run build:native');
    const file = writeInput(S);
    try {
      const r = cp.spawnSync(EXE, [file, String(o.threads || cores()), String(opts.timeLimitMs || 60000)], { encoding: 'utf8', maxBuffer: 1 << 28 });
      if (r.status !== 0) throw new Error('原生求解器失敗：' + (r.stderr || r.status));
      const line = r.stdout.split('\n').filter((l) => l.startsWith('D ')).pop();
      if (!line) throw new Error('原生求解器沒有輸出結果');
      return parseDone(line);
    } finally { try { fs.unlinkSync(file); } catch (e) { /* 暫存檔而已 */ } }
  };
}

// 非同步：邊算邊回報改進（onImprove({ value, pieces, ms, nodes })），可以用 AbortSignal 取消（取消時回傳 null）
function solveAsync(prob, o) {
  o = o || {};
  const t0 = Date.now();
  const S = Solver.prepare(prob);
  const finish = (parsed) => {
    const r = Solver.solve(prob, { timeLimitMs: o.timeLimitMs, engine: () => parsed });
    r.ms = Date.now() - t0; r.engine = 'native'; r.threads = o.threads || cores();
    return r;
  };
  if (noSearch(S)) return Promise.resolve(finish(EMPTY));
  if (!available()) return Promise.reject(new Error('找不到原生執行檔，請先執行 npm run build:native'));
  const file = writeInput(S);
  return new Promise((resolve, reject) => {
    const child = cp.spawn(EXE, [file, String(o.threads || cores()), String(o.timeLimitMs || 60000)], { stdio: ['ignore', 'pipe', 'pipe'] });
    let buf = '', done = null, err = '', aborted = false;
    const cleanup = () => { try { fs.unlinkSync(file); } catch (e) { /* 暫存檔而已 */ } };
    const onLine = (line) => {
      if (line.startsWith('I ')) {
        if (!o.onImprove) return;
        const m = /^I (\S+) (\S+) ?(.*)$/.exec(line); if (!m) return;
        o.onImprove({ value: +m[1], pieces: Solver.describePieces(S, parseList(m[3])), ms: Date.now() - t0, nodes: +m[2] });
      } else if (line.startsWith('D ')) done = parseDone(line);
    };
    child.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { onLine(buf.slice(0, i)); buf = buf.slice(i + 1); } });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => { cleanup(); reject(e); });
    child.on('close', (code) => {
      cleanup();
      if (buf) onLine(buf);
      if (aborted) return resolve(null);
      if (code !== 0 || !done) return reject(new Error('原生求解器失敗：' + (err || code)));
      resolve(finish(done));
    });
    if (o.signal) {
      const abort = () => { aborted = true; child.kill(); };
      if (o.signal.aborted) abort(); else o.signal.addEventListener('abort', abort, { once: true });
    }
  });
}

module.exports = { EXE, available, cores, engineSync, solveAsync };
