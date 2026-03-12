"""いい生活Square 検索 URL 構築・実行"""

import random
import re
import time
from urllib.parse import urlencode

from itandi_search.models import CustomerCriteria, Property

from .auth import EsSquareSession
from .config import (
    CITY_CODES,
    ESSQUARE_SEARCH_URL,
    KODAWARI_MAP,
    LAYOUT_MAP,
    STATION_CODES,
    STRUCTURE_MAP,
)
from .parsers import (
    parse_detail_page,
    parse_graphql_results,
    parse_search_results,
)

# サイト共通 UI 画像（チャットボットアイコン等）を除外するパターン
_JUNK_IMG = re.compile(
    r"okbiz|miibo|chatbot|faq-e-seikatsu|logo|icon|favicon"
    r"|avatar|badge|placeholder|loading|spinner"
    r"|es-service\.net|onetop",
    re.IGNORECASE,
)


def build_search_url(criteria: CustomerCriteria, page: int = 1) -> str:
    """CustomerCriteria → いい生活Square 検索 URL を構築する。"""
    params: list[tuple[str, str]] = []

    # 駅名指定がある場合は station パラメータを使用
    station_codes = _resolve_station_codes(criteria)
    if station_codes:
        for code in station_codes:
            params.append(("station", code))
    else:
        # 駅名がない場合のみ市区町村 (jusho) を使用
        cities = _resolve_cities(criteria)
        for city_name in cities:
            if city_name in CITY_CODES:
                params.append(("jusho", CITY_CODES[city_name]))

    # 賃料 (chinryo_from / chinryo_to) — 万円単位 (整数)
    if criteria.rent_max is not None:
        rent_man = criteria.rent_max // 10000
        params.append(("chinryo_to", str(rent_man)))
    if criteria.rent_min is not None:
        rent_man = criteria.rent_min // 10000
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


def _resolve_station_codes(criteria: CustomerCriteria) -> list[str]:
    """検索条件の駅名リストから ES-Square station コードを解決する。

    Returns:
        駅コードのリスト (例: ["13+256+2844", "13+256+8331"])
        駅名指定がない場合は空リスト
    """
    if not criteria.stations:
        return []

    codes: list[str] = []
    unmapped: list[str] = []
    for station in criteria.stations:
        station = station.strip()
        if station in STATION_CODES:
            codes.append(STATION_CODES[station])
        else:
            unmapped.append(station)

    if unmapped:
        print(
            f"[WARN] ES-Square: 駅コード未定義: "
            f"{', '.join(unmapped)}"
        )

    if codes:
        print(
            f"[INFO] ES-Square: 駅コード {len(codes)} 件解決 "
            f"(未解決: {len(unmapped)} 件)"
        )

    return codes


def _resolve_cities(criteria: CustomerCriteria) -> list[str]:
    """検索条件から市区町村リストを解決する (駅名がない場合のフォールバック)。"""
    if not criteria.cities:
        return []

    resolved = []
    for city in criteria.cities:
        city = city.strip()
        if city in CITY_CODES:
            resolved.append(city)
        else:
            print(f"[WARN] ES-Square: 市区町村コード未定義: {city}")
    return resolved


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
    # エリア指定なしの場合は検索をスキップ（全国検索防止）
    station_codes = _resolve_station_codes(criteria)
    cities = _resolve_cities(criteria)
    if not station_codes and not cities:
        print(
            "[WARN] ES-Square: エリア指定なし（駅名・市区町村とも未設定）"
            "→ 検索をスキップ"
        )
        return []

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
            render_status = _wait_for_render(session, timeout=20)

            # 0 件検出 → このページ以降は不要
            if render_status == "empty":
                print("[INFO] ES-Square: 検索結果 0 件")
                break

            # レンダリング失敗時: page=1 のみリトライ、2+ はスキップ
            if render_status == "timeout":
                if page == 1:
                    print("[INFO] ES-Square: リロードしてリトライ...")
                    html = session.get_page(url)
                    render_status = _wait_for_render(session, timeout=15)
                else:
                    print(
                        f"[WARN] ES-Square: page={page} "
                        f"レンダリング失敗、スキップ"
                    )
                    break

            # リトライ後も失敗
            if render_status != "rendered":
                if render_status == "empty":
                    print("[INFO] ES-Square: リトライ後も 0 件")
                else:
                    print("[WARN] ES-Square: リトライ後もレンダリング失敗")
                break

            # レンダリング後の最新 HTML を取得
            html = session.driver.page_source

            # DOM パースで物件データを抽出
            properties, has_next = parse_search_results(html)
            print(
                f"[DEBUG] ES-Square DOM パース: "
                f"{len(properties)} 件取得 (page={page})"
            )

            # Selenium JavaScript で詳細 UUID を抽出
            if properties:
                _assign_detail_urls(session, properties)

            # DOM パースで 0 件の場合はログのみ
            if not properties:
                print(
                    "[INFO] ES-Square: DOM パースで 0 件 "
                    "(SPA レンダリング未完了の可能性)"
                )

        except Exception as exc:
            print(f"[ERROR] ES-Square ページ取得失敗: {exc}")
            break

        all_properties.extend(properties)
        print(f"[DEBUG] ES-Square page={page}: {len(properties)} 件取得")

        if not has_next or not properties:
            break

        # レート制限対策: ランダム遅延
        time.sleep(random.uniform(1, 2))

    return all_properties


