"""itandi BB 検索 API の呼び出し・レスポンスパース"""

import json
import re
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

from urllib.parse import quote

from .auth import ItandiAuthError, ItandiSession
from .config import ITANDI_BASE_URL, ITANDI_SEARCH_URL, PREFECTURE_IDS
from .models import CustomerCriteria, Property

STATIONS_API_URL = "https://api.itandibb.com/api/internal/stations"


def _parse_price_text(text: str) -> int:
    """価格テキスト（例: "12万円", "1.5万円", "120,000円"）を円単位の整数に変換する。"""
    if not text or text in ("-", "なし", "ー", "—"):
        return 0
    text = text.replace(",", "").replace("円", "").strip()
    # "12万" or "12.5万"
    m = re.search(r"([\d.]+)\s*万", text)
    if m:
        return int(float(m.group(1)) * 10000)
    # 純粋な数値
    m = re.search(r"[\d.]+", text)
    if m:
        return int(float(m.group(0)))
    return 0


def _parse_area_text(text: str) -> float:
    """面積テキスト（例: "25.5m²", "25.5㎡"）を float に変換する。"""
    if not text:
        return 0.0
    m = re.search(r"([\d.]+)", text)
    if m:
        return float(m.group(1))
    return 0.0


class ItandiSearchError(Exception):
    """検索 API エラー"""


def resolve_station_ids(
    session: "ItandiSession",
    station_names: list[str],
    prefecture: str | None = None,
) -> list[int]:
    """駅名リストを itandi BB の station_id リストに変換する。

    Args:
        session: ログイン済み ItandiSession
        station_names: 駅名のリスト (例: ["渋谷", "恵比寿"])
        prefecture: 都道府県名 (例: "東京都") — 同名駅の絞り込みに使用

    Returns:
        station_id のリスト (全路線分を含む)
    """
    prefecture_id = PREFECTURE_IDS.get(prefecture) if prefecture else None
    print(f"[DEBUG] resolve_station_ids: names={station_names}, "
          f"prefecture={prefecture}, prefecture_id={prefecture_id}")
    all_ids: list[int] = []

    for name in station_names:
        name = name.strip()
        if not name:
            continue

        url = f"{STATIONS_API_URL}?name={quote(name)}"
        print(f"[DEBUG] 駅検索 API 呼び出し: {url}")
        try:
            result = session.api_get(url)
        except Exception as exc:
            print(f"[WARN] 駅検索 API エラー ({name}): {exc}")
            import traceback
            traceback.print_exc()
            continue

        if result["status"] != 200:
            print(f"[WARN] 駅検索 API ({name}): status={result['status']}")
            continue

        stations = result["body"].get("stations", [])
        print(f"[DEBUG] 駅検索結果 ({name}): {len(stations)} 件")

        matched = 0
        for st in stations:
            # 部分一致を除外 (例: "渋谷" で "高座渋谷" を除外)
            if st.get("label") != name:
                continue
            # 都道府県で絞り込み
            if prefecture_id and st.get("prefecture_id") != prefecture_id:
                continue
            all_ids.append(st["id"])
            matched += 1
            print(f"[DEBUG]   マッチ: id={st['id']}, "
                  f"label={st.get('label')}, "
                  f"line={st.get('line_name')}, "
                  f"pref_id={st.get('prefecture_id')}")

        if matched == 0:
            # デバッグ: マッチしなかった場合に候補を表示
            labels = [st.get("label") for st in stations[:5]]
            print(f"[WARN] 駅名「{name}」に一致する駅がありません "
                  f"(候補: {labels})")

    if all_ids:
        print(f"[INFO] 駅名 {station_names} → station_id: {all_ids}")
    else:
        print(f"[WARN] 駅名 {station_names} の station_id を解決できませんでした")
    return all_ids


