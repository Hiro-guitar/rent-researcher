"""メインスクリプト — オーケストレーター

Google Sheets の検索条件を読み込み、itandi BB + いい生活Square で検索し、
新着物件を Discord に通知する。
"""

import calendar
import os
import re
import sys
from datetime import date, datetime
from zoneinfo import ZoneInfo

from .auth import ItandiAuthError, ItandiSession
from .config import (
    DISCORD_WEBHOOK_URL,
    EQUIPMENT_DISPLAY_NAMES,
    GAS_WEBAPP_URL,
    ITANDI_EMAIL,
    ITANDI_PASSWORD,
    SOFT_EQUIPMENT_SEARCH_TERMS,
    TEST_MODE,
    TEST_MODE_LIMIT,
)
from .discord import send_error_notification, send_property_notification
from .search import ItandiSearchError, enrich_properties_with_images, search_properties
from .sheets import (
    get_drive_service,
    get_sheets_service,
    load_customer_criteria,
    load_pending_properties,
    load_seen_properties,
    write_pending_properties,
)

# ES-Square: credentials が設定されている場合のみ有効化
_ESSQUARE_ENABLED = False
try:
    from essquare_search.config import ESSQUARE_EMAIL, ESSQUARE_PASSWORD
    if ESSQUARE_EMAIL and ESSQUARE_PASSWORD:
        from essquare_search.auth import EsSquareAuthError, EsSquareSession
        from essquare_search.search import (
            enrich_property_details as esq_enrich_property_details,
            search_properties as esq_search_properties,
        )
        _ESSQUARE_ENABLED = True
except ImportError:
    pass


def _build_search_info(customer, *, search_url: str = "") -> str:
    """CustomerCriteria から検索条件サマリーテキストを組み立てる。

    Discord 通知でどの条件で検索したかを確認するために使う。
    search_url が指定された場合（ES-Square）はURLも表示する。
    """
    lines = ["📋 **検索条件**", "━━━━━━━━━━"]

    # エリア
    if customer.stations:
        lines.append(f"🚉 {' / '.join(customer.stations)}")
    if customer.cities:
        lines.append(f"📍 {' / '.join(customer.cities)}")

    # 賃料
    rent_parts = []
    if customer.rent_min:
        rent_parts.append(f"{customer.rent_min / 10000:.1f}万円〜")
    if customer.rent_max:
        rent_parts.append(f"〜{customer.rent_max / 10000:.1f}万円")
    if rent_parts:
        lines.append(f"💰 {''.join(rent_parts)}")

    # 間取り
    if customer.layouts:
        lines.append(f"🏠 {' / '.join(customer.layouts)}")

    # 面積
    area_parts = []
    if customer.area_min:
        area_parts.append(f"{customer.area_min}㎡〜")
    if customer.area_max:
        area_parts.append(f"〜{customer.area_max}㎡")
    if area_parts:
        lines.append(f"📐 {''.join(area_parts)}")

    # 築年数
    if customer.building_age:
        lines.append(f"🏗 築{customer.building_age}年以内")

    # 建物種別
    if customer.building_types:
        lines.append(f"🏢 {' / '.join(customer.building_types)}")

    # 設備（kodawari）
    if customer.equipment_names:
        lines.append(f"⚙️ {', '.join(customer.equipment_names)}")

    # 特殊条件
    special = []
    if customer.no_deposit:
        special.append("敷金なし")
    if customer.no_key_money:
        special.append("礼金なし")
    if customer.south_facing:
        special.append("南向き")
    if customer.no_loft:
        special.append("ロフトNG")
    if customer.require_loft:
        special.append("ロフト必須")
    if customer.no_teiki:
        special.append("定期借家除外")
    if customer.top_floor_only:
        special.append("最上階")
    if customer.min_floor:
        special.append(f"{customer.min_floor}階以上")
    if special:
        lines.append(f"🔒 {' / '.join(special)}")

    # 駅徒歩
    if customer.walk_minutes:
        lines.append(f"🚶 徒歩{customer.walk_minutes}分以内")

    # 更新日
    if customer.update_within_days:
        lines.append(f"🕐 {customer.update_within_days}日以内に更新")

    # 検索URL（ES-Square のみ）
    if search_url:
        lines.append(f"🔍 {search_url}")

    return "\n".join(lines)


