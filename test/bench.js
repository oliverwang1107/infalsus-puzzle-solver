'use strict';
/*
 * 代表性題目的效能量測（真實粒子庫存 data/particles.json ＋ 真實配方板子／合成的 110 格 14 區大板子）。
 *
 *   node test/bench.js                        # 全部題目，JS 引擎，每題上限 30 秒
 *   node test/bench.js --engine wasm          # js｜wasm｜native（native 可加 --threads N）
 *   node test/bench.js --only B3,B5 --time 60000
 *   node test/bench.js --root <資料夾>        # 用另一份程式碼（裡面要有 src/solver.js、src/solver_wasm.js、wasm/solver.wasm）量測，前後對照用
 *   node test/bench.js --exe <solver_native>  # 指定原生執行檔
 *   node test/bench.js --json out.json        # 結果另存 JSON
 *
 * 輸出每題：是否跑完、用時、節點數、最佳值（跑完的題目三個引擎的最佳值必須一樣）。
 */
const fs = require('fs');
const path = require('path');
const args = process.argv.slice(2);
const arg = (name, def) => { const i = args.indexOf('--' + name); return i >= 0 ? args[i + 1] : def; };
const ROOT = path.resolve(arg('root', path.join(__dirname, '..')));
if (arg('exe')) process.env.INFALSUS_NATIVE_EXE = path.resolve(arg('exe'));
const Solver = require(path.join(ROOT, 'src', 'solver.js'));
const ENGINE = arg('engine', 'js');
const TIME = Number(arg('time', 30000));
const ONLY = arg('only') ? arg('only').split(',') : null;
const DATA = path.join(__dirname, '..', 'data');

const offToAxial = (c, row) => [c, row - ((c - (c & 1)) >> 1)];
const parseEffs = (t) => String(t).split(',').map((x) => { const [v, n] = x.trim().split('x').map(Number); return { v, n: n || 1 }; }).filter((e) => e.v > 0);
const inv = JSON.parse(fs.readFileSync(path.join(DATA, 'particles.json'), 'utf8'));
const stacksOf = (extra) => inv.stacks.filter((s) => extra || !s.extra).map((s) => ({ color: s.color, cells: s.shape, effs: parseEffs(s.effText) }));

function rng(seed0) {
  let seed = seed0;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  return { rnd, ri: (a, b) => a + Math.floor(rnd() * (b - a + 1)) };
}

// 真實配方的板子；區域攻防原始檔是 0（待使用者填），這裡用固定種子給值
function recipe(file, seed) {
  const r = JSON.parse(fs.readFileSync(path.join(DATA, file), 'utf8'));
  const { ri } = rng(seed);
  const ax = (k) => { const [c, row] = k.split(',').map(Number); return offToAxial(c, row); };
  const cells = Object.keys(r.board).map(ax);
  const zones = r.zv.map((z, i) => ({ color: r.board[z.keys[0]].t - 1, cells: z.keys.map(ax), atk: ri(1, 9) * 50 * Math.max(1, Math.round(Math.sqrt(z.keys.length))), def: ri(1, 9) * 50 * Math.max(1, Math.round(Math.sqrt(z.keys.length))), name: 'Z' + (i + 1) }));
  return { cells, zones };
}

// 合成大板子：cols×rows 的六角格（offset 座標），在上面長出 nz 個互不相鄰重疊的色彩區域
function bigBoard(seed, cols, rows, sizes) {
  const { rnd, ri } = rng(seed);
  const key = (c) => c[0] + ',' + c[1];
  const cells = []; const on = new Set();
  for (let c = 0; c < cols; c++) for (let r = 0; r < rows; r++) { const a = offToAxial(c, r); cells.push(a); on.add(key(a)); }
  const taken = new Set(); const zones = [];
  for (let zi = 0; zi < sizes.length; zi++) {
    for (let tries = 0; tries < 200; tries++) {
      const start = cells[ri(0, cells.length - 1)];
      if (taken.has(key(start))) continue;
      const zc = [start]; const mine = new Set([key(start)]);
      for (let g = 0; g < 400 && zc.length < sizes[zi]; g++) {
        const c = zc[ri(0, zc.length - 1)], d = Solver.NEIGH[ri(0, 5)], q = [c[0] + d[0], c[1] + d[1]];
        if (on.has(key(q)) && !taken.has(key(q)) && !mine.has(key(q))) { zc.push(q); mine.add(key(q)); }
      }
      if (zc.length < sizes[zi]) continue;
      for (const k of mine) taken.add(k);
      const sq = Math.max(1, Math.round(Math.sqrt(zc.length)));
      zones.push({ color: zi % 5, cells: zc, atk: ri(1, 9) * 50 * sq, def: ri(1, 9) * 50 * sq, name: 'Z' + (zones.length + 1) });
      break;
    }
  }
  void rnd;
  return { cells, zones };
}

