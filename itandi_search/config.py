"""定数、環境変数、マッピング辞書"""

import os

# ── 環境変数（GitHub Secrets） ──────────────────────────
GOOGLE_SERVICE_ACCOUNT_JSON = os.environ.get("GOOGLE_SERVICE_ACCOUNT_JSON", "")
ITANDI_EMAIL = os.environ.get("ITANDI_EMAIL", "")
ITANDI_PASSWORD = os.environ.get("ITANDI_PASSWORD", "")
SPREADSHEET_ID = os.environ.get("SPREADSHEET_ID", "")
DISCORD_WEBHOOK_URL = os.environ.get("DISCORD_WEBHOOK_URL", "")

# ── Google Sheets シート名 ─────────────────────────────
CRITERIA_SHEET = "検索条件"
CRITERIA_RANGE = "検索条件!A:N"
SEEN_SHEET = "通知済み物件"
SEEN_RANGE = "通知済み物件!A:G"

# ── itandi BB URL ──────────────────────────────────────
ITANDI_LOGIN_PAGE_URL = "https://itandi-accounts.com/login"
ITANDI_LOGIN_POST_URL = "https://itandi-accounts.com/login"
ITANDI_SEARCH_URL = (
    "https://api.itandibb.com/api/internal/v4/rent_room_buildings/search"
)
ITANDI_BASE_URL = "https://itandibb.com"
ITANDI_CALLBACK_URL = "https://itandibb.com/itandi_accounts_callback"

# ── 都道府県 → prefecture_id マッピング ─────────────────
PREFECTURE_IDS: dict[str, int] = {
    "北海道": 1,
    "青森県": 2,
    "岩手県": 3,
    "宮城県": 4,
    "秋田県": 5,
    "山形県": 6,
    "福島県": 7,
    "茨城県": 8,
    "栃木県": 9,
    "群馬県": 10,
    "埼玉県": 11,
    "千葉県": 12,
    "東京都": 13,
    "神奈川県": 14,
    "新潟県": 15,
    "富山県": 16,
    "石川県": 17,
    "福井県": 18,
    "山梨県": 19,
    "長野県": 20,
    "岐阜県": 21,
    "静岡県": 22,
    "愛知県": 23,
    "三重県": 24,
    "滋賀県": 25,
    "京都府": 26,
    "大阪府": 27,
    "兵庫県": 28,
    "奈良県": 29,
    "和歌山県": 30,
    "鳥取県": 31,
    "島根県": 32,
    "岡山県": 33,
    "広島県": 34,
    "山口県": 35,
    "徳島県": 36,
    "香川県": 37,
    "愛媛県": 38,
    "高知県": 39,
    "福岡県": 40,
    "佐賀県": 41,
    "長崎県": 42,
    "熊本県": 43,
    "大分県": 44,
    "宮崎県": 45,
    "鹿児島県": 46,
    "沖縄県": 47,
}

# ── 設備名 → option_id マッピング ───────────────────────
# フォームの「こだわり条件」名称とitandi BB内部名の両方に対応
EQUIPMENT_IDS: dict[str, int] = {
    "バス・トイレ別": 11010,
    "エアコン": 11020,
    "エアコン付": 11020,
    "室内洗濯機置場": 11030,
    "独立洗面台": 11040,
    "2口以上コンロ": 11050,
    "追い焚き": 11060,
    "温水洗浄便座": 11070,
    "オートロック": 11080,
    "モニター付きインターホン": 11090,
    "宅配ボックス": 11100,
    "浴室乾燥機": 11110,
    "ペット可": 11120,
    "ペット相談": 11120,
}

# ── 間取りタイプ変換（SUUMO風 → API値） ──────────────────
LAYOUT_MAP: dict[str, str] = {
    "ワンルーム": "1R",
    "5K以上": "5K",
}

# ── 情報更新日 → 日数マッピング ─────────────────────────
UPDATE_DAYS_MAP: dict[str, int] = {
    "1日以内": 1,
    "3日以内": 3,
    "7日以内": 7,
    "14日以内": 14,
    "30日以内": 30,
}

# ── 構造タイプマッピング（日本語 → API 値） ──────────────
STRUCTURE_TYPE_MAP: dict[str, str] = {
    "木造": "wooden",
    "ブロック": "block",
    "鉄骨造": "steel",
    "軽量鉄骨造": "lightweight_steel",
    "RC": "rc",
    "SRC": "src",
    "PC": "pc",
    "HPC": "hpc",
    "ALC": "alc",
    "CFT": "cft",
}

# ── 建物種別マッピング（日本語 → API 値） ────────────────
BUILDING_TYPE_MAP: dict[str, str] = {
    "マンション": "mansion",
    "アパート": "apartment",
    "一戸建て": "detached_house",
    "テラスハウス": "terraced_house",
    "タウンハウス": "town_house",
    "シェアハウス": "share_house",
}