def _parse_floor_number(text: str) -> int | None:
    """階数テキストから数値を抽出する。
    例: "5階" → 5, "地上10階建" → 10, "B1階" → None
    """
    if not text:
        return None
    m = re.search(r"(\d+)\s*階", text)
    return int(m.group(1)) if m else None


def _filter_by_floor(properties: list, *, min_floor=None,
                     max_floor=None, top_floor_only=False) -> list:
    """所在階で物件をフィルターする。
    floor_text（所在階）と story_text（階建て）から判定。
    """
    result = []
    for p in properties:
        room_floor = _parse_floor_number(p.floor_text)

        if room_floor is None:
            # 階数情報が取得できなかった場合は除外しないが警告付き
            print(f"[WARN] 階数判定不能 (room_id={p.room_id}): "
                  f"floor_text='{p.floor_text}'")
            p.floor_warning = "⚠️ 所在階の情報が取得できませんでした（階数条件の確認が必要です）"
            result.append(p)
            continue

        # 2階以上フィルター
        if min_floor is not None and room_floor < min_floor:
            continue

        # 1階フィルター
        if max_floor is not None and room_floor > max_floor:
            continue

        # 最上階フィルター
        if top_floor_only:
            building_floors = _parse_floor_number(p.story_text)
            if building_floors and room_floor < building_floors:
                continue
            elif not building_floors:
                print(f"[WARN] 階建て不明 (room_id={p.room_id}): "
                      f"story_text='{p.story_text}'")
                p.floor_warning = "⚠️ 階建て情報が取得できませんでした（最上階の確認が必要です）"

        result.append(p)
    return result


def _filter_by_sunlight(properties: list) -> list:
    """南向きの物件のみを返す。
    sunlight（主要採光面）に「南」を含むか判定。
    情報がない場合は除外せず警告付きで残す。
    """
    result = []
    for p in properties:
        if not p.sunlight:
            # 採光面情報がない → 除外しないが警告
            print(f"[WARN] 採光面不明 (room_id={p.room_id}): "
                  f"sunlight='{p.sunlight}'")
            p.sunlight_warning = "⚠️ 主要採光面の情報が取得できませんでした（南向きの確認が必要です）"
            result.append(p)
        elif "南" in p.sunlight:
            # 南を含む（南、南西、南東など）→ OK
            result.append(p)
        else:
            # 南を含まない → 除外
            print(f"[INFO] 南向きフィルター除外 (room_id={p.room_id}): "
                  f"sunlight='{p.sunlight}'")
    return result


def _filter_by_loft(properties: list) -> list:
    """ロフト付き物件を除外する。
    facilities（設備・詳細）に「ロフト」を含むか判定。
    「ロフト」の記載がない物件は警告付きで残す。
    """
    result = []
    for p in properties:
        if "ロフト" in p.facilities:
            # ロフトあり → 除外
            print(f"[INFO] ロフトフィルター除外 (room_id={p.room_id}): "
                  f"facilities に「ロフト」を含む")
        else:
            # ロフトの記載なし → 残すが警告
            p.loft_warning = "⚠️ 設備・詳細に「ロフト」の記載がありません（ロフトなしの確認が必要です）"
            result.append(p)
    return result


def _filter_by_teiki(properties: list) -> list:
    """定期借家の物件を除外する。
    lease_type（賃貸借契約区分）に「定期」を含むか判定。
    情報がない場合は除外せず警告付きで残す。
    """
    result = []
    for p in properties:
        if not p.lease_type:
            # 契約区分情報がない → 除外しないが警告
            print(f"[WARN] 契約区分不明 (room_id={p.room_id}): "
                  f"lease_type='{p.lease_type}'")
            p.teiki_warning = "⚠️ 賃貸借契約区分の情報が取得できませんでした（定期借家の確認が必要です）"
            result.append(p)
        elif "定期" in p.lease_type:
            # 定期借家 → 除外
            print(f"[INFO] 定期借家フィルター除外 (room_id={p.room_id}): "
                  f"lease_type='{p.lease_type}'")
        else:
            # 普通借家等 → 通過
            result.append(p)
    return result


