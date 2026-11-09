/*
 * In Falsus 製作卡牌 — 最佳擺放求解器
 *
 * 座標：六角格軸向座標 (q, r)，平頂六角形（欄位垂直排列）。
 * 顏色：0 紅、1 黃、2 綠、3 藍、4 紫。
 *
 * 計分公式（由遊戲實測，見 notes_cards_and_crafting.md）：
 *   基礎攻/防 = 「已填滿的色彩區域」的攻/防加總
 *   最終攻/防 = 基礎 × (平均粒子效能 / 100) × 懲罰倍率
 *   懲罰倍率  = 1 - (P / penaltyCap)^2   （P >= penaltyCap 時為 0，無法製作）
 *   P = 過載 + 超界 + 重疊 + 乖離
 *     過載 = max(0, 使用粒子數 - 粒子數上限)
 *     重疊 = 被多顆粒子覆蓋的格子數
 *     乖離 = 互不相連的粒子群數 - 1
 *   區域填滿 = 區域內每一格都被「同色」粒子覆蓋
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.InfalsusSolver = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const NEIGH = [[1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1]];
  const MUST_EPS = 1e-6; // 必觸發區域的最小價值（比任何實際的攻防數值都小）
  const key = (q, r) => q + ',' + r;
  const rot60 = (c) => [-c[1], c[0] + c[1]];

  function pop32(x) {
    x = x - ((x >>> 1) & 0x55555555);
    x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
    return Math.imul((x + (x >>> 4)) & 0x0f0f0f0f, 0x01010101) >>> 24;
  }

  function normalize(cells) {
    let mq = Infinity, mr = Infinity;
    for (const c of cells) { if (c[0] < mq) mq = c[0]; if (c[1] < mr) mr = c[1]; }
    const out = cells.map((c) => [c[0] - mq, c[1] - mr]);
    out.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    return out;
  }
  const shapeKey = (cells) => cells.map((c) => c[0] + ',' + c[1]).join(';');

  function orientations(cells, rotation) {
    let cur = normalize(cells);
    const seen = new Map();
    const n = rotation ? 6 : 1;
    for (let i = 0; i < n; i++) {
      const k = shapeKey(cur);
      if (!seen.has(k)) seen.set(k, cur);
      cur = normalize(cur.map(rot60));
    }
    return [...seen.values()];
  }

  function expandEffs(effs) {
    const out = [];
    for (const e of effs || []) {
      if (typeof e === 'number') out.push(e);
      else if (e && typeof e.v === 'number') for (let i = 0; i < (e.n || 1); i++) out.push(e.v);
    }
    return out.filter((x) => x > 0);
  }

  /* ------------------------------------------------------------------ */
  function prepare(prob) {
    const st = Object.assign(
      { limit: 6, rotation: true, allowOverlap: false, penaltyCap: 3, wAtk: 1, wDef: 1 },
      prob.settings || {}
    );
    // 懲罰倍率：預設用實測公式 1-(P/cap)^2；也可傳 penaltyTable（倍率陣列，索引 = 懲罰次數 P，0~1）
    let cap, multArr;
    if (Array.isArray(st.penaltyTable) && st.penaltyTable.length) {
      multArr = st.penaltyTable.slice();
      cap = multArr.findIndex((m) => !(m > 0));
      if (cap < 0) cap = multArr.length;
    } else {
      cap = st.penaltyCap; multArr = [];
      for (let P = 0; P < cap; P++) multArr.push(1 - (P / cap) * (P / cap));
    }
    const multOf = (P) => (P >= cap ? 0 : multArr[P]);
    const cells = prob.cells;
    const N = cells.length;
    const idx = new Map();
    cells.forEach((c, i) => idx.set(key(c[0], c[1]), i));
    const W = Math.max(1, (N + 31) >> 5);
    const mk = () => new Int32Array(W);
    const setBit = (m, i) => { m[i >> 5] |= 1 << (i & 31); };
    const nbCell = cells.map((c) => {
      const m = mk();
      for (const d of NEIGH) { const j = idx.get(key(c[0] + d[0], c[1] + d[1])); if (j !== undefined) setBit(m, j); }
      return m;
    });
    const expand = (m) => {
      const out = mk();
      for (let i = 0; i < N; i++) if (m[i >> 5] & (1 << (i & 31))) for (let w = 0; w < W; w++) out[w] |= nbCell[i][w];
      return out;
    };
    // 區域特殊效果「免除懲罰」：區域填滿後，免除某「一種」懲罰的 waive 點（wtype：disc 乖離／over 過載／overlap 重疊）。
    // 各種類各自扣到 0 為止，不會互相抵銷。
    // WD／WO／WV = 各種類最多可能免除幾點（只算有同色粒子、有機會填滿的區域），用來放寬粒子數上限與剪枝上界
    const colorsAvail = new Set();
    for (const s of prob.stacks || []) if (s.cells && s.cells.length && expandEffs(s.effs).length) colorsAvail.add(s.color);
    const waiveOf = (z) => Math.max(0, Math.floor(+z.waive || 0));
    const wtypeOf = (z) => (z.wtype === 'over' || z.wtype === 'overlap' ? z.wtype : 'disc');
    let WD = 0, WO = 0, WV = 0;
    for (const z of prob.zones || []) {
      if (!colorsAvail.has(z.color)) continue;
      const w = waiveOf(z), t = wtypeOf(z);
      if (t === 'over') WO += w; else if (t === 'overlap') WV += w; else WD += w;
    }
    // 只有「過載」的免除會讓粒子數上限變大（n − limit − 免除 < 懲罰上限）
    const maxPieces = st.maxPieces || st.limit + Math.max(0, cap - 1) + WO;

    const zones = (prob.zones || []).map((z) => {
      const m = mk(); const ci = [];
      for (const c of z.cells) {
        const i = idx.get(key(c[0], c[1]));
        if (i === undefined) throw new Error('區域格子不在板子上: ' + key(c[0], c[1]));
        ci.push(i); setBit(m, i);
      }
      // must：一定要填滿的區域（例如要拿它的特殊效果）。價值為 0 時給一個極小的價值，讓搜尋仍會去填它
      const must = !!z.must;
      const u0 = st.wAtk * (z.atk || 0) + st.wDef * (z.def || 0);
      return {
        color: z.color, cells: ci, mask: m, size: ci.length, atk: z.atk || 0, def: z.def || 0,
        u: must ? Math.max(u0, MUST_EPS) : u0, must, waive: waiveOf(z), wtype: wtypeOf(z), name: z.name || '',
      };
    });
    const mustIdx = []; zones.forEach((z, i) => { if (z.must) mustIdx.push(i); });

    // 合併「同色且同形（旋轉後相同）」的粒子堆疊
    const mergedMap = new Map(); const M = [];
    for (const s of prob.stacks || []) {
      const effs = expandEffs(s.effs);
      if (!effs.length || !s.cells || !s.cells.length) continue;
      const ors = orientations(s.cells, st.rotation);
      const canon = ors.map(shapeKey).sort()[0];
      const k = s.color + '|' + canon;
      let m = mergedMap.get(k);
      if (!m) { m = { color: s.color, orients: ors, effs: [], names: [], size: s.cells.length }; mergedMap.set(k, m); M.push(m); }
      m.effs.push(...effs);
      if (s.name) m.names.push(s.name);
    }
    for (const m of M) { m.effs.sort((a, b) => b - a); if (m.effs.length > maxPieces) m.effs.length = maxPieces; }

    // 產生所有合法擺放（所有格子都在板子上）
    const PL = []; const byStack = M.map(() => []);
    for (let s = 0; s < M.length; s++) {
      for (const o of M[s].orients) {
        const q0 = o[0][0], r0 = o[0][1];
        for (let bi = 0; bi < N; bi++) {
          const bq = cells[bi][0], br = cells[bi][1];
          const ci = []; let ok = true;
          for (const c of o) {
            const j = idx.get(key(bq + c[0] - q0, br + c[1] - r0));
            if (j === undefined) { ok = false; break; }
            ci.push(j);
          }
          if (!ok) continue;
          const mask = mk(), nb = mk();
          for (const j of ci) { setBit(mask, j); for (let w = 0; w < W; w++) nb[w] |= nbCell[j][w]; }
          for (let w = 0; w < W; w++) nb[w] &= ~mask[w];
          const pl = { s, color: M[s].color, size: ci.length, cells: ci, mask, nb, lv: null };
          byStack[s].push(PL.length);
          PL.push(pl);
        }
      }
    }
    // 距離 d 以內（不含自身）的鄰近格遮罩，用於判斷「橋接」可行性
    const nbOf = (p, d) => {
      if (!p.lv) p.lv = [null, p.nb];
      while (p.lv.length <= d) {
        const prev = p.lv[p.lv.length - 1];
        const e = expand(prev);
        for (let w = 0; w < W; w++) e[w] = (e[w] | prev[w]) & ~p.mask[w];
        p.lv.push(e);
      }
      return p.lv[d];
    };

    const coverBy = cells.map(() => [[], [], [], [], []]);
    PL.forEach((p, pid) => { for (const c of p.cells) coverBy[c][p.color].push(pid); });
    // 效能高的先試：好解會很快被找到，之後大部分分支能被上界剪掉（只影響速度，不影響正確性）
    for (const row of coverBy) for (const lst of row) lst.sort((a, b) => M[PL[b].s].effs[0] - M[PL[a].s].effs[0] || PL[b].size - PL[a].size);

    const maxSize = [1, 1, 1, 1, 1]; const hasColor = [false, false, false, false, false];
    for (const m of M) { hasColor[m.color] = true; if (m.size > maxSize[m.color]) maxSize[m.color] = m.size; }
    let effMax = 0; for (const m of M) if (m.effs[0] > effMax) effMax = m.effs[0];

    // 搜尋順序：必觸發的區域先處理（不可略過，放不下的分支很快就會被剪掉），其餘依價值由大到小
    const order = [];
    zones.forEach((z, i) => { if ((z.u > 0 || z.must || z.waive > 0) && hasColor[z.color]) order.push(i); });
    order.sort((a, b) => (zones[b].must - zones[a].must) || zones[b].u - zones[a].u || zones[a].size - zones[b].size);
    // 必觸發的區域如果完全沒有同色粒子，一定無解
    const mustMissing = mustIdx.filter((i) => !hasColor[zones[i].color]);

    return {
      st, cap, limit: st.limit, allowOverlap: !!st.allowOverlap, maxPieces, cells, N, W, idx, nbCell,
      zones, M, PL, byStack, coverBy, maxSize, effMax, order, nbOf, mk, multOf, multArr, mustIdx, mustMissing, WD, WO, WV,
    };
  }

  /* ------------------------------------------------------------------ */
  // 獨立計分（用於驗證與最終報告）。pieces: [{color, cells:[板子格索引], eff}]
  function scoreExplicit(S, pieces) {
    const n = pieces.length;
    const res = {
      n, atk: 0, def: 0, completeZones: [], avg: 0, over: 0, overlap: 0, disc: 0, P: 0, waive: 0, waived: 0, Peff: 0, mult: 0,
      finalAtk: 0, finalDef: 0, value: 0, valid: false, forcedMissing: S.mustIdx.slice(),
    };
    if (n === 0) return res;
    const cnt = new Int32Array(S.N);
    const colorCover = [0, 1, 2, 3, 4].map(() => new Uint8Array(S.N));
    for (const p of pieces) for (const c of p.cells) { cnt[c]++; colorCover[p.color][c] = 1; }
    for (let i = 0; i < S.N; i++) if (cnt[i] >= 2) res.overlap++;
    S.zones.forEach((z, zi) => {
      if (z.cells.every((c) => colorCover[z.color][c])) { res.completeZones.push(zi); res.atk += z.atk; res.def += z.def; }
    });
    // 連通性：兩顆粒子共用或相鄰格子 → 相連
    const par = pieces.map((_, i) => i);
    const find = (x) => { while (par[x] !== x) { par[x] = par[par[x]]; x = par[x]; } return x; };
    let comps = n;
    const cellSets = pieces.map((p) => new Set(p.cells));
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
      let touch = false;
      outer: for (const a of pieces[i].cells) {
        if (cellSets[j].has(a)) { touch = true; break; }
        for (const d of NEIGH) {
          const nj = S.idx.get(key(S.cells[a][0] + d[0], S.cells[a][1] + d[1]));
          if (nj !== undefined && cellSets[j].has(nj)) { touch = true; break outer; }
        }
      }
      if (touch) { const ri = find(i), rj = find(j); if (ri !== rj) { par[ri] = rj; comps--; } }
    }
    res.disc = comps - 1;
    res.over = Math.max(0, n - S.limit);
    res.P = res.over + res.overlap + res.disc;
    // 已填滿的區域各自免除某一種懲罰 waive 點（每種最多免到 0）。P 是原始懲罰，Peff 才是用來查倍率的
    const wb = { disc: 0, over: 0, overlap: 0 };
    for (const zi of res.completeZones) wb[S.zones[zi].wtype] += S.zones[zi].waive;
    const raw = { disc: res.disc, over: res.over, overlap: res.overlap };
    res.waiveBy = wb; res.effBy = {};
    res.waive = wb.disc + wb.over + wb.overlap;
    res.waived = 0;
    for (const t of ['disc', 'over', 'overlap']) { res.effBy[t] = Math.max(0, raw[t] - wb[t]); res.waived += raw[t] - res.effBy[t]; }
    res.Peff = res.P - res.waived;
    res.mult = S.multOf(res.Peff);
    res.avg = pieces.reduce((a, p) => a + p.eff, 0) / n;
    res.finalAtk = res.atk * (res.avg / 100) * res.mult;
    res.finalDef = res.def * (res.avg / 100) * res.mult;
    res.value = S.st.wAtk * res.finalAtk + S.st.wDef * res.finalDef;
    // 必觸發的區域沒填滿 → 這個擺放不算數
    res.forcedMissing = S.mustIdx.filter((zi) => res.completeZones.indexOf(zi) < 0);
    if (res.forcedMissing.length) res.value = 0;
    res.valid = res.mult > 0 && res.forcedMissing.length === 0;
    return res;
  }

  // 給測試用：以座標直接計分
  function evaluatePlacement(prob, pieces) {
    const S = prepare(prob);
    return scoreExplicit(S, pieces.map((p) => ({
      color: p.color, eff: p.eff,
      cells: p.cells.map((c) => { const i = S.idx.get(key(c[0], c[1])); if (i === undefined) throw new Error('格子不在板子上'); return i; }),
    })));
  }

  /* ------------------------------------------------------------------ */
  function solve(prob, opts) {
    opts = opts || {};
    const S = prepare(prob);
    const { W, zones, M, PL, coverBy, byStack, cap, limit, allowOverlap, maxPieces, effMax, order, maxSize } = S;
    const timeLimit = opts.timeLimitMs || 60000;
    const t0 = Date.now();
    let nodes = 0, stop = false, bestVal = 0, best = null, lastProg = t0;
    const stats = { leaves: 0, tiles: 0, extrasCalls: 0, extrasCands: 0, pruneZone: 0, pruneTile: 0 };

    const occ = new Int32Array(W), cov = new Int32Array(5 * W);
    const snapOcc = [], snapCov = [];
    for (let i = 0; i <= maxPieces + 1; i++) { snapOcc.push(new Int32Array(W)); snapCov.push(new Int32Array(5 * W)); }
    const pcs = new Int32Array(maxPieces + 2), effOf = new Float64Array(maxPieces + 2), ovArr = new Int32Array(maxPieces + 2);
    const used = new Int32Array(M.length);
    let n = 0, sumEff = 0, ov = 0;

    // 島嶼：板子上彼此不相鄰的連通塊。不同島嶼的粒子不可能相連（乖離懲罰的下界）
    const islandOf = new Int32Array(S.N).fill(-1);
    let nIsl = 0;
    for (let i = 0; i < S.N; i++) {
      if (islandOf[i] >= 0) continue;
      const stk = [i]; islandOf[i] = nIsl;
      while (stk.length) {
        const c = stk.pop();
        for (let j = 0; j < S.N; j++) if (islandOf[j] < 0 && (S.nbCell[c][j >> 5] & (1 << (j & 31)))) { islandOf[j] = nIsl; stk.push(j); }
      }
      nIsl++;
    }
    const islCnt = new Int32Array(nIsl); let activeIsl = 0;

    // 剩餘庫存中效能最高的 K 顆（用於平均效能上界）
    const gE = [], gS = [], gJ = [];
    { const tmp = []; M.forEach((m, si) => m.effs.forEach((e, j) => tmp.push([e, si, j]))); tmp.sort((a, b) => b[0] - a[0] || a[2] - b[2]); for (const t of tmp) { gE.push(t[0]); gS.push(t[1]); gJ.push(t[2]); } }
    // 去重用的 Zobrist 雜湊（52 位元）
    let zs = 987654321; const zr = () => { zs = (Math.imul(zs, 1103515245) + 12345) & 0x7fffffff; return zs; };
    const z1 = new Float64Array(PL.length), z2 = new Float64Array(PL.length);
    for (let i = 0; i < PL.length; i++) { z1[i] = ((zr() << 11) ^ zr()) & 0x3ffffff; z2[i] = ((zr() << 11) ^ zr()) & 0x3ffffff; }

    const multOf = S.multOf;
    // 免除懲罰。lbEff(過載, 重疊, 乖離)：已知各項原始懲罰「至少」是這些時，最終有效懲罰的下界
    // （各種類最多被免除 WO／WV／WD 點）；剪枝用。evalCurrent 則用目前已填滿的區域「實際」的免除點數。
    const WD = S.WD, WO = S.WO, WV = S.WV, hasW = WD + WO + WV > 0;
    const lbEff = (o, v, d) => Math.max(0, o - WO) + Math.max(0, v - WV) + Math.max(0, d - WD);
    const waiveZ = zones.filter((z) => z.waive > 0);
    const overlapOf = (p) => { let c = 0; for (let w = 0; w < W; w++) { const x = occ[w] & p.mask[w]; if (x) c += pop32(x); } return c; };
    const touches = (p) => { for (let w = 0; w < W; w++) if (occ[w] & p.nb[w]) return true; return false; };

    function apply(pid, ovl) {
      const p = PL[pid];
      snapOcc[n].set(occ); snapCov[n].set(cov);
      const e = M[p.s].effs[used[p.s]];
      pcs[n] = pid; effOf[n] = e; ovArr[n] = ovl;
      used[p.s]++; sumEff += e; ov += ovl; n++;
      if (islCnt[islandOf[p.cells[0]]]++ === 0) activeIsl++;
      const base = p.color * W;
      for (let w = 0; w < W; w++) { occ[w] |= p.mask[w]; cov[base + w] |= p.mask[w]; }
    }
    function undo() {
      n--; const p = PL[pcs[n]];
      used[p.s]--; sumEff -= effOf[n]; ov -= ovArr[n];
      if (--islCnt[islandOf[p.cells[0]]] === 0) activeIsl--;
      occ.set(snapOcc[n]); cov.set(snapCov[n]);
    }

    const zoneUncovered = (z) => { let c = 0; const b = z.color * W; for (let w = 0; w < W; w++) c += pop32(z.mask[w] & ~cov[b + w]); return c; };
    const zoneDone = (z) => { const b = z.color * W; for (let w = 0; w < W; w++) if (z.mask[w] & ~cov[b + w]) return false; return true; };
    const currentU = () => { let u = 0; for (let i = 0; i < zones.length; i++) { const z = zones[i]; if (z.u > 0 && zoneDone(z)) u += z.u; } return u; };

    const par = new Int32Array(maxPieces + 2);
    const compOf = new Int32Array(maxPieces + 2);
    function components() {
      for (let i = 0; i < n; i++) par[i] = i;
      const find = (x) => { while (par[x] !== x) { par[x] = par[par[x]]; x = par[x]; } return x; };
      let comps = n;
      for (let i = 0; i < n; i++) {
        const a = PL[pcs[i]];
        for (let j = i + 1; j < n; j++) {
          const b = PL[pcs[j]];
          let t = false;
          for (let w = 0; w < W; w++) if ((a.nb[w] & b.mask[w]) | (a.mask[w] & b.mask[w])) { t = true; break; }
          if (t) { const ra = find(i), rb = find(j); if (ra !== rb) { par[ra] = rb; comps--; } }
        }
      }
      for (let i = 0; i < n; i++) compOf[i] = find(i);
      return comps;
    }

    function snapshot() { const a = []; for (let i = 0; i < n; i++) a.push({ pid: pcs[i], eff: effOf[i] }); return a; }
    function describe(list) {
      return list.map((x) => {
        const p = PL[x.pid];
        return { stack: p.s, names: M[p.s].names, color: p.color, size: p.size, eff: x.eff, cells: p.cells.slice(), qr: p.cells.map((c) => S.cells[c]) };
      });
    }

    function evalCurrent() {
      if (n === 0) return 0;
      for (const zi of S.mustIdx) if (!zoneDone(zones[zi])) return 0;
      const U = currentU();
      if (U <= 0) return 0;
      let wd = 0, wo = 0, wv = 0;
      if (hasW) for (const z of waiveZ) if (zoneDone(z)) { if (z.wtype === 'over') wo += z.waive; else if (z.wtype === 'overlap') wv += z.waive; else wd += z.waive; }
      const P = Math.max(0, Math.max(0, n - limit) - wo) + Math.max(0, ov - wv) + Math.max(0, components() - 1 - wd);
      const v = (U * (sumEff / n) / 100) * multOf(P);
      if (v > bestVal + 1e-9 || (v > 0 && Math.abs(v - bestVal) <= 1e-9 && best && n < best.length)) {
        const improved = v > bestVal + 1e-9;
        bestVal = v; best = snapshot();
        if (improved && opts.onImprove) opts.onImprove({ value: v, pieces: describe(best), ms: Date.now() - t0, nodes });
      }
      return v;
    }

    // 再多放 K 顆（取剩餘庫存中最好的）時，平均效能的上界。skipS/skipJ：略過某一顆（已被假設放下）
    function avgUBk(nNow, sNow, K, skipS, skipJ) {
      let b = nNow ? sNow / nNow : 0;
      let sum = sNow, cnt = nNow, taken = 0;
      for (let i = 0; i < gE.length && taken < K; i++) {
        const si = gS[i], j = gJ[i];
        if (j < used[si] || (si === skipS && j === skipJ)) continue;
        sum += gE[i]; cnt++; taken++;
        const a = sum / cnt; if (a > b) b = a;
      }
      return b;
    }
    const pndNow = () => lbEff(Math.max(0, n - limit), ov, Math.max(0, activeIsl - 1));
    const ubValue = (Uopt, nNow, sNow, Pnd) => Uopt * avgUBk(nNow, sNow, maxPieces - nNow, -1, -1) / 100 * multOf(Pnd);

    // 剩餘區域的價值上界（背包）。同色區域「合併」計算所需粒子數：
    // 一顆粒子可以同時蓋住相鄰的兩個同色區域，所以不能各自進位後再加總。
    // forced：必須選入的區域（正在鋪的那個），回傳 -Infinity 表示放不下。
    const colTmp = [[], [], [], [], []];
    const dpA = new Float64Array(maxPieces + 2), dpB = new Float64Array(maxPieces + 2), tb = new Float64Array(maxPieces + 2);
    function knap(zi, budget, forced) {
      if (budget < 0) return -Infinity;
      for (let c = 0; c < 5; c++) colTmp[c].length = 0;
      for (let k = zi; k < order.length; k++) {
        const zid = order[k], z = zones[zid];
        const unc = zoneUncovered(z);
        if (unc === 0) continue;
        colTmp[z.color].push(z.u, unc, (zid === forced || z.must) ? 1 : 0);
      }
      dpA.fill(0, 0, budget + 1);
      for (let c = 0; c < 5; c++) {
        const L = colTmp[c]; const m = L.length / 3;
        if (!m) continue;
        let fmask = 0; for (let i = 0; i < m; i++) if (L[i * 3 + 2]) fmask |= 1 << i;
        tb.fill(-Infinity, 0, budget + 1);
        for (let mask = 0; mask < (1 << m); mask++) {
          if ((mask & fmask) !== fmask) continue;
          let su = 0, sc = 0;
          for (let i = 0; i < m; i++) if (mask & (1 << i)) { su += L[i * 3]; sc += L[i * 3 + 1]; }
          const kk = sc ? Math.ceil(sc / maxSize[c]) : 0;
          if (kk <= budget && su > tb[kk]) tb[kk] = su;
        }
        for (let b = 0; b <= budget; b++) {
          let bestv = -Infinity;
          for (let kk = 0; kk <= b; kk++) { if (tb[kk] === -Infinity || dpA[b - kk] === -Infinity) continue; const v = dpA[b - kk] + tb[kk]; if (v > bestv) bestv = v; }
          dpB[b] = bestv;
        }
        for (let b = 0; b <= budget; b++) dpA[b] = dpB[b];
      }
      return dpA[budget];
    }

    function tick() {
      if ((++nodes & 1023) === 0) {
        const t = Date.now();
        if (t - t0 > timeLimit) stop = true;
        if (opts.shouldStop && opts.shouldStop()) stop = true;
        if (opts.onProgress && t - lastProg > 250) { lastProg = t; opts.onProgress({ nodes, ms: t - t0, best: bestVal }); }
      }
    }

    function dfsZone(zi) {
      if (stop) return;
      tick();
      if (zi === order.length) { if (n > 0) { stats.leaves++; evalCurrent(); extrasSearch(); } return; }
      const z = zones[order[zi]];
      const kn = knap(zi, maxPieces - n, -1);
      // -Infinity：剩下必觸發的區域在粒子數上限內放不下
      if (kn === -Infinity) { stats.pruneZone++; return; }
      const ub = ubValue(currentU() + kn, n, sumEff, pndNow());
      if (ub <= bestVal + 1e-9) { stats.pruneZone++; return; }
      if (zoneDone(z)) { dfsZone(zi + 1); return; }
      tile(zi);
      if (!z.must) dfsZone(zi + 1); // 必觸發的區域不能略過
    }

    function tile(zi) {
      if (stop) return;
      const z = zones[order[zi]];
      let c = -1;
      for (const ci of z.cells) { if (!(cov[z.color * W + (ci >> 5)] & (1 << (ci & 31)))) { c = ci; break; } }
      if (c < 0) { dfsZone(zi + 1); return; }
      if (n >= maxPieces) return;
      const need = Math.ceil(zoneUncovered(z) / maxSize[z.color]);
      if (need > maxPieces - n) return;
      const Ubase = currentU() + knap(zi, maxPieces - n, order[zi]);
      if (!(Ubase > 0) || ubValue(Ubase, n, sumEff, pndNow()) <= bestVal + 1e-9) { stats.pruneTile++; return; }
      stats.tiles++;
      const lst = coverBy[c][z.color];
      const restK = maxPieces - n - 1;
      for (let k = 0; k < lst.length; k++) {
        const pid = lst[k], p = PL[pid];
        const si = p.s;
        if (used[si] >= M[si].effs.length) continue;
        const ovl = overlapOf(p);
        if (ovl && !allowOverlap) continue;
        const pc = lbEff(Math.max(0, n + 1 - limit), ov + ovl, Math.max(0, activeIsl - 1));
        if (pc >= cap) continue;
        // 前置過濾：放這顆之後，就算其餘都補到最好，也贏不了目前最佳 → 不展開
        if (Ubase * avgUBk(n + 1, sumEff + M[si].effs[used[si]], restK, si, used[si]) / 100 * multOf(pc) <= bestVal + 1e-9) continue;
        tick(); if (stop) return;
        apply(pid, ovl);
        tile(zi);
        undo();
      }
    }

    // 額外粒子：用來拉高平均效能、或把分離的粒子群接起來
    function extrasSearch() {
      const K = maxPieces - n;
      if (K <= 0) return;
      const ub = ubValue(currentU(), n, sumEff, pndNow());
      if (ub <= bestVal + 1e-9) return;
      stats.extrasCalls++;
      extrasRec(K, new Set(), currentU(), 0, 0);
    }
    function extrasRec(K, visited, U, h1, h2) {
      if (stop) return;
      const comps = components();
      const avg = sumEff / n;
      const compMask = [];
      if (comps > 1) {
        const ids = new Map();
        for (let i = 0; i < n; i++) {
          if (!ids.has(compOf[i])) { ids.set(compOf[i], compMask.length); compMask.push(new Int32Array(W)); }
          const m = compMask[ids.get(compOf[i])], pm = PL[pcs[i]].mask;
          for (let w = 0; w < W; w++) m[w] |= pm[w];
        }
      }
      const ord = [];
      for (let s = 0; s < M.length; s++) if (used[s] < M[s].effs.length) ord.push(s);
      ord.sort((a, b) => M[b].effs[used[b]] - M[a].effs[used[a]]);
      const pAfter = lbEff(Math.max(0, n + 1 - limit), ov, Math.max(0, activeIsl - 1));
      for (const s of ord) {
        const e = M[s].effs[used[s]];
        // 前置過濾：就算之後再補最好的粒子，也贏不過目前最佳 → 這種粒子不用試
        if (U * avgUBk(n + 1, sumEff + e, K - 1, s, used[s]) / 100 * multOf(pAfter) <= bestVal + 1e-9) continue;
        let plainDone = false, farDone = false;
        for (const pid of byStack[s]) {
          const p = PL[pid];
          let hit = false;
          for (let w = 0; w < W; w++) if (occ[w] & p.mask[w]) { hit = true; break; }
          if (hit) continue;
          let allowed = false;
          if (touches(p)) {
            if (comps === 1) {
              if (e > avg && !plainDone) { allowed = true; plainDone = true; }
            } else {
              // 直接接合兩群 → 一定考慮；若還有 K-1 顆可補，距離夠近的鏈式橋接也考慮
              let touched = 0, near = 0;
              const reach = S.nbOf(p, Math.min(K, 5));
              for (const cm of compMask) {
                let t = false, t2 = false;
                for (let w = 0; w < W; w++) { if (cm[w] & p.nb[w]) t = true; if (cm[w] & reach[w]) t2 = true; }
                if (t) touched++; if (t2) near++;
              }
              if (touched >= 2) allowed = true;
              else if (K >= 2 && near >= 2) allowed = true;
              else if (e > avg && !plainDone) { allowed = true; plainDone = true; }
            }
          } else if (!farDone) { allowed = true; farDone = true; }
          if (!allowed) continue;
          tick(); if (stop) return;
          stats.extrasCands++;
          const nh1 = h1 ^ z1[pid], nh2 = h2 ^ z2[pid];
          const sig = nh1 * 67108864 + nh2;
          if (!visited.has(sig)) {
            visited.add(sig);
            apply(pid, 0);
            evalCurrent();
            if (K > 1 && ubValue(U, n, sumEff, pndNow()) > bestVal + 1e-9) extrasRec(K - 1, visited, U, nh1, nh2);
            undo();
          }
        }
      }
    }

    if (order.length && M.length && !S.mustMissing.length) dfsZone(0);

    const pieces = best ? describe(best) : [];
    const score = best ? scoreExplicit(S, pieces.map((p) => ({ color: p.color, cells: p.cells, eff: p.eff }))) : null;
    // 有指定必觸發區域，卻找不到任何擺放：缺同色粒子，或（搜尋跑完時）在粒子數與懲罰限制內放不下
    const forced = { zones: S.mustIdx.slice(), missing: S.mustMissing.slice() };
    const infeasible = S.mustIdx.length > 0 && !best && (S.mustMissing.length > 0 || !stop);
    return {
      // value 取獨立計分的結果（搜尋內部為了讓「必觸發」的 0 價值區域仍會被填，加了極小的 MUST_EPS，不該出現在回報的數字裡）
      stats, value: score ? score.value : 0, internal: bestVal, pieces, score, nodes, ms: Date.now() - t0, finished: !stop, forced, infeasible,
      S: { zones: S.zones.map((z) => ({ color: z.color, atk: z.atk, def: z.def, size: z.size, must: z.must, waive: z.waive, wtype: z.wtype })) },
    };
  }

  // 最佳化目標 → 攻擊／防禦權重。
  // 特化 = 先求該項最大，該項相同時才比另一項（用極小的權重當次要條件）。
  function goalWeights(goal, wAtk, wDef) {
    const EPS = 0.001;
    if (goal === 'atk') return { wAtk: 1, wDef: EPS };
    if (goal === 'def') return { wAtk: EPS, wDef: 1 };
    if (goal === 'custom') return { wAtk: wAtk, wDef: wDef };
    return { wAtk: 1, wDef: 1 };
  }
  // 只保留被勾選顏色的粒子堆疊。useColors: 長度 5 的 boolean 陣列（紅黃綠藍紫）；缺省 = 全部使用
  function filterColors(stacks, useColors) {
    if (!Array.isArray(useColors)) return stacks;
    return stacks.filter((s) => useColors[s.color] !== false);
  }

  return { solve, prepare, scoreExplicit, evaluatePlacement, orientations, normalize, rot60, NEIGH, goalWeights, filterColors };
});
