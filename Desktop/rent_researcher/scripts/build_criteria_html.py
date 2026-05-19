#!/usr/bin/env python3
"""
build_criteria_html.py - GAS の RouteSelectPage.html を form.ehomaki.com 用の
                         静的 docs/criteria.html に変換する。

変換内容:
1. テンプレートスクリプトレット (<?!= ... ?> / <?= ... ?>) を削除し、
   JS 変数を「URLパラメータ + fetch で取得」する形に変える。
2. ROUTE_COMPANIES / STATION_DATA / TOKYO_CITIES の定数を GAS の各データ
   ファイルから抽出して criteria.html に直接埋め込む。
3. LIFF SDK を <head> に追加。
4. google.script.run.processCriteriaSelection を fetch POST に置き換え。
5. 送信完了時に liff.closeWindow() で閉じる。

実行:
    python3 scripts/build_criteria_html.py

更新先: docs/criteria.html
"""

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
WORKTREE = ROOT / ".claude/worktrees/nice-feistel"
SOURCE_HTML = WORKTREE / "RouteSelectPage.html"
ROUTE_DATA = WORKTREE / "RouteData.js"
STATION_DATA_FILE = WORKTREE / "StationData.js"
CITY_DATA_FILE = WORKTREE / "CityData.js"
TARGET_HTML = ROOT / "docs/criteria.html"

# 既に判明している GAS Web App URL (form.ehomaki.com から POST する宛先)
GAS_API_URL = "https://script.google.com/macros/s/AKfycbxq3WNTBLpJp_miOMQzleMdl4X_3IEnnjS6OSPdxUPH3YzEsqMKGz8X5fjMAU9C0_o/exec"
LIFF_ID = "2009257618-mx8s5Vuk"


def extract_const_definition(path: Path, name: str) -> str:
    """`const NAME = ...;` 形式の定義部を文字列で取り出す。"""
    text = path.read_text(encoding="utf-8")
    pattern = re.compile(rf"const\s+{re.escape(name)}\s*=\s*", re.MULTILINE)
    m = pattern.search(text)
    if not m:
        raise RuntimeError(f"{name} not found in {path}")
    start = m.end()
    # マッチ位置から括弧バランスで終端 (`;` 直前まで) を探す
    depth = 0
    in_string = False
    string_char = ""
    i = start
    while i < len(text):
        ch = text[i]
        if in_string:
            if ch == "\\":
                i += 2
                continue
            if ch == string_char:
                in_string = False
            i += 1
            continue
        if ch in ('"', "'"):
            in_string = True
            string_char = ch
            i += 1
            continue
        if ch in "{[(":
            depth += 1
        elif ch in "}])":
            depth -= 1
            if depth == 0:
                # 終端到達。後続の ';' まで取り込む
                end = i + 1
                # ';' をスキップ
                while end < len(text) and text[end] in " \t":
                    end += 1
                if end < len(text) and text[end] == ';':
                    end += 1
                return text[m.start():end]
        i += 1
    raise RuntimeError(f"could not find end of {name}")