def _check_loft_required(properties: list) -> list:
    """ロフト必須: 設備・詳細に「ロフト」の記載がない物件に警告を付ける。
    除外はしない（アラートのみ）。
    """
    for p in properties:
        if "ロフト" not in p.facilities:
            p.loft_warning = "⚠️ 設備・詳細に「ロフト」の記載がありません（ロフト有無の確認が必要です）"
    return properties


def _check_soft_equipment(
    properties: list, soft_equipment_ids: list[int]
) -> list:
    """ソフト設備チェック: 詳細ページの設備テキストに該当設備が見つからない場合に警告を付ける。

    除外はしない（アラートのみ）。
    フリーレント(90003) は free_rent フィールドも確認する。
    """
    if not soft_equipment_ids:
        return properties

    for p in properties:
        missing: list[str] = []
        for eq_id in soft_equipment_ids:
            display_name = EQUIPMENT_DISPLAY_NAMES.get(eq_id, str(eq_id))

            search_terms = SOFT_EQUIPMENT_SEARCH_TERMS.get(eq_id, [])

            if not search_terms:
                continue

            # facilities テキストでキーワード検索
            found = any(term in p.facilities for term in search_terms)

            # フリーレント (90003): free_rent フィールドも確認
            # （設備欄ではなく別フィールドに記載されることが多い）
            if not found and eq_id == 90003 and p.free_rent:
                found = True

            if not found:
                missing.append(display_name)
                print(
                    f"[INFO] ソフト設備アラート (room_id={p.room_id}): "
                    f"「{display_name}」が設備情報に見つかりません"
                )

        if missing:
            p.equipment_warning = (
                f"⚠️ 以下の設備が確認できませんでした: "
                f"{', '.join(missing)}"
            )

    return properties


def _filter_by_status(
    properties: list, *, is_test_customer: bool = False
) -> list:
    """募集ステータスと WEB バッジカウントで物件をフィルターする。

    - "申込あり" → 除外
    - WEB バッジカウント >= 1 → 除外
    - テスト顧客の場合はルール 1, 2 をスキップ

    情報が取得できなかった場合は除外しない（保守的判定）。
    """
    if is_test_customer:
        print("[INFO] テスト顧客: ステータス・WEBバッジフィルターをスキップ")
        return properties

    result = []
    for p in properties:
        # ルール1: 申込あり → 除外
        if p.listing_status == "申込あり":
            print(
                f"[INFO] ステータスフィルター除外 (room_id={p.room_id}): "
                f"status='{p.listing_status}'"
            )
            continue

        # ルール2: WEB バッジカウント >= 1 → 除外
        if p.web_badge_count >= 1:
            print(
                f"[INFO] WEBバッジフィルター除外 (room_id={p.room_id}): "
                f"web_badge_count={p.web_badge_count}"
            )
            continue

        result.append(p)
    return result


def _check_status_kakunin(properties: list) -> list:
    """募集中＋要確認の物件に警告を付ける。

    除外はしない（Discord アラートのみ）。
    """
    for p in properties:
        if p.needs_confirmation:
            p.status_warning = (
                "⚠️ 募集中（要確認）: 物件確認が必要です"
            )
            print(
                f"[INFO] ステータスアラート (room_id={p.room_id}): "
                f"status='{p.listing_status}', 要確認"
            )
    return properties


