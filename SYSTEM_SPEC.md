# 賃貸物件自動検索・通知システム — システム仕様書

## 1. システム概要

お客さんの希望条件に合う賃貸物件を **itandi BB** から自動検索し、
管理者が **Discord** で確認・承認した後、**LINE** でお客さんに物件情報を送信するシステム。

### 全体フロー

```
お客さん (LINE)          管理者 (Discord / ブラウザ)           システム
    │                          │                              │
    │ ①「条件登録」/「条件変更」│                              │
    │─────────────────────────>│                              │
    │  LINE Bot 会話フロー     │                              │
    │  条件選択ページ (LIFF)   │                              │
    │                          │                              │
    │                          │        ② 定期実行 (cron)     │
    │                          │<─────────────────────────────│
    │                          │  itandi BB 検索              │
    │                          │  新着物件を Discord 通知      │
    │                          │                              │
    │                          │ ③ 承認リンクをクリック        │
    │                          │──────────────────────────────>│
    │                          │  プレビュー画面              │
    │                          │  画像選択・情報編集          │
    │                          │  「承認してLINE送信」         │
    │                          │                              │
    │ ④ LINE Flex Message 受信 │                              │
    │<─────────────────────────│──────────────────────────────│
    │  物件詳細ページリンク    │                              │
```

---

## 2. コンポーネント構成

| コンポーネント | 技術 | 役割 |
|---|---|---|
| **Python バックエンド** (`itandi_search/`) | Python 3.11 + Selenium | itandi BB 検索・スクレイピング |
| **GAS (Google Apps Script)** | JavaScript (V8) | LINE Bot・承認ワークフロー・管理ページ |
| **Google Sheets** | — | データストア（検索条件・物件データ・ユーザー情報） |
| **GitHub Actions** | CI/CD | 定期実行 (ネイティブ cron スケジュール) |
| **Discord Webhook** | Forum チャンネル | 管理者への新着通知・承認リンク |
| **LINE Messaging API** | — | お客さんとのやり取り・物件送信 |
| **GitHub Pages** | 静的 HTML | お客さん向け物件詳細ページ (`property.html`) |

---

## 3. Google Sheets 構成

スプレッドシート ID: `1u6NHowKJNqZm_Qv-MQQEDzMWjPOJfJiX1yhaO4Wj6lY`

### 3.1 検索条件シート (`検索条件`)

お客さんごとの物件検索条件。LINE Bot の条件登録フロー、または管理者の手動入力で作成される。

**更新動作:** 同一顧客名の条件を変更（再登録）すると、既存行を削除してから新しい行を追記する（upsert 方式）。これにより、同一顧客に対して常に1行のみ存在し、重複検索を防止する。

| 列 | 内容 | 例 | 備考 |
|---|---|---|---|
| A | タイムスタンプ | 2026/03/04 12:00:00 | 空でも可 |
| B | お客様名 | 山田太郎 | **必須** — LINE Users と一致 |
| C | 都道府県 | 東京都 | **必須** |
| D | 市区町村 | 渋谷区,新宿区 | カンマ区切り |
| E | 路線 | 山手線,中央線 | 参考情報（検索には不使用） |
| F | 駅名 | 渋谷,新宿,池袋 | カンマ区切り |
| G | 駅徒歩(分) | 15 | |
| H | 賃料上限(万円) | 12 | |
| I | 間取り | 1K,1DK,1LDK | カンマ区切り |
| J | 専有面積下限(m²) | 25 | |
| K | 築年数 | 20 | 「新築」→ 1 |
| L | 構造 | 鉄筋系,鉄骨系 | カンマ区切り（グループ展開対応） |
| M | 設備・こだわり | オートロック,2階以上,南向き | カンマ区切り |
| N | 理由 | 転勤 | 参考情報 |
| O | 引越し時期 | 4月中旬 | **入居時期チェックに使用** |
| P | 備考 | — | 参考情報 |
| Q | ペット | 犬 | 参考情報 |
| R | 居住者 | ご自身のみ | LINE Bot 居住者ステップで入力 |

### 3.2 承認待ち物件シート (`承認待ち物件`)

Python が新着物件を書き込み、GAS の承認フローで処理される。

| 列 | 内容 | 備考 |
|---|---|---|
| A | customer_name | 検索条件の B 列と一致 |
| B | building_id | itandi BB の建物 ID |
| C | room_id | itandi BB の部屋 ID |
| D | building_name | 物件名 |
| E | rent | 賃料（円） |
| F | management_fee | 管理費（円） |
| G | layout | 間取り |
| H | area | 面積 (m²) |
| I | station_info | 最寄り駅 |
| J | property_data_json | 全詳細情報の JSON |
| K | status | `pending` → `sent` / `skipped` |
| L | created_at | 作成日時 |
| M | updated_at | 更新日時 |

**J 列 JSON の主要フィールド:**
```
deposit, key_money, address, url, image_url, image_urls,
room_number, building_age, floor, story_text, other_stations,
move_in_date, floor_text, structure, total_units, lease_type,
contract_period, cancellation_notice, renewal_info, sunlight,
facilities, shikibiki, pet_deposit, free_rent, renewal_fee,
fire_insurance, renewal_admin_fee, guarantee_info, key_exchange_fee,
selected_image_urls (承認時に追加)
```

### 3.3 通知済み物件シート (`通知済み物件`)

LINE 送信済みの物件を記録（重複通知防止）。

| 列 | 内容 |
|---|---|
| A | customer_name |
| B | room_id |
| C | building_name |
| D | 送信日時 |

