"""いい生活Square 検索 URL 構築・実行"""

import base64
import json
import random
import re
import time
from urllib.parse import urlencode

from itandi_search.models import CustomerCriteria, Property

from .auth import EsSquareSession
from .config import (
    BUILDING_TYPE_MAP,
    CITY_CODES,
    ESSQUARE_SEARCH_URL,
    KODAWARI_MAP,
    LAYOUT_MAP,
    STATION_CODES,
    STRUCTURE_MAP,
    UPDATE_WITHIN_MAP,
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
    r"|es-service\.net|onetop|sfa_main_banner",
    re.IGNORECASE,
)


def build_search_url(
    criteria: CustomerCriteria,
    page: int = 1,
    *,
    is_test_customer: bool = False,
) -> str:
    """CustomerCriteria → いい生活Square 検索 URL を構築する。"""
    params: list[tuple[str, str]] = []

    # 駅名指定がある場合は station パラメータを使用
    station_codes = _resolve_station_codes(criteria)
    if station_codes:
        for code in station_codes:
            params.append(("station", code))
        # 一部の駅が未解決の場合、市区町村も追加してカバー範囲を広げる
        unmapped_count = (
            len(criteria.stations) - len(station_codes)
            if criteria.stations
            else 0
        )
        if unmapped_count > 0 and criteria.cities:
            cities = _resolve_cities(criteria)
            for city_name in cities:
                if city_name in CITY_CODES:
                    params.append(("jusho", CITY_CODES[city_name]))
            print(
                f"[INFO] ES-Square: 未解決駅 {unmapped_count} 件の"
                f"カバーのため市区町村も追加"
            )
    else:
        # 駅名がない場合のみ市区町村 (jusho) を使用
        cities = _resolve_cities(criteria)
        for city_name in cities:
            if city_name in CITY_CODES:
                params.append(("jusho", CITY_CODES[city_name]))
        if criteria.stations:
            print(
                "[WARN] ES-Square: 全駅が未解決のため"
                "市区町村検索にフォールバック"
            )

    # 賃料 (chinryo.from / chinryo.to) — 円単位、ドット区切り
    if criteria.rent_max is not None:
        params.append(("chinryo.to", str(criteria.rent_max)))
        print(
            f"[INFO] ES-Square: 賃料上限 chinryo.to={criteria.rent_max:,}円"
        )
    else:
        print("[WARN] ES-Square: 賃料上限が未設定 (rent_max=None)")
    if criteria.rent_min is not None:
        params.append(("chinryo.from", str(criteria.rent_min)))

    # 間取り (search_madori_code2) — 連番コード、複数値はキー繰り返し
    for layout in criteria.layouts:
        layout = layout.strip()
        if layout in LAYOUT_MAP:
            params.append(("search_madori_code2", LAYOUT_MAP[layout]))
        else:
            print(f"[WARN] ES-Square: 間取りマッピング未定義: {layout}")

    # 専有面積 (search_menseki.from / search_menseki.to) — ㎡単位
    if criteria.area_min is not None:
        params.append(("search_menseki.from", str(int(criteria.area_min))))
    if criteria.area_max is not None:
        params.append(("search_menseki.to", str(int(criteria.area_max))))

    # 築年数 (chiku_nensu) — 年数 (例: 10 = 10年以内)
    if criteria.building_age is not None:
        params.append(("chiku_nensu", str(criteria.building_age)))

    # 駅徒歩 (kotsu_ekitoho) — 分 (例: 10 = 10分以内)
    if criteria.walk_minutes is not None:
        params.append(("kotsu_ekitoho", str(criteria.walk_minutes)))

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

    # 建物種別 (search_boshu_shubetsu_code)
    # itandi API の building_detail_type 値 → ES-Square コードに変換
    if criteria.building_types:
        added_types: set[str] = set()
        unmapped_types: list[str] = []
        for bt in criteria.building_types:
            code = BUILDING_TYPE_MAP.get(bt)
            if code and code not in added_types:
                params.append(("search_boshu_shubetsu_code", code))
                added_types.add(code)
            elif not code:
                unmapped_types.append(bt)
        if added_types:
            print(
                f"[INFO] ES-Square: 建物種別フィルタ適用: "
                f"{list(added_types)}"
            )
        if unmapped_types:
            print(
                f"[WARN] ES-Square: 建物種別マッピング未定義: "
                f"{unmapped_types}"
            )

    # 敷金なし
    if criteria.no_deposit:
        params.append(("shikikin_nashi_flag", "true"))

    # 礼金なし
    if criteria.no_key_money:
        params.append(("reikin_nashi_flag", "true"))

    # 最終更新日 (koshin_radio_state)
    if criteria.update_within_days is not None:
        # 最も近い選択肢にマッピング (1→today, 3→threeDays, 7→sevenDays)
        best_key: int | None = None
        for days_key in sorted(UPDATE_WITHIN_MAP.keys()):
            if criteria.update_within_days <= days_key:
                best_key = days_key
                break
        if best_key is None:
            # 7日より大きい場合は sevenDays を使用
            best_key = max(UPDATE_WITHIN_MAP.keys())
        params.append(
            ("koshin_radio_state", UPDATE_WITHIN_MAP[best_key])
        )
        print(
            f"[INFO] ES-Square: 最終更新日フィルタ適用: "
            f"{UPDATE_WITHIN_MAP[best_key]} "
            f"(指定: {criteria.update_within_days}日)"
        )

    # 申込あり除外（テスト顧客の場合はスキップ）
    if not is_test_customer:
        params.append(("is_exclude_moshikomi_exist", "true"))
    else:
        print("[INFO] ES-Square: テスト顧客のため申込あり除外をスキップ")

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
    *,
    is_test_customer: bool = False,
) -> str:
    """設備名リスト付きで検索 URL を構築する。

    run.py から呼び出される際、sheets.py で読み込んだ設備名を渡す。
    """
    url = build_search_url(criteria, page, is_test_customer=is_test_customer)

    # kodawari パラメータを追加
    kodawari_params: list[tuple[str, str]] = []
    unmapped_kodawari: list[str] = []
    for name in equipment_names:
        name = name.strip()
        if not name:
            continue
        if name in KODAWARI_MAP:
            kodawari_params.append(("kodawari", KODAWARI_MAP[name]))
        else:
            unmapped_kodawari.append(name)

    if kodawari_params:
        url += "&" + urlencode(kodawari_params)
        print(
            f"[INFO] ES-Square: kodawari {len(kodawari_params)} 件適用"
        )

    if unmapped_kodawari:
        print(
            f"[WARN] ES-Square: kodawari マッピング未定義 "
            f"({len(unmapped_kodawari)} 件): "
            f"{', '.join(unmapped_kodawari)}"
        )

    return url


