'use strict';
const assert = require('assert');
const Solver = require('../src/solver.js');

let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); pass++; console.log('  ok  ', name); }
  catch (e) { fail++; console.log('  FAIL', name, '\n      ', e.message); }
}
const near = (a, b, eps = 0.6) => assert.ok(Math.abs(a - b) <= eps, `expected ${b}, got ${a}`);

/* ---------- 1. 公式驗證：對照遊戲實測數字 ---------- */
console.log('公式驗證（對照遊戲實測值）');
// 「終焉盡頭」最上方 0/1 區：填滿後基礎 300/300。
const board1 = {
  cells: [[0, 0], [1, 0], [2, 0], [3, 0], [4, 0], [5, 0], [6, 0]],
  zones: [{ color: 0, cells: [[0, 0]], atk: 300, def: 300 }],
  settings: { limit: 6 },
};
check('1 顆（效能133）填滿 0/1 區：300×1.33 = 399', () => {
  const r = Solver.evaluatePlacement(board1, [{ color: 0, cells: [[0, 0]], eff: 133 }]);
  near(r.finalAtk, 399);
  assert.strictEqual(r.P, 0);
});
check('2 顆互不相連：乖離1 → 倍率 89% → 355（遊戲顯示 355/355）', () => {
  const r = Solver.evaluatePlacement(board1, [
    { color: 0, cells: [[0, 0]], eff: 133 }, { color: 0, cells: [[3, 0]], eff: 133 }]);
  assert.strictEqual(r.disc, 1);
  near(r.finalAtk, 355, 0.5);
});
check('3 顆互不相連：乖離2 → 倍率 56% → 222（遊戲顯示 222/222）', () => {
  const r = Solver.evaluatePlacement(board1, [
    { color: 0, cells: [[0, 0]], eff: 133 }, { color: 0, cells: [[3, 0]], eff: 133 }, { color: 0, cells: [[6, 0]], eff: 133 }]);
  assert.strictEqual(r.disc, 2);
  near(r.finalAtk, 222, 0.5);
});
check('4 顆互不相連：乖離3 → 倍率 0，無法製作（遊戲顯示「懲罰過多」）', () => {
  const r = Solver.evaluatePlacement(board1, [
    { color: 0, cells: [[0, 0]], eff: 133 }, { color: 0, cells: [[2, 0]], eff: 133 },
    { color: 0, cells: [[4, 0]], eff: 133 }, { color: 0, cells: [[6, 0]], eff: 120 }]);
  assert.strictEqual(r.disc, 3);
  assert.strictEqual(r.valid, false);
  assert.strictEqual(r.finalAtk, 0);
});
check('「脫離常軌的自由」：基礎 350、4 顆平均 163.25、懲罰 1 → 508', () => {
  const b = { cells: board1.cells, zones: [{ color: 0, cells: [[0, 0]], atk: 350, def: 350 }], settings: { limit: 6 } };
  const r = Solver.evaluatePlacement(b, [
    { color: 0, cells: [[0, 0]], eff: 150 }, { color: 0, cells: [[1, 0]], eff: 170 },
    { color: 0, cells: [[2, 0]], eff: 160 }, { color: 0, cells: [[5, 0]], eff: 173 }]);
  assert.strictEqual(r.disc, 1);
  near(r.finalAtk, 508, 0.6);
});
check('顏色不符的粒子不能填滿區域', () => {
  const r = Solver.evaluatePlacement(board1, [{ color: 1, cells: [[0, 0]], eff: 133 }]);
  assert.strictEqual(r.atk, 0);
});
check('過載：超過上限每多 1 顆 +1 懲罰', () => {
  const b = { ...board1, settings: { limit: 2 } };
  const r = Solver.evaluatePlacement(b, [
    { color: 0, cells: [[0, 0]], eff: 100 }, { color: 0, cells: [[1, 0]], eff: 100 }, { color: 0, cells: [[2, 0]], eff: 100 }]);
  assert.strictEqual(r.over, 1);
});
check('重疊：被多顆覆蓋的格子每格 +1（同格多顆只算一次）', () => {
  const r = Solver.evaluatePlacement(board1, [
    { color: 0, cells: [[0, 0], [1, 0]], eff: 100 }, { color: 0, cells: [[1, 0], [2, 0]], eff: 100 },
    { color: 0, cells: [[1, 0]], eff: 100 }]);
  assert.strictEqual(r.overlap, 1);
});

check('自訂倍率表 [1, 8/9, 5/9] 與公式結果一致', () => {
  const two = [{ color: 0, cells: [[0, 0]], eff: 133 }, { color: 0, cells: [[3, 0]], eff: 133 }];
  const a = Solver.evaluatePlacement(board1, two);
  const b = Solver.evaluatePlacement({ ...board1, settings: { limit: 6, penaltyTable: [1, 8 / 9, 5 / 9] } }, two);
  near(a.finalAtk, b.finalAtk, 1e-9);
});
check('自訂倍率表 [1, 0.5]：P=1 → 50%，P=2 → 無法製作', () => {
  const prob = { ...board1, settings: { limit: 6, penaltyTable: [1, 0.5] } };
  const two = [{ color: 0, cells: [[0, 0]], eff: 100 }, { color: 0, cells: [[3, 0]], eff: 100 }];
  near(Solver.evaluatePlacement(prob, two).finalAtk, 150, 1e-9);
  const three = two.concat([{ color: 0, cells: [[6, 0]], eff: 100 }]);
  assert.strictEqual(Solver.evaluatePlacement(prob, three).valid, false);
});

/* ---------- 1b. 最佳化目標與顏色篩選 ---------- */
console.log('\n最佳化目標（攻擊／防禦特化）與顏色篩選');
{
  // 兩個單格區域：Z1 只加攻擊 100、Z2 只加防禦 150；只能放 1 顆（不允許任何懲罰）
  const base = (goal, wA, wD) => {
    const w = Solver.goalWeights(goal, wA, wD);
    return {
      cells: [[0, 0], [5, 0]],
      zones: [{ color: 0, cells: [[0, 0]], atk: 100, def: 0 }, { color: 0, cells: [[5, 0]], atk: 0, def: 150 }],
      stacks: [{ color: 0, cells: [[0, 0]], effs: [{ v: 100, n: 5 }] }],
      settings: { limit: 1, penaltyCap: 1, rotation: false, wAtk: w.wAtk, wDef: w.wDef },
    };
  };
  const pick = (goal) => { const r = Solver.solve(base(goal), { timeLimitMs: 5000 }); return r.score.atk > 0 ? 'atk' : 'def'; };
  check('平衡：選攻防總和較大的 Z2', () => assert.strictEqual(pick('balanced'), 'def'));
  check('攻擊特化：選 Z1（攻擊）', () => assert.strictEqual(pick('atk'), 'atk'));
  check('防禦特化：選 Z2（防禦）', () => assert.strictEqual(pick('def'), 'def'));
  check('特化時另一項當次要條件：攻擊相同時選防禦較高者', () => {
    const w = Solver.goalWeights('atk');
    const prob = {
      cells: [[0, 0], [5, 0]],
      zones: [{ color: 0, cells: [[0, 0]], atk: 100, def: 10 }, { color: 0, cells: [[5, 0]], atk: 100, def: 90 }],
      stacks: [{ color: 0, cells: [[0, 0]], effs: [{ v: 100, n: 5 }] }],
      settings: { limit: 1, penaltyCap: 1, rotation: false, wAtk: w.wAtk, wDef: w.wDef },
    };
    const r = Solver.solve(prob, { timeLimitMs: 5000 });
    assert.strictEqual(r.score.def, 90);
  });
  check('顏色篩選：只保留勾選的顏色', () => {
    const st = [{ color: 0 }, { color: 1 }, { color: 4 }];
    assert.deepStrictEqual(Solver.filterColors(st, [true, false, true, true, false]).map((s) => s.color), [0]);
    assert.strictEqual(Solver.filterColors(st, undefined).length, 3);
  });
}

