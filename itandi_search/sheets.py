"""Google Sheets 読み書き"""

import json

from google.oauth2 import service_account
from googleapiclient.discovery import build

from .config import (
    CRITERIA_RANGE,
    EQUIPMENT_IDS,
    GOOGLE_SERVICE_ACCOUNT_JSON,
    PENDING_RANGE,
    PENDING_SHEET,
    PREFECTURE_IDS,
    SEEN_RANGE,
    SEEN_SHEET,
    SPREADSHEET_ID,
    STRUCTURE_TYPE_MAP,
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

    GAS SheetWriter.gs が書き込む A:Q（17列）フォーマットを読み込む。
    列の順番 (A〜Q):
      A: タイムスタンプ
      B: お客様名
      C: 都道府県
      D: 市区町村（カンマ区切り）
      E: 駅名（カンマ区切り）
      F: 駅徒歩
      G: 賃料上限（万円）
      H: 間取り（カンマ区切り）
      I: 専有面積下限(m2)
      J: 築年数
      K: 構造（カンマ区切り）
      L: 設備（カンマ区切り）
      M〜Q: 参考情報（検索には使わない）
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
        # E列(index 4)は路線（参考情報、検索には使わない）
        stations = _split_csv(_get(row, 5, ""))
        walk_minutes = _parse_int(_strip_unspecified(_get(row, 6, "")))
        rent_max_man = _parse_float(_strip_unspecified(_get(row, 7, "")))
        layouts = _split_csv(_get(row, 8, ""))
        area_min = _parse_float(_strip_unspecified(_get(row, 9, "")))
        building_age_str = _get(row, 10, "").strip()
        structure_types_raw = _split_csv(_get(row, 11, ""))
        equipment_names = _split_csv(_get(row, 12, ""))

        # 構造: 日本語 → API 値に変換
        structure_types = [
            STRUCTURE_TYPE_MAP[st]
            for st in structure_types_raw
            if st in STRUCTURE_TYPE_MAP
        ]

        # 賃料: 万円 → 円
        rent_max = int(rent_max_man * 10000) if rent_max_man else None

        # 築年数
        building_age = None
        if building_age_str and building_age_str != "指定なし":
            building_age = _parse_int(building_age_str.replace("年", ""))
            if building_age_str == "新築":
                building_age = 1

        # 設備 → option_id
        equipment_ids = [
            EQUIPMENT_IDS[eq_name]
            for eq_name in equipment_names
            if eq_name in EQUIPMENT_IDS
        ]

        customer = CustomerCriteria(
            name=name,
            prefecture=prefecture,
            cities=cities,
            stations=stations,
            walk_minutes=walk_minutes,
            rent_max=rent_max,
            layouts=layouts,
            area_min=area_min,
            building_age=building_age,
            structure_types=structure_types,
            equipment_ids=equipment_ids,
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


def load_pending_properties(service) -> set[tuple[str, int]]:
    """承認待ち物件シートから (customer_name, room_id) のセットを返す。

    重複排除用: 既に承認待ちに入っている物件を再追加しない。
    """
    sheet = service.spreadsheets()
    try:
        result = (
            sheet.values()
            .get(spreadsheetId=SPREADSHEET_ID, range=PENDING_RANGE)
            .execute()
        )
    except Exception:
        return set()

    rows = result.get("values", [])
    pending: set[tuple[str, int]] = set()

    for row in rows[1:]:  # ヘッダーをスキップ
        if len(row) < 3:
            continue
        customer_name = _get(row, 0, "")  # A列: customer_name
        room_id = _parse_int(_get(row, 2, ""))  # C列: room_id
        if customer_name and room_id:
            pending.add((customer_name, room_id))

    return pending


def write_pending_properties(
    service, customer_name: str, properties: list, now_str: str
) -> None:
    """新着物件を承認待ちシートに書き込む。

    properties: Property オブジェクトのリスト
    """
    if not properties:
        return

    sheet = service.spreadsheets()
    values = []
    for p in properties:
        # Flex Message 構築に必要な追加データを JSON で格納
        data_json = json.dumps(
            {
                "deposit": p.deposit,
                "key_money": p.key_money,
                "address": p.address,
                "url": p.url,
                "image_url": p.image_url,
                "room_number": p.room_number,
                "building_age": p.building_age,
                "floor": p.floor,
            },
            ensure_ascii=False,
        )

        values.append(
            [
                customer_name,  # A: customer_name
                str(p.building_id),  # B: building_id
                str(p.room_id),  # C: room_id
                p.building_name,  # D: building_name
                str(p.rent),  # E: rent
                str(p.management_fee),  # F: management_fee
                p.layout,  # G: layout
                str(p.area),  # H: area
                p.station_info,  # I: station_info
                data_json,  # J: property_data_json
                "pending",  # K: status
                now_str,  # L: created_at
                "",  # M: updated_at
            ]
        )

    body = {"values": values}
    sheet.values().append(
        spreadsheetId=SPREADSHEET_ID,
        range=f"{PENDING_SHEET}!A:M",
        valueInputOption="RAW",
        insertDataOption="INSERT_ROWS",
        body=body,
    ).execute()


# ─── ヘルパー ──────────────────────────────────────────


def _strip_unspecified(value: str) -> str:
    """「指定なし」等の未指定値を空文字に変換する。"""
    if value.strip() in ("指定なし", "未指定", "なし", ""):
        return ""
    return value


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
