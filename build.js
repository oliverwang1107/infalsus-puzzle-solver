// 把 src/solver.js、src/importer.js 與 data/ 裡的預設粒子／配方內嵌進介面範本，
// 產生可直接雙擊開啟的 infalsus_solver.html
const fs = require('fs');
const path = require('path');
const read = (...p) => fs.readFileSync(path.join(__dirname, ...p), 'utf8');
const esc = (t) => t.replace(/<\/script>/gi, '<\\/script>');
const solver = esc(read('src', 'solver.js'));
const importer = esc(read('src', 'importer.js'));
const solverWasm = esc(read('src', 'solver_wasm.js'));
// WASM 搜尋引擎（wasm/solver.wasm 有提交進 repo；改了 wasm/src/lib.rs 要先 npm run build:wasm）
const wasmFile = path.join(__dirname, 'wasm', 'solver.wasm');
if (!fs.existsSync(wasmFile)) throw new Error('找不到 wasm/solver.wasm，請先執行 npm run build:wasm（需要 Rust）');
const wasmB64 = fs.readFileSync(wasmFile).toString('base64');
const tpl = read('src', 'app.template.html');

// ---- 預設粒子庫存與預設配方 ----
const readJSON = (f) => JSON.parse(read('data', f));
const parseEff = (t) => { const [e, c] = t.split('x').map(Number); return { efficacy: e, count: c }; };
const mkStack = (s, id) => ({ id, color: s.color, shape: s.shape, effText: s.effText, ...(s.extra ? { efficacy: s.efficacy, count: s.count, extra: true } : parseEff(s.effText)) });
const latest = readJSON('particles.json');
const xin = readJSON('recipe_xin_peng_you.json');
const zhao = readJSON('recipe_zhao_xun_huo_ban.json');
const presets = {
  inventories: [
    // 最新庫存分成兩組：30 種＝一般粒子（每色 6 種）；40 種＝再加 10 種額外粒子（6～8 格的大形狀）。兩組的同一種粒子形狀、效能完全一樣
    {
      id: 'latest', name: '最新庫存（一般粒子）',
      note: '來源：「找尋夥伴的溫暖目光」製作畫面截圖。形狀由小圖示轉錄，請對照遊戲確認；效能為每堆的最高值。',
      stacks: latest.stacks.filter((s) => !s.extra).map((s) => mkStack(s, s.id)),
    },
    {
      id: 'latest40', name: '最新庫存（含額外粒子）',
      note: '一般粒子 30 種＋從庫存畫面加的 10 種額外粒子（標「新」，6～8 格的大形狀）。額外粒子會讓搜尋變慢很多：求解時會先只用一般粒子快速解一輪，再用全部粒子找更好的。',
      stacks: latest.stacks.map((s) => mkStack(s, s.id)),
    },
  ],
  // 內建地圖：先是兩張只有板子的預設，再接上 data/maps.json（使用者存的完整地圖：區域數值、任務條件都有）；同名以後者為準
  recipes: (() => {
    const base = [
      { name: '找尋夥伴的溫暖目光', limit: zhao.settings.limit, board: zhao.board, zv: zhao.zv },
      { name: '新朋友', limit: xin.settings.limit, board: xin.board, zv: xin.zv },
    ];
    const mine = fs.existsSync(path.join(__dirname, 'data', 'maps.json')) ? readJSON('maps.json').recipes || {} : {};
    const out = base.map((r) => (mine[r.name] ? { name: r.name, ...mine[r.name] } : r));
    for (const [name, r] of Object.entries(mine)) if (!out.some((x) => x.name === name)) out.push({ name, ...r });
    return out;
  })(),
};
const presetsJSON = JSON.stringify(presets).replace(/</g, '\\u003c');

for (const m of ['/*__SOLVER__*/', '/*__SOLVER_WASM__*/', '/*__WASM_B64__*/', '/*__IMPORTER__*/', '/*__PRESETS__*/']) if (!tpl.includes(m)) throw new Error('範本缺少 ' + m + ' 標記');
const out = tpl.replace('/*__SOLVER__*/', () => solver).replace('/*__SOLVER_WASM__*/', () => solverWasm).replace('/*__WASM_B64__*/', () => wasmB64).replace('/*__IMPORTER__*/', () => importer).replace('/*__PRESETS__*/', () => presetsJSON);
fs.writeFileSync(path.join(__dirname, 'infalsus_solver.html'), out);
// 部署用的資產資料夾（Cloudflare Worker 的 assets）：dist/index.html＋_headers
const distDir = path.join(__dirname, 'dist');
fs.mkdirSync(distDir, { recursive: true });
fs.writeFileSync(path.join(distDir, 'index.html'), out);
fs.writeFileSync(path.join(distDir, '_headers'), fs.readFileSync(path.join(__dirname, 'worker', '_headers'), 'utf8'));
console.log('已產生 infalsus_solver.html（' + Math.round(Buffer.byteLength(out) / 1024) + ' KB；預設庫存 ' + presets.inventories.map((i) => i.stacks.length).join('+') + ' 種、預設配方 ' + presets.recipes.length + ' 個）');
