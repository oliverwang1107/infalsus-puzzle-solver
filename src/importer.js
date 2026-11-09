/*
 * 從製作畫面截圖偵測板子（純 JS，無相依；瀏覽器與 Node 都能跑）
 *
 * 輸入：{ width, height, data, channels }（data 為 RGB 或 RGBA 的位元組陣列）
 * 輸出：{ cells: {"欄,列": t}, zones, counts, lattice, debug }
 *   t：0 空白區（灰）、1 紅、2 黃、3 綠、4 藍、5 紫
 *   座標與介面相同：平頂六角格、奇數欄下移半格。
 *
 * 做法
 *   1. 格線週期：整張圖（含板外淡淡的格線）都是同一組六角格線，用「格線邊中點的高通亮度」對
 *      格距與相位做搜尋，得到晶格。
 *   2. 逐格取樣：格子內部顏色 + 邊框亮度，判斷是不是板上格子、什麼顏色。
 *   3. 修正：被區域計數標籤（0/8 之類）蓋住格心的色格，用相鄰同色格回推。
 *   4. 只保留「連到至少一個色格」的連通塊，丟掉畫面上其他 UI 被誤判的零星格子。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.InfalsusImporter = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const SQ3 = Math.sqrt(3);
  // 實測：2000×1250 的截圖，垂直相鄰格心距離 = 56 px
  const D_RATIO = 56 / 1250;
  const GRAY = 0;

  // 色相 → 顏色代碼（1 紅、2 黃、3 綠、4 藍、5 紫）；飽和度不足 → 0
  function classifyRGB(r, g, b) {
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), sum = r + g + b;
    if (mx - mn >= 38 && mx >= 48) {
      let h;
      const dlt = mx - mn;
      if (mx === r) h = 60 * (((g - b) / dlt + 6) % 6);
      else if (mx === g) h = 60 * ((b - r) / dlt + 2);
      else h = 60 * ((r - g) / dlt + 4);
      if (h >= 330 || h < 20) return 1;
      if (h >= 30 && h < 85) return 2;
      // 實測色相：紅 343–347、黃 68–71、綠（偏青綠）≈177、藍 197–200、紫 267–274
      if (h >= 95 && h < 188) return 3;
      if (h >= 188 && h < 225) return 4;
      if (h >= 240 && h < 320) return 5;
      return -1; // 其他色相：不確定
    }
    return sum > 110 && mx - mn < 38 ? GRAY : -1;
  }

  function detectBoard(img, opts) {
    opts = opts || {};
    const W = img.width, H = img.height, ch = img.channels || 4, px = img.data;
    const N = W * H;

    /* ---------- 1. 高通亮度（線條強度） ---------- */
    const lum = new Float32Array(N);
    for (let i = 0, p = 0; i < N; i++, p += ch) lum[i] = 0.299 * px[p] + 0.587 * px[p + 1] + 0.114 * px[p + 2];
    const iw = W + 1;
    const integ = new Float64Array(iw * (H + 1));
    for (let y = 0; y < H; y++) {
      let row = 0;
      for (let x = 0; x < W; x++) { row += lum[y * W + x]; integ[(y + 1) * iw + x + 1] = integ[y * iw + x + 1] + row; }
    }
    const E0 = new Float32Array(N);
    const rad = 4;
    for (let y = 0; y < H; y++) {
      const y0 = Math.max(0, y - rad), y1 = Math.min(H - 1, y + rad);
      for (let x = 0; x < W; x++) {
        const x0 = Math.max(0, x - rad), x1 = Math.min(W - 1, x + rad);
        const s = integ[(y1 + 1) * iw + x1 + 1] - integ[y0 * iw + x1 + 1] - integ[(y1 + 1) * iw + x0] + integ[y0 * iw + x0];
        const v = lum[y * W + x] - s / ((x1 - x0 + 1) * (y1 - y0 + 1));
        E0[y * W + x] = v > 0 ? v : 0;
      }
    }
    // 3×3 最大值（容許半像素以內的誤差）
    const Eh = new Float32Array(N), E = new Float32Array(N);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      let m = E0[y * W + x];
      if (x > 0 && E0[y * W + x - 1] > m) m = E0[y * W + x - 1];
      if (x < W - 1 && E0[y * W + x + 1] > m) m = E0[y * W + x + 1];
      Eh[y * W + x] = m;
    }
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      let m = Eh[y * W + x];
      if (y > 0 && Eh[(y - 1) * W + x] > m) m = Eh[(y - 1) * W + x];
      if (y < H - 1 && Eh[(y + 1) * W + x] > m) m = Eh[(y + 1) * W + x];
      E[y * W + x] = m;
    }

    /* ---------- 2. 晶格搜尋 ---------- */
    const roi = { x0: 0.18 * W, x1: 0.82 * W, y0: 0.1 * H, y1: 0.85 * H };
    function score(d, ox, oy) {
      const R = d / SQ3, pxs = 1.5 * R, a = d / 2, hx = 0.75 * R, hy = d / 4;
      let sum = 0, cnt = 0;
      const iMin = Math.floor((roi.x0 - ox) / pxs) - 1, iMax = Math.ceil((roi.x1 - ox) / pxs) + 1;
      for (let i = iMin; i <= iMax; i++) {
        const cx = ox + pxs * i, off = (i & 1) ? d / 2 : 0;
        const jMin = Math.floor((roi.y0 - oy - off) / d) - 1, jMax = Math.ceil((roi.y1 - oy - off) / d) + 1;
        for (let j = jMin; j <= jMax; j++) {
          const cy = oy + d * j + off;
          if (cx - hx < roi.x0 || cx + hx > roi.x1 || cy < roi.y0 || cy + a > roi.y1) continue;
          sum += E[Math.round(cy + a) * W + Math.round(cx)]
               + E[Math.round(cy + hy) * W + Math.round(cx + hx)]
               + E[Math.round(cy + hy) * W + Math.round(cx - hx)];
          cnt += 3;
        }
      }
      return cnt ? sum / cnt : 0;
    }
    if (opts.probe) opts.probe({ score, E, W, H });
    const d0 = D_RATIO * H;
    let best = { s: -1, d: d0, ox: 0, oy: 0 };
    const dLo = opts.d ? opts.d : d0 * 0.7, dHi = opts.d ? opts.d : d0 * 1.3, dStep = opts.d ? 1 : Math.max(0.75, d0 / 56);
    for (let d = dLo; d <= dHi + 1e-9; d += dStep) {
      const pxs = 1.5 * d / SQ3;
      for (let ox = 0; ox < pxs; ox += 2) for (let oy = 0; oy < d; oy += 2) {
        const s = score(d, ox, oy);
        if (s > best.s) best = { s, d, ox, oy };
      }
    }
    // 細修
    const c0 = best;
    for (let d = c0.d - (opts.d ? 0 : 1.5); d <= c0.d + (opts.d ? 0 : 1.5) + 1e-9; d += 0.25) {
      for (let ox = c0.ox - 2.5; ox <= c0.ox + 2.5; ox += 0.5) for (let oy = c0.oy - 2.5; oy <= c0.oy + 2.5; oy += 0.5) {
        const s = score(d, ox, oy);
        if (s > best.s) best = { s, d, ox, oy };
      }
      if (opts.d) break;
    }
    const d = best.d, R = d / SQ3, pxs = 1.5 * R, a = d / 2, hx = 0.75 * R, hy = d / 4;
    const ox = best.ox, oy = best.oy;

    /* ---------- 3. 逐格分類 ---------- */
    const sc = d / 56, br = Math.max(1, Math.round(2 * sc));
    function box(x, y, r) {
      const cx = Math.round(x), cy = Math.round(y);
      let sr = 0, sg = 0, sb = 0, n = 0;
      for (let yy = cy - r; yy <= cy + r; yy++) for (let xx = cx - r; xx <= cx + r; xx++) {
        if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
        const p = (yy * W + xx) * ch; sr += px[p]; sg += px[p + 1]; sb += px[p + 2]; n++;
      }
      return n ? [sr / n, sg / n, sb / n] : [0, 0, 0];
    }
    const med4 = (v) => { const s = v.slice().sort((p, q) => p - q); return (s[1] + s[2]) / 2; };
    const cells = new Map(); // "i,j" → {i,j,x,y,k}
    // 棋盤只會出現在左右 UI 面板之間、上方按鈕列與底部「色彩」分頁列之間
    const bx0 = 0.175 * W, bx1 = 0.835 * W, by0 = 0.1 * H, by1 = 0.805 * H;
    const iMin = Math.floor((bx0 - ox) / pxs), iMax = Math.ceil((bx1 - ox) / pxs);
    for (let i = iMin; i <= iMax; i++) {
      const x = ox + pxs * i, off = (i & 1) ? d / 2 : 0;
      const jMin = Math.floor((by0 - oy - off) / d), jMax = Math.ceil((by1 - oy - off) / d);
      for (let j = jMin; j <= jMax; j++) {
        const y = oy + d * j + off;
        if (x < bx0 || x > bx1 || y < by0 || y > by1) continue;
        const up = box(x, y - 0.32 * d, br), dn = box(x, y + 0.32 * d, br), le = box(x - 0.36 * d, y, br), ri = box(x + 0.36 * d, y, br);
        const c4 = [0, 1, 2].map((q) => med4([up[q], dn[q], le[q], ri[q]]));
        let edge = 0;
        for (const [ex, ey] of [[x, y - a], [x, y + a], [x + hx, y - hy], [x - hx, y - hy], [x + hx, y + hy], [x - hx, y + hy]]) {
          const e = box(ex, ey, 1); const s = e[0] + e[1] + e[2]; if (s > edge) edge = s;
        }
        const k = classifyRGB(c4[0], c4[1], c4[2]);
        if (k < 0) continue;
        // 灰格要靠邊框亮度和板外區分（板外也有淡淡的格線）；色格的色差本身就足以判定，
        // 而且縮小圖片後暗色格的邊框會變細變暗，不能拿邊框亮度卡它
        if (k === GRAY && edge <= 150) continue;
        cells.set(i + ',' + j, { i, j, x, y, k });
      }
    }
    const nbrs = (i, j) => (i & 1)
      ? [[i + 1, j], [i + 1, j + 1], [i - 1, j], [i - 1, j + 1], [i, j - 1], [i, j + 1]]
      : [[i + 1, j - 1], [i + 1, j], [i - 1, j - 1], [i - 1, j], [i, j - 1], [i, j + 1]];
    // 被標籤蓋住格心的色格：看格內四個角落點（避開標籤）投票，且至少 2 個相鄰格是同色
    for (const c of cells.values()) {
      if (c.k !== GRAY) continue;
      const votes = [0, 0, 0, 0, 0, 0];
      for (const [dx, dy] of [[-0.2, -0.36], [0.2, -0.36], [-0.2, 0.36], [0.2, 0.36]]) {
        const v = box(c.x + dx * d, c.y + dy * d, br);
        const kk = classifyRGB(v[0], v[1], v[2]);
        if (kk > 0) votes[kk]++;
      }
      let k2 = 0;
      for (let q = 1; q <= 5; q++) if (votes[q] >= 2 && (!k2 || votes[q] > votes[k2])) k2 = q;
      if (!k2) continue;
      let same = 0;
      for (const [ni, nj] of nbrs(c.i, c.j)) { const n = cells.get(ni + ',' + nj); if (n && n.k === k2) same++; }
      if (same >= 2) c.k = k2;
    }

    /* ---------- 4. 只留下連到色格的連通塊 ---------- */
    const seen = new Set(), keep = [];
    for (const c0c of cells.values()) {
      const key0 = c0c.i + ',' + c0c.j;
      if (seen.has(key0)) continue;
      const comp = [c0c]; seen.add(key0);
      for (let q = 0; q < comp.length; q++) {
        for (const [ni, nj] of nbrs(comp[q].i, comp[q].j)) {
          const kk = ni + ',' + nj, n = cells.get(kk);
          if (n && !seen.has(kk)) { seen.add(kk); comp.push(n); }
        }
      }
      // 真正的板子連通塊很大；畫面其他 UI 的誤判通常只有 1～3 格
      if (comp.length >= (opts.minComponent || 6) && comp.some((c) => c.k > 0)) keep.push(...comp);
    }

    /* ---------- 5. 轉成介面座標 ---------- */
    const out = { cells: {}, zones: [], counts: { gray: 0, 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 }, lattice: { d, ox, oy, score: best.s }, debug: { cells: keep.map((c) => ({ x: c.x, y: c.y, k: c.k })) } };
    if (!keep.length) return out;
    let i0 = Math.min(...keep.map((c) => c.i)); if (i0 & 1) i0 -= 1;
    const j0 = Math.min(...keep.map((c) => c.j));
    const grid = new Map();
    for (const c of keep) {
      const col = c.i - i0, row = c.j - j0;
      out.cells[col + ',' + row] = c.k;
      grid.set(col + ',' + row, c.k);
      out.counts[c.k === 0 ? 'gray' : c.k]++;
    }
    // 分區（同色相連），編號順序與介面一致：先欄後列
    const nb2 = (c, r) => (c & 1)
      ? [[c + 1, r], [c + 1, r + 1], [c - 1, r], [c - 1, r + 1], [c, r - 1], [c, r + 1]]
      : [[c + 1, r - 1], [c + 1, r], [c - 1, r - 1], [c - 1, r], [c, r - 1], [c, r + 1]];
    const keys = Object.keys(out.cells).sort((p, q) => { const a1 = p.split(',').map(Number), b1 = q.split(',').map(Number); return a1[0] - b1[0] || a1[1] - b1[1]; });
    const zs = new Set();
    for (const k of keys) {
      const t = out.cells[k]; if (t < 1 || zs.has(k)) continue;
      const comp = [k]; zs.add(k);
      for (let q = 0; q < comp.length; q++) {
        const [c, r] = comp[q].split(',').map(Number);
        for (const [nc, nr] of nb2(c, r)) { const nk = nc + ',' + nr; if (grid.get(nk) === t && !zs.has(nk)) { zs.add(nk); comp.push(nk); } }
      }
      out.zones.push({ color: t, size: comp.length });
    }
    return out;
  }

  return { detectBoard, classifyRGB, D_RATIO };
});