def _parse_move_in_date(
    text: str, *, as_deadline: bool = False,
    reference_date: date | None = None,
) -> date | None:
    """入居時期テキストを date オブジェクトに変換する。

    as_deadline=True: 旬の末日を返す（顧客の希望期限として）
    as_deadline=False: 旬の初日を返す（物件の入居可能開始日として）

    対応フォーマット:
      - "いい物件見つかり次第" / "即入居可" / "相談" → None
      - "4月上旬" → 年を推定して date に変換
      - "4月15日" → 年を推定して date に変換
      - "2026年4月中旬" → そのまま変換
    """
    if not text:
        return None
    text = text.strip()

    # 制約なし・即時入居可能 → 比較不要
    skip_keywords = ("いい物件見つかり次第", "即入居可", "即日", "未定")
    if text in skip_keywords or any(kw in text for kw in skip_keywords):
        return None

    ref = reference_date or date.today()

    # 年・月・日・旬 を抽出
    year_m = re.search(r"(\d{4})\s*年", text)
    month_m = re.search(r"(\d{1,2})\s*月", text)
    day_m = re.search(r"(\d{1,2})\s*日", text)

    year = int(year_m.group(1)) if year_m else None
    month = int(month_m.group(1)) if month_m else None

    if month is None:
        return None  # 月がないと判定不能

    period = None
    if "上旬" in text:
        period = "early"
    elif "中旬" in text:
        period = "mid"
    elif "下旬" in text:
        period = "late"

    # 年が未指定の場合: 今年 or 来年で最も近い未来を推定
    if year is None:
        if month >= ref.month:
            year = ref.year
        else:
            year = ref.year + 1

    # 日の決定
    if day_m:
        day = int(day_m.group(1))
    elif period is not None:
        if as_deadline:
            # 顧客の期限: 旬の末日
            if period == "early":
                day = 10
            elif period == "mid":
                day = 20
            else:
                day = calendar.monthrange(year, month)[1]
        else:
            # 物件の入居可能開始日: 旬の初日
            if period == "early":
                day = 1
            elif period == "mid":
                day = 11
            else:
                day = 21
    else:
        # 月のみ指定（上旬/中旬/下旬なし）
        if as_deadline:
            day = calendar.monthrange(year, month)[1]
        else:
            day = 1

    try:
        return date(year, month, day)
    except ValueError:
        return None


def _check_move_in_date(properties: list, customer_move_in: str) -> list:
    """物件の入居可能時期が顧客の希望入居時期を過ぎていないかチェックする。

    希望入居時期を過ぎている場合は move_in_warning を設定する。
    除外はしない（アラートのみ）。
    """
    if not customer_move_in or customer_move_in in ("いい物件見つかり次第", ""):
        return properties

    today = date.today()
    customer_deadline = _parse_move_in_date(
        customer_move_in, as_deadline=True, reference_date=today
    )

    if customer_deadline is None:
        return properties

    for p in properties:
        # 即入居可等はスキップ
        if p.move_in_date and p.move_in_date.strip() in ("即入居可", "即日"):
            continue

        # 入居可能時期が空（記載なし）→ 内見開始日でフォールバック判定
        if not p.move_in_date or not p.move_in_date.strip():
            if p.preview_start_date and p.preview_start_date.strip():
                # 内見開始日がある → 日付比較で判定
                preview_date = _parse_move_in_date(
                    p.preview_start_date, as_deadline=False, reference_date=today
                )
                if preview_date and preview_date > customer_deadline:
                    p.move_in_warning = (
                        f"⚠️ {customer_move_in}入居希望です。"
                        f"内見開始日が{p.preview_start_date}のため、入居時期の確認が必要です"
                    )
                    print(
                        f"[INFO] 入居時期アラート (room_id={p.room_id}): "
                        f"希望={customer_move_in}, "
                        f"内見開始日={p.preview_start_date}"
                    )
                else:
                    p.move_in_warning = (
                        f"⚠️ {customer_move_in}入居希望です。"
                        f"入居可能時期の記載がありません（内見開始日: {p.preview_start_date}）"
                    )
            else:
                p.move_in_warning = (
                    f"⚠️ {customer_move_in}入居希望です。"
                    f"入居可能時期の記載がありません"
                )
            if p.move_in_warning:
                print(
                    f"[INFO] 入居時期アラート (room_id={p.room_id}): "
                    f"希望={customer_move_in}, 入居可能=記載なし, "
                    f"内見開始日={p.preview_start_date or 'なし'}"
                )
            continue

        # 「相談」は日付比較できないが、入居時期が不確定なのでアラート
        if "相談" in p.move_in_date:
            p.move_in_warning = (
                f"⚠️ {customer_move_in}入居希望です。"
                f"入居時期の確認が必要です"
            )
            print(
                f"[INFO] 入居時期アラート (room_id={p.room_id}): "
                f"希望={customer_move_in}, "
                f"入居可能={p.move_in_date}（相談）"
            )
            continue

        property_available = _parse_move_in_date(
            p.move_in_date, as_deadline=False, reference_date=today
        )

        if property_available is None:
            continue

        if property_available > customer_deadline:
            p.move_in_warning = (
                f"⚠️ {customer_move_in}入居希望です。"
                f"入居時期の確認が必要です"
            )
            print(
                f"[INFO] 入居時期アラート (room_id={p.room_id}): "
                f"希望={customer_move_in}, "
                f"入居可能={p.move_in_date}"
            )

    return properties


