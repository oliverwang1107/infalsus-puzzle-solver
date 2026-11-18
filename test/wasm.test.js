'use strict';
// WASM 搜尋引擎 vs JS 搜尋引擎：隨機題目逐題比對（最佳值、搜尋節點數、擺放都必須一模一樣）
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Solver = require('../src/solver.js');
const Wasm = require('../src/solver_wasm.js');

let pass = 0, fail = 0;
function check(name, fn) { try { fn(); pass++; console.log('  ok  ', name); } catch (e) { fail++; console.log('  FAIL', name, '\n      ', e.message); } }

const wasmFile = path.join(__dirname, '..', 'wasm', 'solver.wasm');
let failed = 0;
const engine = Wasm.loadSync(fs.readFileSync(wasmFile), () => { failed++; });

const { randomProblem, rnd } = require('./random_problem.js').makeRandom(20260510);

console.log('WASM 引擎與 JS 引擎逐題比對');
let n = 0, withPieces = 0, mism = 0;
const t0 = Date.now();
for (let t = 0; t < 400; t++) {
  const prob = randomProblem();
  if (!prob.zones.length) continue;
  let S; try { S = Solver.prepare(prob); } catch (e) { continue; }
  if (S.PL.length > 600) continue;
  n++;
  const a = Solver.solve(prob, { timeLimitMs: 20000 });
  const b = Solver.solve(prob, { timeLimitMs: 20000, engine });
  const same = a.value === b.value && a.internal === b.internal && a.nodes === b.nodes && a.finished === b.finished && a.infeasible === b.infeasible &&
    JSON.stringify(a.pieces.map((p) => [p.stack, p.eff, p.cells])) === JSON.stringify(b.pieces.map((p) => [p.stack, p.eff, p.cells])) &&
    JSON.stringify(a.stats) === JSON.stringify(b.stats);
  if (!same) { mism++; if (mism <= 3) console.log('   不一致 #' + t, 'JS', a.value, a.nodes, 'WASM', b.value, b.nodes, JSON.stringify(prob.settings)); }
  if (a.pieces.length) withPieces++;
}
console.log('   ' + n + ' 題（有擺放 ' + withPieces + ' 題），' + (Date.now() - t0) + ' ms');
check(n + ' 題的最佳值、擺放、搜尋節點數與統計都和 JS 版完全一致', () => { assert.strictEqual(mism, 0); assert.ok(n > 200 && withPieces > 80, '測資太少'); });
check('WASM 沒有發生例外（沒有退回 JS 版）', () => assert.strictEqual(failed, 0));

check('onImprove／onProgress 回呼：改進的最佳值遞增，最後一次等於最終結果', () => {
  const prob = randomProblem(); prob.zones = [{ color: 0, cells: [[0, 0]], atk: 500, def: 100 }, { color: 1, cells: [[1, 0]], atk: 300, def: 300 }];
  prob.cells = [[0, 0], [1, 0], [2, 0]]; prob.stacks = [{ color: 0, cells: [[0, 0]], effs: [{ v: 100, n: 2 }] }, { color: 1, cells: [[0, 0]], effs: [{ v: 120, n: 2 }] }];
  prob.settings = { limit: 3, rotation: false };
  const imps = [];
  const r = Solver.solve(prob, { timeLimitMs: 5000, engine, onImprove: (b) => imps.push(b) });
  assert.ok(imps.length >= 1); for (let i = 1; i < imps.length; i++) assert.ok(imps[i].value > imps[i - 1].value);
  assert.ok(Math.abs(imps[imps.length - 1].value - r.internal) < 1e-9); assert.ok(imps[imps.length - 1].pieces.length === r.pieces.length);
});
check('時間上限：極短的時間限制下會中途停止（finished 為 false）而不是卡住', () => {
  // 刻意出一題跑不完的：12×12、14 個 9 格的長條區域、粒子只有 1～3 格而且效能幾乎一樣（鋪法極多、上界分不出好壞）
  const cells = []; for (let q = 0; q < 12; q++) for (let r = 0; r < 12; r++) cells.push([q, r]);
  const zones = []; for (let i = 0; i < 14; i++) zones.push({ color: i % 2, cells: cells.slice(i * 9, i * 9 + 9), atk: 100 + i, def: 100 });
  const stacks = []; for (let s = 0; s < 6; s++) stacks.push({ color: s % 2, cells: [[0, 0], [1, 0], [0, 1]].slice(0, 1 + (s % 3)), effs: [{ v: 100 + s, n: 30 }] });
  const t1 = Date.now();
  const r = Solver.solve({ cells, zones, stacks, settings: { limit: 30, rotation: true, penaltyCap: 6 } }, { timeLimitMs: 150, engine });
  assert.ok(Date.now() - t1 < 3000, '超時太久'); assert.strictEqual(r.finished, false);
});

console.log('\n' + pass + ' 通過, ' + fail + ' 失敗');
process.exit(fail ? 1 : 0);