### 3.4 LINE Users シート (`LINE Users`)

LINE userId とお客さん名のマッピング。承認時の LINE 送信先特定に使用。

| 列 | 内容 |
|---|---|
| A | userId (LINE) |
| B | お客さん名 |

---

## 4. Python バックエンド (`itandi_search/`)

### 4.1 ファイル構成

```
itandi_search/
├── __main__.py    # エントリーポイント (python -m itandi_search.run)
├── config.py      # 環境変数・定数・マッピング辞書
├── models.py      # データクラス (CustomerCriteria, Property)
├── auth.py        # itandi BB ログイン (Selenium + OAuth2)
├── search.py      # 検索 API 呼び出し・詳細スクレイピング
├── sheets.py      # Google Sheets 読み書き
├── discord.py     # Discord Webhook 通知
└── run.py         # メインオーケストレーター
```

### 4.2 実行フロー (`run.py`)

```
1. Google Sheets 初期化
2. 検索条件シートから全顧客の条件を読み込み
3. 通知済み + 承認待ち物件の (customer_name, room_id) セットを取得
4. itandi BB にログイン (Selenium)
5. 各顧客について:
   a. itandi BB 検索 API で物件検索
   b. 通知済み・承認待ちを除外
   c. 各物件の詳細ページをスクレイピング（画像・設備・ステータス・WEBバッジ等）
   d. 後処理フィルター適用（ハードフィルター = 除外）:
      - **ステータス・WEBバッジフィルター** ← 最初に実行
      - 階数フィルター (2階以上 / 1階のみ / 最上階)
      - 南向きフィルター
      - ロフトNGフィルター
      - 定期借家フィルター
   e. ソフトチェック適用（アラートのみ、除外しない）:
      - ロフト必須チェック
      - ソフト設備チェック
      - **入居時期チェック**
      - **ステータス要確認チェック**
   f. 承認待ちシートに書き込み
   g. Discord に新着通知（承認リンク付き）
6. ブラウザセッション終了
```

### 4.3 認証 (`auth.py`)

**ItandiSession クラス:**
- Selenium (headless Chrome) で itandi BB にログイン
- OAuth2 Authorization Code フロー:
  1. `itandibb.com` → `itandi-accounts.com` にリダイレクト
  2. メール・パスワードでログイン
  3. コールバックで `itandibb.com` に戻る
- ログイン後、ブラウザの JavaScript コンテキストから API 呼び出し
  - `api_get(url)` / `api_post(url, payload)`
  - CSRF トークンをクッキーから取得

### 4.4 検索 (`search.py`)

**検索 API:**
- エンドポイント: `https://api.itandibb.com/api/internal/v4/rent_room_buildings/search`
- フィルター構文: `キー:演算子` (`:in`, `:gteq`, `:lteq`)

**API フィルターで指定するもの:**
| フィルター | キー | 例 |
|---|---|---|
| 都道府県 | `address:in` | `[13]` (東京都) |
| 市区町村 | `address:in` | `[13001, 13002]` |
| 駅 | `station:in` | `[station_id1, ...]` |
| 駅徒歩 | `walk:lteq` | `15` |
| 賃料上限 | `rent:lteq` | `120000` |
| 賃料下限 | `rent:gteq` | `80000` |
| 間取り | `layout:in` | `["1K", "1LDK"]` |
| 面積下限 | `area:gteq` | `25` |
| 築年数 | `built_date:gteq` | `"2006-01-01"` |
| 構造 | `structure_type:in` | `["rc", "src"]` |
| 設備（ハード） | `option_ids:in` | `[11010, 16010]` |

**駅名解決:**
- `resolve_station_ids(session, station_names, prefecture_id)`
- itandi API で駅名を検索し station_id を取得
- 同名駅の都道府県による絞り込み対応

**詳細スクレイピング (`fetch_room_details`):**
- 各物件の詳細ページに Selenium でアクセス
- 取得情報:
  - 全画像 URL (`property-images` ドメイン)
  - 所在階 (`floor_text`) / 階建て (`story_text`)
  - 構造 / 総戸数 / 主要採光面 / 設備・詳細
  - 入居可能時期 / 契約情報 / 費用関連
  - **募集ステータス** (`listing_status`): 申込あり / 成約 / 公開停止 / 契約済み / 募集中
  - **WEB バッジカウント** (`web_badge_count`): WEB問い合わせ数
  - **要確認フラグ** (`needs_confirmation`): 要物確 / 要確認

**ステータス・WEB バッジの取得方法:**
- **ステータス**: `document.body.innerText` から既知ステータス文字列を検索。具体的なステータスから優先検索（"申込あり" → "成約" → "公開停止" → "契約済み" → "募集中"）
- **要確認フラグ**: テキスト中の「要物確」「要確認」を検出
- **WEB バッジ**: 3段階のフォールバックで取得
  1. `.MuiBadge-badge` クラスの要素から "WEB" 親要素のバッジ数を取得
  2. "WEB" テキストを持つボタン/span の兄弟要素からバッジを探索
  3. `innerText` の `WEB\n数字` パターンで正規表現マッチ

### 4.5 後処理フィルター (`run.py`)

API だけでは正確にフィルターできない条件を、詳細スクレイピング後に適用する。

