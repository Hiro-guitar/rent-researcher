"""いえらぶBB 検索ロジック

CustomerCriteria から検索URLを組み立て、
HTML をパースして物件リストを返す。
"""

import random
import re
import time
from typing import Optional

from itandi_search.models import (
    CustomerCriteria,
    Property,
    _normalize_move_in_date,
)

from .auth import IeloveSession
from .config import (
    BUILDING_AGE_CODES,
    CITY_CODES,
    HARD_EQUIPMENT_OPTS,
    IELOVE_BASE_URL,
    LAYOUT_CODES,
    PREFECTURE_CODE,
    STATION_CODES,
    STRUCTURE_ALIAS,
)
from .parsers import parse_detail_page, parse_search_results, parse_total_count


class IeloveSearchError(Exception):
    """いえらぶBB 検索エラー"""


# ── 検索URL構築 ────────────────────────────────────────

def _build_search_url(
    criteria: CustomerCriteria,
    *,
    page: int = 1,
) -> str:
    """CustomerCriteria から検索URLのパスを構築する。

    いえらぶBBはパスベースのURLパラメータを使用する:
    /ielovebb/rent/index/todofuken/13/station/13_1_5/prct/9/...
    """
    parts: list[str] = [
        f"{IELOVE_BASE_URL}/ielovebb/rent/index",
    ]

    # ── 駅コード ──
    station_codes = _resolve_station_codes(criteria)
    city_codes = _resolve_city_codes(criteria)
    if station_codes:
        # 駅指定がある場合は駅コードの都道府県を採用
        prefectures = sorted({c.split("_")[0] for c in station_codes})
        for pref in prefectures:
            parts.append(f"todofuken/{pref}")
            parts.append(f"lineTodofuken/{pref}")
        for code in station_codes:
            parts.append(f"station/{code}")
        # 駅指定がある場合でも市区町村も併用（ANDではなくいえらぶ側はOR的挙動）
        for code in city_codes:
            parts.append(f"shikuchoson/{code}")
    elif city_codes:
        # 市区町村指定のみ
        prefectures = sorted({c.split("_")[0] for c in city_codes})
        for pref in prefectures:
            parts.append(f"todofuken/{pref}")
        for code in city_codes:
            parts.append(f"shikuchoson/{code}")
    else:
        # フォールバック: 都道府県デフォルト (東京都)
        parts.append(f"todofuken/{PREFECTURE_CODE}")

    # ── 賃料上限 (万円) ──
    if criteria.rent_max:
        rent_man = criteria.rent_max // 10000
        parts.append(f"prct/{rent_man}")

    # ── 賃料下限 (万円) ──
    if criteria.rent_min:
        rent_min_man = criteria.rent_min // 10000
        parts.append(f"prcf/{rent_min_man}")

    # ── 管理費込み ──
    parts.append("ikrh/1")

    # ── 専有面積下限 ──
    if criteria.area_min:
        parts.append(f"barf/{criteria.area_min:.2f}")

    # ── 駅徒歩 ──
    if criteria.walk_minutes:
        parts.append(f"wati1/{criteria.walk_minutes}")

    # ── 築年数 ──
    if criteria.building_age:
        age_code = _resolve_building_age(criteria.building_age)
        if age_code:
            parts.append(f"buda/{age_code}")

    # ── 間取り ──
    layout_codes = _resolve_layouts(criteria.layouts)
    if layout_codes:
        for code in layout_codes:
            parts.append(f"madori/{code}")

    # ── 敷金なし ──
    if criteria.no_deposit:
        parts.append("skknt/0")
        parts.append("skuc/1")

    # ── 礼金なし ──
    if criteria.no_key_money:
        parts.append("reknt/0")
        parts.append("reuc/1")

    # ── ハード設備 ──
    for eid in criteria.equipment_ids:
        if eid in HARD_EQUIPMENT_OPTS:
            cat, code = HARD_EQUIPMENT_OPTS[eid]
            parts.append(f"{cat}/{code}")

    # ── ソート (更新が新しい順) ──
    parts.append("optt/2")

    # ── 1ページの表示件数 (最大200) ──
    parts.append("cnt/200")

    # ── ページ番号 ──
    if page > 1:
        parts.append(f"page/{page}")

    return "/".join(parts) + "/"


def _resolve_station_codes(criteria: CustomerCriteria) -> list[str]:
    """顧客の駅名リストをいえらぶ駅コードに変換する。"""
    codes: list[str] = []
    for station_name in criteria.stations:
        code = STATION_CODES.get(station_name)
        if code:
            codes.append(code)
        else:
            print(f"[WARN] いえらぶBB: 駅コード未登録 '{station_name}'")
    return codes


def _resolve_city_codes(criteria: CustomerCriteria) -> list[str]:
    """顧客の市区町村名リストをいえらぶ市区町村コードに変換する。"""
    codes: list[str] = []
    cities = getattr(criteria, "cities", None) or []
    for city_name in cities:
        name = (city_name or "").strip()
        if not name:
            continue
        code = CITY_CODES.get(name)
        if code:
            codes.append(code)
        else:
            print(f"[WARN] いえらぶBB: 市区町村コード未登録 '{name}'")
    return codes


