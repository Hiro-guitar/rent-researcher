"""データクラス定義"""

from dataclasses import dataclass, field
from typing import Optional


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
    shikibiki: str = ""  # 敷引き償却
    pet_deposit: str = ""  # ペット飼育時敷金追加
    free_rent: str = ""  # フリーレント
    renewal_fee: str = ""  # 更新料
    fire_insurance: str = ""  # 火災保険料
    renewal_admin_fee: str = ""  # 更新事務手数料
    guarantee_info: str = ""  # 保証情報（利用必須 + 保証料等）
    key_exchange_fee: str = ""  # 鍵交換費用
    support_fee_24h: str = ""  # 24時間サポート費
    rights_fee: str = ""  # 権利金
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
