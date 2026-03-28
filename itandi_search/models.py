"""データクラス定義"""

import re
from dataclasses import dataclass, field
from datetime import date
from typing import Optional


def _normalize_building_age(value: str) -> str:
    """築年月/築年数テキストを「築○年」形式に変換する。

    入力例:
        "2017/09"      → "築9年"
        "2017年9月"    → "築9年"
        "2017年09月築" → "築9年"
        "築15年"       → "築15年"  (そのまま)
        "9年"          → "築9年"
        "新築"         → "新築"    (そのまま)
        ""             → ""
    """
    if not value:
        return value

    value = value.strip()

    # 既に「築○年」形式 or 「新築」ならそのまま
    if re.match(r"^築\d+年", value) or value == "新築":
        return value

    # 「○年」のみ（築が付いていない）→ 築を付ける
    m = re.match(r"^(\d+)年$", value)
    if m:
        return f"築{m.group(1)}年"

    # 年月形式から年を抽出: "2017/09", "2017-09", "2017年9月", etc.
    m = re.search(r"(\d{4})\s*[/\-年]\s*(\d{1,2})", value)
    if m:
        built_year = int(m.group(1))
        built_month = int(m.group(2))
        today = date.today()
        years = today.year - built_year
        if today.month < built_month:
            years -= 1
        if years < 1:
            return "新築"
        return f"築{years}年"

    # 年のみ: "2017" or "2017年"
    m = re.match(r"^(\d{4})年?$", value)
    if m:
        built_year = int(m.group(1))
        years = date.today().year - built_year
        if years < 1:
            return "新築"
        return f"築{years}年"

    return value


def _normalize_move_in_date(value: str) -> str:
    """入居可能時期テキストを日付表記に変換する。

    入力例:
        "2026/03/29"        → "2026年3月29日"
        "2026-03-29"        → "2026年3月29日"
        "2026/04"           → "2026年4月"
        "2026/04 下旬"      → "2026年4月下旬"
        "2026/04 下旬予定"  → "2026年4月下旬"
        "即入居可"           → "即入居可"  (そのまま)
        "即入居"             → "即入居可"
        "4月上旬"            → "4月上旬"   (そのまま)
        ""                  → ""
    """
    if not value:
        return value

    value = value.strip()

    # 「予定」サフィックスを除去
    value = re.sub(r"予定$", "", value).strip()

    # 「即入居」→「即入居可」に統一
    if value == "即入居":
        return "即入居可"

    # 年/月/日 形式: "2026/03/29", "2026-03-29"
    m = re.match(r"^(\d{4})[/\-](\d{1,2})[/\-](\d{1,2})$", value)
    if m:
        y, mo, d = int(m.group(1)), int(m.group(2)), int(m.group(3))
        return f"{y}年{mo}月{d}日"

    # 年/月 + 旬 形式: "2026/04 下旬", "2026/04 中旬"
    m = re.match(
        r"^(\d{4})[/\-](\d{1,2})\s*(上旬|中旬|下旬)$", value
    )
    if m:
        y, mo = int(m.group(1)), int(m.group(2))
        period = m.group(3)
        return f"{y}年{mo}月{period}"

    # 年/月 形式: "2026/04", "2026-04"
    m = re.match(r"^(\d{4})[/\-](\d{1,2})$", value)
    if m:
        y, mo = int(m.group(1)), int(m.group(2))
        return f"{y}年{mo}月"

    return value


@dataclass
class CustomerCriteria:
    """お客さん1人分の検索条件"""

    name: str
    prefecture: str
    cities: list[str] = field(default_factory=list)
    stations: list[str] = field(default_factory=list)
    walk_minutes: Optional[int] = None
    rent_min: Optional[int] = None  # 円単位
    rent_max: Optional[int] = None  # 円単位
    layouts: list[str] = field(default_factory=list)
    area_min: Optional[float] = None
    area_max: Optional[float] = None
    building_age: Optional[int] = None
    building_types: list[str] = field(default_factory=list)
    structure_types: list[str] = field(default_factory=list)
    min_floor: Optional[int] = None
    max_floor: Optional[int] = None
    top_floor_only: bool = False
    south_facing: bool = False
    no_loft: bool = False
    require_loft: bool = False
    no_deposit: bool = False
    no_key_money: bool = False
    no_teiki: bool = False  # 定期借家を含まない
    equipment_ids: list[int] = field(default_factory=list)
    soft_equipment_ids: list[int] = field(default_factory=list)
    equipment_names: list[str] = field(default_factory=list)  # ES-Square kodawari 用
    ad_reprint_only: bool = False
    deal_types: list[str] = field(default_factory=list)
    update_within_days: Optional[int] = None
    discord_thread_id: Optional[str] = None  # 既存スレッドID（あれば）
    move_in_date: str = ""  # 引越し時期（顧客の希望入居時期）


