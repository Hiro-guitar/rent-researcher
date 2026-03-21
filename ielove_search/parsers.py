"""いえらぶBB HTML パーサー

サーバーサイドレンダリングされた HTML をパースして
物件データを抽出する。
"""

import re
from typing import Optional

from bs4 import BeautifulSoup, Tag

from itandi_search.models import Property

from .config import IELOVE_BASE_URL


# ── 検索結果パーサー ──────────────────────────────────

def parse_search_results(html: str) -> list[Property]:
    """検索結果ページの HTML から物件リストを抽出する。"""
    soup = BeautifulSoup(html, "html.parser")
    properties: list[Property] = []

    # 詳細リンクを起点に物件カードを特定
    detail_links = soup.find_all(
        "a", href=re.compile(r"/ielovebb/rent/detail/id/(\d+)/")
    )

    # 同じ物件IDのリンクが複数回出現する場合があるので重複排除
    seen_ids: set[str] = set()

    for link in detail_links:
        m = re.search(r"/ielovebb/rent/detail/id/(\d+)/", link["href"])
        if not m:
            continue
        prop_id = m.group(1)
        if prop_id in seen_ids:
            continue
        seen_ids.add(prop_id)

        # リンクの祖先を遡って物件カードのコンテナを見つける
        card = _find_property_card(link)
        if not card:
            continue

        prop = _parse_property_card(card, prop_id)
        if prop:
            properties.append(prop)

    return properties


def parse_total_count(html: str) -> int:
    """検索結果の総件数を抽出する。

    「1,150 件中 1 - 30」のようなテキストから総件数を取得。
    """
    m = re.search(r"([\d,]+)\s*件中", html)
    if m:
        return int(m.group(1).replace(",", ""))

    # フォールバック: 「○件」パターン
    m = re.search(r"([\d,]+)\s*件", html)
    if m:
        return int(m.group(1).replace(",", ""))

    return 0


# ── 詳細ページパーサー ─────────────────────────────────

def parse_detail_page(html: str, prop: Property) -> None:
    """物件詳細ページの HTML をパースして Property に情報を追加する。

    prop を in-place で更新する。
    """
    soup = BeautifulSoup(html, "html.parser")

    # テーブルから key-value ペアを抽出
    _parse_detail_tables(soup, prop)

    # 設備情報を抽出
    facilities = _extract_facilities(soup)
    if facilities:
        prop.facilities = facilities

    # 画像URLを抽出
    images = _extract_detail_images(soup)
    if images:
        prop.image_urls = images
        if not prop.image_url and images:
            prop.image_url = images[0]


# ── 内部ヘルパー（検索結果） ──────────────────────────

def _find_property_card(link: Tag) -> Optional[Tag]:
    """詳細リンクから遡って物件カードのコンテナ要素を見つける。"""
    # tr, div, li の中で最も近い大きなコンテナを探す
    for parent in link.parents:
        if parent.name in ("tr", "div", "li", "section", "article"):
            text = parent.get_text()
            # 物件カードらしいか確認（賃料や面積のテキストがあるか）
            if ("円" in text or "万" in text) and (
                "㎡" in text or "m²" in text or "間取" in text
            ):
                return parent
        if parent.name in ("body", "table", "tbody"):
            break
    return None


def _parse_property_card(card: Tag, prop_id: str) -> Optional[Property]:
    """物件カード要素から Property を生成する。"""
    text = card.get_text(separator="\n")

    # 物件名
    building_name = _extract_building_name(card, text)

    # 賃料 (数字のみのテキスト or ○万円 or ○円)
    rent = _extract_rent(text)
    if rent == 0:
        return None  # 賃料がなければスキップ

    # 管理費
    management_fee = _extract_management_fee(text)

    # 住所
    address = _extract_address(text)

    # 駅情報
    station_info = _extract_station_info(text)

    # 間取り・面積
    layout, area = _extract_layout_area(text)

    # 築年数
    building_age = _extract_building_age(text)

    # 敷金・礼金
    deposit, key_money = _extract_deposit_key_money(text)

    # 募集状況
    listing_status = _extract_listing_status(text)

    # 入居時期
    move_in_date = _extract_field_value(text, r"入居時期[：:]?\s*(.+)")

    # 退去予定日
    move_out_date = _extract_field_value(text, r"退去予定日?[：:]?\s*(.+)")

    # 内見開始日
    preview_start_date = _extract_field_value(
        text, r"内見開始日?[：:]?\s*(.+)"
    )

    # 階数 / 構造
    floor, floor_text = _extract_floor(text)
    structure = _extract_structure(text)

    # 部屋番号 (物件名から抽出)
    room_number = ""
    if building_name:
        m = re.search(r"[\s　]+(\d{2,5}[A-Za-z]?)$", building_name)
        if m:
            room_number = m.group(1)
            building_name = building_name[: m.start()].strip()

    # 画像URL
    image_url = _extract_card_image(card)

    # 詳細URL
    detail_url = f"{IELOVE_BASE_URL}/ielovebb/rent/detail/id/{prop_id}/"

    return Property(
        building_id=prop_id,
        room_id=f"ielove_{prop_id}",
        building_name=building_name,
        address=address,
        rent=rent,
        source="ielove",
        management_fee=management_fee,
        deposit=deposit,
        key_money=key_money,
        layout=layout,
        area=area,
        floor=floor,
        floor_text=floor_text,
        building_age=building_age,
        station_info=station_info,
        room_number=room_number,
        url=detail_url,
        image_url=image_url,
        listing_status=listing_status,
        move_in_date=move_in_date,
        move_out_date=move_out_date,
        preview_start_date=preview_start_date,
        structure=structure,
    )


