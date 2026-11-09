// 把 src/solver.js、src/importer.js 與 data/ 裡的預設粒子／配方內嵌進介面範本，
// 產生可直接雙擊開啟的 infalsus_solver.html
const fs = require('fs');
const path = require('path');
const read = (...p) => fs.readFileSync(path.join(__dirname, ...p), 'utf8');
const esc = (t) => t.replace(/<\/script>/gi, '<\\/script>');
const solver = esc(read('src', 'solver.js'));
const importer = esc(read('src', 'importer.js'));
const tpl = read('src', 'app.template.html');

// ---- 預設粒子庫存與預設配方 ----
const readJSON = (f) => JSON.parse(read('data', f));
const parseEff = (t) => { const [e, c] = t.split('x').map(Number); return { efficacy: e, count: c }; };
const mkStack = (s, id) => ({ id, color: s.color, shape: s.shape, effText: s.effText, ...parseEff(s.effText) });
const LET = 'RYGBP';
const latest = readJSON('particles.json');
const xin = readJSON('recipe_xin_peng_you.json');
const zhao = readJSON('recipe_zhao_xun_huo_ban.json');
const presets = {
  inventories: [
    {
      id: 'latest', name: '最新庫存（五色）',
      note: '來源：「找尋夥伴的溫暖目光」製作畫面截圖。形狀由小圖示轉錄，請對照遊戲確認；效能為每堆的最高值。',
      stacks: latest.stacks.map((s) => mkStack(s, s.id)),
    },
    {
      id: 'xin_peng_you', name: '較早庫存（只有紅、紫）',
      note: '來源：「新朋友」製作畫面截圖，是庫存較早的版本（用掉好粒子之前）。',
      stacks: (() => { const n = {}; return xin.stacks.map((s) => { n[s.color] = (n[s.color] || 0) + 1; return mkStack(s, LET[s.color] + n[s.color]); }); })(),
    },
  ],
  recipes: [
    { name: '找尋夥伴的溫暖目光', limit: zhao.settings.limit, board: zhao.board, zv: zhao.zv },
    { name: '新朋友', limit: xin.settings.limit, board: xin.board, zv: xin.zv },
  ],
};
const presetsJSON = JSON.stringify(presets).replace(/</g, '\\u003c');

for (const m of ['/*__SOLVER__*/', '/*__IMPORTER__*/', '/*__PRESETS__*/']) if (!tpl.includes(m)) throw new Error('範本缺少 ' + m + ' 標記');
const out = tpl.replace('/*__SOLVER__*/', () => solver).replace('/*__IMPORTER__*/', () => importer).replace('/*__PRESETS__*/', () => presetsJSON);
fs.writeFileSync(path.join(__dirname, 'infalsus_solver.html'), out);
console.log('已產生 infalsus_solver.html（' + Math.round(Buffer.byteLength(out) / 1024) + ' KB；預設庫存 ' + presets.inventories.map((i) => i.stacks.length).join('+') + ' 種、預設配方 ' + presets.recipes.length + ' 個）');
