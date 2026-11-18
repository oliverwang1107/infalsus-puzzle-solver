// 把編好的桌面版 exe 複製到 release/InFalsusSolver.exe（單一檔案，雙擊就能用）
'use strict';
const fs = require('fs'); const path = require('path');
const root = path.join(__dirname, '..');
const src = path.join(root, 'desktop', 'target', 'release', 'InFalsusSolver.exe');
fs.mkdirSync(path.join(root, 'release'), { recursive: true });
try { fs.copyFileSync(src, path.join(root, 'release', 'InFalsusSolver.exe')); } catch (e) { if (e.code === 'EBUSY') { console.error('release/InFalsusSolver.exe 正在執行中，請先關掉桌面版再重跑 npm run build:desktop（新編好的在 ' + src + '）'); process.exit(1); } throw e; }
console.log('已產生 release/InFalsusSolver.exe（' + Math.round(fs.statSync(src).size / 1024) + ' KB）');
