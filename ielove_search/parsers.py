"""いえらぶBB HTML パーサー

サーバーサイドレンダリングされた HTML をパースして
物件データを抽出する。

検索結果ページの構造:
- 各物件 = table.estate_list
  - table.estate-name: 物件名 + 部屋番号
  - TD (管理費・円を含む): 賃料, 管理費, 住所, 駅, 広告費
  - table.detail-info: 敷金/礼金, 間取り/面積, 築年数/退去予定日, 内見開始日/入居時期
  - table.leasing-detail-info: 募集状況
"""

import re
from typing import Optional

from bs4 import BeautifulSoup, NavigableString, Tag

from itandi_search.models import Property

from .config import IELOVE_BASE_URL


# ── 検索結果パーサー ──────────────────────────────────

def parse_search_results(html: str) -> list[Property]:
    """検索結果ページの HTML から物件リストを抽出する。"""
    soup = BeautifulSoup(html, "html.parser")
    properties: list[Property] = []

    # 各物件は table.estate_list
    for card in soup.find_all("table", class_="estate_list"):
        prop = _parse_estate_card(card)
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

def _parse_estate_card(card: Tag) -> Optional[Property]:
    """table.estate_list から Property を生成する。"""

    # 物件ID (詳細リンクから)
    link = card.find("a", href=re.compile(r"/ielovebb/rent/detail/id/(\d+)/"))
    if not link:
        return None
    m = re.search(r"/detail/id/(\d+)/", link["href"])
    if not m:
        return None
    prop_id = m.group(1)

    # ── 物件名・部屋番号 (table.estate-name > span.large-font) ──
    building_name = ""
    room_number = ""
    name_table = card.find("table", class_="estate-name")
    if name_table:
        name_span = name_table.find("span", class_="large-font")
        if name_span:
            # span 直下のテキストノードだけ取得（子要素のテキストは除外）
            text_parts = []
            for child in name_span.children:
                if isinstance(child, NavigableString):
                    t = child.strip()
                    if t:
                        text_parts.append(t)
                else:
                    break  # <a> 等の子要素に到達したら停止
            raw = " ".join(text_parts)
            # 2つ以上の空白で分割 → 物件名 + 部屋番号
            parts = re.split(r"\s{2,}", raw.strip())
            if len(parts) >= 2 and parts[-1]:
                building_name = " ".join(parts[:-1])
                room_number = parts[-1]
            elif parts:
                building_name = parts[0]

    # ── 賃料・管理費・住所・駅 (管理費を含むTD) ──
    rent = 0
    management_fee = 0
    address = ""
    station_info = ""

    for td in card.find_all("td"):
        text = td.get_text(strip=True)
        if "管理費" in text and "円" in text:
            rent, management_fee, address, station_info = (
                _parse_rent_td(text)
            )
            break

    if rent == 0:
        return None

    # ── 詳細情報 (table.detail-info) ──
    deposit = ""
    key_money = ""
    layout = ""
    area = 0.0
    building_age = ""
    move_out_date = ""
    preview_start_date = ""
    move_in_date = ""

    detail_info = card.find("table", class_="detail-info")
    if detail_info:
        # ヘッダーなしの行からデータを取得
        for row in detail_info.find_all("tr"):
            tds = row.find_all("td")
            ths = row.find_all("th")
            if tds and not ths:
                vals = [td.get_text(strip=True) for td in tds]
                if len(vals) >= 4:
                    deposit, key_money = _split_deposit_key(vals[0])
                    layout, area = _split_layout_area(vals[1])
                    building_age, move_out_date = _split_age_date(vals[2])
                    preview_start_date, move_in_date = (
                        _split_preview_movein(vals[3])
                    )

    # ── 募集状況 (table.leasing-detail-info) ──
    listing_status = ""
    leasing = card.find("table", class_="leasing-detail-info")
    if leasing:
        for td in leasing.find_all("td"):
            text = td.get_text(strip=True)
            if text in ("募集中", "申込あり", "募集中（要確認）"):
                listing_status = text
                break

    # ── 画像 ──
    image_url = _extract_card_image(card)

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
        building_age=building_age,
        station_info=station_info,
        room_number=room_number,
        url=detail_url,
        image_url=image_url,
        listing_status=listing_status,
        move_in_date=move_in_date,
        move_out_date=move_out_date,
        preview_start_date=preview_start_date,
    )


