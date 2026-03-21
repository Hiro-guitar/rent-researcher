"""いえらぶBB 設定"""

import json
import os
from pathlib import Path

IELOVE_EMAIL: str = os.environ.get("IELOVE_EMAIL", "")
IELOVE_PASSWORD: str = os.environ.get("IELOVE_PASSWORD", "")
IELOVE_BASE_URL: str = "https://bb.ielove.jp"

# 都道府県コード
PREFECTURE_CODE: str = "13"  # 東京都

# ── 間取りコード (checkbox value) ──────────────────────

LAYOUT_CODES: dict[str, str] = {
    "1R": "1",
    "1K": "2",
    "1DK": "4",
    "1LDK": "8",
    "2K": "10",
    "2DK": "12",
    "2LDK": "16",
    "3K": "18",
    "3DK": "20",
    "3LDK": "24",
    "4K": "26",
    "4DK": "28",
    "4LDK": "32",
}

# ── 建物構造コード (select option value) ──────────────────

STRUCTURE_CODES: dict[str, str] = {
    "木造": "1",
    "ブロック": "2",
    "鉄骨造": "3",
    "RC": "4",
    "SRC": "5",
    "PC": "6",
    "HPC": "7",
    "軽量鉄骨": "8",
    "その他": "9",
    "ALC": "10",
}

# CustomerCriteria.structure_types からいえらぶコードへの変換
STRUCTURE_ALIAS: dict[str, str] = {
    "鉄筋コンクリート": "4",     # RC
    "鉄骨鉄筋コンクリート": "5", # SRC
    "鉄骨造": "3",
    "軽量鉄骨": "8",
    "木造": "1",
    "RC": "4",
    "SRC": "5",
}

# ── 築年数コード (URL パラメータ値) ────────────────────

BUILDING_AGE_CODES: dict[int, str] = {
    3: "3",
    5: "5",
    10: "10",
    15: "15",
    20: "20",
    25: "25",
    30: "30",
    35: "35",
}

# ── 駅コード・路線コード ────────────────────────────────
# scrape_station_codes.py で生成した JSON をロード

_STATION_FILE = Path(__file__).parent / "station_codes.json"

if _STATION_FILE.exists():
    with open(_STATION_FILE, encoding="utf-8") as _f:
        _data = json.load(_f)
    STATION_CODES: dict[str, str] = _data.get("station_codes", {})
    LINE_CODES: dict[str, str] = _data.get("line_codes", {})
else:
    STATION_CODES = {}
    LINE_CODES = {}
