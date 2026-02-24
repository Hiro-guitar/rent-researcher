"""Discord Webhook 通知（スレッド対応）"""

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

    Forum チャンネルの場合: thread_name でお客さん名のスレッドを自動作成。
    通常チャンネルの場合: thread_id があればそのスレッドに投稿。

    Returns:
        作成されたスレッド ID（新規スレッド作成時）
    """
    if not properties:
        return thread_id

    # 5件ずつバッチ送信（Discord は 1 メッセージ最大 10 embeds）
    BATCH_SIZE = 5
    created_thread_id = thread_id

    for i in range(0, len(properties), BATCH_SIZE):
        batch = properties[i : i + BATCH_SIZE]
        embeds = [_build_embed(prop) for prop in batch]

        payload: dict = {"embeds": embeds}

        # 最初の送信でスレッドを作成（Forum チャンネル向け）
        url = webhook_url
        if created_thread_id:
            # 既存スレッドに投稿
            url = f"{webhook_url}?thread_id={created_thread_id}"
        elif i == 0:
            # 新規スレッド作成（Forum チャンネル）
            payload["thread_name"] = f"🏠 {customer_name}"
            # 最初のメッセージにヘッダーを追加
            payload["content"] = (
                f"**{customer_name}** 様の新着物件 "
                f"({len(properties)}件)"
            )

        try:
            resp = requests.post(url, json=payload, timeout=15)

            if resp.status_code in (400, 404) and "thread_name" in payload:
                # Forum チャンネルでない場合、thread_name なしで再試行
                print(
                    f"[DEBUG] Discord {resp.status_code}: "
                    f"{resp.text[:200]}"
                )
                print("[DEBUG] thread_name なしで再試行...")
                payload.pop("thread_name", None)
                resp = requests.post(webhook_url, json=payload, timeout=15)

            if resp.status_code in (400, 404):
                # まだエラーの場合、embeds を減らして再試行
                print(
                    f"[DEBUG] Discord {resp.status_code}: "
                    f"{resp.text[:200]}"
                )

            resp.raise_for_status()

            # 新規スレッド作成時、レスポンスからスレッド ID を取得
            if i == 0 and not thread_id:
                try:
                    resp_data = resp.json()
                    # Webhook レスポンスに channel_id が含まれる場合
                    new_thread_id = resp_data.get("channel_id")
                    if new_thread_id:
                        created_thread_id = new_thread_id
                except Exception:
                    pass

        except requests.HTTPError as exc:
            if exc.response is not None:
                print(
                    f"[ERROR] Discord 通知失敗 "
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

        # バッチ間の待機
        if i + BATCH_SIZE < len(properties):
            time.sleep(2)

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
