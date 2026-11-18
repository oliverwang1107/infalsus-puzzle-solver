'use strict';
// WASM（單執行緒）vs 原生多執行緒：在 test/stress.js 的隨機大板子上逐題比對最佳值。平常不在 npm test 裡跑（要一兩分鐘）。
//   node test/compare_engines.js [板子數=12]
const fs = require('fs');
const path = require('path');
const Solver = require('../src/solver.js');
const Wasm = require('../src/solver_wasm.js');
const Native = require('../src/solver_native.js');
const { problem } = require('./stress.js');
if (!Native.available()) { console.log('找不到原生執行檔（npm run build:native）'); process.exit(0); }
const eng = Wasm.loadSync(fs.readFileSync(path.join(__dirname, '..', 'wasm', 'solver.wasm')));
const NB = Number(process.argv[2] || 12);
let n = 0, mism = 0, tw = 0, tn = 0, unf = 0;
for (let b = 0; b < NB; b++) for (let v = 0; v < 8; v++) {
  const p = problem(b, v);
  let t = Date.now(); const a = Solver.solve(p.prob, { timeLimitMs: 30000, engine: eng }); tw += Date.now() - t;
  t = Date.now(); const c = Solver.solve(p.prob, { timeLimitMs: 30000, engine: Native.engineSync({}) }); tn += Date.now() - t;
  if (!a.finished || !c.finished) { unf++; continue; }
  n++; if (Math.abs(a.value - c.value) > 1e-6) { mism++; console.log('不一致', p.name, a.value, c.value); }
}
console.log(n + ' 題，不一致 ' + mism + '，逾時略過 ' + unf + '；WASM ' + tw + ' ms，原生 ' + tn + ' ms');
process.exit(mism ? 1 : 0);