def _extract_building_name(card: Tag, text: str) -> str:
    """物件名を抽出する。"""
    # <a> タグ内のテキストで「詳細」以外のもの
    for a in card.find_all("a"):
        href = a.get("href", "")
        if "/ielovebb/rent/detail/" in href:
            name = a.get_text(strip=True)
            if name and name != "詳細" and len(name) > 1:
                return name

    # テーブルヘッダー「物件名」の値
    for th in card.find_all("th"):
        if "物件名" in th.get_text():
            td = th.find_next_sibling("td")
            if td:
                return td.get_text(strip=True)

    # 最初の太字テキスト
    for bold in card.find_all(["b", "strong"]):
        t = bold.get_text(strip=True)
        if t and len(t) > 2 and "円" not in t:
            return t

    return ""


def _extract_rent(text: str) -> int:
    """賃料（円単位）を抽出する。"""
    # パターン1: "400,000円" or "40万円"
    m = re.search(r"([\d,]+)\s*万?\s*円", text)
    if m:
        val = m.group(1).replace(",", "")
        num = int(val)
        if "万" in text[m.start() : m.end()]:
            return num * 10000
        if num < 1000:
            # 万円表記の可能性
            return num * 10000
        return num

    # パターン2: 独立した数字 "400,000" (後に "円" がなくても)
    for line in text.split("\n"):
        line = line.strip()
        m = re.match(r"^([\d,]+)$", line)
        if m:
            val = int(m.group(1).replace(",", ""))
            if 10000 <= val <= 10000000:
                return val

    return 0


def _extract_management_fee(text: str) -> int:
    """管理費・共益費を抽出する。"""
    m = re.search(r"管理費[・共益費]*[：:]\s*([\d,]+)\s*円", text)
    if m:
        return int(m.group(1).replace(",", ""))
    # 「管理費等：2万円」
    m = re.search(r"管理費[等・共益費]*[：:]\s*([\d,.]+)\s*万\s*円", text)
    if m:
        return int(float(m.group(1).replace(",", "")) * 10000)
    return 0


def _extract_address(text: str) -> str:
    """住所を抽出する。"""
    m = re.search(
        r"(東京都[^\n]{3,50})", text
    )
    if m:
        addr = m.group(1).strip()
        # 余計なテキストを除去
        addr = re.split(r"[　\s]{2,}", addr)[0]
        return addr
    return ""


def _extract_station_info(text: str) -> str:
    """駅情報を抽出する。"""
    # 「○○線「○○」駅 徒歩○分」パターン
    m = re.search(
        r"([^\n]*線[「「].*?[」」]駅\s*徒歩\d+分)", text
    )
    if m:
        return m.group(1).strip()

    # 「○○ 徒歩○分」パターン
    m = re.search(r"([^\n]*駅\s*徒歩\d+分)", text)
    if m:
        return m.group(1).strip()

    return ""


def _extract_layout_area(text: str) -> tuple[str, float]:
    """間取りと面積を抽出する。"""
    layout = ""
    area = 0.0

    # 間取り
    m = re.search(r"(\d[SLDK]+)", text)
    if m:
        layout = m.group(1)
    elif "ワンルーム" in text or "1R" in text:
        layout = "1R"

    # 面積 (㎡)
    m = re.search(r"([\d.]+)\s*[㎡m²]", text)
    if m:
        area = float(m.group(1))

    return layout, area


