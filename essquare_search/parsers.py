"""いい生活Square HTML/GraphQL パーサ

検索結果: GraphQL レスポンス JSON をパース (CDP fetch interceptor 経由)
詳細ページ: レンダリング済み HTML の物件概要テーブルを BeautifulSoup でパース
"""

import hashlib
import json
import re

from bs4 import BeautifulSoup

from itandi_search.models import Property

from .config import ESSQUARE_BASE_URL


# ─── GraphQL 検索結果パーサ ──────────────────────────────────


def parse_graphql_results(
    graphql_responses: list[dict],
) -> tuple[list[Property], bool]:
    """GraphQL レスポンスから物件リストと次ページ有無を返す。

    graphql_responses: CDP interceptor でキャプチャした
        [{url: str, data: {data: ...}}, ...] のリスト
    """
    if not graphql_responses:
        return [], False

    for resp in graphql_responses:
        raw_data = resp.get("data", resp)

        # AppSync の標準レスポンス: {data: {queryName: ...}}
        inner = raw_data.get("data", raw_data)

        # 配列を再帰的に探索して物件データを特定
        items = _find_property_array(inner)
        if not items:
            # デバッグ: レスポンス構造をログ出力
            _log_response_structure(raw_data)
            continue

        # ── デバッグ: 物件アイテムの実際のキーと値をログ出力 ──
        if items:
            sample = items[0]
            print(f"[DEBUG] ES-Square GraphQL item keys: {list(sample.keys())}")
            # 各キーの値の型と先頭100文字を出力
            for k, v in sample.items():
                v_str = str(v)[:150]
                print(f"[DEBUG]   {k} ({type(v).__name__}): {v_str}")
            # 2件目も出力（フィールドの多様性確認）
            if len(items) > 1:
                sample2 = items[1]
                print(f"[DEBUG] ES-Square GraphQL item[1] sample:")
                for k, v in sample2.items():
                    v_str = str(v)[:150]
                    print(f"[DEBUG]   {k} ({type(v).__name__}): {v_str}")
        # ── デバッグここまで ──

        properties: list[Property] = []
        for item in items:
            if not isinstance(item, dict):
                continue
            prop = _graphql_item_to_property(item)
            if prop:
                properties.append(prop)

        # ページネーション判定
        total = _find_total(inner)
        has_next = False
        if total is not None:
            has_next = total > len(properties)
        elif len(properties) >= 30:
            # total が不明な場合、30件(1ページ分)あれば次ページありと推定
            has_next = True

        if properties:
            print(
                f"[DEBUG] ES-Square GraphQL: {len(properties)} 件パース "
                f"(total={total})"
            )
            return properties, has_next

    print("[WARN] ES-Square: GraphQL レスポンスから物件データが見つかりません")
    return [], False


def _find_property_array(data: object, depth: int = 0) -> list[dict] | None:
    """JSON 構造の中から物件データの配列を再帰的に探す。

    保存検索条件 (conditionId, name, savedQuery) のような
    非物件データを誤検出しないよう、厳格なフィルタを適用する。
    """
    if depth > 6:
        return None

    if isinstance(data, list) and len(data) > 0:
        # 辞書の配列であれば物件データ候補
        if isinstance(data[0], dict):
            sample = data[0]
            keys_lower = {k.lower() for k in sample.keys()}

            # 非物件データを除外
            # 1. 保存検索条件 (conditionId, savedQuery)
            saved_search_keys = {"conditionid", "savedquery"}
            if keys_lower & saved_search_keys:
                print(
                    f"[DEBUG] ES-Square: 保存検索条件を除外 "
                    f"(keys={list(sample.keys())})"
                )
                return None

            # 2. ユーザーアカウントデータ (userId, roleUid 等)
            user_account_keys = {
                "userid", "roleuid", "provideruseruid",
                "publicname", "enablemfa", "ipaddresslist",
            }
            if len(keys_lower & user_account_keys) >= 2:
                print(
                    f"[DEBUG] ES-Square: ユーザーデータを除外 "
                    f"(keys={list(sample.keys())})"
                )
                return None

            # 物件データの特徴的なフィールド — 賃料/面積/住所が必須
            # "name" 単独ではマッチしない（検索条件名と区別不可）
            strong_indicators = {
                "rent", "chinryo", "price", "rentprice",
                "area", "menseki", "exclusivearea",
                "address", "jusho", "location",
                "layout", "madori",
            }
            # 強い指標が1つ以上あり、かつフィールド数が5以上
            matched = keys_lower & strong_indicators
            if matched and len(sample) >= 5:
                return data

            # 10以上のフィールドを持ち、id系キーがある場合
            # (物件データは通常多くのフィールドを持つ)
            if len(sample) >= 10:
                id_keys = {
                    k for k in keys_lower
                    if "id" in k or "uuid" in k
                }
                if id_keys:
                    return data

    if isinstance(data, dict):
        for key, value in data.items():
            result = _find_property_array(value, depth + 1)
            if result:
                return result

    return None