/* ---------- 2. 與暴力解比對 ---------- */
console.log('\n與暴力搜尋比對（隨機小題目）');
let seed = 12345;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const ri = (a, b) => a + Math.floor(rnd() * (b - a + 1));

function randomBoard() {
  // 從 (0,0) 隨機長出連通的格子
  const want = ri(7, 11); const set = new Map([['0,0', [0, 0]]]);
  while (set.size < want) {
    const arr = [...set.values()]; const c = arr[ri(0, arr.length - 1)];
    const d = Solver.NEIGH[ri(0, 5)]; const q = c[0] + d[0], r = c[1] + d[1];
    set.set(q + ',' + r, [q, r]);
  }
  return [...set.values()];
}
function randomShape(size) {
  const set = new Map([['0,0', [0, 0]]]);
  while (set.size < size) {
    const arr = [...set.values()]; const c = arr[ri(0, arr.length - 1)];
    const d = Solver.NEIGH[ri(0, 5)]; set.set((c[0] + d[0]) + ',' + (c[1] + d[1]), [c[0] + d[0], c[1] + d[1]]);
  }
  return [...set.values()];
}
function randomProblem() {
  const cells = randomBoard();
  const zones = []; const taken = new Set();
  const nz = ri(1, 3);
  for (let z = 0; z < nz; z++) {
    const start = cells[ri(0, cells.length - 1)];
    if (taken.has(start[0] + ',' + start[1])) continue;
    const zc = [start]; taken.add(start[0] + ',' + start[1]);
    const zsize = ri(1, 3);
    for (let t = 0; t < 6 && zc.length < zsize; t++) {
      const c = zc[ri(0, zc.length - 1)]; const d = Solver.NEIGH[ri(0, 5)];
      const q = c[0] + d[0], r = c[1] + d[1], k = q + ',' + r;
      if (cells.some((x) => x[0] === q && x[1] === r) && !taken.has(k)) { zc.push([q, r]); taken.add(k); }
    }
    zones.push({ color: ri(0, 1), cells: zc, atk: ri(1, 8) * 100, def: ri(1, 8) * 100 });
  }
  const stacks = [];
  for (let s = 0; s < ri(2, 4); s++) {
    const effs = []; for (let k = 0; k < ri(1, 3); k++) effs.push(ri(80, 200));
    stacks.push({ color: ri(0, 1), cells: randomShape(ri(1, 3)), effs });
  }
  return { cells, zones, stacks, settings: { limit: ri(2, 4), rotation: rnd() < 0.5, allowOverlap: false, wAtk: 1, wDef: ri(0, 1) } };
}

function bruteForce(prob) {
  const S = Solver.prepare(prob);
  const best = { v: 0 };
  const used = new Int32Array(S.M.length);
  const chosen = [];
  function rec(startPid) {
    if (chosen.length) {
      const sc = Solver.scoreExplicit(S, chosen.map((x) => ({ color: S.PL[x.pid].color, cells: S.PL[x.pid].cells, eff: x.eff })));
      if (sc.value > best.v + 1e-9) best.v = sc.value;
    }
    if (chosen.length >= S.maxPieces) return;
    for (let pid = startPid; pid < S.PL.length; pid++) {
      const p = S.PL[pid];
      if (used[p.s] >= S.M[p.s].effs.length) continue;
      let clash = false; for (const x of chosen) { const q = S.PL[x.pid]; for (let w = 0; w < S.W; w++) if (q.mask[w] & p.mask[w]) clash = true; }
      if (clash) continue;
      chosen.push({ pid, eff: S.M[p.s].effs[used[p.s]] }); used[p.s]++;
      rec(pid + 1);
      used[p.s]--; chosen.pop();
    }
  }
  rec(0);
  return best.v;
}

let mismatches = 0, cases = 0;
const stat = { positive: 0, withPenalty: 0, withExtra: 0, multiPiece: 0, rotation: 0 };
for (let t = 0; t < 250; t++) {
  const prob = randomProblem();
  if (!prob.zones.length) continue;
  const S = Solver.prepare(prob);
  if (S.PL.length > 260) continue; // 暴力解太慢
  cases++;
  const bf = bruteForce(prob);
  const r = Solver.solve(prob, { timeLimitMs: 20000 });
  if (Math.abs(bf - r.value) > 1e-6) {
    mismatches++;
    if (mismatches <= 3) console.log('   不一致 #' + t, 'brute=', bf.toFixed(3), 'solver=', r.value.toFixed(3), JSON.stringify(prob.settings));
  } else if (r.score && Math.abs(r.score.value - r.internal) > 1e-6) {
    mismatches++; console.log('   內部計分與獨立計分不一致', r.score.value, r.value);
  }
  if (bf > 0 && r.score) {
    stat.positive++;
    if (r.score.P > 0) stat.withPenalty++;
    if (r.pieces.length >= 2) stat.multiPiece++;
    if (prob.settings.rotation) stat.rotation++;
    // 有哪顆粒子沒有蓋到任何「有價值的區域格」→ 屬於額外粒子
    const zoneCells = new Set(); S.zones.forEach((z) => { if (z.u > 0) z.cells.forEach((c) => zoneCells.add(c)); });
    if (r.pieces.some((p) => !p.cells.some((c) => zoneCells.has(c)))) stat.withExtra++;
  }
}
console.log('   統計:', JSON.stringify(stat));
check(`${cases} 題與暴力解完全一致`, () => assert.strictEqual(mismatches, 0));

/* ---------- 3. 橋接：兩個區域中間隔著空白格 ---------- */
console.log('\n橋接測試（用額外粒子把分離的兩區接起來，避免乖離懲罰）');
for (const gap of [1, 2, 3]) {
  check(`中間隔 ${gap} 格空白：與暴力解一致`, () => {
    const len = gap + 2;
    const cells = []; for (let q = 0; q < len; q++) cells.push([q, 0]);
    const prob = {
      cells,
      zones: [{ color: 0, cells: [[0, 0]], atk: 500, def: 500 }, { color: 0, cells: [[len - 1, 0]], atk: 500, def: 500 }],
      stacks: [{ color: 0, cells: [[0, 0]], effs: [{ v: 200, n: 8 }] }],
      settings: { limit: 6, rotation: false },
    };
    const bf = bruteForce(prob);
    const r = Solver.solve(prob, { timeLimitMs: 20000 });
    assert.ok(Math.abs(bf - r.value) < 1e-6, `brute=${bf} solver=${r.value}`);
    // 隔得夠近時，橋接後 P=0（共 gap+2 顆，上限 6）：應該優於 P=1 的 2 顆解
    if (gap + 2 <= 6) assert.strictEqual(r.score.P, 0, `gap=${gap} 應該橋接成功，實得 P=${r.score.P}, n=${r.pieces.length}`);
  });
}

