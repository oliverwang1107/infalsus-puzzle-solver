'use strict';
// 檢查「建置出來的 infalsus_solver.html」裡內建的預設粒子庫存與預設配方是否完好
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Solver = require('../src/solver.js');

let pass = 0, fail = 0;
function check(name, fn) { try { fn(); pass++; console.log('  ok  ', name); } catch (e) { fail++; console.log('  FAIL', name, '\n      ', e.message); } }

const html = fs.readFileSync(path.join(__dirname, '..', 'infalsus_solver.html'), 'utf8');
const m = html.match(/<script id="presets-json" type="application\/json">([\s\S]*?)<\/script>/);
assert.ok(m, '網頁裡找不到 presets-json（請先 node build.js）');
const B = JSON.parse(m[1]);
const connected = (cells) => {
  const set = new Set(cells.map((c) => c.join(',')));
  const seen = new Set([cells[0].join(',')]); const st = [cells[0]];
  while (st.length) { const c = st.pop(); for (const d of Solver.NEIGH) { const k = (c[0] + d[0]) + ',' + (c[1] + d[1]); if (set.has(k) && !seen.has(k)) { seen.add(k); st.push([c[0] + d[0], c[1] + d[1]]); } } }
  return seen.size === set.size;
};

console.log('內建預設資料');
const latest = B.inventories[0], earlier = B.inventories[1];
check('最新庫存：五色各 6 種共 30 種，編號不重複', () => {
  assert.strictEqual(latest.stacks.length, 30);
  assert.strictEqual(new Set(latest.stacks.map((s) => s.id)).size, 30);
  for (let c = 0; c < 5; c++) assert.strictEqual(latest.stacks.filter((s) => s.color === c).length, 6, '顏色 ' + c);
});
check('每種粒子：形狀相連、效能與數量和 effText 一致、形狀已正規化', () => {
  for (const s of [...latest.stacks, ...earlier.stacks]) {
    assert.ok(connected(s.shape), s.id + ' 形狀不相連');
    assert.strictEqual(s.effText, s.efficacy + 'x' + s.count, s.id);
    assert.deepStrictEqual(Solver.normalize(s.shape), s.shape, s.id + ' 形狀未正規化');
  }
});
check('較早庫存 12 種（紅 6、紫 6），形狀與最新庫存的同編號完全相同', () => {
  assert.strictEqual(earlier.stacks.length, 12);
  for (const s of earlier.stacks) {
    const t = latest.stacks.find((x) => x.id === s.id);
    assert.ok(t, s.id + ' 在最新庫存找不到');
    assert.deepStrictEqual(s.shape, t.shape, s.id);
  }
});
check('同顏色的粒子形狀彼此不重複（不會變成同一堆）', () => {
  const keys = latest.stacks.map((s) => s.color + '|' + JSON.stringify(s.shape));
  assert.strictEqual(new Set(keys).size, keys.length);
});
check('預設配方：「找尋夥伴的溫暖目光」40 格 7 區、上限 8；「新朋友」125 格 5 區、上限 6', () => {
  const [a, b] = B.recipes;
  assert.strictEqual(a.name, '找尋夥伴的溫暖目光'); assert.strictEqual(Object.keys(a.board).length, 40); assert.strictEqual(a.zv.length, 7); assert.strictEqual(a.limit, 8);
  assert.strictEqual(b.name, '新朋友'); assert.strictEqual(Object.keys(b.board).length, 125); assert.strictEqual(b.zv.length, 5); assert.strictEqual(b.limit, 6);
});
check('預設配方的每個區域格子都在板子上', () => {
  for (const r of B.recipes) for (const z of r.zv) for (const k of z.keys) assert.ok(r.board[k], r.name + ' 區域格 ' + k + ' 不在板子上');
});
check('網頁不使用 eval（在限制較多的環境也能執行）', () => assert.ok(!/\beval\s*\(/.test(html), '網頁裡還有 eval('));

console.log('\n' + pass + ' 通過, ' + fail + ' 失敗');
process.exit(fail ? 1 : 0);