def _run_itandi_search(
    *,
    itandi,
    customer,
    exclude_set: set,
    sheets_service,
    test_mode: bool = False,
) -> int:
    """itandi BB で検索してフィルタ → 承認待ち → Discord 通知。

    Returns: 新着件数
    """
    print(f"[INFO] 検索中: {customer.name}")
    limit = TEST_MODE_LIMIT if test_mode else None
    properties = search_properties(itandi, customer, limit_results=limit)
    print(f"  → {len(properties)} 件ヒット")

    # 通知済み・承認待ちを除外
    new_properties = [
        p
        for p in properties
        if (customer.name, p.room_id) not in exclude_set
    ]

    if not new_properties:
        print("  → 新着なし")
        return 0

    print(f"  → うち新着 {len(new_properties)} 件")

    # 各物件の詳細ページから全画像URLを取得
    try:
        enrich_properties_with_images(itandi, new_properties)
    except Exception as exc:
        print(f"[WARN] 画像取得に失敗 ({customer.name}): {exc}")

    # 賃料フィルター（安全策: API フィルタの漏れを防止）
    before = len(new_properties)
    new_properties = _filter_by_rent(
        new_properties, rent_max=customer.rent_max
    )
    filtered = before - len(new_properties)
    if filtered:
        print(
            f"  → 賃料フィルター: {filtered} 件除外, "
            f"残り {len(new_properties)} 件"
        )
    if not new_properties:
        print("  → 賃料条件に合う物件なし")
        return 0

    # ステータス・WEBバッジフィルター（詳細取得後に判定）
    is_test = "テスト" in customer.name
    before = len(new_properties)
    new_properties = _filter_by_status(
        new_properties, is_test_customer=is_test
    )
    filtered = before - len(new_properties)
    if filtered:
        print(
            f"  → ステータス/WEBフィルター: "
            f"{filtered} 件除外, "
            f"残り {len(new_properties)} 件"
        )
    if not new_properties:
        print("  → ステータス条件に合う物件なし")
        return 0

    # 所在階フィルター（詳細取得後に判定）
    if (customer.min_floor is not None
            or customer.max_floor is not None
            or customer.top_floor_only):
        before = len(new_properties)
        new_properties = _filter_by_floor(
            new_properties,
            min_floor=customer.min_floor,
            max_floor=customer.max_floor,
            top_floor_only=customer.top_floor_only,
        )
        filtered = before - len(new_properties)
        if filtered:
            print(f"  → 階数フィルター: {filtered} 件除外, "
                  f"残り {len(new_properties)} 件")
        if not new_properties:
            print("  → 条件に合う階の物件なし")
            return 0

    # 南向きフィルター（詳細取得後に判定）
    if customer.south_facing:
        before = len(new_properties)
        new_properties = _filter_by_sunlight(new_properties)
        filtered = before - len(new_properties)
        if filtered:
            print(f"  → 南向きフィルター: {filtered} 件除外, "
                  f"残り {len(new_properties)} 件")
        if not new_properties:
            print("  → 南向きの物件なし")
            return 0

    # ロフトNGフィルター（詳細取得後に判定）
    if customer.no_loft:
        before = len(new_properties)
        new_properties = _filter_by_loft(new_properties)
        filtered = before - len(new_properties)
        if filtered:
            print(f"  → ロフトフィルター: {filtered} 件除外, "
                  f"残り {len(new_properties)} 件")
        if not new_properties:
            print("  → ロフトなしの物件なし")
            return 0

    # 定期借家フィルター（詳細取得後に判定）
    if customer.no_teiki:
        before = len(new_properties)
        new_properties = _filter_by_teiki(new_properties)
        filtered = before - len(new_properties)
        if filtered:
            print(f"  → 定期借家フィルター: {filtered} 件除外, "
                  f"残り {len(new_properties)} 件")
        if not new_properties:
            print("  → 普通借家の物件なし")
            return 0

    # ロフト必須チェック（除外はせずアラートのみ）
    if customer.require_loft:
        new_properties = _check_loft_required(new_properties)

    # ソフト設備チェック（除外はせずアラートのみ）
    if customer.soft_equipment_ids:
        new_properties = _check_soft_equipment(
            new_properties, customer.soft_equipment_ids
        )

    # 入居時期チェック（除外はせずアラートのみ）
    if customer.move_in_date:
        new_properties = _check_move_in_date(
            new_properties, customer.move_in_date
        )

    # ステータス要確認チェック（除外はせずアラートのみ）
    new_properties = _check_status_kakunin(new_properties)

    # 承認待ちシートに書き込み
    try:
        write_pending_properties(
            sheets_service,
            customer.name,
            new_properties,
            now_jst(),
        )
    except Exception as exc:
        print(
            f"[ERROR] 承認待ち書き込み失敗 "
            f"({customer.name}): {exc}"
        )

    # Discord 通知（承認リンク付き）
    webhook_url = DISCORD_WEBHOOK_URL
    if webhook_url:
        thread_id = send_property_notification(
            webhook_url=webhook_url,
            customer_name=customer.name,
            properties=new_properties,
            thread_id=customer.discord_thread_id,
            gas_webapp_url=GAS_WEBAPP_URL,
            search_info=_build_search_info(customer),
        )

        # スレッド ID を保存（今後の通知で再利用）
        if (
            thread_id
            and thread_id != customer.discord_thread_id
        ):
            customer.discord_thread_id = thread_id

    # exclude_set にも追加（同一実行内での重複防止）
    for p in new_properties:
        exclude_set.add((customer.name, p.room_id))

    return len(new_properties)