def _wait_for_render(
    session: EsSquareSession, timeout: int = 25
) -> str:
    """SPA のレンダリング完了を待つ。

    検索結果の要素が表示されるか、タイムアウトするまで待機する。
    Returns:
        "rendered" - 検索結果が表示された
        "empty" - 検索結果が 0 件（ページは表示された）
        "timeout" - レンダリングがタイムアウト
    """
    start = time.time()
    last_len = 0
    stale_start: float | None = None  # テキスト長が変化しなくなった時刻

    while time.time() - start < timeout:
        try:
            indicators = session.execute_script("""
                var body = document.body;
                if (!body) return {len: 0, yen: false, sqm: false,
                                   zero: false, search: false};
                var t = body.innerText;
                return {
                    len: t.length,
                    yen: t.includes('円'),
                    sqm: t.includes('㎡'),
                    zero: /0\\s*件/.test(t),
                    search: t.includes('検索')
                };
            """)
            if not indicators:
                time.sleep(1)
                continue

            text_len = indicators.get("len", 0)
            has_yen = indicators.get("yen", False)
            has_sqm = indicators.get("sqm", False)
            has_zero = indicators.get("zero", False)
            has_search = indicators.get("search", False)

            # 検索結果ページは「円」と「㎡」の両方を含む
            if text_len > 1000 and has_yen and has_sqm:
                return "rendered"
            # 「円」のみでもテキスト量が多ければ OK
            if text_len > 2000 and has_yen:
                return "rendered"

            # 0 件のページ（ページ自体は表示されている）
            if text_len > 800 and has_search and has_zero and not has_yen:
                return "empty"

            # テキスト長の変化を追跡 → 停滞検出
            if text_len != last_len:
                last_len = text_len
                stale_start = None
            elif stale_start is None:
                stale_start = time.time()
            elif time.time() - stale_start > 8:
                print(
                    f"[WARN] ES-Square: ページが {text_len} chars "
                    f"で停止（8秒以上変化なし）"
                )
                break

        except Exception:
            pass
        time.sleep(1)

    print("[WARN] ES-Square: レンダリング待ちタイムアウト")
    return "timeout"


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


def _log_browser_diagnostics(
    session: EsSquareSession, page: int
) -> None:
    """レンダリング失敗時のブラウザ診断情報をログ出力する。"""
    try:
        diag = session.execute_script("""
            var result = {};
            result.url = window.location.href;
            result.title = document.title;
            var body = document.body;
            result.bodyLen = body ? body.innerText.length : 0;
            result.bodyPreview = body
                ? body.innerText.substring(0, 500).replace(/\\n/g, ' | ')
                : '';
            // React エラーバウンダリのチェック
            var errEl = document.querySelector(
                '[class*="error"], [class*="Error"], [role="alert"]'
            );
            result.errorEl = errEl
                ? errEl.textContent.substring(0, 200)
                : null;
            // #root / #app の内容量
            var root = document.getElementById('root')
                || document.getElementById('app')
                || document.getElementById('__next');
            result.rootLen = root ? root.innerText.length : -1;
            return result;
        """)
        if diag:
            print(f"[DEBUG] ES-Square 診断 page={page}:")
            print(f"[DEBUG]   URL: {diag.get('url', '?')}")
            print(f"[DEBUG]   title: {diag.get('title', '?')}")
            print(f"[DEBUG]   bodyLen: {diag.get('bodyLen', 0)}")
            print(f"[DEBUG]   rootLen: {diag.get('rootLen', -1)}")
            if diag.get("errorEl"):
                print(f"[DEBUG]   ERROR: {diag['errorEl']}")
            print(f"[DEBUG]   preview: {diag.get('bodyPreview', '')}")
    except Exception as exc:
        print(f"[DEBUG] ES-Square 診断失敗: {exc}")