**フィルター実行順序:**
```
enrich_properties_with_images()  ← 詳細ページスクレイピング（画像・ステータス・WEBバッジ・設備等）
  ↓
┌─ ハードフィルター（条件に合わない物件を除外）─────────────────────┐
│ ① _filter_by_status()    ← 申込あり・WEBバッジで除外（全顧客共通）│
│ ② _filter_by_floor()     ← 階数条件で除外                        │
│ ③ _filter_by_sunlight()  ← 南向き条件で除外                      │
│ ④ _filter_by_loft()      ← ロフトNG条件で除外                    │
│ ⑤ _filter_by_teiki()     ← 定期借家条件で除外                    │
└────────────────────────────────────────────────────────────────────┘
  ↓
┌─ ソフトチェック（除外せず、Discord アラートのみ）─────────────────┐
│ ⑥ _check_loft_required()   ← ロフト必須チェック                  │
│ ⑦ _check_soft_equipment()  ← ソフト設備の存在チェック            │
│ ⑧ _check_move_in_date()    ← 入居時期チェック                    │
│ ⑨ _check_status_kakunin()  ← 募集中＋要確認チェック              │
└────────────────────────────────────────────────────────────────────┘
  ↓
承認待ちシート書き込み + Discord 通知
```

#### ステータス・WEB バッジフィルター（最初に実行）

物件の募集ステータスと WEB バッジカウントで除外する。全顧客共通（条件設定不要）。

| 条件 | 動作 |
|---|---|
| ステータスが「申込あり」 | 除外 |
| WEB バッジカウント ≥ 1 | 除外（WEB問い合わせがある = 他社が既に問い合わせ済み） |
| ステータスが「募集中」＋「要確認」/「要物確」 | 除外しない。Discord アラート表示（後段の `_check_status_kakunin()` で処理） |
| ステータス未取得（空文字） | 除外しない（保守的判定） |
| WEB バッジ未取得（-1） | 除外しない（保守的判定） |
| **お客様名に「テスト」を含む場合** | ルール1,2をスキップ（テスト用途） |

#### 階数フィルター

| 条件 | 動作 |
|---|---|
| 2階以上 (`min_floor=2`) | `floor_text` から階数を解析し、2階未満を除外 |
| 1階の物件 (`max_floor=1`) | `floor_text` から階数を解析し、1階以外を除外 |
| 最上階 (`top_floor_only`) | `floor_text` と `story_text` を比較し、最上階以外を除外 |
| 階数不明時 | 除外せず、Discord で黄色アラート表示 |

#### 南向きフィルター

| 条件 | 動作 |
|---|---|
| 南向き (`south_facing`) | `sunlight` に「南」を含むか判定 |
| 「南」を含む | 通過（南、南西、南東 等） |
| 「南」を含まない | 除外 |
| 採光面情報なし | 除外せず、Discord で黄色アラート表示 |

#### ロフトフィルター

| 条件 | `facilities` に「ロフト」あり | `facilities` に「ロフト」なし |
|---|---|---|
| **ロフトNG** (`no_loft`) | 除外 | 残す + 黄色アラート |
| **ロフト** (`require_loft`) | そのまま通過 | そのまま通過 + 黄色アラート |
| **どちらも未選択** | 何もしない | 何もしない |

#### 定期借家フィルター

| 条件 | 動作 |
|---|---|
| 定期借家を含まない (`no_teiki`) | `lease_type` に「定期」を含む物件を除外 |
| 「定期」を含む | 除外 |
| 「定期」を含まない（普通借家等） | 通過 |
| 契約区分情報なし | 除外せず、Discord で黄色アラート表示 |

#### ソフト設備フィルター（アラートのみ）

以下の設備は、API の `option_id:all_in` には含めず、詳細ページスクレイピング後の `facilities` テキストから存在を確認する。該当設備が `facilities` に見つからない場合は **除外せず** ⚠️ アラートを表示する。

| ID | 設備名 | facilities 内検索キーワード | 備考 |
|---|---|---|---|
| 11020 | 温水洗浄便座 | `温水洗浄便座` | |
| 11050 | 浴室乾燥機 | `浴室乾燥` | |
| 11060 | 独立洗面台 | `独立洗面` | |
| 12032 | コンロ2口以上 | `2口`, `3口` | |
| 13010 | エアコン付き | `エアコン` | |
| 16011 | TVモニタ付きインタホン | `モニター付`, `TVモニタ` | |
| 21020 | 宅配ボックス | `宅配ボックス`, `宅配BOX` | |
| 15021 | インターネット無料 | `インターネット無料`, `ネット無料` | |
| 14020 | シューズボックス | `シューズボックス`, `シューズBOX`, `シューズクローク` | |
| 90001 | 角部屋 | `角部屋`, `角住戸` | API option_id なし（仮ID） |
| 90002 | カウンターキッチン | `カウンターキッチン`, `対面キッチン`, `対面式キッチン` | API option_id なし（仮ID） |
| 90003 | フリーレント | `フリーレント` + `free_rent` フィールド | API フィルターなし（仮ID） |
| 12030 | ガスコンロ対応 | `ガスコンロ` | |
| 12020 | IHコンロ | `IHクッキング`, `IHコンロ`, `IH対応` | |
| 12010 | システムキッチン | `システムキッチン` | |
| 19070 | バルコニー付 | `バルコニー` | |
| 10020 | 都市ガス | `都市ガス` | |
| 10021 | プロパンガス | `プロパンガス`, `プロパン` | |
| 16030 | 防犯カメラ | `防犯カメラ` | |
| 22020 | 楽器相談可 | `楽器相談`, `楽器可` | |
| 14010 | 収納 | `収納`, `クローゼット`, `押入` | |
| 90004 | 敷地内ゴミ置場 | `ゴミ置場`, `ゴミ置き場`, `ゴミステーション`, `24時間ゴミ` | API option_id なし（仮ID） |
| 90005 | ルーフバルコニー付 | `ルーフバルコニー` | API option_id なし（仮ID） |
| 90006 | 専用庭 | `専用庭` | API option_id なし（仮ID） |
| 90007 | ルームシェア可 | `ルームシェア` | API option_id なし（仮ID） |
| 90008 | 高齢者歓迎 | `高齢者` | API option_id なし（仮ID） |