def search_properties(
    session: EsSquareSession,
    criteria: CustomerCriteria,
    equipment_names: list[str] | None = None,
    *,
    is_test_customer: bool = False,
) -> tuple[list[Property], str]:
    """いい生活Square で物件を検索して (Property リスト, 検索URL) を返す。

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
        return [], ""

    # API レスポンスキャプチャを設定 (全 fetch を記録)
    try:
        session.setup_api_interceptor()
    except Exception as exc:
        print(f"[WARN] ES-Square: API インターセプター設定失敗: {exc}")

    all_properties: list[Property] = []
    max_pages = 5
    first_page_url = ""  # page=1 の検索URL（Discord通知用）

    for page in range(1, max_pages + 1):
        if equipment_names:
            url = build_search_url_with_kodawari(
                criteria, equipment_names, page,
                is_test_customer=is_test_customer,
            )
        else:
            url = build_search_url(
                criteria, page, is_test_customer=is_test_customer
            )

        if page == 1:
            first_page_url = url

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

    return all_properties, first_page_url


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
                // Search children only (child + child's siblings)
                // Do NOT traverse the root's own siblings to avoid
                // leaking into the next property row's fiber subtree
                var child = fiber.child;
                while (child) {
                    var found = findBukkenGuid(child, maxDepth - 1);
                    if (found) return found;
                    child = child.sibling;
                }
                return null;
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
    1. CDP Network ログから api.e-bukken-1.com の画像 URL を抽出
    2. Swiper ギャラリーモーダル操作 + fetch インターセプター
    3. API レスポンスデータから画像 URL を抽出
    4. DOM の img タグから HTTP URL を直接取得 (フォールバック)
    """
    for prop in properties:
        if not prop.url:
            continue

        try:
            # CDP Network ドメインを有効化
            # (Network.getResponseBody で画像を取得するために必要)
            try:
                session.driver.execute_cdp_cmd(
                    'Network.enable', {}
                )
            except Exception:
                pass

            # CDP ログをクリア (前の物件のログが混ざらないようにする)
            try:
                session.driver.get_log('performance')
            except Exception:
                pass

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
                _clear_img_fetch_tracking(session)

                # 1. ギャラリーを操作して画像ロードを誘発
                _extract_gallery_images(session)

                # 2. CDP Network ログから画像 URL を抽出 (最も確実)
                cdp_entries = _extract_images_from_cdp(session)
                if cdp_entries:
                    # 全画像を CDP でダウンロード
                    raw_images: list[bytes] = []
                    for _, req_id in cdp_entries:
                        img_bytes = _download_image_via_cdp(
                            session, req_id
                        )
                        if img_bytes:
                            raw_images.append(img_bytes)

                    # 同一画像の低画質版を除外
                    unique_images = _dedup_images(raw_images)

                    # catbox.moe にアップロード
                    public_urls: list[str] = []
                    for i, img_bytes in enumerate(
                        unique_images
                    ):
                        cat_url = _upload_to_catbox(img_bytes)
                        if cat_url:
                            public_urls.append(cat_url)
                        # レート制限回避
                        if i < len(unique_images) - 1:
                            time.sleep(0.3)

                    if public_urls:
                        details["image_urls"] = public_urls
                        details["image_url"] = public_urls[0]
                        print(
                            f"[DEBUG] ES-Square catbox "
                            f"アップロード: "
                            f"{len(public_urls)} 件成功"
                        )
                    else:
                        cdp_urls = [
                            u for u, _ in cdp_entries
                        ]
                        details["image_urls"] = cdp_urls
                        if not details.get("image_url"):
                            details["image_url"] = cdp_urls[0]

                    # image_data は不要 — 承認ページで catbox URL
                    # から全画像表示できるため Discord サムネ添付しない

            if not details.get("image_urls"):
                # 3. API レスポンスデータから画像 URL を探す
                api_images = _extract_images_from_api_data(session)
                if api_images:
                    details["image_urls"] = api_images
                    if not details.get("image_url"):
                        details["image_url"] = api_images[0]

            if not details.get("image_urls"):
                # 4. DOM の img タグからフォールバック取得
                js_images = _extract_images_via_js(session)
                if js_images:
                    details["image_urls"] = js_images
                    if not details.get("image_url"):
                        details["image_url"] = js_images[0]

            # 詳細情報を Property にセット
            for key, value in details.items():
                if hasattr(prop, key) and value:
                    setattr(prop, key, value)

            img_count = (
                len(prop.image_urls) if prop.image_urls else 0
            )
            print(
                f"[DEBUG] ES-Square 詳細取得完了 "
                f"(room_id={prop.room_id}): "
                f"images={img_count}"
            )

        except Exception as exc:
            print(
                f"[WARN] ES-Square 詳細取得失敗 "
                f"(room_id={prop.room_id}): {exc}"
            )

        # レート制限対策
        time.sleep(random.uniform(1, 2))