/* ---------- 3b. 一顆粒子同時蓋住兩個相鄰同色區域（上界不可各區域各自進位） ---------- */
check('一顆長條同時填滿兩個相鄰同色區域（背包上界須合併同色需求）', () => {
  const prob = {
    cells: [[0, 0], [1, 0], [2, 0], [3, 0], [4, 0], [5, 0], [8, 0]],
    zones: [
      { color: 0, cells: [[0, 0], [1, 0]], atk: 500, def: 0 },
      { color: 0, cells: [[2, 0], [3, 0]], atk: 500, def: 0 },
      { color: 0, cells: [[8, 0]], atk: 600, def: 0 },
    ],
    stacks: [
      { color: 0, cells: [[0, 0]], effs: [{ v: 100, n: 10 }] },
      { color: 0, cells: [[0, 0], [1, 0], [2, 0], [3, 0]], effs: [100] },
    ],
    settings: { limit: 1, penaltyCap: 1, rotation: false },
  };
  const bf = bruteForce(prob);
  const r = Solver.solve(prob, { timeLimitMs: 10000 });
  assert.ok(Math.abs(bf - 1000) < 1e-6, 'brute=' + bf);
  assert.ok(Math.abs(r.value - 1000) < 1e-6, 'solver=' + r.value);
});

/* ---------- 4. 較大的隨機題（上限較高、粒子較多） ---------- */
console.log('\n較大的隨機題');
{
  let mm = 0, cs = 0; const st2 = { chain: 0, penalty: 0 };
  for (let t = 0; t < 120; t++) {
    const prob = randomProblem();
    prob.settings.limit = ri(3, 5);
    if (!prob.zones.length) continue;
    const S = Solver.prepare(prob);
    if (S.PL.length > 90) continue;
    cs++;
    const bf = bruteForce(prob);
    const r = Solver.solve(prob, { timeLimitMs: 20000 });
    if (Math.abs(bf - r.value) > 1e-6) { mm++; if (mm <= 3) console.log('   不一致', 'brute=', bf.toFixed(3), 'solver=', r.value.toFixed(3), JSON.stringify(prob.settings), 'PL=', S.PL.length); }
    if (r.score && r.score.P > 0) st2.penalty++;
  }
  console.log('   統計:', cs, '題', JSON.stringify(st2));
  check(`${cs} 題與暴力解完全一致`, () => assert.strictEqual(mm, 0));
}

/* ---------- 5. 雙島嶼板子（驗證「不同島嶼不可能相連」的剪枝） ---------- */
console.log('\n雙島嶼隨機題');
{
  let mm = 0, cs = 0, st3 = { crossIsland: 0 };
  for (let t = 0; t < 200; t++) {
    const a = randomBoard();
    const b = randomBoard().map(([q, r]) => [q + 30, r]); // 遠遠隔開，絕不相鄰
    const cells = a.concat(b);
    const zones = []; const taken = new Set();
    for (let z = 0; z < ri(2, 4); z++) {
      const start = cells[ri(0, cells.length - 1)];
      if (taken.has(start.join(','))) continue;
      const zc = [start]; taken.add(start.join(','));
      const zsize = ri(1, 2);
      for (let k = 0; k < 6 && zc.length < zsize; k++) {
        const c = zc[ri(0, zc.length - 1)]; const d = Solver.NEIGH[ri(0, 5)]; const q = c[0] + d[0], r = c[1] + d[1];
        if (cells.some((x) => x[0] === q && x[1] === r) && !taken.has(q + ',' + r)) { zc.push([q, r]); taken.add(q + ',' + r); }
      }
      zones.push({ color: ri(0, 1), cells: zc, atk: ri(1, 8) * 100, def: ri(1, 8) * 100 });
    }
    if (!zones.length) continue;
    const stacks = [];
    for (let s = 0; s < ri(2, 4); s++) {
      const effs = []; for (let k = 0; k < ri(1, 3); k++) effs.push(ri(80, 200));
      stacks.push({ color: ri(0, 1), cells: randomShape(ri(1, 2)), effs });
    }
    const prob = { cells, zones, stacks, settings: { limit: ri(2, 3), rotation: rnd() < 0.5, wAtk: 1, wDef: 1 } };
    const S = Solver.prepare(prob);
    if (S.PL.length > 48) continue;
    cs++;
    const bf = bruteForce(prob);
    const r = Solver.solve(prob, { timeLimitMs: 20000 });
    if (Math.abs(bf - r.value) > 1e-6) { mm++; if (mm <= 3) console.log('   不一致', 'brute=', bf.toFixed(3), 'solver=', r.value.toFixed(3)); }
    if (r.score && r.score.disc > 0) st3.crossIsland++;
  }
  console.log('   統計:', cs, '題', JSON.stringify(st3));
  check(`${cs} 題雙島嶼與暴力解完全一致`, () => assert.strictEqual(mm, 0));
}

