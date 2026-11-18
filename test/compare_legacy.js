'use strict';
/*
 * 新搜尋（區域組合）vs 舊搜尋（opts.legacy）逐題比對最佳值；平常不在 npm test 裡跑（比較久），改搜尋演算法之後手動跑：
 *   node test/compare_legacy.js [題數=300] [種子=1] [wasm]
 * 題目：隨機小題（test/random_problem.js）＋中型題（真實粒子庫存、30～60 格、4～8 區，舊搜尋還跑得完的大小）。
 */
const fs = require('fs');
const path = require('path');
const Solver = require('../src/solver.js');
const N = Number(process.argv[2] || 300), SEED = Number(process.argv[3] || 1);
let engine;
if (process.argv[4] === 'wasm') engine = require('../src/solver_wasm.js').loadSync(fs.readFileSync(path.join(__dirname, '..', 'wasm', 'solver.wasm')), (e) => console.log('WASM 例外', e && e.message));
const { randomProblem } = require('./random_problem.js').makeRandom(1000 + SEED);
const inv = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'particles.json'), 'utf8'));
const parseEffs = (t) => String(t).split(',').map((x) => { const [v, n] = x.trim().split('x').map(Number); return { v, n: n || 1 }; }).filter((e) => e.v > 0);
let seed = 5000 + SEED;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const ri = (a, b) => a + Math.floor(rnd() * (b - a + 1));
const off = (c, row) => [c, row - ((c - (c & 1)) >> 1)];
function midProblem() {
  const cols = ri(5, 9), rows = ri(4, 7), key = (c) => c[0] + ',' + c[1];
  const cells = [], on = new Set();
  for (let c = 0; c < cols; c++) for (let r = 0; r < rows; r++) { if (rnd() < 0.08) continue; const a = off(c, r); cells.push(a); on.add(key(a)); }
  const taken = new Set(), zones = [], nz = ri(3, 8), ncol = ri(2, 5);
  for (let zi = 0; zi < nz; zi++) {
    const want = ri(1, 8), start = cells[ri(0, cells.length - 1)];
    if (taken.has(key(start))) continue;
    const zc = [start], mine = new Set([key(start)]);
    for (let g = 0; g < 200 && zc.length < want; g++) {
      const c = zc[ri(0, zc.length - 1)], d = Solver.NEIGH[ri(0, 5)], q = [c[0] + d[0], c[1] + d[1]];
      if (on.has(key(q)) && !taken.has(key(q)) && !mine.has(key(q))) { zc.push(q); mine.add(key(q)); }
    }
    for (const k of mine) taken.add(k);
    const z = { color: ri(0, ncol - 1), cells: zc, atk: ri(0, 9) * 50, def: ri(0, 9) * 50, name: 'Z' + (zones.length + 1) };
    if (rnd() < 0.2) { z.waive = ri(1, 2); z.wtype = ['all', 'disc', 'over', 'overlap', 'out'][ri(0, 4)]; }
    if (rnd() < 0.08) z.must = true;
    zones.push(z);
  }
  const extra = rnd() < 0.3;
  let stacks = inv.stacks.filter((s) => (extra || !s.extra) && s.color < ncol).map((s) => ({ color: s.color, cells: s.shape, effs: parseEffs(s.effText) }));
  if (rnd() < 0.4) stacks = stacks.filter(() => rnd() < 0.6); // 庫存種類少一點
  if (rnd() < 0.3) stacks = stacks.map((s) => ({ color: s.color, cells: s.cells, effs: s.effs.map((e) => ({ v: e.v - ri(0, 40), n: ri(1, 2) })).concat([{ v: ri(60, 200), n: ri(1, 3) }]) })); // 每堆只有幾顆、效能不一
  const settings = { limit: ri(3, 7), rotation: rnd() < 0.25, allowOverlap: rnd() < 0.25, penaltyCap: ri(2, 4), wAtk: [1, 1, 1, 0.001, 0][ri(0, 4)], wDef: [1, 1, 0.001, 1, 1][ri(0, 4)] };
  if (rnd() < 0.2) settings.minBaseDef = zones.reduce((a, z) => a + (rnd() < 0.4 ? z.def : 0), 0);
  if (rnd() < 0.2) settings.maxPenalty = ri(0, 2);
  if (rnd() < 0.25) { const g = {}; g[['all', 'disc', 'over', 'overlap', 'out'][ri(0, 4)]] = ri(1, 2); settings.globalWaive = g; }
  if (rnd() < 0.15) settings.allowOutside = true;
  return { cells, zones, stacks, settings };
}

let n = 0, mism = 0, unfinished = 0, tNew = 0, tOld = 0, nodesNew = 0, nodesOld = 0, withPieces = 0;
for (let t = 0; t < N; t++) {
  const prob = t % 3 === 0 ? midProblem() : randomProblem();
  if (!prob.zones.length) continue;
  let S; try { S = Solver.prepare(prob); } catch (e) { continue; }
  if (S.PL.length > 2500) continue;
  const a = Solver.solve(prob, { timeLimitMs: 20000, legacy: true });
  if (!a.finished) { unfinished++; continue; }
  const b = Solver.solve(prob, { timeLimitMs: 20000, engine });
  n++; tOld += a.ms; tNew += b.ms; nodesOld += a.nodes; nodesNew += b.nodes;
  if (a.pieces.length) withPieces++;
  const same = Math.abs(a.value - b.value) < 1e-6 && Math.abs(a.internal - b.internal) < 1e-6 && a.infeasible === b.infeasible && b.finished;
  if (!same) { mism++; if (mism <= 5) { console.log('不一致 #' + t, '舊', a.value, a.pieces.length, '新', b.value, b.pieces.length, b.finished, JSON.stringify(prob.settings)); if (process.argv[5]) fs.writeFileSync(process.argv[5] + '.' + t + '.json', JSON.stringify(prob)); } }
}
console.log(`${n} 題（有擺放 ${withPieces}、舊版逾時略過 ${unfinished}），不一致 ${mism}；舊 ${tOld} ms／${nodesOld} 節點，新 ${tNew} ms／${nodesNew} 節點`);
process.exit(mism ? 1 : 0);