@dataclass
class Property:
    """物件1部屋分のデータ"""

    building_id: str
    room_id: str
    building_name: str
    address: str
    rent: int  # 円単位
    source: str = "itandi"  # "itandi" or "essquare"
    management_fee: int = 0
    deposit: str = ""
    key_money: str = ""
    layout: str = ""
    area: float = 0.0
    floor: int = 0
    building_age: str = ""
    station_info: str = ""
    room_number: str = ""
    url: str = ""
    image_url: Optional[str] = None
    image_urls: list[str] = field(default_factory=list)
    image_categories: list[str] = field(default_factory=list)  # 画像カテゴリ（いえらぶ）
    image_data: Optional[bytes] = None  # 画像バイナリ（Discord添付用）
    # 追加詳細情報
    story_text: str = ""  # 階建て (例: "地上10階建")
    other_stations: list[str] = field(default_factory=list)  # 他の最寄り駅
    move_in_date: str = ""  # 入居可能時期
    floor_text: str = ""  # 所在階 (テキスト)
    structure: str = ""  # 構造
    total_units: str = ""  # 総戸数
    lease_type: str = ""  # 賃貸借契約区分
    contract_period: str = ""  # 契約期間
    cancellation_notice: str = ""  # 解約予告
    renewal_info: str = ""  # 更新・再契約可否
    sunlight: str = ""  # 主要採光面
    facilities: str = ""  # 設備・詳細
    cleaning_fee: str = ""  # クリーニング費用
    shikibiki: str = ""  # 敷引き償却
    pet_deposit: str = ""  # ペット飼育時敷金追加
    free_rent: str = ""  # フリーレント
    renewal_fee: str = ""  # 更新料
    fire_insurance: str = ""  # 火災保険料
    renewal_admin_fee: str = ""  # 更新事務手数料
    guarantee_info: str = ""  # 保証情報（利用必須 + 保証料等）
    key_exchange_fee: str = ""  # 鍵交換費用
    support_fee_24h: str = ""  # 24時間サポート費
    additional_deposit: str = ""  # 敷金積み増し
    guarantee_deposit: str = ""  # 保証金
    water_billing: str = ""  # 水道料金形態
    parking_fee: str = ""  # 駐車場代
    bicycle_parking_fee: str = ""  # 駐輪場代
    motorcycle_parking_fee: str = ""  # バイク置き場代
    other_monthly_fee: str = ""  # その他月次費用（Concierge24等）
    other_onetime_fee: str = ""  # その他一時金（鍵交換費・HC代等）
    move_in_conditions: str = ""  # 入居条件（ペット可否・法人可否等）
    move_out_date: str = ""  # 退去日
    free_rent_detail: str = ""  # フリーレント詳細
    layout_detail: str = ""  # 間取り詳細
    preview_start_date: str = ""  # 内見開始日
    # 募集ステータス・WEBバッジ
    listing_status: str = ""  # 募集ステータス (例: "募集中", "申込あり")
    web_badge_count: int = -1  # WEB バッジカウント (-1=未取得, 0=なし, 1+=あり)
    needs_confirmation: bool = False  # 要物確・要確認フラグ
    floor_warning: str = ""  # 階数判定不能時の警告メッセージ
    sunlight_warning: str = ""  # 採光面判定不能時の警告メッセージ
    loft_warning: str = ""  # ロフト判定不能時の警告メッセージ
    equipment_warning: str = ""  # ソフト設備の不在アラート
    teiki_warning: str = ""  # 定期借家の警告メッセージ
    move_in_warning: str = ""  # 入居時期の警告メッセージ
    status_warning: str = ""  # ステータス関連の警告メッセージ

    def __post_init__(self) -> None:
        self.building_age = _normalize_building_age(self.building_age)
        self.move_in_date = _normalize_move_in_date(self.move_in_date)