def _resolve_building_age(age: int) -> str:
    """築年数を最も近いコードに変換する。"""
    # 設定値以下の最大コードを探す
    best = ""
    for threshold, code in sorted(BUILDING_AGE_CODES.items()):
        if threshold <= age:
            best = code
        else:
            break
    return best if best else str(age)


def _resolve_layouts(layouts: list[str]) -> list[str]:
    """間取り名をコードに変換する。"""
    codes: list[str] = []
    for layout in layouts:
        code = LAYOUT_CODES.get(layout)
        if code:
            codes.append(code)
    return codes


# ── メイン検索関数 ──────────────────────────────────────

def search_properties(
    session: IeloveSession,
    criteria: CustomerCriteria,
    equipment_names: Optional[list[str]] = None,
    *,
    is_test_customer: bool = False,
    limit_results: Optional[int] = None,
) -> tuple[list[Property], str]:
    """いえらぶBBで物件を検索する。

    Returns:
        (物件リスト, 検索URL)
    """
    if not STATION_CODES:
        print(
            "[WARN] いえらぶBB: station_codes.json が見つかりません。"
            "python -m ielove_search.scrape_station_codes を実行してください。"
        )

    search_url = _build_search_url(criteria)
    print(f"[DEBUG] いえらぶBB 検索URL: {search_url}")

    all_properties: list[Property] = []
    page = 1
    max_pages = 5  # 最大5ページ (200件/ページ = 最大1000件)

    while page <= max_pages:
        url = _build_search_url(criteria, page=page) if page > 1 else search_url

        try:
            html = session.get_page(url)
        except Exception as exc:
            raise IeloveSearchError(
                f"検索ページ取得失敗 (page {page}): {exc}"
            ) from exc

        properties = parse_search_results(html)

        if not properties:
            break

        all_properties.extend(properties)
        print(
            f"  → いえらぶBB page {page}: {len(properties)} 件 "
            f"(累計 {len(all_properties)} 件)"
        )

        # 件数制限
        if limit_results and len(all_properties) >= limit_results:
            all_properties = all_properties[:limit_results]
            break

        # 総件数チェック（1ページ目のみ）
        if page == 1:
            total = parse_total_count(html)
            if total <= 200:
                break  # 全件取得済み

        # 200件未満なら最終ページ
        if len(properties) < 200:
            break

        page += 1
        time.sleep(random.uniform(1, 3))  # ページ間ランダムウェイト

    return all_properties, search_url


# ── 詳細ページ取得 ──────────────────────────────────────

def enrich_property_details(
    session: IeloveSession,
    properties: list[Property],
    *,
    drive_service=None,
) -> None:
    """各物件の詳細ページから追加情報を取得する。

    properties を in-place で更新する。
    """
    for i, prop in enumerate(properties):
        if not prop.url:
            continue

        try:
            html = session.get_page(prop.url)
            # 最初の1件だけHTMLをダンプ（デバッグ用）
            if i == 0:
                try:
                    import pathlib
                    dump_path = pathlib.Path("/tmp/ielove_detail_debug.html")
                    dump_path.write_text(html, encoding="utf-8")
                    print(f"[DEBUG] 詳細ページHTML保存: {dump_path}")
                except Exception:
                    pass
            parse_detail_page(html, prop)

            # 入居時期を正規化 ("2026/5/中旬" → "2026年5月中旬")
            if prop.move_in_date:
                prop.move_in_date = _normalize_move_in_date(
                    prop.move_in_date
                )

            if prop.image_urls:
                cats = prop.image_categories
                cat_count = sum(1 for c in cats if c) if cats else 0
                print(
                    f"[DEBUG] {prop.building_name}: "
                    f"画像 {len(prop.image_urls)}枚取得"
                    f" (カテゴリ付き {cat_count}枚)"
                )
                for j, u in enumerate(prop.image_urls[:5]):
                    cat = cats[j] if j < len(cats) else ""
                    print(f"  [{j}] {cat or '(なし)'} {u}")
                if len(prop.image_urls) > 5:
                    print(f"  ... 他 {len(prop.image_urls) - 5}枚")
        except Exception as exc:
            print(
                f"[WARN] いえらぶBB 詳細取得失敗 "
                f"({prop.building_name}): {exc}"
            )
            continue

        # 詳細ページごとにランダム遅延
        time.sleep(random.uniform(1, 3))

    # 画像ダウンロード（最初の1枚をDiscord添付用に）
    _download_first_images(session, properties)


def _download_first_images(
    session: IeloveSession,
    properties: list[Property],
) -> None:
    """各物件の最初の画像をダウンロードする。"""
    driver = session.driver
    if not driver:
        return

    for prop in properties:
        if prop.image_data:
            continue  # 既にダウンロード済み

        url = prop.image_url
        if not url:
            # image_urls から取得
            if prop.image_urls:
                url = prop.image_urls[0]
            else:
                continue

        try:
            image_bytes = driver.execute_script(
                """
                var resp = await fetch(arguments[0]);
                var buf = await resp.arrayBuffer();
                var bytes = new Uint8Array(buf);
                var binary = '';
                for (var i = 0; i < bytes.length; i++) {
                    binary += String.fromCharCode(bytes[i]);
                }
                return btoa(binary);
                """,
                url,
            )
            if image_bytes:
                import base64
                prop.image_data = base64.b64decode(image_bytes)
        except Exception:
            pass  # 画像ダウンロード失敗は無視