def _find_total(data: object, depth: int = 0) -> int | None:
    """レスポンスから total/count 値を探す。"""
    if depth > 5:
        return None

    if isinstance(data, dict):
        for key, value in data.items():
            key_lower = key.lower()
            if key_lower in ("total", "totalcount", "count", "totalitems"):
                if isinstance(value, int):
                    return value
            if isinstance(value, dict):
                result = _find_total(value, depth + 1)
                if result is not None:
                    return result

    return None


def _graphql_item_to_property(item: dict) -> Property | None:
    """GraphQL の物件アイテムを Property に変換する。

    フィールド名はサイトの GraphQL スキーマに依存するため、
    複数の命名パターンに対応する。
    """
    try:
        # UUID / ID の抽出
        uuid = _extract_field(item, [
            "uuid", "id", "roomId", "room_id", "bukkenId", "bukken_id",
            "propertyId", "property_id",
        ], "")

        if not uuid:
            # ネストされたオブジェクトの中を探す
            for v in item.values():
                if isinstance(v, dict):
                    uuid = _extract_field(v, ["uuid", "id"], "")
                    if uuid:
                        break

        # 物件名
        building_name = _extract_field(item, [
            "buildingName", "building_name", "bukkenName", "bukken_name",
            "name", "propertyName", "property_name",
        ], "不明")

        # 賃料 (円単位に統一)
        rent_raw = _extract_field(item, [
            "rent", "chinryo", "price", "rentPrice",
            "rent_price", "chinryou",
        ], 0)
        rent = _normalize_rent(rent_raw)

        # 管理費
        mgmt_raw = _extract_field(item, [
            "managementFee", "management_fee", "kanrihi",
            "commonAreaFee", "kyouekihi",
        ], 0)
        management_fee = _normalize_rent(mgmt_raw)

        # 間取り
        layout = _extract_field(item, [
            "layout", "madori", "roomLayout", "floor_plan",
        ], "")

        # 面積
        area_raw = _extract_field(item, [
            "area", "menseki", "exclusiveArea", "exclusive_area",
            "senyuMenseki",
        ], 0)
        area = float(area_raw) if area_raw else 0.0

        # 住所
        address = _extract_field(item, [
            "address", "jusho", "location", "propertyAddress",
        ], "")

        # 駅情報
        station = _extract_field(item, [
            "stationInfo", "station_info", "station", "access",
            "nearestStation", "kotsu",
        ], "")
        # 駅情報がリストの場合
        if isinstance(station, list):
            station = " / ".join(str(s) for s in station[:3])

        # 敷金・礼金
        deposit = str(_extract_field(item, [
            "deposit", "shikikin", "securityDeposit",
        ], ""))
        key_money = str(_extract_field(item, [
            "keyMoney", "key_money", "reikin", "gratitudePayment",
        ], ""))

        # 構造
        structure = _extract_field(item, [
            "structure", "kozo", "buildingStructure",
            "building_structure",
        ], "")

        # 築年数
        building_age = str(_extract_field(item, [
            "buildingAge", "building_age", "chikunensu",
            "age", "builtYear",
        ], ""))

        # 階数
        floor_raw = _extract_field(item, [
            "floor", "kai", "floorNumber",
        ], 0)
        floor = int(floor_raw) if floor_raw and str(floor_raw).isdigit() else 0

        # 入居可能日
        move_in = _extract_field(item, [
            "moveInDate", "move_in_date", "availableDate",
            "nyukyoDate", "nyukyo_date",
        ], "")

        # 画像URL
        image_url = _extract_field(item, [
            "imageUrl", "image_url", "thumbnailUrl", "thumbnail",
            "mainImage", "photo",
        ], None)
        image_urls_raw = _extract_field(item, [
            "imageUrls", "image_urls", "images", "photos",
        ], [])
        image_urls = list(image_urls_raw) if isinstance(
            image_urls_raw, list
        ) else []

        # room_id の決定
        room_id = str(uuid) if uuid else _generate_room_id(
            building_name, rent, layout, area
        )

        # building_id (UUID のハイフン前部分 or room_id)
        building_id = uuid.split("-")[0] if uuid and "-" in uuid else room_id

        # 詳細ページ URL
        url = ""
        if uuid:
            url = f"{ESSQUARE_BASE_URL}/bukken/chintai/search/detail/{uuid}"

        prop = Property(
            building_id=building_id,
            room_id=room_id,
            building_name=building_name,
            source="essquare",
            address=address,
            rent=rent,
            management_fee=management_fee,
            deposit=deposit,
            key_money=key_money,
            layout=layout,
            area=area,
            floor=floor,
            building_age=building_age,
            station_info=station,
            url=url,
            image_url=image_url,
            image_urls=image_urls,
            structure=structure,
            move_in_date=str(move_in),
        )
        # デバッグ: 抽出結果のサマリー（最初の3件のみ）
        if not hasattr(_graphql_item_to_property, "_debug_count"):
            _graphql_item_to_property._debug_count = 0
        if _graphql_item_to_property._debug_count < 3:
            print(
                f"[DEBUG] ES-Square parsed property: "
                f"uuid={uuid!r}, name={building_name!r}, "
                f"rent={rent}, layout={layout!r}, "
                f"area={area}, addr={address!r}"
            )
            _graphql_item_to_property._debug_count += 1
        return prop
    except Exception as exc:
        print(f"[WARN] ES-Square GraphQL 物件パースエラー: {exc}")
        return None


