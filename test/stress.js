'use strict';
/*
 * 找「慢的題目」用：隨機大板子（真實粒子庫存）× 各種設定，列出最花時間／節點的幾題。平常不在 npm test 裡跑。
 *   node test/stress.js [板子數=20] [種子=1] [每題上限毫秒=20000] [engine=js|wasm|native]
 */
const fs = require('fs');
const path = require('path');
const Solver = require('../src/solver.js');
const MAIN = require.main === module;
const NB = Number((MAIN && process.argv[2]) || 20), SEED = Number((MAIN && process.argv[3]) || 1), TIME = Number((MAIN && process.argv[4]) || 20000), ENGINE = (MAIN && process.argv[5]) || 'js';
let engine;
if (ENGINE === 'wasm') engine = require('../src/solver_wasm.js').loadSync(fs.readFileSync(path.join(__dirname, '..', 'wasm', 'solver.wasm')), (e) => console.log('WASM 例外', e && e.message));
if (ENGINE === 'native') engine = require('../src/solver_native.js').engineSync({});
const inv = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'particles.json'), 'utf8'));
const parseEffs = (t) => String(t).split(',').map((x) => { const [v, n] = x.trim().split('x').map(Number); return { v, n: n || 1 }; }).filter((e) => e.v > 0);
const stacksOf = (extra) => inv.stacks.filter((s) => extra || !s.extra).map((s) => ({ color: s.color, cells: s.shape, effs: parseEffs(s.effText) }));
let seed = 9000 + SEED;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const ri = (a, b) => a + Math.floor(rnd() * (b - a + 1));
const off = (c, row) => [c, row - ((c - (c & 1)) >> 1)];
const key = (c) => c[0] + ',' + c[1];
function board() {
  const cols = ri(9, 13), rows = ri(8, 11), cells = [], on = new Set();
  for (let c = 0; c < cols; c++) for (let r = 0; r < rows; r++) { const a = off(c, r); cells.push(a); on.add(key(a)); }
  const taken = new Set(), zones = [], nz = ri(8, 16);
  for (let zi = 0; zi < nz; zi++) {
    const want = [1, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 10][ri(0, 11)];
    for (let tries = 0; tries < 50; tries++) {
      const start = cells[ri(0, cells.length - 1)];
      if (taken.has(key(start))) continue;
      const zc = [start], mine = new Set([key(start)]);
      for (let g = 0; g < 300 && zc.length < want; g++) {
        const c = zc[ri(0, zc.length - 1)], d = Solver.NEIGH[ri(0, 5)], q = [c[0] + d[0], c[1] + d[1]];
        if (on.has(key(q)) && !taken.has(key(q)) && !mine.has(key(q))) { zc.push(q); mine.add(key(q)); }
      }
      for (const k of mine) taken.add(k);
      const sq = Math.max(1, Math.round(Math.sqrt(zc.length)));
      zones.push({ color: ri(0, 4), cells: zc, atk: ri(0, 9) * 50 * sq, def: ri(0, 9) * 50 * sq, name: 'Z' + (zones.length + 1) });
      break;
    }
  }
  return { cells, zones };
}
const VARIANTS = () => [
    ['上限8', { limit: 8 }, false], ['上限12', { limit: 12 }, false], ['上限16', { limit: 16 }, false],
    ['上限12＋額外粒子', { limit: 12 }, true], ['上限10＋旋轉', { limit: 10, rotation: true }, false],
    ['上限12＋重疊免除1', { limit: 12, allowOverlap: true, globalWaive: { overlap: 1 } }, false],
    ['上限10＋超界免除1＋攻擊特化', { limit: 10, allowOutside: true, globalWaive: { out: 1 }, wAtk: 1, wDef: 0.001 }, false],
    ['上限14＋懲罰上限5', { limit: 14, penaltyCap: 5 }, false],
  ];
const mkProb = (bd, st, extra) => ({ cells: bd.cells, zones: bd.zones, stacks: stacksOf(extra), settings: Object.assign({ limit: 8, rotation: false, allowOverlap: false, penaltyCap: 3, wAtk: 1, wDef: 1 }, st) });
// 給其他腳本用：第 b 張板子（同一個種子下）的第 v 個設定
function problem(b, v) { seed = 9000 + SEED; let bd; for (let i = 0; i <= b; i++) bd = board(); const [vn, st, extra] = VARIANTS()[v]; return { name: '板' + b + ' ' + vn, prob: mkProb(bd, st, extra) }; }
module.exports = { problem };
if (MAIN) {
const rows = [];
for (let b = 0; b < NB; b++) {
  const bd = board();
  for (const [vn, st, extra] of VARIANTS()) {
    const prob = mkProb(bd, st, extra);
    const t0 = Date.now();
    const r = Solver.solve(prob, { timeLimitMs: TIME, engine });
    rows.push({ b, vn, cells: bd.cells.length, nz: bd.zones.length, ms: Date.now() - t0, nodes: r.nodes, fin: r.finished, value: r.value, stats: r.stats });
  }
}
rows.sort((x, y) => y.nodes - x.nodes);
const tot = rows.reduce((a, r) => a + r.ms, 0), unf = rows.filter((r) => !r.fin).length;
console.log(`${rows.length} 題，總用時 ${tot} ms，逾時 ${unf} 題；最花節點的 12 題：`);
for (const r of rows.slice(0, 12)) console.log(`  板${r.b}(${r.cells}格${r.nz}區) ${r.vn}  ${r.fin ? '完成' : '逾時'} ${r.ms} ms 節點 ${r.nodes} 最佳 ${r.value.toFixed(1)} ${JSON.stringify(r.stats)}`);
}