def _parse_rent_td(text: str) -> tuple[int, int, str, str]:
    """賃料TDのテキストから賃料・管理費・住所・駅を抽出する。

    入力例: "122,000円管理費・共益費：1万円東京都品川区東五反田３丁目山手線「五反田」駅徒歩6分広告費：100％"
    """
    rent = 0
    mgmt = 0
    address = ""
    station = ""

    # 賃料
    rm = re.match(r"([\d,]+)\s*円", text)
    if rm:
        rent = int(rm.group(1).replace(",", ""))

    # 管理費
    mm = re.search(r"管理費[・共益費]*[：:]\s*([\d,]+)\s*円", text)
    if mm:
        mgmt = int(mm.group(1).replace(",", ""))
    else:
        mm = re.search(r"管理費[・共益費]*[：:]\s*([\d,.]+)\s*万\s*円", text)
        if mm:
            mgmt = int(float(mm.group(1).replace(",", "")) * 10000)

    # 駅情報 (路線名は日本語文字のみにマッチさせる)
    _LINE_CHARS = r"[ぁ-んァ-ヶー\u4E00-\u9FFFA-Za-zＡ-Ｚａ-ｚ]"
    sm = re.search(
        rf"({_LINE_CHARS}{{2,20}}線「[^」]+」駅\s*徒歩\d+分)", text
    )
    if sm:
        raw_station = sm.group(1)
        # 住所末尾（丁目・番地・号）が路線名に混入するのを除去
        station = re.sub(r"^[丁目番地号]+", "", raw_station)

        # 住所: 東京都〜駅マッチ開始位置（+ 除去した文字数分）
        stripped_len = len(raw_station) - len(station)
        addr_end = sm.start(1) + stripped_len
        am = re.search(r"東京都", text)
        if am:
            address = text[am.start():addr_end].strip()
            address = re.sub(r"^\(税込\)\s*", "", address)

    if not address:
        # 駅情報がない場合のフォールバック
        am = re.search(r"(東京都[^\s]{3,50})", text)
        if am:
            address = am.group(1).strip()
            address = re.split(r"広告費", address)[0].strip()

    return rent, mgmt, address, station


def _split_deposit_key(text: str) -> tuple[str, str]:
    """「なしなし」「1ヶ月1ヶ月」「10万8,000円なし」等を敷金・礼金に分割する。"""
    if not text or text == "-":
        return "", ""

    if text == "なしなし":
        return "なし", "なし"

    # 金額パターン: 1ヶ月, 10万8,000円, 0円, なし, -
    _val = r"([\d,万.]+\s*[ヶか月円]+|なし|-)"
    m = re.match(rf"{_val}\s*{_val}", text)
    if m:
        return m.group(1).strip(), m.group(2).strip()

    return text, ""


def _split_layout_area(text: str) -> tuple[str, float]:
    """「1R20.01㎡」等を間取り・面積に分割する。"""
    layout = ""
    area = 0.0

    # 間取り
    lm = re.match(r"(\d[RSLDK]+|ワンルーム)", text)
    if lm:
        layout = lm.group(1)
        if layout == "ワンルーム":
            layout = "1R"

    # 面積
    am = re.search(r"([\d.]+)\s*[㎡m²]", text)
    if am:
        area = float(am.group(1))

    return layout, area


