"""Discord Webhook 通知（スレッド対応）"""

import json
import time
from urllib.parse import quote

import requests

from .models import Property


def send_property_notification(
    webhook_url: str,
    customer_name: str,
    properties: list[Property],
    thread_id: str | None = None,
    gas_webapp_url: str = "",
) -> str | None:
    """物件一覧を Discord に通知する。

    Forum チャンネル対応:
      - thread_id がない場合: thread_name でスレッドを新規作成し、
        ?wait=true で thread_id を取得
      - thread_id がある場合: ?thread_id= で既存スレッドに投稿

    Returns:
        スレッド ID（新規作成 or 既存）
    """
    if not properties:
        return thread_id

    created_thread_id = thread_id

    # ── 1. スレッド作成（Forum チャンネル: thread_name 必須） ──
    if not created_thread_id:
        header_payload: dict = {
            "content": (
                f"**{customer_name}** 様の新着物件 "
                f"({len(properties)}件)"
            ),
            "thread_name": f"🏠 {customer_name}",
        }
        url = f"{webhook_url}?wait=true"
        try:
            print("[DEBUG] Discord スレッド作成...")
            resp = requests.post(url, json=header_payload, timeout=15)
            print(
                f"[DEBUG] Discord スレッド作成応答: "
                f"status={resp.status_code}"
            )
            if resp.status_code != 200:
                print(
                    f"[DEBUG] Discord エラー: {resp.text[:300]}"
                )
            resp.raise_for_status()

            # レスポンスから channel_id (= thread_id) を取得
            resp_data = resp.json()
            new_thread_id = resp_data.get("channel_id")
            if new_thread_id:
                created_thread_id = new_thread_id
                print(
                    f"[DEBUG] Discord スレッド作成成功: "
                    f"thread_id={created_thread_id}"
                )
            else:
                print(
                    f"[WARN] Discord レスポンスに channel_id なし: "
                    f"{json.dumps(resp_data, ensure_ascii=False)[:300]}"
                )
        except Exception as exc:
            print(f"[ERROR] Discord スレッド作成失敗: {exc}")
            return thread_id

    # ── 2. 物件情報を送信 ────────────────────────────────────
    for idx, prop in enumerate(properties):
        msg = _build_text_message(
            prop, idx + 1, gas_webapp_url, customer_name
        )
        payload: dict = {"content": msg}

        url = f"{webhook_url}?thread_id={created_thread_id}"

        _post_with_retry(url, payload, idx + 1)

        # レート制限回避のため待機
        if idx < len(properties) - 1:
            time.sleep(1)

    # ── 3. 一括承認リンクを送信 ─────────────────────────────────
    if gas_webapp_url and len(properties) > 1:
        approve_all_url = (
            f"{gas_webapp_url}"
            f"?action=approve_all"
            f"&customer={quote(customer_name)}"
        )
        bulk_msg = (
            f"\n📨 **[全 {len(properties)} 件を一括承認して"
            f"LINE送信]({approve_all_url})**"
        )
        bulk_payload: dict = {"content": bulk_msg}
        url = f"{webhook_url}?thread_id={created_thread_id}"
        _post_with_retry(url, bulk_payload, len(properties) + 1)

    return created_thread_id


def _post_with_retry(url: str, payload: dict, index: int) -> None:
    """Discord に POST し、429 レート制限時はリトライする。"""
    try:
        resp = requests.post(url, json=payload, timeout=15)

        if resp.status_code not in (200, 204):
            print(
                f"[DEBUG] Discord 送信 #{index}: "
                f"status={resp.status_code}, "
                f"body={resp.text[:200]}"
            )

        resp.raise_for_status()

    except requests.HTTPError as exc:
        if exc.response is not None:
            print(
                f"[ERROR] Discord 通知失敗 #{index} "
                f"(status={exc.response.status_code}): "
                f"{exc.response.text[:300]}"
            )
            if exc.response.status_code == 429:
                retry_after = exc.response.json().get(
                    "retry_after", 5
                )
                print(
                    f"[WARN] Discord レート制限。"
                    f"{retry_after}秒待機..."
                )
                time.sleep(retry_after)
                try:
                    resp = requests.post(
                        url, json=payload, timeout=15
                    )
                    resp.raise_for_status()
                except Exception as retry_exc:
                    print(
                        f"[ERROR] Discord リトライ失敗: "
                        f"{retry_exc}"
                    )
        else:
            print(f"[ERROR] Discord 通知失敗: {exc}")
    except Exception as exc:
        print(f"[ERROR] Discord 通知失敗: {exc}")


