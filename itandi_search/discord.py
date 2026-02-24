"""Discord Webhook 通知（スレッド対応）"""

import json
import time

import requests

from .models import Property


def send_property_notification(
    webhook_url: str,
    customer_name: str,
    properties: list[Property],
    thread_id: str | None = None,
) -> str | None:
    """物件一覧を Discord に通知する。

    通常チャンネルに content メッセージとして送信する。
    thread_id があればそのスレッドに投稿。

    Returns:
        作成されたスレッド ID（新規スレッド作成時）
    """
    if not properties:
        return thread_id

    # まずヘッダーメッセージを送信
    created_thread_id = thread_id

    if not created_thread_id:
        header_payload: dict = {
            "content": (
                f"**🏠 {customer_name}** 様の新着物件 "
                f"({len(properties)}件)"
            ),
        }
        url = f"{webhook_url}?wait=true"
        try:
            print(f"[DEBUG] Discord ヘッダー送信...")
            resp = requests.post(url, json=header_payload, timeout=15)
            print(
                f"[DEBUG] Discord ヘッダー応答: "
                f"status={resp.status_code}"
            )
            if resp.status_code != 200:
                print(
                    f"[DEBUG] Discord ヘッダーエラー: "
                    f"{resp.text[:300]}"
                )
            resp.raise_for_status()
        except Exception as exc:
            print(f"[ERROR] Discord ヘッダー送信失敗: {exc}")

    # 1件ずつ送信（embeds の問題を回避）
    for idx, prop in enumerate(properties):
        # テキストベースのメッセージを構築
        msg = _build_text_message(prop, idx + 1)

        payload: dict = {"content": msg}

        url = webhook_url
        if created_thread_id:
            url = f"{webhook_url}?thread_id={created_thread_id}"

        try:
            resp = requests.post(url, json=payload, timeout=15)

            if resp.status_code != 200 and resp.status_code != 204:
                print(
                    f"[DEBUG] Discord 送信 #{idx+1}: "
                    f"status={resp.status_code}, "
                    f"body={resp.text[:200]}"
                )

            resp.raise_for_status()

        except requests.HTTPError as exc:
            if exc.response is not None:
                print(
                    f"[ERROR] Discord 通知失敗 #{idx+1} "
                    f"(status={exc.response.status_code}): "
                    f"{exc.response.text[:300]}"
                )
                if exc.response.status_code == 429:
                    # レート制限: リトライ
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
                            f"[ERROR] Discord リトライ失敗: {retry_exc}"
                        )
            else:
                print(f"[ERROR] Discord 通知失敗: {exc}")
        except Exception as exc:
            print(f"[ERROR] Discord 通知失敗: {exc}")

        # レート制限回避のため待機
        if idx < len(properties) - 1:
            time.sleep(1)

    return created_thread_id


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


def _build_text_message(prop: Property, index: int) -> str:
    """Property → Discord テキストメッセージに変換する。"""
    rent_man = prop.rent / 10000 if prop.rent else 0
    mgmt_man = prop.management_fee / 10000 if prop.management_fee else 0

    lines = [
        f"**{index}. {prop.building_name or '物件情報'}**",
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