def build_search_payload(
    criteria: CustomerCriteria,
    station_ids: list[int] | None = None,
) -> dict:
    """CustomerCriteria → itandi BB 検索 API のリクエストボディに変換する。"""
    filter_obj: dict = {}

    # エリア
    prefecture_id = PREFECTURE_IDS.get(criteria.prefecture) if criteria.prefecture else None
    if criteria.cities and prefecture_id:
        filter_obj["address:in"] = [
            {"city": city.strip(), "prefecture_id": prefecture_id}
            for city in criteria.cities
            if city.strip()
        ]

    # 駅
    if station_ids:
        filter_obj["station_id:in"] = station_ids
    elif not filter_obj.get("address:in") and prefecture_id:
        # 市区町村も駅も指定されていない場合、都道府県でフィルター
        # (全国の物件が返ってくるのを防ぐ安全策)
        filter_obj["address:in"] = [{"prefecture_id": prefecture_id}]
        print(f"[INFO] 都道府県フィルター適用 (フォールバック): "
              f"prefecture_id={prefecture_id}")

    # 賃料
    if criteria.rent_min is not None:
        filter_obj["rent:gteq"] = criteria.rent_min
    if criteria.rent_max is not None:
        filter_obj["rent:lteq"] = criteria.rent_max

    # 間取り
    if criteria.layouts:
        filter_obj["room_layout:in"] = criteria.layouts

    # 専有面積
    if criteria.area_min is not None:
        filter_obj["floor_area_amount:gteq"] = criteria.area_min
    if criteria.area_max is not None:
        filter_obj["floor_area_amount:lteq"] = criteria.area_max

    # 築年数
    if criteria.building_age is not None:
        filter_obj["building_age:lteq"] = criteria.building_age

    # 駅徒歩
    if criteria.walk_minutes is not None:
        filter_obj["station_walk_minutes:lteq"] = criteria.walk_minutes

    # 構造
    if criteria.structure_types:
        filter_obj["structure_type:in"] = criteria.structure_types

    # 建物種別
    if criteria.building_types:
        filter_obj["building_detail_type:in"] = criteria.building_types

    # 所在階 — itandi 検索 API では部屋単位の階数フィルターが
    # 正しく機能しないため、API フィルターは使わず
    # run.py の後処理で floor_text を使って除外する

    # 設備
    if criteria.equipment_ids:
        filter_obj["option_id:all_in"] = criteria.equipment_ids

    # 敷金なし
    if criteria.no_deposit:
        filter_obj["shikikin:eq"] = 0

    # 礼金なし
    if criteria.no_key_money:
        filter_obj["reikin:eq"] = 0

    # 広告転載可
    if criteria.ad_reprint_only:
        filter_obj["offer_advertisement_reprint_available_type:in"] = [
            "available"
        ]

    # 取引態様
    if criteria.deal_types:
        filter_obj["offer_deal_type:in"] = criteria.deal_types

    # 情報更新日
    if criteria.update_within_days is not None:
        jst = ZoneInfo("Asia/Tokyo")
        cutoff = datetime.now(jst) - timedelta(
            days=criteria.update_within_days
        )
        filter_obj["offer_conditions_updated_at:gteq"] = cutoff.strftime(
            "%Y-%m-%dT00:00:00.000"
        )

    return {
        "aggregation": {
            "bucket_size": 5,
            "field": "building_id",
            "next_bucket_existance_check": True,
        },
        "filter": filter_obj,
        "page": {"limit": 20, "page": 1},
        "sort": [{"last_status_opened_at": "desc"}],
    }


