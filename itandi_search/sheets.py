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
    SOFT_EQUIPMENT_IDS,
    SPREADSHEET_ID,
    STRUCTURE_TYPE_MAP,
    TEXT_ONLY_EQUIPMENT,
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

        # デバッグ: 行データを表示（列マッピングの確認用）
        print(f"[DEBUG] 行データ (len={len(row)}): "
              f"B={_get(row, 1, '')}, C={_get(row, 2, '')}, "
              f"D={_get(row, 3, '')}, E={_get(row, 4, '')}, "
              f"F={_get(row, 5, '')}, G={_get(row, 6, '')}")

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
        move_in_date_raw = _get(row, 14, "").strip()  # O列: 引越し時期

        # 構造: カテゴリ名を個別の構造タイプに展開してから API 値に変換
        STRUCTURE_GROUP_MAP = {
            "鉄筋系": ["RC", "SRC"],
            "鉄骨系": ["鉄骨造", "軽量鉄骨造"],
            "ブロック・その他": ["ブロック", "PC", "HPC", "ALC", "CFT"],
        }
        expanded = []
        for st in structure_types_raw:
            if st in STRUCTURE_GROUP_MAP:
                expanded.extend(STRUCTURE_GROUP_MAP[st])
            else:
                expanded.append(st)
        structure_types = [
            STRUCTURE_TYPE_MAP[st]
            for st in expanded
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

        # 階数・位置の条件は設備ではなく所在階フィルターとして処理
        min_floor = None
        max_floor = None
        top_floor_only = False
        if "2階以上" in equipment_names:
            min_floor = 2
        if "1階の物件" in equipment_names:
            max_floor = 1
        if "最上階" in equipment_names:
            top_floor_only = True
        south_facing = "南向き" in equipment_names
        no_loft = "ロフトNG" in equipment_names
        require_loft = "ロフト" in equipment_names
        no_deposit = "敷金なし" in equipment_names
        no_key_money = "礼金なし" in equipment_names
        no_teiki = "定期借家を含まない" in equipment_names
        equipment_names = [
            e for e in equipment_names
            if e not in (
                "2階以上", "1階の物件", "最上階", "南向き",
                "ロフトNG", "ロフト", "敷金なし", "礼金なし",
                "定期借家を含まない",
            )
        ]

        # 設備 → option_id（ハード／ソフトに分離）
        # EQUIPMENT_IDS に加え TEXT_ONLY_EQUIPMENT（API option_id なし）も変換
        all_equipment_ids = []
        for eq_name in equipment_names:
            if eq_name in EQUIPMENT_IDS:
                all_equipment_ids.append(EQUIPMENT_IDS[eq_name])
            elif eq_name in TEXT_ONLY_EQUIPMENT:
                all_equipment_ids.append(TEXT_ONLY_EQUIPMENT[eq_name])
        # ハード設備: API の option_id:all_in で厳密に除外
        hard_equipment_ids = list(dict.fromkeys(
            eid for eid in all_equipment_ids if eid not in SOFT_EQUIPMENT_IDS
        ))
        # ソフト設備: 詳細ページで存在チェック → 不在時は ⚠️ アラート（除外しない）
        soft_equipment_ids = list(dict.fromkeys(
            eid for eid in all_equipment_ids if eid in SOFT_EQUIPMENT_IDS
        ))

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
            equipment_ids=hard_equipment_ids,
            soft_equipment_ids=soft_equipment_ids,
            equipment_names=equipment_names,
            min_floor=min_floor,
            max_floor=max_floor,
            top_floor_only=top_floor_only,
            south_facing=south_facing,
            no_loft=no_loft,
            require_loft=require_loft,
            no_deposit=no_deposit,
            no_key_money=no_key_money,
            no_teiki=no_teiki,
            move_in_date=move_in_date_raw,
        )
        customers.append(customer)

    return customers


def load_seen_properties(service) -> set[tuple[str, str]]:
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
    seen: set[tuple[str, str]] = set()

    for row in rows[1:]:  # ヘッダーをスキップ
        if len(row) < 3:
            continue
        customer_name = _get(row, 0, "")
        room_id = _get(row, 2, "").strip()
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


def load_pending_properties(service) -> set[tuple[str, str]]:
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
    pending: set[tuple[str, str]] = set()

    for row in rows[1:]:  # ヘッダーをスキップ
        if len(row) < 3:
            continue
        customer_name = _get(row, 0, "")  # A列: customer_name
        room_id = _get(row, 2, "").strip()  # C列: room_id
        if customer_name and room_id:
            pending.add((customer_name, room_id))

    return pending


