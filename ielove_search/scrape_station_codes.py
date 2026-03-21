"""いえらぶBB 駅コード収集ツール

Usage:
    python -m ielove_search.scrape_station_codes

環境変数 IELOVE_EMAIL / IELOVE_PASSWORD が必要。
結果は ielove_search/station_codes.json に出力される。

AJAX エンドポイント /ielovebb/rentshareajax/getstationbylinecode/ を
使用して都内全路線の駅コードを収集する。
"""

import json
import re
from pathlib import Path

from .auth import IeloveSession
from .config import IELOVE_BASE_URL, IELOVE_EMAIL, IELOVE_PASSWORD


def scrape_all_station_codes(session: IeloveSession) -> dict:
    """全路線の駅コードを AJAX エンドポイント経由で収集する。"""
    driver = session.driver
    if not driver:
        raise RuntimeError("ブラウザセッションが初期化されていません")

    station_codes: dict[str, str] = {}
    line_codes: dict[str, str] = {}

    # 路線番号を広範囲にスキャンして全路線を発見
    line_nums = list(range(1, 300)) + list(range(500, 600))

    for line_num in line_nums:
        url = (
            f"{IELOVE_BASE_URL}/ielovebb/rentshareajax/"
            f"getstationbylinecode/line/{line_num}/todofuken/13/"
        )
        try:
            html = driver.execute_script(
                "var xhr = new XMLHttpRequest();"
                "xhr.open('GET', arguments[0], false);"
                "xhr.send();"
                "return xhr.responseText;",
                url,
            )
        except Exception:
            continue

        if not html or len(html) < 50:
            continue

        # 路線名を抽出
        m = re.search(
            r'<span class="area_text line_name_span">(.*?)</span>', html
        )
        if not m:
            continue
        line_name = m.group(1).strip()

        # 路線コードを抽出
        m = re.search(r'value="(13_\d+)" name="select_all"', html)
        if not m:
            continue
        line_code = m.group(1)
        line_codes[line_name] = line_code

        # 駅コードを抽出
        count = 0
        for sm in re.finditer(
            r'value="(13_\d+_\d+)" name="station\[\]"[^>]*>'
            r'\s*<span class="station_text">([^<]+)</span>',
            html,
        ):
            st_code = sm.group(1)
            st_name = sm.group(2).strip()
            if st_name not in station_codes:
                station_codes[st_name] = st_code
            count += 1

        if count:
            print(f"  {line_name} ({line_code}): {count} 駅")

    return {
        "station_codes": station_codes,
        "line_codes": line_codes,
    }


def main() -> None:
    if not IELOVE_EMAIL or not IELOVE_PASSWORD:
        print("[ERROR] IELOVE_EMAIL / IELOVE_PASSWORD が設定されていません")
        return

    session = IeloveSession(IELOVE_EMAIL, IELOVE_PASSWORD)
    try:
        session.login()
        print("[INFO] 駅コード収集開始...")
        data = scrape_all_station_codes(session)

        output_path = Path(__file__).parent / "station_codes.json"
        with open(output_path, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)

        print(
            f"[INFO] {len(data['station_codes'])} 駅, "
            f"{len(data['line_codes'])} 路線"
        )
        print(f"[INFO] 出力: {output_path}")
    finally:
        session.close()


if __name__ == "__main__":
    main()
