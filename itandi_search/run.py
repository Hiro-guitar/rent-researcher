"""メインスクリプト — オーケストレーター

Google Sheets の検索条件を読み込み、itandi BB で検索し、
新着物件を Discord に通知する。
"""

import os
import sys
from datetime import datetime
from zoneinfo import ZoneInfo

from .auth import ItandiAuthError, ItandiSession
from .config import (
    DISCORD_WEBHOOK_URL,
    GAS_WEBAPP_URL,
    ITANDI_EMAIL,
    ITANDI_PASSWORD,
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