def search_properties(
    session: ItandiSession, criteria: CustomerCriteria
) -> list[Property]:
    """条件に合致する物件を検索して返す。

    ブラウザの fetch() を使って API を呼び出す。
    ページネーションに対応し、最大 10 ページ (200 件) まで取得する。
    """
    # 駅名 → station_id 解決
    print(f"[DEBUG] criteria.stations = {criteria.stations}")
    print(f"[DEBUG] criteria.prefecture = {criteria.prefecture}")
    print(f"[DEBUG] criteria.cities = {criteria.cities}")
    station_ids: list[int] | None = None
    if criteria.stations:
        station_ids = resolve_station_ids(
            session, criteria.stations, criteria.prefecture
        )
        print(f"[DEBUG] 解決された station_ids = {station_ids}")
    else:
        print("[DEBUG] criteria.stations が空のため駅検索をスキップ")

    payload = build_search_payload(criteria, station_ids=station_ids)
    all_properties: list[Property] = []
    page = 1
    max_pages = 10

    print(f"[DEBUG] 検索条件: {json.dumps(payload.get('filter', {}), ensure_ascii=False)[:200]}")

    while page <= max_pages:
        payload["page"]["page"] = page

        try:
            result = session.api_post(ITANDI_SEARCH_URL, payload)
        except Exception as exc:
            raise ItandiSearchError(f"検索 API 通信エラー: {exc}") from exc

        status = result["status"]

        if status == 401:
            raise ItandiAuthError("セッションが無効または期限切れです")
        if status == 422:
            raise ItandiSearchError(
                f"検索パラメータが不正です: {result.get('raw', '')[:200]}"
            )
        if status == 429:
            raise ItandiSearchError("itandi BB にレート制限されました")
        if status != 200:
            raise ItandiSearchError(
                f"検索 API エラー (status={status}): "
                f"{result.get('raw', '')[:200]}"
            )

        data = result["body"]

        properties = parse_search_response(data)
        all_properties.extend(properties)

        # 次ページがあるか確認
        meta = data.get("meta", {})
        has_next = meta.get("next_bucket_exists", False)
        if not has_next:
            # aggregation 内のフラグも確認
            agg = data.get("aggregation", {})
            has_next = agg.get("next_bucket_exists", False)

        if not has_next:
            break
        page += 1

    return all_properties


def parse_search_response(data: dict) -> list[Property]:
    """検索 API の JSON レスポンスを Property リストに変換する。

    実際のレスポンス構造 (Run #18 で確認済み):
    {
        "room_total_count": 12,
        "total_count": 12,
        "buildings": [
            {
                "property_id": ...,
                "building_detail_type": "mansion",
                "building_age_text": "築15年",
                "construction_date_text": "2010年1月",
                "story_text": "地上10階建",
                "images_count": 5,
                "image_url": "https://...",
                "name": "○○マンション",
                "coordinate": {...},
                "address_text": "東京都千代田区...",
                "nearby_train_station_texts": ["○○線 △△駅 徒歩5分"],
                "management_company_name": "...",
                "rooms": [
                    {
                        "id": 12345,
                        "rent": 120000,
                        "management_fee": 10000,
                        ...
                    }
                ],
                "more_rooms_exist": false
            }
        ]
    }
    """
    properties: list[Property] = []

    # レスポンスのトップレベルキーは "buildings"
    buildings = data.get("buildings", [])
    if not isinstance(buildings, list):
        buildings = []

    for bldg in buildings:
        if not isinstance(bldg, dict):
            continue

        # 建物情報
        property_id = bldg.get("property_id", 0)
        building_name = bldg.get("name", "")
        address = bldg.get("address_text", "")
        building_age = bldg.get("building_age_text", "")
        image_url_bldg = bldg.get("image_url")

        # 最寄り駅情報（テキスト配列）
        station_texts = bldg.get("nearby_train_station_texts", [])
        station_info = ""
        other_stations: list[str] = []
        if station_texts and isinstance(station_texts, list):
            station_info = station_texts[0] if station_texts else ""
            other_stations = station_texts[1:] if len(station_texts) > 1 else []

        # 階建て・建物種別
        story_text = bldg.get("story_text", "") or ""

        # 部屋情報
        rooms = bldg.get("rooms", [])
        if not rooms:
            continue

        for room in rooms:
            if not isinstance(room, dict):
                continue

            # property_id が部屋の ID
            room_id = room.get("property_id", 0)
            if not room_id:
                continue

            # テキスト形式のフィールドをパース
            rent = _parse_price_text(room.get("rent_text", ""))
            management_fee = _parse_price_text(
                room.get("kanrihi_text", "")
                or room.get("kanrihi_kyoekihi_text", "")
            )
            deposit = room.get("shikikin_text", "") or ""
            key_money = room.get("reikin_text", "") or ""
            layout = room.get("layout_text", "") or ""
            area_text = room.get("floor_area_text", "") or ""
            area = _parse_area_text(area_text)

            # 画像URL（間取り図 or 建物画像）
            image_url = room.get("madori_image_url") or image_url_bldg

            # 部屋番号
            room_number = room.get("room_number", "") or ""

            prop = Property(
                building_id=int(property_id) if property_id else 0,
                room_id=int(room_id) if room_id else 0,
                building_name=str(building_name),
                address=str(address),
                rent=rent,
                management_fee=management_fee,
                deposit=deposit,
                key_money=key_money,
                layout=layout,
                area=area,
                floor=0,  # floor は rooms にないため 0
                building_age=building_age,
                station_info=station_info,
                room_number=str(room_number),
                url=f"{ITANDI_BASE_URL}/rent_rooms/{room_id}",
                image_url=image_url,
                story_text=story_text,
                other_stations=other_stations,
            )
            properties.append(prop)

    return properties


