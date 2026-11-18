// 把 wasm/src/lib.rs 編成 WebAssembly，輸出 wasm/solver.wasm（這個檔案有提交進 repo，
// 所以沒有裝 Rust 的人也能直接 npm run build；改了 lib.rs 才需要重新執行 npm run build:wasm）
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const dir = __dirname;
const r = spawnSync('cargo', ['build', '--release', '--lib', '--target', 'wasm32-unknown-unknown'], { cwd: dir, stdio: 'inherit', shell: process.platform === 'win32' });
if (r.status !== 0) { console.error('cargo build 失敗（需要 Rust，以及 rustup target add wasm32-unknown-unknown）'); process.exit(r.status || 1); }
const out = path.join(dir, 'target', 'wasm32-unknown-unknown', 'release', 'infalsus_solver.wasm');
fs.copyFileSync(out, path.join(dir, 'solver.wasm'));
console.log('已產生 wasm/solver.wasm（' + Math.round(fs.statSync(path.join(dir, 'solver.wasm')).size / 1024) + ' KB）');