def _split_age_date(text: str) -> tuple[str, str]:
    """「築1年-」等を築年数・退去予定日に分割する。"""
    building_age = ""
    move_out = ""

    # 築年数
    m = re.match(r"(築\d+年|新築)", text)
    if m:
        building_age = m.group(1)
        rest = text[m.end():]
        if rest and rest != "-":
            move_out = rest
    else:
        move_out = text if text != "-" else ""

    return building_age, move_out


def _split_preview_movein(text: str) -> tuple[str, str]:
    """「-期日指定2026/5/中旬」等を内見開始日・入居時期に分割する。"""
    if not text:
        return "", ""

    # 先頭が「-」の場合
    if text.startswith("-"):
        rest = text[1:]
        return "", rest if rest and rest != "-" else ""

    # 日付で始まる場合（内見開始日）
    m = re.match(r"(\d{4}/\d{1,2}/\d{1,2}|\d{4}/\d{1,2}|-)", text)
    if m:
        preview = m.group(1) if m.group(1) != "-" else ""
        rest = text[m.end():]
        movein = rest if rest and rest != "-" else ""
        return preview, movein

    return "", text


def _extract_card_image(card: Tag) -> Optional[str]:
    """カードから画像URLを抽出する。"""
    img = card.find("img")
    if img:
        src = img.get("src") or img.get("data-src") or ""
        if src and not _is_icon(src) and not src.startswith("data:"):
            if src.startswith("//"):
                return "https:" + src
            if src.startswith("/"):
                return IELOVE_BASE_URL + src
            return src
    return None


def _is_icon(url: str) -> bool:
    """アイコン/ロゴ画像・プレースホルダーかどうか判定する。"""
    return bool(
        re.search(r"logo|icon|favicon|badge|noimage|dummy|loading", url, re.I)
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
                    td = tds[i]
                    # <br/>を含むTDはセパレーター付きでテキスト取得
                    if td.find("br"):
                        value = td.get_text(separator=" / ", strip=True)
                    else:
                        value = td.get_text(strip=True)
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
        # 部分一致で探す（ただし「構造」は完全一致のみ）
        for key, fld in _DETAIL_FIELD_MAP.items():
            if key == label and fld:
                field = fld
                break
        if not field:
            for key, fld in _DETAIL_FIELD_MAP.items():
                if len(key) >= 3 and key in label and fld:
                    field = fld
                    break

    if not field:
        return

    # 特殊処理
    if field == "other_stations":
        # 「X線「Y」駅 徒歩Z分」を個別に抽出
        found = re.findall(
            r"[^\s]+線「[^」]+」駅\s*徒歩\d+分", value
        )
        if found:
            # 内部の余分な空白を圧縮
            prop.other_stations = [
                re.sub(r"\s+", " ", s).strip() for s in found
            ]
        else:
            # フォールバック: カンマ等で分割
            stations = [
                s.strip() for s in re.split(r"[,、/／\n]", value)
                if s.strip()
            ]
            prop.other_stations = stations
        return

    if field == "lease_type":
        setattr(prop, field, value)
        return

    if field == "floor_text":
        setattr(prop, field, value)
        m = re.match(r"(\d+)\s*階", value)
        if m:
            prop.floor = int(m.group(1))
        return

    if field == "story_text":
        # 「1階/5階建」パターン → 所在階 + 階建てに分割
        m = re.match(r"(\d+)\s*階\s*/\s*(\d+)\s*階建", value)
        if m:
            prop.floor = int(m.group(1))
            prop.floor_text = f"{m.group(1)}階"
            prop.story_text = f"地上{m.group(2)}階建"
        else:
            setattr(prop, field, value)
        return

    if field == "structure":
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

        for td in table.find_all("td"):
            text = td.get_text(strip=True)
            if text and len(text) > 5:
                parts.append(text)

    if parts:
        return " / ".join(parts)

    # フォールバック
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
        # data: URI (lazy-load placeholder) を除外
        if src.startswith("data:"):
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
