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
    equipment_ids: list[int] = field(default_factory=list)
    ad_reprint_only: bool = True
    deal_types: list[str] = field(default_factory=list)
    update_within_days: Optional[int] = None
    notes: str = ""  # その他ご希望（フリーテキスト）
    discord_thread_id: Optional[str] = None  # 既存スレッドID（あれば）


@dataclass
class Property:
    """物件1部屋分のデータ"""

    building_id: int
    room_id: int
    building_name: str
    address: str
    rent: int  # 円単位
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