def fetch_room_details(
    session: ItandiSession, room_id: int
) -> tuple[list[str], dict[str, str]]:
    """物件詳細ページから画像URLと詳細情報をスクレイピングする。

    itandi BB の検索 API は madori_image_url (間取り図) と building image_url
    しか返さないが、物件詳細ページには外観・内装・間取り等の複数画像が掲載される。
    また、入居可能時期・構造・設備等の詳細情報もテーブルから取得する。

    Args:
        session: ログイン済み ItandiSession
        room_id: 物件の room_id

    Returns:
        (画像URLリスト, 詳細情報dict) のタプル
    """
    if not session.driver:
        print(f"[WARN] Selenium セッションが無い為、詳細スクレイピングをスキップ (room_id={room_id})")
        return [], {}

    import time

    detail_url = f"{ITANDI_BASE_URL}/rent_rooms/{room_id}"
    print(f"[DEBUG] 詳細取得: {detail_url} にアクセス中...")

    try:
        session.driver.get(detail_url)
        time.sleep(3)  # ページ読み込み待ち（React SPA 考慮）

        # property-images ドメインの全画像URLを取得
        image_script = """
        var imgs = document.querySelectorAll('img[src*="property-images"]');
        var urls = [];
        var seen = {};
        for (var i = 0; i < imgs.length; i++) {
            var src = imgs[i].src;
            if (src && !seen[src]) {
                seen[src] = true;
                urls.push(src);
            }
        }
        return urls;
        """
        image_urls = session.driver.execute_script(image_script) or []
        print(f"[DEBUG] room_id={room_id}: {len(image_urls)} 枚の画像を取得")

        # ページ構造のデバッグ情報を出力
        debug_script = """
        var info = {};
        info.title = document.title;
        info.th_count = document.querySelectorAll('th').length;
        info.dt_count = document.querySelectorAll('dt').length;
        info.table_count = document.querySelectorAll('table').length;
        info.dl_count = document.querySelectorAll('dl').length;
        // ラベル系の要素を探す
        var labelEls = document.querySelectorAll('[class*="label"], [class*="Label"], [class*="key"], [class*="Key"], [class*="item"], [class*="Item"], [class*="title"], [class*="heading"]');
        info.label_class_count = labelEls.length;
        // テキスト内容のサンプルを取得（最初の5個）
        var samples = [];
        for (var i = 0; i < Math.min(labelEls.length, 5); i++) {
            samples.push(labelEls[i].tagName + '.' + labelEls[i].className.substring(0, 50) + ': ' + labelEls[i].textContent.trim().substring(0, 30));
        }
        info.label_samples = samples;
        // body の直下の構造
        var bodyChildren = [];
        for (var i = 0; i < Math.min(document.body.children.length, 5); i++) {
            var el = document.body.children[i];
            bodyChildren.push(el.tagName + '#' + el.id + '.' + (el.className || '').substring(0, 30));
        }
        info.body_children = bodyChildren;
        // 特定のテキストを含む要素を探す
        var allText = document.body.innerText || '';
        info.has_nyukyo = allText.includes('入居');
        info.has_kouzo = allText.includes('構造');
        info.has_setsubi = allText.includes('設備');
        info.has_keiyaku = allText.includes('契約');
        info.text_length = allText.length;
        // 全テキストの先頭500文字
        info.text_sample = allText.substring(0, 500);
        return info;
        """
        debug_info = session.driver.execute_script(debug_script) or {}
        print(f"[DEBUG] room_id={room_id} ページ構造: title={debug_info.get('title', 'N/A')}")
        print(f"[DEBUG]   th={debug_info.get('th_count')}, dt={debug_info.get('dt_count')}, table={debug_info.get('table_count')}, dl={debug_info.get('dl_count')}")
        print(f"[DEBUG]   label系class数={debug_info.get('label_class_count')}")
        for s in debug_info.get('label_samples', []):
            print(f"[DEBUG]   sample: {s}")
        print(f"[DEBUG]   body_children={debug_info.get('body_children', [])}")
        print(f"[DEBUG]   テキスト有無: 入居={debug_info.get('has_nyukyo')}, 構造={debug_info.get('has_kouzo')}, 設備={debug_info.get('has_setsubi')}, 契約={debug_info.get('has_keiyaku')}")
        print(f"[DEBUG]   text_length={debug_info.get('text_length')}")
        text_sample = debug_info.get('text_sample', '')
        if text_sample:
            # 改行を置換して1行にして先頭300文字だけ
            print(f"[DEBUG]   text_sample: {text_sample[:300].replace(chr(10), ' | ')}")

        # 詳細テーブルから物件情報を取得
        # itandi BB は React SPA (Material-UI) のため th/td/dt/dd がない
        # ページのテキストから「ラベル：値」パターンを抽出する
        details_script = """
        var details = {};

        // アプローチ1: th/td パターン（フォールバック）
        var ths = document.querySelectorAll('th');
        for (var i = 0; i < ths.length; i++) {
            var key = ths[i].textContent.trim();
            var td = ths[i].nextElementSibling;
            if (td) { details[key] = td.textContent.trim(); }
        }

        // アプローチ2: ページ全体のテキストからラベル：値パターンを抽出
        var text = document.body.innerText || '';
        // 探すラベルリスト
        var labels = [
            '入居可能時期', '入居時期',
            '所在階', '構造', '総戸数',
            '賃貸借の種類', '賃貸借契約の種類', '賃貸借契約区分', '契約区分', '契約形態', '契約期間',
            '解約予告', '解約通知期間',
            '更新・再契約', '契約更新',
            '主要採光面', '向き', '方角',
            '敷引き・償却', '敷引き', '敷引', '償却',
            'ペット飼育時敷金追加', 'ペット',
            'フリーレント',
            '更新事務手数料',
            '更新料',
            '火災保険料', '火災保険', '保険',
            '鍵交換費用', '鍵交換'
        ];

        for (var i = 0; i < labels.length; i++) {
            var label = labels[i];
            // ラベル：値 または ラベル+改行+値 パターンを検索
            var patterns = [
                new RegExp(label + '[：:\\\\s]+([^\\\\n|]+)'),
                new RegExp(label + '\\\\n([^\\\\n]+)')
            ];
            for (var j = 0; j < patterns.length; j++) {
                var m = text.match(patterns[j]);
                if (m && m[1]) {
                    var val = m[1].trim();
                    // 不要な末尾を除去（次のラベルや区切り文字）
                    val = val.replace(/[|｜].*$/, '').trim();
                    if (val && val.length < 300 && val.length > 0) {
                        if (!details[label]) {
                            details[label] = val;
                        }
                    }
                    break;
                }
            }
        }

        // アプローチ3: React コンポーネントからラベル/値ペアを取得
        var labelEls = document.querySelectorAll('[class*="Label"], [class*="label"]');
        for (var i = 0; i < labelEls.length; i++) {
            var key = labelEls[i].textContent.trim();
            var next = labelEls[i].nextElementSibling;
            if (next && key && key.length < 30 && !details[key]) {
                var val = next.textContent.trim();
                if (val && val.length < 300) {
                    details[key] = val;
                }
            }
        }

        // アプローチ4: 設備情報をテキストの行から抽出（行ベース・ステートマシン方式）
        // itandi BBの詳細ページでは設備が「建物設備」「バス・トイレ」「キッチン」等に分かれている
        var facilityCats = {
            '建物設備': true, 'バス・トイレ': true, 'キッチン': true,
            '室内設備': true, 'セキュリティ': true, '冷暖房': true,
            '収納': true, 'TV・通信': true, 'その他設備': true,
            '主な設備': true
        };
        var lines = text.split('\\n');
        var facilityCategorized = {};
        var currentCat = '';
        var inFac = false;
        var facilitySet = {};
        for (var li = 0; li < lines.length; li++) {
            var ln = lines[li].trim();
            if (!ln) continue;
            // 設備カテゴリのヘッダーなら設備モード開始
            if (facilityCats[ln]) { inFac = true; currentCat = ln; if (!facilityCategorized[currentCat]) facilityCategorized[currentCat] = []; continue; }
            if (!inFac) continue;
            // 設備モード終了条件: 非設備セクションヘッダーや価格パターン
            if (/^[\\d,.]+万?円/.test(ln) || /^¥/.test(ln)) { inFac = false; continue; }
            if (/^(賃料|管理費|共益費|費用|契約|条件$|フリーレント|権利金|入居|現況|駐車場代|駐輪場代|バイク置き場代|水道|所在地|交通|物件概要|表示について|図面ダウンロード|物件資料|仲介|取引|敷金|礼金|保証会社|保証金|更新料|更新事務|解約|火災保険|備考|間取り|面積|専有|所在階|総戸数|方角|採光|入力なし|なし$|\\d+年|\\d+万|出稿|内見予約|WEB$|募集)/.test(ln)) { inFac = false; continue; }
            if (ln.length > 30) { inFac = false; continue; }
            // 「その他」は設備アイテムではないのでスキップ
            if (ln === 'その他') continue;
            // 設備アイテムとして追加（カテゴリ別・重複排除）
            if (ln.length >= 2 && currentCat && !facilitySet[ln]) {
                facilitySet[ln] = true;
                facilityCategorized[currentCat].push(ln);
            }
        }
        // 空カテゴリを除去
        var hasFac = false;
        for (var cat in facilityCategorized) {
            if (facilityCategorized[cat].length === 0) { delete facilityCategorized[cat]; }
            else { hasFac = true; }
        }
        if (hasFac) {
            details['__all_facilities'] = facilityCategorized;
        }

        // アプローチ5: 保証情報（備考セクションを除外）
        var gIdx = -1;
        for (var li = 0; li < lines.length; li++) {
            if (lines[li].trim() === '保証情報') { gIdx = li; break; }
        }
        if (gIdx >= 0) {
            var gParts = [];
            for (var li = gIdx + 1; li < Math.min(gIdx + 15, lines.length); li++) {
                var ln = lines[li].trim();
                if (!ln) continue;
                // 「備考」単独セクションヘッダーで停止（「備考：XXX」は含める）
                if (ln === '備考') break;
                // セクション境界で停止
                if (/^(賃料|管理費|共益費|費用|契約|設備|物件概要|交通|所在地|間取り|面積|専有|所在階|総戸数|方角|採光|表示|図面|仲介|取引|条件$|建物設備|バス|キッチン|室内|セキュリティ|冷暖房|収納|TV|その他設備|主な設備|出稿|内見|WEB$|募集|火災保険|更新料|更新事務|解約|敷金|礼金|フリーレント|敷引|ペット|保険$)/.test(ln)) break;
                // 「備考：」プレフィックスは除去して内容だけ取得
                if (/^備考[：:]/.test(ln)) {
                    ln = ln.replace(/^備考[：:]\\s*/, '');
                    if (ln) gParts.push(ln);
                } else {
                    gParts.push(ln);
                }
            }
            if (gParts.length > 0) {
                details['__guarantee_info'] = gParts.join(' ');
            }
        }

        return details;
        """
        raw_details = session.driver.execute_script(details_script) or {}
        print(f"[DEBUG] room_id={room_id}: {len(raw_details)} 件の詳細項目を取得")

        # 日本語ラベル → 内部キーにマッピング
        # ※ 長いラベルを先にチェックするためリスト化（部分一致の誤マッチ防止）
        label_map_list = [
            # 長い・具体的なラベルを先に（部分一致で短い方に食われるのを防ぐ）
            ("更新事務手数料", "renewal_admin_fee"),
            ("更新料", "renewal_fee"),
            ("更新・再契約", "renewal_info"),
            ("契約更新", "renewal_info"),
            ("入居可能時期", "move_in_date"),
            ("入居時期", "move_in_date"),
            ("所在階", "floor_text"),
            ("構造", "structure"),
            ("総戸数", "total_units"),
            ("賃貸借契約の種類", "lease_type"),
            ("賃貸借契約区分", "lease_type"),
            ("賃貸借の種類", "lease_type"),
            ("契約区分", "lease_type"),
            ("契約形態", "lease_type"),
            ("賃貸借契約期間", "contract_period"),
            ("契約期間", "contract_period"),
            ("解約通知期間", "cancellation_notice"),
            ("解約予告", "cancellation_notice"),
            ("主要採光面", "sunlight"),
            ("向き", "sunlight"),
            ("方角", "sunlight"),
            ("敷引き・償却", "shikibiki"),
            ("敷引き", "shikibiki"),
            ("敷引", "shikibiki"),
            ("償却", "shikibiki"),
            ("ペット飼育時敷金追加", "pet_deposit"),
            ("ペット", "pet_deposit"),
            ("フリーレント", "free_rent"),
            ("火災保険料", "fire_insurance"),
            ("火災保険", "fire_insurance"),
            ("保険", "fire_insurance"),
            ("鍵交換費用", "key_exchange_fee"),
            ("鍵交換", "key_exchange_fee"),
        ]

        details: dict[str, str] = {}
        for raw_label, value in raw_details.items():
            if not value or value in ("-", "ー", "—", "―", "入力なし"):
                continue
            for label, key in label_map_list:
                if label in raw_label and key not in details:
                    details[key] = value
                    break

        # 契約区分 (lease_type) はそのまま残す
        # 契約期間 (contract_period) もそのまま残す

        # 保証情報を処理（複数行結合済み・備考：除去済み）
        guarantee_info = raw_details.get("__guarantee_info", "")
        if guarantee_info:
            details["guarantee_info"] = guarantee_info

        # カテゴリ別の設備データがあれば整形文字列に変換して使用
        all_fac = raw_details.get("__all_facilities")
        if all_fac:
            if isinstance(all_fac, dict):
                # カテゴリ別辞書 → 整形文字列に変換
                parts = []
                for cat, items in all_fac.items():
                    if items:
                        parts.append(f"【{cat}】{' / '.join(items)}")
                details["facilities"] = "\n".join(parts)
            else:
                details["facilities"] = str(all_fac)

        print(f"[DEBUG] room_id={room_id}: マッピング後 {len(details)} 件の詳細")
        return image_urls, details

    except Exception as exc:
        print(f"[WARN] 詳細スクレイピング失敗 (room_id={room_id}): {exc}")
        return [], {}


def fetch_room_image_urls(session: ItandiSession, room_id: int) -> list[str]:
    """後方互換: 画像URLのみ取得（fetch_room_details のラッパー）"""
    image_urls, _ = fetch_room_details(session, room_id)
    return image_urls


def enrich_properties_with_images(
    session: ItandiSession, properties: list[Property]
) -> None:
    """検索結果の各物件に対して詳細ページから画像URL + 詳細情報を取得して設定する。

    Args:
        session: ログイン済み ItandiSession
        properties: 画像URL・詳細情報を追加する Property リスト (in-place で変更)
    """
    for prop in properties:
        image_urls, details = fetch_room_details(session, prop.room_id)
        if image_urls:
            prop.image_urls = image_urls
            if not prop.image_url and image_urls:
                prop.image_url = image_urls[0]
        # 詳細情報を Property にセット
        if details:
            for key, value in details.items():
                if hasattr(prop, key) and value:
                    setattr(prop, key, value)