**動作:** 顧客がこれらの設備を選択した場合、API検索では条件に含めない（ヒット件数が増える）。詳細ページの設備情報に該当キーワードが見つからない場合、Discord 通知に `⚠️ 以下の設備が確認できませんでした: 温水洗浄便座, 宅配ボックス` のような黄色アラートを表示する。

**特殊ケース:**
- **フリーレント (90003):** `facilities` テキストに加え、`free_rent` フィールドも確認する。

#### 入居時期チェック（アラートのみ）

顧客が希望入居時期を設定している場合、物件の入居可能時期と比較してアラートを表示する。除外はしない。

**データソース:**
- 顧客の希望入居時期: 検索条件シート O列 (index 14) → `CustomerCriteria.move_in_date`
- 物件の入居可能時期: 詳細ページスクレイピング → `Property.move_in_date`

**日付パーサー (`_parse_move_in_date`):**
- 対応フォーマット: `"4月上旬"`, `"4月15日"`, `"2026年4月中旬"` 等
- `as_deadline=True`（顧客の期限）: 旬の末日を返す（上旬→10日, 中旬→20日, 下旬→月末）
- `as_deadline=False`（物件の開始日）: 旬の初日を返す（上旬→1日, 中旬→11日, 下旬→21日）
- 年未指定時: 今年 or 来年で最も近い未来の月を推定
- スキップ: `"いい物件見つかり次第"`, `"即入居可"`, `"即日"`, `"未定"` → 比較不要 (None)

**チェックロジック:**

| 物件の入居可能時期 | 動作 |
|---|---|
| 空文字 / `"即入居可"` / `"即日"` | スキップ（問題なし） |
| `"相談"` を含む | **即アラート**（日付比較できないが不確定のため） |
| 日付パース可能 & 顧客期限を超過 | アラート表示 |
| 日付パース可能 & 顧客期限以内 | 問題なし |

**アラート形式:** `⚠️ 4月中旬入居希望です。入居時期の確認が必要です`

#### ステータス要確認チェック（アラートのみ）

ステータスが「募集中」で「要物確」「要確認」フラグがある物件にアラートを表示する。除外はしない。

**アラート形式:** `⚠️ 募集中（要確認）: 物件確認が必要です`

### 4.6 構造タイプの展開

LINE フォームで選択されるグループ名を個別の API 値に変換:

| グループ名 | 展開先 | API 値 |
|---|---|---|
| 鉄筋系 | RC, SRC | `rc`, `src` |
| 鉄骨系 | 鉄骨造, 軽量鉄骨造 | `steel`, `lightweight_steel` |
| ブロック・その他 | ブロック | `block` |
| 木造 | 木造 | `wooden` |

### 4.7 設備の特殊処理

M 列の設備名のうち、itandi API の `option_id` に変換されるものと、後処理フィルターとして扱われるものがある。

**後処理として扱われるもの（`option_id` に変換しない）:**
- `2階以上` → `min_floor = 2`
- `1階の物件` → `max_floor = 1`
- `最上階` → `top_floor_only = True`
- `南向き` → `south_facing = True`
- `ロフトNG` → `no_loft = True`
- `ロフト` → `require_loft = True`
- `定期借家を含まない` → `no_teiki = True`

**独立APIパラメータとして扱われるもの:**
- `敷金なし` → `no_deposit = True` → API: `shikikin:eq = 0`
- `礼金なし` → `no_key_money = True` → API: `reikin:eq = 0`

**ハード設備 — itandi API `option_id:all_in` で厳密に除外:**

| option_id | config.py キー | LINE フォーム選択肢 |
|---|---|---|
| 11010 | バス・トイレ別 | バス・トイレ別 |
| 11040 | 追い焚き機能 / 追い焚き / 追い焚き風呂 | 追い焚き風呂 |
| 11080 | 室内洗濯機置き場 / 室内洗濯機置場 | 室内洗濯機置場 |
| 12033 | コンロ3口以上 | コンロ3口以上 |
| 13020 | 床暖房 | 床暖房 |
| 14012 | ウォークインクローゼット | ウォークインクローゼット |
| 16010 | オートロック | オートロック |
| 19010 | 家具付き / 家具家電付き | 家具家電付き |
| 19040 | エレベーター | エレベーター |
| 19090 | 駐輪場 / 駐輪場あり | 駐輪場あり |
| 22010 | ペット相談 / ペット可 / ペット相談可 | ペット相談可 |
| 22050 | 事務所可 / 事務所利用可 | 事務所利用可 |

**ソフト設備 — API除外せず、詳細ページで存在チェック → 不在時に ⚠️ アラート表示:**

