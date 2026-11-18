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
const latest30 = B.inventories[0], latest = B.inventories[1];
check('內建庫存只有 30 種與 40 種兩組（較早庫存已拿掉）', () => assert.strictEqual(B.inventories.length, 2));
check('內建庫存分成兩組：30 種（一般粒子，不含額外粒子）和 40 種（含額外粒子）；兩組相同編號的粒子完全一樣', () => {
  assert.strictEqual(latest30.stacks.length, 30); assert.ok(latest30.stacks.every((s) => !s.extra));
  assert.strictEqual(latest.stacks.length, 40); assert.strictEqual(latest.stacks.filter((s) => s.extra).length, 10);
  for (const s of latest30.stacks) assert.deepStrictEqual(s, latest.stacks.find((t) => t.id === s.id), s.id);
  assert.strictEqual(latest30.id, 'latest'); // 舊存檔記的 presetSet 'latest' 仍然有效（＝30 種）
});
check('最新庫存：預設 30 種（五色各 6 種）＋額外 10 種（每色 2 種、6～8 格、預設不加入），編號不重複', () => {
  assert.strictEqual(latest.stacks.length, 40);
  assert.strictEqual(new Set(latest.stacks.map((s) => s.id)).size, 40);
  for (let c = 0; c < 5; c++) {
    assert.strictEqual(latest.stacks.filter((s) => s.color === c && !s.extra).length, 6, '顏色 ' + c);
    const ex = latest.stacks.filter((s) => s.color === c && s.extra);
    assert.strictEqual(ex.length, 2, '額外 顏色 ' + c);
    for (const s of ex) assert.ok(s.shape.length >= 6 && s.shape.length <= 8, s.id + ' 格數 ' + s.shape.length);
  }
});
check('額外粒子：效能欄位與 effText 一致（最高值、總顆數）', () => {
  const parse = (t) => t.split(',').map((x) => x.trim().split('x').map(Number));
  for (const s of latest.stacks.filter((q) => q.extra)) {
    const e = parse(s.effText);
    assert.strictEqual(s.efficacy, Math.max(...e.map((x) => x[0])), s.id);
    assert.strictEqual(s.count, e.reduce((a, x) => a + x[1], 0), s.id);
  }
});
check('額外粒子都能被求解器放進板子（旋轉關閉）', () => {
  for (const s of latest.stacks.filter((q) => q.extra)) {
    const cells = s.shape.map((c) => c.slice());
    const r = Solver.solve({ cells, zones: [{ color: s.color, cells, atk: 100, def: 100 }], stacks: [{ color: s.color, cells: s.shape, effs: [{ v: 100, n: 1 }] }], settings: { limit: 4, rotation: false } }, { timeLimitMs: 300 });
    assert.ok(r && r.value > 0, s.id + ' 放不進自己形狀的板子');
  }
});
check('每種粒子：形狀相連、形狀已正規化；預設的效能與數量和 effText 一致', () => {
  for (const s of latest.stacks) {
    assert.ok(connected(s.shape), s.id + ' 形狀不相連');
    if (!s.extra) assert.strictEqual(s.effText, s.efficacy + 'x' + s.count, s.id);
    assert.deepStrictEqual(Solver.normalize(s.shape), s.shape, s.id + ' 形狀未正規化');
  }
});
check('首次開啟只載入預設的 30 種（額外粒子不預設開啟）', () => {
  assert.ok(html.includes('inv.stacks.filter((p) => !p.extra)'), 'firstRun 沒有排除額外粒子');
});
check('擺放說明的小地圖：整顆被後面粒子蓋住、或放在板外的粒子也要畫得出來（曾因此整段「怎麼擺」消失）', () => {
  assert.ok(html.includes('pieces[hi].qr.forEach((c) => owner.set('), '小地圖沒有以被選粒子自己的格子為準');
  assert.ok(html.includes('onBoard.has(k)'), '小地圖沒有把板外的格子算進去');
});
check('同顏色的粒子形狀彼此不重複（不會變成同一堆）', () => {
  const keys = latest.stacks.map((s) => s.color + '|' + JSON.stringify(s.shape));
  assert.strictEqual(new Set(keys).size, keys.length);
});
check('預設配方：「找尋夥伴的溫暖目光」40 格 7 區、上限 8；「新朋友」125 格 5 區（用 data/maps.json 裡使用者存的版本：上限 9）', () => {
  const [a, b] = B.recipes;
  assert.strictEqual(a.name, '找尋夥伴的溫暖目光'); assert.strictEqual(Object.keys(a.board).length, 40); assert.strictEqual(a.zv.length, 7); assert.strictEqual(a.limit, 8);
  assert.strictEqual(b.name, '新朋友'); assert.strictEqual(Object.keys(b.board).length, 125); assert.strictEqual(b.zv.length, 5); assert.strictEqual(b.limit, 9);
});
check('內建地圖：使用者存的 24 張都在（含永遠陪在你身旁 110 格 14 區、上限 18）、名稱不重複、會合併進預設配方', () => {
  const maps = require('../data/maps.json').recipes;
  assert.strictEqual(Object.keys(maps).length, 24);
  const names = B.recipes.map((r) => r.name);
  assert.strictEqual(new Set(names).size, names.length, '內建地圖名稱重複');
  for (const n of Object.keys(maps)) assert.ok(names.includes(n), '缺少內建地圖 ' + n);
  assert.strictEqual(B.recipes.length, 25); // 24 張＋「找尋夥伴的溫暖目光」
  const y = B.recipes.find((r) => r.name === '永遠陪在你身旁');
  assert.strictEqual(Object.keys(y.board).length, 110); assert.strictEqual(y.zv.length, 14); assert.strictEqual(y.limit, 18);
  assert.ok(y.zv.some((z) => z.atk > 0 || z.def > 0), '區域數值沒帶進來');
});
check('內建地圖與自己的存檔同名時只列一次（以存檔為準）', () => {
  assert.ok(html.includes('.filter(([, n]) => !state.recipes[n])'), '下拉選單沒有去除同名內建地圖');
});
check('預設配方的每個區域格子都在板子上', () => {
  for (const r of B.recipes) for (const z of r.zv) for (const k of z.keys) assert.ok(r.board[k], r.name + ' 區域格 ' + k + ' 不在板子上');
});
check('網頁不使用 eval（在限制較多的環境也能執行）', () => assert.ok(!/\beval\s*\(/.test(html), '網頁裡還有 eval('));
check('卡牌紀錄：求解完成會記錄、重設不清紀錄（介面行為在瀏覽器實測過，這裡只擋被誤刪）', () => {
  for (const s of ['id="tab-cards"', 'function logCard', 'if (has) logCard(run)', 'keepCards', 'btnCardsCsv']) assert.ok(html.includes(s), '缺少 ' + s);
});
check('擺放說明：每顆有步驟卡片＋小地圖，並有放完後的檢查數字（介面行為在瀏覽器實測過）', () => {
  for (const s of ['function renderGuide', 'function miniMap', 'function pieceCover', "h('div', 'verify')"]) assert.ok(html.includes(s), '缺少 ' + s);
});
check('合併區域：介面有合併／拆開、求解前把格子相加成一個區域（行為在瀏覽器實測過，這裡只擋被誤刪）', () => {
  for (const s of ['function linkMerges', 'function setMerge', 'const effZones', "h('div', 'zmerge')", 'src: z.members.slice()', 'effZones().map(', 'mg: z.mg']) assert.ok(html.includes(s), '缺少 ' + s);
});
check('區域特性：介面有特性槽／範圍欄位與任務條件門檻，求解走 Solver.solveTraits（行為在瀏覽器實測過，這裡只擋被誤刪）', () => {
  for (const s of ['id="sMinSlot"', 'id="sMinRL"', 'id="sMinRR"', 'class="zt"', 'function solveTraits', 'Solver.solveTraits(', 'function traitRows', 'minSlots: traitNeed(st).slot']) assert.ok(html.includes(s), '缺少 ' + s);
});
check('固定免除只有超界、重疊、乖離（整體、過載拿掉了）', () => {
  const m = html.match(/class="gwrow"[\s\S]*?<\/span>/)[0];
  assert.deepStrictEqual([...m.matchAll(/data-t="(\w+)"/g)].map((x) => x[1]), ['out', 'overlap', 'disc']);
});
check('介面整理：同樣功能只留一個入口（地圖存檔／刪除在地圖分頁、載入在上方選單、匯出匯入在「更多」）', () => {
  for (const s of ['btnRecipeSave', 'btnRecipeDel', 'btnDemo', 'id="fileMaps"', 'id="recipeName"']) assert.ok(!html.includes(s), '還有重複的 ' + s);
  for (const s of ['id="btnMapSave"', 'id="btnRecipeLoad"', 'id="btnMapsExport"', 'id="fileImport"', 'id="btnMapCsv"']) assert.ok(html.includes(s), '缺少 ' + s);
});
check('任務條件：介面有基礎防禦／攻擊門檻輸入，並傳給求解器', () => {
  for (const s of ['id="sMinD"', 'id="sMinA"', 'id="sMaxP"', 'class="gwi"', 'globalWaive: gwv', 'allowOutside:', 'function diagBox', 'function solveNative', 'id="sNative"', 'function applyMap', 'function solveDesktop', 'function resetTaskConditions', 'function syncRecipeSel', 'id="tab-maps"', 'function snapshotMap', 'minBaseDef: Math.max(0, +st.minBaseDef || 0)', 'minBaseAtk: Math.max(0, +st.minBaseAtk || 0)']) assert.ok(html.includes(s), '缺少 ' + s);
});

console.log('\n' + pass + ' 通過, ' + fail + ' 失敗');
process.exit(fail ? 1 : 0);
