'use strict';
// 真實大小題目的效能測試（合成資料；形狀與數值僅供壓力測試）
const Solver = require('../src/solver.js');
let seed = Number(process.argv[2] || 7);
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const ri = (a, b) => a + Math.floor(rnd() * (b - a + 1));
const NEIGH = Solver.NEIGH;
const key = (c) => c[0] + ',' + c[1];

// 產生所有自由多六邊形（旋轉等價）到 size
function freePolyhexes(maxSize) {
  const canon = (cells) => Solver.orientations(cells, true).map((o) => o.map((c) => c.join(',')).join(';')).sort()[0];
  let level = new Map([[canon([[0, 0]]), [[0, 0]]]]);
  const all = [...level.values()];
  for (let s = 2; s <= maxSize; s++) {
    const next = new Map();
    for (const cells of level.values()) {
      const have = new Set(cells.map(key));
      for (const c of cells) for (const d of NEIGH) {
        const n = [c[0] + d[0], c[1] + d[1]];
        if (have.has(key(n))) continue;
        const nc = Solver.normalize(cells.concat([n]));
        const k = canon(nc);
        if (!next.has(k)) next.set(k, nc);
      }
    }
    level = next; all.push(...level.values());
  }
  return all;
}
const SHAPES = freePolyhexes(6);

function growBlob(start, size, taken) {
  const cells = [start]; taken.add(key(start));
  let guard = 0;
  while (cells.length < size && guard++ < 500) {
    const c = cells[ri(0, cells.length - 1)]; const d = NEIGH[ri(0, 5)];
    const n = [c[0] + d[0], c[1] + d[1]];
    if (!taken.has(key(n))) { cells.push(n); taken.add(key(n)); }
  }
  return cells;
}

function makeProblem(opts) {
  const taken = new Set(); const zones = [];
  const zoneSizes = opts.zoneSizes || [1, 7, 2, 2, 7, 7, 8, 4];
  const cells = [];
  let cx = 0;
  zoneSizes.forEach((sz, i) => {
    const start = [cx, i % 2 ? 3 : -2]; cx += 3;
    const z = growBlob(start, sz, taken);
    zones.push({ color: i % 5, cells: z, atk: ri(1, 6) * 100, def: ri(1, 6) * 100 });
    cells.push(...z);
  });
  // 空白格：區域周圍一圈
  const have = new Set(cells.map(key));
  for (const c of [...cells]) for (const d of NEIGH) {
    const n = [c[0] + d[0], c[1] + d[1]];
    if (!have.has(key(n))) { have.add(key(n)); cells.push(n); }
  }
  const stacks = [];
  for (let color = 0; color < 5; color++) {
    for (let k = 0; k < (opts.shapesPerColor || 9); k++) {
      const shape = SHAPES[ri(0, SHAPES.length - 1)];
      const base = ri(100, 180);
      const effs = []; for (let j = 0; j < ri(5, 30); j++) effs.push(base - ri(0, 30));
      stacks.push({ color, cells: shape, effs });
    }
  }
  return { cells, zones, stacks, settings: { limit: 6, rotation: opts.rotation !== false, allowOverlap: !!opts.overlap } };
}

const prob = makeProblem({ rotation: process.argv[3] !== 'norot', overlap: process.argv[4] === 'overlap' });
const S = Solver.prepare(prob);
console.log(`板子 ${prob.cells.length} 格, 區域 ${prob.zones.length} 個, 合併後粒子堆疊 ${S.M.length}, 可行擺放 ${S.PL.length}`);
let lastValue = 0;
const t0 = Date.now();
const r = Solver.solve(prob, {
  timeLimitMs: Number(process.argv[5] || 60000),
  onImprove: (b) => { if (b.value > lastValue * 1.02) { lastValue = b.value; console.log(`  ${(b.ms / 1000).toFixed(1)}s 找到 ${b.value.toFixed(1)} (${b.pieces.length} 顆)`); } },
});
console.log("  stats", JSON.stringify(r.stats));
console.log(`完成=${r.finished} 節點=${r.nodes} 用時=${((Date.now() - t0) / 1000).toFixed(1)}s 最佳=${r.value.toFixed(1)}`);
if (r.score) console.log(`  粒子 ${r.score.n} 顆, 平均效能 ${r.score.avg.toFixed(1)}, 懲罰 P=${r.score.P} (乖離${r.score.disc}/過載${r.score.over}/重疊${r.score.overlap}), 完成區域 ${r.score.completeZones.length}, ATK ${r.score.finalAtk.toFixed(0)} DEF ${r.score.finalDef.toFixed(0)}`);
