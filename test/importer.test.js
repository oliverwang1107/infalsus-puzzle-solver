'use strict';
const assert = require('assert');
const path = require('path');
const { decodePNG } = require('./png.js');
const Imp = require('../src/importer.js');

let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); pass++; console.log('  ok  ', name); } catch (e) { fail++; console.log('  FAIL', name, '\n      ', e.message); }
}
const fx = (n) => decodePNG(path.join(__dirname, 'fixtures', n + '.png'));

// 轉成「軸向座標＋正規化平移」的集合，讓兩份座標只差一個平移也能比較
function canon(cellsByKey) {
  const ax = Object.entries(cellsByKey).map(([k, t]) => { const [c, r] = k.split(',').map(Number); return [c, r - ((c - (c & 1)) >> 1), t]; });
  const mq = Math.min(...ax.map((a) => a[0])), mr = Math.min(...ax.map((a) => a[1]));
  return ax.map((a) => (a[0] - mq) + ',' + (a[1] - mr) + ':' + a[2]).sort();
}
// 簡單雙線性縮放（測試不同解析度）
function resize(img, f) {
  const w = Math.round(img.width * f), h = Math.round(img.height * f), ch = img.channels;
  const out = Buffer.alloc(w * h * ch);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const sx = (x + 0.5) / f - 0.5, sy = (y + 0.5) / f - 0.5;
    const x0 = Math.max(0, Math.floor(sx)), y0 = Math.max(0, Math.floor(sy)), x1 = Math.min(img.width - 1, x0 + 1), y1 = Math.min(img.height - 1, y0 + 1);
    const fx_ = Math.min(1, Math.max(0, sx - x0)), fy_ = Math.min(1, Math.max(0, sy - y0));
    for (let c = 0; c < ch; c++) {
      const g = (xx, yy) => img.data[(yy * img.width + xx) * ch + c];
      out[(y * w + x) * ch + c] = Math.round(g(x0, y0) * (1 - fx_) * (1 - fy_) + g(x1, y0) * fx_ * (1 - fy_) + g(x0, y1) * (1 - fx_) * fy_ + g(x1, y1) * fx_ * fy_);
    }
  }
  return { width: w, height: h, channels: ch, data: out };
}

console.log('截圖偵測：新朋友（完整可見的板子）');
const xin = fx('board_xin_peng_you');
const r1 = Imp.detectBoard(xin);
check('格距接近 55.4（六角形半徑 32 px）', () => assert.ok(Math.abs(r1.lattice.d - 55.4) < 1.2, 'd=' + r1.lattice.d));
check('共 125 格：灰 86、紅 15、藍 15、紫 9', () => {
  assert.strictEqual(Object.keys(r1.cells).length, 125);
  assert.deepStrictEqual([r1.counts.gray, r1.counts[1], r1.counts[4], r1.counts[5]], [86, 15, 15, 9]);
});
check('5 個區域：藍 7、藍 8、紫 9、紅 8、紅 7（與遊戲計數 0/7、0/8、0/9、0/8、0/7 一致）', () => {
  assert.deepStrictEqual(r1.zones.map((z) => z.color + ':' + z.size), ['4:7', '4:8', '5:9', '1:8', '1:7']);
});
check('與手動轉錄的 data/recipe_xin_peng_you.json 逐格一致', () => {
  const manual = require('../data/recipe_xin_peng_you.json');
  const mc = {}; for (const [k, v] of Object.entries(manual.board)) mc[k] = v.t;
  assert.deepStrictEqual(canon(r1.cells), canon(mc));
});
check('縮放成 80% 解析度也能自動找出格距並得到同樣結果', () => {
  const r = Imp.detectBoard(resize(xin, 0.8));
  assert.ok(Math.abs(r.lattice.d - 55.4 * 0.8) < 1.2, 'd=' + r.lattice.d);
  assert.deepStrictEqual(canon(r.cells), canon(r1.cells));
});
check('縮放成 120% 解析度也能自動找出格距並得到同樣結果', () => {
  const r = Imp.detectBoard(resize(xin, 1.2));
  assert.deepStrictEqual(canon(r.cells), canon(r1.cells));
});

console.log('\n截圖偵測：脫離常軌的自由（提示框蓋住下半部，只能驗證看得到的部分）');
const r2 = Imp.detectBoard(fx('board_tuo_li_chang_gui'));
const zs = r2.zones.map((z) => z.color + ':' + z.size);
check('上半部完整：紅 7、紅 2、紅 2、紫 1', () => {
  assert.strictEqual(zs.filter((z) => z === '1:7').length, 1);
  assert.strictEqual(zs.filter((z) => z === '1:2').length, 2);
  assert.ok(zs.includes('5:1'));
});
check('有偵測到黃色與綠色區域（下半部）', () => {
  assert.ok(r2.counts[2] >= 3, '黃 ' + r2.counts[2]);
  assert.ok(r2.counts[3] >= 3, '綠 ' + r2.counts[3]);
});

console.log('\n截圖偵測：找尋夥伴的溫暖目光（綠、黃區域；棋盤被遊戲放大，格距和前兩張不同）');
const r3 = Imp.detectBoard(fx('board_zhao_xun_huo_ban'));
check('自動適應較大的格距（≈62 px，不是 55 px）', () => assert.ok(Math.abs(r3.lattice.d - 62.2) < 1.5, 'd=' + r3.lattice.d));
check('共 40 格：灰 12、黃 11、綠 17', () => {
  assert.strictEqual(Object.keys(r3.cells).length, 40);
  assert.deepStrictEqual([r3.counts.gray, r3.counts[2], r3.counts[3]], [12, 11, 17]);
});
check('7 個區域：綠 1、綠 10、綠 1、綠 4、綠 1、黃 10、黃 1（與遊戲計數 0/1、0/10、0/1、0/4、0/1、0/10、0/1 一致）', () => {
  assert.deepStrictEqual(r3.zones.map((z) => z.color + ':' + z.size), ['3:1', '3:10', '3:1', '3:4', '3:1', '2:10', '2:1']);
});

console.log('\n' + pass + ' 通過, ' + fail + ' 失敗');
process.exit(fail ? 1 : 0);
