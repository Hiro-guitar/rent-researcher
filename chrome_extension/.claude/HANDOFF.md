# 物件自動取得 Chrome拡張 — セッション引き継ぎ資料

## プロジェクト概要
賃貸物件を4つの業者間サイト（REINS・いえらぶBB・itandi BB・ES-Square）から自動取得し、顧客の希望条件でフィルタして Discord + GAS に送信する Chrome拡張（Manifest V3）。

**拡張のロード元**: `~/chrome_extension/` からローカル読み込み。デプロイ不要、拡張再読み込みで反映。

---

## ファイル構成

### コア
| ファイル | 行数 | 役割 |
|---------|------|------|
| `manifest.json` | - | 拡張定義。Service Worker, content scripts, permissions |
| `background.js` | ~3900行 | **メインオーケストレーター**。検索サイクル・GAS連携・Discord通知・フィルタ・REINS自動操作 |
| `log.html` / `log.js` | - | ダッシュボードUI。ログ表示・サービスON/OFF・顧客選択・検索実行ボタン |
| `options.html` / `options.js` | - | 設定画面。GAS URL・Discord webhook・検索間隔等 |
| `popup.html` / `popup.js` | - | 簡易ポップアップ（ほぼ使わない） |

### サービス別 background（`importScripts` で background.js に読み込まれる）
| ファイル | 役割 |
|---------|------|
| `ielove-background.js` (~1080行) | いえらぶBB検索オーケストレーション |
| `itandi-background.js` (~1180行) | itandi BB検索（API経由） |
| `essquare-background.js` (~1620行) | ES-Square検索オーケストレーション |

### サービス別 content script（各サイトのページに注入）
| ファイル | 対象URL | 役割 |
|---------|---------|------|
| `content-search.js` | `system.reins.jp/*` | REINS検索結果のDOM解析・ページ遷移 |
| `content-detail.js` | `system.reins.jp/*/GBK003200*` | REINS物件詳細の抽出 |
| `ielove-content-search.js` | `bb.ielove.jp/*/rent/index/*` | いえらぶ検索結果のDOM解析 |
| `ielove-content-detail.js` | `bb.ielove.jp/*/rent/detail/*` | いえらぶ物件詳細の抽出 |
| `itandi-content-detail.js` | `itandibb.com/rent_rooms/*` | itandi物件詳細の抽出 |
| `essquare-content-detail.js` | `rent.es-square.net/*/detail/*` | ES-Square物件詳細の抽出 |
| `reins-timer-polyfill.js` | `system.reins.jp/*` (MAIN world) | Vue用タイマーポリフィル |

### 設定ファイル（駅コード・市区町村コード等の静的マッピング）
| ファイル | 内容 |
|---------|------|
| `ielove-config.js` | いえらぶの駅コード・市区町村コード |
| `ielove-oaza-config.js` | いえらぶの大字コード（町名レベル） |
| `itandi-config.js` | itandiの都道府県・構造・間取りマッピング |
| `essquare-config.js` | ES-Squareの駅コード・市区町村コード・間取りマッピング |
| `lineNameMap.json` | REINS路線名の正規化マッピング |
| `reinsCodeMap.json` | REINS路線コード |
| `ieloveStationCodes.json` | いえらぶ駅コードデータ |

---

## アーキテクチャ

```
background.js (Service Worker / メインオーケストレーター)
├── importScripts: ielove-config.js, ielove-oaza-config.js, ielove-background.js
├── importScripts: itandi-config.js, itandi-background.js
├── importScripts: essquare-config.js, essquare-background.js
│
├── runSearchCycle()          ← メイン検索ループ
│   ├── refreshCriteria()     ← GASから顧客条件取得
│   ├── fetchSeenIds()        ← 既知物件ID取得
│   └── for each customer:
│       ├── itandi:   searchItandi(tabId, customer, seenIds, searchId)
│       ├── essquare: searchEssquare(tabId, customer, seenIds, searchId)
│       ├── ielove:   searchIelove(tabId, customer, seenIds, searchId)
│       └── reins:    (background.js内で直接実装)
│
├── sendDiscordNotification()     ← 物件をDiscordスレッドに送信
├── sendDiscordNoResultNotification() ← 新着なし通知
├── getFilterRejectReason()       ← 物件フィルタ（全サービス共通）
├── submitProperties()            ← GASに物件送信
└── setupAlarm() / chrome.alarms  ← 自動検索スケジューリング
```

