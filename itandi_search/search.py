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

    ページネーションに対応し、最大 10 ページ (200 件) まで取得する。
    """
    payload = build_search_payload(criteria)
    headers = session.get_api_headers()
    all_properties: list[Property] = []
    page = 1
    max_pages = 10

    print(f"[DEBUG] 検索ペイロード: {json.dumps(payload, ensure_ascii=False)}")

    # Cookie のドメインとAPIドメインを確認
    api_domain = ITANDI_SEARCH_URL.split("/")[2]
    matching_cookies = [
        f"{c.name}({c.domain})"
        for c in session.session.cookies
        if api_domain.endswith(c.domain.lstrip("."))
    ]
    print(f"[DEBUG] API ({api_domain}) に送信される Cookie: {matching_cookies}")

    while page <= max_pages:
        payload["page"]["page"] = page

        try:
            resp = session.session.post(
                ITANDI_SEARCH_URL,
                json=payload,
                headers=headers,
                timeout=30,
            )
        except Exception as exc:
            raise ItandiSearchError(f"検索 API 通信エラー: {exc}") from exc

        print(f"[DEBUG] 検索API レスポンス: status={resp.status_code}")

        if resp.status_code == 401:
            raise ItandiAuthError("セッションが無効または期限切れです")
        if resp.status_code == 422:
            raise ItandiSearchError(
                f"検索パラメータが不正です: {resp.text[:200]}"
            )
        if resp.status_code == 429:
            raise ItandiSearchError("itandi BB にレート制限されました")

        try:
            resp.raise_for_status()
            data = resp.json()
        except Exception as exc:
            raise ItandiSearchError(
                f"検索 API レスポンスエラー: {exc}"
            ) from exc

        properties = parse_search_response(data)
        all_properties.extend(properties)

        # 次ページがあるか確認
        # レスポンス構造は実装時に調整が必要
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

    NOTE: 実際のレスポンス構造は初回実行時に確認して調整が必要。
    以下は想定される構造に基づく実装。
    """
    properties: list[Property] = []

    # パターン 1: data がリスト（building ごとにグループ化）
    buildings = data.get("data", [])
    if not isinstance(buildings, list):
        buildings = []

    for building_group in buildings:
        # building 情報の取得（複数のキー名を試す）
        building = (
            building_group.get("building")
            or building_group.get("rent_room_building")
            or building_group
        )

        building_id = building.get("id", 0)
        building_name = building.get("name", "") or building.get(
            "building_name", ""
        )
        address = building.get("address", "") or building.get(
            "full_address", ""
        )
        building_age = str(building.get("building_age", ""))

        # 最寄り駅情報
        stations = building.get("nearest_stations", [])
        station_info = ""
        if stations and isinstance(stations, list):
            first = stations[0] if stations else {}
            if isinstance(first, dict):
                line = first.get("line_name", "")
                name = first.get("station_name", "")
                walk = first.get("walk_minutes", "")
                station_info = f"{line} {name}駅 徒歩{walk}分"
            elif isinstance(first, str):
                station_info = first

        # 部屋情報
        rooms = (
            building_group.get("rooms")
            or building_group.get("rent_rooms")
            or building_group.get("rent_room_buildings_rooms", [])
        )
        if not rooms:
            # building 自体が room 情報を含む場合
            rooms = [building_group]

        for room in rooms:
            if not isinstance(room, dict):
                continue

            room_id = room.get("id", 0) or room.get("room_id", 0)
            if not room_id:
                continue

            rent = room.get("rent", 0) or 0
            management_fee = room.get("management_fee", 0) or room.get(
                "kanrihi", 0
            ) or 0
            deposit = str(room.get("deposit", "") or "")
            key_money = str(room.get("key_money", "") or room.get("reikin", "") or "")
            layout = room.get("layout", "") or room.get("room_layout", "") or ""
            area = room.get("floor_area_amount", 0) or room.get("area", 0) or 0
            floor_val = room.get("floor", 0) or 0

            # 画像URL
            images = room.get("images", []) or building.get("images", [])
            image_url = None
            if images and isinstance(images, list):
                first_img = images[0]
                if isinstance(first_img, dict):
                    image_url = first_img.get("url") or first_img.get(
                        "image_url"
                    )
                elif isinstance(first_img, str):
                    image_url = first_img

            prop = Property(
                building_id=int(building_id) if building_id else 0,
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
                url=f"{ITANDI_BASE_URL}/rent_room_buildings/{building_id}",
                image_url=image_url,
            )
            properties.append(prop)

    return properties