/* ---------- 6. 必觸發區域（must）：一定要填滿的區域 ---------- */
console.log('\n必觸發區域');
{
  // 兩個互不相鄰的紅色單格區，只有 1 顆粒子可用（上限 1、懲罰上限 1 → 第 2 顆就無法製作）
  const two = (mustB, mustA) => ({
    cells: [[0, 0], [5, 0]],
    zones: [{ color: 0, cells: [[0, 0]], atk: 1000, def: 0, must: !!mustA }, { color: 0, cells: [[5, 0]], atk: 10, def: 0, must: !!mustB }],
    stacks: [{ color: 0, cells: [[0, 0]], effs: [{ v: 100, n: 2 }] }],
    settings: { limit: 1, penaltyCap: 1, rotation: false },
  });
  check('沒有指定時選價值高的 Z1（1000）；指定 Z2 必觸發後改選 Z2（10）', () => {
    const a = Solver.solve(two(false), { timeLimitMs: 5000 });
    near(a.value, 1000); assert.deepStrictEqual(a.score.completeZones, [0]);
    const b = Solver.solve(two(true), { timeLimitMs: 5000 });
    near(b.value, 10); assert.deepStrictEqual(b.score.completeZones, [1]);
    assert.strictEqual(b.infeasible, false); assert.deepStrictEqual(b.forced.zones, [1]);
  });
  check('兩個區域都必觸發但只放得下 1 顆 → 無解（infeasible），不會硬給一個沒填滿的擺放', () => {
    const r = Solver.solve(two(true, true), { timeLimitMs: 5000 });
    assert.strictEqual(r.infeasible, true); assert.strictEqual(r.pieces.length, 0); assert.strictEqual(r.finished, true);
  });
  check('放寬粒子數上限後，兩個都必觸發可以同時滿足（P = 乖離 1）', () => {
    const p = two(true, true); p.settings = { limit: 2, penaltyCap: 3, rotation: false };
    const r = Solver.solve(p, { timeLimitMs: 5000 });
    assert.strictEqual(r.infeasible, false); assert.deepStrictEqual(r.score.completeZones.sort(), [0, 1]);
    assert.ok(r.score.valid && r.score.forcedMissing.length === 0);
  });
  check('必觸發區域沒有同色粒子 → 立刻無解，並指出是哪個區域', () => {
    const p = two(false); p.zones.push({ color: 2, cells: [[2, 0]], atk: 5, def: 0, must: true }); p.cells.push([2, 0]);
    const r = Solver.solve(p, { timeLimitMs: 5000 });
    assert.strictEqual(r.infeasible, true); assert.deepStrictEqual(r.forced.missing, [2]); assert.strictEqual(r.nodes, 0);
  });
  check('必觸發區域沒填攻防（0／0）也會被填滿，其餘區域照常最佳化', () => {
    const p = {
      cells: [[0, 0], [1, 0], [2, 0]],
      zones: [{ color: 0, cells: [[0, 0]], atk: 0, def: 0, must: true }, { color: 0, cells: [[2, 0]], atk: 300, def: 0 }],
      stacks: [{ color: 0, cells: [[0, 0]], effs: [{ v: 100, n: 4 }] }],
      settings: { limit: 4, rotation: false },
    };
    const r = Solver.solve(p, { timeLimitMs: 5000 });
    assert.deepStrictEqual(r.score.completeZones.sort(), [0, 1]);
    // 分離的兩顆接起來比較好：中間補一顆就沒有乖離
    assert.strictEqual(r.score.P, 0); near(r.score.finalAtk, 300);
  });
  check('只有必觸發區域、沒有任何攻防數值：仍然給出填滿它的擺放', () => {
    const p = { cells: [[0, 0], [1, 0]], zones: [{ color: 0, cells: [[0, 0], [1, 0]], atk: 0, def: 0, must: true }], stacks: [{ color: 0, cells: [[0, 0], [1, 0]], effs: [120] }], settings: { limit: 2, rotation: false } };
    const r = Solver.solve(p, { timeLimitMs: 5000 });
    assert.strictEqual(r.infeasible, false); assert.deepStrictEqual(r.score.completeZones, [0]); assert.strictEqual(r.pieces.length, 1);
  });
  check('獨立計分：必觸發區域沒填滿 → value 為 0、valid 為 false、forcedMissing 列出區域', () => {
    const p = two(true);
    const sc = Solver.evaluatePlacement(p, [{ color: 0, eff: 100, cells: [[0, 0]] }]);
    assert.strictEqual(sc.value, 0); assert.strictEqual(sc.valid, false); assert.deepStrictEqual(sc.forcedMissing, [1]);
    const ok = Solver.evaluatePlacement(p, [{ color: 0, eff: 100, cells: [[5, 0]] }]);
    assert.strictEqual(ok.valid, true); near(ok.value, 10);
    assert.deepStrictEqual(Solver.evaluatePlacement(p, []).forcedMissing, [1]);
  });

  let mm = 0, cs = 0, nInf = 0, nChanged = 0;
  for (let t = 0; t < 260; t++) {
    const prob = randomProblem();
    if (!prob.zones.length) continue;
    prob.settings.limit = ri(2, 4);
    prob.zones.forEach((z) => { z.must = rnd() < 0.45; });
    if (!prob.zones.some((z) => z.must)) prob.zones[0].must = true;
    const S = Solver.prepare(prob);
    if (S.PL.length > 120) continue;
    cs++;
    const bf = bruteForce(prob);
    const r = Solver.solve(prob, { timeLimitMs: 20000 });
    const free = bruteForce(Object.assign({}, prob, { zones: prob.zones.map((z) => Object.assign({}, z, { must: false })) }));
    if (Math.abs(bf - free) > 1e-6) nChanged++;
    if (Math.abs(bf - r.value) > 1e-6) { mm++; if (mm <= 3) console.log('   不一致', 'brute=', bf.toFixed(3), 'solver=', r.value.toFixed(3), JSON.stringify(prob.settings)); }
    else if (bf === 0 && !r.infeasible) { mm++; console.log('   無解卻沒標示 infeasible'); }
    else if (bf > 0 && (r.infeasible || r.score.forcedMissing.length)) { mm++; console.log('   有解卻標示無解／沒填滿必觸發區域'); }
    if (bf === 0) nInf++;
  }
  console.log('   統計:', cs, '題，其中無解', nInf, '題、必觸發改變最佳值', nChanged, '題');
  check(`${cs} 題隨機必觸發題與暴力解完全一致（含無解的判定）`, () => { assert.strictEqual(mm, 0); assert.ok(nInf > 0 && nChanged > 0, '測資沒有涵蓋無解／改變最佳值的情形'); });
}

