'use strict';
// 測試用的隨機題目產生器（wasm.test.js、native.test.js 共用；種子固定，每次產生同樣的題目）
const Solver = require('../src/solver.js');
function makeRandom(seed0) {
  let seed = seed0;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const ri = (a, b) => a + Math.floor(rnd() * (b - a + 1));
  function grow(want, start) {
    const set = new Map([[start.join(','), start]]);
    while (set.size < want) {
      const arr = [...set.values()]; const c = arr[ri(0, arr.length - 1)];
      const d = Solver.NEIGH[ri(0, 5)]; set.set((c[0] + d[0]) + ',' + (c[1] + d[1]), [c[0] + d[0], c[1] + d[1]]);
    }
    return [...set.values()];
  }
  function randomProblem() {
    const cells = grow(ri(8, 16), [0, 0]);
    const key = (c) => c[0] + ',' + c[1];
    const taken = new Set(), zones = [];
    for (let z = 0; z < ri(1, 4); z++) {
      const start = cells[ri(0, cells.length - 1)]; if (taken.has(key(start))) continue;
      const zc = [start]; taken.add(key(start));
      for (let t = 0; t < 8 && zc.length < ri(1, 4); t++) {
        const c = zc[ri(0, zc.length - 1)]; const d = Solver.NEIGH[ri(0, 5)]; const q = [c[0] + d[0], c[1] + d[1]];
        if (cells.some((x) => key(x) === key(q)) && !taken.has(key(q))) { zc.push(q); taken.add(key(q)); }
      }
      zones.push({ color: ri(0, 2), cells: zc, atk: ri(0, 8) * 100, def: ri(0, 8) * 100, name: 'Z' + (zones.length + 1) });
    }
    const stacks = [];
    for (let s = 0; s < ri(2, 6); s++) {
      const effs = []; for (let k = 0; k < ri(1, 4); k++) effs.push(ri(60, 260));
      stacks.push({ color: ri(0, 2), cells: grow(ri(1, 4), [0, 0]), effs: [{ v: effs[0], n: ri(1, 3) }].concat(effs.slice(1)) });
    }
    const settings = { limit: ri(2, 6), rotation: rnd() < 0.4, allowOverlap: rnd() < 0.3, penaltyCap: ri(2, 4), wAtk: ri(0, 2), wDef: ri(0, 2) };
    if (rnd() < 0.3) settings.minBaseDef = zones.reduce((a, z) => a + (rnd() < 0.5 ? z.def : 0), 0);
    if (rnd() < 0.2) settings.minBaseAtk = zones.reduce((a, z) => a + (rnd() < 0.5 ? z.atk : 0), 0);
    if (rnd() < 0.3) settings.maxPenalty = ri(0, 2);
    if (rnd() < 0.3) { const g = {}; g[['all', 'disc', 'over', 'overlap', 'out'][ri(0, 4)]] = ri(1, 2); settings.globalWaive = g; }
    if (rnd() < 0.3) settings.allowOutside = true;
    zones.forEach((z) => {
      if (rnd() < 0.35) { z.waive = ri(1, 3); z.wtype = ['all', 'disc', 'over', 'overlap', 'out'][ri(0, 4)]; }
      if (rnd() < 0.15) z.must = true;
    });
    return { cells, zones, stacks, settings };
  }

  return { randomProblem, rnd, ri };
}
module.exports = { makeRandom };
