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
    // 任務條件「總懲罰最多 N 點」：有效懲罰超過 N 就當作無法製作（等於把懲罰上限降到 N+1）。未設定（空白、負數）＝不限制
    const maxPen = st.maxPenalty === '' || st.maxPenalty === null || st.maxPenalty === undefined || !(st.maxPenalty >= 0) ? Infinity : Math.floor(st.maxPenalty);
    if (maxPen + 1 < cap) { cap = maxPen + 1; multArr = multArr.slice(0, cap); }
    const multOf = (P) => (P >= cap ? 0 : multArr[P]);
    // 板子上的格子（索引 0..NB-1）。允許超界擺放時，後面再接「板外的外圈格子」（索引 NB..N-1），
    // 讓粒子可以部分放到板子外面（每顆超界的粒子 +1「粒子超界」懲罰；至少要有一格在板子上，否則是「虛偽錯誤」不考慮）
    const boardCells = prob.cells;
    const NB = boardCells.length;
    let allowOutside = !!st.allowOutside;
    // 超界的粒子每顆 +1「超界」懲罰，只能被「超界免除」與「整體免除」吸收，其餘要靠可承受的有效懲罰（cap − 1）。
    // 三者加起來是 0（例：任務「總懲罰為 0」又沒有超界／整體免除）→ 任何超界擺放都不可能有效，整圈板外格子與超界擺放都不用考慮
    // （實測「無雙」開著允許超界：板外格子讓擺放從 2655 變 7190 種，30 秒跑不完 → 關掉 29 毫秒就證明最優，答案相同）。keepOutside 只給測試用
    if (allowOutside && !st.keepOutside) {
      const gwI = st.globalWaive || {}, n0 = (v) => Math.max(0, Math.floor(+v || 0));
      let tol = Math.max(0, cap - 1) + n0(gwI.out) + n0(gwI.all);
      for (const z of prob.zones || []) if (z.wtype === 'out' || z.wtype === 'all') tol += n0(z.waive);
      if (tol < 1) allowOutside = false;
    }
    const cells = boardCells.slice();
    if (allowOutside) {
      let R = 0;
      for (const s of prob.stacks || []) if (s.cells && s.cells.length && expandEffs(s.effs).length) R = Math.max(R, s.cells.length - 1);
      const seen = new Set(cells.map((c) => key(c[0], c[1])));
      let frontier = boardCells;
      for (let r = 0; r < R; r++) {
        const next = [];
        for (const c of frontier) for (const d of NEIGH) {
          const q = c[0] + d[0], rr = c[1] + d[1], k = key(q, rr);
          if (!seen.has(k)) { seen.add(k); const nc = [q, rr]; cells.push(nc); next.push(nc); }
        }
        frontier = next;
      }
    }
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
    // 區域特殊效果「免除懲罰」：區域填滿後免除 waive 點懲罰。wtype：disc 乖離／over 過載／overlap 重疊＝只免那一種，
    // out 超界（只在允許超界擺放時有意義）。各種類各自扣到 0 為止，不會互相抵銷；all 整體＝從「各種懲罰扣完之後的總和」再扣（不分種類）。
    // WD／WO／WV／WU／WA = 各種類最多可能免除幾點（只算有同色粒子、有機會填滿的區域），用來放寬粒子數上限與剪枝上界
    const colorsAvail = new Set();
    for (const s of prob.stacks || []) if (s.cells && s.cells.length && expandEffs(s.effs).length) colorsAvail.add(s.color);
    const waiveOf = (z) => Math.max(0, Math.floor(+z.waive || 0));
    const wtypeOf = (z) => (z.wtype === 'over' || z.wtype === 'overlap' || z.wtype === 'all' || z.wtype === 'out' ? z.wtype : 'disc');
    // 固定免除（settings.globalWaive：{ disc, over, overlap, all }）：角色技能／卡牌效果，不用填滿任何區域，一直生效
    const gwIn = st.globalWaive || {}, gwN = (v) => Math.max(0, Math.floor(+v || 0));
    const gw = { disc: gwN(gwIn.disc), over: gwN(gwIn.over), overlap: gwN(gwIn.overlap), all: gwN(gwIn.all), out: gwN(gwIn.out) };
    let WD = gw.disc, WO = gw.over, WV = gw.overlap, WA = gw.all, WU = gw.out;
    for (const z of prob.zones || []) {
      if (!colorsAvail.has(z.color)) continue;
      const w = waiveOf(z), t = wtypeOf(z);
      if (t === 'over') WO += w; else if (t === 'overlap') WV += w; else if (t === 'all') WA += w; else if (t === 'out') WU += w; else WD += w;
    }
    // 「過載」與「整體」的免除會讓粒子數上限變大（n − limit − 免除 < 懲罰上限）
    const maxPieces = st.maxPieces || st.limit + Math.max(0, cap - 1) + WO + WA;

    // 基礎攻防門檻（任務條件）：填滿的區域的攻／防加總（遊戲裡的「基礎攻擊力／基礎防禦力」）至少要達到的值。0 = 不限制。
    // 基礎值只看哪些區域填滿，和平均效能、懲罰倍率無關（懲罰過多無法製作的限制照舊）。
    const minA = Math.max(0, +st.minBaseAtk || 0), minD = Math.max(0, +st.minBaseDef || 0);

    const zones = (prob.zones || []).map((z) => {
      const m = mk(); const ci = [];
      for (const c of z.cells) {
        const i = idx.get(key(c[0], c[1]));
        if (i === undefined || i >= NB) throw new Error('區域格子不在板子上: ' + key(c[0], c[1]));
        ci.push(i); setBit(m, i);
      }
      // must：一定要填滿的區域（例如要拿它的特殊效果）。價值為 0 時給一個極小的價值，讓搜尋仍會去填它
      // need：對基礎攻防門檻有貢獻的區域；即使目標權重讓它的價值是 0，搜尋也要考慮去填它
      const must = !!z.must;
      const need = (minD > 0 && (z.def || 0) > 0) || (minA > 0 && (z.atk || 0) > 0);
      const u0 = st.wAtk * (z.atk || 0) + st.wDef * (z.def || 0);
      return {
        color: z.color, cells: ci, mask: m, size: ci.length, atk: z.atk || 0, def: z.def || 0,
        u: must || need ? Math.max(u0, MUST_EPS) : u0, must, waive: waiveOf(z), wtype: wtypeOf(z), name: z.name || '',
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

    // 產生所有合法擺放（至少一格在板子上；不允許超界時，所有格子都在板子上）
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
          let anyBoard = false, anyOut = false;
          for (const j of ci) { if (j < NB) anyBoard = true; else anyOut = true; }
          if (!anyBoard) continue; // 完全在板子外 → 「虛偽錯誤」，不考慮
          const mask = mk(), nb = mk();
          for (const j of ci) { setBit(mask, j); for (let w = 0; w < W; w++) nb[w] |= nbCell[j][w]; }
          for (let w = 0; w < W; w++) nb[w] &= ~mask[w];
          const pl = { s, color: M[s].color, size: ci.length, cells: ci, mask, nb, out: anyOut, lv: null };
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
    PL.forEach((p, pid) => { for (const c of p.cells) if (c < NB) coverBy[c][p.color].push(pid); });
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
    // 基礎攻防門檻的理論上限：所有「有同色粒子」的區域全部填滿時的攻／防加總；連這個都不到就一定無解
    let capA = 0, capD = 0;
    for (const z of zones) if (hasColor[z.color]) { capA += z.atk; capD += z.def; }
    const baseUnreach = capA < minA || capD < minD;

    return {
      st, cap, limit: st.limit, allowOverlap: !!st.allowOverlap, allowOutside, maxPieces, cells, NB, N, W, idx, nbCell,
      zones, M, PL, byStack, coverBy, maxSize, effMax, order, nbOf, mk, multOf, multArr, mustIdx, mustMissing, WD, WO, WV, WU, WA, gw,
      minA, minD, capA, capD, baseUnreach,
    };
  }

  /* ------------------------------------------------------------------ */
  // 獨立計分（用於驗證與最終報告）。pieces: [{color, cells:[板子格索引], eff}]
  function scoreExplicit(S, pieces) {
    const n = pieces.length;
    const res = {
      n, atk: 0, def: 0, completeZones: [], avg: 0, over: 0, overlap: 0, disc: 0, out: 0, P: 0, waive: 0, waived: 0, Peff: 0, mult: 0,
      finalAtk: 0, finalDef: 0, value: 0, valid: false, forcedMissing: S.mustIdx.slice(), baseOk: S.minA <= 0 && S.minD <= 0,
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
    for (const p of pieces) if (p.cells.some((c) => c >= S.NB)) res.out++; // 粒子超界：有任何一格在板子外的粒子，每顆 +1
    res.P = res.over + res.overlap + res.disc + res.out;
    // 已填滿的區域各自免除某一種懲罰 waive 點（每種最多免到 0）。P 是原始懲罰，Peff 才是用來查倍率的
    // 先各種類各自扣（最多扣到 0），再用「整體」的免除從剩下的總和裡扣
    const wb = { disc: S.gw.disc, over: S.gw.over, overlap: S.gw.overlap, out: S.gw.out, all: S.gw.all };
    for (const zi of res.completeZones) wb[S.zones[zi].wtype] += S.zones[zi].waive;
    const raw = { disc: res.disc, over: res.over, overlap: res.overlap, out: res.out };
    res.waiveBy = wb; res.effBy = {};
    res.waive = wb.disc + wb.over + wb.overlap + wb.out + wb.all;
    let typed = 0;
    for (const t of ['disc', 'over', 'overlap', 'out']) { res.effBy[t] = Math.max(0, raw[t] - wb[t]); typed += res.effBy[t]; }
    res.effAll = Math.max(0, typed - wb.all);
    res.Peff = res.effAll;
    res.waived = res.P - res.Peff;
    res.mult = S.multOf(res.Peff);
    res.avg = pieces.reduce((a, p) => a + p.eff, 0) / n;
    res.finalAtk = res.atk * (res.avg / 100) * res.mult;
    res.finalDef = res.def * (res.avg / 100) * res.mult;
    res.value = S.st.wAtk * res.finalAtk + S.st.wDef * res.finalDef;
    // 必觸發的區域沒填滿 → 這個擺放不算數
    res.forcedMissing = S.mustIdx.filter((zi) => res.completeZones.indexOf(zi) < 0);
    if (res.forcedMissing.length) res.value = 0;
    // 基礎攻防門檻沒達到 → 這個擺放不算數
    res.baseOk = res.atk >= S.minA && res.def >= S.minD;
    if (!res.baseOk) res.value = 0;
    res.valid = res.mult > 0 && res.forcedMissing.length === 0 && res.baseOk;
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
  // 搜尋結果（list：[{ pid, eff }]）轉成對外的粒子描述
  function describePieces(S, list) {
    return list.map((x) => {
      const p = S.PL[x.pid];
      return { stack: p.s, names: S.M[p.s].names, color: p.color, size: p.size, eff: x.eff, cells: p.cells.slice(), qr: p.cells.map((c) => S.cells[c]) };
    });
  }

  // 島嶼：板子上彼此不相鄰的連通塊。不同島嶼的粒子不可能相連（乖離懲罰的下界）。結果快取在 S 上
  function islands(S) {
    if (S.islandOf) return S;
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
    S.islandOf = islandOf; S.nIsl = nIsl;
    return S;
  }

  /*
   * 搜尋計畫（「區域組合」搜尋用；JS／WASM／原生三個引擎共用同一份，由 JS 算好再攤平給 Rust）。
   *
   * 想法：最後「填滿哪些區域」的組合 T 一旦固定，基礎值 U(T) 就固定，剩下只要讓「平均效能 × 懲罰倍率」最大。
   * 而「把某個區域填滿、恰好用 k 顆」最多能拿到多少效能總和，可以對每個區域單獨、精確地算出來（鋪法輪廓，見 resid）。
   * 把各區域的輪廓和「其餘隨便放的粒子」（取庫存裡效能最高的）用背包合起來，就得到這個組合的上界 RB(T)，
   * 比舊版「粒子數背包 × 全庫存最高平均效能」緊很多（舊版把「大顆才蓋得滿」和「小顆效能才高」分開各取最好）。
   * 搜尋時依 RB 由大到小一個組合一個組合搜（每個組合內部還是照原本的順序、一格一格鋪），RB 不超過目前最佳就全部結束。
   *
   * 同色而且「一顆粒子可以同時蓋到」的區域不能分開算（同一顆會被算兩次、或漏算可以順便蓋到的格子）：
   * 組合 T 裡這樣互相牽連的區域綁成一「塊」（comp）一起算輪廓；塊是依 T 動態拆的（沒被選進 T 的區域不會把別人牽在一起）。
   * 一塊的格子數超過 CBITS 時改用粗略的輪廓（只看格數與最大粒子）；區域數超過 MAXZ 時整個退回舊版搜尋（plan.ok = false）。
   */
  // COMP_CAP／PROF_CAP：一塊／全部最多記幾個輪廓狀態。超過之後新的狀態改用粗略輪廓（仍是正確的上界，只是比較鬆），
  // 避免同色區域緊貼在一起的極端板子把時間與記憶體吃光。
  const MAXZ = 20, CBITS = 52, HALF = 26, HMUL = 67108864, COMP_CAP = 40000, PROF_CAP = 250000, SEED_NODES = 3000;
  function buildPlan(S) {
    if (S.plan) return S.plan;
    const plan = { ok: false };
    S.plan = plan;
    const { zones, order, PL, M, coverBy, maxPieces: K, W } = S;
    const nz = order.length;
    if (!(nz && M.length) || S.mustMissing.length || S.baseUnreach || nz > MAXZ) return plan;
    islands(S);
    const K1 = K + 1, NEG = -Infinity, allowOverlap = S.allowOverlap;
    // --- 每個擺放：會同時碰到哪些同色區域（spMask：區域之間「可以被同一顆蓋到」的關係）、會蓋到哪些異色區域的格子（blk）---
    const cellZ = new Map(); // 格子 → [區域在 order 裡的位置]
    for (let pos = 0; pos < nz; pos++) for (const c of zones[order[pos]].cells) { let l = cellZ.get(c); if (!l) { l = []; cellZ.set(c, l); } l.push(pos); }
    const spMask = new Int32Array(nz), blk = new Int32Array(PL.length);
    for (let pos = 0; pos < nz; pos++) spMask[pos] = 1 << pos;
    for (let pid = 0; pid < PL.length; pid++) {
      const p = PL[pid]; let same = 0, other = 0;
      for (const c of p.cells) { const l = cellZ.get(c); if (!l) continue; for (const pos of l) { if (zones[order[pos]].color === p.color) same |= 1 << pos; else other |= 1 << pos; } }
      blk[pid] = other;
      if (same & (same - 1)) for (let pos = 0; pos < nz; pos++) if (same & (1 << pos)) spMask[pos] |= same;
    }
    // 把一組區域（位元遮罩）拆成互相牽連的塊，依最小位置由小到大放進 out
    function splitInto(maskB, out) {
      let rest = maskB;
      while (rest) {
        const low = rest & -rest; let comp = low, front = low;
        while (front) { const b = 31 - Math.clz32(front & -front); front &= front - 1; const add = spMask[b] & maskB & ~comp; comp |= add; front |= add; }
        out.push(comp); rest &= ~comp;
      }
      return out;
    }
    // --- 各顏色、全部庫存效能最高的 k 顆的總和（不夠 k 顆 → -Infinity）---
    const ctop = [];
    for (let c = 0; c < 5; c++) {
      const e = []; for (const m of M) if (m.color === c) for (const x of m.effs) e.push(x);
      e.sort((a, b) => b - a);
      const t = new Float64Array(K1).fill(NEG); t[0] = 0;
      for (let k = 1; k <= K && k <= e.length; k++) t[k] = t[k - 1] + e[k - 1];
      ctop.push(t);
    }
    const all = []; for (const m of M) for (const x of m.effs) all.push(x);
    all.sort((a, b) => b - a);
    const xf = new Float64Array(K1).fill(NEG); xf[0] = 0;
    for (let k = 1; k <= K && k <= all.length; k++) xf[k] = xf[k - 1] + all[k - 1];
    // --- 塊（依區域組合建立，用到才建）---
    const comps = [], compIdx = new Map();
    function compOf(mask) {
      let ci = compIdx.get(mask);
      if (ci !== undefined) return ci;
      const C = { mask, color: 0, zpos: [], cells: [], big: false, cellBit: new Int8Array(S.N).fill(-1), allLo: 0, allHi: 0, memo: new Map(), memoBig: new Map(), root: -1, nStates: 0 };
      for (let pos = 0; pos < nz; pos++) if (mask & (1 << pos)) {
        const z = zones[order[pos]]; C.zpos.push(pos); C.color = z.color;
        for (const c of z.cells) { if (C.cellBit[c] >= 0 || C.cells.length >= CBITS) C.big = true; else C.cellBit[c] = C.cells.length; C.cells.push(c); }
      }
      if (!C.big) for (let i = 0; i < C.cells.length; i++) { if (i < HALF) C.allLo |= 1 << i; else C.allHi |= 1 << (i - HALF); }
      ci = comps.length; comps.push(C); compIdx.set(mask, ci);
      return ci;
    }
    // --- 鋪法輪廓 ---
    // prof[idx][k] = 「把還沒蓋到的格子 m 全部蓋滿，恰好再用 k 顆」最多能拿到的效能總和（做不到 = -Infinity）。
    // 做法和搜尋一樣：每次挑 m 裡編號最小的格子，試所有蓋得到它的同色擺放；O = 這一塊裡已經被蓋住的格子（不允許重疊時不能再碰）。
    // 放寬的地方（所以是上界）：不管塊外面有沒有被別的粒子擋住、每種粒子都當作還有最高效能的那顆（最後再用 ctop 壓一次）。
    // m、O 各拆成低 26 位與高 26 位兩個整數（Lo／Hi）。pmin／pmax：輪廓裡有值的 k 的範圍。
    // hull[idx]：從這個狀態把 m 蓋滿的所有鋪法裡，粒子可能佔到的格子（板子遮罩）；用來判斷已放好的粒子群還有沒有機會被接上。
    const prof = [new Float64Array(K1).fill(NEG)], pmin = [0], pmax = [0], hull = [new Int32Array(W)];
    prof[0][0] = 0;
    function addProf(R, H) {
      let lo = K1, hi = -1;
      for (let k = 0; k <= K; k++) if (R[k] !== NEG) { if (lo > k) lo = k; hi = k; }
      prof.push(R); pmin.push(lo); pmax.push(hi); hull.push(H);
      return prof.length - 1;
    }
    function resid(ci, mLo, mHi, oLo, oHi) {
      if (!mLo && !mHi) return 0;
      const C = comps[ci], k1 = mLo + mHi * HMUL, k2 = oLo + oHi * HMUL;
      let sub = C.memo.get(k1);
      if (sub === undefined) { sub = new Map(); C.memo.set(k1, sub); } else { const got = sub.get(k2); if (got !== undefined) return got; }
      if (C.nStates >= COMP_CAP || prof.length >= PROF_CAP) { const ix = residBig(ci, pop32(mLo) + pop32(mHi)); sub.set(k2, ix); return ix; }
      C.nStates++;
      const R = new Float64Array(K1).fill(NEG), H = new Int32Array(W);
      const b = mLo ? 31 - Math.clz32(mLo & -mLo) : HALF + 31 - Math.clz32(mHi & -mHi);
      const lst = coverBy[C.cells[b]][C.color], cb = C.cellBit;
      for (let i = 0; i < lst.length; i++) {
        const pid = lst[i], p = PL[pid], pc = p.cells;
        let pLo = 0, pHi = 0;
        for (let q = 0; q < pc.length; q++) { const bb = cb[pc[q]]; if (bb >= 0) { if (bb < HALF) pLo |= 1 << bb; else pHi |= 1 << (bb - HALF); } }
        if (!allowOverlap && ((pLo & oLo) | (pHi & oHi))) continue;
        const e = M[p.s].effs[0];
        const ci2 = allowOverlap ? resid(ci, mLo & ~pLo, mHi & ~pHi, 0, 0) : resid(ci, mLo & ~pLo, mHi & ~pHi, oLo | pLo, oHi | pHi);
        if (pmax[ci2] < 0) continue; // 這樣放之後剩下的格子蓋不滿
        const ch = prof[ci2], hh = hull[ci2], pm = p.mask;
        for (let k = 0; k < K; k++) { const v = ch[k]; if (v !== NEG && e + v > R[k + 1]) R[k + 1] = e + v; }
        for (let w = 0; w < W; w++) H[w] |= pm[w] | hh[w];
      }
      const ct = ctop[C.color];
      for (let k = 0; k <= K; k++) if (R[k] > ct[k]) R[k] = ct[k];
      const idx = addProf(R, H); sub.set(k2, idx);
      return idx;
    }
    // 格子太多的塊：只知道還有 unc 格要蓋 → 至少 ceil(unc / 最大粒子) 顆，效能最多是該色最高的 k 顆；可能佔到的格子不設限
    const fullHull = new Int32Array(W).fill(-1);
    function residBig(ci, unc) {
      if (unc === 0) return 0;
      const C = comps[ci];
      let idx = C.memoBig.get(unc);
      if (idx !== undefined) return idx;
      const R = new Float64Array(K1).fill(NEG), ct = ctop[C.color], kmin = Math.ceil(unc / S.maxSize[C.color]);
      for (let k = kmin; k <= K; k++) R[k] = ct[k];
      idx = addProf(R, fullHull); C.memoBig.set(unc, idx);
      return idx;
    }
    // 一塊從頭開始（都還沒蓋）的輪廓
    function rootOf(ci) {
      const C = comps[ci];
      if (C.root < 0) C.root = C.big ? residBig(ci, C.cells.length) : resid(ci, C.allLo, C.allHi, 0, 0);
      return C.root;
    }
    // --- 列出所有區域組合與它的上界 ---
    const zIsl = new Int32Array(nz), islOk = S.nIsl <= 30;
    if (islOk) for (let pos = 0; pos < nz; pos++) for (const c of zones[order[pos]].cells) zIsl[pos] |= 1 << S.islandOf[c];
    const gw = S.gw, cap = S.cap, limit = S.limit, multArr = S.multArr, minA = S.minA, minD = S.minD;
    const gmasks = splitInto(nz >= 31 ? -1 : (1 << nz) - 1, []); // 靜態的群（所有區域都選時的塊）：不同群之間一定互不牽連
    const masks = [], rbs = [];
    const bufs = []; for (let i = 0; i <= gmasks.length; i++) bufs.push(new Float64Array(K1));
    const tmp = new Float64Array(K1), parts = [];
    bufs[0].set(xf);
    let mustAll = 0; for (let pos = 0; pos < nz; pos++) if (zones[order[pos]].must) mustAll |= 1 << pos;
    (function rec(gi, mask, U, atk, def, wd, wo, wv, wu, wa, isl) {
      if (gi === gmasks.length) {
        if (!(U > 0) || atk < minA || def < minD) return;
        const a = bufs[gi], d = islOk ? Math.max(0, pop32(isl) - 1) : 0;
        let rb = 0;
        for (let t = 1; t <= K; t++) {
          const y = a[t]; if (y === NEG) continue;
          const P = Math.max(0, Math.max(0, Math.max(0, t - limit) - wo) + Math.max(0, d - wd) - wa);
          if (P >= cap) continue;
          const v = (U * (y / t) / 100) * multArr[P];
          if (v > rb) rb = v;
        }
        if (rb > 0) { masks.push(mask); rbs.push(rb); }
        return;
      }
      const gm = gmasks[gi], a = bufs[gi], b = bufs[gi + 1], mustB = gm & mustAll;
      for (let B = gm; ; B = (B - 1) & gm) {
        if ((B & mustB) === mustB) {
          if (B === 0) { b.set(a); rec(gi + 1, mask, U, atk, def, wd, wo, wv, wu, wa, isl); }
          else {
            let u2 = U, a2 = atk, d2 = def, xd = wd, xo = wo, xv = wv, xu = wu, xa = wa, is2 = isl;
            for (let pos = 0; pos < nz; pos++) if (B & (1 << pos)) {
              const z = zones[order[pos]];
              u2 += z.u; a2 += z.atk; d2 += z.def; is2 |= zIsl[pos];
              if (z.waive > 0) { if (z.wtype === 'over') xo += z.waive; else if (z.wtype === 'overlap') xv += z.waive; else if (z.wtype === 'all') xa += z.waive; else if (z.wtype === 'out') xu += z.waive; else xd += z.waive; }
            }
            parts.length = 0; splitInto(B, parts);
            b.set(a);
            let any = true;
            for (let q = 0; q < parts.length && any; q++) {
              const ri = rootOf(compOf(parts[q])), R = prof[ri], lo = pmin[ri], hi = pmax[ri];
              any = false;
              for (let j = 0; j <= K; j++) {
                let best = NEG;
                for (let k = lo; k <= hi && k <= j; k++) { const rv = R[k]; if (rv === NEG) continue; const av = b[j - k]; if (av === NEG) continue; if (av + rv > best) best = av + rv; }
                tmp[j] = best; if (best !== NEG) any = true;
              }
              b.set(tmp);
            }
            if (any) rec(gi + 1, mask | B, u2, a2, d2, xd, xo, xv, xu, xa, is2);
          }
        }
        if (B === 0) break;
      }
    })(0, 0, 0, 0, 0, gw.disc, gw.over, gw.overlap, gw.out, gw.all, 0);
    const idxs = masks.map((_, i) => i);
    idxs.sort((x, y) => rbs[y] - rbs[x] || masks[x] - masks[y]);
    plan.ok = true; plan.spMask = spMask; plan.blk = blk; plan.ctop = ctop; plan.comps = comps; plan.compOf = compOf; plan.splitInto = splitInto;
    plan.prof = prof; plan.pmin = pmin; plan.pmax = pmax; plan.hull = hull; plan.resid = resid; plan.residBig = residBig; plan.rootOf = rootOf; plan.zIsl = zIsl; plan.islOk = islOk;
    plan.masks = Int32Array.from(idxs.map((i) => masks[i])); plan.rbs = Float64Array.from(idxs.map((i) => rbs[i]));
    return plan;
  }

  // 內建的 JS 搜尋引擎。回傳 { best: [{ pid, eff }] 或 null, bestVal, nodes, stop, stats }。
  // 也可以換成別的引擎（例如 WASM 版，見 src/solver_wasm.js）：solve(prob, { engine: (S, opts, t0) => ({...}) })
  function searchJS(S, opts, t0) {
    const { W, zones, M, PL, coverBy, byStack, cap, limit, allowOverlap, maxPieces, effMax, order, maxSize } = S;
    const timeLimit = opts.timeLimitMs || 60000;
    // opts.split = { k, m }：把搜尋空間分成 m 份，這次只搜第 k 份（0 起算）；m 份各跑一次再取最好的，結果和不分割一樣
    const splitM = opts.split && opts.split.m > 1 ? opts.split.m | 0 : 1, splitK = splitM > 1 ? opts.split.k | 0 : 0;
    let nodes = 0, stop = false, bestVal = 0, best = null, lastProg = t0;
    // 「區域組合」搜尋的節點額度：一個組合用完額度就先擱著（bail），換下一個；見 runPlan
    let bail = false, nodeLimit = Infinity, inPlan = false;
    const stats = { leaves: 0, tiles: 0, extrasCalls: 0, extrasCands: 0, pruneZone: 0, pruneTile: 0 };

    const occ = new Int32Array(W), cov = new Int32Array(5 * W);
    const snapOcc = [], snapCov = [];
    for (let i = 0; i <= maxPieces + 1; i++) { snapOcc.push(new Int32Array(W)); snapCov.push(new Int32Array(5 * W)); }
    const pcs = new Int32Array(maxPieces + 2), effOf = new Float64Array(maxPieces + 2), ovArr = new Int32Array(maxPieces + 2);
    const used = new Int32Array(M.length);
    let n = 0, sumEff = 0, ov = 0, outN = 0;

    const islandOf = islands(S).islandOf, nIsl = S.nIsl;
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
    const WD = S.WD, WO = S.WO, WV = S.WV, WU = S.WU, WA = S.WA, hasW = WD + WO + WV + WU + WA > 0;
    const lbEff = (o, v, d, u) => Math.max(0, Math.max(0, o - WO) + Math.max(0, v - WV) + Math.max(0, d - WD) + Math.max(0, (u || 0) - WU) - WA);
    const waiveZ = zones.filter((z) => z.waive > 0);
    const overlapOf = (p) => { let c = 0; for (let w = 0; w < W; w++) { const x = occ[w] & p.mask[w]; if (x) c += pop32(x); } return c; };
    const touches = (p) => { for (let w = 0; w < W; w++) if (occ[w] & p.nb[w]) return true; return false; };

    // 目前已放粒子的連通群（隨放隨更新）：第 n 層有 cmN[n] 群，cm 裡每群一個遮罩＝該群所有粒子的「本身＋相鄰格」聯集
    const CW = (maxPieces + 2) * W, cmN = new Int32Array(maxPieces + 3), cm = new Int32Array((maxPieces + 3) * CW);
    function apply(pid, ovl) {
      const p = PL[pid];
      {
        const d0 = n * CW, d1 = d0 + CW, pm = p.mask, pn = p.nb; let nc = 1;
        for (let w = 0; w < W; w++) cm[d1 + w] = pm[w] | pn[w];
        for (let j = 0, o = d0; j < cmN[n]; j++, o += W) {
          let t = false;
          for (let w = 0; w < W; w++) if (cm[o + w] & pm[w]) { t = true; break; }
          if (t) for (let w = 0; w < W; w++) cm[d1 + w] |= cm[o + w];
          else { const o2 = d1 + nc * W; for (let w = 0; w < W; w++) cm[o2 + w] = cm[o + w]; nc++; }
        }
        cmN[n + 1] = nc;
      }
      snapOcc[n].set(occ); snapCov[n].set(cov);
      const e = M[p.s].effs[used[p.s]];
      pcs[n] = pid; effOf[n] = e; ovArr[n] = ovl;
      used[p.s]++; sumEff += e; ov += ovl; n++; if (p.out) outN++;
      if (islCnt[islandOf[p.cells[0]]]++ === 0) activeIsl++;
      const base = p.color * W;
      for (let w = 0; w < W; w++) { occ[w] |= p.mask[w]; cov[base + w] |= p.mask[w]; }
    }
    function undo() {
      n--; const p = PL[pcs[n]];
      used[p.s]--; sumEff -= effOf[n]; ov -= ovArr[n]; if (p.out) outN--;
      if (--islCnt[islandOf[p.cells[0]]] === 0) activeIsl--;
      occ.set(snapOcc[n]); cov.set(snapCov[n]);
    }

    const zoneUncovered = (z) => { let c = 0; const b = z.color * W; for (let w = 0; w < W; w++) c += pop32(z.mask[w] & ~cov[b + w]); return c; };
    const zoneDone = (z) => { const b = z.color * W; for (let w = 0; w < W; w++) if (z.mask[w] & ~cov[b + w]) return false; return true; };
    const currentU = () => { let u = 0; for (let i = 0; i < zones.length; i++) { const z = zones[i]; if (z.u > 0 && zoneDone(z)) u += z.u; } return u; };
    // 基礎攻防門檻：目前已填滿的區域的攻／防加總
    const minA = S.minA, minD = S.minD, hasBase = minA > 0 || minD > 0;
    const baseNow = (f) => { let s = 0; for (let i = 0; i < zones.length; i++) { const z = zones[i]; if (z[f] > 0 && zoneDone(z)) s += z[f]; } return s; };
    const baseMet = () => (minD <= 0 || baseNow('def') >= minD) && (minA <= 0 || baseNow('atk') >= minA);

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
    const describe = (list) => describePieces(S, list);

    function evalCurrent() {
      if (n === 0) return 0;
      for (const zi of S.mustIdx) if (!zoneDone(zones[zi])) return 0;
      if (hasBase && !baseMet()) return 0;
      const U = currentU();
      if (U <= 0) return 0;
      let wd = S.gw.disc, wo = S.gw.over, wv = S.gw.overlap, wu = S.gw.out, wa = S.gw.all;
      if (hasW) for (const z of waiveZ) if (zoneDone(z)) { if (z.wtype === 'over') wo += z.waive; else if (z.wtype === 'overlap') wv += z.waive; else if (z.wtype === 'all') wa += z.waive; else if (z.wtype === 'out') wu += z.waive; else wd += z.waive; }
      const P = Math.max(0, Math.max(0, Math.max(0, n - limit) - wo) + Math.max(0, ov - wv) + Math.max(0, cmN[n] - 1 - wd) + Math.max(0, outN - wu) - wa);
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
    const pndNow = () => lbEff(Math.max(0, n - limit), ov, Math.max(0, activeIsl - 1), outN);
    const ubValue = (Uopt, nNow, sNow, Pnd) => Uopt * avgUBk(nNow, sNow, maxPieces - nNow, -1, -1) / 100 * multOf(Pnd);

    // 剩餘區域的價值上界（背包）。同色區域「合併」計算所需粒子數：
    // 一顆粒子可以同時蓋住相鄰的兩個同色區域，所以不能各自進位後再加總。
    // forced：必須選入的區域（正在鋪的那個），回傳 -Infinity 表示放不下。
    const colTmp = [[], [], [], [], []];
    const dpA = new Float64Array(maxPieces + 2), dpB = new Float64Array(maxPieces + 2), tb = new Float64Array(maxPieces + 2);
    // field：用區域的哪個欄位當價值（預設 'u' = 目標價值；基礎攻防門檻的剪枝用 'atk'／'def'）
    function knap(zi, budget, forced, field) {
      if (budget < 0) return -Infinity;
      const f = field || 'u';
      for (let c = 0; c < 5; c++) colTmp[c].length = 0;
      for (let k = zi; k < order.length; k++) {
        const zid = order[k], z = zones[zid];
        const unc = zoneUncovered(z);
        if (unc === 0) continue;
        colTmp[z.color].push(z[f], unc, (zid === forced || z.must) ? 1 : 0);
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
      if (++nodes >= nodeLimit) bail = true;
      if ((nodes & 1023) === 0) {
        const t = Date.now();
        if (t - t0 > timeLimit) stop = true;
        if (opts.shouldStop && opts.shouldStop()) stop = true;
        if (opts.onProgress && t - lastProg > 250) { lastProg = t; opts.onProgress({ nodes, ms: t - t0, best: bestVal }); }
      }
    }

    // 基礎攻防門檻的剪枝：已填滿的加上「剩餘粒子數內最多還能填到」的（背包上界）仍不夠 → 這個分支不可能達標
    function baseReachable(zi, forced) {
      if (minD > 0) { const k = knap(zi, maxPieces - n, forced, 'def'); if (k === -Infinity || baseNow('def') + k < minD) return false; }
      if (minA > 0) { const k = knap(zi, maxPieces - n, forced, 'atk'); if (k === -Infinity || baseNow('atk') + k < minA) return false; }
      return true;
    }

    function dfsZone(zi) {
      if (stop || bail) return;
      tick();
      if (zi === order.length) { if (n > 0 && (!hasBase || baseMet())) { stats.leaves++; evalCurrent(); extrasSearch(); } return; }
      const z = zones[order[zi]];
      const kn = knap(zi, maxPieces - n, -1);
      // -Infinity：剩下必觸發的區域在粒子數上限內放不下
      if (kn === -Infinity) { stats.pruneZone++; return; }
      if (hasBase && !baseReachable(zi, -1)) { stats.pruneZone++; return; }
      const ub = ubValue(currentU() + kn, n, sumEff, pndNow());
      if (ub <= bestVal + 1e-9) { stats.pruneZone++; return; }
      if (zoneDone(z)) { dfsZone(zi + 1); return; }
      tile(zi);
      if (!z.must) dfsZone(zi + 1); // 必觸發的區域不能略過
    }

    function tile(zi) {
      if (stop || bail) return;
      const z = zones[order[zi]];
      let c = -1;
      for (const ci of z.cells) { if (!(cov[z.color * W + (ci >> 5)] & (1 << (ci & 31)))) { c = ci; break; } }
      if (c < 0) { dfsZone(zi + 1); return; }
      if (n >= maxPieces) return;
      const need = Math.ceil(zoneUncovered(z) / maxSize[z.color]);
      if (need > maxPieces - n) return;
      const Ubase = currentU() + knap(zi, maxPieces - n, order[zi]);
      if (!(Ubase > 0) || ubValue(Ubase, n, sumEff, pndNow()) <= bestVal + 1e-9) { stats.pruneTile++; return; }
      if (hasBase && !baseReachable(zi, order[zi])) { stats.pruneTile++; return; }
      stats.tiles++;
      const lst = coverBy[c][z.color];
      const restK = maxPieces - n - 1;
      for (let k = 0; k < lst.length; k++) {
        if (splitM > 1 && n === 0 && k % splitM !== splitK) continue; // 平行搜尋：第一顆粒子的候選擺放依序輪流分給各執行緒
        const pid = lst[k], p = PL[pid];
        const si = p.s;
        if (used[si] >= M[si].effs.length) continue;
        const ovl = overlapOf(p);
        if (ovl && !allowOverlap) continue;
        const pc = lbEff(Math.max(0, n + 1 - limit), ov + ovl, Math.max(0, activeIsl - 1), outN + (p.out ? 1 : 0));
        if (pc >= cap) continue;
        // 前置過濾：放這顆之後，就算其餘都補到最好，也贏不了目前最佳 → 不展開
        if (Ubase * avgUBk(n + 1, sumEff + M[si].effs[used[si]], restK, si, used[si]) / 100 * multOf(pc) <= bestVal + 1e-9) continue;
        tick(); if (stop || bail) return;
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
    // 額外粒子的把關：再放一顆「堆疊 s 的下一顆」（效能 e）。
    // x0：放完之後乖離是 d0，「就停在這裡」有沒有可能贏過目前最佳。
    // xFut：之後最多再補 K-1 顆最好的粒子（乖離最好能降到 dI）有沒有可能贏。
    function x0(e, d0, out2, U) {
      const n2 = n + 1;
      const P0 = inPlan ? lbT(n2 > limit ? n2 - limit : 0, ov, d0, out2) : lbEff(n2 > limit ? n2 - limit : 0, ov, d0, out2);
      return P0 < cap && (U * ((sumEff + e) / n2) / 100) * S.multArr[P0] > bestVal + 1e-9;
    }
    function xFut(s, e, dI, out2, K, U) {
      const n2 = n + 1, target = bestVal + 1e-9;
      let sum = sumEff + e, cnt = 0;
      for (let i = 0; i < gE.length && cnt < K - 1; i++) {
        const si = gS[i], j = gJ[i];
        if (j < used[si] || (si === s && j === used[s])) continue;
        cnt++; sum += gE[i];
        const N = n2 + cnt, P = inPlan ? lbT(N > limit ? N - limit : 0, ov, dI, out2) : lbEff(N > limit ? N - limit : 0, ov, dI, out2);
        if (P < cap && (U * (sum / N) / 100) * S.multArr[P] > target) return true;
      }
      return false;
    }
    // 堆疊 s 的「同一顆會一起蓋到的格子」：lk[c*W..] = 所有蓋到格子 c 的擺放的遮罩聯集（用到才算）
    const lkS = new Array(M.length).fill(null);
    function stackLink(s) {
      let L = lkS[s];
      if (!L) {
        L = lkS[s] = new Int32Array(S.N * W);
        for (const pid of byStack[s]) { const p = PL[pid], pm = p.mask; for (const c of p.cells) { const o = c * W; for (let w = 0; w < W; w++) L[o + w] |= pm[w]; } }
      }
      return L;
    }
    // 堆疊 s 蓋到每一格的擺放清單（用到才算）
    const scS = new Array(M.length).fill(null);
    function stackCells(s) {
      let B = scS[s];
      if (!B) {
        B = scS[s] = []; for (let c = 0; c < S.N; c++) B.push([]);
        for (const pid of byStack[s]) for (const c of PL[pid].cells) B[c].push(pid);
      }
      return B;
    }
    const xStamp = new Int32Array(PL.length); let xStampId = 0;
    function extrasRec(K, visited, U, h1, h2) {
      if (stop || bail) return;
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
      const pAfter = lbEff(Math.max(0, n + 1 - limit), ov, Math.max(0, activeIsl - 1), outN);
      const dIn = Math.max(0, (inPlan && islT > activeIsl ? islT : activeIsl) - 1);
      // 各連通群「旁邊還空著的格子」（要碰到這一群，粒子一定有一格在這裡面）；用到才算
      const nc0 = cmN[n];
      let frM = null, frC = null;
      // 堆疊 s 的擺放裡，有可能同時碰到兩個群的（只看形狀與位置：粒子有一格在某一群旁邊、而且同一顆蓋得到另一群旁邊的格子）
      const bridgeList = (s) => {
        if (!frM) {
          frM = []; frC = [];
          for (let j = 0, o = n * CW; j < nc0; j++, o += W) {
            const m = new Int32Array(W), cl = [];
            for (let w = 0; w < W; w++) { let x = cm[o + w] & ~occ[w]; m[w] = x; while (x) { cl.push(w * 32 + 31 - Math.clz32(x & -x)); x &= x - 1; } }
            frM.push(m); frC.push(cl);
          }
        }
        const L = stackLink(s), B = stackCells(s), out = [], st = ++xStampId;
        for (let i = 0; i < nc0 - 1; i++) {
          const cl = frC[i];
          for (let x = 0; x < cl.length; x++) {
            const a = cl[x], o = a * W;
            let reach = false;
            for (let j = i + 1; j < nc0 && !reach; j++) { const m = frM[j]; for (let w = 0; w < W; w++) if (L[o + w] & m[w]) { reach = true; break; } }
            if (!reach) continue;
            const bl = B[a];
            for (let y = 0; y < bl.length; y++) { const pid = bl[y]; if (xStamp[pid] !== st) { xStamp[pid] = st; out.push(pid); } }
          }
        }
        return out;
      };
      for (const s of ord) {
        const e = M[s].effs[used[s]];
        // 前置過濾：就算之後再補最好的粒子，也贏不過目前最佳 → 這種粒子不用試
        if (U * avgUBk(n + 1, sumEff + e, K - 1, s, used[s]) / 100 * multOf(pAfter) <= bestVal + 1e-9) continue;
        let list = byStack[s];
        if (!x0(e, dIn, outN, U)) { if (!xFut(s, e, dIn, outN, K, U)) continue; } // 這種粒子就算一放就把所有群接起來也贏不了
        else if (nc0 > 1 && !xFut(s, e, dIn, outN, K, U)) {
          // 只有「放了就停」才可能贏：算出至少要一次碰到幾群；要兩群以上的話，只看「形狀上搆得到兩群」的擺放（通常很少，甚至沒有）
          let need = 0;
          while (need < nc0 && !x0(e, nc0 - need, outN, U)) need++;
          if (need >= 2) { list = bridgeList(s); if (!list.length) continue; }
        }
        const plainDone = [false, false], farDone = [false, false]; // 索引：0＝板內、1＝超界（超界的粒子會多 +1 懲罰，不能互相代表）
        for (let li = 0; li < list.length; li++) {
          const pid = list[li], p = PL[pid];
          let hit = false;
          for (let w = 0; w < W; w++) if (occ[w] & p.mask[w]) { hit = true; break; }
          if (hit) continue;
          const oi = p.out ? 1 : 0;
          // 事前把關（不用真的放上去）：放了這顆之後連通群數是確定的（c2）
          {
            const pm = p.mask;
            let tc = 0;
            for (let j = 0, o = n * CW; j < cmN[n]; j++, o += W) { for (let w = 0; w < W; w++) if (cm[o + w] & pm[w]) { tc++; break; } }
            const ai = activeIsl + (islCnt[islandOf[p.cells[0]]] === 0 ? 1 : 0);
            if (!x0(e, cmN[n] - tc, outN + oi, U) && !xFut(s, e, Math.max(0, (inPlan && islT > ai ? islT : ai) - 1), outN + oi, K, U)) continue;
          }
          let allowed = false;
          if (touches(p)) {
            if (comps === 1) {
              if (e > avg && !plainDone[oi]) { allowed = true; plainDone[oi] = true; }
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
              else if (e > avg && !plainDone[oi]) { allowed = true; plainDone[oi] = true; }
            }
          } else if (!farDone[oi]) { allowed = true; farDone[oi] = true; }
          if (!allowed) continue;
          tick(); if (stop || bail) return;
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

    /* ------------------------------------------------------------------ */
    // 「區域組合」搜尋（說明見 buildPlan）。plan.ok 為 false（區域太多…）或 opts.legacy 時用上面的舊版 dfsZone。
    const plan = opts.legacy ? { ok: false } : buildPlan(S);
    const nz = order.length, K1 = maxPieces + 1, NEG = -Infinity, multArr = S.multArr;
    const tComp = new Int32Array(nz), tParts = [], cUsed = new Uint8Array(nz);
    // 每一塊「從頭開始時、樂觀估計下還有可能贏」的第一顆擺放（setupT 算好）：vBuf[vStart[q] .. vStart[q]+vLen[q])。vLen = -1：不設限（格子太多的塊）
    const vStart = new Int32Array(nz), vLen = new Int32Array(nz);
    let vBuf = new Int32Array(1024), vN = 0;
    let curT = 0, nTC = 0, UT = 0, tWD = 0, tWO = 0, tWV = 0, tWU = 0, tWA = 0, islT = 1;
    let comps = null, prof = null, pmin = null, pmax = null, hull = null, blk = null;
    // 每一層（第幾塊）進場時算好的：其他塊＋額外粒子的合併輪廓。SX0＝不放額外粒子、SX1＝至少放一顆、SXA＝兩者取大；
    // HO＝其他塊之後可能佔到的格子、OTH＝還有沒有其他塊沒鋪
    const SX0 = [], SX1 = [], SXA = [], HO = [], OTH = new Uint8Array(nz + 1);
    for (let i = 0; i <= nz; i++) { SX0.push(new Float64Array(K1)); SX1.push(new Float64Array(K1)); SXA.push(new Float64Array(K1)); HO.push(new Int32Array(W)); }
    const cvTmp = new Float64Array(K1), sxV = new Float64Array(K1);
    let sLo = 0, sHi = 0; // cState 的回傳值
    // 這個組合 T 的有效懲罰下界：只有 T 裡的區域（＋固定免除）能免除懲罰
    const lbT = (o, v, d, u) => Math.max(0, Math.max(0, o - tWO) + Math.max(0, v - tWV) + Math.max(0, d - tWD) + Math.max(0, u - tWU) - tWA);

    function setupT(mask) {
      curT = mask; UT = 0;
      tWD = S.gw.disc; tWO = S.gw.over; tWV = S.gw.overlap; tWU = S.gw.out; tWA = S.gw.all;
      let isl = 0;
      for (let pos = 0; pos < nz; pos++) {
        if (!(mask & (1 << pos))) continue;
        const z = zones[order[pos]];
        UT += z.u; isl |= plan.zIsl[pos];
        if (z.waive > 0) { if (z.wtype === 'over') tWO += z.waive; else if (z.wtype === 'overlap') tWV += z.waive; else if (z.wtype === 'all') tWA += z.waive; else if (z.wtype === 'out') tWU += z.waive; else tWD += z.waive; }
      }
      islT = plan.islOk ? pop32(isl) : 1;
      tParts.length = 0; plan.splitInto(mask, tParts);
      nTC = tParts.length;
      for (let q = 0; q < nTC; q++) { tComp[q] = plan.compOf(tParts[q]); cUsed[q] = 0; }
      // 每一塊的「可行的第一顆」：假設它第一個鋪、其他塊都照自己最好的輪廓、額外粒子取全庫存最好的，還贏得過目前最佳的擺放。
      // 之後搜尋中任何時候，這一塊能用的第一顆一定在這份清單裡（實際情況只會更差），所以清單裡的都被擋住時整個分支可以剪掉。
      vN = 0;
      const dI = Math.max(0, islT - 1);
      for (let q = 0; q < nTC; q++) {
        const ci = tComp[q], C = comps[ci];
        vStart[q] = vN;
        if (C.big || nTC < 2) { vLen[q] = -1; continue; }
        sxV[0] = 0;
        for (let j = 1; j <= maxPieces; j++) sxV[j] = j <= gE.length ? sxV[j - 1] + gE[j - 1] : NEG;
        for (let q2 = 0; q2 < nTC; q2++) if (q2 !== q) conv(sxV, plan.rootOf(tComp[q2]), maxPieces);
        const lst = coverBy[C.cells[0]][C.color], cbit = C.cellBit;
        for (let k = 0; k < lst.length; k++) {
          const pid = lst[k], pp = PL[pid], pc = pp.cells;
          if (!allowOverlap && (blk[pid] & mask)) continue;
          let pLo = 0, pHi = 0;
          for (let x = 0; x < pc.length; x++) { const bb = cbit[pc[x]]; if (bb >= 0) { if (bb < HALF) pLo |= 1 << bb; else pHi |= 1 << (bb - HALF); } }
          const ri = allowOverlap ? plan.resid(ci, C.allLo & ~pLo, C.allHi & ~pHi, 0, 0) : plan.resid(ci, C.allLo & ~pLo, C.allHi & ~pHi, pLo, pHi);
          if (!cb(ri, sxV, 1, M[pp.s].effs[0], 0, pp.out ? 1 : 0, dI)) continue;
          if (vN === vBuf.length) { const nb = new Int32Array(vBuf.length * 2); nb.set(vBuf); vBuf = nb; }
          vBuf[vN++] = pid;
        }
        vLen[q] = vN - vStart[q];
      }
    }
    // 塊 C 的格子目前哪些已經被同色粒子蓋住 → sLo／sHi
    function cState(C) {
      let lo = 0, hi = 0; const b = C.color * W, cl = C.cells;
      for (let i = 0; i < cl.length; i++) { const ci = cl[i]; if (cov[b + (ci >> 5)] & (1 << (ci & 31))) { if (i < HALF) lo |= 1 << i; else hi |= 1 << (i - HALF); } }
      sLo = lo; sHi = hi;
    }
    // 塊 ci 目前的鋪法輪廓（prof 的索引；0 = 都填滿了）
    function cProf(ci) {
      const C = comps[ci];
      if (C.big) { let unc = 0; for (const pos of C.zpos) unc += zoneUncovered(zones[order[pos]]); return plan.residBig(ci, unc); }
      cState(C);
      return allowOverlap ? plan.resid(ci, C.allLo & ~sLo, C.allHi & ~sHi, 0, 0) : plan.resid(ci, C.allLo & ~sLo, C.allHi & ~sHi, sLo, sHi);
    }
    // 上界檢查的核心：輪廓 R（索引 ri）配上合併輪廓 sx，在「目前 n1 顆、效能總和 se1、重疊 ov1、超界 out1、乖離至少 d」之下，有沒有可能贏過目前最佳
    function cb(ri, sx, n1, se1, ov1, out1, d) {
      const R = prof[ri], lo = pmin[ri], hi = pmax[ri], Kr = maxPieces - n1, target = bestVal + 1e-9;
      for (let t = lo; t <= Kr; t++) {
        let y = NEG;
        for (let k = lo; k <= hi && k <= t; k++) { const rv = R[k]; if (rv === NEG) continue; const av = sx[t - k]; if (av === NEG) continue; if (av + rv > y) y = av + rv; }
        if (y === NEG) continue;
        const N = n1 + t; if (N === 0) continue;
        const P = lbT(N > limit ? N - limit : 0, ov1, d, out1);
        if (P >= cap) continue;
        if ((UT * ((se1 + y) / N) / 100) * multArr[P] > target) return true;
      }
      return false;
    }
    // 已放好的粒子群裡，有幾群「之後鋪區域的粒子（範圍 hull[ri] ∪ HO[ti]）不可能碰到」→ 不放額外粒子的話乖離至少這麼多。
    // pid >= 0：假設再放上這顆（還沒 apply）。回傳值只在「不放額外粒子」時成立。
    function strand(ti, ri, pid) {
      const h1 = hull[ri], h2 = HO[ti], any = ri !== 0 || OTH[ti] === 1;
      let cnt = 0;
      const base = n * CW, nc = cmN[n];
      if (pid < 0) {
        for (let j = 0, o = base; j < nc; j++, o += W) { let t = false; for (let w = 0; w < W; w++) if (cm[o + w] & (h1[w] | h2[w])) { t = true; break; } if (!t) cnt++; }
        return cnt;
      }
      const p = PL[pid], pm = p.mask, pn = p.nb;
      let link = false;
      for (let w = 0; w < W; w++) if ((pm[w] | pn[w]) & (h1[w] | h2[w])) { link = true; break; }
      for (let j = 0, o = base; j < nc; j++, o += W) {
        let tp = false, th = false;
        for (let w = 0; w < W; w++) { const x = cm[o + w]; if (x & pm[w]) tp = true; if (x & (h1[w] | h2[w])) th = true; }
        if (tp) { if (th) link = true; } else if (!th) cnt++;
      }
      return cnt + (any && !link ? 1 : 0);
    }
    function canBeat(ti, ri, n1, se1, ov1, out1, dI, pid) {
      if (!cb(ri, SXA[ti], n1, se1, ov1, out1, dI)) return false;
      const dC = strand(ti, ri, pid);
      if (dC <= dI) return true;
      return cb(ri, SX0[ti], n1, se1, ov1, out1, dC) || cb(ri, SX1[ti], n1, se1, ov1, out1, dI);
    }
    function conv(sx, ri, Kr) {
      const R = prof[ri], lo = pmin[ri], hi = pmax[ri];
      for (let j = 0; j <= Kr; j++) {
        let b = NEG;
        for (let k = lo; k <= hi && k <= j; k++) { const rv = R[k]; if (rv === NEG) continue; const av = sx[j - k]; if (av === NEG) continue; if (av + rv > b) b = av + rv; }
        cvTmp[j] = b;
      }
      for (let j = 0; j <= Kr; j++) sx[j] = cvTmp[j];
    }

    // 組合裡的區域都鋪完了：計分，再看要不要補額外粒子（用這個組合自己的上界把關，比舊版的 ubValue 緊）
    function leafT() {
      if (!(n > 0 && (!hasBase || baseMet()))) return;
      stats.leaves++;
      evalCurrent();
      const K = maxPieces - n;
      if (K <= 0) return;
      const d = Math.max(0, (activeIsl > islT ? activeIsl : islT) - 1), target = bestVal + 1e-9;
      let sum = sumEff, cnt = 0, ok = false;
      for (let i = 0; i < gE.length && cnt < K; i++) {
        if (gJ[i] < used[gS[i]]) continue;
        cnt++; sum += gE[i];
        const N = n + cnt, P = lbT(N > limit ? N - limit : 0, ov, d, outN);
        if (P < cap && (UT * (sum / N) / 100) * multArr[P] > target) { ok = true; break; }
      }
      if (!ok) return;
      stats.extrasCalls++;
      extrasRec(K, new Set(), currentU(), 0, 0);
    }

    // 選下一塊來鋪：挑「還放得下的可行第一顆」最少的（最受限的先鋪，撞牆才撞得早）；有任何一塊已經沒有可行的第一顆 → 這個分支不可能，剪掉
    function dfsT(ti) {
      if (stop || bail) return;
      tick();
      let bq = -1, bc = 0x7fffffff;
      for (let q = 0; q < nTC; q++) {
        if (cUsed[q]) continue;
        let cnt = 0x7ffffffe;
        const len = vLen[q];
        if (len >= 0) {
          if (allowOverlap) cnt = len;
          else {
            cnt = 0;
            for (let x = vStart[q], xe = x + len; x < xe && cnt < bc; x++) {
              const pm = PL[vBuf[x]].mask; let hit = false;
              for (let w = 0; w < W; w++) if (occ[w] & pm[w]) { hit = true; break; }
              if (!hit) cnt++;
            }
          }
          if (cnt === 0) { stats.pruneZone++; return; }
        }
        if (cnt < bc) { bc = cnt; bq = q; }
      }
      if (bq < 0) { leafT(); return; }
      const Kr = maxPieces - n;
      if (Kr <= 0) return;
      // 其餘隨便放的粒子：剩餘庫存裡效能最高的 x 顆。s0 = 一顆都不放、s1 = 至少放一顆
      const s0 = SX0[ti], s1 = SX1[ti], sa = SXA[ti], ho = HO[ti];
      s0[0] = 0; s1[0] = NEG;
      let cnt = 0, acc = 0;
      for (let i = 0; i < gE.length && cnt < Kr; i++) { if (gJ[i] < used[gS[i]]) continue; cnt++; acc += gE[i]; s1[cnt] = acc; s0[cnt] = NEG; }
      for (let j = cnt + 1; j <= Kr; j++) { s1[j] = NEG; s0[j] = NEG; }
      // 併入其他還沒鋪的塊的輪廓（都還沒動過，所以是「從頭開始」的輪廓）
      let oth = 0;
      for (let w = 0; w < W; w++) ho[w] = 0;
      for (let q = 0; q < nTC; q++) {
        if (cUsed[q] || q === bq) continue;
        const ri = plan.rootOf(tComp[q]);
        oth = 1;
        conv(s0, ri, Kr); conv(s1, ri, Kr);
        const hh = hull[ri]; for (let w = 0; w < W; w++) ho[w] |= hh[w];
      }
      OTH[ti] = oth;
      for (let j = 0; j <= Kr; j++) sa[j] = s0[j] > s1[j] ? s0[j] : s1[j];
      const cc = tComp[bq], C = comps[cc], ri = plan.rootOf(cc);
      const dI = Math.max(0, (activeIsl > islT ? activeIsl : islT) - 1);
      if (!canBeat(ti, ri, n, sumEff, ov, outN, dI, -1)) { stats.pruneZone++; return; }
      cUsed[bq] = 1;
      tileT(ti, cc, C.allLo, C.allHi, 0, 0);
      cUsed[bq] = 0;
    }

    // 鋪塊 cc：每次挑它還沒蓋到的第一格，試所有蓋得到的同色擺放。m＝還沒蓋的格子、O＝已蓋的格子（位元，各分高低兩半）
    function tileT(ti, cc, mLo, mHi, oLo, oHi) {
      if (stop || bail) return;
      const C = comps[cc], big = C.big, color = C.color;
      let c = -1;
      if (big) {
        for (let x = 0; x < C.zpos.length && c < 0; x++) { const z = zones[order[C.zpos[x]]]; for (const ci of z.cells) { if (!(cov[color * W + (ci >> 5)] & (1 << (ci & 31)))) { c = ci; break; } } }
      } else if (mLo) c = C.cells[31 - Math.clz32(mLo & -mLo)];
      else if (mHi) c = C.cells[HALF + 31 - Math.clz32(mHi & -mHi)];
      if (c < 0) { dfsT(ti + 1); return; }
      if (n >= maxPieces) return;
      stats.tiles++;
      const lst = coverBy[c][color], cbit = C.cellBit;
      for (let k = 0; k < lst.length; k++) {
        if (splitM > 1 && n === 0 && k % splitM !== splitK) continue; // 平行搜尋：第一顆粒子的候選擺放依序輪流分給各份
        const pid = lst[k], p = PL[pid];
        if (used[p.s] >= M[p.s].effs.length) continue;
        if (!allowOverlap && (blk[pid] & curT)) continue; // 會蓋到組合裡別色區域的格子 → 那個區域永遠填不滿
        const ovl = overlapOf(p);
        if (ovl && !allowOverlap) continue;
        if (big) {
          apply(pid, ovl);
          const ri = cProf(cc);
          if (!canBeat(ti, ri, n, sumEff, ov, outN, Math.max(0, (activeIsl > islT ? activeIsl : islT) - 1), -1)) { stats.pruneTile++; undo(); continue; }
          tick();
          if (stop || bail) { undo(); return; }
          tileT(ti, cc, 0, 0, 0, 0);
          undo();
          continue;
        }
        const pc = p.cells;
        let pLo = 0, pHi = 0;
        for (let q = 0; q < pc.length; q++) { const bb = cbit[pc[q]]; if (bb >= 0) { if (bb < HALF) pLo |= 1 << bb; else pHi |= 1 << (bb - HALF); } }
        const m2Lo = mLo & ~pLo, m2Hi = mHi & ~pHi, o2Lo = allowOverlap ? 0 : (oLo | pLo), o2Hi = allowOverlap ? 0 : (oHi | pHi);
        const ri = plan.resid(cc, m2Lo, m2Hi, o2Lo, o2Hi);
        const ai = activeIsl + (islCnt[islandOf[pc[0]]] === 0 ? 1 : 0);
        if (!canBeat(ti, ri, n + 1, sumEff + M[p.s].effs[used[p.s]], ov + ovl, outN + (p.out ? 1 : 0), Math.max(0, (ai > islT ? ai : islT) - 1), pid)) { stats.pruneTile++; continue; }
        apply(pid, ovl);
        tick();
        if (stop || bail) { undo(); return; }
        tileT(ti, cc, m2Lo, m2Hi, o2Lo, o2Hi);
        undo();
      }
    }

    // 依上界由大到小搜每個區域組合。每個組合先給一點節點額度，用完就擱著換下一個（先讓每個看起來不錯的組合都有機會
    // 找到好解，把目前最佳拉高），一輪走完再把額度放大重來；搜完的組合不會再搜。上界不超過目前最佳時整個結束。
    function runPlan() {
      comps = plan.comps; prof = plan.prof; pmin = plan.pmin; pmax = plan.pmax; hull = plan.hull; blk = plan.blk;
      // 先用舊版搜尋跑一小段，拿到一個「還可以」的解當起點（舊版很快就會找到第一個解；沒有起點時每個組合都得盲搜）
      const nodes0 = nodes;
      bail = false; nodeLimit = nodes + SEED_NODES;
      dfsZone(0);
      if (stop) return;
      inPlan = true;
      const masks = plan.masks, rbs = plan.rbs, nC = masks.length;
      const fin = new Uint8Array(nC);
      // 舊版搜尋穿插著跑：「區域組合」這邊每做了 8 份工，就讓舊版從頭跑 1 份（額度每次加倍）。兩種搜法互補——
      // 鋪法極多、上界分不出好壞的板子上，舊版比較快碰到不錯的解。舊版要是整個跑完了，答案就確定了（回傳 true）。
      let legacySpent = nodes - nodes0, legacyNext = SEED_NODES * 8, setups = 0;
      const maybeLegacy = () => {
        if ((nodes - nodes0 - legacySpent) + 30 * setups < 8 * legacyNext) return false;
        const st = nodes;
        inPlan = false; bail = false; nodeLimit = nodes + legacyNext;
        dfsZone(0);
        legacySpent += nodes - st; legacyNext *= 2; inPlan = true;
        if (!stop && !bail) return true;
        bail = false;
        return false;
      };
      let budget = 2000, done = false;
      while (!stop && !done) {
        let pending = 0;
        for (let i = 0; i < nC && !stop; i++) {
          if (rbs[i] <= bestVal + 1e-9) break; // 依上界排序過：後面的也都不可能更好
          if (fin[i]) continue;
          setupT(masks[i]); setups++;
          bail = false; nodeLimit = nodes + budget;
          dfsT(0);
          if (stop) break;
          if (bail) pending++; else fin[i] = 1;
          if (maybeLegacy()) { done = true; break; }
        }
        if (!pending) break;
        budget *= 8;
      }
      bail = false; nodeLimit = Infinity;
    }

    if (order.length && M.length && !S.mustMissing.length && !S.baseUnreach) { if (plan.ok) runPlan(); else dfsZone(0); }
    return { best, bestVal, nodes, stop, stats };
  }

  function solve(prob, opts) {
    opts = opts || {};
    const S = prepare(prob);
    const t0 = Date.now();
    const { best, bestVal, nodes, stop, stats } = (opts.engine || searchJS)(S, opts, t0);
    const minA = S.minA, minD = S.minD, hasBase = minA > 0 || minD > 0;
    const pieces = best ? describePieces(S, best) : [];
    const score = best ? scoreExplicit(S, pieces.map((p) => ({ color: p.color, cells: p.cells, eff: p.eff }))) : null;
    // 有指定必觸發區域，卻找不到任何擺放：缺同色粒子，或（搜尋跑完時）在粒子數與懲罰限制內放不下
    const forced = { zones: S.mustIdx.slice(), missing: S.mustMissing.slice() };
    // 同理：有基礎攻防門檻卻找不到達標的擺放（門檻比所有區域加總還高，或在粒子數與懲罰限制內達不到）
    const base = { minAtk: minA, minDef: minD, capAtk: S.capA, capDef: S.capD, unreachable: S.baseUnreach };
    const infeasible = (S.mustIdx.length > 0 || hasBase) && !best && (S.mustMissing.length > 0 || S.baseUnreach || !stop);
    return {
      // value 取獨立計分的結果（搜尋內部為了讓「必觸發」的 0 價值區域仍會被填，加了極小的 MUST_EPS，不該出現在回報的數字裡）
      stats, value: score ? score.value : 0, internal: bestVal, pieces, score, nodes, ms: Date.now() - t0, finished: !stop, forced, base, infeasible,
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

  // 診斷：第 zi 個區域「單獨」能不能被填滿（只留這一個區域、必須填滿，其餘條件照舊）。
  // 回傳 { fillable: true／false／null（時間到、不確定）, colorOk, n（參考的粒子數）, ... }。
  // 用在「無解」時告訴使用者是哪些區域的粒子形狀／數量／顏色拼不出來。
  function diagnoseZone(prob, zi, timeLimitMs) {
    const z = prob.zones[zi];
    const one = Object.assign({}, prob, {
      zones: [Object.assign({}, z, { must: true, waive: 0 })],
      settings: Object.assign({}, prob.settings, { minBaseAtk: 0, minBaseDef: 0 }),
    });
    const r = solve(one, { timeLimitMs: timeLimitMs || 2000 });
    const colorOk = (prob.stacks || []).some((s) => s.color === z.color && s.cells && s.cells.length && expandEffs(s.effs).length > 0);
    const fillable = r.pieces.length > 0 ? true : (r.infeasible ? false : null);
    return { index: zi, name: z.name || '', color: z.color, size: z.cells.length, atk: z.atk || 0, def: z.def || 0, fillable, colorOk, n: r.pieces.length, finished: r.finished };
  }

  /* ------------------------------------------------------------------ */
  // 區域特性（特性槽 slot、卡牌範圍左 rl／右 rr）與任務條件「特性至少多少」。
  // 引擎只認「一定要觸發（must）」，所以特性門檻在引擎外面用分支定界處理（結果仍是最優）：
  // 節點＝一組「一定要填滿」的區域＋一組「不算它的特性」的區域。先解放寬的問題；解出來的特性已達標就是這個節點的最優解，
  // 否則挑一個還沒算到、又對缺的那項有貢獻的區域分兩支：(a) 一定要填滿它 (b) 不算它。值不比目前最好的高的節點直接剪掉。
  const TRAIT_KEYS = ['slot', 'rl', 'rr'];
  const RANGE_MAX = 4; // 遊戲的卡牌範圍左右各最多 4 格
  function traitTotals(prob, complete) {
    const t = { slot: 0, rl: 0, rr: 0 };
    for (const i of complete) { const z = prob.zones[i]; if (z) for (const k of TRAIT_KEYS) t[k] += Math.max(0, z[k] | 0); }
    t.rl = Math.min(RANGE_MAX, t.rl); t.rr = Math.min(RANGE_MAX, t.rr);
    return t;
  }
  const traitMet = (t, need) => t.slot >= (need.slot || 0) && t.rl >= (need.rl || 0) && t.rr >= (need.rr || 0);
  // solveFn(problem, limitMs, onImprove) → Promise<{ r, status }>（onImprove(b)：引擎每找到更好的解時呼叫，可不理它）（r 同 solve 的回傳；status 'proved'｜'timeout'｜'stopped'）
  // opts: { limitMs, score(pieces)→scoreExplicit 結果（沒給就自己 prepare）, onProgress({ms,best}), onImprove({pieces,value}), isCancelled(), nowFn }
  async function solveTraits(base, need, solveFn, opts) {
    opts = opts || {};
    const now = opts.nowFn || Date.now, t0 = now(), limitMs = opts.limitMs || 60000;
    const S0 = prepare(base);
    const scoreOf = opts.score || ((pieces) => scoreExplicit(S0, pieces.map((p) => ({ color: p.color, cells: p.cells, eff: p.eff }))));
    let best = null, bestVal = -Infinity, nodes = 0, anyTimeout = false, cancelled = false, solves = 0, lastStatus = '';
    const colors = new Set((base.stacks || []).filter((s) => expandEffs(s.effs).length && s.cells && s.cells.length).map((s) => s.color));
    const cand = [];
    base.zones.forEach((z, i) => { if (colors.has(z.color) && TRAIT_KEYS.some((k) => (z[k] | 0) > 0)) cand.push(i); });
    const potential = (excl, only) => { const t = { slot: 0, rl: 0, rr: 0 }; for (const i of (only || cand)) if (!excl.has(i)) for (const k of TRAIT_KEYS) t[k] += Math.max(0, base.zones[i][k] | 0); t.rl = Math.min(RANGE_MAX, t.rl); t.rr = Math.min(RANGE_MAX, t.rr); return t; };
    // 解一個「這些區域一定要填滿」的問題；引擎每找到更好的解就檢查（算分時排除 excl 的區域不計特性），達標的立刻記成目前最好、通知畫面
    const consider = (pieces, excl) => {
      const sc = scoreOf(pieces);
      if (sc.value <= bestVal + 1e-9) return { sc, ok: false };
      const tot = traitTotals(base, sc.completeZones.filter((i) => !excl.has(i)));
      if (!traitMet(tot, need)) return { sc, tot, ok: false };
      bestVal = sc.value; best = { pieces, score: sc };
      if (opts.onImprove) opts.onImprove({ pieces, value: sc.value });
      return { sc, tot, ok: true };
    };
    const run = async (forced, excl, ms) => {
      const prob = forced.size ? Object.assign({}, base, { zones: base.zones.map((z, i) => (forced.has(i) ? Object.assign({}, z, { must: true }) : z)) }) : base;
      const before = best;
      const res = await solveFn(prob, ms, (b) => { if (b && b.pieces && b.pieces.length) consider(b.pieces, excl); });
      solves++; nodes += res.r.nodes || 0;
      if (best !== before && !best.engine) { best.engine = res.r.engine; best.threads = res.r.threads; }
      if (opts.onProgress) opts.onProgress({ ms: now() - t0, best: Math.max(0, bestVal) });
      if (res.status === 'stopped') cancelled = true;
      lastStatus = res.status;
      const r = res.r;
      if (r.pieces && r.pieces.length) { const c = consider(r.pieces, excl); if (c.ok) { best.engine = r.engine; best.threads = r.threads; } return c; }
      return null;
    };
    // 先找出所有「剛好夠」的區域組合（拿掉任何一個就不達標）：任何達標的解都至少填滿其中一組，所以每一組各解一次（那些區域一定要填滿）
    // 就一定不漏；而且每個解出來的解都已經達標，畫面上很快就有可用的答案（比先解沒限制的放寬問題快很多）。組合太多才改用分支定界。
    const covers = [], MAX_COVERS = opts.maxCovers != null ? opts.maxCovers : 48; let tooMany = false;
    (function gen(i, chosen) {
      if (tooMany) return;
      if (traitMet(potential(new Set(), chosen), need)) {
        if (chosen.every((m) => !traitMet(potential(new Set(), chosen.filter((x) => x !== m)), need))) { covers.push(chosen.slice()); if (covers.length > MAX_COVERS) tooMany = true; }
        return;
      }
      if (i >= cand.length || !traitMet(potential(new Set(), chosen.concat(cand.slice(i))), need)) return;
      chosen.push(cand[i]); gen(i + 1, chosen); chosen.pop();
      gen(i + 1, chosen);
    })(0, []);
    const stack = [];
    if (!tooMany) {
      const size = (c) => c.reduce((a, i) => a + base.zones[i].cells.length, 0);
      covers.sort((a, b) => size(a) - size(b));
      // 輪流給每一組一點時間，沒解完的下一輪把時間放大（×4）再來：容易的組合很快就有達標的解可以先給你看，難的才慢慢跑
      let pending = covers.map((_, i) => i), budget = Math.max(300, Math.round(limitMs / (covers.length * 40)));
      while (pending.length && !cancelled) {
        const still = [];
        for (let k = 0; k < pending.length; k++) {
          if (opts.isCancelled && opts.isCancelled()) { cancelled = true; break; }
          const left = limitMs - (now() - t0);
          if (left <= 50) { still.push(...pending.slice(k)); break; }
          await run(new Set(covers[pending[k]]), new Set(), Math.min(left, budget));
          if (cancelled) break;
          if (lastStatus !== 'proved') still.push(pending[k]);
        }
        pending = still; budget *= 4;
        if (limitMs - (now() - t0) <= 50) break;
      }
      if (pending.length) anyTimeout = true;
    } else {
      stack.push({ forced: new Set(), excl: new Set() });
      while (stack.length) {
        if (opts.isCancelled && opts.isCancelled()) { cancelled = true; break; }
        const node = stack.pop();
        if (!traitMet(potential(node.excl), need)) continue; // 連全部（沒被排除的）都填滿也達不到
        // 「非填不可」的區域（沒有它就達不到門檻）直接當成一定要填滿，不用分支
        { let forced = node.forced;
          for (const i of cand) {
            if (forced.has(i) || node.excl.has(i)) continue;
            const ex = new Set(node.excl); ex.add(i);
            if (!traitMet(potential(ex), need)) { if (forced === node.forced) forced = new Set(forced); forced.add(i); }
          }
          node.forced = forced; }
        const left = limitMs - (now() - t0);
        if (left <= 50) { anyTimeout = true; stack.push(node); break; }
        const c = await run(node.forced, node.excl, Math.max(300, Math.min(left, Math.round(left / 3))));
        if (cancelled) break;
        if (lastStatus === 'timeout') anyTimeout = true;
        if (!c || c.ok || c.sc.value <= bestVal + 1e-9 && !c.ok && c.tot === undefined) continue; // 無解／已達標（最優）／上界不比目前最好的高
        const tot = c.tot, deficit = { slot: (need.slot || 0) - tot.slot, rl: (need.rl || 0) - tot.rl, rr: (need.rr || 0) - tot.rr };
        const done = new Set(c.sc.completeZones.filter((i) => !node.excl.has(i)));
        const opt = cand.filter((i) => !done.has(i) && !node.forced.has(i) && !node.excl.has(i) && TRAIT_KEYS.some((k) => deficit[k] > 0 && (base.zones[i][k] | 0) > 0));
        if (!opt.length) continue;
        const gain = (i) => TRAIT_KEYS.reduce((a, k) => a + Math.min(Math.max(0, deficit[k]), base.zones[i][k] | 0), 0) / base.zones[i].cells.length;
        opt.sort((a, b) => gain(b) - gain(a));
        const z = opt[0];
        stack.push({ forced: node.forced, excl: new Set([...node.excl, z]) }); // 後進先出：先處理「一定要填滿」那支
        stack.push({ forced: new Set([...node.forced, z]), excl: node.excl });
      }
    }
    const unfinished = cancelled || anyTimeout || stack.length > 0, ms = now() - t0;
    const status = cancelled ? 'stopped' : unfinished ? 'timeout' : 'proved';
    if (!best) return { r: { pieces: [], nodes, ms, finished: !unfinished, infeasible: !unfinished, solves }, status };
    return { r: { pieces: best.pieces, score: best.score, value: bestVal, nodes, ms, finished: !unfinished, engine: best.engine, threads: best.threads, solves }, status };
  }

  return { solve, solveTraits, traitTotals, traitMet, TRAIT_KEYS, RANGE_MAX, searchJS, buildPlan, describePieces, prepare, scoreExplicit, evaluatePlacement, diagnoseZone, orientations, normalize, rot60, NEIGH, goalWeights, filterColors };
});