### background.js がエクスポートするグローバル関数（各モジュールが使用）
- `sleep(ms)`, `getStorageData(keys)`, `setStorageData(data)`
- `gasGet(action, params)`, `gasPost(body)`
- `waitForDomReady(tabId, selector, opts)`
- `getFilterRejectReason(prop, customer)` — 物件フィルタ判定
- `logError(msg)`, `isSearchCancelled(searchId)`
- `hashRoomId(source, rawId)` — SHA-256ハッシュ化

---

## 検索サイクルの流れ

1. **トリガー**: chrome.alarms（自動）/ "今すぐ検索"ボタン（手動）
2. **GASから条件取得**: `refreshCriteria()` → `customerCriteria` 配列
3. **除外顧客フィルタ**: `excludedCustomers` に入っている顧客をスキップ
4. **顧客ごとにループ**:
   - 有効なサービスそれぞれで検索実行
   - 各サービスは専用タブ（ログイン維持）を使用
   - 検索結果を取得 → フィルタ → Discord通知 → GAS送信
5. **バッチモード**: 重複排除後に一括通知（サービス優先度: itandi > ES-Square > いえらぶ > REINS）
6. **新着なし通知**: `discordPropertyCounters` が0の顧客に通知

---

## 各サービスの技術的特徴

### REINS
- **Vue 2 SPA**。条件セットは `$data` 直接代入（MAIN world scriptタグ注入）
- 検索実行・OKダイアログは**DOMクリック**（JSからexecute()呼び出しは認証エラー）
- メニュー遷移は `$router.push()` 経由（URL直接遷移NG）
- 路線/市区町村は**最大3スロット**のみ → 町名フィルタはポストフィルタ
- 支線対応: 丸ノ内線方南支線、常磐線快速/各停、中央線快速/各停

### いえらぶBB
- DOM解析ベース（`table.estate_list` パース）
- 大字コードで町名検索、**丁目はサポートしない** → ポストフィルタで丁目照合
- 2回目検索（既知物件）は丁目照合をスキップ

### itandi BB
- **API経由**（ページコンテキストからfetch、CSRF必要）
- `bucket_size` 上限 **99**（100だと400エラー）
- 駅IDは `resolveItandiStationIds()` でAPI検索 → `[...new Set(allIds)]` で重複排除
- `jgdc_codes` で町名フィルタリング

### ES-Square
- **URLパラメータ**ベースの検索（フォーム操作不要）
- `jusho` パラメータ: `13+103+港南` 形式（丁目は非対応）
- **jusho上限50件** → チャンク分割 (`JUSHO_CHUNK_SIZE = 50`)

---

## Discord通知

- **顧客ごとにスレッド**を作成/再利用（`discordThreadIds` 永続化）
- 検索サイクルごとに最初の物件送信前に**検索条件を送信** (`buildSearchInfo`)
- 物件メッセージに通し番号付き、メンション付き
- **新着なし通知**: `sendDiscordNoResultNotification()` で検索条件＋「新着物件なし」を送信
- バッチモードでは重複排除後に一括送信

---

## GAS連携

```javascript
// GET: 条件取得
gasGet('get_criteria')  → { criteria: [...] }
gasGet('get_seen_ids')  → { seen_ids: { customerName: [id, ...] } }

// POST: 物件送信
gasPost({ action: 'add_reins_property', customer_name, properties, discord_thread_id, api_key })
```

---

## chrome.storage.local 主要キー

