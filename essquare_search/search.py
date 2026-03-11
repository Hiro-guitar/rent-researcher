"""いい生活Square 検索 URL 構築・実行"""

import random
import time
from urllib.parse import urlencode

from itandi_search.models import CustomerCriteria, Property

from .auth import EsSquareSession
from .config import (
    CITY_CODES,
    ESSQUARE_SEARCH_URL,
    KODAWARI_MAP,
    LAYOUT_MAP,
    STRUCTURE_MAP,
)
from .parsers import (
    parse_detail_page,
    parse_graphql_results,
    parse_search_results,
)


def build_search_url(criteria: CustomerCriteria, page: int = 1) -> str:
    """CustomerCriteria → いい生活Square 検索 URL を構築する。"""
    params: list[tuple[str, str]] = []

    # エリア (jusho)
    for city in criteria.cities:
        city = city.strip()
        if city in CITY_CODES:
            params.append(("jusho", CITY_CODES[city]))
        else:
            print(f"[WARN] ES-Square: 市区町村コード未定義: {city}")

    # 賃料 (chinryo_from / chinryo_to) — 万円単位
    if criteria.rent_max is not None:
        rent_man = criteria.rent_max / 10000
        params.append(("chinryo_to", str(rent_man)))
    if criteria.rent_min is not None:
        rent_man = criteria.rent_min / 10000
        params.append(("chinryo_from", str(rent_man)))

    # 間取り (madori)
    for layout in criteria.layouts:
        layout = layout.strip()
        if layout in LAYOUT_MAP:
            params.append(("madori", LAYOUT_MAP[layout]))
        else:
            print(f"[WARN] ES-Square: 間取りマッピング未定義: {layout}")

    # 専有面積 (menseki_from / menseki_to)
    if criteria.area_min is not None:
        params.append(("menseki_from", str(criteria.area_min)))
    if criteria.area_max is not None:
        params.append(("menseki_to", str(criteria.area_max)))

    # 築年数 (chikunensu)
    if criteria.building_age is not None:
        params.append(("chikunensu", str(criteria.building_age)))

    # 駅徒歩 (toho)
    if criteria.walk_minutes is not None:
        params.append(("toho", str(criteria.walk_minutes)))

    # 建物構造 (kozo)
    added_kozo: set[str] = set()
    for st in criteria.structure_types:
        # itandi API値 (wooden, rc, etc.) → ES-Square構造名
        reverse_map = {
            "wooden": "木造",
            "steel": "鉄骨系",
            "lightweight_steel": "鉄骨系",
            "rc": "鉄筋系",
            "src": "鉄筋系",
            "block": "その他",
        }
        jp_name = reverse_map.get(st, "")
        if jp_name and jp_name in STRUCTURE_MAP:
            kozo_val = STRUCTURE_MAP[jp_name]
            if kozo_val not in added_kozo:
                params.append(("kozo", kozo_val))
                added_kozo.add(kozo_val)

    # 敷金なし
    if criteria.no_deposit:
        params.append(("shikikin", "0"))

    # 礼金なし
    if criteria.no_key_money:
        params.append(("reikin", "0"))

    # 申込あり除外
    params.append(("is_exclude_moshikomi_exist", "true"))

    # ソート: 最終更新日順
    params.append(("order", "saishu_koshin_time.desc"))

    # ページネーション
    params.append(("items_per_page", "30"))
    params.append(("p", str(page)))

    return f"{ESSQUARE_SEARCH_URL}?{urlencode(params)}"


def build_search_url_with_kodawari(
    criteria: CustomerCriteria,
    equipment_names: list[str],
    page: int = 1,
) -> str:
    """設備名リスト付きで検索 URL を構築する。

    run.py から呼び出される際、sheets.py で読み込んだ設備名を渡す。
    """
    url = build_search_url(criteria, page)

    # kodawari パラメータを追加
    kodawari_params: list[tuple[str, str]] = []
    for name in equipment_names:
        name = name.strip()
        if name in KODAWARI_MAP:
            kodawari_params.append(("kodawari", KODAWARI_MAP[name]))

    if kodawari_params:
        url += "&" + urlencode(kodawari_params)

    return url


def search_properties(
    session: EsSquareSession,
    criteria: CustomerCriteria,
    equipment_names: list[str] | None = None,
) -> list[Property]:
    """いい生活Square で物件を検索して Property リストを返す。

    GraphQL レスポンスのインターセプトを優先し、
    失敗時は DOM パースにフォールバックする。
    最大 5 ページ (150 件) まで取得する。
    """
    # GraphQL インターセプターを設定 (以降の全ページ遷移で有効)
    try:
        session.setup_graphql_interceptor()
    except Exception as exc:
        print(f"[WARN] ES-Square: GraphQL インターセプター設定失敗: {exc}")

    all_properties: list[Property] = []
    max_pages = 5

    for page in range(1, max_pages + 1):
        if equipment_names:
            url = build_search_url_with_kodawari(
                criteria, equipment_names, page
            )
        else:
            url = build_search_url(criteria, page)

        print(f"[DEBUG] ES-Square 検索: page={page}, url={url[:200]}...")

        try:
            # ページ遷移 (get_page はセッション切れも自動処理)
            session.driver.get(url)

            # GraphQL レスポンスをポーリング
            graphql_data = _wait_for_graphql(session, timeout=15)

            if graphql_data:
                # GraphQL パス (優先)
                properties, has_next = parse_graphql_results(graphql_data)
            else:
                # DOM フォールバック
                print(
                    f"[WARN] ES-Square: GraphQL 取得失敗、"
                    f"DOM パースにフォールバック (page={page})"
                )
                html = session.driver.page_source
                properties, has_next = parse_search_results(html)

        except Exception as exc:
            print(f"[ERROR] ES-Square ページ取得失敗: {exc}")
            break

        all_properties.extend(properties)
        print(f"[DEBUG] ES-Square page={page}: {len(properties)} 件取得")

        if not has_next or not properties:
            break

        # レート制限対策: ランダム遅延
        time.sleep(random.uniform(2, 4))

    return all_properties


def _wait_for_graphql(
    session: EsSquareSession, timeout: int = 15
) -> list[dict] | None:
    """GraphQL レスポンスが到着するまでポーリングする。"""
    start = time.time()

    while time.time() - start < timeout:
        time.sleep(1)

        # セッション切れチェック
        try:
            current_url = session.driver.current_url
            if "es-account.com" in current_url or "/login" in current_url:
                print("[WARN] ES-Square: セッション切れ検出 (GraphQL 待機中)")
                return None
        except Exception:
            return None

        # インターセプトデータ取得
        try:
            data = session.execute_script(
                "return window.__esq_graphql || [];"
            )
            if data and len(data) > 0:
                return data
        except Exception:
            pass

    return None


def enrich_property_details(
    session: EsSquareSession,
    properties: list[Property],
) -> None:
    """各物件の詳細ページから追加情報を取得する (in-place 変更)。"""
    for prop in properties:
        if not prop.url:
            continue

        try:
            html = session.get_page(prop.url)
            details = parse_detail_page(html)

            # 詳細情報を Property にセット
            for key, value in details.items():
                if hasattr(prop, key) and value:
                    setattr(prop, key, value)

        except Exception as exc:
            print(
                f"[WARN] ES-Square 詳細取得失敗 "
                f"(room_id={prop.room_id}): {exc}"
            )

        # レート制限対策
        time.sleep(random.uniform(2, 4))