def _build_property_json(p) -> str:
    """Property → JSON 文字列（シートの J 列用）。"""
    return json.dumps(
        {
            "deposit": p.deposit,
            "key_money": p.key_money,
            "address": p.address,
            "url": p.url,
            "image_url": p.image_url,
            "image_urls": p.image_urls,
            "room_number": p.room_number,
            "building_age": p.building_age,
            "floor": p.floor,
            # 追加詳細情報
            "story_text": p.story_text,
            "other_stations": p.other_stations,
            "move_in_date": p.move_in_date,
            "floor_text": p.floor_text,
            "structure": p.structure,
            "total_units": p.total_units,
            "lease_type": p.lease_type,
            "contract_period": p.contract_period,
            "cancellation_notice": p.cancellation_notice,
            "renewal_info": p.renewal_info,
            "sunlight": p.sunlight,
            "facilities": p.facilities,
            "shikibiki": p.shikibiki,
            "pet_deposit": p.pet_deposit,
            "free_rent": p.free_rent,
            "renewal_fee": p.renewal_fee,
            "fire_insurance": p.fire_insurance,
            "renewal_admin_fee": p.renewal_admin_fee,
            "guarantee_info": p.guarantee_info,
            "key_exchange_fee": p.key_exchange_fee,
            "support_fee_24h": p.support_fee_24h,
            "rights_fee": p.rights_fee,
            "additional_deposit": p.additional_deposit,
            "guarantee_deposit": p.guarantee_deposit,
            "water_billing": p.water_billing,
            "parking_fee": p.parking_fee,
            "bicycle_parking_fee": p.bicycle_parking_fee,
            "motorcycle_parking_fee": p.motorcycle_parking_fee,
            "other_monthly_fee": p.other_monthly_fee,
            "other_onetime_fee": p.other_onetime_fee,
            "move_in_conditions": p.move_in_conditions,
            "move_out_date": p.move_out_date,
            "free_rent_detail": p.free_rent_detail,
            "layout_detail": p.layout_detail,
        },
        ensure_ascii=False,
    )


def write_pending_properties(
    service, customer_name: str, properties: list, now_str: str
) -> None:
    """新着物件を承認待ちシートに書き込む。

    既に同じ (customer_name, room_id) かつ status='pending' の行が
    存在する場合はデータを**上書き更新**し、存在しない場合は新規追加する。
    これにより force_notify 等で再実行しても画像 URL 等が最新になる。

    properties: Property オブジェクトのリスト
    """
    if not properties:
        return

    sheet = service.spreadsheets()

    # ── 既存 pending 行を読み取り、(customer, room_id) → 行番号リスト
    # 重複行が複数ある場合、全行を更新する必要がある
    # (GAS の findPendingRow は最初の一致を返すため)
    existing: dict[tuple[str, str], list[int]] = {}
    try:
        resp = (
            sheet.values()
            .get(
                spreadsheetId=SPREADSHEET_ID,
                range=f"{PENDING_SHEET}!A:K",
            )
            .execute()
        )
        rows = resp.get("values", [])
        for idx, row in enumerate(rows):
            if len(row) < 11:
                continue
            r_customer = str(row[0])
            r_room_id = str(row[2])
            r_status = str(row[10])
            if r_customer == customer_name and r_status == "pending":
                key = (r_customer, r_room_id)
                existing.setdefault(key, []).append(idx + 1)
    except Exception as exc:
        print(f"[WARN] 承認待ちシート読み取り失敗: {exc}")

    # ── 更新 / 新規追加 に振り分け
    to_append = []
    batch_data = []  # batchUpdate 用
    for p in properties:
        data_json = _build_property_json(p)
        row_values = [
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

        key = (customer_name, str(p.room_id))
        if key in existing:
            # 全ての重複行を batchUpdate で一括更新
            row_nums = existing[key]
            for row_num in row_nums:
                batch_data.append(
                    {
                        "range": (
                            f"{PENDING_SHEET}"
                            f"!A{row_num}:M{row_num}"
                        ),
                        "values": [row_values],
                    }
                )
            print(
                f"[DEBUG] 承認待ち更新予定: "
                f"{len(row_nums)}行, "
                f"room_id={p.room_id}"
            )
        else:
            to_append.append(row_values)

    # ── 既存行を batchUpdate で一括更新 (1 API コール)
    if batch_data:
        try:
            sheet.values().batchUpdate(
                spreadsheetId=SPREADSHEET_ID,
                body={
                    "valueInputOption": "RAW",
                    "data": batch_data,
                },
            ).execute()
            print(
                f"[DEBUG] 承認待ち一括更新完了: "
                f"{len(batch_data)}行"
            )
        except Exception as exc:
            print(
                f"[WARN] 承認待ち一括更新失敗: {exc}"
            )

    # ── 新規物件を一括追加
    if to_append:
        body = {"values": to_append}
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