| キー | 型 | 説明 |
|-----|---|------|
| `gasWebappUrl` | string | GASデプロイURL |
| `gasApiKey` | string | GAS APIキー |
| `discordWebhookUrl` | string | Discord webhook URL |
| `discordThreadIds` | object | `{ 顧客名: threadId }` 永続 |
| `customerCriteria` | array | GASから取得した顧客条件配列 |
| `excludedCustomers` | array | 検索から除外する顧客名リスト |
| `enabledServices` | object | `{ reins, ielove, itandi, essquare }` |
| `autoSearchEnabled` | boolean | 自動検索ON/OFF |
| `searchIntervalMinutes` | number | 検索間隔（分） |
| `businessStartHour` / `businessEndHour` | number | 営業時間 |
| `jitterPercent` | number | 間隔ランダム化 ±% |
| `notifyMode` | string | `'immediate'` or `'batch'` |
| `isSearching` | boolean | 検索中フラグ |
| `debugLog` | string | ログバッファ（改行区切り） |
| `moshikomiSkipMap` | object | 申込あり物件の30日TTLキャッシュ |
| `{service}Skipped_{customer}` | object | サービス別スキップ済み物件 |

---

## ダッシュボード (log.html / log.js)

- **コントロールパネル**: ステータス表示、サービスON/OFF、顧客チェックボックス、検索ボタン
- **ログビューア**: タグ別色分け（REINS=青、いえらぶ=橙、itandi=紫、ES-Square=黄土）
- **フィルタ**: サービスタグ・テキスト検索
- **顧客チェックボックス**: 除外リスト方式（新規顧客は自動ON）

---

## フィルタ (`getFilterRejectReason`)

background.js 内の共通フィルタ。全サービスの物件に適用:
1. **町名フィルタ** (`selectedTowns`): 住所が指定町名に一致するか（正規化比較）
2. **賃料**: `rent + management_fee ≤ rent_max × 10000`
3. **面積**: `area ≥ area_min`
4. **間取り**: `layouts` に含まれるか
5. **築年数**: `building_age ≤ max`
6. **駅徒歩**: `walk ≤ max`
7. **構造**: `structures` に含まれるか
8. **申込あり**: `moshikomiSkipMap` でスキップ

---

## 重要な制約・注意事項

- **GASファイルは `nice-feistel` ワークツリーでのみ編集**。他ワークツリーでのGAS編集禁止
- **Chrome拡張の変更はデプロイ不要**。拡張を再読み込みすれば反映
- **数値の四捨五入禁止**（賃料・管理費等）
- **常に日本語で応答**
- コード変更後は毎回**コミット・プッシュ**まで一連で実行
- itandi API `bucket_size` は**最大99**
- ES-Square `jusho` は**最大50件**（チャンク分割必要）
- REINSは**最大3スロット**（町名はポストフィルタのみ）

---

## 顧客条件オブジェクト (CustomerCriteria) の主要フィールド

```javascript
{
  name: '顧客名',
  rent_max: 15,                    // 万円
  area_min: 25,                    // ㎡
  layouts: ['1K', '1DK', '1LDK'], // 間取り
  building_age: 20,                // 築年数上限
  walk: 10,                        // 駅徒歩（分）
  structures: ['RC', 'SRC'],       // 構造
  equipment: 'BT別,オートロック',    // 設備条件（カンマ区切り）
  prefecture: '東京都',
  cities: ['港区', '渋谷区'],       // 市区町村
  stations: ['新宿', '渋谷'],       // 駅名（旧形式）
  routes_with_stations: [           // 路線+駅（新形式）
    { route: 'JR山手線', stations: ['新宿', '渋谷'] },
    { route: '東京メトロ銀座線', stations: ['表参道'] }
  ],
  selectedTowns: {                  // 町名指定（丁目含む）
    '港区': ['芝浦1丁目', '芝浦2丁目', '港南3丁目'],
    '渋谷区': ['恵比寿南']
  }
}
```