| ID | config.py キー | LINE フォーム選択肢 | 備考 |
|---|---|---|---|
| 11020 | 温水洗浄便座 | 温水洗浄便座 | |
| 11050 | 浴室乾燥機 | 浴室乾燥機 | |
| 11060 | 独立洗面台 | 独立洗面台 | |
| 12032 | コンロ2口 / コンロ2口以上 / 2口以上コンロ | コンロ2口以上 | |
| 13010 | エアコン / エアコン付き | エアコン付き | |
| 14020 | シューズボックス | シューズボックス | |
| 15021 | インターネット無料 | インターネット無料 | |
| 16011 | モニター付きインターホン / TVモニタ付きインタホン | TVモニタ付きインタホン | |
| 21020 | 宅配ボックス | 宅配ボックス | |
| 90001 | 角部屋 | 角部屋 | API option_id なし（仮ID） |
| 90002 | カウンターキッチン | カウンターキッチン | API option_id なし（仮ID） |
| 90003 | フリーレント | フリーレント | API フィルターなし（仮ID） |

### 4.8 Discord 通知 (`discord.py`)

**通知形式:**
- Forum チャンネルの Webhook を使用
- 新規顧客: スレッドを自動作成（`thread_name: 🏠 {顧客名}`）
- 既存顧客: 既存スレッドに投稿
- 各物件を個別メッセージで送信（レート制限回避: 1秒間隔）

**メッセージ内容:**
```
**1. パークアクシス渋谷  301**
🔗 https://itandibb.com/...
💰 **12.5万円** (管理費: 0.8万円)
🏠 1LDK ｜ 📐 35.2m² ｜ 🏗 築5年
📍 渋谷区渋谷1-2-3
🚉 JR山手線 渋谷駅 徒歩5分
💴 敷金: 1ヶ月 / 礼金: 1ヶ月

```ansi
⚠️ 設備・詳細に「ロフト」の記載がありません（ロフトなしの確認が必要です）
⚠️ 以下の設備が確認できませんでした: 温水洗浄便座, 宅配ボックス
⚠️ 4月中旬入居希望です。入居時期の確認が必要です
⚠️ 募集中（要確認）: 物件確認が必要です
```

✅ [承認してLINE送信](GAS_URL?action=approve&customer=...&room_id=...)
```

**一括承認リンク:**
- 2件以上の場合、最後に全件一括承認リンクを追加

### 4.9 環境変数

| 変数名 | 用途 |
|---|---|
| `GOOGLE_SERVICE_ACCOUNT_JSON` | Google Sheets API 認証 |
| `SPREADSHEET_ID` | 対象スプレッドシート ID |
| `ITANDI_EMAIL` | itandi BB ログインメール |
| `ITANDI_PASSWORD` | itandi BB ログインパスワード |
| `DISCORD_WEBHOOK_URL` | Discord Forum チャンネル Webhook |
| `GAS_WEBAPP_URL` | GAS Web App URL（承認リンク用） |
| `FORCE_NOTIFY` | `1` で通知済みチェックをスキップ |

---

## 5. Google Apps Script (GAS)

### 5.1 ファイル構成

```
├── コード.js              # メインエントリーポイント (doPost / doGet)
├── Config.js              # 定数・ステップ定義
├── StateManager.js        # 会話状態管理
├── ConversationFlow.js    # LINE Bot 条件登録フロー
├── ExistingBot.js         # 既存ボット（申込・面積検索）
├── LineApi.js             # LINE Messaging API ラッパー
├── SheetWriter.js         # 検索条件シート書き込み・読み込み
├── PropertyApproval.js    # 物件承認ワークフロー
├── RouteSelectPage.html   # 条件選択 LIFF ページ
├── CityData.js            # 東京都 市区町村データ
├── StationData.js         # 路線・駅データ
├── RouteData.js           # 鉄道会社・路線グループ
└── appsscript.json        # GAS マニフェスト
```

### 5.2 LINE Bot 条件登録・条件変更フロー

#### 条件登録（新規）

```
友だち追加 → ウェルカムメッセージ
    │
「条件登録」入力
    │
  STEP_NAME        → お名前入力
    │
  STEP_REASON      → 理由選択 (転勤/就職/進学/結婚/同棲/更新/その他)
    │
  STEP_RESIDENT    → 居住者選択 (ご自身のみ/ご夫婦・パートナー/ご家族/お子様/ご両親/その他)
    │                  ※「その他」→ STEP_RESIDENT_CUSTOM（自由入力）
    │
  STEP_MOVE_IN_DATE → 引越し時期選択 (日付ピッカー / 期間選択)
    │
  STEP_CRITERIA_SELECT → LIFF ページで詳細条件選択
    │                      (路線/駅 or 市区町村、賃料、間取り、
    │                       面積、築年数、構造、設備・こだわり)
    │
  STEP_CONFIRM     → 確認メッセージ (Flex Message)
    │
  「登録する」      → シートに書き込み → 完了メッセージ
```

#### 条件変更（既存条件の修正）

```
「条件変更」入力
    │
  readLatestCriteria(userId)  → スプレッドシートから既存条件を読み込み
    │                            (LINE Users シートで userId → 顧客名を取得
    │                             → 検索条件シートから最新行を取得)
    │
  条件が見つからない場合 → 「まだ条件が登録されていません」メッセージ
    │
  条件が見つかった場合:
    state に既存条件をセット（name, reason, resident, move_in_date 等）
    │
  STEP_CRITERIA_SELECT → LIFF ページで条件変更
    │                      ※ 名前・理由・居住者・引越し時期の入力をスキップ
    │                      ※ 既存の選択値がプリセットされた状態で表示
    │
  STEP_CONFIRM     → 確認メッセージ (Flex Message)
    │
  「登録する」      → 既存行を削除 → 新しい行を追記 → 完了メッセージ
```