def _extract_building_age(text: str) -> str:
    """築年数を抽出する。"""
    # 「築○年」
    m = re.search(r"(築\d+年)", text)
    if m:
        return m.group(1)
    # 「新築」
    if "新築" in text:
        return "新築"
    return ""


def _extract_deposit_key_money(text: str) -> tuple[str, str]:
    """敷金・礼金を抽出する。"""
    deposit = ""
    key_money = ""

    # 「敷金/礼金」ヘッダーの値（「2ヶ月/1ヶ月」等）
    m = re.search(r"敷金\s*/\s*礼金", text)
    if m:
        # 次の行 or 同じ行のスラッシュ区切り値を探す
        after = text[m.end() :]
        vm = re.search(
            r"([\d.]+\s*[ヶか月万円]+|なし|-)\s*/\s*([\d.]+\s*[ヶか月万円]+|なし|-)",
            after,
        )
        if vm:
            deposit = vm.group(1).strip()
            key_money = vm.group(2).strip()
            return deposit, key_money

    # 個別パターン
    m = re.search(r"敷金[：:]\s*([^\n/]+)", text)
    if m:
        deposit = m.group(1).strip()
    m = re.search(r"礼金[：:]\s*([^\n/]+)", text)
    if m:
        key_money = m.group(1).strip()

    return deposit, key_money


def _extract_listing_status(text: str) -> str:
    """募集状況を抽出する。"""
    for status in ["募集中（要確認）", "申込あり", "募集中"]:
        if status in text:
            return status
    return ""


def _extract_floor(text: str) -> tuple[int, str]:
    """所在階を抽出する。"""
    # 「16階/42階建」パターン
    m = re.search(r"(\d+)\s*階\s*/\s*(\d+)\s*階建", text)
    if m:
        floor = int(m.group(1))
        floor_text = f"{m.group(1)}階/{m.group(2)}階建"
        return floor, floor_text

    # 「所在階：○階」
    m = re.search(r"所在階[：:]\s*(\d+)\s*階", text)
    if m:
        return int(m.group(1)), f"{m.group(1)}階"

    # 「○階」(単独)
    m = re.search(r"(\d+)\s*階[^建]", text)
    if m:
        return int(m.group(1)), f"{m.group(1)}階"

    return 0, ""


def _extract_structure(text: str) -> str:
    """建物構造を抽出する。"""
    patterns = [
        "鉄筋コンクリート（RC）",
        "鉄骨鉄筋コンクリート（SRC）",
        "鉄筋コンクリート",
        "鉄骨鉄筋コンクリート",
        "鉄骨造",
        "軽量鉄骨",
        "木造",
        "RC",
        "SRC",
        "ALC",
    ]
    for pat in patterns:
        if pat in text:
            return pat
    return ""


def _extract_card_image(card: Tag) -> Optional[str]:
    """カードから画像URLを抽出する。"""
    img = card.find("img")
    if img:
        src = img.get("src") or img.get("data-src") or ""
        if src and not _is_icon(src):
            if src.startswith("//"):
                return "https:" + src
            if src.startswith("/"):
                return IELOVE_BASE_URL + src
            return src
    return None


def _extract_field_value(text: str, pattern: str) -> str:
    """正規表現パターンで値を抽出する。"""
    m = re.search(pattern, text)
    if m:
        val = m.group(1).strip()
        # 改行以降を除去
        val = val.split("\n")[0].strip()
        return val
    return ""


def _is_icon(url: str) -> bool:
    """アイコン/ロゴ画像かどうか判定する。"""
    return bool(
        re.search(r"logo|icon|favicon|badge|noimage|dummy", url, re.I)
    )


# ── 内部ヘルパー（詳細ページ） ────────────────────────

# ラベル → Property フィールド名のマッピング
_DETAIL_FIELD_MAP: dict[str, str] = {
    "敷引金": "shikibiki",
    "敷引": "shikibiki",
    "償却金": "shikibiki",
    "償却": "shikibiki",
    "保証金": "guarantee_deposit",
    "敷金積増し金": "additional_deposit",
    "敷金積増し": "additional_deposit",
    "フリーレント": "free_rent",
    "鍵交換代": "key_exchange_fee",
    "鍵交換費": "key_exchange_fee",
    "鍵交換費用": "key_exchange_fee",
    "室内清掃費用": "other_onetime_fee",
    "室内清掃費": "other_onetime_fee",
    "その他初期費用": "other_onetime_fee",
    "その他月額費用": "other_monthly_fee",
    "保証会社": "guarantee_info",
    "構造": "structure",
    "階建": "story_text",
    "向き": "sunlight",
    "総戸数": "total_units",
    "契約期間": "contract_period",
    "更新料": "renewal_fee",
    "契約内容": "lease_type",
    "更新事務手数料": "renewal_admin_fee",
    "間取り": "layout_detail",
    "保険": "fire_insurance",
    "現況": "listing_status",
    "退去予定日": "move_out_date",
    "駐車場": "parking_fee",
    "バルコニー面積": "",  # 不要
    "その他交通": "other_stations",
    "備考": "",  # 長すぎるので省略
    "特優賃": "",
    "入居時期": "move_in_date",
    "所在階": "floor_text",
}


