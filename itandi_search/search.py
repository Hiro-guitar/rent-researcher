"""itandi BB 検索 API の呼び出し・レスポンスパース"""

import json
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

from .auth import ItandiAuthError, ItandiSession
from .config import ITANDI_BASE_URL, ITANDI_SEARCH_URL, PREFECTURE_IDS
from .models import CustomerCriteria, Property


class ItandiSearchError(Exception):
    """検索 API エラー"""


def build_search_payload(criteria: CustomerCriteria) -> dict:
    """CustomerCriteria → itandi BB 検索 API のリクエストボディに変換する。"""
    filter_obj: dict = {}

    # エリア
    if criteria.cities and criteria.prefecture:
        prefecture_id = PREFECTURE_IDS.get(criteria.prefecture)
        if prefecture_id:
            filter_obj["address:in"] = [
                {"city": city.strip(), "prefecture_id": prefecture_id}
                for city in criteria.cities
                if city.strip()
            ]

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

    # 所在階
    if criteria.min_floor is not None:
        filter_obj["floor:gteq"] = criteria.min_floor

    # 設備
    if criteria.equipment_ids:
        filter_obj["option_id:all_in"] = criteria.equipment_ids

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
    payload = build_search_payload(criteria)
    all_properties: list[Property] = []
    page = 1
    max_pages = 10

    print(f"[DEBUG] 検索ペイロード: {json.dumps(payload, ensure_ascii=False)}")

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

        # デバッグ: レスポンス構造を出力
        if page == 1:
            top_keys = list(data.keys()) if isinstance(data, dict) else type(data).__name__
            print(f"[DEBUG] レスポンス トップレベルキー: {top_keys}")
            if isinstance(data, dict):
                for k, v in data.items():
                    if isinstance(v, list):
                        print(f"[DEBUG]   {k}: list (長さ={len(v)})")
                        if v:
                            first = v[0]
                            if isinstance(first, dict):
                                print(f"[DEBUG]     先頭要素のキー: {list(first.keys())}")
                                # rooms の構造も出力
                                if "rooms" in first and isinstance(first["rooms"], list) and first["rooms"]:
                                    room0 = first["rooms"][0]
                                    if isinstance(room0, dict):
                                        print(f"[DEBUG]     rooms[0] のキー: {list(room0.keys())}")
                                        # 主要な値をサンプル出力
                                        sample_keys = ["id", "room_id", "rent", "management_fee",
                                                       "layout", "room_layout", "floor_area_amount",
                                                       "floor", "deposit", "key_money", "image_url"]
                                        for sk in sample_keys:
                                            if sk in room0:
                                                print(f"[DEBUG]       {sk}: {room0[sk]}")
                    elif isinstance(v, dict):
                        print(f"[DEBUG]   {k}: dict (キー={list(v.keys())})")
                    else:
                        print(f"[DEBUG]   {k}: {v}")

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
        if station_texts and isinstance(station_texts, list):
            station_info = station_texts[0] if station_texts else ""

        # 部屋情報
        rooms = bldg.get("rooms", [])
        if not rooms:
            continue

        for room in rooms:
            if not isinstance(room, dict):
                continue

            room_id = room.get("id", 0)
            if not room_id:
                continue

            rent = room.get("rent", 0) or 0
            management_fee = room.get("management_fee", 0) or 0
            deposit = str(room.get("deposit", "") or room.get("deposit_text", "") or "")
            key_money = str(room.get("key_money", "") or room.get("key_money_text", "") or "")
            layout = room.get("layout", "") or room.get("room_layout", "") or room.get("layout_text", "") or ""
            area = room.get("floor_area_amount", 0) or room.get("area", 0) or 0
            floor_val = room.get("floor", 0) or 0

            # 画像URL（部屋レベルがあればそちら、なければ建物レベル）
            image_url = room.get("image_url") or image_url_bldg

            prop = Property(
                building_id=int(property_id) if property_id else 0,
                room_id=int(room_id) if room_id else 0,
                building_name=str(building_name),
                address=str(address),
                rent=int(rent) if rent else 0,
                management_fee=int(management_fee) if management_fee else 0,
                deposit=deposit,
                key_money=key_money,
                layout=str(layout),
                area=float(area) if area else 0.0,
                floor=int(floor_val) if floor_val else 0,
                building_age=building_age,
                station_info=station_info,
                url=f"{ITANDI_BASE_URL}/rent_room_buildings/{property_id}",
                image_url=image_url,
            )
            properties.append(prop)

    return properties