**関連関数:**
- `startChangeFlow(replyToken, userId)` (`ConversationFlow.js`): 条件変更フローの開始。既存条件を読み込み、CRITERIA_SELECT ステップに直接遷移。
- `readLatestCriteria(userId)` (`SheetWriter.js`): LINE userId からスプレッドシートの既存条件を読み込み、state 形式のオブジェクトに変換して返す。
- `writeToSheet(userId, state)` (`SheetWriter.js`): 同じ顧客名の既存行を削除してから新しい行を追記（upsert 方式）。

**会話状態管理 (`StateManager.js`):**
- `PropertiesService.getUserProperties()` でユーザーごとの状態を保存
- キー: `state_{userId}`
- 24時間タイムアウト（`CONVERSATION_TIMEOUT_MS`）

### 5.3 条件選択ページ (`RouteSelectPage.html`)

LIFF (LINE Front-end Framework) で LINE アプリ内に表示される Web ページ。

**機能:**
- **エリア選択**: 「路線・駅から選ぶ」 / 「市区町村から選ぶ」タブ切り替え
  - 路線: 鉄道会社ごとに折りたたみ表示 (JR, メトロ, 都営, 東急, 西武, 小田急, 京王)
  - 駅: 路線選択後にチェックボックス表示
  - 市区町村: 23区 + 26市 + 4町
- **物件条件**: スライダー / チェックボックス
  - 賃料上限 (5〜30万円)
  - 間取り (1R, 1K, 1DK, 1LDK, 2K, 2DK, 2LDK, 3K, 3DK, 3LDK, 4K以上)
  - 駅徒歩 (3〜20分)
  - 専有面積下限 (15〜50m²)
  - 築年数 (新築〜30年)
  - 建物構造 (鉄筋系, 鉄骨系, 木造, ブロック・その他)
- **こだわり条件**: チェックボックス
  - 室内設備: 室内洗濯機置場, **ロフト**, **ロフトNG**, 家具家電付き, エアコン付き, 床暖房
  - キッチン: 2口以上コンロ, 独立洗面台
  - バス・トイレ: バス・トイレ別, 追い焚き, 温水洗浄便座, 浴室乾燥機
  - セキュリティ: オートロック, モニター付きインターホン, 宅配ボックス
  - 建物・位置: **2階以上**, **1階の物件**, **最上階**, **南向き**
  - ペット: 犬OK / 猫OK / 犬猫両方OK / ペットNG

### 5.4 doGet ルーティング (`コード.js`)

| action パラメータ | 処理 | 対象者 |
|---|---|---|
| `status` | ヘルスチェック | — |
| `selectCriteria` | 条件選択 LIFF ページ | お客さん |
| `approve` | 単一物件 承認プレビュー | 管理者 |
| `approve_all` | 一括 承認プレビュー | 管理者 |
| `skip` | 物件スキップ | 管理者 |
| `confirm_approve` | 承認確定 → LINE送信 | 管理者 |
| `confirm_approve_all` | 一括承認確定 → LINE送信 | 管理者 |
| `view` | 物件詳細ページ (リダイレクト) | お客さん |
| `view_api` | 物件詳細 JSON API | property.html |
| `line_users` | LINE 友だち一覧ページ | 管理者 |
| `push` | 個別 LINE プッシュ | 管理者 |

### 5.5 承認ワークフロー (`PropertyApproval.js`)

**単一承認フロー:**
```
Discord 承認リンク → ?action=approve&customer=...&room_id=...
    │
    ├ 承認プレビュー画面表示
    │   - 物件情報（全フィールド編集可能）
    │   - 画像グリッド（チェックで選択/除外）
    │   - 「承認してLINE送信」ボタン
    │
    ├ google.script.run → confirmApproveFromClient()
    │   - 編集値をシートに反映
    │   - 選択画像を保存
    │   - LINE Flex Message を構築・送信
    │   - ステータスを "sent" に更新
    │   - 通知済みシートに追記
    │
    └ 完了画面
```

**一括承認フロー:**
```
Discord 一括承認リンク → ?action=approve_all&customer=...
    │
    ├ 一括プレビュー画面（全 pending 物件を一覧表示）
    │   - 各物件に「画像を見せる」チェック
    │   - 「全て承認してLINE送信」ボタン
    │
    ├ google.script.run → confirmApproveAllFromClient()
    │   - 各物件を順次 LINE 送信（500ms 間隔）
    │
    └ 完了画面
```

**LINE Flex Message (`buildPropertyFlex`):**
- バブル形式のリッチメッセージ
- ヒーロー画像（選択された最初の画像）
- 物件名・賃料・管理費
- 間取り・面積・築年数・階数・所在地・最寄り駅・敷金/礼金
- 「物件詳細を見る」ボタン → property.html へ

### 5.6 LINE 友だち一覧ページ

管理者が条件登録フロー未完了のお客さんを手動で LINE Users シートに登録するためのページ。

**URL:** `GAS_URL?action=line_users`

**機能:**
- LINE Messaging API の Get Followers IDs で全友だちを取得
- 各フォロワーのプロフィール（表示名・画像）を表示
- 最終やり取り時刻順にソート
- 登録済み: 「✓ 登録済み（顧客名）」表示
- 未登録: チェックボックス + 顧客名入力欄
- 名前で検索可能
- 選択した人を一括登録

### 5.7 GAS デプロイ情報