def _extract_field(
    item: dict, keys: list[str], default: object
) -> object:
    """複数の候補キーから値を取得する。"""
    for key in keys:
        if key in item and item[key] is not None:
            return item[key]
        # case-insensitive fallback
        key_lower = key.lower()
        for k, v in item.items():
            if k.lower() == key_lower and v is not None:
                return v
    return default


def _normalize_rent(value: object) -> int:
    """賃料を円単位の int に正規化する。"""
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return int(value)
    if isinstance(value, str):
        # "140,000" or "140000" or "14万" or "14.0万円"
        cleaned = value.replace(",", "").replace("円", "").strip()
        if "万" in cleaned:
            cleaned = cleaned.replace("万", "")
            try:
                return int(float(cleaned) * 10000)
            except ValueError:
                return 0
        try:
            return int(float(cleaned))
        except ValueError:
            return 0
    return 0


def _generate_room_id(
    building_name: str, rent: int, layout: str, area: float
) -> str:
    """UUID が取得できない場合の代替 room_id を生成する。"""
    source = f"esq:{building_name}:{rent}:{layout}:{area}"
    return "esq-" + hashlib.md5(source.encode()).hexdigest()[:12]


def _log_response_structure(data: object, prefix: str = "", depth: int = 0):
    """GraphQL レスポンスの構造をデバッグログに出力する。"""
    if depth > 3:
        return
    if isinstance(data, dict):
        keys = list(data.keys())[:20]
        print(f"[DEBUG] GraphQL {prefix}: dict keys={keys}")
        for k in keys[:5]:
            _log_response_structure(data[k], f"{prefix}.{k}", depth + 1)
    elif isinstance(data, list):
        print(
            f"[DEBUG] GraphQL {prefix}: list len={len(data)}"
            f"{f' item_type={type(data[0]).__name__}' if data else ''}"
        )
        if data and isinstance(data[0], dict):
            print(
                f"[DEBUG] GraphQL {prefix}[0]: keys="
                f"{list(data[0].keys())[:15]}"
            )


def _debug_dom_row(row, idx: int) -> None:
    """物件行の DOM 構造をデバッグ出力する。"""
    try:
        tag = row.name
        classes = row.get("class", [])
        if isinstance(classes, list):
            classes = " ".join(classes)

        # 直接の子要素の概要
        children = list(row.children)
        child_tags = []
        for c in children:
            name = getattr(c, "name", None)
            if name:
                c_cls = c.get("class", [])
                if isinstance(c_cls, list):
                    c_cls = " ".join(c_cls[:2])
                c_text = c.get_text(" ", strip=True)[:40]
                child_tags.append(f"{name}.{c_cls}='{c_text}'")

        print(f"[DEBUG] DOM row[{idx}]: <{tag} class='{classes}'>")
        print(f"[DEBUG]   children ({len(child_tags)}): "
              f"{child_tags[:8]}")

        # クリーンなテキスト行を出力
        text = row.get_text("\n", strip=True)
        clean = _clean_dom_lines(text)
        print(f"[DEBUG]   clean_lines ({len(clean)}): "
              f"{clean[:10]}")

        # リンクの確認
        links = row.find_all("a", href=True)
        for link in links[:3]:
            print(f"[DEBUG]   <a href='{link['href'][:100]}'>")

    except Exception as exc:
        print(f"[DEBUG] DOM row debug error: {exc}")


# ─── DOM フォールバックパーサ (検索結果) ──────────────────────