def _image_dhash(data: bytes) -> int | None:
    """画像の Difference Hash (dHash) を計算する。

    16x17 のグレースケールに縮小し、隣接ピクセルの
    輝度差で 256bit ハッシュを生成する。Average Hash より
    頑健で、異なる画像の誤マッチが大幅に減る。
    """
    try:
        import io
        from PIL import Image

        img = Image.open(io.BytesIO(data))
        # dHash: 幅を +1 にして隣接比較
        img = img.convert('L').resize((17, 16), Image.LANCZOS)
        pixels = list(img.getdata())
        bits = []
        for row in range(16):
            for col in range(16):
                idx = row * 17 + col
                bits.append(
                    1 if pixels[idx] < pixels[idx + 1] else 0
                )
        return int(''.join(str(b) for b in bits), 2)
    except Exception:
        return None


def _hamming_distance(h1: int, h2: int) -> int:
    """2つのハッシュ間の Hamming Distance を計算する。"""
    return bin(h1 ^ h2).count('1')


# 同一画像と判定する Hamming Distance の閾値
# 256bit dHash で 12 以下 → 同一画像の異なる解像度
_DEDUP_THRESHOLD = 12


def _dedup_images(
    images: list[bytes],
) -> list[bytes]:
    """dHash + Hamming Distance で同一画像を重複排除する。

    完全一致だけでなく、類似度ベースで判定するため:
    - 同じ画像のサムネイル/フルサイズを確実に検出 (issue #1)
    - 異なる画像の誤マッチを防止 (issue #2)
    各グループから最大サイズ（高画質）の画像のみ保持する。
    """
    # (hash, bytes) のリスト
    entries: list[tuple[int, bytes]] = []
    no_hash: list[bytes] = []

    for data in images:
        h = _image_dhash(data)
        if h is None:
            no_hash.append(data)
        else:
            entries.append((h, data))

    # クラスタリング: 既存グループと比較し、
    # 近いグループに追加 or 新グループ作成
    groups: list[list[tuple[int, bytes]]] = []
    for h, data in entries:
        matched = False
        for group in groups:
            # グループの代表ハッシュと比較
            rep_hash = group[0][0]
            if _hamming_distance(h, rep_hash) <= _DEDUP_THRESHOLD:
                group.append((h, data))
                matched = True
                break
        if not matched:
            groups.append([(h, data)])

    # 各グループから最大サイズの画像を選択
    result = [
        max(group, key=lambda x: len(x[1]))[1]
        for group in groups
    ] + no_hash

    removed = len(images) - len(result)
    if removed > 0:
        print(
            f"[DEBUG] ES-Square 画像重複排除: "
            f"{len(images)} → {len(result)} "
            f"({removed}枚の低画質版を除外)"
        )
    else:
        print(
            f"[DEBUG] ES-Square 画像: "
            f"{len(result)} 枚 (重複なし)"
        )
    return result


