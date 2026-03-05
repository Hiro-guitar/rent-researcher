"""メインスクリプト — オーケストレーター

Google Sheets の検索条件を読み込み、itandi BB で検索し、
新着物件を Discord に通知する。
"""

import os
import re
import sys
from datetime import datetime
from zoneinfo import ZoneInfo

from .auth import ItandiAuthError, ItandiSession
from .config import (
    DISCORD_WEBHOOK_URL,
    EQUIPMENT_DISPLAY_NAMES,
    GAS_WEBAPP_URL,
    ITANDI_EMAIL,
    ITANDI_PASSWORD,
    SOFT_EQUIPMENT_SEARCH_TERMS,
)
from .discord import send_error_notification, send_property_notification
from .search import ItandiSearchError, enrich_properties_with_images, search_properties
from .sheets import (
    get_sheets_service,
    load_customer_criteria,
    load_pending_properties,
    load_seen_properties,
    write_pending_properties,
)


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
    特殊ケース:
      - フリーレント(90003): free_rent フィールドも確認する。
      - 定期借家を含まない(90009): lease_type に「定期」が含まれる場合にアラート（逆チェック）。
    """
    if not soft_equipment_ids:
        return properties

    for p in properties:
        missing: list[str] = []
        for eq_id in soft_equipment_ids:
            display_name = EQUIPMENT_DISPLAY_NAMES.get(eq_id, str(eq_id))

            # 定期借家を含まない (90009): 逆チェック — 定期借家の場合にアラート
            if eq_id == 90009:
                if p.lease_type and "定期" in p.lease_type:
                    missing.append(display_name)
                    print(
                        f"[INFO] ソフト設備アラート (room_id={p.room_id}): "
                        f"定期借家の可能性あり (lease_type='{p.lease_type}')"
                    )
                continue

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

    # ── 5. 各顧客の検索＋通知 ─────────────────────────────
    total_new = 0

    for customer in customers:
        try:
            print(f"[INFO] 検索中: {customer.name}")
            properties = search_properties(itandi, customer)
            print(f"  → {len(properties)} 件ヒット")

            # 通知済み・承認待ちを除外
            new_properties = [
                p
                for p in properties
                if (customer.name, p.room_id) not in exclude_set
            ]

            if new_properties:
                print(f"  → うち新着 {len(new_properties)} 件")

                # 各物件の詳細ページから全画像URLを取得
                try:
                    enrich_properties_with_images(itandi, new_properties)
                except Exception as exc:
                    print(f"[WARN] 画像取得に失敗 ({customer.name}): {exc}")

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
                        continue

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
                        continue

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
                        continue

                # ロフト必須チェック（除外はせずアラートのみ）
                if customer.require_loft:
                    new_properties = _check_loft_required(new_properties)

                # ソフト設備チェック（除外はせずアラートのみ）
                if customer.soft_equipment_ids:
                    new_properties = _check_soft_equipment(
                        new_properties, customer.soft_equipment_ids
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

                total_new += len(new_properties)
            else:
                print("  → 新着なし")

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

    # ── 6. ブラウザセッションを閉じる ──────────────────────
    itandi.close()

    if total_new:
        print(
            f"[INFO] 合計 {total_new} 件を承認待ちとして記録しました"
        )

    print(f"[{now_jst()}] 完了")


if __name__ == "__main__":
    main()
