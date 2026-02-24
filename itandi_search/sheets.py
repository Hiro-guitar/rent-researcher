"""Google Sheets 読み書き"""

import json

from google.oauth2 import service_account
from googleapiclient.discovery import build

from .config import (
    BUILDING_TYPE_MAP,
    CRITERIA_RANGE,
    EQUIPMENT_IDS,
    GOOGLE_SERVICE_ACCOUNT_JSON,
    LAYOUT_MAP,
    SEEN_RANGE,
    SEEN_SHEET,
    SPREADSHEET_ID,
)
from .models import CustomerCriteria


def get_sheets_service():
    """Google Sheets API サービスを返す。"""
    scopes = ["https://www.googleapis.com/auth/spreadsheets"]
    service_account_info = json.loads(GOOGLE_SERVICE_ACCOUNT_JSON)
    credentials = service_account.Credentials.from_service_account_info(
        service_account_info, scopes=scopes
    )
    return build("sheets", "v4", credentials=credentials)


def load_customer_criteria(service) -> list[CustomerCriteria]:
    """検索条件シートから全顧客の検索条件を読み込む。

    SUUMO風 Google Form のレスポンスを想定。
    列の順番 (A〜O):
      A: タイムスタンプ
      B: お名前（必須）
      C: 部屋探しの理由
      D: 都道府県（必須）
      E: 市区町村（カンマ区切り）
      F: 路線名（カンマ区切り）
      G: 駅名（カンマ区切り）
      H: 賃料上限（"10万円" 形式）
      I: 間取りタイプ（カンマ区切り、"ワンルーム" 含む）
      J: 駅徒歩（"5分以内" 形式）
      K: 専有面積（"20m²" 形式、下限のみ）
      L: 築年数（"5年以内" or "新築" 形式）
      M: 建物の種類（カンマ区切り）
      N: こだわり条件（カンマ区切り、設備 + "2階以上" 等）
      O: その他ご希望（フリーテキスト）
    """
    sheet = service.spreadsheets()
    result = (
        sheet.values()
        .get(spreadsheetId=SPREADSHEET_ID, range=CRITERIA_RANGE)
        .execute()
    )
    rows = result.get("values", [])

    if len(rows) < 2:  # ヘッダー行のみ or 空
        return []

    customers: list[CustomerCriteria] = []
    for row in rows[1:]:  # ヘッダーをスキップ
        if len(row) < 2:
            continue

        name = _get(row, 1, "").strip()
        if not name:
            continue

        reason = _get(row, 2, "").strip()
        prefecture = _get(row, 3, "").strip()
        cities = _split_csv(_get(row, 4, ""))

        # 路線名・駅名（フリーテキスト、カンマ区切り）
        routes = _split_csv(_get(row, 5, ""))
        stations = _split_csv(_get(row, 6, ""))

        # 賃料上限: "10万円" → 100000
        rent_max_man = _parse_rent(_get(row, 7, ""))
        rent_max = int(rent_max_man * 10000) if rent_max_man else None

        # 間取り: "ワンルーム" → "1R" に変換
        layouts_raw = _split_csv(_get(row, 8, ""))
        layouts = [LAYOUT_MAP.get(l, l) for l in layouts_raw]

        # 駅徒歩: "5分以内" → 5
        walk_minutes = _parse_walk(_get(row, 9, ""))

        # 専有面積（下限のみ）: "20m²" → 20.0
        area_min = _parse_area(_get(row, 10, ""))

        # 築年数: "5年以内" → 5, "新築" → 1
        building_age = _parse_building_age(_get(row, 11, ""))

        # 建物の種類: "一戸建て・テラスハウス" → ["detached_house", "terraced_house"]
        building_types_raw = _split_csv(_get(row, 12, ""))
        building_types: list[str] = []
        for bt in building_types_raw:
            if bt == "一戸建て・テラスハウス":
                building_types.append(BUILDING_TYPE_MAP["一戸建て"])
                building_types.append(BUILDING_TYPE_MAP["テラスハウス"])
            elif bt in BUILDING_TYPE_MAP:
                building_types.append(BUILDING_TYPE_MAP[bt])

        # こだわり条件: 設備ID + 特殊条件（2階以上 etc.）
        kodawari_raw = _split_csv(_get(row, 13, ""))
        equipment_ids: list[int] = []
        min_floor = None
        for item in kodawari_raw:
            if item == "2階以上":
                min_floor = 2
            elif item in EQUIPMENT_IDS:
                equipment_ids.append(EQUIPMENT_IDS[item])

        # その他ご希望
        notes = _get(row, 14, "").strip()

        customer = CustomerCriteria(
            name=name,
            reason=reason,
            prefecture=prefecture,
            cities=cities,
            routes=routes,
            stations=stations,
            walk_minutes=walk_minutes,
            rent_max=rent_max,
            layouts=layouts,
            area_min=area_min,
            building_age=building_age,
            building_types=building_types,
            min_floor=min_floor,
            equipment_ids=equipment_ids,
            ad_reprint_only=True,
            notes=notes,
        )
        customers.append(customer)

    return customers


