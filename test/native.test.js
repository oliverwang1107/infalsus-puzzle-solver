'use strict';
// 原生多執行緒求解器 vs JS 搜尋引擎：隨機題目逐題比對最佳值（需要先 npm run build:native；沒有執行檔就跳過）
const assert = require('assert');
const Solver = require('../src/solver.js');
const Native = require('../src/solver_native.js');
const { randomProblem } = require('./random_problem.js').makeRandom(777001);

if (!Native.available()) { console.log('找不到原生執行檔（npm run build:native），跳過原生求解器測試'); process.exit(0); }
let pass = 0, fail = 0;
function check(name, fn) { try { fn(); pass++; console.log('  ok  ', name); } catch (e) { fail++; console.log('  FAIL', name, '\n      ', e.message); } }
console.log('原生多執行緒求解器與 JS 引擎逐題比對');
let n = 0, mism = 0, withPieces = 0;
for (let t = 0; t < 120; t++) {
  const prob = randomProblem();
  if (!prob.zones.length) continue;
  let S; try { S = Solver.prepare(prob); } catch (e) { continue; }
  if (S.PL.length > 400) continue;
  n++;
  const a = Solver.solve(prob, { timeLimitMs: 20000 });
  const b = Solver.solve(prob, { timeLimitMs: 20000, engine: Native.engineSync({ threads: 1 + (t % 6) }) });
  // 多執行緒的搜尋順序不同，節點數與同分時的擺放可能不一樣；最佳值、是否無解、有沒有完成都必須一致
  const same = Math.abs(a.value - b.value) < 1e-6 && Math.abs(a.internal - b.internal) < 1e-6 && a.infeasible === b.infeasible && a.finished === b.finished;
  if (!same) { mism++; if (mism <= 3) console.log('   不一致 #' + t, 'JS', a.value, 'native', b.value, JSON.stringify(prob.settings)); }
  if (a.pieces.length) withPieces++;
}
console.log('   ' + n + ' 題（有擺放 ' + withPieces + ' 題）');
check(n + ' 題的最佳值都和 JS 版一致', () => { assert.strictEqual(mism, 0); assert.ok(n > 60 && withPieces > 25, '測資太少'); });
(async () => {
  const prob = randomProblem(); prob.zones = [{ color: 0, cells: [[0, 0]], atk: 500, def: 100 }, { color: 1, cells: [[1, 0]], atk: 300, def: 300 }];
  prob.cells = [[0, 0], [1, 0], [2, 0]]; prob.stacks = [{ color: 0, cells: [[0, 0]], effs: [{ v: 100, n: 2 }] }, { color: 1, cells: [[0, 0]], effs: [{ v: 120, n: 2 }] }]; prob.settings = { limit: 3, rotation: false };
  const imps = [];
  const r = await Native.solveAsync(prob, { threads: 4, timeLimitMs: 5000, onImprove: (b) => imps.push(b) });
  const j = Solver.solve(prob, { timeLimitMs: 5000 });
  check('solveAsync 的結果等於 JS 版，且有回報改進（值遞增）', () => {
    assert.ok(Math.abs(r.value - j.value) < 1e-6); assert.strictEqual(r.engine, 'native'); assert.ok(imps.length >= 1);
    for (let i = 1; i < imps.length; i++) assert.ok(imps[i].value > imps[i - 1].value);
  });
  const ac = new AbortController();
  // 刻意出一題跑不完的（見 wasm.test.js 的說明）
  const big = { cells: [], zones: [], stacks: [], settings: { limit: 30, rotation: true, penaltyCap: 6 } };
  for (let q = 0; q < 12; q++) for (let r2 = 0; r2 < 12; r2++) big.cells.push([q, r2]);
  for (let i = 0; i < 14; i++) big.zones.push({ color: i % 2, cells: big.cells.slice(i * 9, i * 9 + 9), atk: 100 + i, def: 100 });
  for (let s = 0; s < 6; s++) big.stacks.push({ color: s % 2, cells: [[0, 0], [1, 0], [0, 1]].slice(0, 1 + (s % 3)), effs: [{ v: 100 + s, n: 30 }] });
  setTimeout(() => ac.abort(), 300);
  const t0 = Date.now();
  const rr = await Native.solveAsync(big, { threads: 4, timeLimitMs: 60000, signal: ac.signal });
  check('取消：中止後回傳 null 而且很快結束', () => { assert.strictEqual(rr, null); assert.ok(Date.now() - t0 < 5000); });
  console.log('\n' + pass + ' 通過, ' + fail + ' 失敗');
  process.exit(fail ? 1 : 0);
})();