def parse_search_results(html: str) -> tuple[list[Property], bool]:
    """検索結果ページのレンダリング済み HTML から物件リストを解析する。

    React SPA のレンダリング後の DOM をパースする。
    MUI のクラス名は動的なため、テキストパターンでマッチングする。
    """
    soup = BeautifulSoup(html, "lxml")
    properties: list[Property] = []
    seen_keys: set[str] = set()

    # ── デバッグ: HTML 構造を調査 ──
    body = soup.find("body")
    body_text = body.get_text(" ", strip=True) if body else ""
    print(f"[DEBUG] DOM パーサ: HTML={len(html)} bytes, "
          f"body_text={len(body_text)} chars")

    # テーブル要素の確認
    tables = soup.find_all("table")
    print(f"[DEBUG] DOM パーサ: <table> count={len(tables)}")

    # リンク内のテキストパターンを確認
    detail_links = soup.find_all(
        "a", href=re.compile(r"/bukken/chintai/search/detail/")
    )
    print(f"[DEBUG] DOM パーサ: 物件詳細リンク count={len(detail_links)}")
    for i, link in enumerate(detail_links[:3]):
        href = link.get("href", "")
        text = link.get_text(" ", strip=True)[:100]
        print(f"[DEBUG]   link[{i}]: href={href}")
        print(f"[DEBUG]   link[{i}]: text={text}")

    # 賃料テキストを含む要素を起点に物件行を探す
    rent_pattern = re.compile(r"([\d,]+)\s*円")
    rent_matches = soup.find_all(string=rent_pattern)
    print(f"[DEBUG] DOM パーサ: 賃料パターン matches={len(rent_matches)}")
    for i, m in enumerate(rent_matches[:5]):
        print(f"[DEBUG]   rent[{i}]: {str(m).strip()[:80]}")

    # ── 方式1: 物件詳細リンクから物件行を探す ──
    if detail_links:
        print("[DEBUG] DOM パーサ: 詳細リンク方式で物件抽出を試行...")
        for link in detail_links:
            href = link.get("href", "")
            uuid_match = re.search(
                r"/detail/([a-f0-9-]+)", href
            )
            uuid = uuid_match.group(1) if uuid_match else ""

            # リンクの親要素から物件行を探す
            row = _find_property_row(link)
            if not row:
                # リンクの親を遡って行コンテナを探す
                row = _find_property_row_flexible(link)

            if row:
                row_id = id(row)
                if row_id in seen_keys:
                    continue
                seen_keys.add(row_id)

                prop = _parse_dom_property_row(row, uuid=uuid)
                if prop:
                    properties.append(prop)

    # ── 方式2: 賃料テキストから物件行を探す (フォールバック) ──
    if not properties:
        print("[DEBUG] DOM パーサ: 賃料パターン方式で物件抽出を試行...")
        _debug_row_count = 0
        for element in rent_matches:
            parent = element.parent
            if not parent:
                continue

            row = _find_property_row(parent)
            if not row:
                row = _find_property_row_flexible(parent)
            if not row:
                continue

            row_id = id(row)
            if row_id in seen_keys:
                continue
            seen_keys.add(row_id)

            # デバッグ: 最初の2行のHTML構造をダンプ
            if _debug_row_count < 2:
                _debug_dom_row(row, _debug_row_count)
                _debug_row_count += 1

            prop = _parse_dom_property_row(row)
            if prop:
                properties.append(prop)

    # ── 方式3: テーブル行から物件を探す ──
    if not properties and tables:
        print("[DEBUG] DOM パーサ: テーブル方式で物件抽出を試行...")
        for table in tables:
            rows = table.find_all("tr")
            for tr in rows:
                cells = tr.find_all(["td", "th"])
                if len(cells) >= 4:
                    cell_texts = [
                        c.get_text(strip=True)[:50] for c in cells
                    ]
                    # 賃料っぽいセルがあれば
                    if any("円" in t for t in cell_texts):
                        prop = _parse_table_row(tr)
                        if prop:
                            properties.append(prop)

    print(f"[DEBUG] DOM パーサ: 最終結果 {len(properties)} 件")

    # ページネーション: 次ページの存在を判定
    has_next = _check_pagination(soup)

    return properties, has_next


def _find_property_row(element) -> object | None:
    """要素から物件行のコンテナ要素を探す。

    MuiBox-root の子要素を 6 つ以上持つ flex コンテナを探す。
    """
    current = element
    for _ in range(10):
        current = current.parent
        if not current or current.name is None:
            return None

        # div で MuiBox-root クラスを持つか確認
        classes = current.get("class", [])
        if not isinstance(classes, list):
            classes = [classes]

        if current.name != "div":
            continue

        if not any("MuiBox" in c for c in classes):
            continue

        # 直接の div 子要素数を確認
        children = [
            c for c in current.children
            if getattr(c, "name", None) == "div"
        ]

        if len(children) >= 6:
            return current

    return None


def _find_property_row_flexible(element) -> object | None:
    """詳細リンクの親要素から物件行コンテナを柔軟に探す。

    MuiBox に限らず、テキスト内容が物件情報を含む最小のコンテナを返す。
    """
    current = element
    for _ in range(15):
        current = current.parent
        if not current or current.name is None:
            return None

        if current.name not in ("div", "tr", "li", "article", "section"):
            continue

        text = current.get_text(" ", strip=True)
        # 賃料(円)と面積(㎡)が両方含まれていれば物件行と判断
        if "円" in text and ("㎡" in text or "m²" in text):
            return current

    return None