def _assign_detail_urls(
    session: EsSquareSession,
    properties: list[Property],
) -> None:
    """React Fiber の bukkenGuid から詳細ページ UUID を抽出し、
    Property.url と room_id を設定する。

    ES-Square の React SPA は物件行コンポーネントの props に
    bukkenGuid (物件UUID) を保持している。Fiber ツリーを走査して取得する。
    """
    try:
        uuids = session.execute_script("""
            var allDivs = document.querySelectorAll('div[class*="MuiBox-root"]');
            var propertyRows = [];
            for (var i = 0; i < allDivs.length; i++) {
                var div = allDivs[i];
                var children = [];
                for (var c = div.firstElementChild; c; c = c.nextElementSibling) {
                    if (c.tagName === 'DIV') children.push(c);
                }
                if (children.length >= 6) {
                    var t = div.innerText || '';
                    if (t.indexOf('円') !== -1 && t.indexOf('㎡') !== -1) {
                        propertyRows.push(div);
                    }
                }
            }

            // Find React Fiber key
            var fiberKey = null;
            for (var r = 0; r < propertyRows.length; r++) {
                for (var key in propertyRows[r]) {
                    if (key.indexOf('__reactFiber$') === 0) {
                        fiberKey = key;
                        break;
                    }
                }
                if (fiberKey) break;
            }
            if (!fiberKey) return [];

            // Extract bukkenGuid from each row's fiber tree
            var results = [];
            var uuidPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

            function findBukkenGuid(fiber, maxDepth) {
                if (!fiber || maxDepth <= 0) return null;
                try {
                    var p = fiber.memoizedProps;
                    if (p && typeof p.bukkenGuid === 'string'
                        && uuidPattern.test(p.bukkenGuid)) {
                        return p.bukkenGuid;
                    }
                } catch(e) {}
                // Search child first, then sibling
                var found = findBukkenGuid(fiber.child, maxDepth - 1);
                if (found) return found;
                return findBukkenGuid(fiber.sibling, maxDepth - 1);
            }

            for (var j = 0; j < propertyRows.length; j++) {
                var fiber = propertyRows[j][fiberKey];
                var guid = findBukkenGuid(fiber, 10);
                if (guid) {
                    results.push(guid);
                } else {
                    results.push(null);
                }
            }
            return results;
        """)

        if uuids:
            # null を除いた有効な UUID の数
            valid = [u for u in uuids if u]
            print(
                f"[DEBUG] ES-Square: bukkenGuid {len(valid)} 件取得 "
                f"(rows={len(uuids)})"
            )

            # properties と uuids を物件名でマッチング
            # DOM の行順と properties の順序が一致する前提
            uuid_idx = 0
            for prop in properties:
                if prop.url:
                    continue
                # 有効な UUID を順番に割り当て
                while uuid_idx < len(uuids):
                    guid = uuids[uuid_idx]
                    uuid_idx += 1
                    if guid:
                        prop.room_id = guid
                        prop.building_id = (
                            guid.split("-")[0] if "-" in guid else guid
                        )
                        prop.url = (
                            f"https://rent.es-square.net"
                            f"/bukken/chintai/search/detail/{guid}"
                        )
                        break
        else:
            print("[DEBUG] ES-Square: UUID が見つかりませんでした")

    except Exception as exc:
        print(f"[WARN] ES-Square UUID 抽出失敗: {exc}")


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