| 項目 | 値 |
|---|---|
| Script ID | `1IjXv_rfbn3bD1YBIbLX91EgODlJT3gh0_kPj3r_HQVRSsmhRyTfUP1Np` |
| デプロイコマンド | `npx clasp push && npx clasp deploy` |
| 公開範囲 | ANYONE_ANONYMOUS |
| LIFF ID | `2009257618-mx8s5Vuk` |

**デプロイ時の注意:**
- `clasp push` は全ファイルを丸ごと上書きするため、**必ず main ブランチの最新コードからデプロイすること**。古いブランチやworktreeからデプロイすると、他の変更が消える。
- `clasp deploy` は新しいデプロイメントを作成する。LINE Webhook は特定のデプロイメント URL を参照しているため、既存のデプロイメントを更新する必要がある。
- 推奨デプロイ方法: `gas_deploy.sh` スクリプト（Apps Script REST API を直接使用）
  ```
  bash gas_deploy.sh <GASソースファイルのディレクトリ>
  ```
  このスクリプトは、ファイルプッシュ → 新バージョン作成 → 全デプロイメント更新を一括で行う。
- 手動デプロイの場合:
  ```
  npx clasp push
  npx @google/clasp deployments  # 一覧表示
  # 各デプロイメント ID に対して:
  npx @google/clasp deploy -i <DEPLOYMENT_ID>
  ```

---

## 6. お客さん向け物件詳細ページ (`property.html`)

GitHub Pages でホスト: `https://form.ehomaki.com/property.html`

**2つのデータ取得方式:**
1. **ハッシュ方式（優先）**: URL の `#` 以降に Base64 エンコードされた JSON データ
   - GAS の `buildViewUrl()` が生成
   - API 不要で即時表示
2. **API 方式（フォールバック）**: `?customer=...&room_id=...` パラメータで GAS `view_api` を呼び出し

**表示内容:**
- 画像カルーセル（スワイプ対応）
- 物件名・賃料・管理費
- 基本情報: 間取り、面積、築年数、所在階、階建て、構造、総戸数、主要採光面、入居可能時期
- アクセス: 最寄り駅、他の最寄り駅、住所
- 費用: 敷引き、ペット敷金追加、更新料、火災保険、更新事務手数料、保証料、鍵交換費用
- 契約条件: 契約区分、契約期間、解約予告、更新/再契約可否、フリーレント
- 設備・詳細

---

## 7. GitHub Actions

### ワークフロー (`itandi_search.yml`)

**トリガー:**
- `schedule` (cron: `*/30 1-10 * * *`) ← 10:00〜19:30 JST、30分おき（21枠/日）
- `workflow_dispatch` ← GitHub UI からの手動実行（`force_notify` オプション）

**ランダムディレイ:**
- スケジュール実行時のみ、0〜25分のランダム遅延を挿入
- `sleep $((RANDOM % 1500))` でアクセスパターンを不規則化
- 手動実行時（`workflow_dispatch`）はスキップ

**実行環境:**
- `ubuntu-latest`
- Python 3.11
- Chrome (stable)
- タイムアウト: 40分（ランダムディレイ最大25分 + 実行時間を考慮）

**ステップ:**
1. `actions/checkout@v4`
2. ランダムディレイ（スケジュール実行時のみ）
3. `actions/setup-python@v5` (3.11)
4. `browser-actions/setup-chrome@v1`
5. `pip install -r requirements.txt`
6. `python -m itandi_search.run`

**Secrets:**
| シークレット | 用途 |
|---|---|
| `GOOGLE_SERVICE_ACCOUNT_JSON` | Google Sheets API 認証 |
| `SPREADSHEET_ID` | スプレッドシート ID |
| `ITANDI_EMAIL` | itandi BB ログイン |
| `ITANDI_PASSWORD` | itandi BB ログイン |
| `DISCORD_WEBHOOK_URL` | Discord 通知 |
| `GAS_WEBAPP_URL` | GAS Web App エンドポイント |

---

## 8. データモデル

### 8.1 CustomerCriteria（検索条件）

```python
@dataclass
class CustomerCriteria:
    name: str                          # 顧客名
    prefecture: str                    # 都道府県
    cities: list[str]                  # 市区町村リスト
    stations: list[str]                # 駅名リスト
    walk_minutes: int | None           # 駅徒歩（分）
    rent_min: int | None               # 賃料下限（円）
    rent_max: int | None               # 賃料上限（円）
    layouts: list[str]                 # 間取りリスト
    area_min: float | None             # 面積下限 (m²)
    area_max: float | None             # 面積上限 (m²)
    building_age: int | None           # 築年数
    building_types: list[str]          # 建物種別
    structure_types: list[str]         # 構造タイプ（API値）
    min_floor: int | None              # 最低階数
    max_floor: int | None              # 最高階数
    top_floor_only: bool               # 最上階のみ
    south_facing: bool                 # 南向きのみ
    no_loft: bool                      # ロフトNG
    require_loft: bool                 # ロフト必須
    no_deposit: bool                   # 敷金なし（API: shikikin:eq=0）
    no_key_money: bool                 # 礼金なし（API: reikin:eq=0）
    no_teiki: bool                     # 定期借家を含まない（後処理フィルター）
    equipment_ids: list[int]           # ハード設備 option_id リスト（API除外用）
    soft_equipment_ids: list[int]      # ソフト設備 ID リスト（アラート用、仮ID含む）
    discord_thread_id: str | None      # Discord スレッド ID
    move_in_date: str                  # 引越し時期（顧客の希望入居時期、O列）
```