def _parse_table_row(tr) -> Property | None:
    """テーブル行 (tr) から Property を構築する。"""
    try:
        cells = tr.find_all(["td", "th"])
        if len(cells) < 4:
            return None

        texts = [c.get_text(strip=True) for c in cells]
        full_text = " ".join(texts)

        # 賃料抽出
        rent_match = re.search(r"([\d,]+)\s*円", full_text)
        rent = (
            int(rent_match.group(1).replace(",", ""))
            if rent_match else 0
        )
        if not rent:
            return None

        # 物件名 (最初の非空セル)
        building_name = "不明"
        for t in texts:
            if t and "円" not in t and "㎡" not in t:
                building_name = t[:50]
                break

        # 間取り・面積
        layout = ""
        area = 0.0
        for t in texts:
            m_layout = re.search(
                r"(ワンルーム|[1-9][KDLRSK]+(?:\+S)?)", t
            )
            if m_layout:
                layout = m_layout.group(1)
            m_area = re.search(r"([\d.]+)\s*(?:㎡|m²)", t)
            if m_area:
                area = float(m_area.group(1))

        # UUID (リンクから)
        uuid = ""
        link = tr.find(
            "a", href=re.compile(r"/detail/")
        )
        if link:
            m = re.search(r"/detail/([a-f0-9-]+)", link["href"])
            if m:
                uuid = m.group(1)

        room_id = str(uuid) if uuid else _generate_room_id(
            building_name, rent, layout, area
        )
        url = (
            f"{ESSQUARE_BASE_URL}/bukken/chintai/search/detail/{uuid}"
            if uuid else ""
        )

        return Property(
            building_id=room_id,
            room_id=room_id,
            building_name=building_name,
            source="essquare",
            rent=rent,
            layout=layout,
            area=area,
            url=url,
        )
    except Exception as exc:
        print(f"[WARN] ES-Square テーブル行パースエラー: {exc}")
        return None


def _parse_dom_property_row(row, uuid: str = "") -> Property | None:
    """DOM の物件行から Property を構築する。

    物件行の構造を柔軟にパースする。
    - 方式A: div の子要素がカラムとして並ぶ (MUI Grid)
    - 方式B: 行全体のテキストから正規表現で抽出
    """
    try:
        # ── 方式A: カラム構造 ──
        children = [
            c for c in row.children
            if getattr(c, "name", None) == "div"
        ]

        if len(children) >= 6:
            return _parse_column_row(children, uuid)

        # ── 方式B: テキストベース抽出 ──
        return _parse_text_row(row, uuid)

    except Exception as exc:
        print(f"[WARN] ES-Square DOM パースエラー: {exc}")
        return None


def _parse_column_row(children: list, uuid: str = "") -> Property | None:
    """カラム構造の物件行をパースする (方式A)。

    各カラムのテキストからタイムスタンプを除去してからパースする。
    """
    # Col 2: 物件名・住所・駅情報
    col_info = children[1] if len(children) > 1 else None
    info_text = col_info.get_text("\n", strip=True) if col_info else ""
    info_lines = _clean_dom_lines(info_text)

    # バッジ・ラベル行をスキップして物件名を取得
    building_name = "不明"
    name_idx = 0
    for i, line in enumerate(info_lines):
        if _is_badge_line(line):
            continue
        building_name = line[:60]
        name_idx = i
        break

    address = ""
    station_info = ""
    for line in info_lines[name_idx + 1:]:
        if "駅" in line and ("徒歩" in line or "分" in line):
            station_info = line
        elif not address and (
            "区" in line or "市" in line or "町" in line
            or "丁目" in line
        ):
            address = line

    # Col 3: 賃料・管理費
    col_rent = children[2] if len(children) > 2 else None
    rent_text = col_rent.get_text(" ", strip=True) if col_rent else ""
    rent, management_fee = _parse_rent_text(rent_text)

    # Col 4: 敷金・礼金
    col_deposit = children[3] if len(children) > 3 else None
    deposit_text = (
        col_deposit.get_text(" ", strip=True) if col_deposit else ""
    )
    deposit, key_money = _parse_deposit_text(deposit_text)

    # Col 5: 間取り・面積 (タイムスタンプ除去)
    col_layout = children[4] if len(children) > 4 else None
    layout_text = (
        col_layout.get_text(" ", strip=True) if col_layout else ""
    )
    layout_text = re.sub(r"\b\d{10,}\b", "", layout_text).strip()
    layout, area = _parse_layout_text(layout_text)

    # Col 6: 構造・築年数 (タイムスタンプ除去)
    col_structure = children[5] if len(children) > 5 else None
    structure_text = (
        col_structure.get_text(" ", strip=True) if col_structure else ""
    )
    structure_text = re.sub(r"\b\d{10,}\b", "", structure_text).strip()
    structure, building_age = _parse_structure_text(structure_text)

    room_id = str(uuid) if uuid else _generate_room_id(
        building_name, rent, layout, area
    )
    url = (
        f"{ESSQUARE_BASE_URL}/bukken/chintai/search/detail/{uuid}"
        if uuid else ""
    )

    return Property(
        building_id=room_id,
        room_id=room_id,
        building_name=building_name,
        source="essquare",
        address=address,
        rent=rent,
        management_fee=management_fee,
        deposit=deposit,
        key_money=key_money,
        layout=layout,
        area=area,
        station_info=station_info,
        structure=structure,
        building_age=building_age,
        url=url,
    )