def _wait_for_detail_render(
    session: EsSquareSession, timeout: int = 10
) -> bool:
    """詳細ページのレンダリング完了を待つ。

    物件名や賃料テキストが表示されるまで待機する。
    Returns: True if rendered, False if timeout
    """
    start = time.time()
    while time.time() - start < timeout:
        try:
            result = session.execute_script("""
                var body = document.body;
                if (!body) return {len: 0, ready: false};
                var t = body.innerText;
                return {
                    len: t.length,
                    ready: t.length > 500 && (
                        t.includes('物件概要') || t.includes('設備')
                        || t.includes('賃料') || t.includes('間取')
                        || t.includes('所在地')
                    ),
                    imgCount: document.querySelectorAll('img[src]').length
                };
            """)
            if result and result.get("ready"):
                return True
        except Exception:
            pass
        time.sleep(1)
    return False


def enrich_property_details(
    session: EsSquareSession,
    properties: list[Property],
) -> None:
    """各物件の詳細ページから追加情報を取得する (in-place 変更)。

    画像取得の優先順位:
    1. API レスポンスデータから画像 URL を抽出
    2. Swiper ギャラリーモーダルを操作して Performance API でキャプチャ
    3. DOM の img タグから HTTP URL を直接取得 (フォールバック)
    """
    for prop in properties:
        if not prop.url:
            continue

        try:
            html = session.get_page(prop.url)

            # SPA レンダリング完了を待つ
            rendered = _wait_for_detail_render(session, timeout=10)
            if rendered:
                html = session.driver.page_source

            details = parse_detail_page(html)

            # parse_detail_page が返す画像からサイト共通UI画像を除外
            if details.get("image_urls"):
                cleaned = [
                    u for u in details["image_urls"]
                    if not _JUNK_IMG.search(u)
                ]
                details["image_urls"] = cleaned
                if not cleaned:
                    details["image_url"] = None

            # 画像取得: 複数の方法を順番に試行
            if not details.get("image_urls"):
                # インターセプターでトラッキングした画像 fetch URL をクリア
                # (前の物件の画像が混ざらないようにする)
                _clear_img_fetch_tracking(session)

                # 1. Swiper ギャラリーを操作して画像を取得
                #    ギャラリー操作中に fetch される画像 URL を
                #    インターセプターがトラッキングする
                gallery_images = _extract_gallery_images(session)
                if gallery_images:
                    details["image_urls"] = gallery_images
                    if not details.get("image_url"):
                        details["image_url"] = gallery_images[0]
                    print(
                        f"[DEBUG] ES-Square 画像取得: "
                        f"ギャラリーから {len(gallery_images)} 件"
                    )

            if not details.get("image_urls"):
                # 2. API レスポンスデータから画像 URL を探す
                api_images = _extract_images_from_api_data(session)
                if api_images:
                    details["image_urls"] = api_images
                    if not details.get("image_url"):
                        details["image_url"] = api_images[0]
                    print(
                        f"[DEBUG] ES-Square 画像取得: "
                        f"API データから {len(api_images)} 件"
                    )

            if not details.get("image_urls"):
                # 3. DOM の img タグからフォールバック取得
                js_images = _extract_images_via_js(session)
                if js_images:
                    details["image_urls"] = js_images
                    if not details.get("image_url"):
                        details["image_url"] = js_images[0]
                    print(
                        f"[DEBUG] ES-Square 画像取得: "
                        f"DOM から {len(js_images)} 件"
                    )

            # 詳細情報を Property にセット
            for key, value in details.items():
                if hasattr(prop, key) and value:
                    setattr(prop, key, value)

            img_count = len(prop.image_urls) if prop.image_urls else 0
            img_src = "none"
            if img_count > 0:
                first_url = prop.image_urls[0][:80] if prop.image_urls else ""
                img_src = first_url
            print(
                f"[DEBUG] ES-Square 詳細取得完了 "
                f"(room_id={prop.room_id}): "
                f"images={img_count}, src={img_src}"
            )

        except Exception as exc:
            print(
                f"[WARN] ES-Square 詳細取得失敗 "
                f"(room_id={prop.room_id}): {exc}"
            )

        # レート制限対策
        time.sleep(random.uniform(1, 2))