def main() -> None:
    html = SOURCE_HTML.read_text(encoding="utf-8")

    # 1. <head> に LIFF SDK と preconnect を追加
    head_inject = """  <!-- LIFF SDK (送信後に liff.closeWindow() するため) -->
  <script src="https://static.line-scdn.net/liff/edge/2/sdk.js"></script>
  <!-- GAS API への TLS ハンドシェイクを事前に済ませる -->
  <link rel="preconnect" href="https://script.google.com" crossorigin>
  <link rel="dns-prefetch" href="https://script.google.com">
  <style>
    /* LIFF WebView のヘッダーが既にページタイトルを表示するため、
       ページ内 .header は非表示にする (form.ehomaki.com への直接アクセス時のみ
       影響するが、本番フローではLIFF経由のみなのでOK) */
    .header { display: none !important; }
  </style>
</head>"""
    html = html.replace("</head>", head_inject, 1)

    # 2. テンプレートスクリプトレットのブロックを置換
    # 元: 446-466行あたりの "サーバーから注入されるデータ" を全部書き換える
    # 静的データはここに直接埋め込み、ユーザー状態は fetch で取得する
    route_companies_src = extract_const_definition(ROUTE_DATA, "ROUTE_COMPANIES")
    station_data_src = extract_const_definition(STATION_DATA_FILE, "STATION_DATA")
    tokyo_cities_src = extract_const_definition(CITY_DATA_FILE, "TOKYO_CITIES")

    # const → var に変換 (criteria.html では他のJSも var で書かれているため統一)
    route_companies_src = route_companies_src.replace("const ROUTE_COMPANIES", "var ROUTE_COMPANIES", 1)
    station_data_src = station_data_src.replace("const STATION_DATA", "var STATION_DATA", 1)
    tokyo_cities_src = tokyo_cities_src.replace("const TOKYO_CITIES", "var TOKYO_CITIES", 1)

    static_block_start = "var ROUTE_COMPANIES = <?!= routeCompanies ?>;"
    static_block_end = "var INIT_FOCUS = '<?= initFocus ?>';"
    start_idx = html.find(static_block_start)
    end_idx = html.find(static_block_end)
    if start_idx == -1 or end_idx == -1:
        raise RuntimeError("template scriptlet block not found in source HTML")
    end_idx += len(static_block_end)

    new_block = f"""// ══════════════════════════════════════════════════════════
//  静的データ (GAS の RouteData.js / StationData.js / CityData.js から
//  scripts/build_criteria_html.py で同期したもの。元ファイルを更新した
//  場合は必ずこのスクリプトを再実行すること。)
// ══════════════════════════════════════════════════════════
{route_companies_src}
{station_data_src}
{tokyo_cities_src}

// ══════════════════════════════════════════════════════════
//  ユーザー状態 (URL パラメータ + fetch で初期化される)
// ══════════════════════════════════════════════════════════
var GAS_API_URL = '{GAS_API_URL}';
var LIFF_ID = '{LIFF_ID}';

var _qs = new URLSearchParams(location.search);
// LIFF 経由でアクセスされた場合、元の query は liff.state= に格納される
if (_qs.get('liff.state')) {{
  try {{
    var inner = _qs.get('liff.state').replace(/^\\?/, '');
    var innerQs = new URLSearchParams(inner);
    innerQs.forEach(function(v, k) {{ if (!_qs.has(k)) _qs.set(k, v); }});
  }} catch (_) {{}}
}}
var USER_ID = _qs.get('userId') || '';

// 初期値は空。後で fetch によって上書きされる。
var SELECTED_ROUTES = [];
var SELECTED_STATIONS = {{}};
var SELECTED_CITIES = [];
var SELECTED_TOWNS = {{}};
var INIT_AREA_METHOD = 'route';
var INIT_RENT_MAX = '';
var INIT_LAYOUTS = [];
var INIT_WALK = '';
var INIT_AREA_MIN = '';
var INIT_BUILDING_AGE = '';
var INIT_BUILDING_STRUCTURES = [];
var INIT_EQUIPMENT = [];
var INIT_PET_TYPE = '';
var INIT_OTHER_CONDITIONS = '';
var INIT_FOCUS = (_qs.get('focus') || '').toLowerCase();
"""

    html = html[:start_idx] + new_block + html[end_idx:]

    # 3. window.onload を fetch ベースに変更
    # 元の window.onload は SELECTED_* / INIT_* が template から既に来ている前提
    # 静的版では fetch で取得 → 取得完了後にレンダリング、という流れに変更する
    # 既存の Phase1〜5 の流れを保ちつつ、fetch 後に restoreSelections を呼ぶ
    onload_old = "window.onload = function() {"
    onload_new = """// ══════════════════════════════════════════════════════════
//  GAS API からユーザー状態を fetch して INIT_*/SELECTED_* を上書き
// ══════════════════════════════════════════════════════════
function _fetchUserState(cb) {
  if (!USER_ID) { cb(null); return; }
  var url = GAS_API_URL + '?action=criteria_state&userId=' + encodeURIComponent(USER_ID);
  fetch(url, { redirect: 'follow' })
    .then(function(r) { return r.text(); })
    .then(function(text) {
      try {
        var data = JSON.parse(text);
        if (data && data.success) {
          if (Array.isArray(data.selectedRoutes)) SELECTED_ROUTES = data.selectedRoutes;
          if (data.selectedStations) SELECTED_STATIONS = data.selectedStations;
          if (Array.isArray(data.selectedCities)) SELECTED_CITIES = data.selectedCities;
          if (data.selectedTowns) SELECTED_TOWNS = data.selectedTowns;
          if (data.areaMethod) INIT_AREA_METHOD = data.areaMethod;
          if (data.rentMax != null) INIT_RENT_MAX = data.rentMax;
          if (Array.isArray(data.layouts)) INIT_LAYOUTS = data.layouts;
          if (data.walkMax != null) INIT_WALK = data.walkMax;
          if (data.areaMin != null) INIT_AREA_MIN = data.areaMin;
          if (data.buildingAge != null) INIT_BUILDING_AGE = data.buildingAge;
          if (Array.isArray(data.buildingStructures)) INIT_BUILDING_STRUCTURES = data.buildingStructures;
          if (Array.isArray(data.equipment)) INIT_EQUIPMENT = data.equipment;
          if (data.petType != null) INIT_PET_TYPE = data.petType;
          if (data.otherConditions != null) INIT_OTHER_CONDITIONS = data.otherConditions;
        }
        cb(data && data.success ? data : null);
      } catch (e) { cb(null); }
    })
    .catch(function() { cb(null); });
}

window.onload = function() {"""
    html = html.replace(onload_old, onload_new, 1)

    # 4. Phase 1 のローディング消去前に fetch を挟む
    # 元: renderLayouts() 等を同期実行 → initialLoading を消す
    # 新: fetch → renderLayouts() 等 → initialLoading を消す
    # 一番シンプルな実装: window.onload の中身全体を _fetchUserState のコールバックでラップする
    phase1_old = """  // ── Phase 1: 軽い項目を即座にレンダリング (同期) ──
  renderLayouts();"""
    phase1_new = """  // GAS API から状態を取得してから描画を進める
  _fetchUserState(function() {

  // ── Phase 1: 軽い項目を即座にレンダリング (同期) ──
  renderLayouts();"""
    html = html.replace(phase1_old, phase1_new, 1)

    # 5. window.onload の末尾の `};` をコールバック閉じ + `});` に変える
    onload_close_old = """          applyConditionFocus_();
          _mark('Phase5: 復元完了・全レンダ完了');
        });
      });
    });
  });
};"""
    onload_close_new = """          applyConditionFocus_();
          _mark('Phase5: 復元完了・全レンダ完了');
        });
      });
    });
  });

  }); // end of _fetchUserState callback
};"""
    if onload_close_old not in html:
        raise RuntimeError("could not find window.onload tail to patch")
    html = html.replace(onload_close_old, onload_close_new, 1)

    # 6. google.script.run.processCriteriaSelection を fetch POST に置換
    submit_old = """  google.script.run
    .withSuccessHandler(function(result) {
      document.getElementById('loading').style.display = 'none';
      if (result && result.success) {
        document.getElementById('success').style.display = 'flex';
        setTimeout(function() {
          try { window.top.postMessage('liff-close', '*'); } catch(e) {}
          try { window.close(); } catch(e2) {}
        }, 1500);
      } else {
        showAlert(result ? result.message : 'エラーが発生しました。');
        document.getElementById('app').style.display = 'block';
      }
    })
    .withFailureHandler(function(err) {
      document.getElementById('loading').style.display = 'none';
      showAlert('エラーが発生しました: ' + (err.message || err));
      document.getElementById('app').style.display = 'block';
    })
    .processCriteriaSelection(USER_ID, criteria);
}"""
    submit_new = """  // fetch POST で GAS API に送信 (Content-Type: text/plain で CORS preflight を回避)
  fetch(GAS_API_URL, {
    method: 'POST',
    body: JSON.stringify({ action: 'criteria_submit', userId: USER_ID, criteria: criteria }),
    redirect: 'follow'
  })
    .then(function(r) { return r.text(); })
    .then(function(text) {
      var result; try { result = JSON.parse(text); } catch(e) { result = null; }
      document.getElementById('loading').style.display = 'none';
      if (result && result.success) {
        document.getElementById('success').style.display = 'flex';
        setTimeout(function() {
          // LIFF 経由なら liff.closeWindow() で閉じる
          try { if (window.liff && typeof liff.closeWindow === 'function') liff.closeWindow(); } catch(e) {}
          try { window.top.postMessage('liff-close', '*'); } catch(e2) {}
          try { window.close(); } catch(e3) {}
        }, 1500);
      } else {
        showAlert(result ? result.message : 'エラーが発生しました。');
        document.getElementById('app').style.display = 'block';
      }
    })
    .catch(function(err) {
      document.getElementById('loading').style.display = 'none';
      showAlert('エラーが発生しました: ' + (err && err.message ? err.message : err));
      document.getElementById('app').style.display = 'block';
    });
}

// ══════════════════════════════════════════════════════════
//  LIFF 初期化 (送信後に liff.closeWindow() するためだけに使う)
// ══════════════════════════════════════════════════════════
(function _initLiff() {
  try {
    if (window.liff && typeof liff.init === 'function') {
      liff.init({ liffId: LIFF_ID }).catch(function() { /* LIFF 外でも動作可 */ });
    }
  } catch (_) {}
})();"""
    if submit_old not in html:
        raise RuntimeError("could not find submit handler to patch")
    html = html.replace(submit_old, submit_new, 1)

    # 7. 出力
    TARGET_HTML.parent.mkdir(parents=True, exist_ok=True)
    TARGET_HTML.write_text(html, encoding="utf-8")
    print(f"✅ wrote {TARGET_HTML} ({len(html.encode('utf-8'))} bytes)")


if __name__ == "__main__":
    main()