def _filter_by_rent(properties: list, *, rent_max: int | None) -> list:
    """賃料上限で物件をフィルターする（安全策）。

    サーバーサイドフィルタ（itandi API / ES-Square URL パラメータ）が
    正しく機能しなかった場合のフォールバック。
    管理費を含む総賃料（rent + management_fee）で判定する。
    """
    if rent_max is None:
        return properties

    result = []
    for p in properties:
        total_rent = p.rent + (p.management_fee or 0)
        if total_rent <= rent_max:
            result.append(p)
        else:
            print(
                f"[INFO] 賃料フィルター除外 (room_id={p.room_id}): "
                f"賃料={p.rent:,}円 + 管理費={p.management_fee:,}円 "
                f"= 合計{total_rent:,}円 > 上限{rent_max:,}円 "
                f"(物件名: {p.building_name})"
            )
    return result


def _run_essquare_search(
    *,
    esq_session,
    customer,
    exclude_set: set,
    sheets_service,
    drive_service=None,
    test_mode: bool = False,
) -> int:
    """いい生活Square で検索してフィルタ → 承認待ち → Discord 通知。

    Returns: 新着件数
    """
    print(f"[INFO] ES-Square 検索中: {customer.name}")

    is_test = "テスト" in customer.name
    limit = TEST_MODE_LIMIT if test_mode else None
    properties, esq_search_url = esq_search_properties(
        esq_session, customer, customer.equipment_names or None,
        is_test_customer=is_test,
        limit_results=limit,
    )
    print(f"  → ES-Square: {len(properties)} 件ヒット")

    # 通知済み・承認待ちを除外
    new_properties = [
        p for p in properties
        if (customer.name, p.room_id) not in exclude_set
    ]

    if not new_properties:
        print("  → ES-Square: 新着なし")
        return 0

    print(f"  → ES-Square: うち新着 {len(new_properties)} 件")

    # 詳細ページから追加情報を取得 (URL がある物件のみ)
    props_with_url = [p for p in new_properties if p.url]
    if props_with_url:
        try:
            esq_enrich_property_details(
                esq_session, props_with_url,
                drive_service=drive_service,
            )
        except Exception as exc:
            print(f"[WARN] ES-Square 詳細取得失敗 ({customer.name}): {exc}")

    # ── フィルタ (itandi と同じロジックを適用) ──────────

    is_test = "テスト" in customer.name

    # 賃料フィルター（安全策: サーバーサイドフィルタの漏れを防止）
    before = len(new_properties)
    new_properties = _filter_by_rent(
        new_properties, rent_max=customer.rent_max
    )
    filtered = before - len(new_properties)
    if filtered:
        print(f"  → ES-Square 賃料フィルター: {filtered} 件除外")
    if not new_properties:
        print("  → ES-Square: 賃料条件に合う物件なし")
        return 0

    # 定期借家フィルター
    if customer.no_teiki:
        before = len(new_properties)
        new_properties = _filter_by_teiki(new_properties)
        filtered = before - len(new_properties)
        if filtered:
            print(f"  → ES-Square 定期借家フィルター: {filtered} 件除外")
        if not new_properties:
            return 0

    # 所在階フィルター
    if (customer.min_floor is not None
            or customer.max_floor is not None
            or customer.top_floor_only):
        before = len(new_properties)
        new_properties = _filter_by_floor(
            new_properties,
            min_floor=customer.min_floor,
            max_floor=customer.max_floor,
            top_floor_only=customer.top_floor_only,
        )
        filtered = before - len(new_properties)
        if filtered:
            print(f"  → ES-Square 階数フィルター: {filtered} 件除外")
        if not new_properties:
            return 0

    # 南向きフィルター
    if customer.south_facing:
        before = len(new_properties)
        new_properties = _filter_by_sunlight(new_properties)
        filtered = before - len(new_properties)
        if filtered:
            print(f"  → ES-Square 南向きフィルター: {filtered} 件除外")
        if not new_properties:
            return 0

    # ロフトNGフィルター
    if customer.no_loft:
        before = len(new_properties)
        new_properties = _filter_by_loft(new_properties)
        filtered = before - len(new_properties)
        if filtered:
            print(f"  → ES-Square ロフトフィルター: {filtered} 件除外")
        if not new_properties:
            return 0

    # ロフト必須チェック（アラートのみ）
    if customer.require_loft:
        new_properties = _check_loft_required(new_properties)

    # ソフト設備チェック（アラートのみ）
    if customer.soft_equipment_ids:
        new_properties = _check_soft_equipment(
            new_properties, customer.soft_equipment_ids
        )

    # 入居時期チェック（アラートのみ）
    if customer.move_in_date:
        new_properties = _check_move_in_date(
            new_properties, customer.move_in_date
        )

    # 承認待ちシートに書き込み
    try:
        write_pending_properties(
            sheets_service,
            customer.name,
            new_properties,
            now_jst(),
        )
    except Exception as exc:
        print(
            f"[ERROR] ES-Square 承認待ち書き込み失敗 "
            f"({customer.name}): {exc}"
        )

    # Discord 通知
    webhook_url = DISCORD_WEBHOOK_URL
    if webhook_url:
        thread_id = send_property_notification(
            webhook_url=webhook_url,
            customer_name=customer.name,
            properties=new_properties,
            thread_id=customer.discord_thread_id,
            gas_webapp_url=GAS_WEBAPP_URL,
            search_info=_build_search_info(
                customer, search_url=esq_search_url
            ),
        )
        if thread_id and thread_id != customer.discord_thread_id:
            customer.discord_thread_id = thread_id

    # exclude_set に追加
    for p in new_properties:
        exclude_set.add((customer.name, p.room_id))

    return len(new_properties)