def send_error_notification(webhook_url: str, message: str) -> None:
    """エラーを Discord に通知する。"""
    payload: dict = {"content": f"**[itandi BB 検索エラー]**\n{message}"}
    try:
        resp = requests.post(webhook_url, json=payload, timeout=10)
        # Forum チャンネルの場合、thread_name が必要
        if resp.status_code == 400:
            payload["thread_name"] = "⚠️ エラー通知"
            resp = requests.post(webhook_url, json=payload, timeout=10)
        resp.raise_for_status()
    except Exception as exc:
        print(f"[ERROR] Discord エラー通知失敗: {exc}")


def _build_text_message(
    prop: Property,
    index: int,
    gas_webapp_url: str = "",
    customer_name: str = "",
) -> str:
    """Property → Discord テキストメッセージに変換する。"""
    rent_man = prop.rent / 10000 if prop.rent else 0
    mgmt_man = prop.management_fee / 10000 if prop.management_fee else 0

    title = prop.building_name or "物件情報"
    if prop.room_number:
        title += f"  {prop.room_number}"

    lines = [
        f"**{index}. {title}**",
    ]

    if prop.url:
        lines.append(f"🔗 {prop.url}")

    rent_str = f"💰 **{rent_man:.1f}万円**"
    if mgmt_man:
        rent_str += f" (管理費: {mgmt_man:.1f}万円)"
    lines.append(rent_str)

    parts = []
    if prop.layout:
        parts.append(f"🏠 {prop.layout}")
    if prop.area:
        parts.append(f"📐 {prop.area}m²")
    if prop.building_age:
        parts.append(f"🏗 {prop.building_age}")
    if parts:
        lines.append(" ｜ ".join(parts))

    if prop.address:
        lines.append(f"📍 {prop.address}")

    if prop.station_info:
        lines.append(f"🚉 {prop.station_info}")

    if prop.deposit or prop.key_money:
        lines.append(
            f"💴 敷金: {prop.deposit or 'なし'} / "
            f"礼金: {prop.key_money or 'なし'}"
        )

    # 承認リンク
    if gas_webapp_url and customer_name:
        approve_url = (
            f"{gas_webapp_url}"
            f"?action=approve"
            f"&customer={quote(customer_name)}"
            f"&room_id={prop.room_id}"
        )
        lines.append(
            f"✅ [承認してLINE送信]({approve_url})"
        )

    return "\n".join(lines)


def _build_embed(prop: Property) -> dict:
    """Property → Discord Embed 辞書に変換する。"""
    # 賃料を万円表示
    rent_man = prop.rent / 10000 if prop.rent else 0
    mgmt_man = prop.management_fee / 10000 if prop.management_fee else 0

    fields = [
        {
            "name": "💰 賃料",
            "value": f"**{rent_man:.1f}万円**"
            + (f" (管理費: {mgmt_man:.1f}万円)" if mgmt_man else ""),
            "inline": True,
        },
        {
            "name": "🏠 間取り",
            "value": prop.layout or "不明",
            "inline": True,
        },
        {
            "name": "📐 面積",
            "value": f"{prop.area}m²" if prop.area else "不明",
            "inline": True,
        },
    ]

    if prop.address:
        fields.append(
            {"name": "📍 所在地", "value": prop.address, "inline": False}
        )

    if prop.station_info:
        fields.append(
            {
                "name": "🚉 最寄り駅",
                "value": prop.station_info,
                "inline": True,
            }
        )

    if prop.building_age:
        fields.append(
            {"name": "🏗 築年数", "value": prop.building_age, "inline": True}
        )

    if prop.floor:
        fields.append(
            {"name": "🔢 階数", "value": f"{prop.floor}階", "inline": True}
        )

    if prop.deposit or prop.key_money:
        fields.append(
            {
                "name": "💴 敷金/礼金",
                "value": f"{prop.deposit or 'なし'} / {prop.key_money or 'なし'}",
                "inline": True,
            }
        )

    embed: dict = {
        "title": prop.building_name or "物件情報",
        "url": prop.url,
        "color": 0x00AAFF,
        "fields": fields,
    }

    if prop.image_url:
        embed["thumbnail"] = {"url": prop.image_url}

    return embed
