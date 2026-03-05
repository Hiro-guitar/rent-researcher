"""定数、環境変数、マッピング辞書"""

import os

# ── 環境変数（GitHub Secrets） ──────────────────────────
GOOGLE_SERVICE_ACCOUNT_JSON = os.environ.get("GOOGLE_SERVICE_ACCOUNT_JSON", "")
ITANDI_EMAIL = os.environ.get("ITANDI_EMAIL", "")
ITANDI_PASSWORD = os.environ.get("ITANDI_PASSWORD", "")
SPREADSHEET_ID = os.environ.get("SPREADSHEET_ID", "")
DISCORD_WEBHOOK_URL = os.environ.get("DISCORD_WEBHOOK_URL", "")
GAS_WEBAPP_URL = os.environ.get("GAS_WEBAPP_URL", "")

# ── Google Sheets シート名 ─────────────────────────────
CRITERIA_SHEET = "検索条件"
CRITERIA_RANGE = "検索条件!A:Q"
SEEN_SHEET = "通知済み物件"
SEEN_RANGE = "通知済み物件!A:G"
PENDING_SHEET = "承認待ち物件"
PENDING_RANGE = "承認待ち物件!A:M"

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
EQUIPMENT_IDS: dict[str, int] = {
    # ── 水回り ──
    "バス・トイレ別": 11010,
    "温水洗浄便座": 11020,
    "追い焚き機能": 11040,
    "追い焚き": 11040,              # alias
    "追い焚き風呂": 11040,           # alias
    "浴室乾燥機": 11050,
    "独立洗面台": 11060,
    "室内洗濯機置き場": 11080,
    "室内洗濯機置場": 11080,          # alias（き無し表記）
    # ── キッチン ──
    "コンロ2口": 12032,
    "コンロ2口以上": 12032,          # alias
    "2口以上コンロ": 12032,          # alias
    "コンロ3口以上": 12033,
    # ── 冷暖房 ──
    "エアコン": 13010,
    "エアコン付き": 13010,           # alias
    # ── セキュリティ ──
    "オートロック": 16010,
    "モニター付きインターホン": 16011,
    "TVモニタ付きインタホン": 16011,  # alias
    # ── 冷暖房（追加） ──
    "床暖房": 13020,
    # ── 収納 ──
    "ウォークインクローゼット": 14012,
    "シューズボックス": 14020,
    # ── TV・通信 ──
    "インターネット無料": 15021,
    # ── その他設備 ──
    "宅配ボックス": 21020,
    "家具付き": 19010,
    "家具家電付き": 19010,           # alias
    "エレベーター": 19040,
    "駐輪場": 19090,
    "駐輪場あり": 19090,             # alias
    # ── 入居条件 ──
    "ペット相談": 22010,
    "ペット可": 22010,               # alias
    "ペット相談可": 22010,           # alias
    "事務所可": 22050,
    "事務所利用可": 22050,           # alias
}

# ── ソフト設備（アラートのみ、API除外しない） ──────────────
# これらの option_id は API の option_id:all_in に含めず、
# 詳細ページの設備テキストから存在チェック → 不在時に ⚠️ アラート表示
SOFT_EQUIPMENT_IDS: set[int] = {
    11020,  # 温水洗浄便座
    11050,  # 浴室乾燥機
    11060,  # 独立洗面台
    12032,  # コンロ2口以上
    13010,  # エアコン付き
    16011,  # TVモニタ付きインタホン
    21020,  # 宅配ボックス
    15021,  # インターネット無料
    14020,  # シューズボックス
    90001,  # 角部屋（API option_id なし — 内部用仮ID）
    90002,  # カウンターキッチン（API option_id なし — 内部用仮ID）
    90003,  # フリーレント（API フィルターなし — 内部用仮ID）
}

# ソフト設備の詳細ページ内検索キーワード（いずれかが facilities テキストに含まれれば OK）
SOFT_EQUIPMENT_SEARCH_TERMS: dict[int, list[str]] = {
    11020: ["温水洗浄便座"],
    11050: ["浴室乾燥"],
    11060: ["独立洗面"],
    12032: ["2口", "3口"],
    13010: ["エアコン"],
    16011: ["モニター付", "TVモニタ"],
    21020: ["宅配ボックス", "宅配BOX"],
    15021: ["インターネット無料", "ネット無料"],
    14020: ["シューズボックス", "シューズBOX", "シューズクローク"],
    90001: ["角部屋", "角住戸"],
    90002: ["カウンターキッチン", "対面キッチン", "対面式キッチン"],
    90003: ["フリーレント"],
}

# option_id → 日本語表示名（アラートメッセージ用）
EQUIPMENT_DISPLAY_NAMES: dict[int, str] = {
    11020: "温水洗浄便座",
    11050: "浴室乾燥機",
    11060: "独立洗面台",
    12032: "コンロ2口以上",
    13010: "エアコン付き",
    16011: "TVモニタ付きインタホン",
    21020: "宅配ボックス",
    15021: "インターネット無料",
    14020: "シューズボックス",
    90001: "角部屋",
    90002: "カウンターキッチン",
    90003: "フリーレント",
}

# ── API option_id を持たない設備の内部用仮IDマッピング ────
# M列の設備名 → 仮ID（SOFT_EQUIPMENT_IDS に含まれるため API に送信されない）
TEXT_ONLY_EQUIPMENT: dict[str, int] = {
    "角部屋": 90001,
    "カウンターキッチン": 90002,
    "フリーレント": 90003,
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
