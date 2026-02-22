"""Google Sheets 読み書き"""

import json

from google.oauth2 import service_account
from googleapiclient.discovery import build

from .config import (
    CRITERIA_RANGE,
    EQUIPMENT_IDS,
    GOOGLE_SERVICE_ACCOUNT_JSON,
    PREFECTURE_IDS,
    SEEN_RANGE,
    SEEN_SHEET,
    SPREADSHEET_ID,
    UPDATE_DAYS_MAP,
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

    Google Form のレスポンスを想定。
    列の順番 (A〜T):
      A: タイムスタンプ
      B: お客様名
      C: 都道府県
      D: 市区町村（カンマ区切り）
      E: 駅徒歩（分以内）
      F: 賃料下限（万円）
      G: 賃料上限（万円）
      H: 間取り（カンマ区切り）
      I: 専有面積下限(m2)
      J: 専有面積上限(m2)
      K: 築年数
      L: 建物種別（カンマ区切り）
      M: 構造（カンマ区切り）
      N: 所在階（以上）
      O: 必須設備（カンマ区切り）
      P: 広告転載可のみ
      Q: 取引態様（カンマ区切り）
      R: 情報更新日
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

        prefecture = _get(row, 2, "").strip()
        cities = _split_csv(_get(row, 3, ""))
        walk_minutes = _parse_int(_get(row, 4, ""))
        rent_min_man = _parse_float(_get(row, 5, ""))
        rent_max_man = _parse_float(_get(row, 6, ""))
        layouts = _split_csv(_get(row, 7, ""))
        area_min = _parse_float(_get(row, 8, ""))
        area_max = _parse_float(_get(row, 9, ""))
        building_age_str = _get(row, 10, "").strip()
        building_types = _split_csv(_get(row, 11, ""))
        structure_types = _split_csv(_get(row, 12, ""))
        min_floor_str = _get(row, 13, "").strip()
        equipment_names = _split_csv(_get(row, 14, ""))
        ad_reprint_str = _get(row, 15, "").strip()
        deal_types = _split_csv(_get(row, 16, ""))
        update_days_str = _get(row, 17, "").strip()

        # 賃料: 万円 → 円
        rent_min = int(rent_min_man * 10000) if rent_min_man else None
        rent_max = int(rent_max_man * 10000) if rent_max_man else None

        # 築年数
        building_age = None
        if building_age_str and building_age_str != "指定なし":
            building_age = _parse_int(building_age_str.replace("年", ""))
            if building_age_str == "新築":
                building_age = 1

        # 所在階
        min_floor = None
        if min_floor_str and min_floor_str != "指定なし":
            min_floor = _parse_int(
                min_floor_str.replace("階以上", "").replace("階", "")
            )

        # 設備 → option_id
        equipment_ids = [
            EQUIPMENT_IDS[name]
            for name in equipment_names
            if name in EQUIPMENT_IDS
        ]

        # 広告転載可
        ad_reprint_only = ad_reprint_str in ("はい", "Yes", "TRUE", "true", "")

        # 情報更新日
        update_within_days = UPDATE_DAYS_MAP.get(update_days_str)

        customer = CustomerCriteria(
            name=name,
            prefecture=prefecture,
            cities=cities,
            walk_minutes=walk_minutes,
            rent_min=rent_min,
            rent_max=rent_max,
            layouts=layouts,
            area_min=area_min,
            area_max=area_max,
            building_age=building_age,
            building_types=building_types,
            structure_types=structure_types,
            min_floor=min_floor,
            equipment_ids=equipment_ids,
            ad_reprint_only=ad_reprint_only,
            deal_types=deal_types,
            update_within_days=update_within_days,
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
    """カンマ区切りの文字列をリストに分割する。"""
    if not value or not value.strip():
        return []
    return [v.strip() for v in value.split(",") if v.strip()]


def _parse_int(value: str) -> int | None:
    """文字列を int に変換する。失敗時は None。"""
    if not value:
        return None
    try:
        # "10分" → "10", "2階以上" → "2" のような処理は呼び出し元で
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
