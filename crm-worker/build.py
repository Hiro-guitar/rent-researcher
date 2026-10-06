#!/usr/bin/env python3
"""Cloudflare版CRMの画面を作る。今の GAS のコードと画面（~/CrmTreePage.html）から組み立てる。

  python3 ~/crm-worker/build.py && (cd ~/crm-worker && npx wrangler deploy)

- public/app/gas-all.js … ホーム直下の GAS のコード（*.js）を名前順につなぎ、1つの関数の中に閉じ込める
  （ブラウザの window の名前とぶつからないように）。GAS_FN('名前') で中の関数・値を取り出せる。
- public/index.html … CrmTreePage.html の埋め込み（<?!= ... ?>）を、起動時に作る値（__boot）に差し替える。
"""
import glob, os, re

HOME = os.path.expanduser('~')
OUT = os.path.join(HOME, 'crm-worker', 'public')
os.makedirs(os.path.join(OUT, 'app'), exist_ok=True)

parts = []
for p in sorted(glob.glob(os.path.join(HOME, '*.js'))):
    with open(p, encoding='utf-8') as f:
        parts.append('// ==== ' + os.path.basename(p) + '\n' + f.read())
bundle = ('(function () {\n' + '\n;\n'.join(parts) +
          '\n;\nwindow.GAS_FN = function (n) { return eval(n); };\n})();\n')
with open(os.path.join(OUT, 'app', 'gas-all.js'), 'w', encoding='utf-8') as f:
    f.write(bundle)

with open(os.path.join(HOME, 'CrmTreePage.html'), encoding='utf-8') as f:
    html = f.read()

repl = {
    'treeJson': '__boot.tree',
    'customerPageUrl': '__boot.consts.customerPageUrl',
    'adminUrl': '__boot.consts.adminUrl',
    'approveBaseUrl': '__boot.consts.approveBaseUrl',
    'mobileSearchUrl': '__boot.consts.mobileSearchUrl',
    'masterJson': '__boot.master',
    'cfUrl': '""',
}
def sub(m):
    k = m.group(1)
    if k not in repl:
        raise SystemExit('知らない埋め込み: ' + k)
    return repl[k]
html, n = re.subn(r"JSON\.parse\('<\?!= (\w+) \?>'\)", sub, html)
if '<?' in html:
    raise SystemExit('差し替えていない埋め込みが残っています')

# 画面の本体（いちばん大きい <script>）は、起動して値がそろってから動かす
blocks = list(re.finditer(r'<script>(.*?)</script>', html, re.S))
main = max(blocks, key=lambda m: len(m.group(1)))
html = (html[:main.start()] + '<script type="text/x-crm" id="crmMain">' + main.group(1) + '</script>'
        + '<div id="bootMsg" style="position:fixed;top:40%;left:0;right:0;text-align:center;color:#888;font:14px sans-serif">読み込み中…</div>'
        + '<script src="/gas-shim.js"></script><script src="/app/gas-all.js"></script><script src="/boot.js"></script>'
        + '<script>__bootCrm();</script>' + html[main.end():])
with open(os.path.join(OUT, 'index.html'), 'w', encoding='utf-8') as f:
    f.write(html)
print('作りました: 埋め込み %d 個を差し替え / GASのコード %d ファイル / %d KB' % (n, len(parts), len(bundle) // 1024))