def _parse_text_row(row, uuid: str = "") -> Property | None:
    """行全体のテキストから物件情報を正規表現で抽出する (方式B)。

    カラム構造がない場合のフォールバック。
    React が生成するタイムスタンプ(13桁数字)を除去してからパースする。
    """
    text = row.get_text("\n", strip=True)
    lines = _clean_dom_lines(text)

    if not lines:
        return None

    # 賃料 (必須) — 「円」を含む行を優先検索
    rent = 0
    management_fee = 0

    # まず、「円」を含む行から賃料を探す (金額が大きい順にソート)
    yen_lines = [l for l in lines if "円" in l]
    rent_candidates: list[tuple[int, int]] = []
    for line in yen_lines:
        r, m = _parse_rent_text(line)
        if r > 0:
            rent_candidates.append((r, m))

    if rent_candidates:
        # 最大額を賃料とする (敷金・礼金より賃料が大きいことが多い)
        # ただし、先に出現する金額を優先
        rent, management_fee = rent_candidates[0]

    # 「円」がなくても「万」形式の賃料を探す (例: "4.7万")
    if not rent:
        for line in lines:
            m_man = re.search(r"([\d.]+)\s*万", line)
            if m_man:
                try:
                    rent = int(float(m_man.group(1)) * 10000)
                    break
                except ValueError:
                    pass

    if not rent:
        return None

    # 物件名 (バッジ・賃料・面積を除いた最初の行)
    building_name = "不明"
    for line in lines:
        if _is_badge_line(line):
            continue
        if ("円" not in line and "㎡" not in line
                and "m²" not in line and len(line) > 2):
            building_name = line[:60]
            break

    # 間取り・面積
    layout = ""
    area = 0.0
    for line in lines:
        l, a = _parse_layout_text(line)
        if l:
            layout = l
        if a > 0:
            area = a

    # 住所
    address = ""
    station_info = ""
    for line in lines:
        if "駅" in line and ("徒歩" in line or "分" in line):
            station_info = line
        elif not address and (
            "区" in line or "市" in line or "町" in line
            or "丁目" in line
        ):
            address = line

    # 敷金・礼金
    deposit = ""
    key_money = ""
    for line in lines:
        d, k = _parse_deposit_text(line)
        if d:
            deposit = d
        if k:
            key_money = k

    # 構造・築年数
    structure = ""
    building_age = ""
    for line in lines:
        s, a = _parse_structure_text(line)
        if s:
            structure = s
        if a:
            building_age = a

    # UUID からリンクを探す
    if not uuid:
        link = row.find("a", href=re.compile(r"/detail/"))
        if link:
            m = re.search(r"/detail/([a-f0-9-]+)", link["href"])
            if m:
                uuid = m.group(1)

    room_id = str(uuid) if uuid else _generate_room_id(
        building_name, rent, layout, area
    )
    url = (
        f"{ESSQUARE_BASE_URL}/bukken/chintai/search/detail/{uuid}"
        if uuid else ""
    )

    return Property(
        building_id=room_id,
        room_id=room_id,
        building_name=building_name,
        source="essquare",
        address=address,
        rent=rent,
        management_fee=management_fee,
        deposit=deposit,
        key_money=key_money,
        layout=layout,
        area=area,
        station_info=station_info,
        structure=structure,
        building_age=building_age,
        url=url,
    )


# ES-Square 検索結果のバッジ・ラベルパターン
_BADGE_PATTERNS = re.compile(
    r"^("
    r"New|NEW|新着|更新|値下げ"
    r"|AD\s*あり|AD\s*有|AD\s*–|AD$"
    r"|広告可[※＊]?|広告料あり"
    r"|元付|客付|専任|一般"
    r"|\d+分前|\d+時間前|\d+日前"
    r")$",
    re.IGNORECASE,
)


def _is_badge_line(line: str) -> bool:
    """行がバッジ・ラベル（物件名ではない）かどうかを判定する。"""
    line = line.strip()
    if not line or len(line) <= 1:
        return True
    if _BADGE_PATTERNS.match(line):
        return True
    return False


def _clean_dom_lines(text: str) -> list[str]:
    """DOM テキストから React 生成のタイムスタンプを除去してクリーンな行リストを返す。

    React/MUI コンポーネントがレンダリングする DOM には、
    13桁のタイムスタンプ(ミリ秒Unix時間)がテキストノードに混入することがある。
    これらを除去してから行分割する。
    """
    lines = [l.strip() for l in text.split("\n") if l.strip()]

    cleaned: list[str] = []
    for line in lines:
        # 行全体が10桁以上の数字のみ → タイムスタンプ → スキップ
        if re.fullmatch(r"\d{10,}", line):
            continue
        # 行内のタイムスタンプ（10桁以上の数字が単独で存在）を除去
        line = re.sub(r"\b\d{10,}\b", "", line).strip()
        if line:
            cleaned.append(line)

    return cleaned