def _parse_detail_tables(soup: BeautifulSoup, prop: Property) -> None:
    """詳細ページのテーブルから情報を抽出する。"""
    for table in soup.find_all("table"):
        rows = table.find_all("tr")
        for row in rows:
            ths = row.find_all("th")
            tds = row.find_all("td")

            if not ths or not tds:
                continue

            # 2カラム構成: th1 td1 th2 td2
            for i, th in enumerate(ths):
                label = th.get_text(strip=True)
                if i < len(tds):
                    value = tds[i].get_text(strip=True)
                else:
                    continue

                _map_detail_field(prop, label, value)

    # 「所在階/階建」パターンの処理
    if prop.floor_text and "/" in prop.floor_text:
        m = re.match(r"(\d+)\s*階\s*/\s*(\d+)\s*階建", prop.floor_text)
        if m:
            prop.floor = int(m.group(1))
            prop.story_text = f"地上{m.group(2)}階建"


def _map_detail_field(prop: Property, label: str, value: str) -> None:
    """ラベルと値を Property のフィールドにマッピングする。"""
    if not value or value in ("-", "−", "―", "ー", "なし", ""):
        return

    field = _DETAIL_FIELD_MAP.get(label, "")

    if not field:
        # 部分一致で探す
        for key, fld in _DETAIL_FIELD_MAP.items():
            if key in label and fld:
                field = fld
                break

    if not field:
        return

    # 特殊処理
    if field == "other_stations":
        # その他交通はリスト
        stations = [s.strip() for s in re.split(r"[,、/／\n]", value) if s.strip()]
        prop.other_stations = stations
        return

    if field == "lease_type":
        setattr(prop, field, value)
        # 定期借家の検出
        if "定期" in value:
            prop.lease_type = value
        return

    if field == "floor_text":
        setattr(prop, field, value)
        # 所在階/階建パターン
        m = re.match(r"(\d+)\s*階", value)
        if m:
            prop.floor = int(m.group(1))
        return

    if field == "structure":
        # 既に検索結果で設定済みなら上書きしない場合もあるが、
        # 詳細ページの方が正確なので上書き
        setattr(prop, field, value)
        return

    # 通常のフィールド設定
    current = getattr(prop, field, "")
    if not current:
        setattr(prop, field, value)


def _extract_facilities(soup: BeautifulSoup) -> str:
    """設備条件を抽出する。"""
    parts: list[str] = []

    for table in soup.find_all("table"):
        table_text = table.get_text()
        if "基本設備" not in table_text and "キッチン" not in table_text:
            continue

        # di_table 内のセクション
        for td in table.find_all("td"):
            text = td.get_text(strip=True)
            if text and len(text) > 5:
                parts.append(text)

    if parts:
        return " / ".join(parts)

    # フォールバック: 「設備」を含むセクションを探す
    for elem in soup.find_all(string=re.compile("設備")):
        parent = elem.parent
        if parent:
            sibling = parent.find_next_sibling()
            if sibling:
                text = sibling.get_text(strip=True)
                if text and len(text) > 5:
                    parts.append(text)

    return " / ".join(parts) if parts else ""


def _extract_detail_images(soup: BeautifulSoup) -> list[str]:
    """詳細ページから画像URLを抽出する。"""
    urls: list[str] = []
    seen: set[str] = set()

    for img in soup.find_all("img"):
        src = img.get("src") or img.get("data-src") or ""
        if not src or _is_icon(src):
            continue
        if "noimage" in src.lower() or "dummy" in src.lower():
            continue

        if src.startswith("//"):
            src = "https:" + src
        elif src.startswith("/"):
            src = IELOVE_BASE_URL + src

        if src not in seen:
            seen.add(src)
            urls.append(src)

        if len(urls) >= 20:
            break

    return urls