/* ---------- 7. 區域特殊效果「免除懲罰」（waive）：區域填滿後，免除某「一種」懲罰（乖離 disc／過載 over／重疊 overlap）的 N 點 ---------- */
console.log('\n免除懲罰（分種類）');
{
  // 兩個互不相鄰的紅色單格區（相隔 4 格），各 500 攻；同時填滿 → 乖離 1
  const two = (waiveA, wtype, extra) => Object.assign({
    cells: [[0, 0], [5, 0]],
    zones: [{ color: 0, cells: [[0, 0]], atk: 500, def: 0, waive: waiveA || 0, wtype }, { color: 0, cells: [[5, 0]], atk: 500, def: 0 }],
    stacks: [{ color: 0, cells: [[0, 0]], effs: [{ v: 100, n: 2 }] }],
    settings: { limit: 2, penaltyCap: 3, rotation: false },
  }, extra || {});
  check('沒有免除：兩區都填滿有乖離 1 → 倍率 8/9 → 888.9', () => {
    const r = Solver.solve(two(0), { timeLimitMs: 5000 });
    near(r.value, 1000 * 8 / 9, 0.01); assert.strictEqual(r.score.P, 1); assert.strictEqual(r.score.waived, 0);
  });
  check('Z1 填滿後免除「乖離」1 點 → 乖離被抵銷，倍率 100% → 1000（沒寫種類時預設就是乖離）', () => {
    for (const wt of ['disc', undefined]) {
      const r = Solver.solve(two(1, wt), { timeLimitMs: 5000 });
      near(r.value, 1000, 0.01);
      assert.strictEqual(r.score.P, 1); assert.strictEqual(r.score.waive, 1); assert.strictEqual(r.score.waived, 1); assert.strictEqual(r.score.Peff, 0);
      assert.strictEqual(r.score.mult, 1); assert.strictEqual(r.score.effBy.disc, 0);
    }
  });
  check('種類不對就沒有用：免除「過載」或「重疊」抵銷不了乖離', () => {
    for (const wt of ['over', 'overlap']) {
      const r = Solver.solve(two(3, wt), { timeLimitMs: 5000 });
      near(r.value, 1000 * 8 / 9, 0.01); assert.strictEqual(r.score.waived, 0); assert.strictEqual(r.score.Peff, 1); assert.strictEqual(r.score.waive, 3);
    }
  });
  check('免除超過實際懲罰時，最多免到 0（不會變成負的而多賺）', () => {
    const r = Solver.solve(two(5, 'disc'), { timeLimitMs: 5000 });
    near(r.value, 1000, 0.01); assert.strictEqual(r.score.waived, 1); assert.strictEqual(r.score.Peff, 0);
  });
  check('免除要靠區域「填滿」：只放別區的粒子，Z1 沒填滿就沒有免除', () => {
    const sc = Solver.evaluatePlacement(two(1, 'disc'), [{ color: 0, eff: 100, cells: [[5, 0]] }]);
    assert.strictEqual(sc.waive, 0); assert.strictEqual(sc.waived, 0);
    const sc2 = Solver.evaluatePlacement(two(1, 'disc'), [{ color: 0, eff: 100, cells: [[5, 0]] }, { color: 0, eff: 100, cells: [[0, 0]] }]);
    assert.strictEqual(sc2.P, 1); assert.strictEqual(sc2.Peff, 0); near(sc2.finalAtk, 1000, 0.01);
  });
  check('免除「過載」讓可承受的粒子數變多：粒子上限 1、懲罰上限 1；兩區相鄰（乖離 0）', () => {
    const adj = (waive, wtype) => ({
      cells: [[0, 0], [1, 0]],
      zones: [{ color: 0, cells: [[0, 0]], atk: 500, def: 0, waive, wtype }, { color: 0, cells: [[1, 0]], atk: 500, def: 0 }],
      stacks: [{ color: 0, cells: [[0, 0]], effs: [{ v: 100, n: 2 }] }],
      settings: { limit: 1, penaltyCap: 1, rotation: false },
    });
    const none = Solver.solve(adj(0), { timeLimitMs: 5000 });
    near(none.value, 500); assert.strictEqual(none.pieces.length, 1);
    const wrong = Solver.solve(adj(1, 'disc'), { timeLimitMs: 5000 }); // 免除的是乖離，過載 1 點還在 → 2 顆仍是 P=1 ≥ 上限
    near(wrong.value, 500); assert.strictEqual(wrong.pieces.length, 1);
    const right = Solver.solve(adj(1, 'over'), { timeLimitMs: 5000 });
    near(right.value, 1000); assert.strictEqual(right.pieces.length, 2);
    assert.strictEqual(right.score.over, 1); assert.strictEqual(right.score.waived, 1); assert.strictEqual(right.score.Peff, 0);
  });
  check('免除「重疊」：被兩顆覆蓋的格子不再扣分（獨立計分）', () => {
    const p = {
      cells: [[0, 0], [1, 0]],
      zones: [{ color: 0, cells: [[0, 0]], atk: 500, def: 0, waive: 1, wtype: 'overlap' }],
      stacks: [{ color: 0, cells: [[0, 0]], effs: [100] }, { color: 0, cells: [[0, 0], [1, 0]], effs: [100] }],
      settings: { limit: 2, rotation: false, allowOverlap: true },
    };
    const pcs = [{ color: 0, eff: 100, cells: [[0, 0]] }, { color: 0, eff: 100, cells: [[0, 0], [1, 0]] }];
    const sc = Solver.evaluatePlacement(p, pcs);
    assert.strictEqual(sc.overlap, 1); assert.strictEqual(sc.P, 1); assert.strictEqual(sc.Peff, 0); near(sc.finalAtk, 500, 0.01);
    p.zones[0].wtype = 'disc';
    const sc2 = Solver.evaluatePlacement(p, pcs);
    assert.strictEqual(sc2.Peff, 1); near(sc2.finalAtk, 500 * 8 / 9, 0.01);
  });
  check('只有「免除」沒有攻防的區域：值得填的時候會去填它（相鄰於 A，用它的免除抵銷 A、B 之間的乖離）', () => {
    // A(0,0) 500 攻、W(1,0) 0 攻 0 防 免除乖離 1、B(6,0) 500 攻（與 A 相隔太遠，橋接不了）
    const p = {
      cells: [[0, 0], [1, 0], [6, 0]],
      zones: [{ color: 0, cells: [[0, 0]], atk: 500, def: 0 }, { color: 0, cells: [[6, 0]], atk: 500, def: 0 }, { color: 0, cells: [[1, 0]], atk: 0, def: 0, waive: 1, wtype: 'disc' }],
      stacks: [{ color: 0, cells: [[0, 0]], effs: [{ v: 100, n: 4 }] }],
      settings: { limit: 3, rotation: false },
    };
    const r = Solver.solve(p, { timeLimitMs: 5000 });
    near(r.value, 1000, 0.01); assert.deepStrictEqual(r.score.completeZones.sort(), [0, 1, 2]);
    assert.strictEqual(r.score.disc, 1); assert.strictEqual(r.score.Peff, 0);
  });

  // 隨機題與暴力解比對（區域隨機帶 0~2 點免除、種類隨機，有些區域沒有攻防）
  let mm = 0, cs = 0, used = 0, changed = 0; const byType = { disc: 0, over: 0 };
  for (let t = 0; t < 360; t++) {
    const prob = randomProblem();
    if (!prob.zones.length) continue;
    prob.settings.limit = ri(1, 3);
    if (rnd() < 0.3) prob.settings.penaltyCap = ri(1, 4);
    prob.zones.forEach((z) => {
      if (rnd() < 0.6) { z.waive = ri(1, 2); z.wtype = ['disc', 'over', 'overlap'][ri(0, 2)]; }
      if (z.waive && rnd() < 0.3) { z.atk = 0; z.def = 0; }
      if (rnd() < 0.15) z.must = true;
    });
    const S = Solver.prepare(prob);
    if (S.PL.length > 70 || S.maxPieces > 8) continue;
    cs++;
    const bf = bruteForce(prob);
    const r = Solver.solve(prob, { timeLimitMs: 20000 });
    if (Math.abs(bf - r.value) > 1e-6) { mm++; if (mm <= 3) console.log('   不一致', 'brute=', bf.toFixed(3), 'solver=', r.value.toFixed(3), JSON.stringify(prob.settings), 'waive=', JSON.stringify(prob.zones.map((z) => [z.waive || 0, z.wtype]))); }
    else if (r.score && Math.abs(r.score.value - r.internal) > 1e-4) { mm++; console.log('   內部計分與獨立計分不一致', r.score.value, r.internal); }
    if (r.score && r.score.waived > 0) { used++; for (const k of ['disc', 'over']) if (r.score.waiveBy[k] > 0 && r.score.effBy[k] < r.score[k]) byType[k]++; }
    const free = bruteForce(Object.assign({}, prob, { zones: prob.zones.map((z) => Object.assign({}, z, { waive: 0 })) }));
    if (Math.abs(bf - free) > 1e-6) changed++;
  }
  console.log('   統計:', cs, '題，最佳解實際用到免除', used, '題（乖離', byType.disc, '、過載', byType.over, '）、免除改變最佳值', changed, '題');
  check(`${cs} 題隨機免除題與暴力解完全一致`, () => { assert.strictEqual(mm, 0); assert.ok(used > 0 && changed > 0 && byType.disc > 0 && byType.over > 0, '測資沒有涵蓋乖離與過載的免除'); });

  // 允許重疊的題目暴力解不支援，只驗證「搜尋內部計分 = 獨立計分」（含免除重疊）
  let om = 0, oc = 0, oUsed = 0;
  for (let t = 0; t < 120; t++) {
    const prob = randomProblem();
    if (!prob.zones.length) continue;
    prob.settings.allowOverlap = true; prob.settings.limit = ri(1, 3);
    prob.zones.forEach((z) => { if (rnd() < 0.6) { z.waive = ri(1, 2); z.wtype = ['disc', 'over', 'overlap'][ri(0, 2)]; } });
    const S = Solver.prepare(prob);
    if (S.PL.length > 70 || S.maxPieces > 8) continue;
    oc++;
    const r = Solver.solve(prob, { timeLimitMs: 20000 });
    if (r.score && Math.abs(r.score.value - r.internal) > 1e-4) { om++; console.log('   內部計分與獨立計分不一致', r.score.value, r.internal); }
    if (r.score && r.score.overlap > 0 && r.score.waiveBy.overlap > 0) oUsed++;
  }
  console.log('   允許重疊：', oc, '題，其中最佳解有重疊且有重疊免除', oUsed, '題');
  check(`${oc} 題允許重疊的題目：內部計分與獨立計分一致`, () => assert.strictEqual(om, 0));
}

