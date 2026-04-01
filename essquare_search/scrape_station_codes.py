"""ES-Square の駅選択UIから全駅コードをスクレイピングするユーティリティ。

使い方:
    python -m essquare_search.scrape_station_codes

出力: 路線ごとの駅名→コード対応を JSON で標準出力に出力する。
"""

import json
import re
import sys
import time

from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC
from selenium.common.exceptions import TimeoutException

from .auth import EsSquareSession
from .config import ESSQUARE_EMAIL, ESSQUARE_PASSWORD, ESSQUARE_SEARCH_URL

# ── JavaScript: 駅ページから lineCode + 全駅データを抽出 ──────────
JS_EXTRACT_STATIONS = """
var checkboxes = document.querySelectorAll('input[data-testclass="checkbox"]');
if (checkboxes.length === 0) return JSON.stringify({error: 'no checkboxes'});

var first = checkboxes[0];
var fiberKey = Object.keys(first).find(function(k) {
    return k.indexOf('__reactFiber') === 0;
});
if (!fiberKey) return JSON.stringify({error: 'no fiber key'});

var fiber = first[fiberKey];
var current = fiber;
var depth = 0;
var stations = [];
var lineCode = null;

while (current && depth < 20) {
    var props = current.memoizedProps;
    if (props && typeof props === 'object') {
        // lineCode を取得
        if (props.line && props.line.lineCode && !lineCode) {
            lineCode = props.line.lineCode;
        }
        // 駅リスト（React children 配列）を取得
        if (Array.isArray(props.children) && props.children.length >= 2) {
            var c0 = props.children[0];
            if (c0 && c0.key && c0.props && c0.props.label && stations.length === 0) {
                for (var i = 0; i < props.children.length; i++) {
                    var child = props.children[i];
                    stations.push({key: child.key, label: child.props.label});
                }
            }
        }
    }
    current = current.return;
    depth++;
}

return JSON.stringify({lineCode: lineCode, stations: stations});
"""

# ── JavaScript: 路線ページから全路線チェックボックスのラベルを取得 ──
JS_GET_LINE_LABELS = """
var labels = [];
var checkboxes = document.querySelectorAll('input[data-testclass="checkbox"]');
checkboxes.forEach(function(cb) {
    var label = cb.closest('label');
    if (label) {
        var text = label.textContent.trim();
        if (text) labels.push(text);
    }
});
return JSON.stringify(labels);
"""

# 都道府県コード
PREF_CODES: dict[str, str] = {
    "東京都": "13",
    "神奈川県": "14",
    "埼玉県": "11",
    "千葉県": "12",
}


def _wait_for_modal_content(driver, text_pattern: str, timeout: int = 10):
    """モーダル内に指定テキストが表示されるまで待つ。"""
    WebDriverWait(driver, timeout).until(
        EC.presence_of_element_located(
            (By.XPATH, f"//*[contains(text(), '{text_pattern}')]")
        )
    )


def _click_by_text(driver, tag: str, text: str, timeout: int = 10):
    """指定テキストを含む要素をクリックする。"""
    xpath = f"//{tag}[contains(text(), '{text}')]"
    el = WebDriverWait(driver, timeout).until(
        EC.element_to_be_clickable((By.XPATH, xpath))
    )
    el.click()
    time.sleep(1)


def _click_checkbox_by_label(driver, label_text: str, timeout: int = 5):
    """ラベルテキストに完全一致するチェックボックスをクリックする。"""
    # ラベルの span を探してクリック
    xpath = f"//label[.//span[contains(text(), '{label_text}')]]//input[@data-testclass='checkbox']"
    try:
        cb = WebDriverWait(driver, timeout).until(
            EC.presence_of_element_located((By.XPATH, xpath))
        )
        driver.execute_script("arguments[0].click()", cb)
        time.sleep(0.5)
        return True
    except TimeoutException:
        return False


def _parse_label(label: str) -> str:
    """'大塚 (75)' → '大塚'"""
    return re.sub(r"\s*\(\d[\d,]*\)\s*$", "", label).strip()