def _extract_images_from_api_data(
    session: EsSquareSession,
) -> list[str]:
    """キャプチャ済み API レスポンスデータから画像 URL を再帰的に抽出する。

    詳細ページの API レスポンス JSON 内に含まれる画像 URL を探索する。
    """
    try:
        urls = session.execute_script("""
            var apiData = window.__esq_api || [];
            var imageUrls = [];
            var seen = {};
            var SKIP = /logo|icon|favicon|avatar|badge|placeholder|no.?image|es-service\.net|onetop|okbiz|miibo|chatbot/i;

            function search(obj, depth) {
                if (depth > 8 || !obj) return;
                if (typeof obj === 'string') {
                    if (/^https?:\\/\\//i.test(obj)
                        && /\\.(jpg|jpeg|png|webp|gif|avif)/i.test(obj)
                        && !SKIP.test(obj)
                        && !seen[obj]) {
                        seen[obj] = true;
                        imageUrls.push(obj);
                    }
                    return;
                }
                if (Array.isArray(obj)) {
                    for (var i = 0; i < Math.min(obj.length, 200); i++) {
                        search(obj[i], depth + 1);
                    }
                    return;
                }
                if (typeof obj === 'object') {
                    var keys = Object.keys(obj);
                    for (var k = 0; k < keys.length; k++) {
                        search(obj[keys[k]], depth + 1);
                    }
                }
            }

            for (var i = 0; i < apiData.length; i++) {
                search(apiData[i].data, 0);
            }
            return imageUrls;
        """)
        if urls:
            print(f"[DEBUG] ES-Square API画像: {len(urls)} 件発見")
        return urls[:20] if urls else []
    except Exception as exc:
        print(f"[WARN] ES-Square API画像抽出失敗: {exc}")
        return []


def _clear_img_fetch_tracking(session: EsSquareSession) -> None:
    """画像 fetch トラッキングをクリアする (物件間の混入防止)。"""
    try:
        session.execute_script("window.__esq_img_fetches = [];")
    except Exception:
        pass


def _get_tracked_img_urls(session: EsSquareSession) -> list[str]:
    """インターセプターがトラッキングした画像 fetch URL を取得する。

    fetch() で取得された画像の元の HTTP URL を返す。
    blob URL ではなく、Discord embed で使用可能な HTTP URL。
    """
    try:
        urls = session.execute_script(
            "return window.__esq_img_fetches || [];"
        )
        if urls:
            # ジャンク画像を除外
            cleaned = [
                u for u in urls
                if isinstance(u, str) and not _JUNK_IMG.search(u)
            ]
            return cleaned[:20]
    except Exception:
        pass
    return []


def _close_gallery_modal(session: EsSquareSession) -> None:
    """ギャラリーモーダルを確実に閉じる。"""
    try:
        session.execute_script("""
            // 参考スクリプトのクローズセレクタ
            var close = document.querySelector(
                '.MuiBox-root.css-11p4x25'
            );
            if (close) { close.click(); return; }
            // MUI Dialog の閉じるボタン
            var closeBtn = document.querySelector(
                '[aria-label="close"], [aria-label="Close"],'
                + 'button.MuiIconButton-root[aria-label*="close"]'
            );
            if (closeBtn) { closeBtn.click(); return; }
            // Backdrop クリック
            var backdrop = document.querySelector(
                '.MuiBackdrop-root, [class*="backdrop"],'
                + '[class*="overlay"]'
            );
            if (backdrop) { backdrop.click(); return; }
            // ESC キー
            document.dispatchEvent(
                new KeyboardEvent('keydown', {
                    key: 'Escape', code: 'Escape', bubbles: true,
                })
            );
        """)
        time.sleep(0.5)
    except Exception:
        pass