def load_seen_properties(service) -> set[tuple[str, int]]:
    """通知済み物件シートから (customer_name, room_id) のセットを返す。"""
    sheet = service.spreadsheets()
    try:
        result = (
            sheet.values()
            .get(spreadsheetId=SPREADSHEET_ID, range=SEEN_RANGE)
            .execute()
        )
    except Exception:
        # シートが存在しない場合は空セットを返す
        return set()

    rows = result.get("values", [])
    seen: set[tuple[str, int]] = set()

    for row in rows[1:]:  # ヘッダーをスキップ
        if len(row) < 3:
            continue
        customer_name = _get(row, 0, "")
        room_id_str = _get(row, 2, "")
        room_id = _parse_int(room_id_str)
        if customer_name and room_id:
            seen.add((customer_name, room_id))

    return seen


def mark_properties_seen(service, entries: list[dict]) -> None:
    """通知済み物件をシートに追記する。

    entries: [{"customer_name", "building_id", "room_id",
               "building_name", "rent", "notified_at"}, ...]
    """
    if not entries:
        return

    sheet = service.spreadsheets()
    values = [
        [
            e["customer_name"],
            str(e["building_id"]),
            str(e["room_id"]),
            e["building_name"],
            str(e["rent"]),
            e["notified_at"],
        ]
        for e in entries
    ]

    body = {"values": values}
    sheet.values().append(
        spreadsheetId=SPREADSHEET_ID,
        range=f"{SEEN_SHEET}!A:F",
        valueInputOption="RAW",
        insertDataOption="INSERT_ROWS",
        body=body,
    ).execute()


# ─── ヘルパー ──────────────────────────────────────────


def _get(row: list, index: int, default: str = "") -> str:
    """リストの要素を安全に取得する。"""
    if index < len(row):
        return str(row[index])
    return default


def _split_csv(value: str) -> list[str]:
    """カンマ区切り or セミコロン区切りの文字列をリストに分割する。

    Google Forms のチェックボックスは ", " 区切りで保存されるため、
    カンマとセミコロンの両方に対応する。
    """
    if not value or not value.strip():
        return []
    # セミコロンをカンマに統一してから分割
    normalized = value.replace(";", ",")
    return [v.strip() for v in normalized.split(",") if v.strip()]


def _parse_int(value: str) -> int | None:
    """文字列を int に変換する。失敗時は None。"""
    if not value:
        return None
    try:
        cleaned = "".join(c for c in value if c.isdigit() or c == "-")
        return int(cleaned) if cleaned else None
    except ValueError:
        return None


def _parse_float(value: str) -> float | None:
    """文字列を float に変換する。失敗時は None。"""
    if not value:
        return None
    try:
        cleaned = "".join(c for c in value if c.isdigit() or c in ".-")
        return float(cleaned) if cleaned else None
    except ValueError:
        return None


def _parse_rent(value: str) -> float | None:
    """賃料テキスト "10万円" → 10.0, "上限なし" → None."""
    value = value.strip()
    if not value or value in ("上限なし", "指定なし", "指定しない"):
        return None
    # "10万円" → "10", "3.5万円" → "3.5"
    cleaned = value.replace("万円", "").replace("万", "").strip()
    return _parse_float(cleaned)


def _parse_walk(value: str) -> int | None:
    """駅徒歩テキスト "5分以内" → 5, "指定しない" → None."""
    value = value.strip()
    if not value or value in ("指定しない", "指定なし"):
        return None
    cleaned = value.replace("分以内", "").replace("分", "").strip()
    return _parse_int(cleaned)


def _parse_area(value: str) -> float | None:
    """面積テキスト "20m²" → 20.0, "指定しない" → None."""
    value = value.strip()
    if not value or value in ("指定しない", "指定なし"):
        return None
    cleaned = value.replace("m²", "").replace("㎡", "").strip()
    return _parse_float(cleaned)


def _parse_building_age(value: str) -> int | None:
    """築年数テキスト "5年以内" → 5, "新築" → 1, "指定しない" → None."""
    value = value.strip()
    if not value or value in ("指定しない", "指定なし"):
        return None
    if value == "新築":
        return 1
    cleaned = value.replace("年以内", "").replace("年", "").strip()
    return _parse_int(cleaned)