const base = (o) => Object.assign({ limit: 8, rotation: false, allowOverlap: false, penaltyCap: 3, wAtk: 1, wDef: 1 }, o);
const SZ14 = [1, 10, 1, 4, 7, 10, 1, 8, 2, 6, 9, 3, 5, 7];
const big = () => bigBoard(11, 11, 10, SZ14); // 110 格、14 區
const clone = (b) => JSON.parse(JSON.stringify(b));
const PROBLEMS = [
  ['B1', '找尋夥伴 40格7區 上限8', () => ({ ...recipe('recipe_zhao_xun_huo_ban.json', 3), stacks: stacksOf(false), settings: base({ limit: 8 }) })],
  ['B2', '新朋友 125格5區 上限6', () => ({ ...recipe('recipe_xin_peng_you.json', 5), stacks: stacksOf(false), settings: base({ limit: 6 }) })],
  ['B3', '大板 110格14區 上限8', () => ({ ...big(), stacks: stacksOf(false), settings: base({ limit: 8 }) })],
  ['B4', '大板 110格14區 上限12', () => ({ ...big(), stacks: stacksOf(false), settings: base({ limit: 12 }) })],
  ['B5', '大板 110格14區 上限16', () => ({ ...big(), stacks: stacksOf(false), settings: base({ limit: 16 }) })],
  ['B6', '大板 上限8 可旋轉', () => ({ ...big(), stacks: stacksOf(false), settings: base({ limit: 8, rotation: true }) })],
  ['B7', '大板 上限10 允許重疊＋固定免除重疊1', () => ({ ...big(), stacks: stacksOf(false), settings: base({ limit: 10, allowOverlap: true, globalWaive: { overlap: 1 } }) })],
  ['B8', '大板 上限10 區域免除(乖離/整體)＋必觸發', () => { const b = clone(big()); b.zones[1].waive = 1; b.zones[1].wtype = 'disc'; b.zones[4].waive = 1; b.zones[4].wtype = 'all'; b.zones[7].must = true; return { ...b, stacks: stacksOf(false), settings: base({ limit: 10 }) }; }],
  ['B9', '大板 上限12 含額外粒子(40種)', () => ({ ...big(), stacks: stacksOf(true), settings: base({ limit: 12 }) })],
  ['B10', '大板 上限10 基礎防禦門檻＋最大懲罰1', () => { const b = big(); const tot = b.zones.reduce((a, z) => a + z.def, 0); return { ...b, stacks: stacksOf(false), settings: base({ limit: 10, minBaseDef: Math.round(tot * 0.45), maxPenalty: 1 }) }; }],
  ['B11', '大板 上限8 特化攻擊＋允許超界', () => ({ ...big(), stacks: stacksOf(false), settings: base({ limit: 8, wAtk: 1, wDef: 0.001, allowOutside: true, globalWaive: { out: 1 } }) })],
  ['B12', '另一張大板(種子23) 上限12', () => ({ ...bigBoard(23, 11, 10, [3, 9, 1, 6, 8, 2, 10, 4, 7, 1, 5, 9, 2, 6]), stacks: stacksOf(false), settings: base({ limit: 12 }) })],
];

function getEngine() {
  if (ENGINE === 'js') return undefined;
  if (ENGINE === 'wasm') {
    const Wasm = require(path.join(ROOT, 'src', 'solver_wasm.js'));
    return Wasm.loadSync(fs.readFileSync(path.join(ROOT, 'wasm', 'solver.wasm')), (e) => { console.log('  !! WASM 例外，退回 JS：' + (e && e.message)); });
  }
  if (ENGINE === 'native') {
    const Native = require(path.join(ROOT, 'src', 'solver_native.js'));
    return Native.engineSync({ threads: Number(arg('threads', Native.cores())) });
  }
  throw new Error('未知的引擎：' + ENGINE);
}

if (require.main === module) {
  const engine = getEngine();
  const rows = [];
  console.log(`引擎=${ENGINE}${ENGINE === 'native' ? '×' + arg('threads', 'all') : ''} 每題上限 ${TIME} ms  root=${ROOT}`);
  for (const [id, name, mk] of PROBLEMS) {
    if (ONLY && !ONLY.includes(id)) continue;
    const prob = mk();
    const S = Solver.prepare(prob);
    let tBest = 0;
    const t0 = Date.now();
    const r = Solver.solve(prob, { timeLimitMs: TIME, engine, onImprove: ENGINE === 'native' ? undefined : (b) => { tBest = b.ms; } });
    const ms = Date.now() - t0;
    const row = { id, name, cells: prob.cells.length, zones: prob.zones.length, placements: S.PL.length, finished: r.finished, ms, tBest, nodes: r.nodes, value: r.value, n: r.pieces.length, stats: r.stats };
    rows.push(row);
    console.log(`${id.padEnd(4)} ${r.finished ? '完成' : '逾時'} ${String(ms).padStart(6)} ms  節點 ${String(r.nodes).padStart(11)}  最佳 ${r.value.toFixed(3).padStart(10)} (${r.pieces.length} 顆${ENGINE === 'native' ? '' : '，' + tBest + ' ms 找到'})  ${name}｜擺放 ${S.PL.length}`);
  }
  if (arg('json')) fs.writeFileSync(arg('json'), JSON.stringify(rows, null, 1));
}
module.exports = { PROBLEMS };
