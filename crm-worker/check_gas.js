// デプロイ前の点検: GAS のコードを名前順に読み込んで、①読み込みで落ちないか ②要る関数がそろっているか を確かめる。
//   node ~/crm-worker/check_gas.js
// ⚠️ 2026-10-07: ファイルの外側で別ファイルの定数を使ってGAS全体が落ちた／書き直しで関数を消した。どちらもこれで気づける。
const fs = require('fs'), vm = require('vm'), path = require('path');
const HOME = process.env.HOME;
const ctx = { console, Date, Math, JSON, crypto: require('crypto').webcrypto, btoa: (s) => Buffer.from(s, 'binary').toString('base64'), unescape, encodeURIComponent, decodeURIComponent };
ctx.globalThis = ctx; vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(HOME, 'crm-worker/public/gas-shim.js'), 'utf8'), ctx);
const files = fs.readdirSync(HOME).filter((f) => f.endsWith('.js')).sort();
for (const f of files) {
  try { vm.runInContext(fs.readFileSync(path.join(HOME, f), 'utf8'), ctx, { filename: f }); }
  catch (e) { console.error('✗ 読み込みで落ちます: ' + f + ' / ' + e.message); process.exit(1); }
}
const must = ['doGet', 'doPost', '_cfCrmCall_', '_cfCrmCallable_', 'cfSyncRows', 'cfSyncSheet', 'cfSyncCheck', 'cfSyncAll', '_crmTouch_',
  'getCrmPageConsts', 'cfCrmUrl', 'getCrmVersion', 'getCrmOne', '_crmTreeForPage_'];
let bad = 0;
const callable = vm.runInContext('_cfCrmCallable_()', ctx);
for (const n of must.concat(callable)) {
  if (vm.runInContext('typeof ' + n, ctx) !== 'function') { console.error('✗ 関数がありません: ' + n); bad++; }
}
if (bad) process.exit(1);
console.log('✓ GASのコード ' + files.length + 'ファイル: 読み込みOK・関数そろっている（' + (must.length + callable.length) + '個）');
