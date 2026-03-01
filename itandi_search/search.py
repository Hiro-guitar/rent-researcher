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
    all_ids: list[int] = []

    for name in station_names:
        name = name.strip()
        if not name:
            continue

        url = f"{STATIONS_API_URL}?name={quote(name)}"
        try:
            result = session.api_get(url)
        except Exception as exc:
            print(f"[WARN] 駅検索 API エラー ({name}): {exc}")
            continue

        if result["status"] != 200:
            print(f"[WARN] 駅検索 API ({name}): status={result['status']}")
            continue

        stations = result["body"].get("stations", [])

        for st in stations:
            # 部分一致を除外 (例: "渋谷" で "高座渋谷" を除外)
            if st.get("label") != name:
                continue
            # 都道府県で絞り込み
            if prefecture_id and st.get("prefecture_id") != prefecture_id:
                continue
            all_ids.append(st["id"])

    if all_ids:
        print(f"[INFO] 駅名 {station_names} → station_id: {all_ids}")
    return all_ids


def build_search_payload(
    criteria: CustomerCriteria,
    station_ids: list[int] | None = None,
) -> dict:
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

    # 駅
    if station_ids:
        filter_obj["station_id:in"] = station_ids

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
    # 駅名 → station_id 解決
    station_ids: list[int] | None = None
    if criteria.stations:
        station_ids = resolve_station_ids(
            session, criteria.stations, criteria.prefecture
        )

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
        if station_texts and isinstance(station_texts, list):
            station_info = station_texts[0] if station_texts else ""

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
            )
            properties.append(prop)

    return properties