def _upload_to_catbox(image_data: bytes) -> str | None:
    """画像を catbox.moe にアップロードし、公開 URL を返す。

    api.e-bukken-1.com の画像は認証が必要で承認ページで表示できないため、
    catbox.moe にアップロードして公開 URL に変換する。
    GAS 側の uploadPropertyImage() と同じ API を使用。
    """
    import requests as req

    try:
        resp = req.post(
            'https://catbox.moe/user/api.php',
            files={
                'fileToUpload': (
                    'property.jpg', image_data, 'image/jpeg',
                ),
            },
            data={'reqtype': 'fileupload'},
            timeout=30,
        )
        if resp.status_code == 200:
            url = resp.text.strip()
            if url.startswith('https://'):
                return url
            print(
                f"[WARN] catbox.moe 不正レスポンス: "
                f"{url[:100]}"
            )
        else:
            print(
                f"[WARN] catbox.moe アップロード失敗: "
                f"status={resp.status_code}"
            )
    except Exception as exc:
        print(f"[WARN] catbox.moe アップロード失敗: {exc}")
    return None


def _extract_images_from_cdp(
    session: EsSquareSession,
) -> list[tuple[str, str]]:
    """CDP Network ログから物件画像の (URL, requestId) を抽出する。

    ES-Square の物件画像は api.e-bukken-1.com から image/jpeg として
    ロードされ、ブラウザ内で blob: URL に変換されて表示される。
    CDP の Network.responseReceived イベントから元の HTTP URL と
    requestId を取得する。

    同じ画像がサムネイル（低画質）とフルサイズ（高画質）で
    読み込まれるため、URL パスで重複排除し、サイズの大きい方を採用する。

    Returns:
        list of (url, requestId) tuples
    """
    from urllib.parse import urlparse

    try:
        perf_log = session.driver.get_log('performance')

        # URL パス → (url, requestId, size) のマップ
        # 同じパスの画像はサイズが大きい方（高画質）を採用
        by_path: dict[str, tuple[str, str, int]] = {}

        for entry in perf_log:
            try:
                msg = json.loads(entry.get('message', '{}'))
                message = msg.get('message', {})
                params = message.get('params', {})
                resp = params.get('response', {})
                url = resp.get('url', '')
                mime = resp.get('mimeType', '')
                request_id = params.get('requestId', '')
            except (json.JSONDecodeError, AttributeError):
                continue

            if not url:
                continue

            # image/* MIME type のレスポンスを対象とする
            if 'image' not in mime:
                continue

            # ジャンク画像を除外
            if _JUNK_IMG.search(url):
                continue

            # data: URI / blob: URL は除外
            if url.startswith('data:') or url.startswith('blob:'):
                continue

            # URL パスで重複排除（クエリパラムを無視）
            parsed = urlparse(url)
            path_key = parsed.path

            # レスポンスサイズで高画質版を選択
            size = resp.get('encodedDataLength', 0)

            if (
                path_key not in by_path
                or size > by_path[path_key][2]
            ):
                by_path[path_key] = (url, request_id, size)

        result = [
            (url, req_id)
            for url, req_id, _ in by_path.values()
        ]

        if result:
            print(
                f"[DEBUG] ES-Square CDP画像: "
                f"{len(result)} 件 (重複排除済み)"
            )
        return result

    except Exception as exc:
        print(f"[WARN] ES-Square CDP画像取得失敗: {exc}")
        return []