def _parse_rent_text(text: str) -> tuple[int, int]:
    """賃料テキストから (賃料, 管理費) を円単位で返す。

    タイムスタンプ(10桁以上)が混入している場合は除去してからパースする。
    """
    # タイムスタンプ除去
    cleaned = re.sub(r"\b\d{10,}\b", "", text).strip()
    amounts = re.findall(r"([\d,]+)\s*円", cleaned)
    rent = int(amounts[0].replace(",", "")) if amounts else 0
    mgmt = int(amounts[1].replace(",", "")) if len(amounts) > 1 else 0
    return rent, mgmt


def _parse_deposit_text(text: str) -> tuple[str, str]:
    """敷金・礼金テキストを返す。"""
    deposit = ""
    key_money = ""
    # タイムスタンプ除去
    text = re.sub(r"\b\d{10,}\b", "", text).strip()
    # "敷140,000円 礼140,000円" パターン
    m_deposit = re.search(r"敷\s*([\d,]+円|なし|-)", text)
    m_key = re.search(r"礼\s*([\d,]+円|なし|-)", text)
    if m_deposit:
        deposit = m_deposit.group(1)
    if m_key:
        key_money = m_key.group(1)
    return deposit, key_money


def _parse_layout_text(text: str) -> tuple[str, float]:
    """間取り・面積テキストから (間取り, 面積m2) を返す。"""
    layout = ""
    area = 0.0
    # "1K 24.39 ㎡"
    m_layout = re.search(
        r"(ワンルーム|[1-9][KDLRSK]+(?:\+S)?)", text
    )
    m_area = re.search(r"([\d.]+)\s*㎡", text)
    if m_layout:
        layout = m_layout.group(1)
    if m_area:
        area = float(m_area.group(1))
    return layout, area


def _parse_structure_text(text: str) -> tuple[str, str]:
    """構造・築年数テキストを返す。"""
    structure = ""
    age = ""
    # "鉄筋コンクリート 9年"
    parts = text.split()
    for part in parts:
        if re.match(r"\d+年", part):
            age = part
        elif part and not re.match(r"[\d.]+", part):
            structure = part
    return structure, age


def _check_pagination(soup: BeautifulSoup) -> bool:
    """次ページが存在するか判定する。"""
    # 「次へ」「>」ボタンの存在確認
    for text in ["次へ", "次", ">"]:
        el = soup.find(string=re.compile(re.escape(text)))
        if el:
            # disabled でなければ次ページあり
            parent = el.parent
            if parent and not parent.get("disabled"):
                return True

    # aria-label="Go to next page" パターン (MUI Pagination)
    next_btn = soup.find(attrs={"aria-label": re.compile(r"next", re.I)})
    if next_btn and not next_btn.get("disabled"):
        return True

    return False


# ─── 詳細ページパーサ ────────────────────────────────────────


def parse_detail_page(html: str) -> dict:
    """詳細ページの HTML から物件詳細情報を辞書で返す。

    物件概要テーブル (th/td ペア) をパースし、
    Property のフィールド名にマッピングする。
    """
    soup = BeautifulSoup(html, "lxml")
    details: dict = {}

    # 物件概要テーブルを探す
    # パターン1: <table> 内の th/td
    for table in soup.find_all("table"):
        rows = table.find_all("tr")
        for tr in rows:
            th = tr.find("th")
            td = tr.find("td")
            if th and td:
                label = th.get_text(strip=True)
                value = td.get_text(strip=True)
                _map_detail_field(details, label, value)

    # パターン2: dl > dt/dd (React SPA で使われることがある)
    for dl in soup.find_all("dl"):
        dts = dl.find_all("dt")
        dds = dl.find_all("dd")
        for dt_el, dd_el in zip(dts, dds):
            label = dt_el.get_text(strip=True)
            value = dd_el.get_text(strip=True)
            _map_detail_field(details, label, value)

    # パターン3: MUI の Grid/Box ベースのレイアウト (th-like + td-like div)
    # ラベルと値が隣接する div として配置されるパターン
    _parse_mui_detail_layout(soup, details)

    # 画像 URL の取得
    image_urls = _extract_detail_images(soup)
    if image_urls:
        details["image_urls"] = image_urls
        if not details.get("image_url"):
            details["image_url"] = image_urls[0]

    # 設備一覧の取得
    facilities = _extract_facilities(soup)
    if facilities:
        details["facilities"] = facilities

    return details