/* ---------- 7b. 免除「整體」懲罰（wtype: 'all'）：各種類先各自扣，再從剩下的總和裡扣 ---------- */
console.log('\n免除整體懲罰');
{
  const two = (waive, wtype, settings) => ({
    cells: [[0, 0], [5, 0]],
    zones: [{ color: 0, cells: [[0, 0]], atk: 500, def: 0, waive, wtype }, { color: 0, cells: [[5, 0]], atk: 500, def: 0 }],
    stacks: [{ color: 0, cells: [[0, 0]], effs: [{ v: 100, n: 3 }] }],
    settings: Object.assign({ limit: 2, penaltyCap: 3, rotation: false }, settings || {}),
  });
  check('整體免除 1 點抵銷乖離 1（不分種類）→ 倍率 100% → 1000', () => {
    const r = Solver.solve(two(1, 'all'), { timeLimitMs: 5000 });
    near(r.value, 1000, 0.01); assert.strictEqual(r.score.P, 1); assert.strictEqual(r.score.Peff, 0); assert.strictEqual(r.score.waived, 1); assert.strictEqual(r.score.waiveBy.all, 1);
  });
  check('整體免除跨種類：過載 1＋乖離 1（P=2）→ 免 1 剩 1（8/9）、免 2 剩 0（1.0）、免 5 也只到 0', () => {
    const p = (w) => two(w, 'all', { limit: 1 });
    // 2 顆（上限 1）互不相連：過載 1、乖離 1
    const two2 = [{ color: 0, eff: 100, cells: [[0, 0]] }, { color: 0, eff: 100, cells: [[5, 0]] }];
    const base = Solver.evaluatePlacement(p(0), two2); assert.strictEqual(base.P, 2); near(base.mult, 5 / 9, 1e-9);
    assert.strictEqual(Solver.evaluatePlacement(p(1), two2).Peff, 1);
    assert.strictEqual(Solver.evaluatePlacement(p(2), two2).Peff, 0);
    assert.strictEqual(Solver.evaluatePlacement(p(5), two2).Peff, 0); assert.strictEqual(Solver.evaluatePlacement(p(5), two2).waived, 2);
  });
  check('「整體」和某一種的免除加在一起：乖離 1 被「乖離」免除抵銷、過載 1 被「整體」免除抵銷 → 0', () => {
    const p = two(1, 'all', { limit: 1 });
    p.zones[1].waive = 1; p.zones[1].wtype = 'disc';
    const two2 = [{ color: 0, eff: 100, cells: [[0, 0]] }, { color: 0, eff: 100, cells: [[5, 0]] }];
    const sc = Solver.evaluatePlacement(p, two2);
    assert.strictEqual(sc.P, 2); assert.strictEqual(sc.effBy.disc, 0); assert.strictEqual(sc.effBy.over, 1); assert.strictEqual(sc.Peff, 0); assert.strictEqual(sc.waived, 2);
  });
  check('整體免除讓可承受的粒子數變多：粒子上限 1、懲罰上限 1，相鄰兩區（乖離 0，過載 1 → 被免除）', () => {
    const adj = (waive) => ({
      cells: [[0, 0], [1, 0]],
      zones: [{ color: 0, cells: [[0, 0]], atk: 500, def: 0, waive, wtype: 'all' }, { color: 0, cells: [[1, 0]], atk: 500, def: 0 }],
      stacks: [{ color: 0, cells: [[0, 0]], effs: [{ v: 100, n: 2 }] }],
      settings: { limit: 1, penaltyCap: 1, rotation: false },
    });
    near(Solver.solve(adj(0), { timeLimitMs: 5000 }).value, 500);
    const r = Solver.solve(adj(1), { timeLimitMs: 5000 });
    near(r.value, 1000); assert.strictEqual(r.pieces.length, 2); assert.strictEqual(r.score.Peff, 0);
  });

  let mm = 0, cs = 0, used = 0, changed = 0;
  for (let t = 0; t < 300; t++) {
    const prob = randomProblem();
    if (!prob.zones.length) continue;
    prob.settings.limit = ri(1, 3);
    if (rnd() < 0.3) prob.settings.penaltyCap = ri(1, 4);
    prob.zones.forEach((z) => {
      if (rnd() < 0.6) { z.waive = ri(1, 3); z.wtype = ['all', 'all', 'disc', 'over'][ri(0, 3)]; }
      if (z.waive && rnd() < 0.3) { z.atk = 0; z.def = 0; }
      if (rnd() < 0.1) z.must = true;
    });
    const S = Solver.prepare(prob);
    if (S.PL.length > 70 || S.maxPieces > 8) continue;
    cs++;
    const bf = bruteForce(prob);
    const r = Solver.solve(prob, { timeLimitMs: 20000 });
    if (Math.abs(bf - r.value) > 1e-6) { mm++; if (mm <= 3) console.log('   不一致', 'brute=', bf.toFixed(3), 'solver=', r.value.toFixed(3), JSON.stringify(prob.settings), 'waive=', JSON.stringify(prob.zones.map((z) => [z.waive || 0, z.wtype]))); }
    else if (r.score && Math.abs(r.score.value - r.internal) > 1e-4) { mm++; console.log('   內部計分與獨立計分不一致', r.score.value, r.internal); }
    if (r.score && r.score.waiveBy.all > 0 && r.score.waived > 0) used++;
    const free = bruteForce(Object.assign({}, prob, { zones: prob.zones.map((z) => Object.assign({}, z, { waive: 0 })) }));
    if (Math.abs(bf - free) > 1e-6) changed++;
  }
  console.log('   統計:', cs, '題，最佳解實際用到整體免除', used, '題、免除改變最佳值', changed, '題');
  check(`${cs} 題隨機整體免除題與暴力解完全一致`, () => { assert.strictEqual(mm, 0); assert.ok(used > 0 && changed > 0, '測資沒有涵蓋整體免除'); });

  // 固定免除（settings.globalWaive）：角色技能／卡牌效果，不用填滿區域，一直生效
  check('固定免除：整體 1 點抵銷乖離 1，不用填任何區域；種類不對（重疊）抵銷不了乖離', () => {
    const r = Solver.solve(two(0, 'all', { globalWaive: { all: 1 } }), { timeLimitMs: 5000 });
    near(r.value, 1000, 0.01); assert.strictEqual(r.score.Peff, 0); assert.strictEqual(r.score.waiveBy.all, 1);
    const w = Solver.solve(two(0, 'all', { globalWaive: { overlap: 1 } }), { timeLimitMs: 5000 });
    near(w.value, 1000 * 8 / 9, 0.01); assert.strictEqual(w.score.Peff, 1);
  });
  check('固定免除「重疊」1 點：一次重疊不算懲罰（獨立計分）；第二次重疊才算', () => {
    const p = {
      cells: [[0, 0], [1, 0], [2, 0]],
      zones: [{ color: 0, cells: [[0, 0], [1, 0], [2, 0]], atk: 600, def: 0 }],
      stacks: [{ color: 0, cells: [[0, 0], [1, 0]], effs: [100] }, { color: 0, cells: [[1, 0], [2, 0]], effs: [100] }],
      settings: { limit: 2, rotation: false, allowOverlap: true, globalWaive: { overlap: 1 } },
    };
    const pcs = [{ color: 0, eff: 100, cells: [[0, 0], [1, 0]] }, { color: 0, eff: 100, cells: [[1, 0], [2, 0]] }];
    const sc = Solver.evaluatePlacement(p, pcs);
    assert.strictEqual(sc.overlap, 1); assert.strictEqual(sc.P, 1); assert.strictEqual(sc.Peff, 0); near(sc.finalAtk, 600, 0.01);
    p.settings.globalWaive = {};
    near(Solver.evaluatePlacement(p, pcs).finalAtk, 600 * 8 / 9, 0.01);
  });
  check('固定免除「過載」讓可放的粒子變多：粒子上限 1、懲罰上限 1，免除過載 1 點後放得下 2 顆', () => {
    const adj = (gw) => ({
      cells: [[0, 0], [1, 0]],
      zones: [{ color: 0, cells: [[0, 0]], atk: 500, def: 0 }, { color: 0, cells: [[1, 0]], atk: 500, def: 0 }],
      stacks: [{ color: 0, cells: [[0, 0]], effs: [{ v: 100, n: 2 }] }],
      settings: { limit: 1, penaltyCap: 1, rotation: false, globalWaive: gw },
    });
    assert.strictEqual(Solver.solve(adj({}), { timeLimitMs: 5000 }).pieces.length, 1);
    const r = Solver.solve(adj({ over: 1 }), { timeLimitMs: 5000 });
    near(r.value, 1000); assert.strictEqual(r.pieces.length, 2);
  });
  {
    let gm = 0, gc = 0, gused = 0;
    for (let t = 0; t < 260; t++) {
      const prob = randomProblem();
      if (!prob.zones.length) continue;
      prob.settings.limit = ri(1, 3);
      if (rnd() < 0.3) prob.settings.penaltyCap = ri(1, 4);
      const gw = {}; gw[['all', 'disc', 'over'][ri(0, 2)]] = ri(1, 2); prob.settings.globalWaive = gw;
      if (rnd() < 0.4) prob.settings.maxPenalty = ri(0, 1);
      prob.zones.forEach((z) => { if (rnd() < 0.3) { z.waive = ri(1, 2); z.wtype = ['all', 'disc', 'over'][ri(0, 2)]; } });
      const S = Solver.prepare(prob);
      if (S.PL.length > 70 || S.maxPieces > 8) continue;
      gc++;
      const bf = bruteForce(prob);
      const r = Solver.solve(prob, { timeLimitMs: 20000 });
      if (Math.abs(bf - r.value) > 1e-6) { gm++; if (gm <= 3) console.log('   不一致', 'brute=', bf.toFixed(3), 'solver=', r.value.toFixed(3), JSON.stringify(prob.settings)); }
      else if (r.score && Math.abs(r.score.value - r.internal) > 1e-4) { gm++; console.log('   內部計分與獨立計分不一致', r.score.value, r.internal); }
      if (r.score && r.score.waived > 0) gused++;
    }
    console.log('   統計:', gc, '題，最佳解實際用到免除', gused, '題');
    check(`${gc} 題隨機固定免除題與暴力解完全一致`, () => { assert.strictEqual(gm, 0); assert.ok(gused > 0, '測資沒有涵蓋固定免除'); });
  }
}