### 8.2 Property（物件データ）

```python
@dataclass
class Property:
    # ── 基本情報（検索結果から取得）──
    building_id: int                   # 建物 ID
    room_id: int                       # 部屋 ID
    building_name: str                 # 物件名
    address: str                       # 住所
    rent: int                          # 賃料（円）
    management_fee: int                # 管理費（円）
    deposit: str                       # 敷金
    key_money: str                     # 礼金
    layout: str                        # 間取り
    area: float                        # 面積 (m²)
    floor: int                         # 階数
    building_age: str                  # 築年数
    station_info: str                  # 最寄り駅
    room_number: str                   # 部屋番号
    url: str                           # itandi BB URL
    image_url: str | None              # メイン画像 URL
    image_urls: list[str]              # 全画像 URL

    # ── 詳細情報（詳細ページスクレイピングから取得）──
    story_text: str                    # 階建て ("地上10階建")
    other_stations: list[str]          # 他の最寄り駅
    move_in_date: str                  # 入居可能時期
    floor_text: str                    # 所在階テキスト ("5階")
    structure: str                     # 構造
    total_units: str                   # 総戸数
    lease_type: str                    # 賃貸借契約区分
    contract_period: str               # 契約期間
    cancellation_notice: str           # 解約予告
    renewal_info: str                  # 更新・再契約可否
    sunlight: str                      # 主要採光面
    facilities: str                    # 設備・詳細
    shikibiki: str                     # 敷引き償却
    pet_deposit: str                   # ペット飼育時敷金追加
    free_rent: str                     # フリーレント
    renewal_fee: str                   # 更新料
    fire_insurance: str                # 火災保険料
    renewal_admin_fee: str             # 更新事務手数料
    guarantee_info: str                # 保証情報
    key_exchange_fee: str              # 鍵交換費用

    # ── 募集ステータス・WEBバッジ（詳細ページスクレイピングから取得）──
    listing_status: str                # 募集ステータス ("募集中", "申込あり", "成約" 等)
    web_badge_count: int               # WEB バッジカウント (-1=未取得, 0=なし, 1+=あり)
    needs_confirmation: bool           # 要物確・要確認フラグ

    # ── 警告メッセージ（後処理フィルターで設定）──
    floor_warning: str                 # 階数判定不能時
    sunlight_warning: str              # 採光面判定不能時
    loft_warning: str                  # ロフト判定不能時
    teiki_warning: str                 # 定期借家判定不能時
    equipment_warning: str             # ソフト設備不在アラート
    move_in_warning: str               # 入居時期超過アラート
    status_warning: str                # ステータス要確認アラート
```

---

## 9. 外部サービス連携

### 9.1 itandi BB

| 項目 | 値 |
|---|---|
| ログインページ | `https://itandi-accounts.com/login` |
| 検索 API | `https://api.itandibb.com/api/internal/v4/rent_room_buildings/search` |
| 物件ページ | `https://itandibb.com` |
| 認証方式 | OAuth2 + Cookie ベースセッション |

### 9.2 LINE Messaging API

| 項目 | 値 |
|---|---|
| Reply API | `https://api.line.me/v2/bot/message/reply` |
| Push API | `https://api.line.me/v2/bot/message/push` |
| Followers API | `https://api.line.me/v2/bot/followers/ids` |
| Profile API | `https://api.line.me/v2/bot/profile/{userId}` |
| 認証 | Bearer トークン (`CHANNEL_ACCESS_TOKEN`) |

### 9.3 Discord

| 項目 | 値 |
|---|---|
| 送信方式 | Webhook (Forum チャンネル) |
| スレッド作成 | `?wait=true` + `thread_name` |
| スレッド投稿 | `?thread_id={id}` |
| レート制限 | 429 レスポンス時に `retry_after` 秒待機 |

### 9.4 Google Sheets API

| 項目 | 値 |
|---|---|
| 認証 | サービスアカウント (JSON キー) |
| スコープ | `https://www.googleapis.com/auth/spreadsheets` |

---

## 10. 重複排除の仕組み

同じ物件を同じお客さんに二重通知しないための仕組み:

```
通知済みセット = load_seen_properties()      # 通知済みシートから
承認待ちセット = load_pending_properties()    # 承認待ちシートから
除外セット = 通知済みセット ∪ 承認待ちセット

各物件について:
  if (顧客名, room_id) ∈ 除外セット:
    スキップ
  else:
    承認待ちシートに書き込み + Discord 通知
    除外セットに追加（同一実行内の重複防止）
```

`FORCE_NOTIFY=1` 環境変数で通知済みチェックをスキップ可能（テスト用）。

---

## 11. エラーハンドリング

| 箇所 | エラー | 処理 |
|---|---|---|
| Google Sheets 初期化 | 認証失敗 | FATAL → 終了 |
| 検索条件読み込み | シート読み込み失敗 | FATAL → 終了 |
| itandi BB ログイン | 認証失敗 | FATAL → Discord エラー通知 → 終了 |
| 物件検索 | API エラー | ERROR → Discord エラー通知 → 次の顧客へ |
| 画像取得 | スクレイピング失敗 | WARN → 画像なしで続行 |
| Discord 送信 | 429 レート制限 | `retry_after` 秒待機 → リトライ |
| Discord 送信 | その他のエラー | ERROR ログ → 続行 |
| シート書き込み | 書き込み失敗 | ERROR ログ → 続行 |
| LINE 送信 (GAS) | ユーザー未登録 | エラー画面表示 |