def _extract_gallery_images(
    session: EsSquareSession,
) -> list[str]:
    """Swiper ギャラリーモーダルを操作して物件画像 URL を取得する。

    ES-Square の物件画像は Swiper カルーセルモーダル内に blob URL で
    表示される。以下の方法で HTTP URL を取得する:
    1. fetch インターセプターがトラッキングした画像 HTTP URL
    2. Performance API から画像リクエスト URL

    参考: ユーザー提供の Tampermonkey スクリプト
    - サムネイル: .css-tx2s10 img
    - モーダル画像: .swiper-slide-active .css-oq6icw img
    - 次へボタン: svg[data-testid="keyboardArrowRight"] 内 .css-1nuul26
    - 閉じるボタン: .MuiBox-root.css-11p4x25
    - 画像ロード完了: img.complete && img.naturalWidth > 0
    """
    try:
        # Performance エントリをクリア (ギャラリー操作分のみキャプチャ)
        session.execute_script("performance.clearResourceTimings();")

        # サムネイルをクリックしてギャラリーモーダルを開く
        clicked = session.execute_script("""
            // 参考スクリプトのセレクタ
            var thumb = document.querySelector('.css-tx2s10 img');
            if (thumb && thumb.naturalWidth > 0) {
                thumb.click();
                return 'css-tx2s10';
            }
            // フォールバック: Swiper 関連の画像
            var swiperImg = document.querySelector(
                '.swiper img, [class*="swiper"] img'
            );
            if (swiperImg && swiperImg.naturalWidth > 0) {
                swiperImg.click();
                return 'swiper';
            }
            // フォールバック: blob URL の画像 or 大きい画像
            var imgs = document.querySelectorAll('img');
            for (var i = 0; i < imgs.length; i++) {
                var img = imgs[i];
                var src = img.src || '';
                var w = img.naturalWidth || img.width || 0;
                var h = img.naturalHeight || img.height || 0;
                if ((src.indexOf('blob:') === 0 || (w > 100 && h > 80))
                    && !/logo|icon|avatar|badge|chatbot|miibo/i.test(
                        (img.className || '') + (img.alt || '') + src
                    )) {
                    img.click();
                    return 'fallback';
                }
            }
            return null;
        """)

        if not clicked:
            print("[DEBUG] ES-Square: ギャラリーサムネイル未検出")
            return []

        print(f"[DEBUG] ES-Square: サムネイルクリック ({clicked})")

        # Swiper モーダルの画像ロードを待つ
        # (Tampermonkey 参考: img.complete && img.naturalWidth > 0)
        modal_ready = False
        for _ in range(10):
            time.sleep(0.5)
            modal_ready = session.execute_script("""
                var active = document.querySelector(
                    '.swiper-slide-active .css-oq6icw img,'
                    + '.swiper-slide-active img'
                );
                if (active && active.complete
                    && active.naturalWidth > 0) return true;
                // フォールバック: Swiper コンテナ自体の存在確認
                var swiper = document.querySelector(
                    '.swiper-slide-active, [class*="swiper"]'
                );
                return !!swiper;
            """)
            if modal_ready:
                break

        if not modal_ready:
            print("[DEBUG] ES-Square: ギャラリーモーダル未検出")
            return []

        print("[DEBUG] ES-Square: ギャラリーモーダル表示確認")

        # 全スライドを順番にナビゲート
        slide_count = 0
        max_slides = 25
        for _ in range(max_slides):
            # 次へボタンの検出とクリック
            # (Tampermonkey 参考: .css-1nuul26 内の ArrowRight アイコン)
            nav_result = session.execute_script("""
                // 方法1: Tampermonkey と同じセレクタ
                var nextContainer = document.querySelector('.css-1nuul26');
                if (nextContainer) {
                    var style = window.getComputedStyle(nextContainer);
                    if (style.pointerEvents === 'none'
                        || nextContainer.hasAttribute('disabled')) {
                        return 'disabled';
                    }
                    nextContainer.click();
                    return 'clicked';
                }
                // 方法2: ArrowRight アイコンから親ボタンを探す
                var nextIcon = document.querySelector(
                    'svg[data-testid="KeyboardArrowRightIcon"],'
                    + 'svg[data-testid="keyboardArrowRight"],'
                    + 'svg[data-testid="ArrowForwardIosIcon"],'
                    + 'svg[data-testid="NavigateNextIcon"]'
                );
                if (!nextIcon) return 'no_button';
                var el = nextIcon;
                for (var i = 0; i < 5; i++) {
                    el = el.parentElement;
                    if (!el) break;
                    var s = window.getComputedStyle(el);
                    if (s.pointerEvents === 'none') return 'disabled';
                    if (el.tagName === 'BUTTON'
                        || el.getAttribute('role') === 'button'
                        || el.onclick
                        || s.cursor === 'pointer') {
                        el.click();
                        return 'clicked';
                    }
                }
                // 最後の手段: アイコンの親をクリック
                var parent = nextIcon.parentElement;
                if (parent) { parent.click(); return 'clicked'; }
                return 'no_button';
            """)

            if nav_result != "clicked":
                print(
                    f"[DEBUG] ES-Square: ナビゲーション終了 "
                    f"(reason={nav_result})"
                )
                break

            slide_count += 1

            # 画像ロード完了を待つ
            # (Tampermonkey 参考: waitForImageChange)
            for _ in range(6):
                time.sleep(0.3)
                loaded = session.execute_script("""
                    var img = document.querySelector(
                        '.swiper-slide-active .css-oq6icw img,'
                        + '.swiper-slide-active img'
                    );
                    return img && img.complete
                        && img.naturalWidth > 0;
                """)
                if loaded:
                    break

        print(
            f"[DEBUG] ES-Square: {slide_count} スライドナビゲート"
        )

        # 画像 URL を収集: fetch インターセプター + Performance API
        # 方法1: fetch インターセプターでトラッキングした HTTP URL
        tracked_urls = _get_tracked_img_urls(session)

        # 方法2: Performance API から画像リクエスト URL を収集
        perf_urls = session.execute_script("""
            var entries = performance.getEntriesByType('resource');
            var imgUrls = [];
            var seen = {};
            var SKIP = /logo|icon|favicon|avatar|badge|chatbot|miibo|okbiz|es-service\.net|onetop/i;
            var SKIP_EXT = /\\.(js|css|woff|woff2|ttf|eot|svg)$/i;

            for (var i = 0; i < entries.length; i++) {
                var name = entries[i].name;
                if (seen[name] || SKIP.test(name)
                    || SKIP_EXT.test(name)) continue;

                var isImageExt = /\\.(jpg|jpeg|png|webp|gif|bmp|avif)/i
                    .test(name);
                var init = entries[i].initiatorType;
                var size = (entries[i].transferSize || 0)
                    + (entries[i].decodedBodySize || 0);

                if (isImageExt
                    || ((init === 'fetch'
                        || init === 'xmlhttprequest')
                        && size > 5000)) {
                    imgUrls.push(name);
                    seen[name] = true;
                }
            }
            return imgUrls;
        """) or []

        # モーダルを閉じる
        _close_gallery_modal(session)

        # 結果をマージ (fetch トラッキング優先、重複除去)
        seen: set[str] = set()
        result: list[str] = []
        for url in tracked_urls + perf_urls:
            if url not in seen and not _JUNK_IMG.search(url):
                seen.add(url)
                result.append(url)

        if result:
            print(
                f"[DEBUG] ES-Square ギャラリー画像: "
                f"{len(result)} URL "
                f"(fetch={len(tracked_urls)}, "
                f"perf={len(perf_urls)})"
            )
            for u in result[:3]:
                print(f"[DEBUG]   {str(u)[:150]}")

        return result[:20]

    except Exception as exc:
        print(f"[WARN] ES-Square ギャラリー画像取得失敗: {exc}")
        _close_gallery_modal(session)
        return []


