/*
 * 求解器的 WASM 搜尋引擎（Rust 原始碼在 wasm/src/lib.rs，是 solver.js 的 searchJS 的逐行移植）。
 *
 * 用法（Node 或瀏覽器）：
 *   const Wasm = require('./solver_wasm.js');                 // 瀏覽器裡是全域 InfalsusWasm
 *   const engine = Wasm.loadSync(bytes);                      // 或 await Wasm.load(bytes)
 *   Solver.solve(prob, { engine, timeLimitMs: 30000 });       // 和 JS 版的結果格式完全一樣
 *
 * 做法：prepare()（所有合法擺放、遮罩…）還是在 JS 端算，攤平成兩個陣列寫進 WASM 記憶體，只有最花時間的搜尋在 WASM 裡跑。
 * WASM 不能用（沒載入、太大、發生例外）時，engine 會自動退回 JS 版搜尋，所以呼叫端不用處理失敗。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./solver.js'));
  else root.InfalsusWasm = factory(root.InfalsusSolver);
})(typeof self !== 'undefined' ? self : this, function (Solver) {
  'use strict';

  const WTYPE = { disc: 0, over: 1, overlap: 2, all: 3, out: 4 };

  // 把 prepare() 的結果攤平成 { ints, floats }。順序必須和 wasm/src/lib.rs 的 run() 讀取的順序一致
  function marshal(S) {
    const I = [], F = [];
    const N = S.N, W = S.W;
    I.push(N, W, S.zones.length, S.M.length, S.PL.length, S.limit, S.allowOverlap ? 1 : 0, S.cap, S.maxPieces);
    for (let c = 0; c < 5; c++) I.push(S.maxSize[c]);
    I.push(S.WD, S.WO, S.WV, S.WA, S.WU, S.gw.disc, S.gw.over, S.gw.overlap, S.gw.all, S.gw.out);
    I.push(S.order.length); for (const z of S.order) I.push(z);
    // 島嶼：板子上彼此不相鄰的連通塊
    const islandOf = new Int32Array(N).fill(-1); let nIsl = 0;
    for (let i = 0; i < N; i++) {
      if (islandOf[i] >= 0) continue;
      const stk = [i]; islandOf[i] = nIsl;
      while (stk.length) {
        const c = stk.pop();
        for (let j = 0; j < N; j++) if (islandOf[j] < 0 && (S.nbCell[c][j >> 5] & (1 << (j & 31)))) { islandOf[j] = nIsl; stk.push(j); }
      }
      nIsl++;
    }
    I.push(nIsl); for (let i = 0; i < N; i++) I.push(islandOf[i]);
    for (let i = 0; i < N; i++) for (let w = 0; w < W; w++) I.push(S.nbCell[i][w]);
    I.push(S.mustIdx.length); for (const z of S.mustIdx) I.push(z);
    // 浮點數：懲罰倍率表、基礎攻防門檻
    F.push(S.cap); for (let p = 0; p < S.cap; p++) F.push(S.multArr[p]);
    F.push(S.minA, S.minD);
    for (const z of S.zones) {
      I.push(z.color, z.must ? 1 : 0, z.waive, WTYPE[z.wtype] || 0, z.cells.length); for (const c of z.cells) I.push(c);
      for (let w = 0; w < W; w++) I.push(z.mask[w]);
      F.push(z.atk, z.def, z.u);
    }
    for (const m of S.M) { I.push(m.effs.length); for (const e of m.effs) F.push(e); }
    for (const p of S.PL) {
      I.push(p.s, p.color, p.out ? 1 : 0, p.cells.length); for (const c of p.cells) I.push(c);
      for (let w = 0; w < W; w++) I.push(p.mask[w]);
      for (let w = 0; w < W; w++) I.push(p.nb[w]);
    }
    for (let c = 0; c < N; c++) for (let col = 0; col < 5; col++) { const l = S.coverBy[c][col]; I.push(l.length); for (const pid of l) I.push(pid); }
    for (const l of S.byStack) { I.push(l.length); for (const pid of l) I.push(pid); }
    // 「區域組合」搜尋的計畫（Solver.buildPlan）：區域之間的牽連關係、每個擺放會擋到哪些異色區域、各色最高效能的前 k 顆總和、依上界排序的區域組合。
    // 塊與鋪法輪廓由 Rust 端用到時自己算（和 JS 版同一套算法）
    const plan = Solver.buildPlan(S), nz = S.order.length;
    I.push(plan.ok ? 1 : 0);
    if (plan.ok) {
      for (let i = 0; i < nz; i++) I.push(plan.spMask[i]);
      for (let i = 0; i < nz; i++) I.push(plan.zIsl[i]);
      I.push(plan.islOk ? 1 : 0);
      for (let pid = 0; pid < S.PL.length; pid++) I.push(plan.blk[pid]);
      I.push(plan.masks.length); for (let i = 0; i < plan.masks.length; i++) I.push(plan.masks[i]);
      for (let c = 0; c < 5; c++) for (let k = 0; k <= S.maxPieces; k++) F.push(plan.ctop[c][k]);
      for (let i = 0; i < plan.rbs.length; i++) F.push(plan.rbs[i]);
    }
    return { ints: Int32Array.from(I), floats: Float64Array.from(F) };
  }

  function makeEngine(instanceRef, ctxRef) {
    return function engine(S, opts, t0) {
      const ex = instanceRef.exports;
      // 不適合交給 WASM 的情形（輸出緩衝區放不下）→ 用 JS 版
      if (S.maxPieces + 2 > ex.max_out()) return Solver.searchJS(S, opts, t0);
      // JS 版 solve() 一開始的判斷：這些情形不需要搜尋
      if (!(S.order.length && S.M.length && !S.mustMissing.length && !S.baseUnreach)) {
        return { best: null, bestVal: 0, nodes: 0, stop: false, stats: { leaves: 0, tiles: 0, extrasCalls: 0, extrasCands: 0, pruneZone: 0, pruneTile: 0 } };
      }
      let pI = 0, pF = 0, bytesI = 0, bytesF = 0;
      try {
        const { ints, floats } = marshal(S);
        bytesI = ints.byteLength; bytesF = floats.byteLength;
        pI = ex.alloc(bytesI); pF = ex.alloc(bytesF);
        // alloc 之後記憶體可能長大，要在最後才建立 view
        new Int32Array(ex.memory.buffer, pI, ints.length).set(ints);
        new Float64Array(ex.memory.buffer, pF, floats.length).set(floats);
        ctxRef.cur = { S, opts };
        const flags = (opts.onProgress ? 1 : 0) | (opts.onImprove ? 2 : 0) | (opts.shouldStop ? 4 : 0) | (opts.legacy ? 8 : 0);
        const sp = opts.split && opts.split.m > 1 ? opts.split : { k: 0, m: 1 };
        const rc = ex.run(pI, ints.length, pF, floats.length, opts.timeLimitMs || 60000, flags, sp.k | 0, sp.m | 0);
        if (rc !== 0) throw new Error('wasm run rc=' + rc);
        const r = readOut(ex, 0);
        ctxRef.cur = null;
        return r;
      } catch (e) {
        ctxRef.cur = null;
        // 例外之後 WASM 實例的狀態不可靠，通知呼叫端重建，並用 JS 版重算
        engineFailed(e);
        return Solver.searchJS(S, opts, t0);
      } finally {
        try { if (pI) ex.dealloc(pI, bytesI); if (pF) ex.dealloc(pF, bytesF); } catch (e2) { /* 實例壞了就算了 */ }
      }
    };
  }
  let failHook = null;
  function engineFailed(e) { if (failHook) failHook(e); }

  function readOut(ex, withPieces) {
    const mem = ex.memory.buffer;
    const info = new Float64Array(mem, ex.out_info_ptr(), 16);
    const nBest = info[3];
    let best = null;
    if (nBest >= 0) {
      const pids = new Int32Array(mem, ex.out_pid_ptr(), nBest), effs = new Float64Array(mem, ex.out_eff_ptr(), nBest);
      best = []; for (let i = 0; i < nBest; i++) best.push({ pid: pids[i], eff: effs[i] });
    }
    return {
      best, bestVal: info[0], nodes: info[1], stop: info[2] !== 0,
      stats: { leaves: info[4], tiles: info[5], extrasCalls: info[6], extrasCands: info[7], pruneZone: info[8], pruneTile: info[9] },
    };
  }

  function buildImports(ctxRef, memRef) {
    return {
      env: {
        now_ms: () => Date.now(),
        should_stop: () => { const c = ctxRef.cur; return c && c.opts.shouldStop && c.opts.shouldStop() ? 1 : 0; },
        on_progress: (nodes, ms, best) => { const c = ctxRef.cur; if (c && c.opts.onProgress) c.opts.onProgress({ nodes, ms, best }); },
        on_improve: (value, nodes, ms) => {
          const c = ctxRef.cur; if (!c || !c.opts.onImprove) return;
          const r = readOut(memRef.ex, 1);
          c.opts.onImprove({ value, pieces: Solver.describePieces(c.S, r.best || []), ms, nodes });
        },
      },
    };
  }

  // 同步載入（Node、測試用）。bytes：.wasm 的位元組（Uint8Array／Buffer）
  function loadSync(bytes, onFail) {
    const ctxRef = { cur: null }, memRef = { ex: null };
    const instance = new WebAssembly.Instance(new WebAssembly.Module(bytes), buildImports(ctxRef, memRef));
    memRef.ex = instance.exports;
    const engine = makeEngine({ exports: instance.exports }, ctxRef);
    failHook = onFail || null;
    return engine;
  }
  // 非同步載入（瀏覽器、Worker）
  function load(bytes, onFail) {
    const ctxRef = { cur: null }, memRef = { ex: null };
    return WebAssembly.instantiate(bytes, buildImports(ctxRef, memRef)).then((res) => {
      memRef.ex = res.instance.exports;
      failHook = onFail || null;
      return makeEngine({ exports: res.instance.exports }, ctxRef);
    });
  }

  return { loadSync, load, marshal };
});