def now_jst() -> str:
    """現在の JST タイムスタンプを返す。"""
    return datetime.now(ZoneInfo("Asia/Tokyo")).strftime("%Y-%m-%d %H:%M:%S")


def main() -> None:
    print(f"[{now_jst()}] itandi BB 物件検索を開始します...")

    # ── 1. Google Sheets 初期化 ──────────────────────────
    try:
        sheets_service = get_sheets_service()
    except Exception as exc:
        print(f"[FATAL] Google Sheets 初期化失敗: {exc}")
        sys.exit(1)

    # ── 2. 検索条件の読み込み ─────────────────────────────
    try:
        customers = load_customer_criteria(sheets_service)
    except Exception as exc:
        print(f"[FATAL] 検索条件の読み込み失敗: {exc}")
        sys.exit(1)

    if not customers:
        print("[INFO] 検索条件が登録されていません。終了します。")
        return

    print(f"[INFO] {len(customers)} 件の検索条件を読み込みました")

    # テストモード: テスト顧客のみに絞る
    if TEST_MODE:
        customers = [c for c in customers if "テスト" in c.name]
        print(
            f"[INFO] テストモード: {len(customers)} 件のテスト顧客のみ処理 "
            f"(各サービス {TEST_MODE_LIMIT} 物件まで)"
        )
        if not customers:
            print("[INFO] テストモード: テスト顧客が見つかりません。終了します。")
            return

    # ── 3. 通知済み・承認待ち物件の読み込み ─────────────────
    force_notify = os.environ.get("FORCE_NOTIFY", "") == "1"
    if force_notify:
        print("[INFO] FORCE_NOTIFY=1: 通知済みチェックをスキップします")
        seen_set: set = set()
        pending_set: set = set()
    else:
        try:
            seen_set = load_seen_properties(sheets_service)
        except Exception as exc:
            print(f"[WARN] 通知済み物件の読み込み失敗: {exc}")
            seen_set = set()
        try:
            pending_set = load_pending_properties(sheets_service)
        except Exception as exc:
            print(f"[WARN] 承認待ち物件の読み込み失敗: {exc}")
            pending_set = set()

    # 重複排除用: 通知済み + 承認待ちの和集合
    exclude_set = seen_set | pending_set

    # ── 3b. Google Drive 初期化（画像アップロード用） ──────
    drive_service = None
    try:
        drive_service = get_drive_service()
    except Exception as exc:
        print(f"[WARN] Google Drive 初期化失敗: {exc}")

    # ── 4. itandi BB ログイン ─────────────────────────────
    itandi: ItandiSession | None = None
    try:
        itandi = ItandiSession(ITANDI_EMAIL, ITANDI_PASSWORD)
        itandi.login()
    except ItandiAuthError as exc:
        print(f"[FATAL] itandi BB ログイン失敗: {exc}")
        if DISCORD_WEBHOOK_URL:
            send_error_notification(
                DISCORD_WEBHOOK_URL,
                f"itandi BB ログイン失敗: {exc}",
            )
        if itandi:
            itandi.close()
        sys.exit(1)

    # ── 4b. いい生活Square ログイン（任意） ──────────────────
    esq_session = None
    if _ESSQUARE_ENABLED:
        try:
            esq_session = EsSquareSession(ESSQUARE_EMAIL, ESSQUARE_PASSWORD)
            esq_session.login()
        except Exception as exc:
            print(f"[WARN] いい生活Square ログイン失敗: {exc}")
            if esq_session:
                esq_session.close()
            esq_session = None

    # ── 5. 各顧客の検索＋通知 ─────────────────────────────
    total_new = 0

    for customer in customers:
        # ── 5a. itandi BB 検索 ───────────────────────────────
        try:
            total_new += _run_itandi_search(
                itandi=itandi,
                customer=customer,
                exclude_set=exclude_set,
                sheets_service=sheets_service,
                test_mode=TEST_MODE,
            )
        except ItandiSearchError as exc:
            print(f"[ERROR] 検索失敗 ({customer.name}): {exc}")
            if DISCORD_WEBHOOK_URL:
                send_error_notification(
                    DISCORD_WEBHOOK_URL,
                    f"{customer.name} の検索中にエラー: {exc}",
                )
        except Exception as exc:
            print(f"[ERROR] 予期しないエラー ({customer.name}): {exc}")
            if DISCORD_WEBHOOK_URL:
                send_error_notification(
                    DISCORD_WEBHOOK_URL,
                    f"{customer.name} の処理中にエラー: {exc}",
                )

        # ── 5b. いい生活Square 検索 ──────────────────────────
        if esq_session:
            try:
                total_new += _run_essquare_search(
                    esq_session=esq_session,
                    customer=customer,
                    exclude_set=exclude_set,
                    sheets_service=sheets_service,
                    drive_service=drive_service,
                    test_mode=TEST_MODE,
                )
            except Exception as exc:
                print(
                    f"[ERROR] ES-Square 検索エラー "
                    f"({customer.name}): {exc}"
                )

    # ── 6. ブラウザセッションを閉じる ──────────────────────
    itandi.close()
    if esq_session:
        esq_session.close()

    if total_new:
        print(
            f"[INFO] 合計 {total_new} 件を承認待ちとして記録しました"
        )

    print(f"[{now_jst()}] 完了")


if __name__ == "__main__":
    main()