def _extract_images_via_js(session: EsSquareSession) -> list[str]:
    """JavaScript で画像 URL を直接取得する (最終フォールバック)。

    DOM の img タグから HTTP URL を収集する。
    blob: URL は除外（Discord embed で使用不可のため）。
    """
    try:
        urls = session.execute_script("""
            var urls = [];
            var seen = {};
            var SKIP = /placeholder|logo|icon|favicon|avatar|badge|es-service\.net|onetop|okbiz|miibo|chatbot/i;

            var imgs = document.querySelectorAll('img');
            for (var i = 0; i < imgs.length; i++) {
                var src = imgs[i].src
                    || imgs[i].getAttribute('data-src') || '';
                if (!src || src.startsWith('data:')
                    || src.startsWith('blob:')
                    || !src.startsWith('http')
                    || SKIP.test(src) || seen[src]) continue;
                var w = imgs[i].naturalWidth || imgs[i].width || 0;
                var h = imgs[i].naturalHeight || imgs[i].height || 0;
                if ((w === 0 && h === 0) || (w > 50 && h > 50)) {
                    urls.push(src);
                    seen[src] = true;
                }
            }
            return urls;
        """)
        return urls[:20] if urls else []
    except Exception as exc:
        print(f"[WARN] ES-Square JS画像取得失敗: {exc}")
    return []