/* ---------- 8. 基礎攻防門檻（任務條件）：填滿的區域攻／防加總至少要達到某值 ---------- */
console.log('\n基礎攻防門檻');
{
  // 兩個互不相鄰的紅色單格區：Z1 攻 1000／防 0，Z2 攻 0／防 100；預設只放得下 1 顆
  const two = (st) => ({
    cells: [[0, 0], [5, 0]],
    zones: [{ color: 0, cells: [[0, 0]], atk: 1000, def: 0 }, { color: 0, cells: [[5, 0]], atk: 0, def: 100 }],
    stacks: [{ color: 0, cells: [[0, 0]], effs: [{ v: 100, n: 3 }] }],
    settings: Object.assign({ limit: 1, penaltyCap: 1, rotation: false }, st || {}),
  });
  check('沒有門檻選 Z1（1000）；基礎防禦 ≥ 100 → 一定要填 Z2', () => {
    const a = Solver.solve(two(), { timeLimitMs: 5000 });
    assert.deepStrictEqual(a.score.completeZones, [0]);
    const b = Solver.solve(two({ minBaseDef: 100 }), { timeLimitMs: 5000 });
    assert.deepStrictEqual(b.score.completeZones, [1]); assert.strictEqual(b.score.def, 100); assert.strictEqual(b.infeasible, false);
    assert.strictEqual(b.score.baseOk, true); assert.strictEqual(b.base.minDef, 100);
  });
  check('門檻比所有區域加總還高 → 立刻無解，並回報理論上限', () => {
    const r = Solver.solve(two({ minBaseDef: 101 }), { timeLimitMs: 5000 });
    assert.strictEqual(r.infeasible, true); assert.strictEqual(r.pieces.length, 0); assert.strictEqual(r.nodes, 0);
    assert.strictEqual(r.base.unreachable, true); assert.strictEqual(r.base.capDef, 100); assert.strictEqual(r.base.capAtk, 1000);
  });
  check('每項門檻單獨都達得到，但粒子數上限放不下兩區 → 搜尋跑完後無解', () => {
    const r = Solver.solve(two({ minBaseDef: 100, minBaseAtk: 1000 }), { timeLimitMs: 5000 });
    assert.strictEqual(r.infeasible, true); assert.strictEqual(r.base.unreachable, false); assert.strictEqual(r.finished, true); assert.strictEqual(r.pieces.length, 0);
  });
  check('放寬粒子數上限後，攻防門檻同時達標（乖離 1 → 倍率 8/9）', () => {
    const r = Solver.solve(two({ minBaseDef: 100, minBaseAtk: 1000, limit: 2, penaltyCap: 3 }), { timeLimitMs: 5000 });
    assert.strictEqual(r.infeasible, false); assert.deepStrictEqual(r.score.completeZones.sort(), [0, 1]); near(r.score.finalAtk, 1000 * 8 / 9); near(r.score.finalDef, 100 * 8 / 9);
  });
  check('門檻看的是「基礎」值，不受平均效能與倍率影響：效能 50、乖離 1 也算達標', () => {
    const p = two({ minBaseDef: 100, minBaseAtk: 1000, limit: 2, penaltyCap: 3 }); p.stacks[0].effs = [{ v: 50, n: 3 }];
    const r = Solver.solve(p, { timeLimitMs: 5000 });
    assert.strictEqual(r.infeasible, false); assert.strictEqual(r.score.atk, 1000); assert.strictEqual(r.score.def, 100); assert.ok(r.score.finalAtk < 1000);
  });
  check('目標權重讓防禦價值為 0（自訂 攻 1／防 0）時，仍會為了基礎防禦門檻去填 Z2', () => {
    const r = Solver.solve(two({ minBaseDef: 100, wAtk: 1, wDef: 0, limit: 2, penaltyCap: 3 }), { timeLimitMs: 5000 });
    assert.strictEqual(r.infeasible, false); assert.ok(r.score.def >= 100);
  });
  check('獨立計分：基礎值沒達標 → value 為 0、valid 為 false、baseOk 為 false', () => {
    const p = two({ minBaseDef: 100 });
    const bad = Solver.evaluatePlacement(p, [{ color: 0, eff: 100, cells: [[0, 0]] }]);
    assert.strictEqual(bad.baseOk, false); assert.strictEqual(bad.value, 0); assert.strictEqual(bad.valid, false);
    const ok = Solver.evaluatePlacement(p, [{ color: 0, eff: 100, cells: [[5, 0]] }]);
    assert.strictEqual(ok.baseOk, true); assert.strictEqual(ok.valid, true); near(ok.value, 100);
    assert.strictEqual(Solver.evaluatePlacement(two(), [{ color: 0, eff: 100, cells: [[0, 0]] }]).baseOk, true); // 沒設門檻 → 一律達標
  });

  check('診斷：哪些區域「單獨」就填不滿（沒有同色粒子／形狀拼不出來／超過粒子數上限）', () => {
    const p = {
      cells: [[0, 0], [1, 0], [2, 0], [5, 0], [6, 0], [9, 0]],
      zones: [
        { color: 0, cells: [[0, 0], [1, 0]], atk: 100, def: 0, name: 'A' },          // 紅 2 格：有 2 格長條，可以
        { color: 0, cells: [[2, 0], [5, 0]], atk: 100, def: 0, name: 'B' },          // 紅，但兩格不相鄰，要兩顆 1 格 → 可以（2 顆）
        { color: 1, cells: [[6, 0]], atk: 100, def: 0, name: 'C' },                  // 黃：沒有黃色粒子
        { color: 0, cells: [[0, 0], [1, 0], [2, 0]], atk: 100, def: 0, name: 'D' },  // 紅 3 格：2 格長條＋1 格 1 顆 → 可以
      ],
      stacks: [{ color: 0, cells: [[0, 0], [1, 0]], effs: [100] }, { color: 0, cells: [[0, 0]], effs: [{ v: 100, n: 3 }] }],
      settings: { limit: 3, rotation: false },
    };
    const d = p.zones.map((_, i) => Solver.diagnoseZone(p, i, 3000));
    assert.deepStrictEqual(d.map((x) => x.fillable), [true, true, false, true]);
    assert.deepStrictEqual(d.map((x) => x.colorOk), [true, true, false, true]);
    // 粒子數上限 1：只有 A（一顆 2 格）填得滿，B、D 要 2 顆以上 → 填不滿
    p.settings = { limit: 1, penaltyCap: 1, rotation: false };
    assert.deepStrictEqual(p.zones.map((_, i) => Solver.diagnoseZone(p, i, 3000).fillable), [true, false, false, false]);
  });

  let mm = 0, cs = 0, nInf = 0, nChanged = 0, nBoth = 0;
  for (let t = 0; t < 320; t++) {
    const prob = randomProblem();
    if (!prob.zones.length) continue;
    prob.settings.limit = ri(2, 4);
    const sum = (f) => prob.zones.reduce((a, z) => a + (rnd() < 0.6 ? z[f] : 0), 0);
    const mode = ri(0, 2); // 0 只限防禦、1 只限攻擊、2 兩者都限
    if (mode !== 1) prob.settings.minBaseDef = sum('def') + (rnd() < 0.15 ? 50 : 0);
    if (mode !== 0) prob.settings.minBaseAtk = sum('atk') + (rnd() < 0.15 ? 50 : 0);
    const S = Solver.prepare(prob);
    if (S.PL.length > 120) continue;
    cs++; if (mode === 2) nBoth++;
    const bf = bruteForce(prob);
    const r = Solver.solve(prob, { timeLimitMs: 20000 });
    const freeProb = Object.assign({}, prob, { settings: Object.assign({}, prob.settings, { minBaseDef: 0, minBaseAtk: 0 }) });
    if (Math.abs(bf - bruteForce(freeProb)) > 1e-6) nChanged++;
    if (Math.abs(bf - r.value) > 1e-6) { mm++; if (mm <= 3) console.log('   不一致', 'brute=', bf.toFixed(3), 'solver=', r.value.toFixed(3), JSON.stringify(prob.settings)); }
    else if (bf === 0 && !r.infeasible && r.score && r.score.value > 0) { mm++; console.log('   無解卻給了擺放'); }
    else if (bf > 0 && (r.infeasible || !r.score.baseOk)) { mm++; console.log('   有解卻標示無解／基礎值沒達標'); }
    if (bf === 0) nInf++;
  }
  console.log('   統計:', cs, '題（兩項都限', nBoth, '）、無解', nInf, '題、門檻改變最佳值', nChanged, '題');
  check(`${cs} 題隨機基礎攻防門檻題與暴力解完全一致（含無解的判定）`, () => { assert.strictEqual(mm, 0); assert.ok(nInf > 0 && nChanged > 0 && nBoth > 0, '測資沒有涵蓋無解／改變最佳值／兩項同時限制的情形'); });

  // 「總懲罰最多 N 點」（遊戲任務常見的「總懲罰數為 0」＝ 0）：有效懲罰超過 N 就當作無法製作
  check('總懲罰最多 0：兩區互不相連（乖離 1）無法同時達標；最多 1 就可以；沒設定＝不限制', () => {
    const p = (mp) => two({ minBaseDef: 100, minBaseAtk: 1000, limit: 2, penaltyCap: 3, maxPenalty: mp });
    assert.strictEqual(Solver.solve(p(0), { timeLimitMs: 5000 }).infeasible, true);
    const one = Solver.solve(p(1), { timeLimitMs: 5000 });
    assert.strictEqual(one.infeasible, false); assert.strictEqual(one.score.Peff, 1);
    for (const none of [undefined, '', null, -1]) assert.strictEqual(Solver.solve(p(none), { timeLimitMs: 5000 }).infeasible, false);
  });
  check('總懲罰最多 0＋免除：整體免除 1 點生效（區域填滿）後，乖離 1 也算有效懲罰 0 → 可以', () => {
    const p = two({ minBaseDef: 100, minBaseAtk: 1000, limit: 2, penaltyCap: 3, maxPenalty: 0 });
    p.zones[0].waive = 1; p.zones[0].wtype = 'all';
    const r = Solver.solve(p, { timeLimitMs: 5000 });
    assert.strictEqual(r.infeasible, false); assert.strictEqual(r.score.disc, 1); assert.strictEqual(r.score.Peff, 0);
  });
  {
    let mm2 = 0, cs2 = 0, nInf2 = 0, nChg2 = 0;
    for (let t = 0; t < 220; t++) {
      const prob = randomProblem();
      if (!prob.zones.length) continue;
      prob.settings.limit = ri(1, 4);
      prob.settings.maxPenalty = ri(0, 2);
      if (rnd() < 0.5) prob.settings.minBaseDef = prob.zones.reduce((a, z) => a + (rnd() < 0.5 ? z.def : 0), 0);
      prob.zones.forEach((z) => { if (rnd() < 0.4) { z.waive = ri(1, 2); z.wtype = ['all', 'all', 'disc', 'over'][ri(0, 3)]; } });
      const S = Solver.prepare(prob);
      if (S.PL.length > 90 || S.maxPieces > 8) continue;
      cs2++;
      const bf = bruteForce(prob);
      const r = Solver.solve(prob, { timeLimitMs: 20000 });
      const free = bruteForce(Object.assign({}, prob, { settings: Object.assign({}, prob.settings, { maxPenalty: undefined }) }));
      if (Math.abs(bf - free) > 1e-6) nChg2++;
      if (Math.abs(bf - r.value) > 1e-6) { mm2++; if (mm2 <= 3) console.log('   不一致', 'brute=', bf.toFixed(3), 'solver=', r.value.toFixed(3), JSON.stringify(prob.settings)); }
      else if (r.score && Math.abs(r.score.value - r.internal) > 1e-4) { mm2++; console.log('   內部計分與獨立計分不一致', r.score.value, r.internal); }
      else if (r.score && r.score.Peff > prob.settings.maxPenalty) { mm2++; console.log('   有效懲罰超過上限'); }
      if (bf === 0) nInf2++;
    }
    console.log('   統計:', cs2, '題，無解', nInf2, '題、懲罰上限改變最佳值', nChg2, '題');
    check(`${cs2} 題隨機「總懲罰最多 N」題與暴力解完全一致`, () => { assert.strictEqual(mm2, 0); assert.ok(nChg2 > 0, '測資沒有涵蓋懲罰上限改變最佳值的情形'); });
  }
}

console.log(`\n${pass} 通過, ${fail} 失敗`);
process.exit(fail ? 1 : 0);