# 詳細ページのラベル → Property フィールドのマッピング
_DETAIL_FIELD_MAP: dict[str, str] = {
    "物件名": "building_name",
    "物件所在地": "address",
    "所在地": "address",
    "交通機関": "station_info",
    "最寄り駅": "station_info",
    "交通": "station_info",
    "間取り": "layout",
    "面積": "_area_text",
    "専有面積": "_area_text",
    "所在階": "floor_text",
    "階": "floor_text",
    "部屋向き": "sunlight",
    "向き": "sunlight",
    "主要採光面": "sunlight",
    "建物構造": "structure",
    "構造": "structure",
    "築年月": "building_age",
    "築年数": "building_age",
    "総戸数": "total_units",
    "賃貸借の種類": "lease_type",
    "契約種別": "lease_type",
    "契約期間": "contract_period",
    "解約予告": "cancellation_notice",
    "解約通知期間": "cancellation_notice",
    "更新": "renewal_info",
    "更新・再契約": "renewal_info",
    "入居可能日": "move_in_date",
    "入居時期": "move_in_date",
    "階建て": "story_text",
    "階建": "story_text",
    "敷引き": "shikibiki",
    "償却": "shikibiki",
    "ペット敷金": "pet_deposit",
    "フリーレント": "free_rent",
    "更新料": "renewal_fee",
    "火災保険": "fire_insurance",
    "火災保険料": "fire_insurance",
    "更新事務手数料": "renewal_admin_fee",
    "保証会社": "guarantee_info",
    "保証": "guarantee_info",
    "鍵交換": "key_exchange_fee",
    "鍵交換費用": "key_exchange_fee",
    "賃料": "_rent_text",
    "管理費": "_mgmt_text",
    "共益費": "_mgmt_text",
    "敷金": "deposit",
    "礼金": "key_money",
    "部屋番号": "room_number",
}


def _map_detail_field(details: dict, label: str, value: str) -> None:
    """ラベルと値を details 辞書にマッピングする。"""
    if not label or not value:
        return

    # 完全一致
    if label in _DETAIL_FIELD_MAP:
        field_name = _DETAIL_FIELD_MAP[label]
        details[field_name] = value
        return

    # 部分一致
    for key, field_name in _DETAIL_FIELD_MAP.items():
        if key in label:
            details[field_name] = value
            return


def _parse_mui_detail_layout(soup: BeautifulSoup, details: dict) -> None:
    """MUI Grid/Box ベースの詳細情報レイアウトをパースする。"""
    # ラベルキーワードを含むテキスト要素を探し、隣接要素から値を取得
    label_keywords = list(_DETAIL_FIELD_MAP.keys())

    for keyword in label_keywords:
        elements = soup.find_all(
            string=re.compile(re.escape(keyword))
        )
        for el in elements:
            parent = el.parent
            if not parent:
                continue

            # 同じ親内の次の兄弟要素から値を取得
            next_sib = parent.find_next_sibling()
            if next_sib:
                value = next_sib.get_text(strip=True)
                if value and value != keyword:
                    _map_detail_field(details, keyword, value)
                    break

            # 親の次の子要素を確認
            grandparent = parent.parent
            if grandparent:
                children = list(grandparent.children)
                try:
                    idx = children.index(parent)
                    if idx + 1 < len(children):
                        next_child = children[idx + 1]
                        if hasattr(next_child, "get_text"):
                            value = next_child.get_text(strip=True)
                            if value and value != keyword:
                                _map_detail_field(
                                    details, keyword, value
                                )
                                break
                except ValueError:
                    pass


def _extract_detail_images(soup: BeautifulSoup) -> list[str]:
    """詳細ページから画像 URL を抽出する。"""
    urls: list[str] = []
    seen: set[str] = set()

    for img in soup.find_all("img"):
        src = img.get("src", "")
        if not src or src in seen:
            continue
        # blob: URL やプレースホルダーをスキップ
        if src.startswith("blob:") or "placeholder" in src.lower():
            continue
        # 物件画像っぽいもの (S3 等のストレージ URL)
        if any(
            domain in src
            for domain in [
                "amazonaws.com", "cloudfront.net", "es-square",
                "es-account", "essquare",
            ]
        ):
            urls.append(src)
            seen.add(src)

    return urls


def _extract_facilities(soup: BeautifulSoup) -> str:
    """詳細ページから設備一覧テキストを抽出する。"""
    # "設備" ラベルの後のテキストを取得
    for keyword in ["設備", "設備・条件", "主な設備"]:
        elements = soup.find_all(string=re.compile(re.escape(keyword)))
        for el in elements:
            parent = el.parent
            if not parent:
                continue

            # 同じ行 or 次の要素から設備テキストを取得
            next_sib = parent.find_next_sibling()
            if next_sib:
                text = next_sib.get_text(", ", strip=True)
                if text and len(text) > 5:
                    return text

            # 親コンテナの全テキストから設備部分を抽出
            grandparent = parent.parent
            if grandparent:
                full_text = grandparent.get_text(", ", strip=True)
                if keyword in full_text:
                    # keyword 以降のテキストを返す
                    idx = full_text.index(keyword) + len(keyword)
                    rest = full_text[idx:].lstrip(",: 、")
                    if rest and len(rest) > 5:
                        return rest

    return ""