def _scrape_prefecture_stations(
    driver, pref_name: str, pref_code: str
) -> list[dict]:
    """指定都道府県の全路線・全駅コードをスクレイピングする。

    Returns:
        [
            {
                "lineName": "山手線",
                "lineCode": 125,
                "prefCode": "13",
                "stations": [
                    {"name": "大塚", "stationCode": "5547"},
                    ...
                ]
            },
            ...
        ]
    """
    # 検索ページにアクセス
    print(f"[INFO] 検索ページにアクセス ({pref_name})...", file=sys.stderr)
    driver.get(ESSQUARE_SEARCH_URL)
    time.sleep(4)

    # ── Step 1: モーダルを開く ──
    print("[INFO] エリア・沿線モーダルを開く...", file=sys.stderr)
    try:
        dropdown = WebDriverWait(driver, 10).until(
            EC.element_to_be_clickable(
                (By.XPATH, "//*[contains(text(), 'エリア・沿線を選択')]")
            )
        )
        dropdown.click()
        time.sleep(2)
    except TimeoutException:
        pass

    # ── Step 2: 「沿線」タブをクリック ──
    print("[INFO] 沿線タブを選択...", file=sys.stderr)
    _click_by_text(driver, "button", "沿線")
    time.sleep(1)

    # ── Step 3: 都道府県を選択 ──
    print(f"[INFO] {pref_name}を選択...", file=sys.stderr)
    _click_checkbox_by_label(driver, pref_name)
    time.sleep(1)

    # ── Step 4: 「路線を選択」をクリック ──
    print("[INFO] 路線を選択...", file=sys.stderr)
    _click_by_text(driver, "button", "路線を選択")
    time.sleep(2)

    # ── Step 5: 全路線のラベルを取得 ──
    print("[INFO] 路線リスト取得中...", file=sys.stderr)
    line_labels_json = driver.execute_script(JS_GET_LINE_LABELS)
    all_line_labels = json.loads(line_labels_json)

    skip_patterns = ["新幹線"]
    line_labels = []
    for label in all_line_labels:
        name = _parse_label(label)
        if any(p in name for p in skip_patterns):
            print(f"  [SKIP] {name}", file=sys.stderr)
            continue
        line_labels.append(label)

    print(f"[INFO] {len(line_labels)} 路線を処理対象...", file=sys.stderr)

    # ── Step 6: 各路線の駅データを取得 ──
    all_lines = []

    for idx, line_label in enumerate(line_labels):
        line_name = _parse_label(line_label)
        print(
            f"[INFO] [{idx + 1}/{len(line_labels)}] {line_name} ...",
            file=sys.stderr,
        )

        if not _click_checkbox_by_label(driver, line_name):
            print(f"  [WARN] チェックボックスが見つかりません: {line_name}", file=sys.stderr)
            continue

        try:
            _click_by_text(driver, "button", "駅を選択", timeout=5)
            time.sleep(2)
        except TimeoutException:
            print(f"  [WARN] 駅を選択ボタンが見つかりません: {line_name}", file=sys.stderr)
            _click_checkbox_by_label(driver, line_name)
            continue

        try:
            result_json = driver.execute_script(JS_EXTRACT_STATIONS)
            result = json.loads(result_json)
        except Exception as e:
            print(f"  [WARN] データ抽出エラー: {e}", file=sys.stderr)
            result = {"error": str(e)}

        if "error" in result:
            print(f"  [WARN] {result['error']}", file=sys.stderr)
        else:
            line_code = result.get("lineCode")
            stations = result.get("stations", [])
            parsed_stations = []
            for s in stations:
                sname = _parse_label(s["label"])
                parsed_stations.append({
                    "name": sname,
                    "stationCode": s["key"],
                })
            all_lines.append({
                "lineName": line_name,
                "lineCode": line_code,
                "prefCode": pref_code,
                "stations": parsed_stations,
            })
            print(
                f"  → lineCode={line_code}, {len(parsed_stations)} 駅",
                file=sys.stderr,
            )

        try:
            _click_by_text(driver, "button", "沿線", timeout=5)
            time.sleep(1)
        except TimeoutException:
            driver.back()
            time.sleep(2)

        _click_checkbox_by_label(driver, line_name)
        time.sleep(0.3)

    return all_lines


def scrape_all_stations(
    session: EsSquareSession,
    prefectures: list[str] | None = None,
) -> dict:
    """指定都道府県の全路線・全駅コードをスクレイピングする。

    Args:
        session: ログイン済みセッション
        prefectures: 対象都道府県リスト (None なら PREF_CODES の全件)

    Returns:
        {"lines": [ {lineName, lineCode, prefCode, stations}, ... ]}
    """
    driver = session.driver
    if not driver:
        raise RuntimeError("セッションが初期化されていません")

    targets = prefectures or list(PREF_CODES.keys())
    all_lines: list[dict] = []

    for pref_name in targets:
        pref_code = PREF_CODES.get(pref_name)
        if not pref_code:
            print(f"[WARN] 未知の都道府県: {pref_name}", file=sys.stderr)
            continue
        lines = _scrape_prefecture_stations(driver, pref_name, pref_code)
        all_lines.extend(lines)

    return {"lines": all_lines}


def scrape_all_tokyo_stations(session: EsSquareSession) -> dict:
    """後方互換: 東京都のみスクレイピング。"""
    return scrape_all_stations(session, prefectures=["東京都"])


def generate_station_codes_dict(data: dict) -> dict[str, dict]:
    """スクレイピング結果を STATION_CODES 形式に変換する。

    Returns:
        {
            "路線名": {
                "駅名": "prefCode+lineCode+stationCode",
                ...
            },
            ...
        }
    """
    result = {}
    for line in data["lines"]:
        line_name = line["lineName"]
        line_code = line["lineCode"]
        pref_code = line.get("prefCode", "13")
        if line_code is None:
            continue
        stations = {}
        for s in line["stations"]:
            code = f"{pref_code}+{line_code}+{s['stationCode']}"
            stations[s["name"]] = code
        result[line_name] = stations
    return result


def main():
    if not ESSQUARE_EMAIL or not ESSQUARE_PASSWORD:
        print(
            "ERROR: ESSQUARE_EMAIL / ESSQUARE_PASSWORD 環境変数を設定してください",
            file=sys.stderr,
        )
        sys.exit(1)

    session = EsSquareSession(ESSQUARE_EMAIL, ESSQUARE_PASSWORD)
    try:
        session.login()
        raw_data = scrape_all_stations(session)

        # 路線ごとの駅コードを生成
        codes_by_line = generate_station_codes_dict(raw_data)

        # JSON 出力
        print(json.dumps(codes_by_line, ensure_ascii=False, indent=2))

        # サマリー
        total_stations = sum(len(v) for v in codes_by_line.values())
        print(
            f"\n[SUMMARY] {len(codes_by_line)} 路線, {total_stations} 駅",
            file=sys.stderr,
        )
    finally:
        session.close()


if __name__ == "__main__":
    main()