def _download_image_via_cdp(
    session: EsSquareSession, request_id: str,
) -> bytes | None:
    """CDP Network.getResponseBody で画像バイナリを取得する。

    ブラウザが既に受信した画像のレスポンスボディを
    CDP 経由で直接取得する。クロスオリジン認証の問題がない。
    """
    if not request_id:
        return None
    try:
        result = session.driver.execute_cdp_cmd(
            'Network.getResponseBody',
            {'requestId': request_id},
        )
        body = result.get('body', '')
        is_base64 = result.get('base64Encoded', False)
        if not body:
            print("[WARN] CDP画像: body が空")
            return None
        if is_base64:
            data = base64.b64decode(body)
        else:
            data = body.encode('latin-1')
        print(
            f"[DEBUG] CDP画像取得成功: "
            f"{len(data)} bytes"
        )
        if len(data) > 1000:
            return data
        print(
            f"[WARN] CDP画像サイズ不足: {len(data)} bytes"
        )
    except Exception as exc:
        print(f"[WARN] CDP画像取得失敗: {exc}")
    return None


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

        # Swiper の総スライド数を取得
        total_slides = session.execute_script("""
            // Swiper インスタンスから総数を取得
            var swiperEl = document.querySelector('.swiper');
            if (swiperEl && swiperEl.swiper) {
                return swiperEl.swiper.slides.length
                       - swiperEl.swiper.loopedSlides * 2;
            }
            // フォールバック: スライド DOM 要素数
            var slides = document.querySelectorAll(
                '.swiper-slide:not(.swiper-slide-duplicate)'
            );
            if (slides.length > 0) return slides.length;
            // 全スライド数
            var all = document.querySelectorAll('.swiper-slide');
            return all.length || 100;
        """)
        if not total_slides or total_slides < 1:
            total_slides = 100

        # ループギャラリーを考慮: 全スライド数 + 余裕
        max_nav = min(total_slides + 2, 200)
        print(
            f"[DEBUG] ES-Square: 総スライド数={total_slides}"
            f", 最大ナビ={max_nav}"
        )

        # 全スライドを順番にナビゲート
        slide_count = 0
        seen_indices: set[int] = set()
        for _ in range(max_nav):
            # 現在のスライドインデックスを取得
            cur_idx = session.execute_script("""
                var el = document.querySelector('.swiper');
                if (el && el.swiper) return el.swiper.realIndex;
                return -1;
            """)
            if isinstance(cur_idx, int) and cur_idx >= 0:
                if cur_idx in seen_indices:
                    # ループ検出: 同じスライドに戻った
                    print(
                        f"[DEBUG] ES-Square: ループ検出 "
                        f"(idx={cur_idx}), ナビ終了"
                    )
                    break
                seen_indices.add(cur_idx)

            # 次へボタンの検出とクリック
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
            f" ({len(seen_indices)} ユニーク)"
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
