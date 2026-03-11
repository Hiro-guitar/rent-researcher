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

    DOM パース (BeautifulSoup) をメインに、
    API レスポンスキャプチャを補助的に使用する。
    最大 5 ページ (150 件) まで取得する。
    """
    # API レスポンスキャプチャを設定 (全 fetch を記録)
    try:
        session.setup_api_interceptor()
    except Exception as exc:
        print(f"[WARN] ES-Square: API インターセプター設定失敗: {exc}")

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
            # ページ遷移 + レンダリング待ち
            html = session.get_page(url)

            # SPA レンダリング完了をさらに待つ
            _wait_for_render(session, timeout=10)

            # レンダリング後の最新 HTML を取得
            html = session.driver.page_source

            # ── デバッグ: ページ状態をログ出力 ──
            _debug_page_state(session, html, page)

            # DOM パースで物件データを抽出
            properties, has_next = parse_search_results(html)
            print(
                f"[DEBUG] ES-Square DOM パース: "
                f"{len(properties)} 件取得 (page={page})"
            )

            # DOM パースで 0 件の場合、API レスポンスを確認
            if not properties:
                print(
                    "[INFO] ES-Square: DOM パースで 0 件、"
                    "API レスポンスを確認..."
                )
                api_data = _get_captured_api_data(session)
                if api_data:
                    properties, has_next = parse_graphql_results(
                        api_data
                    )
                    print(
                        f"[DEBUG] ES-Square API パース: "
                        f"{len(properties)} 件取得"
                    )

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


def _wait_for_render(
    session: EsSquareSession, timeout: int = 10
) -> None:
    """SPA のレンダリング完了を待つ。

    検索結果の要素が表示されるか、タイムアウトするまで待機する。
    """
    start = time.time()
    while time.time() - start < timeout:
        try:
            # ページ内のテキスト量でレンダリング完了を推定
            text_len = session.execute_script(
                "return document.body ? document.body.innerText.length : 0;"
            )
            # 検索結果ページは通常数千文字以上
            if text_len and text_len > 500:
                # 「円」が含まれるか確認 (賃料表示の目印)
                has_yen = session.execute_script(
                    "return document.body.innerText.includes('円');"
                )
                if has_yen:
                    return
        except Exception:
            pass
        time.sleep(1)

    print("[WARN] ES-Square: レンダリング待ちタイムアウト")


def _debug_page_state(
    session: EsSquareSession, html: str, page: int
) -> None:
    """ページの状態をデバッグログに出力する。"""
    try:
        current_url = session.driver.current_url
        title = session.driver.title
        print(f"[DEBUG] ES-Square page={page}: URL={current_url}")
        print(f"[DEBUG] ES-Square page={page}: title={title}")
        print(f"[DEBUG] ES-Square page={page}: HTML size={len(html)}")

        # ページのテキスト内容から物件っぽい情報を確認
        body_text = session.execute_script(
            "return document.body ? document.body.innerText : '';"
        )
        if body_text:
            text_len = len(body_text)
            print(f"[DEBUG] ES-Square: body text length={text_len}")

            # 「円」の出現回数 (賃料関連テキストの数)
            yen_count = body_text.count("円")
            print(f"[DEBUG] ES-Square: '円' count={yen_count}")

            # 「万」の出現回数
            man_count = body_text.count("万")
            print(f"[DEBUG] ES-Square: '万' count={man_count}")

            # 「㎡」の出現回数 (面積)
            sqm_count = body_text.count("㎡")
            print(f"[DEBUG] ES-Square: '㎡' count={sqm_count}")

            # 「件」の出現回数 (検索結果件数表示)
            ken_count = body_text.count("件")
            print(f"[DEBUG] ES-Square: '件' count={ken_count}")

            # 先頭 2000 文字のダンプ
            preview = body_text[:2000].replace("\n", " | ")
            print(f"[DEBUG] ES-Square body preview: {preview}")

        # キャプチャした API URL リスト
        api_urls = session.execute_script(
            "return (window.__esq_api || []).map(r => r.url).slice(0, 20);"
        )
        if api_urls:
            print(
                f"[DEBUG] ES-Square: captured API URLs "
                f"({len(api_urls)} 件):"
            )
            for u in api_urls:
                print(f"[DEBUG]   {str(u)[:200]}")

    except Exception as exc:
        print(f"[DEBUG] ES-Square debug failed: {exc}")


def _get_captured_api_data(
    session: EsSquareSession,
) -> list[dict] | None:
    """キャプチャした API レスポンスデータを取得する。"""
    try:
        data = session.execute_script(
            "return window.__esq_api || [];"
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
