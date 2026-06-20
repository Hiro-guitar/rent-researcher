/**
 * SuumoPatrol.gs — SUUMO自動巡回＆入稿管理
 *
 * 機能:
 *   1. 巡回検索条件のCRUD（SUUMO巡回条件シート）
 *   2. 候補物件の管理（SUUMO候補物件シート）
 *   3. 掲載管理（SUUMO掲載管理シート）
 *   4. 承認ページ表示
 *   5. Discord通知
 *
 * シート構成:
 *   SUUMO巡回条件: 条件ID | 条件名 | エリア情報JSON | 賃料下限 | 賃料上限 | 間取りJSON |
 *                  面積下限 | 築年数 | 有効フラグ | 作成日時 | 最終巡回日時
 *   SUUMO候補物件: 物件キー | 建物名 | 部屋番号 | 住所 | 賃料 | 管理費 | 間取り | 面積 |
 *                  最寄駅 | 検出日時 | ソース | ステータス | property_data_json |
 *                  画像ジャンルJSON | 巡回条件ID
 *   SUUMO掲載管理: 物件キー | 建物名 | 部屋番号 | 掲載開始日 | 賃料 | 最終PV数 |
 *                  最終問合数 | パフォーマンススコア | ステータス | 停止日
 */

// ── ヘッダー定義 ──────────────────────────────────────────

var SUUMO_PATROL_HEADERS = [
  '条件ID', '条件名', 'エリア情報JSON', '賃料下限', '賃料上限',
  '間取りJSON', '面積下限', '築年数', '有効', '作成日時', '最終巡回日時',
  '徒歩', '構造JSON', '設備JSON', '登録日数フィルタ'
];

var SUUMO_CANDIDATE_HEADERS = [
  '物件キー', '建物名', '部屋番号', '住所', '賃料', '管理費', '間取り', '面積',
  '最寄駅', '検出日時', 'ソース', 'ステータス', 'property_data_json',
  '画像ジャンルJSON', '巡回条件ID', 'SUUMO設備チェックJSON',
  'submittingTs', 'discordSentTs',
  // 巡回時の反響予測スコア (0-100、Chrome拡張 inquiry-score.js で算出)
  // 物件の本来の人気度を示し、停止候補判定で「競合多くても保護したい物件」を識別する
  '反響予測スコア'
];

// Discord通知済みカラムのインデックス（ヘッダー順変更時はここも更新）
var SUUMO_CANDIDATE_COL_DISCORD_SENT_TS = 18; // 1-indexed: 18列目 = 'discordSentTs'

// 未通知物件再送の対象期間（ms）。古すぎる物件は再送対象から外す。
var SUUMO_UNSENT_RETRY_WINDOW_MS = 24 * 60 * 60 * 1000; // 24時間

// submittingロックのタイムアウト（ミリ秒）
// キュー内で多数の物件を順次処理するとき、後ろの物件は入稿開始まで時間がかかるため
// 余裕を持って30分に設定（1件5分×6件までは確実にカバー）
var SUUMO_SUBMITTING_TIMEOUT_MS = 30 * 60 * 1000; // 30分

var SUUMO_LISTING_HEADERS = [
  '物件キー', '建物名', '部屋番号', '掲載開始日', '賃料', '最終PV数',
  '最終問合数', 'パフォーマンススコア', 'ステータス', '停止日',
  // ── 以下はSUUMOビジネス Daily Search連携(Phase 1)で追加 ──
  'suumo_property_code', '合計一覧PV', '合計詳細PV', '問い合わせ数',
  '掲載日数(SUUMO)', '競合_第1基準値', '競合_第2基準値', '競合_第3基準値',
  '危険度スコア', '最終取得日時',
  // 入稿時に候補物件シートから引き継いだ反響予測スコア (0-100)
  // findStopCandidates で「本来人気だけど競合に埋もれている物件」を保護するのに使う
  '反響予測スコア',
  // 22列目: 物件空室管理シート(PROPERTY_SHEET_ID)のK列「終了日」を初回検出した日。
  // 一度書き込んだら永続 (キャンセル等で空室管理側がクリアされても保持)。
  // findStopCandidates で「掲載開始 → 申込までの日数」を二乗減衰で人気度補正。
  '初回申込検知日',
  // 23列目: 危険度スコアの内訳 JSON (findStopCandidates 実行時に更新)。
  // {"comp":N,"inq":N,"score":N,"moshi":N,"resi":N,"long":N,"e45":N,"hi":N,"total":N}
  // 各物件がなぜそのスコアになったかを後から検証できるようにする。
  'スコア内訳',
  // ── 物件ポテンシャル順位 (反響予測スコアに代わる主要指標。1日1回 巡回時に更新) ──
  // 24列目: お客さんの「同条件・安い順」検索で自分が何番目か (重複広告は排除した実物件ベース)
  '現在の順位',
  // 25列目: 1ページ目(安い順top)に入るか。○=掲載価値あり / ×=埋もれ(圏外)
  '1ページ目内',
  // 26列目: 順位を最後に更新した日 (yyyy-MM-dd, JST)
  '順位更新日',
  // 27列目: 順位の根拠URL (同条件・賃料+管理費が安い順のSUUMO検索。クリックで目視確認)
  '順位URL',
  // 28列目: 母数 = 同条件・1ページ目の重複排除後の部屋数。
  // 「1位/1件(競合ゼロ=独占)」か「1位/30件(激戦区で最安=最強)」かの文脈が分かる。
  '母数(件数)'
];

// 停止候補ログシート (毎回の findStopCandidates 実行履歴を蓄積)
// Phase B (1〜2週後) でこれを分析して誤検知率を計測する。
var SUUMO_STOP_LOG_SHEET = 'SUUMO停止候補ログ';
var SUUMO_STOP_LOG_HEADERS = [
  '実行日時',
  'relaxLevel',
  '物件キー',
  '建物名',
  '部屋番号',
  '危険度スコア',
  'スコア内訳',
  '選出',
  '反響予測スコア',
  '問い合わせ数',
  '初回申込検知日',
  'シート掲載日数',
  '掲載日数(SUUMO)'
];

// 競合履歴シート (SUUMOビジネス取得毎に各物件のスナップショットを蓄積)
// updateSuumoListingStats から毎日 append。
// 30日以上溜まったら「直近7日平均 vs 14〜21日前7日平均」等のトレンド検知に使う (Phase B以降)。
// 90日で自動削除。
var SUUMO_COMPETITION_LOG_SHEET = 'SUUMO競合履歴';
var SUUMO_COMPETITION_LOG_HEADERS = [
  '取得日時',
  '物件キー',
  '建物名',
  '部屋番号',
  '競合_第1基準値',
  '競合_第2基準値',
  '競合_第3基準値',
  '合計一覧PV',
  '合計詳細PV',
  '問い合わせ数',
  '掲載日数(SUUMO)'
];
var SUUMO_COMPETITION_LOG_RETENTION_DAYS = 90;

// ── シートアクセスヘルパー ──────────────────────────────────

/**
 * 指定シートを取得（なければヘッダー付きで自動作成）
 */
function getSuumoSheet_(sheetName, headers) {
  var ss = SpreadsheetApp.openById(CRITERIA_SHEET_ID);
  var sheet = ss.getSheetByName(sheetName);
  if (!sheet) {
    sheet = ss.insertSheet(sheetName);
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    sheet.setFrozenRows(1);
  } else {
    // ヘッダー列数が不足している場合は自動拡張
    var currentHeaders = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    if (currentHeaders.length < headers.length) {
      var missing = headers.slice(currentHeaders.length);
      sheet.getRange(1, currentHeaders.length + 1, 1, missing.length).setValues([missing]);
    }
  }
  return sheet;
}

function getPatrolCriteriaSheet_() {
  return getSuumoSheet_(SUUMO_PATROL_CRITERIA_SHEET, SUUMO_PATROL_HEADERS);
}

function getCandidateSheet_() {
  return getSuumoSheet_(SUUMO_CANDIDATE_SHEET, SUUMO_CANDIDATE_HEADERS);
}

function getStopLogSheet_() {
  return getSuumoSheet_(SUUMO_STOP_LOG_SHEET, SUUMO_STOP_LOG_HEADERS);
}

function getCompetitionLogSheet_() {
  return getSuumoSheet_(SUUMO_COMPETITION_LOG_SHEET, SUUMO_COMPETITION_LOG_HEADERS);
}

/**
 * 競合履歴シートから 90日超のログを削除 (1日に1回くらい走る想定)。
 * 毎回 updateSuumoListingStats から呼ばれるが、内部でフラグを使って
 * 1日 1回だけ実行する。
 */
function _purgeOldCompetitionLogs_() {
  try {
    // 1日に1回だけ実行 (Script Properties でフラグ管理)
    var props = PropertiesService.getScriptProperties();
    var lastPurge = props.getProperty('SUUMO_COMP_LOG_LAST_PURGE');
    var today = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd');
    if (lastPurge === today) return;

    var sheet = getCompetitionLogSheet_();
    var lastRow = sheet.getLastRow();
    if (lastRow <= 1) {
      props.setProperty('SUUMO_COMP_LOG_LAST_PURGE', today);
      return;
    }
    var cutoff = new Date(Date.now() - SUUMO_COMPETITION_LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000);
    var data = sheet.getRange(2, 1, lastRow - 1, 1).getValues(); // 1列目: 取得日時
    var deletedCount = 0;
    // 後ろから削除 (削除中に行番号がズレないように)
    for (var i = data.length - 1; i >= 0; i--) {
      var ts = data[i][0];
      var d = (ts instanceof Date) ? ts : new Date(ts);
      if (!isNaN(d.getTime()) && d.getTime() < cutoff.getTime()) {
        sheet.deleteRow(i + 2);
        deletedCount++;
      }
    }
    props.setProperty('SUUMO_COMP_LOG_LAST_PURGE', today);
    if (deletedCount > 0) {
      Logger.log('競合履歴 90日超ログ削除: ' + deletedCount + '行');
    }
  } catch (e) {
    Logger.log('競合履歴 purge 失敗: ' + e.message);
  }
}

/**
 * 建物名+部屋番号でマッチング用のキーを生成。
 * 物件空室管理シート(PROPERTY_SHEET_ID) と SUUMO掲載管理シート(SUUMO_LISTING_SHEET)
 * の照合に使う。全角/半角・空白・大文字小文字の揺れを吸収する。
 */
function _normalizeBuildingRoomKey_(building, room) {
  var b = String(building || '')
    .replace(/[\s　]/g, '')   // 半角/全角スペース除去
    .toLowerCase();
  // 部屋番号は数字部分のみ抽出 (「101号室」 → 「101」)
  var r = String(room || '').replace(/[^0-9]/g, '');
  return b + '|' + r;
}

/**
 * 物件空室管理シート(PROPERTY_SHEET_ID/PROPERTY_SHEET_NAME) を読んで、
 * 「建物名+部屋番号 → K列の終了日(Date)」のマップを返す。
 * K列に値が無い (まだ申込検知されてない) 物件はマップに含めない。
 * findStopCandidates から呼ばれて、SUUMO掲載物件と突合する。
 */
/**
 * メンテナンス用: 物件空室管理シート(PROPERTY_SHEET_ID) のK列「終了日」を、
 * SUUMO掲載管理シートの 22列目「初回申込検知日」に一括反映する。
 * 既に値が入っている行は触らない (永続化のため)。
 * active な行のみが対象。
 *
 * GAS エディタの「関数を選択」プルダウンから手動実行する想定。
 */
function backfillInitialMoshikomiDates() {
  var sheet = getListingSheet_();
  var lastRow = sheet.getLastRow();
  if (lastRow <= 1) {
    Logger.log('backfill: 掲載管理シートが空');
    return { scanned: 0, updated: 0 };
  }

  var headerLen = SUUMO_LISTING_HEADERS.length;
  var data = sheet.getRange(2, 1, lastRow - 1, headerLen).getValues();
  var moshikomiColIdx = SUUMO_LISTING_HEADERS.indexOf('初回申込検知日') + 1;
  if (moshikomiColIdx <= 0) {
    Logger.log('backfill: 初回申込検知日列が見つからない');
    return { error: '初回申込検知日列が見つからない' };
  }

  var vacancyEndedMap = _buildVacancyEndedMap_();
  var mapKeyCount = Object.keys(vacancyEndedMap).length;
  Logger.log('backfill: 物件空室管理シートから ' + mapKeyCount + ' 件の終了日を取得');

  var updated = 0;
  var scanned = 0;
  var skippedAlreadyFilled = 0;
  var skippedNoMatch = 0;
  var updatedRows = [];

  for (var i = 0; i < data.length; i++) {
    if (data[i][8] !== 'active') continue;
    scanned++;

    var existing = data[i][moshikomiColIdx - 1];
    if (existing) {
      skippedAlreadyFilled++;
      continue;
    }

    var bldName = String(data[i][1] || '');
    var roomNo = String(data[i][2] || '');
    var vkey = _normalizeBuildingRoomKey_(bldName, roomNo);
    var foundEnded = vacancyEndedMap[vkey];
    if (!(foundEnded instanceof Date)) {
      skippedNoMatch++;
      continue;
    }

    sheet.getRange(i + 2, moshikomiColIdx).setValue(foundEnded);
    updated++;
    updatedRows.push(bldName + ' ' + roomNo + ' → ' +
                     Utilities.formatDate(foundEnded, 'Asia/Tokyo', 'yyyy-MM-dd HH:mm'));
  }

  Logger.log('backfill完了: scanned=' + scanned +
             ' updated=' + updated +
             ' skipAlreadyFilled=' + skippedAlreadyFilled +
             ' skipNoMatch=' + skippedNoMatch);
  if (updatedRows.length > 0) {
    Logger.log('更新した物件:\n  ' + updatedRows.join('\n  '));
  }
  return {
    scanned: scanned,
    updated: updated,
    skippedAlreadyFilled: skippedAlreadyFilled,
    skippedNoMatch: skippedNoMatch,
    updatedRows: updatedRows
  };
}

function _buildVacancyEndedMap_() {
  var map = {};
  try {
    var ss = SpreadsheetApp.openById(PROPERTY_SHEET_ID);
    var sheet = ss.getSheetByName(PROPERTY_SHEET_NAME);
    if (!sheet) return map;
    var lastRow = sheet.getLastRow();
    if (lastRow <= 1) return map;
    // A=物件名, B=部屋番号, K=終了日 (11列目まで読めば十分)
    var data = sheet.getRange(2, 1, lastRow - 1, 11).getValues();
    for (var i = 0; i < data.length; i++) {
      var building = String(data[i][0] || '').trim();
      if (!building) continue;
      var room = String(data[i][1] || '').trim();
      var endedRaw = data[i][10]; // K列 (0-indexed 10)
      var endedDate = null;
      if (endedRaw instanceof Date) {
        endedDate = endedRaw;
      } else if (endedRaw) {
        var dd = new Date(String(endedRaw));
        if (!isNaN(dd.getTime())) endedDate = dd;
      }
      if (!endedDate) continue;
      var key = _normalizeBuildingRoomKey_(building, room);
      // 既に同じキーで登録済みの場合、より古い日付を優先 (初回申込検知のため)
      if (!map[key] || endedDate.getTime() < map[key].getTime()) {
        map[key] = endedDate;
      }
    }
  } catch (e) {
    Logger.log('_buildVacancyEndedMap_ 取得失敗: ' + (e && e.message));
  }
  return map;
}

function getListingSheet_() {
  return getSuumoSheet_(SUUMO_LISTING_SHEET, SUUMO_LISTING_HEADERS);
}

// ═══════════════════════════════════════════════════════════
// 物件ポテンシャル順位 (1日1回 巡回時に掲載中物件の順位を更新)
// ═══════════════════════════════════════════════════════════

/**
 * POST: get_listed_for_rank
 * 掲載中(active)の物件を、順位再計算に必要なスペック付きで返す。
 * スペックは候補物件シートの property_data_json(13列目) から物件キーで引く。
 * @returns {success, properties:[{key, property}]}
 */
function handleGetListedForRank(json) {
  var sheet = getListingSheet_();
  var lastRow = sheet.getLastRow();
  if (lastRow <= 1) {
    return ContentService.createTextOutput(JSON.stringify({ success: true, properties: [] }))
      .setMimeType(ContentService.MimeType.JSON);
  }
  var data = sheet.getRange(2, 1, lastRow - 1, SUUMO_LISTING_HEADERS.length).getValues();

  // 候補シート: 物件キー → property_data_json
  var candSheet = getCandidateSheet_();
  var candMap = {};
  var cLast = candSheet.getLastRow();
  if (cLast > 1) {
    var cData = candSheet.getRange(2, 1, cLast - 1, SUUMO_CANDIDATE_HEADERS.length).getValues();
    for (var c = 0; c < cData.length; c++) {
      var ckey = cData[c][0];
      var pjson = cData[c][12]; // property_data_json
      if (ckey && pjson) candMap[ckey] = pjson;
    }
  }

  var props = [];
  for (var i = 0; i < data.length; i++) {
    if (data[i][8] !== 'active') continue; // 9列目: ステータス
    var key = data[i][0];
    var pjson = candMap[key];
    if (!pjson) continue; // specsが無い物件はスキップ
    var property;
    try { property = JSON.parse(pjson); } catch (e) { continue; }
    props.push({ key: key, property: property });
  }
  return ContentService.createTextOutput(JSON.stringify({ success: true, properties: props }))
    .setMimeType(ContentService.MimeType.JSON);
}

/**
 * POST: update_listing_rank
 * 掲載管理シートの該当行に現在の順位・1ページ目内・順位更新日を書き込む(上書き)。
 * @param json.updates [{key, rank, inPage1, sampleSize}]
 * @returns {success, updated}
 */
function handleUpdateListingRank(json) {
  var updates = (json && json.updates) || [];
  if (!updates.length) {
    return ContentService.createTextOutput(JSON.stringify({ success: true, updated: 0 }))
      .setMimeType(ContentService.MimeType.JSON);
  }
  var sheet = getListingSheet_();
  var lastRow = sheet.getLastRow();
  if (lastRow <= 1) {
    return ContentService.createTextOutput(JSON.stringify({ success: true, updated: 0 }))
      .setMimeType(ContentService.MimeType.JSON);
  }
  var rankCol = SUUMO_LISTING_HEADERS.indexOf('現在の順位') + 1;
  var pageCol = SUUMO_LISTING_HEADERS.indexOf('1ページ目内') + 1;
  var dateCol = SUUMO_LISTING_HEADERS.indexOf('順位更新日') + 1;
  var urlCol = SUUMO_LISTING_HEADERS.indexOf('順位URL') + 1;
  var sampleCol = SUUMO_LISTING_HEADERS.indexOf('母数(件数)') + 1;

  // 物件キー → 行番号
  var keyVals = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
  var keyRow = {};
  for (var i = 0; i < keyVals.length; i++) {
    if (keyVals[i][0]) keyRow[keyVals[i][0]] = i + 2;
  }

  var today = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd');
  var updated = 0;
  for (var u = 0; u < updates.length; u++) {
    var up = updates[u] || {};
    var row = keyRow[up.key];
    if (!row) continue;
    sheet.getRange(row, rankCol).setValue(up.rank);
    sheet.getRange(row, pageCol).setValue(up.inPage1 ? '○' : '×');
    sheet.getRange(row, dateCol).setValue(today);
    if (up.searchUrl) sheet.getRange(row, urlCol).setValue(up.searchUrl);
    if (up.sampleSize != null) sheet.getRange(row, sampleCol).setValue(up.sampleSize);
    updated++;
  }
  return ContentService.createTextOutput(JSON.stringify({ success: true, updated: updated }))
    .setMimeType(ContentService.MimeType.JSON);
}

// ═══════════════════════════════════════════════════════════
// 1. 巡回検索条件 CRUD
// ═══════════════════════════════════════════════════════════

/**
 * 全巡回条件を取得（Chrome拡張・AdminPage用）
 */
function getPatrolCriteria() {
  var sheet = getPatrolCriteriaSheet_();
  var lastRow = sheet.getLastRow();
  if (lastRow <= 1) return [];

  var data = sheet.getRange(2, 1, lastRow - 1, SUUMO_PATROL_HEADERS.length).getValues();
  var result = [];
  for (var i = 0; i < data.length; i++) {
    // Date オブジェクトを文字列に変換（google.script.run がシリアライズできないため）
    var createdAt = data[i][9];
    if (createdAt instanceof Date) {
      createdAt = Utilities.formatDate(createdAt, 'Asia/Tokyo', 'yyyy-MM-dd HH:mm:ss');
    } else {
      createdAt = String(createdAt || '');
    }
    var lastPatrolAt = data[i][10];
    if (lastPatrolAt instanceof Date) {
      lastPatrolAt = Utilities.formatDate(lastPatrolAt, 'Asia/Tokyo', 'yyyy-MM-dd HH:mm:ss');
    } else {
      lastPatrolAt = String(lastPatrolAt || '');
    }

    result.push({
      id: String(data[i][0] || ''),
      name: String(data[i][1] || ''),
      areaJson: String(data[i][2] || '{}'),
      rentMin: String(data[i][3] || ''),
      rentMax: String(data[i][4] || ''),
      layoutsJson: String(data[i][5] || '[]'),
      areaMin: String(data[i][6] || ''),
      buildingAge: String(data[i][7] || ''),
      enabled: data[i][8] === true || data[i][8] === 'TRUE' || String(data[i][8]).toUpperCase() === 'TRUE',
      createdAt: createdAt,
      lastPatrolAt: lastPatrolAt,
      walk: String(data[i][11] || ''),
      structuresJson: String(data[i][12] || '[]'),
      equipmentJson: String(data[i][13] || '[]'),
      // daysWithin はダッシュボード側で一元管理するため返さない。
      // 旧シート列(14)に値が残っていても Chrome 拡張は無視する。
      rowIndex: i + 2
    });
  }
  return result;
}

/**
 * 有効な巡回条件のみ取得（Chrome拡張の巡回用）
 */
function getActivePatrolCriteria() {
  return getPatrolCriteria().filter(function(c) { return c.enabled; });
}

/**
 * 巡回条件を保存（新規 or 更新）
 * @param {Object} data - { id?, name, area, rentMin, rentMax, layouts, areaMin, buildingAge }
 */
function savePatrolCriteria(data) {
  var sheet = getPatrolCriteriaSheet_();
  var now = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd HH:mm:ss');

  // 部分更新対応: data に明示的にキーがあれば上書き、無ければ既存値を維持
  // (toggleEnabled が {id, enabled} だけ送るケースで、area/layouts等が空で
  //  上書きされて条件が消えるバグを回避)
  if (data.id) {
    var criteria = getPatrolCriteria();
    for (var i = 0; i < criteria.length; i++) {
      if (criteria[i].id === data.id) {
        var existing = criteria[i];
        var row = existing.rowIndex;

        var newName = data.name !== undefined ? data.name : existing.name;
        var newAreaJson = data.area !== undefined
          ? (typeof data.area === 'string' ? data.area : JSON.stringify(data.area || {}))
          : existing.areaJson;
        var newRentMin = data.rentMin !== undefined ? data.rentMin : existing.rentMin;
        var newRentMax = data.rentMax !== undefined ? data.rentMax : existing.rentMax;
        var newLayoutsJson = data.layouts !== undefined
          ? (typeof data.layouts === 'string' ? data.layouts : JSON.stringify(data.layouts || []))
          : existing.layoutsJson;
        var newAreaMin = data.areaMin !== undefined ? data.areaMin : existing.areaMin;
        var newBuildingAge = data.buildingAge !== undefined ? data.buildingAge : existing.buildingAge;
        var newWalk = data.walk !== undefined ? data.walk : existing.walk;
        var newStructuresJson = data.structures !== undefined
          ? (typeof data.structures === 'string' ? data.structures : JSON.stringify(data.structures || []))
          : existing.structuresJson;
        var newEquipmentJson = data.equipment !== undefined
          ? (typeof data.equipment === 'string' ? data.equipment : JSON.stringify(data.equipment || []))
          : existing.equipmentJson;
        // 旧 daysWithin 列(15列目)は触らない (ダッシュボード側で一元管理)

        sheet.getRange(row, 2, 1, 7).setValues([[
          newName, newAreaJson, newRentMin, newRentMax, newLayoutsJson, newAreaMin, newBuildingAge
        ]]);
        sheet.getRange(row, 12, 1, 3).setValues([[
          newWalk, newStructuresJson, newEquipmentJson
        ]]);
        if (data.enabled !== undefined) {
          sheet.getRange(row, 9).setValue(data.enabled);
        }
        return { success: true, id: data.id, action: 'updated' };
      }
    }
    return { success: false, message: '条件ID ' + data.id + ' が見つかりません' };
  } else {
    var areaJson = typeof data.area === 'string' ? data.area : JSON.stringify(data.area || {});
    var layoutsJson = typeof data.layouts === 'string' ? data.layouts : JSON.stringify(data.layouts || []);
    var structuresJson = typeof data.structures === 'string' ? data.structures : JSON.stringify(data.structures || []);
    var equipmentJson = typeof data.equipment === 'string' ? data.equipment : JSON.stringify(data.equipment || []);
    // 新規条件の作成
    var newId = 'patrol-' + Utilities.getUuid().substring(0, 8);
    sheet.appendRow([
      newId,
      data.name || '無題の条件',
      areaJson,
      data.rentMin || '',
      data.rentMax || '',
      layoutsJson,
      data.areaMin || '',
      data.buildingAge || '',
      true,
      now,
      '',  // 最終巡回日時
      data.walk || '',
      structuresJson,
      equipmentJson,
      ''  // 旧 daysWithin 列 (廃止: ダッシュボード側で一元管理)
    ]);
    return { success: true, id: newId, action: 'created' };
  }
}

/**
 * 巡回条件を削除
 */
function deletePatrolCriteria(criteriaId) {
  var sheet = getPatrolCriteriaSheet_();
  var criteria = getPatrolCriteria();
  for (var i = 0; i < criteria.length; i++) {
    if (criteria[i].id === criteriaId) {
      sheet.deleteRow(criteria[i].rowIndex);
      return { success: true };
    }
  }
  return { success: false, message: '条件が見つかりません' };
}

/**
 * 巡回条件の最終巡回日時を更新
 */
function updatePatrolLastRun_(criteriaId) {
  var sheet = getPatrolCriteriaSheet_();
  var criteria = getPatrolCriteria();
  var now = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd HH:mm:ss');
  for (var i = 0; i < criteria.length; i++) {
    if (criteria[i].id === criteriaId) {
      sheet.getRange(criteria[i].rowIndex, 11).setValue(now);
      return;
    }
  }
}

// ═══════════════════════════════════════════════════════════
// 2. 候補物件管理
// ═══════════════════════════════════════════════════════════

/**
 * 候補物件を追加（Chrome拡張からのPOST）
 * @param {Object} json - { properties: [...], patrolCriteriaId }
 * @returns {Object} { added, duplicates }
 */
function addSuumoCandidates(json) {
  var sheet = getCandidateSheet_();
  var properties = json.properties || [];
  var criteriaId = json.patrolCriteriaId || '';
  var now = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd HH:mm:ss');

  // 既存キーを取得（重複チェック用）
  var existingKeys = {};
  var lastRow = sheet.getLastRow();
  if (lastRow > 1) {
    var keys = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
    for (var i = 0; i < keys.length; i++) {
      if (keys[i][0]) existingKeys[keys[i][0]] = true;
    }
  }

  var added = 0;
  var duplicates = 0;
  var newProperties = [];

  for (var j = 0; j < properties.length; j++) {
    var p = properties[j];
    var bldg = p.building_name || p.buildingName || p.building || '';
    var room = p.room_number || p.roomNumber || p.room || '';
    var key = normalizeSuumoPropertyKey_(bldg, room);

    if (existingKeys[key]) {
      duplicates++;
      continue;
    }

    existingKeys[key] = true;
    added++;

    var nearestStation = '';
    if (p.access && p.access.length > 0) {
      var a = p.access[0];
      nearestStation = (a.line || '') + ' ' + (a.station || '') + ' 徒歩' + (a.walk || '') + '分';
    }

    var row = [
      key,
      bldg,
      room,
      (p.pref || '') + (p.addr1 || '') + (p.addr2 || '') + (p.addr3 || ''),
      p.rent || '',
      p.managementFee || p.commonServiceFee || '',
      (p.madoriRoomCount || '') + (p.madoriType || ''),
      p.usageArea || '',
      nearestStation,
      now,
      p.sourceType || '',
      'pending',
      JSON.stringify(p),
      '',
      criteriaId
    ];

    sheet.appendRow(row);
    // appendRow後の最終行 = 今書いたrow。markSuumoCandidateAsDiscordSent_用に保持
    newProperties.push({ row: row, property: p, _sheetRowIndex: sheet.getLastRow() });
  }

  // 巡回条件の最終実行日時を更新
  if (criteriaId) {
    updatePatrolLastRun_(criteriaId);
  }

  return { added: added, duplicates: duplicates, newProperties: newProperties };
}

/**
 * 未通知物件（discordSentTs が空 or 未設定の物件）を取得。
 * Cloudflare 1015等でDiscord通知が失敗した物件を次回以降の巡回で再送するために使う。
 * - criteriaId: 対象の巡回条件IDに絞る
 * - 検出日時が 24時間以内 の物件のみ（古い未通知は諦める）
 * - 最大20件まで（1回の再送で大量処理しないよう制限）
 * @returns {Array} [{row: [...], property: {...}}, ...]
 */
function getUnsentSuumoCandidates_(criteriaId) {
  var sheet = getCandidateSheet_();
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  var lastCol = sheet.getLastColumn();
  var data = sheet.getRange(2, 1, lastRow - 1, lastCol).getValues();
  var now = new Date().getTime();
  var results = [];

  for (var i = 0; i < data.length; i++) {
    var row = data[i];
    var rowCriteriaId = row[14] || ''; // 巡回条件ID(15列目, 0-indexed:14)
    if (criteriaId && rowCriteriaId !== criteriaId) continue;

    var discordSentTs = row[SUUMO_CANDIDATE_COL_DISCORD_SENT_TS - 1] || '';
    if (discordSentTs) continue; // 既に通知済み

    // 検出日時(10列目 = 'yyyy-MM-dd HH:mm:ss' 文字列 or Date)のタイムスタンプ
    var detectedAtRaw = row[9];
    var detectedAtMs = 0;
    if (detectedAtRaw instanceof Date) {
      detectedAtMs = detectedAtRaw.getTime();
    } else if (typeof detectedAtRaw === 'string' && detectedAtRaw) {
      detectedAtMs = new Date(detectedAtRaw.replace(' ', 'T') + '+09:00').getTime();
    }
    if (!detectedAtMs || isNaN(detectedAtMs)) continue;
    if (now - detectedAtMs > SUUMO_UNSENT_RETRY_WINDOW_MS) continue;

    // property_data_json(13列目) から property を復元
    var propertyJson = row[12] || '';
    if (!propertyJson) continue;
    try {
      var property = JSON.parse(propertyJson);
      results.push({ row: row, property: property, _sheetRowIndex: i + 2 });
    } catch (e) { continue; }
    // 1回の巡回で再送する上限(GAS実行時間6分×物件間8秒→最大40件だが余裕を持って10件)
    if (results.length >= 10) break;
  }
  return results;
}

/**
 * Chrome拡張から呼ばれる: Discord送信成功した sheetRowIndex 群を一括マーク。
 * sheetRowIndexes: number[]
 */
function handleMarkSuumoDiscordSent(json) {
  var indexes = (json && json.sheetRowIndexes) || [];
  var marked = 0;
  for (var i = 0; i < indexes.length; i++) {
    try {
      markSuumoCandidateAsDiscordSent_(indexes[i]);
      marked++;
    } catch (e) {}
  }
  return ContentService.createTextOutput(JSON.stringify({
    success: true, marked: marked
  })).setMimeType(ContentService.MimeType.JSON);
}

/**
 * 指定 row (sheetRowIndex は 1-indexed) の discordSentTs 列に現在時刻を記録。
 */
function markSuumoCandidateAsDiscordSent_(sheetRowIndex) {
  try {
    var sheet = getCandidateSheet_();
    var now = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd HH:mm:ss');
    sheet.getRange(sheetRowIndex, SUUMO_CANDIDATE_COL_DISCORD_SENT_TS).setValue(now);
  } catch (e) {
    console.warn('markSuumoCandidateAsDiscordSent_ failed:', e && e.message);
  }
}

/**
 * 物件キーの正規化（建物名|部屋番号）
 */
function normalizeSuumoPropertyKey_(building, room) {
  var b = (building || '').replace(/[\s\u3000]/g, '').toLowerCase();
  var r = (room || '').replace(/[^\d]/g, '');
  return b + '|' + r;
}

/**
 * 10分以上submittingのままの行をapprovedに戻す（失敗/タブクラッシュ対策）
 */
function recoverStaleSubmittingQueue_() {
  var sheet = getCandidateSheet_();
  var lastRow = sheet.getLastRow();
  if (lastRow <= 1) return 0;

  // submitting の回復は、SUUMO_SUBMITTING_TIMEOUT_MS(30分) 〜 MAX_RECOVER_AGE_MS(24時間)
  // の範囲に限定する。24時間超過した submitting は「入稿試行失敗の過去遺産」と判定して
  // expired ステータスにし、以降自動再処理されないようにする(誤再入稿防止)。
  var MAX_RECOVER_AGE_MS = 24 * 60 * 60 * 1000; // 24時間

  var data = sheet.getRange(2, 1, lastRow - 1, SUUMO_CANDIDATE_HEADERS.length).getValues();
  var now = Date.now();
  var recovered = 0;
  var expired = 0;

  for (var i = 0; i < data.length; i++) {
    if (data[i][11] !== 'submitting') continue;
    var ts = Number(data[i][16] || 0);
    var ageMs = ts ? (now - ts) : Number.MAX_SAFE_INTEGER;

    if (ageMs > MAX_RECOVER_AGE_MS) {
      // 24時間超過 → expired (以後自動処理されない)
      sheet.getRange(i + 2, 12).setValue('expired');
      expired++;
    } else if (ageMs > SUUMO_SUBMITTING_TIMEOUT_MS) {
      // 30分〜24時間 → approved に戻す(入稿タブクラッシュ等からの復旧)
      sheet.getRange(i + 2, 12).setValue('approved');
      sheet.getRange(i + 2, 17).setValue('');
      recovered++;
    }
    // 30分未満は処理中として放置
  }
  if (recovered > 0 || expired > 0) {
    console.log('recoverStaleSubmittingQueue_: recovered=' + recovered + ' expired=' + expired);
  }
  return recovered;
}

/**
 * 承認済み（approved）の候補物件を取得（閲覧のみ・ロックなし）
 */
function getSuumoApprovalQueue() {
  var sheet = getCandidateSheet_();
  var lastRow = sheet.getLastRow();
  if (lastRow <= 1) return [];

  var data = sheet.getRange(2, 1, lastRow - 1, SUUMO_CANDIDATE_HEADERS.length).getValues();
  var result = [];
  for (var i = 0; i < data.length; i++) {
    if (data[i][11] === 'approved') {
      result.push(buildQueueItem_(data[i], i + 2));
    }
  }
  return result;
}

/**
 * 承認済みキューを取得すると同時にsubmittingへロック（Chrome拡張の入稿開始時に使用）
 * - 取得した行は全てsubmittingに変更し、取得時刻を17列目に記録
 * - 10分以上submittingのまま放置された行は先にapprovedへ復旧
 */
function getAndLockSuumoApprovalQueue() {
  recoverStaleSubmittingQueue_();

  var sheet = getCandidateSheet_();
  var lastRow = sheet.getLastRow();
  if (lastRow <= 1) return [];

  var data = sheet.getRange(2, 1, lastRow - 1, SUUMO_CANDIDATE_HEADERS.length).getValues();
  var result = [];
  var now = Date.now();

  for (var i = 0; i < data.length; i++) {
    if (data[i][11] === 'approved') {
      result.push(buildQueueItem_(data[i], i + 2));
      sheet.getRange(i + 2, 12).setValue('submitting');
      sheet.getRange(i + 2, 17).setValue(now);
    }
  }
  return result;
}

/**
 * シート行からキュー項目オブジェクトを生成
 */
function buildQueueItem_(row, rowIndex) {
  var propertyData = {};
  try { propertyData = JSON.parse(row[12]); } catch (ex) {}
  var imageGenres = {};
  try { imageGenres = JSON.parse(row[13]); } catch (ex) {}
  var featureIds = [];
  try { featureIds = JSON.parse(row[15] || '[]'); } catch (ex) {}

  return {
    key: row[0],
    building: row[1],
    room: row[2],
    address: row[3],
    source: row[10],
    propertyData: propertyData,
    imageGenres: imageGenres,
    featureIds: featureIds,
    rowIndex: rowIndex
  };
}

/**
 * 候補物件のステータスを更新
 */
function updateCandidateStatus_(key, newStatus) {
  var sheet = getCandidateSheet_();
  var lastRow = sheet.getLastRow();
  if (lastRow <= 1) return false;

  var keys = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
  for (var i = 0; i < keys.length; i++) {
    if (keys[i][0] === key) {
      sheet.getRange(i + 2, 12).setValue(newStatus); // ステータス列
      return true;
    }
  }
  return false;
}

/**
 * 候補物件に画像ジャンルJSONを保存し、ステータスをapprovedに変更
 */
function approveSuumoCandidate(key, imageGenresJson, featureIdsJson) {
  var sheet = getCandidateSheet_();
  var lastRow = sheet.getLastRow();
  if (lastRow <= 1) return { success: false, message: '候補物件が見つかりません' };

  var keys = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
  for (var i = 0; i < keys.length; i++) {
    if (keys[i][0] === key) {
      var row = i + 2;
      sheet.getRange(row, 12).setValue('approved');
      sheet.getRange(row, 14).setValue(imageGenresJson || '');
      sheet.getRange(row, 16).setValue(featureIdsJson || '');
      return { success: true };
    }
  }
  return { success: false, message: '物件キー ' + key + ' が見つかりません' };
}

/**
 * 候補物件を却下
 */
function rejectSuumoCandidate(key) {
  return updateCandidateStatus_(key, 'rejected') ?
    { success: true } : { success: false, message: '物件が見つかりません' };
}

// ═══════════════════════════════════════════════════════════
// 3. 掲載管理
// ═══════════════════════════════════════════════════════════

/**
 * 入稿完了を記録（Chrome拡張からのPOST）
 * - data.success === false の場合はsubmittingロックを解除しapprovedに戻す（リトライ可能）
 */
function recordSuumoPosting(data) {
  // Chrome拡張(suumo-fill-auto.js) は propertyKey を送ってくるが、
  // 旧互換のため key も受け付ける
  var key = data.key || data.propertyKey || '';
  if (!key) return { success: false, message: 'key未指定' };

  // 失敗報告: submittingロックを解除してapprovedに戻す
  if (data.success === false) {
    updateCandidateStatus_(key, 'approved');
    clearSubmittingTimestamp_(key);
    return { success: false, key: key, recovered: true };
  }

  var sheet = getListingSheet_();
  var now = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd HH:mm:ss');

  // 二重登録防止: 既に同じ物件キーで active 行が存在する場合は appendRow せず、
  // suumo_property_code (11列目) が空ならその情報だけ補完する。
  // Phase5 と Phase6 がほぼ同時に suumo_post_complete を投げると二重登録される
  // ことがあるため、ここで防御する。
  var listingLastRow = sheet.getLastRow();
  if (listingLastRow > 1) {
    try {
      var keysCol = sheet.getRange(2, 1, listingLastRow - 1, 1).getValues();
      var statusCol = sheet.getRange(2, 9, listingLastRow - 1, 1).getValues();
      var existingCodeCol = sheet.getRange(2, 11, listingLastRow - 1, 1).getValues();
      for (var ei = 0; ei < keysCol.length; ei++) {
        if (keysCol[ei][0] === key && statusCol[ei][0] === 'active') {
          // 既に active 行あり → suumo_property_code を補完するだけで終了
          var newCode = String(data.suumoPropertyCode || '');
          var existingCode = String(existingCodeCol[ei][0] || '');
          if (newCode && !existingCode) {
            sheet.getRange(ei + 2, 11).setValue(newCode);
            Logger.log('recordSuumoPosting: 既存active行に suumo_code を補完 row=' +
                       (ei + 2) + ' key=' + key + ' code=' + newCode);
          } else {
            Logger.log('recordSuumoPosting: 二重登録回避 row=' + (ei + 2) + ' key=' + key);
          }
          // candidate シート側の状態はそのまま posted へ
          updateCandidateStatus_(key, 'posted');
          clearSubmittingTimestamp_(key);
          return { success: true, key: key, deduped: true, existingRow: ei + 2 };
        }
      }
    } catch (e) {
      Logger.log('recordSuumoPosting: 重複チェック失敗 (続行) ' + e.message);
    }
  }

  // 候補物件シートから反響予測スコアを取得して掲載管理シートにコピー
  // (停止候補判定で「本来人気だが競合多い物件」を保護するのに使う)
  var inquiryScore = 0;
  try {
    var candSheet = getCandidateSheet_();
    var candLastRow = candSheet.getLastRow();
    var scoreColIdx = SUUMO_CANDIDATE_HEADERS.indexOf('反響予測スコア') + 1;
    if (candLastRow > 1 && scoreColIdx > 0) {
      var candKeys = candSheet.getRange(2, 1, candLastRow - 1, 1).getValues();
      for (var ci = 0; ci < candKeys.length; ci++) {
        if (candKeys[ci][0] === key) {
          inquiryScore = Number(candSheet.getRange(ci + 2, scoreColIdx).getValue()) || 0;
          break;
        }
      }
    }
  } catch (e) {
    Logger.log('recordSuumoPosting: 反響予測スコア取得失敗 ' + e.message);
  }

  // 掲載管理シートに追加 (23列、SUUMO_LISTING_HEADERS に合わせる)
  // suumoPropertyCode: 登録完了画面に表示される 12 桁のSUUMO物件コード。
  // Phase5 (forrent-final-submit.js) と Phase6 (suumo-fill-auto.js) どちらでも取得して送る。
  sheet.appendRow([
    key,
    data.building || '',
    data.room || '',
    now,
    data.rent || '',
    0,  // PV初期値
    0,  // 問合初期値
    0,  // スコア初期値
    'active',
    '',
    String(data.suumoPropertyCode || ''),  // 11列目: suumo_property_code
    '', '', '', '',                        // 12-15: SUUMOビジネス連携で後から更新される
    '', '', '', '',                        // 16-19: 競合数・危険度(SUUMOビジネス連携で更新)
    '',                                    // 20: 最終取得日時
    inquiryScore,                          // 21: 反響予測スコア (入稿時に候補から引き継ぎ)
    '',                                    // 22: 初回申込検知日 (findStopCandidatesで動的に書き込み)
    ''                                     // 23: スコア内訳 (findStopCandidatesで動的に書き込み)
  ]);

  // 候補物件シートのステータスをpostedに更新 + submittingTsクリア
  updateCandidateStatus_(key, 'posted');
  clearSubmittingTimestamp_(key);

  return { success: true, key: key };
}

/**
 * submittingTs列（17列目）をクリア
 */
function clearSubmittingTimestamp_(key) {
  var sheet = getCandidateSheet_();
  var lastRow = sheet.getLastRow();
  if (lastRow <= 1) return;

  var keys = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
  for (var i = 0; i < keys.length; i++) {
    if (keys[i][0] === key) {
      sheet.getRange(i + 2, 17).setValue('');
      return;
    }
  }
}

/**
 * 掲載中の物件数を取得
 */
function getActiveListingCount() {
  var sheet = getListingSheet_();
  var lastRow = sheet.getLastRow();
  if (lastRow <= 1) return 0;

  var statuses = sheet.getRange(2, 9, lastRow - 1, 1).getValues();
  var count = 0;
  for (var i = 0; i < statuses.length; i++) {
    if (statuses[i][0] === 'active') count++;
  }
  return count;
}

/**
 * パフォーマンスデータを更新（Chrome拡張からのPOST）
 * @param {Array} updates - [{ key, pv, inquiries }]
 */
function updateSuumoPerformance(updates) {
  var sheet = getListingSheet_();
  var lastRow = sheet.getLastRow();
  if (lastRow <= 1) return { success: true, updated: 0 };

  var data = sheet.getRange(2, 1, lastRow - 1, SUUMO_LISTING_HEADERS.length).getValues();
  var updated = 0;

  for (var i = 0; i < updates.length; i++) {
    var u = updates[i];
    for (var j = 0; j < data.length; j++) {
      if (data[j][0] === u.key && data[j][8] === 'active') {
        var row = j + 2;
        var pv = Number(u.pv) || 0;
        var inquiries = Number(u.inquiries) || 0;
        // パフォーマンススコア = PV + 問合数×10
        var score = pv + inquiries * 10;
        sheet.getRange(row, 6, 1, 3).setValues([[pv, inquiries, score]]);
        updated++;
        break;
      }
    }
  }

  return { success: true, updated: updated };
}

/**
 * 掲載停止すべき物件を特定(Phase 2 新ロジック)
 *
 * 保護ルール(停止対象外):
 *   - シート掲載日数 < 7 (新着)
 *   - 問い合わせ数 >= 1 かつ シート掲載日数 < 45
 *
 * 保護ルール外の物件について以下の危険度スコアを計算し、
 * スコア降順の上位を停止候補として返す。
 *
 *   score = (第3競合×2.1 + 第2競合×1.6 + 第1競合×1.0) × 10
 *         + (シート掲載日数 >= 60 ? 9999 : 0)   ← 60日超は確実に落とす
 *         + (シート掲載日数 >= 45 ? 500 : 0)    ← 45日超は強い停止圧力
 *
 * 注: 問い合わせ数による減点はスコア側に入れない(保護ルールで扱うため)。
 *     SUUMOビジネスの「掲載日数(最大45)」ではなく、シートの「掲載開始日」から
 *     算出した経過日数を基準日数として使う(ユーザー指示: シート日数のほうが正確)。
 *
 * @param {number} topN - 返す候補数の上限(デフォルト10)
 * @returns {Array<Object>} スコア降順の候補リスト(0件なら空配列)
 */
function findStopCandidates(topN, options) {
  var limit = topN || 10;
  options = options || {};
  // protectRelaxLevel: 0=標準 / 1=緩い / 2=最小 / 3=保護無視
  // 0: 新着7日保護 + 問合あり&45日未満保護 (デフォルト)
  // 1: 新着3日保護 + 問合あり&30日未満保護
  // 2: 新着1日保護のみ (新規入稿直後だけ守る)
  // 3: 保護なし (最終手段、 50件埋まり全員保護該当の詰み回避)
  var relaxLevel = options.protectRelaxLevel || 0;

  var sheet = getListingSheet_();
  var lastRow = sheet.getLastRow();
  if (lastRow <= 1) return [];

  var headerLen = SUUMO_LISTING_HEADERS.length;
  var data = sheet.getRange(2, 1, lastRow - 1, headerLen).getValues();
  var now = new Date();

  // 物件空室管理シート(PROPERTY_SHEET_ID) の K列「終了日」を参照するためのマップ。
  // 「建物名+部屋番号」→ 終了日(Date) の形。終了日がない (まだ申込検知されてない)
  // 物件はマップに含まれない。
  var vacancyEndedMap = _buildVacancyEndedMap_();

  // 列インデックス (1-indexed)
  var moshikomiColIdx = SUUMO_LISTING_HEADERS.indexOf('初回申込検知日') + 1;
  var breakdownColIdx = SUUMO_LISTING_HEADERS.indexOf('スコア内訳') + 1;

  // 停止候補選出ログ用 (実行ごとに全 active 物件を記録、Phase B の評価データ蓄積)
  var logRows = [];

  var candidates = [];
  for (var i = 0; i < data.length; i++) {
    if (data[i][8] !== 'active') continue;

    var suumoListedDays = Number(data[i][14]) || 0; // 15列目: 掲載日数(SUUMO最大45)。参考情報
    var compLv1 = Number(data[i][15]) || 0;  // 16列目: 第1基準値競合数
    var compLv2 = Number(data[i][16]) || 0;  // 17列目: 第2基準値競合数
    var compLv3 = Number(data[i][17]) || 0;  // 18列目: 第3基準値競合数
    var inquiries = Number(data[i][13]) || 0; // 14列目: 問い合わせ数(SUUMOビジネス集計値)
    if (!inquiries) inquiries = Number(data[i][6]) || 0; // フォールバック: 旧7列目
    // 21列目: 反響予測スコア (入稿時に候補から引き継ぎ、0-100)
    var inquiryScore = Number(data[i][20]) || 0;
    // 13列目: 合計詳細PV (一日PV算出に使う)
    var totalDetailPv = Number(data[i][12]) || 0;

    // シート上での掲載開始日からの経過日数(これが保護・スコア両方の基準)
    var sheetDays = 0;
    var startRaw = data[i][3];
    var startDate = null;
    if (startRaw) {
      startDate = (startRaw instanceof Date) ? startRaw : new Date(startRaw);
      if (!isNaN(startDate.getTime())) {
        sheetDays = Math.floor((now.getTime() - startDate.getTime()) / (24 * 60 * 60 * 1000));
      } else {
        startDate = null;
      }
    }

    // 実効掲載日数 = max(シート日数, SUUMO集計日数)
    // SUUMOビジネス側の「掲載日数」は最大45でcap される。45達成 = 少なくとも
    // 45日以上SUUMO掲載中と判断できる。初期投入でシート日数が浅い物件でも
    // SUUMO側の実績で保護判定/45日ボーナス判定できる。
    var effectiveDays = Math.max(sheetDays, suumoListedDays);

    // ── 初回申込検知日 (22列目) を取得 ──────────────────
    // 1. シートの値が入っていればそれを使う
    // 2. 入っていなければ、物件空室管理シートから建物名+部屋番号で検索
    //    マッチして終了日があれば、ここで初回検知として書き込み (永続化)
    var initialMoshikomiDate = null;
    if (moshikomiColIdx > 0) {
      var existing = data[i][moshikomiColIdx - 1];
      if (existing instanceof Date) {
        initialMoshikomiDate = existing;
      } else if (existing) {
        var ed = new Date(String(existing));
        if (!isNaN(ed.getTime())) initialMoshikomiDate = ed;
      }
      if (!initialMoshikomiDate) {
        var bldName = String(data[i][1] || '');
        var roomNo = String(data[i][2] || '');
        var vkey = _normalizeBuildingRoomKey_(bldName, roomNo);
        var foundEnded = vacancyEndedMap[vkey];
        if (foundEnded instanceof Date) {
          initialMoshikomiDate = foundEnded;
          // シートに永続化 (キャンセル等で空室管理側がクリアされても保持)
          try {
            sheet.getRange(i + 2, moshikomiColIdx).setValue(foundEnded);
          } catch (e) {
            Logger.log('初回申込検知日の書き込み失敗 row=' + (i + 2) + ': ' + e.message);
          }
        }
      }
    }

    // 60日超は無条件で停止候補対象 (相手の反響予測が高くても、シート日数60日を
    // 超えた物件は強制的に落とす)
    var isLongStay = (sheetDays >= 60);

    // 反響30超+申込検知ありは「役目を果たした」として強制落とし対象に。
    // 申込検知なし(または不明) なら、たとえ反響30超でも保護を維持する。
    var hasMoshikomi = (initialMoshikomiDate instanceof Date);
    var forceFromInquiries = (inquiries >= 30 && hasMoshikomi);

    var forceCandidate = isLongStay || forceFromInquiries;

    // ── 弱さの判定 (順位ベース。反響予測スコア式は廃止) ─────────────
    // 加重競合数 = 第1基準値×1.0 + 第2基準値×1.6 + 第3基準値×2.1
    //   (第2基準値の会社は1.6倍/第3は2.1倍 掲載されやすい=強い競合とみなす)
    var weightedComp = (compLv3 * 2.1) + (compLv2 * 1.6) + (compLv1 * 1.0);
    var lowComp = (weightedComp <= 5);              // 低競合(他社少)= 25件キープのため守る

    // ポテンシャル順位 (24列目=現在の順位 / 25列目=1ページ目内 ○×)
    var potRank = Number(data[i][23]) || 0;
    var outOfPage1 = (String(data[i][24] || '') === '×'); // 圏外(類似物件50件以上の中で埋もれ)
    var hasInquiry = (inquiries > 0);

    // 弱さスコア(高いほど先に落とす)
    var weak;
    if (forceCandidate) {
      weak = 1000000 + sheetDays;                   // 60日超/反響30+申込 は最優先(同点はシート日数長い順)
    } else {
      weak = potRank;                               // 順位が悪い(大きい)ほど弱い
      if (outOfPage1) weak += 100000;               // 圏外が最弱
      if (!lowComp) weak += 50000;                  // 高競合は低競合より先に落とす
    }

    var forceReason = isLongStay ? '60日超' : (forceFromInquiries ? '反響30+申込' : '');
    // 落とす理由(人が読める文字)
    var dropReason;
    if (forceCandidate) {
      dropReason = (isLongStay ? '掲載60日超' : '')
                 + (forceFromInquiries ? ((isLongStay ? ' / ' : '') + '反響30件超&申込あり') : '');
    } else {
      dropReason = (outOfPage1 ? '圏外(埋もれ)' : ('順位' + potRank + '位'))
                 + ' / ' + (lowComp ? '低競合' : ('高競合(加重' + (Math.round(weightedComp * 10) / 10) + ')'));
    }
    var breakdown = {
      reason: dropReason,
      weightedComp: Math.round(weightedComp * 10) / 10,
      lowComp: lowComp, rank: potRank, outOfPage1: outOfPage1,
      inquiries: inquiries, hasMoshikomi: hasMoshikomi,
      force: forceReason || null, weak: weak
    };
    var breakdownJson = JSON.stringify(breakdown);

    // ── 保護判定 (eligibility)。relaxLevel で段階的に緩める(全員保護で詰むのを回避) ──
    //   force は常に対象。0: 低競合と問い合わせ来てるを守る / 1: 問い合わせのみ守る / 2+: 保護なし
    var protectedReason = '';
    if (!forceCandidate) {
      if (relaxLevel <= 0) {
        if (lowComp) protectedReason = 'lowComp';
        else if (hasInquiry) protectedReason = 'inquiry';
      } else if (relaxLevel === 1) {
        if (hasInquiry) protectedReason = 'inquiry';
      }
      // relaxLevel >= 2 は保護なし
    }

    // ログ用エントリ (全 active 物件を記録)
    logRows.push([
      now,
      relaxLevel,
      data[i][0],                       // 物件キー
      data[i][1] || '',                 // 建物名
      data[i][2] || '',                 // 部屋番号
      weak,
      breakdownJson,
      protectedReason ? ('保護:' + protectedReason) : '候補',
      '',                               // (旧:反響予測スコア 廃止)
      inquiries,
      initialMoshikomiDate || '',
      sheetDays,
      suumoListedDays
    ]);

    if (protectedReason) continue;

    candidates.push({
      key: data[i][0],
      building: data[i][1],
      room: data[i][2],
      startDate: startRaw,
      rent: data[i][4],
      pv: totalDetailPv || Number(data[i][5]) || 0, // 合計詳細PV優先
      inquiries: inquiries,
      score: weak,
      reason: dropReason,
      breakdown: breakdown,
      weightedComp: weightedComp,
      lowComp: lowComp,
      rank: potRank,
      outOfPage1: outOfPage1,
      force: forceReason || '',
      suumoPropertyCode: String(data[i][10] || ''),
      suumoListedDays: suumoListedDays,
      sheetDays: sheetDays,
      compLv1: compLv1,
      compLv2: compLv2,
      compLv3: compLv3,
      rowIndex: i + 2,
      protectRelaxLevel: relaxLevel  // どの保護段階で拾われたかを記録
    });
  }

  // 停止候補ログシートに一括追記 (Phase B の評価データ蓄積)
  if (logRows.length > 0) {
    try {
      var logSheet = getStopLogSheet_();
      var logStart = logSheet.getLastRow() + 1;
      logSheet.getRange(logStart, 1, logRows.length, SUUMO_STOP_LOG_HEADERS.length)
        .setValues(logRows);
    } catch (e) {
      Logger.log('停止候補ログ書き込み失敗: ' + e.message);
    }
  }

  // 降順ソートして上位N件を返す
  candidates.sort(function(a, b) {
    if (b.score !== a.score) return b.score - a.score;
    // 同点はシート日数が長い方を優先
    return b.sheetDays - a.sheetDays;
  });

  return candidates.slice(0, limit);
}

/**
 * 段階的保護緩和つきの候補取得。
 *
 * 標準ルール (level 0) で 0 件なら段階的に緩めて、 必ず 1 件以上の候補を返す。
 * (50件埋まり + 全員保護対象 で詰むのを回避するため)
 *
 * @param {number} topN 上限件数
 * @returns {{ candidates: Array, finalLevel: number }}
 *   candidates: 候補リスト (空配列は active 行が 1 件もない場合のみ)
 *   finalLevel: 最終的に採用した relaxLevel (0..3)
 */
function findStopCandidatesWithGracefulRelax(topN) {
  for (var level = 0; level <= 3; level++) {
    var list = findStopCandidates(topN, { protectRelaxLevel: level });
    if (list.length > 0) {
      return { candidates: list, finalLevel: level };
    }
  }
  return { candidates: [], finalLevel: 3 };
}

/**
 * 旧API互換: 最上位1件だけ返す
 * (handleGetSuumoQueue で stopCandidate を単数返ししていた呼び出し元のため)
 */
function findStopCandidate() {
  var list = findStopCandidates(1);
  return list.length > 0 ? list[0] : null;
}

/**
 * 物件を掲載停止にする
 */
function stopSuumoListing(key) {
  var sheet = getListingSheet_();
  var lastRow = sheet.getLastRow();
  if (lastRow <= 1) return { success: false };

  var now = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd HH:mm:ss');
  var keys = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
  var statuses = sheet.getRange(2, 9, lastRow - 1, 1).getValues();
  var stoppedCount = 0;
  // 同じ key の行が複数あるケース (再承認で重複登録された等) に対応するため、
  // 最初の1行だけでなく該当する全行を stopped 化する。
  // 旧実装は早期 return していたため、 1物件目だけ stopped、 残りは active のまま
  // → ForRent との不整合で「既に成約」 ループ → 入稿不能のバグになっていた
  // (2026-05-05)
  for (var i = 0; i < keys.length; i++) {
    if (keys[i][0] === key && statuses[i][0] !== 'stopped') {
      var row = i + 2;
      sheet.getRange(row, 9).setValue('stopped');
      sheet.getRange(row, 10).setValue(now);
      stoppedCount++;
    }
  }
  if (stoppedCount === 0) {
    return { success: false, message: '該当の active 行が見つかりません (key=' + key + ')' };
  }
  return { success: true, stoppedCount: stoppedCount };
}

/**
 * 掲載管理シートの重複行をいっぺんに削除する
 *
 * 経緯 (2026-05-05):
 *   旧 suumo-fill-auto.js が「フォーム入力完了 = 入稿成功」 と誤判定し、
 *   Phase5 (確認画面登録) が失敗しても active 行が追加されていた。
 *   その結果、 同じ key の行が複数並ぶシートになり、 「停止候補」として永遠に
 *   検出される無限ループを引き起こしていた。
 *
 * 動作:
 *   各 key について行を集約し、 1 行だけ残してそれ以外は **行ごと削除** する。
 *   残す行の優先順位:
 *     1) status=active がある場合 → active のうち最新 (最大行番号) を 1 行残す
 *     2) active が無い場合 → stopped のうち最新 (最大行番号) を 1 行残す
 *   それ以外の重複行はゴミとして物理削除 (deleteRow)。
 *
 *   削除は後ろの行から実施する (前から削除すると行番号がずれるため)。
 *
 * @param {Object} [opts]
 *   - dryRun {boolean}  true なら結果を返すだけで削除しない (確認用)
 * @returns {{ success: boolean, processedKeys: number, deletedRows: number, details: Array }}
 */
function cleanupDuplicateListings(opts) {
  opts = opts || {};
  var dryRun = !!opts.dryRun;
  var sheet = getListingSheet_();
  var lastRow = sheet.getLastRow();
  if (lastRow <= 1) {
    return {
      success: true, dryRun: dryRun, processedKeys: 0, deletedRows: 0, details: [],
      message: 'シートが空です'
    };
  }

  // 列: A=key(1), B=building(2), C=room(3), D=postedAt(4), I=status(9),
  //     K=suumo_property_code(11), L=合計一覧PV(12), M=合計詳細PV(13)
  // 23列ぶん取って残す行判定に使う。
  var values = sheet.getRange(2, 1, lastRow - 1, SUUMO_LISTING_HEADERS.length).getValues();

  // key ごとに全行を集める
  var rowsByKey = {};
  for (var i = 0; i < values.length; i++) {
    var key = values[i][0];
    if (!key) continue;
    if (!rowsByKey[key]) rowsByKey[key] = [];
    rowsByKey[key].push({
      sheetRow: i + 2,
      key: key,
      building: values[i][1],
      room: values[i][2],
      postedAt: values[i][3],
      status: values[i][8],
      suumoCode: String(values[i][10] || '').trim(),
      totalListPv: Number(values[i][11]) || 0,
      totalDetailPv: Number(values[i][12]) || 0,
      inquiryScore: Number(values[i][20]) || 0
    });
  }

  // 削除対象の行番号を集める (重複している key の中から「残す 1 行」以外)
  var toDelete = []; // [{ sheetRow, key, building, room, status, keptRow, keptStatus }, ...]
  var processedKeys = 0;

  Object.keys(rowsByKey).forEach(function (key) {
    var rows = rowsByKey[key];
    if (rows.length <= 1) return; // 重複なし
    processedKeys++;

    // 残す 1 行を決定:
    // 優先順位:
    //   1) status === 'active' を優先 (stopped は最後)
    //   2) suumo_property_code が入っている行を優先 (SUUMOビジネス連携で値あり)
    //   3) 合計詳細PV + 合計一覧PV の合計が大きい行を優先 (データ豊富)
    //   4) 反響予測スコアが入っている行を優先
    //   5) 最大 sheetRow (新しい行)
    function scoreForKeep(r) {
      var s = 0;
      if (r.status === 'active') s += 10000000;
      if (r.suumoCode) s += 1000000;
      s += Math.min(999999, r.totalDetailPv + r.totalListPv);
      if (r.inquiryScore > 0) s += 100;
      return s;
    }
    var sorted = rows.slice().sort(function (a, b) {
      var sa = scoreForKeep(a);
      var sb = scoreForKeep(b);
      if (sa !== sb) return sb - sa;
      return b.sheetRow - a.sheetRow;
    });
    var keep = sorted[0];

    rows.forEach(function (r) {
      if (r.sheetRow === keep.sheetRow) return;
      toDelete.push({
        sheetRow: r.sheetRow,
        key: r.key,
        building: r.building,
        room: r.room,
        status: r.status,
        suumoCode: r.suumoCode || '',
        totalDetailPv: r.totalDetailPv,
        keptRow: keep.sheetRow,
        keptStatus: keep.status,
        keptSuumoCode: keep.suumoCode || '',
        keptTotalDetailPv: keep.totalDetailPv
      });
    });
  });

  // 物理削除は **行番号が大きい方から** 実行 (前から消すと番号がずれる)
  toDelete.sort(function (a, b) { return b.sheetRow - a.sheetRow; });

  if (!dryRun) {
    for (var j = 0; j < toDelete.length; j++) {
      sheet.deleteRow(toDelete[j].sheetRow);
    }
  }

  return {
    success: true,
    dryRun: dryRun,
    processedKeys: processedKeys,
    deletedRows: toDelete.length,
    details: toDelete,
    message: (dryRun ? '[DRY RUN] ' : '') + processedKeys + ' 件の key で重複検出 → '
             + toDelete.length + ' 行を' + (dryRun ? '削除予定 (実削除なし)' : '物理削除')
  };
}

/**
 * 掲載管理シートの「stopped」行のうち、 停止日 (J 列) から指定日数以上経過した
 * 行を物理削除する。
 *
 * 用途:
 *   stopped (掲載終了) になった物件の履歴は古くなるとシートを圧迫するため、
 *   2 週間 (14 日) 経過したら自動削除して掃除する。
 *
 * @param {number} [daysOld=14] 何日経過した stopped 行を削除対象にするか
 * @param {Object} [opts]
 *   - dryRun {boolean} true なら結果を返すだけで削除しない
 * @returns {{ success: boolean, deletedRows: number, details: Array }}
 */
function purgeOldStoppedListings_(daysOld, opts) {
  var threshold = ((daysOld == null ? 14 : daysOld)) * 24 * 60 * 60 * 1000;
  var dryRun = !!(opts && opts.dryRun);
  var sheet = getListingSheet_();
  var lastRow = sheet.getLastRow();
  if (lastRow <= 1) return { success: true, deletedRows: 0, details: [] };

  // I 列 (status) と J 列 (停止日) を含む 10 列分を読み込む
  var values = sheet.getRange(2, 1, lastRow - 1, 10).getValues();
  var now = Date.now();
  var rowsToDelete = [];

  for (var i = 0; i < values.length; i++) {
    var status = values[i][8]; // I 列
    if (status !== 'stopped') continue;
    var stoppedAt = values[i][9]; // J 列
    if (!stoppedAt) continue; // 停止日 不明 → 触らない (安全側)
    var stoppedDate = (stoppedAt instanceof Date) ? stoppedAt : new Date(stoppedAt);
    if (isNaN(stoppedDate.getTime())) continue;
    if (now - stoppedDate.getTime() >= threshold) {
      rowsToDelete.push({
        sheetRow: i + 2,
        key: values[i][0],
        building: values[i][1],
        room: values[i][2],
        stoppedAt: stoppedAt
      });
    }
  }

  // 物理削除は **行番号が大きい方から** 実行 (前から消すと番号ズレ)
  rowsToDelete.sort(function (a, b) { return b.sheetRow - a.sheetRow; });

  if (!dryRun) {
    for (var j = 0; j < rowsToDelete.length; j++) {
      sheet.deleteRow(rowsToDelete[j].sheetRow);
    }
  }

  return {
    success: true,
    dryRun: dryRun,
    deletedRows: rowsToDelete.length,
    details: rowsToDelete,
  };
}

/**
 * 24 時間に 1 度だけ purgeOldStoppedListings_ を実行 (高頻度のシート操作を回避)。
 * SUUMO 関連の主要関数 (handleGetSuumoQueue や recordSuumoPosting) の冒頭で呼ぶ。
 * ScriptProperties に最終実行時刻を記録して、 24h 経っていれば再実行する。
 */
function maybePurgeOldStoppedListings_() {
  var now = Date.now();
  try {
    var props = PropertiesService.getScriptProperties();
    var last = parseInt(props.getProperty('LAST_STOPPED_PURGE_AT') || '0', 10);
    if (last && now - last < 24 * 60 * 60 * 1000) return;
    var result = purgeOldStoppedListings_(14);
    props.setProperty('LAST_STOPPED_PURGE_AT', String(now));
    if (result.deletedRows > 0) {
      console.log('[SUUMO掲載管理] 14日経過 stopped 行を自動削除: ' + result.deletedRows + '件');
    }
  } catch (e) {
    console.error('maybePurgeOldStoppedListings_ 例外: ' + (e && e.message));
  }
}

// ═══════════════════════════════════════════════════════════
// 4. 承認ページ
// ═══════════════════════════════════════════════════════════

/**
 * SUUMO巡回条件管理ページを表示
 */
function handleSuumoPatrolConfigPage(e) {
  try {
    var template = HtmlService.createTemplateFromFile('SuumoPatrolConfig');
    template.tokyoCities = JSON.stringify(TOKYO_CITIES);
    template.routeCompanies = JSON.stringify(ROUTE_COMPANIES);
    template.stationData = JSON.stringify(STATION_DATA);

    return template.evaluate()
      .setTitle('SUUMO巡回条件管理')
      .addMetaTag('viewport', 'width=device-width, initial-scale=1')
      .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
  } catch (err) {
    console.error('SuumoPatrolConfig error: ' + err.message + '\n' + err.stack);
    return HtmlService.createHtmlOutput(
      '<html><body style="font-family:sans-serif;padding:40px;text-align:center;">' +
      '<h2 style="color:#e74c3c;">エラー</h2>' +
      '<p>' + err.message + '</p>' +
      '<pre style="text-align:left;background:#f5f5f5;padding:10px;margin:20px auto;max-width:600px;overflow:auto;">' + (err.stack || '') + '</pre>' +
      '</body></html>'
    ).setTitle('エラー');
  }
}

/**
 * SUUMO承認ページを表示
 */
function handleSuumoApprovePage(e) {
  var key = e.parameter.key;
  if (!key) {
    return HtmlService.createHtmlOutput(
      '<html><body style="text-align:center;padding:40px;font-family:sans-serif;">' +
      '<h3>パラメータエラー</h3><p>物件キーが指定されていません。</p></body></html>'
    ).setTitle('SUUMO承認');
  }

  // 候補物件データを取得
  var sheet = getCandidateSheet_();
  var lastRow = sheet.getLastRow();
  if (lastRow <= 1) {
    return HtmlService.createHtmlOutput(
      '<html><body style="text-align:center;padding:40px;font-family:sans-serif;">' +
      '<h3>物件が見つかりません</h3></body></html>'
    ).setTitle('SUUMO承認');
  }

  var data = sheet.getRange(2, 1, lastRow - 1, SUUMO_CANDIDATE_HEADERS.length).getValues();
  var candidateRow = null;
  for (var i = 0; i < data.length; i++) {
    if (data[i][0] === key) {
      candidateRow = data[i];
      break;
    }
  }

  if (!candidateRow) {
    return HtmlService.createHtmlOutput(
      '<html><body style="text-align:center;padding:40px;font-family:sans-serif;">' +
      '<h3>物件が見つかりません</h3><p>キー: ' + key + '</p></body></html>'
    ).setTitle('SUUMO承認');
  }

  var propertyData = {};
  try { propertyData = JSON.parse(candidateRow[12]); } catch (ex) {}

  var template = HtmlService.createTemplateFromFile('SuumoApprovalPage');
  template.propertyKey = key;
  template.building = candidateRow[1];
  template.room = candidateRow[2];
  template.address = candidateRow[3];
  template.rent = candidateRow[4];
  template.managementFee = candidateRow[5];
  template.layout = candidateRow[6];
  template.area = candidateRow[7];
  template.station = candidateRow[8];
  template.source = candidateRow[10];
  template.status = candidateRow[11];
  template.propertyDataJson = JSON.stringify(propertyData);

  return template.evaluate()
    .setTitle('SUUMO掲載承認 - ' + candidateRow[1])
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

// ═══════════════════════════════════════════════════════════
// 5. Discord通知
// ═══════════════════════════════════════════════════════════

/**
 * 巡回開始時に Discord forum チャンネルにスレッドを1つ作成し、thread_id を返す。
 * 巡回中の全物件はこのスレッドに追記される(Discord rate limit緩和のため)。
 * Chrome拡張から action=create_suumo_patrol_thread で呼ばれる。
 */
function handleCreateSuumoPatrolThread(json) {
  var webhookUrl = PropertiesService.getScriptProperties().getProperty('SUUMO_DISCORD_WEBHOOK_URL') || '';
  if (!webhookUrl) {
    return ContentService.createTextOutput(JSON.stringify({
      success: false, error: 'SUUMO_DISCORD_WEBHOOK_URL未設定'
    })).setMimeType(ContentService.MimeType.JSON);
  }

  var criteriaName = (json && json.criteriaName) || '';
  var jstNow = Utilities.formatDate(new Date(), 'JST', 'yyyy-MM-dd HH:mm');
  var threadName = '🌀 SUUMO巡回 ' + jstNow + (criteriaName ? ' / ' + criteriaName : '');

  // ?wait=true でメッセージ作成結果を取得 → channel_id がスレッドIDになる
  try {
    var resp = UrlFetchApp.fetch(webhookUrl + '?wait=true', {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify({
        thread_name: threadName,
        content: '━━━ SUUMO巡回 開始 ━━━\n📅 ' + jstNow + (criteriaName ? '\n📋 条件: ' + criteriaName : '')
      }),
      muteHttpExceptions: true
    });
    var code = resp.getResponseCode();
    var bodyText = resp.getContentText();
    if (code < 200 || code >= 300) {
      return ContentService.createTextOutput(JSON.stringify({
        success: false, error: 'webhook HTTP ' + code + ': ' + bodyText.substring(0, 200)
      })).setMimeType(ContentService.MimeType.JSON);
    }
    var body = JSON.parse(bodyText);
    // forum チャンネルへの thread_name 付き投稿時、channel_id が新スレッドのID
    var threadId = body.channel_id || body.thread_id || (body.channel && body.channel.id) || '';
    if (!threadId) {
      return ContentService.createTextOutput(JSON.stringify({
        success: false, error: 'thread_id取得失敗', responseSnippet: bodyText.substring(0, 200)
      })).setMimeType(ContentService.MimeType.JSON);
    }
    return ContentService.createTextOutput(JSON.stringify({
      success: true, thread_id: threadId, thread_name: threadName
    })).setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({
      success: false, error: err.message
    })).setMimeType(ContentService.MimeType.JSON);
  }
}

/**
 * SUUMO候補物件のDiscord通知を送信
 * @param {Array} newProperties - addSuumoCandidates()の戻り値のnewProperties
 * @param {string} criteriaName - 巡回条件名
 * @param {string} threadId - 既存スレッドID(巡回開始時に作成済みなら指定。そのスレッドに投稿)
 */
function sendSuumoDiscordNotification(newProperties, criteriaName, threadId) {
  // 実行時にスクリプトプロパティから取得
  var webhookUrl = PropertiesService.getScriptProperties().getProperty('SUUMO_DISCORD_WEBHOOK_URL') || '';
  console.log('sendSuumoDiscordNotification: webhookUrl=' + (webhookUrl ? webhookUrl.substring(0, 50) + '...' : '(空)') + ', props=' + newProperties.length);

  if (!webhookUrl) {
    console.log('sendSuumoDiscordNotification: webhookUrlが空のため送信スキップ');
    return { sent: 0, skipped: true, reason: 'webhook_url_empty' };
  }
  if (newProperties.length === 0) {
    return { sent: 0, skipped: true, reason: 'no_properties' };
  }

  var gasUrl = ScriptApp.getService().getUrl();
  var sent = 0;
  var errors = [];

  for (var i = 0; i < newProperties.length; i++) {
    var entry = newProperties[i];
    var p = entry.property;
    var row = entry.row;

    var building = p.building_name || p.buildingName || p.building || '(建物名なし)';
    var room = p.room_number || p.roomNumber || p.room || '';
    var source = p.sourceType || p.source || '';

    // 金額フォーマット（円→万円）
    var fmtMan = function(yen) {
      if (!yen) return '';
      var v = parseFloat(yen);
      if (isNaN(v)) return String(yen);
      if (v >= 10000) return String(parseFloat((v / 10000).toFixed(4))) + '万円';
      return String(v) + '円';
    };

    var rentDisplay = p.rent ? fmtMan(p.rent) : '不明';
    var mgmtFeeRaw = p.management_fee || p.managementFee || p.commonServiceFee || '';
    var mgmtFee = mgmtFeeRaw ? fmtMan(mgmtFeeRaw) : '';
    var layout = p.layout || ((p.madoriRoomCount || '') + (p.madoriType || ''));
    var area = p.area || p.usageArea || '';
    // 住所: itandi等はp.address、SUUMOはpref+addr1+addr2
    var address = p.address || ((p.pref || '') + (p.addr1 || '') + (p.addr2 || ''));
    // 交通: itandi/essquare等はp.station_info文字列、SUUMOはp.access配列
    var stationInfo = p.station_info || '';
    if (!stationInfo && p.access && p.access.length > 0) {
      stationInfo = (p.access[0].line || '') + ' ' + (p.access[0].station || '') + '駅 徒歩' + (p.access[0].walk || '') + '分';
    }
    var otherStations = (p.other_stations && p.other_stations.length > 0) ? p.other_stations : [];

    var approveUrl = gasUrl + '?action=suumo_approve&key=' + encodeURIComponent(row[0]);

    // 警告アラート（ANSI黄色コードブロックで表示）
    var warnings = [];
    var adKeisai = p.ad_keisai || p.adKeisai || '';
    if (adKeisai && String(adKeisai).trim() !== '可') {
      warnings.push('⚠️ 広告掲載: ' + String(adKeisai).trim() + '（SUUMO広告掲載の確認が必要です）');
    }

    // 申込有無の警告（listing_status が「申込あり」「申込N件」等なら元付に確認が必要）
    var listingStatus = p.listing_status ? String(p.listing_status).trim() : '';
    if (listingStatus && (listingStatus === '申込あり' || /^申込\d+件$/.test(listingStatus) || /申込/.test(listingStatus))) {
      warnings.push('⚠️ 募集状況: ' + listingStatus);
    }

    // メッセージ組立
    var msgLines = [];
    msgLines.push('**🏠 新着SUUMO候補物件**');
    msgLines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    msgLines.push('**' + building + '  ' + room + '号室** `[' + source + ']`');
    var rentLine = '賃料: **' + rentDisplay + '**';
    if (mgmtFee) rentLine += ' (管理費: ' + mgmtFee + ')';
    msgLines.push(rentLine);
    if (layout) msgLines.push('間取り: ' + layout);
    if (area) msgLines.push('面積: ' + area + 'm²');
    if (p.building_age) msgLines.push('築年: ' + p.building_age);
    if (address) msgLines.push('住所: ' + address);
    if (stationInfo) msgLines.push('交通: ' + stationInfo);
    if (otherStations.length > 0) msgLines.push('他の路線: ' + otherStations.join(' / '));
    if (p.floor_text || p.story_text) {
      msgLines.push('階数: ' + (p.floor_text || '?') + '/' + (p.story_text || '?'));
    }
    if (p.deposit || p.key_money) {
      msgLines.push('敷金: ' + (p.deposit || 'なし') + ' / 礼金: ' + (p.key_money || 'なし'));
    }
    if (p.move_in_date) msgLines.push('入居: ' + p.move_in_date);
    if (p.reins_property_number) msgLines.push('物件番号: ' + p.reins_property_number);
    if (p.ad_fee) msgLines.push('広告料: ' + p.ad_fee);
    if (p.current_status) msgLines.push('現況: ' + p.current_status);
    else if (p.listing_status) msgLines.push('現況: ' + p.listing_status);
    var ownerCompany = p.owner_company || p.reins_shougo || '';
    var ownerPhone = p.owner_phone || p.reins_tel || '';
    if (ownerCompany) msgLines.push('元付: ' + ownerCompany + (ownerPhone ? ' (' + ownerPhone + ')' : ''));

    // SUUMO競合数（Chrome拡張のsuumo-competitor.jsが事前にprop.suumo_competitorをアタッチ）
    if (p.suumo_competitor && typeof p.suumo_competitor === 'object') {
      var sc = p.suumo_competitor;
      var compLine = '🏙️ SUUMO競合: 物件名あり:' + (sc.withName || 0) + '件(うちハイライト' + (sc.withNameHighlighted || 0) + '件)'
                   + ' / なし:' + (sc.withoutName || 0) + '件(うちハイライト' + (sc.withoutNameHighlighted || 0) + '件)';
      msgLines.push(compLine);
      if (sc.url) msgLines.push('[🔍 SUUMO検索結果](' + sc.url + ')');
    }

    // 画像枚数カウント（11枚以下なら警告）
    var imageCount = 0;
    if (p.image_urls && Array.isArray(p.image_urls)) imageCount = p.image_urls.length;
    else if (p.imageUrls && Array.isArray(p.imageUrls)) imageCount = p.imageUrls.length;
    if (imageCount === 0 && p.image_url) imageCount = 1;
    if (imageCount <= 11) {
      warnings.push('⚠️ 画像: ' + imageCount + '枚（11枚以下なので要確認）');
    }

    if (warnings.length > 0) {
      msgLines.push('```ansi\n\u001b[0;33m' + warnings.join('\n') + '\u001b[0m\n```');
    }

    msgLines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    // 元サイトリンク（ディスコに元ページのリンクを入れる）
    if (p.url) {
      msgLines.push('[🔗 詳細ページ](' + p.url + ')');
    } else if (p.reins_property_number) {
      var cleanNum = String(p.reins_property_number).replace(/\D/g, '');
      msgLines.push('[🔗 REINSで開く](https://system.reins.jp/main/BK/GBK004100#bukken=' + cleanNum + ')');
    }
    msgLines.push('[📋 承認ページを開く](' + approveUrl + ')');
    msgLines.push('巡回条件: ' + (criteriaName || '不明'));

    var content = msgLines.join('\n');

    // threadId 指定があれば既存スレッドに投稿、無ければ従来通り forum で新スレッド作成
    var payload = { content: content };
    var postUrl = webhookUrl;
    if (threadId) {
      // forum スレッドに追記: ?thread_id=xxx を付ける
      postUrl = webhookUrl + (webhookUrl.indexOf('?') >= 0 ? '&' : '?') + 'thread_id=' + encodeURIComponent(threadId);
    } else {
      // 後方互換: thread_id無しなら毎回新スレッド作成(Discord forum)
      payload.thread_name = building + ' ' + room + '号室 - ' + rentDisplay;
    }

    // 429/5xxは指数バックオフでリトライ（最大3回）
    var sendSuccess = false;
    var lastErrMsg = '';
    for (var attempt = 0; attempt < 3; attempt++) {
      try {
        var resp = UrlFetchApp.fetch(postUrl, {
          method: 'post',
          contentType: 'application/json',
          payload: JSON.stringify(payload),
          muteHttpExceptions: true
        });
        var respCode = resp.getResponseCode();
        console.log('Discord送信 #' + (i+1) + ' attempt=' + (attempt+1) + ': HTTP ' + respCode);
        if (respCode >= 200 && respCode < 300) {
          sent++;
          sendSuccess = true;
          // 送信成功を物件行にマーク（未通知フラグを消して、次回巡回での再送対象から外す）
          if (entry && entry._sheetRowIndex) {
            try { markSuumoCandidateAsDiscordSent_(entry._sheetRowIndex); } catch (e) {}
          }
          break;
        }
        lastErrMsg = 'HTTP ' + respCode + ': ' + resp.getContentText().substring(0, 100);
        // 429 or 5xx: リトライ
        if (respCode === 429 || respCode >= 500) {
          // Retry-After header を尊重
          var headers = resp.getAllHeaders();
          var retryAfter = parseFloat(headers['Retry-After'] || headers['retry-after'] || '0');
          // Discord JSON body に retry_after がある場合も対応
          try {
            var body = JSON.parse(resp.getContentText());
            if (body.retry_after) retryAfter = Math.max(retryAfter, parseFloat(body.retry_after));
          } catch (e) {}
          // Cloudflare 1015 は長めに待つ
          var waitMs;
          if (retryAfter > 0) {
            waitMs = Math.ceil(retryAfter * 1000);
          } else {
            // 指数バックオフ: 5s, 15s, 45s
            waitMs = Math.min(5000 * Math.pow(3, attempt), 60000);
          }
          // GAS Utilities.sleep() の最大値は300000ms。それより手前の60秒で打ち切って
          // 次回巡回に回す（Cloudflare 1015 は数十分待たないと解除されないため）
          var MAX_RETRY_WAIT_MS = 60000;
          if (waitMs > MAX_RETRY_WAIT_MS) {
            lastErrMsg = 'Retry-After過大: ' + Math.round(waitMs / 1000) + 's（次回巡回で再送）';
            console.log('Discord 429/5xx: ' + lastErrMsg + ' — この物件のリトライ打ち切り');
            break;
          }
          console.log('Discord 429/5xx: ' + waitMs + 'ms待機後リトライ');
          Utilities.sleep(waitMs);
          continue;
        }
        // その他のエラーはリトライしない
        break;
      } catch (err) {
        console.error('SUUMO Discord通知失敗: ' + err.message);
        lastErrMsg = err.message;
        Utilities.sleep(2000);
      }
    }
    if (!sendSuccess) {
      errors.push(lastErrMsg);
    }
    // 次の物件送信前にレートリミット対策のウェイト
    // 1回のGAS呼び出しで複数物件を送る場合(未通知再送など)もレート制限に刺さらないよう
    // 全ソース一律8秒(Chrome拡張側のsendCollectorと同じ)
    if (i < newProperties.length - 1) {
      Utilities.sleep(8000);
    }
  }

  return { sent: sent, errors: errors };
}

// ═══════════════════════════════════════════════════════════
// 6. doGet/doPost ハンドラー（コード.js から呼ばれる）
// ═══════════════════════════════════════════════════════════

/**
 * GET: 巡回条件一覧を返す
 */
function handleGetPatrolCriteria(e) {
  if (!_validateReinsApiKey(e.parameter.api_key)) {
    return ContentService.createTextOutput(JSON.stringify({ error: 'unauthorized' }))
      .setMimeType(ContentService.MimeType.JSON);
  }

  var allCriteria = getPatrolCriteria();
  var activeCriteria = allCriteria.filter(function(c) { return c.enabled; });
  console.log('handleGetPatrolCriteria: 全' + allCriteria.length + '件, 有効' + activeCriteria.length + '件');
  if (allCriteria.length > 0) {
    console.log('先頭条件 enabled値: ' + JSON.stringify(allCriteria[0].enabled) + ', 生データ8列目確認用');
  }
  return ContentService.createTextOutput(JSON.stringify({
    criteria: activeCriteria,
    debug: { total: allCriteria.length, active: activeCriteria.length }
  }))
    .setMimeType(ContentService.MimeType.JSON);
}

/**
 * GET: 承認済みキュー（Chrome拡張のポーリング用）
 * - lock=true: 取得と同時にsubmittingへロック（拡張が入稿開始する時に使用）
 * - lock=false or 未指定: 閲覧のみ（古い呼び出し互換）
 */
function handleGetSuumoQueue(e) {
  if (!_validateReinsApiKey(e.parameter.api_key)) {
    return ContentService.createTextOutput(JSON.stringify({ error: 'unauthorized' }))
      .setMimeType(ContentService.MimeType.JSON);
  }

  // 24h に 1 回、 14日経過した stopped 行を自動削除する (掲載管理シートの掃除)
  // SUUMO 巡回・入稿の度に呼ばれる関数なので、 ここで定期掃除のフックを置くのが
  // ユーザーが何もしなくても自動で掃除されて都合が良い。
  try { maybePurgeOldStoppedListings_(); } catch (_) {}

  var shouldLock = e.parameter.lock === 'true' || e.parameter.lock === '1';
  var queue = shouldLock ? getAndLockSuumoApprovalQueue() : getSuumoApprovalQueue();
  var listingCount = getActiveListingCount();
  // 50件超過時のみ候補を計算(計算コスト節約)
  // 標準保護ルールで 0 件なら段階的に緩めて必ず 1 件以上返すようにする
  // (50件埋まり + 全員保護対象 で詰む状態の自動回避)
  var relaxResult = listingCount >= 50
    ? findStopCandidatesWithGracefulRelax(10)
    : { candidates: [], finalLevel: 0 };
  var stopCandidates = relaxResult.candidates;
  var stopCandidate = stopCandidates.length > 0 ? stopCandidates[0] : null;

  return ContentService.createTextOutput(JSON.stringify({
    queue: queue,
    locked: shouldLock,
    activeListingCount: listingCount,
    stopCandidate: stopCandidate,       // 後方互換(旧Chrome拡張が読む単数)
    stopCandidates: stopCandidates,     // 新API: 上位10件のリスト
    stopCandidateRelaxLevel: relaxResult.finalLevel  // どの保護段階で拾ったか (0=標準/3=保護無視)
  })).setMimeType(ContentService.MimeType.JSON);
}

/**
 * POST: 候補物件追加
 */
function handleAddSuumoCandidate(json) {
  console.log('handleAddSuumoCandidate: ' + (json.properties || []).length + '件受信');
  var result = addSuumoCandidates(json);
  console.log('addSuumoCandidates結果: added=' + result.added + ', dup=' + result.duplicates + ', newProps=' + (result.newProperties || []).length);

  var webhookUrl = PropertiesService.getScriptProperties().getProperty('SUUMO_DISCORD_WEBHOOK_URL') || '';
  console.log('SUUMO_DISCORD_WEBHOOK_URL: ' + (webhookUrl ? webhookUrl.substring(0, 50) + '...' : '(未設定)'));

  // 顧客検索と同じく「今来た物件のみ通知」とする。
  // 旧実装は過去24時間の未通知物件を毎回再送していたが、Discord rate limit時に
  // 失敗が雪だるま式に積み上がって avalanche を起こしていた(同じ物件を毎回再送→
  // どんどん未通知が増える→1物件あたりN件送信になる→レート制限で1時間Ban)。
  // 顧客検索ではこの再送ロジックがなく問題が起きていないため、踏襲する。
  // result.newProperties はそのまま使う(新着のみ)

  // 巡回条件名を取得
  var criteriaName = '';
  if (json.patrolCriteriaId) {
    var criteria = getPatrolCriteria();
    for (var i = 0; i < criteria.length; i++) {
      if (criteria[i].id === json.patrolCriteriaId) {
        criteriaName = criteria[i].name;
        break;
      }
    }
  }

  // Discord通知は GAS 側では一切送らず、Chrome拡張側でユーザーIPから送る形に変更。
  // 理由: GAS共用IPプールが他のユーザーの乱用で Cloudflare 1015 にフラグされるのを回避するため。
  // Chrome拡張で必要な情報をレスポンスに含めて返す:
  //   - newProperties: 各物件の row(主キーつき) と property オブジェクト
  //   - criteriaName: 巡回条件名(メッセージに使う)
  //   - gasUrl: 承認URLを Chrome拡張側で構築するために返す
  var gasUrl = ScriptApp.getService().getUrl();
  var notifyProps = [];
  if (result.newProperties) {
    for (var np = 0; np < result.newProperties.length; np++) {
      var entry = result.newProperties[np];
      notifyProps.push({
        key: entry.row && entry.row[0],
        property: entry.property,
        sheetRowIndex: entry._sheetRowIndex || null
      });
    }
  }

  return ContentService.createTextOutput(JSON.stringify({
    success: true,
    added: result.added,
    duplicates: result.duplicates,
    webhookSet: !!webhookUrl,
    // Chrome拡張がユーザーIPからDiscord送信するための情報
    notifyProps: notifyProps,
    criteriaName: criteriaName,
    gasUrl: gasUrl,
    discordWebhookUrl: webhookUrl
  })).setMimeType(ContentService.MimeType.JSON);
}

/**
 * POST: SUUMO承認確定
 */
function handleConfirmSuumoApprove(json) {
  var key = json.key;
  var imageGenresJson = json.imageGenres ? JSON.stringify(json.imageGenres) : '';

  var result = approveSuumoCandidate(key, imageGenresJson);
  return ContentService.createTextOutput(JSON.stringify(result))
    .setMimeType(ContentService.MimeType.JSON);
}

/**
 * POST: SUUMO入稿完了
 */
function handleSuumoPostComplete(json) {
  var result = recordSuumoPosting(json);
  return ContentService.createTextOutput(JSON.stringify(result))
    .setMimeType(ContentService.MimeType.JSON);
}

/**
 * POST: 候補物件の反響予測スコアを一括更新
 * Chrome拡張側で Discord 通知後にまとめて送信される。
 * payload: { action: 'update_candidate_inquiry_scores', updates: [{key, score}, ...] }
 */
function handleUpdateSuumoCandidateInquiryScores(json) {
  var updates = (json && json.updates) || [];
  if (!Array.isArray(updates) || updates.length === 0) {
    return ContentService.createTextOutput(JSON.stringify({ success: true, updated: 0 }))
      .setMimeType(ContentService.MimeType.JSON);
  }
  var sheet = getCandidateSheet_();
  var lastRow = sheet.getLastRow();
  if (lastRow <= 1) {
    return ContentService.createTextOutput(JSON.stringify({ success: true, updated: 0 }))
      .setMimeType(ContentService.MimeType.JSON);
  }
  var keyCol = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
  var keyToRow = {};
  for (var i = 0; i < keyCol.length; i++) keyToRow[keyCol[i][0]] = i + 2;
  var scoreColIdx = SUUMO_CANDIDATE_HEADERS.indexOf('反響予測スコア') + 1;  // 1-indexed
  if (scoreColIdx <= 0) {
    return ContentService.createTextOutput(JSON.stringify({ success: false, message: '反響予測スコア列が見つからない' }))
      .setMimeType(ContentService.MimeType.JSON);
  }
  var updated = 0;
  for (var u = 0; u < updates.length; u++) {
    var k = updates[u] && updates[u].key;
    if (!k) continue;
    var row = keyToRow[k];
    if (!row) continue;
    var score = Number(updates[u].score);
    if (isNaN(score)) continue;
    sheet.getRange(row, scoreColIdx).setValue(score);
    updated++;
  }
  return ContentService.createTextOutput(JSON.stringify({ success: true, updated: updated }))
    .setMimeType(ContentService.MimeType.JSON);
}

/**
 * POST: パフォーマンスデータ更新
 */
function handleUpdateSuumoPerformance(json) {
  var result = updateSuumoPerformance(json.updates || []);
  return ContentService.createTextOutput(JSON.stringify(result))
    .setMimeType(ContentService.MimeType.JSON);
}

/**
 * POST: 掲載停止
 */
function handleStopSuumoListing(json) {
  var result = stopSuumoListing(json.key);
  return ContentService.createTextOutput(JSON.stringify(result))
    .setMimeType(ContentService.MimeType.JSON);
}

/**
 * POST: 重複行をいっぺんに削除 (メンテナンス用)
 *
 * curl 例:
 *   curl -X POST "$GAS_URL" -H "Content-Type: application/json" \
 *     -d '{"action":"cleanup_duplicate_listings","dryRun":true}'
 */
function handleCleanupDuplicateListings(json) {
  var result = cleanupDuplicateListings({ dryRun: !!json.dryRun });
  return ContentService.createTextOutput(JSON.stringify(result))
    .setMimeType(ContentService.MimeType.JSON);
}

/**
 * POST: ForRent PUB1R2801 から取得した「掲載中物件」リストをシートに反映
 *
 * Chrome拡張側で「掲載物件のみ」フィルタを適用してスクレイプしているため、
 * 受け取る rows は「現在実際に掲載中の物件」集合となる。
 *
 * 処理:
 *   A. 取得された suumoCode で既存の stopped 行が見つかれば → active に復活
 *      (手動で再開/再入稿した物件に対応)
 *   B. 受信セットに含まれないシート上の active 行 → 既にSUUMO掲載終了と判定
 *      → stopped化し、停止日に '(ForRent直読み)' を付記
 *
 * 安全ガード:
 *   - 取得件数 < 10 件は自動消去しない(部分fetch疑い)
 *   - 消去候補が active総数の 50% 超なら中止(API障害対策)
 */
function handleSyncForrentListingStatus(json) {
  var rows = (json && json.rows) || [];
  var fetchedAt = json && json.fetchedAt ? String(json.fetchedAt) : '';

  if (!Array.isArray(rows) || rows.length === 0) {
    return ContentService.createTextOutput(JSON.stringify({
      success: true, received: 0, stopped: 0, reactivated: 0, unmatched: 0, skipped: 'empty'
    })).setMimeType(ContentService.MimeType.JSON);
  }

  var sheet = getListingSheet_();
  var lastRow = sheet.getLastRow();
  if (lastRow <= 1) {
    return ContentService.createTextOutput(JSON.stringify({
      success: true, received: rows.length, stopped: 0, reactivated: 0, unmatched: rows.length
    })).setMimeType(ContentService.MimeType.JSON);
  }

  var headerLen = SUUMO_LISTING_HEADERS.length;
  var data = sheet.getRange(2, 1, lastRow - 1, headerLen).getValues();

  // 受信側: suumo_property_code のセット(掲載中物件)
  var liveCodeSet = {};
  for (var r = 0; r < rows.length; r++) {
    var c = String((rows[r] || {}).suumoCode || '').replace(/[^0-9]/g, '');
    if (c && c.length === 12) liveCodeSet[c] = true;
  }

  var now;
  if (fetchedAt) {
    var dd = new Date(fetchedAt);
    now = isNaN(dd.getTime())
      ? Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd HH:mm:ss')
      : Utilities.formatDate(dd, 'Asia/Tokyo', 'yyyy-MM-dd HH:mm:ss');
  } else {
    now = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd HH:mm:ss');
  }

  var stopped = 0;
  var reactivated = 0;
  var unmatched = 0; // 受信側で、シートに suumo_property_code が一致しないコードの件数
  var inserted = 0;  // 未マッチ行をシートに新規追加した件数
  var healed = 0;    // 既存 active 行の空 suumo_code を ForRent 直読み値で補完した件数
  var autoStopSkipReason = '';

  // A. stopped 復活 + 新規物件の追加
  //    マッチ判定のために codeToSheetRow マップ構築
  //    さらに、シートに無い suumoCode は新規行としてinsert(掲載開始日=今日)
  var codeToSheetRow = {};
  // 補助マップ: 「propertyKey → { sheetRow, hasCode }」(active かつ suumo_code 空の行を特定するため)
  // SUUMO の完了画面 DOM が想定外で Phase5/Phase6 とも regex 不一致 → 空コードのまま
  // appendRow されてしまうケースの自動修復用。
  var keyToEmptyCodeRow = {};
  for (var i = 0; i < data.length; i++) {
    var code = String(data[i][10] || '').replace(/[^0-9]/g, '');
    if (code) codeToSheetRow[code] = { sheetRow: i + 2, status: data[i][8] };
    if (!code && data[i][8] === 'active') {
      var emptyKey = String(data[i][0] || '');
      if (emptyKey) keyToEmptyCodeRow[emptyKey] = { sheetRow: i + 2 };
    }
  }

  // 受信rowsを suumoCode → { buildingName, roomNo, rent } のマップに変換
  // (scrape時に建物名/部屋番号/賃料も取っているため、これを使って新規挿入する)
  var codeToMeta = {};
  for (var rr = 0; rr < rows.length; rr++) {
    var row = rows[rr] || {};
    var c = String(row.suumoCode || '').replace(/[^0-9]/g, '');
    if (c && c.length === 12) {
      codeToMeta[c] = {
        buildingName: String(row.buildingName || ''),
        roomNo: String(row.roomNo || ''),
        rent: String(row.rent || ''),
      };
    }
  }

  for (var c2 in liveCodeSet) {
    var t = codeToSheetRow[c2];
    if (t) {
      // 既存マッチ: stopped → active 復活
      if (t.status === 'stopped') {
        sheet.getRange(t.sheetRow, 9).setValue('active');
        sheet.getRange(t.sheetRow, 10).setValue('');
        reactivated++;
      }
      continue;
    }
    // 未マッチ: ForRent掲載中なのにシートに無い → 新規行として追加
    // 掲載開始日 = 現在時刻(= 最新のForRent状態同期時刻)。
    // 毎日この同期を回せば、新規入稿物件も最大1日のラグで実日付が入る。
    var meta = codeToMeta[c2] || {};
    var buildingName = meta.buildingName || '';
    var roomNo = meta.roomNo || '';
    var rent = meta.rent || '';
    var propertyKey = normalizeSuumoPropertyKey_(buildingName, roomNo);

    // 自動修復: ForRent側の suumoCode はあるがシートのコード列(11)では未マッチ。
    // しかし「同じ propertyKey の active 行で suumo_code が空」のものが見つかれば、
    // それは Phase5/Phase6 で DOM regex 不一致だった行 → 新規挿入せずに code を補完して終了。
    // これにより「空コード行 + 後日の新規行」という重複発生を構造的にゼロにする。
    if (propertyKey && keyToEmptyCodeRow[propertyKey]) {
      var healRow = keyToEmptyCodeRow[propertyKey].sheetRow;
      sheet.getRange(healRow, 11).setValue(c2);
      delete keyToEmptyCodeRow[propertyKey]; // 同じ key で複数 code に補完されないよう除外
      Logger.log('handleSyncForrentListingStatus: 空コード行を自動修復 row=' + healRow +
                 ' key=' + propertyKey + ' code=' + c2);
      healed++;
      continue;
    }

    var newRow = [
      propertyKey,     // 1  物件キー
      buildingName,    // 2  建物名
      roomNo,          // 3  部屋番号
      now,             // 4  掲載開始日(= 今日、ForRent出現日)
      rent,            // 5  賃料(ForRentから抽出、無ければ空)
      0, 0, 0,         // 6-8 最終PV/問合/スコア(未取得)
      'active',        // 9  ステータス
      '',              // 10 停止日
      c2,              // 11 suumo_property_code
      0, 0, 0,         // 12-14 合計一覧PV/合計詳細PV/問い合わせ数
      0,               // 15 掲載日数(SUUMO)
      0, 0, 0,         // 16-18 競合_第1/第2/第3
      0,               // 19 危険度スコア
      now              // 20 最終取得日時(ここではForRent直読み時刻)
    ];
    sheet.appendRow(newRow);
    inserted++;
    unmatched++;
  }

  // B. 受信セットに含まれない active 行を stopped化
  //    安全ガード: 受信件数<10 or 消去候補が active総数の過半超 なら中止
  if (rows.length < 10) {
    autoStopSkipReason = 'fetch件数(' + rows.length + ')が少なすぎる';
  } else {
    var activeRows = [];
    var stopCandidates = [];
    for (var j = 0; j < data.length; j++) {
      if (data[j][8] !== 'active') continue;
      activeRows.push(j);
      var codeJ = String(data[j][10] || '').replace(/[^0-9]/g, '');
      // suumo_property_code が無い行は判定不能なので残す
      if (!codeJ) continue;
      if (!liveCodeSet[codeJ]) {
        stopCandidates.push(j);
      }
    }
    if (activeRows.length > 0 && stopCandidates.length > activeRows.length / 2) {
      autoStopSkipReason = '消去候補(' + stopCandidates.length + ')がactive総数(' + activeRows.length + ')の半分超';
    } else {
      for (var m = 0; m < stopCandidates.length; m++) {
        var jj = stopCandidates[m];
        sheet.getRange(jj + 2, 9).setValue('stopped');
        sheet.getRange(jj + 2, 10).setValue(now + ' (ForRent直読み)');
        stopped++;
      }
    }
  }

  return ContentService.createTextOutput(JSON.stringify({
    success: true,
    received: rows.length,
    stopped: stopped,
    reactivated: reactivated,
    unmatched: unmatched,
    inserted: inserted,
    healed: healed,
    skipped: autoStopSkipReason
  })).setMimeType(ContentService.MimeType.JSON);
}

/**
 * SUUMO候補物件シートで submitting / approved のまま残っている行を
 * 一括で expired に変更する管理ユーティリティ
 *
 * Chrome拡張の過去バグ(propertyKey↔key mismatch)で submitting のまま残った
 * 物件を一気にクリーンアップする用途。GASエディタから手動実行。
 *
 * 安全策: 実行しても削除はしない(ステータスを expired に変えるのみ)。
 */
function cleanupStaleCandidateStatuses() {
  var sheet = getCandidateSheet_();
  var lastRow = sheet.getLastRow();
  if (lastRow <= 1) return { before: 0, expired: 0 };

  var data = sheet.getRange(2, 1, lastRow - 1, SUUMO_CANDIDATE_HEADERS.length).getValues();
  var changed = 0;
  var counts = { submitting: 0, approved: 0 };
  for (var i = 0; i < data.length; i++) {
    var status = data[i][11];
    if (status === 'submitting' || status === 'approved') {
      counts[status] = (counts[status] || 0) + 1;
      sheet.getRange(i + 2, 12).setValue('expired');
      sheet.getRange(i + 2, 17).setValue(''); // submittingTsクリア
      changed++;
    }
  }
  return { expired: changed, breakdown: counts };
}

/**
 * SUUMO掲載管理シートの不完全行を掃除する管理ユーティリティ
 *
 * ForRent状態同期で新規追加された直後の行は 建物名/部屋番号/賃料 が空欄
 * (suumo_property_code だけ入ってる状態)。本来は次回SUUMOビジネス取得で
 * 埋まるが、バグや取得漏れで残ってしまった行を掃除したい時に使う。
 *
 * GASエディタから手動で cleanupIncompleteSuumoListingRows を実行。
 * 削除はしない、情報出力のみ(削除したい場合はシート上で手動削除)。
 */
function cleanupIncompleteSuumoListingRows() {
  var sheet = getListingSheet_();
  var lastRow = sheet.getLastRow();
  if (lastRow <= 1) return { incomplete: 0 };

  var data = sheet.getRange(2, 1, lastRow - 1, SUUMO_LISTING_HEADERS.length).getValues();
  var incomplete = [];
  for (var i = 0; i < data.length; i++) {
    var building = String(data[i][1] || '').trim();
    var room = String(data[i][2] || '').trim();
    var code = String(data[i][10] || '').trim();
    if (!building && !room && code) {
      incomplete.push({
        row: i + 2,
        suumoCode: code,
        status: data[i][8],
        startDate: data[i][3]
      });
    }
  }
  return { incomplete: incomplete.length, rows: incomplete };
}

/**
 * 掲載管理シートの日時カラムをJST表記に一括修正する管理ユーティリティ
 *
 * Chrome拡張の初期バージョンがISO8601(UTC)のまま書き込んでいた
 * 「掲載開始日」(4列目)と「最終取得日時」(20列目)を JST "yyyy-MM-dd HH:mm:ss" に変換する。
 * 手動実行用(GASエディタから fixSuumoListingTimestampsToJst_ を実行)。
 */
function fixSuumoListingTimestampsToJst_() {
  var sheet = getListingSheet_();
  var lastRow = sheet.getLastRow();
  if (lastRow <= 1) return { updated: 0 };

  var headerLen = SUUMO_LISTING_HEADERS.length;
  var data = sheet.getRange(2, 1, lastRow - 1, headerLen).getValues();
  var updates = 0;

  // ISO形式("2026-04-21T05:37:42.528Z" 等)を JST に変換する
  var toJst = function(v) {
    if (!v) return v;
    var s = String(v);
    // 既にJST表記(2026-04-21 22:00:27)のものは触らない
    if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s)) return v;
    // タイムゾーン付きっぽいものだけ変換
    if (!/T.*Z$|[+-]\d{2}:\d{2}$/.test(s)) return v;
    var d = new Date(s);
    if (isNaN(d.getTime())) return v;
    return Utilities.formatDate(d, 'Asia/Tokyo', 'yyyy-MM-dd HH:mm:ss');
  };

  for (var i = 0; i < data.length; i++) {
    var startAt = data[i][3];   // 4列目: 掲載開始日
    var lastFetch = data[i][19]; // 20列目: 最終取得日時
    var newStart = toJst(startAt);
    var newFetch = toJst(lastFetch);
    if (newStart !== startAt) {
      sheet.getRange(i + 2, 4).setValue(newStart);
      updates++;
    }
    if (newFetch !== lastFetch) {
      sheet.getRange(i + 2, 20).setValue(newFetch);
      updates++;
    }
  }
  return { updated: updates };
}

/**
 * POST: SUUMOビジネス Daily Search からの掲載実績を掲載管理シートに反映(Phase 1)
 * @param {Object} json - { action, fetchedAt, rows: [ { name, room, suumo_code, ... } ] }
 * @returns {TextOutput} { success, updated, inserted, matchedByCode, matchedByKey, unmatched }
 */
function handleUpdateSuumoListingStats(json) {
  var result = updateSuumoListingStats_(json);
  return ContentService.createTextOutput(JSON.stringify(result))
    .setMimeType(ContentService.MimeType.JSON);
}

/**
 * SUUMOビジネスから取得した物件実績を掲載管理シートに反映する内部実装
 *
 * マッチング戦略:
 *   1) 11列目(suumo_property_code)と一致する行があれば上書き
 *   2) 1列目(物件キー=正規化済 建物名|部屋番号) と一致する行があれば上書き、さらに11列目にcodeを記録
 *   3) 上記で見つからなければ「新規検出」として追記(ステータス=active, 掲載開始日=fetchedAt)
 *
 * 既存の10列(1〜10列目)は active/停止 ステータスや掲載開始日などの運用データなので、
 * インサート時のみ埋め、更新時は 6〜8列目(最終PV数/問合数/スコア)だけを上書きする。
 */
function updateSuumoListingStats_(json) {
  var rows = (json && json.rows) || [];
  var fetchedAt = json && json.fetchedAt ? String(json.fetchedAt) : '';
  if (!Array.isArray(rows) || rows.length === 0) {
    return { success: true, updated: 0, inserted: 0, matchedByCode: 0, matchedByKey: 0, unmatched: 0 };
  }

  var sheet = getListingSheet_();
  var lastRow = sheet.getLastRow();
  var headerLen = SUUMO_LISTING_HEADERS.length;

  var existing = [];
  if (lastRow > 1) {
    existing = sheet.getRange(2, 1, lastRow - 1, headerLen).getValues();
  }

  // 既存行のインデックスマップ(codeとkey)
  var codeToRow = {};  // suumo_property_code -> (1-based sheet row)
  var keyToRow = {};   // 物件キー -> (1-based sheet row)
  for (var i = 0; i < existing.length; i++) {
    var sheetRow = i + 2;
    var existingKey = String(existing[i][0] || '');
    var existingCode = String(existing[i][10] || ''); // 11列目 = index 10
    if (existingCode) codeToRow[existingCode] = sheetRow;
    if (existingKey) keyToRow[existingKey] = sheetRow;
  }

  var updated = 0;
  var inserted = 0;
  var matchedByCode = 0;
  var matchedByKey = 0;
  var unmatched = 0;
  // Daily Search結果にマッチしたシート行番号(1-based)を記録
  // 残ったactive行は「SUUMO側で既に掲載終了」と判定して自動stopped化する
  var matchedSheetRows = {};

  // fetchedAt は Chrome拡張から ISO8601(UTC) で送られてくる。JST表記に統一する。
  var now;
  if (fetchedAt) {
    var d = new Date(fetchedAt);
    now = isNaN(d.getTime())
      ? Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd HH:mm:ss')
      : Utilities.formatDate(d, 'Asia/Tokyo', 'yyyy-MM-dd HH:mm:ss');
  } else {
    now = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd HH:mm:ss');
  }

  // 競合履歴 (Phase A+) 用に各物件のスナップショットを集める。
  // ループ終了後にまとめて履歴シートへ append (個別 appendRow より高速)。
  var competitionLogRows = [];

  for (var r = 0; r < rows.length; r++) {
    var row = rows[r] || {};
    var name = String(row.name || '');
    var roomNo = String(row.room || '');
    var suumoCode = String(row.suumo_code || '').replace(/[^0-9]/g, '');
    var listedDays = Number(row.listed_days) || 0;
    var totalListPv = Number(row.total_list_pv) || 0;
    var totalDetailPv = Number(row.total_detail_pv) || 0;
    var inquiries = Number(row.inquiries) || 0;

    // 競合基準値別件数は暫定で整数パースのみ(正しい列が未確定の場合は0になる)
    var compLv1 = parseInt(String(row.comp_lv1_raw || '').replace(/[^0-9]/g, ''), 10) || 0;
    var compLv2 = parseInt(String(row.comp_lv2_raw || '').replace(/[^0-9]/g, ''), 10) || 0;
    var compLv3 = parseInt(String(row.comp_lv3_raw || '').replace(/[^0-9]/g, ''), 10) || 0;

    // 危険度スコア(Phase 2 findStopCandidates と同一式で計算)
    // シート掲載日数は既存行があれば計算できるが、新規insert時はまだ無いので
    // SUUMO掲載日数 listedDays(最大45) で代用。60日ボーナスは既存行更新時に
    // findStopCandidates 側がシート日数で正確に判定するので、ここでは控えめに。
    var weightedComp = (compLv3 * 2.1) + (compLv2 * 1.6) + (compLv1 * 1.0);
    var riskScore = weightedComp * 10
                  - inquiries * 100
                  + (listedDays >= 45 ? 500 : 0);

    var propertyKey = normalizeSuumoPropertyKey_(name, roomNo);
    var targetRow = null;
    var matchBy = '';

    if (suumoCode && codeToRow[suumoCode]) {
      targetRow = codeToRow[suumoCode];
      matchBy = 'code';
      matchedByCode++;
    } else if (propertyKey && keyToRow[propertyKey]) {
      targetRow = keyToRow[propertyKey];
      matchBy = 'key';
      matchedByKey++;
    }

    // 20列分の値(拡張カラム)
    var extended = [
      suumoCode,
      totalListPv,
      totalDetailPv,
      inquiries,
      listedDays,
      compLv1,
      compLv2,
      compLv3,
      riskScore,
      now
    ];

    if (targetRow) {
      // 既存行を更新: 6-8列目(最終PV/問合/スコア)と 11-20列目(拡張カラム)
      // 5列目(賃料)や1-4列目・9-10列目の運用データは触らない
      // パフォーマンススコアは既存ロジックと衝突しないよう、問い合わせ数×10 + 合計詳細PV をセット(更新日時が新しい方として上書き)
      var derivedScore = totalDetailPv + inquiries * 10;
      sheet.getRange(targetRow, 6, 1, 3).setValues([[totalDetailPv, inquiries, derivedScore]]);
      // 11-20列目を更新 (21列目=反響予測スコアは入稿時にセットされたまま保持)
      sheet.getRange(targetRow, 11, 1, extended.length).setValues([extended]);
      updated++;
      matchedSheetRows[targetRow] = true;

      // 競合履歴に append 用エントリ追加 (Phase A+ 時系列トレンド分析用)
      competitionLogRows.push([
        now,
        propertyKey,
        name,
        roomNo,
        compLv1,
        compLv2,
        compLv3,
        totalListPv,
        totalDetailPv,
        inquiries,
        listedDays
      ]);

      // 初マッチ時にsuumo_property_codeを記録済みに更新(キー一致だったケース)
      if (matchBy === 'key' && suumoCode) {
        codeToRow[suumoCode] = targetRow;
      }

      // 建物名(2列目)・部屋番号(3列目)・物件キー(1列目)が空の行は Daily Search の値で埋める。
      // (ForRent状態同期で新規追加された行は建物名/部屋番号が空欄なので、
      //  SUUMOビジネス取得タイミングで正確な値に置き換える)
      var existingBuilding = String(existing[targetRow - 2][1] || '').trim();
      var existingRoom = String(existing[targetRow - 2][2] || '').trim();
      var existingKey = String(existing[targetRow - 2][0] || '').trim();
      if (!existingBuilding && name) {
        sheet.getRange(targetRow, 2).setValue(name);
      }
      if (!existingRoom && roomNo) {
        sheet.getRange(targetRow, 3).setValue(roomNo);
      }
      if (!existingKey && propertyKey) {
        sheet.getRange(targetRow, 1).setValue(propertyKey);
      }
      // 賃料(5列目)も空なら埋める
      var existingRent = String(existing[targetRow - 2][4] || '').trim();
      if (!existingRent && row.rent) {
        sheet.getRange(targetRow, 5).setValue(String(row.rent));
      }

      // ステータス(active/stopped)はSUUMOビジネスデータでは変更しない。
      // Daily Searchは2日前までの集計のため状態判定に使えない。
      // active/stopped の更新は ForRent状態同期(PUB1R2801直読み) の責務。
    } else {
      // 新規検出: フル20列で append
      var derivedScoreNew = totalDetailPv + inquiries * 10;
      var newRow = [
        propertyKey,        // 1  物件キー
        name,               // 2  建物名
        roomNo,             // 3  部屋番号
        now,                // 4  掲載開始日(SUUMOビジネス初検出日時)
        String(row.rent || ''), // 5  賃料
        totalDetailPv,      // 6  最終PV数
        inquiries,          // 7  最終問合数
        derivedScoreNew,    // 8  パフォーマンススコア
        'active',           // 9  ステータス
        ''                  // 10 停止日
      ].concat(extended);
      sheet.appendRow(newRow);
      var newSheetRow = sheet.getLastRow();
      if (suumoCode) codeToRow[suumoCode] = newSheetRow;
      if (propertyKey) keyToRow[propertyKey] = newSheetRow;
      matchedSheetRows[newSheetRow] = true;
      inserted++;
      unmatched++;
    }
  }

  // SUUMOビジネスデータではステータス(active/stopped)を変更しない。
  // Daily Searchは2日前までの集計なので、直近停止物件の状態判定には使えない。
  // active/stopped の同期は ForRent状態同期(PUB1R2801直読み) で別途行う。

  // 競合履歴シートに一括append (Phase A+ 時系列トレンド分析用、Phase B以降で活用)
  var competitionLogged = 0;
  if (competitionLogRows.length > 0) {
    try {
      var compLogSheet = getCompetitionLogSheet_();
      var compLogStart = compLogSheet.getLastRow() + 1;
      compLogSheet.getRange(compLogStart, 1,
                             competitionLogRows.length,
                             SUUMO_COMPETITION_LOG_HEADERS.length)
        .setValues(competitionLogRows);
      competitionLogged = competitionLogRows.length;
    } catch (e) {
      Logger.log('競合履歴 append 失敗: ' + e.message);
    }
  }
  // 90日超の古いログを1日1回だけ削除 (Script Properties で実行日記録)
  _purgeOldCompetitionLogs_();

  return {
    success: true,
    updated: updated,
    inserted: inserted,
    matchedByCode: matchedByCode,
    matchedByKey: matchedByKey,
    unmatched: unmatched,
    receivedRows: rows.length,
    competitionLogged: competitionLogged
  };
}

/**
 * POST: 巡回条件保存（Chrome拡張からのPOST用）
 */
function handleSavePatrolCriteriaPost(json) {
  var result = savePatrolCriteria(json);
  return ContentService.createTextOutput(JSON.stringify(result))
    .setMimeType(ContentService.MimeType.JSON);
}

/**
 * POST: SUUMO Discord Webhook URL をスクリプトプロパティに保存
 */
function handleSetSuumoWebhook(json) {
  if (!_validateReinsApiKey(json.api_key)) {
    return ContentService.createTextOutput(JSON.stringify({ error: 'unauthorized' }))
      .setMimeType(ContentService.MimeType.JSON);
  }

  var webhookUrl = json.webhookUrl || '';
  PropertiesService.getScriptProperties().setProperty('SUUMO_DISCORD_WEBHOOK_URL', webhookUrl);

  return ContentService.createTextOutput(JSON.stringify({ success: true }))
    .setMimeType(ContentService.MimeType.JSON);
}

// ═══════════════════════════════════════════════════════════
// 7. google.script.run 用ラッパー（AdminPage / SuumoApprovalPage から呼ばれる）
// ═══════════════════════════════════════════════════════════

/**
 * AdminPage から呼ばれる: 巡回条件一覧取得
 */
function loadPatrolCriteria() {
  try {
    var result = getPatrolCriteria();
    console.log('loadPatrolCriteria: ' + result.length + '件取得');
    return result;
  } catch (err) {
    console.error('loadPatrolCriteria error: ' + err.message + '\n' + err.stack);
    throw err;
  }
}

/**
 * AdminPage から呼ばれる: 巡回条件保存
 */
function savePatrolCriteriaFromAdmin(data) {
  return savePatrolCriteria(data);
}

/**
 * AdminPage から呼ばれる: 巡回条件削除
 */
function deletePatrolCriteriaFromAdmin(criteriaId) {
  return deletePatrolCriteria(criteriaId);
}

/**
 * SuumoApprovalPage から呼ばれる: 承認確定
 */
function confirmSuumoApproveFromClient(key, imageGenres, featureIds, updatedImageUrls, editedFields) {
  var imageGenresJson = imageGenres ? JSON.stringify(imageGenres) : '';
  var featureIdsJson = featureIds ? JSON.stringify(featureIds) : '';

  var hasImageUpdate = updatedImageUrls && Array.isArray(updatedImageUrls) && updatedImageUrls.length > 0;
  var hasEditedFields = editedFields && typeof editedFields === 'object' && Object.keys(editedFields).length > 0;

  // 手動追加画像 / 承認画面で編集されたフィールドがあれば property_data_json を更新
  if (hasImageUpdate || hasEditedFields) {
    var sheet = getCandidateSheet_();
    var lastRow = sheet.getLastRow();
    if (lastRow > 1) {
      var keys = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
      for (var i = 0; i < keys.length; i++) {
        if (keys[i][0] === key) {
          var row = i + 2;
          var propJson = sheet.getRange(row, 13).getValue();
          try {
            var propData = JSON.parse(propJson);
            if (hasImageUpdate) {
              propData.image_urls = updatedImageUrls;
            }
            if (hasEditedFields) {
              for (var k in editedFields) {
                if (Object.prototype.hasOwnProperty.call(editedFields, k)) {
                  propData[k] = editedFields[k];
                }
              }
            }
            sheet.getRange(row, 13).setValue(JSON.stringify(propData));
          } catch (ex) {
            // パース失敗時はスキップ
          }
          break;
        }
      }
    }
  }

  return approveSuumoCandidate(key, imageGenresJson, featureIdsJson);
}

/**
 * SuumoApprovalPage から呼ばれる: 却下
 */
function rejectSuumoCandidateFromClient(key) {
  return rejectSuumoCandidate(key);
}

/**
 * 掲載中物件数を返す
 */
function getActiveListingCountForClient() {
  return getActiveListingCount();
}

/**
 * AdminPage から呼ばれる: SUUMO巡回条件管理ページのURLを返す
 */
function getSuumoPatrolConfigUrl() {
  var baseUrl = ScriptApp.getService().getUrl();
  var apiKey = PropertiesService.getScriptProperties().getProperty('REINS_API_KEY') || '';
  return baseUrl + '?action=suumo_patrol_config&api_key=' + encodeURIComponent(apiKey);
}

/**
 * SuumoPatrolConfigPage から呼ばれる: 管理ページURLを返す
 */
function getAdminPageUrl() {
  var baseUrl = ScriptApp.getService().getUrl();
  var apiKey = PropertiesService.getScriptProperties().getProperty('REINS_API_KEY') || '';
  return baseUrl + '?action=admin&api_key=' + encodeURIComponent(apiKey);
}

// ═══════════════════════════════════════════════════════════
// AdminPage 用: submitting 状態の物件管理（手動入稿完了報告）
// ═══════════════════════════════════════════════════════════

/**
 * submitting 状態のまま放置されている候補物件をリスト化
 * AdminPage.html から google.script.run 経由で呼ばれる。
 * - submitting タイムアウト(30分)を超過した行のみ返す
 * - 各行に経過時間(分)を付与
 */
function listSubmittingProperties() {
  var sheet = getCandidateSheet_();
  var lastRow = sheet.getLastRow();
  if (lastRow <= 1) return [];

  var data = sheet.getRange(2, 1, lastRow - 1, SUUMO_CANDIDATE_HEADERS.length).getValues();
  var nowMs = Date.now();
  var results = [];

  for (var i = 0; i < data.length; i++) {
    var status = data[i][11]; // 12列目: ステータス
    if (status !== 'submitting') continue;

    var submittingTsRaw = data[i][16]; // 17列目: submittingTs
    var submittingMs = 0;
    if (submittingTsRaw instanceof Date) {
      submittingMs = submittingTsRaw.getTime();
    } else if (submittingTsRaw) {
      var dd = new Date(submittingTsRaw);
      if (!isNaN(dd.getTime())) submittingMs = dd.getTime();
    }
    var ageMs = submittingMs ? (nowMs - submittingMs) : 0;
    var ageMin = Math.floor(ageMs / 60000);

    var foundAtRaw = data[i][9]; // 10列目: 検出日時
    var foundAt = '';
    if (foundAtRaw instanceof Date) {
      foundAt = Utilities.formatDate(foundAtRaw, 'Asia/Tokyo', 'yyyy-MM-dd HH:mm:ss');
    } else if (foundAtRaw) {
      foundAt = String(foundAtRaw);
    }

    var submittingAt = '';
    if (submittingMs) {
      submittingAt = Utilities.formatDate(new Date(submittingMs), 'Asia/Tokyo', 'yyyy-MM-dd HH:mm:ss');
    }

    results.push({
      key: String(data[i][0] || ''),
      building: String(data[i][1] || ''),
      room: String(data[i][2] || ''),
      address: String(data[i][3] || ''),
      rent: data[i][4] || '',
      layout: String(data[i][6] || ''),
      station: String(data[i][8] || ''),
      foundAt: foundAt,
      submittingAt: submittingAt,
      ageMin: ageMin,
      isTimeout: ageMs >= SUUMO_SUBMITTING_TIMEOUT_MS,
      rowIndex: i + 2
    });
  }

  // 新しい submitting 順にソート（経過時間が長いものが上）
  results.sort(function(a, b) { return b.ageMin - a.ageMin; });
  return results;
}

/**
 * 手動で入稿完了したものとしてマーク（AdminPage の「手動入稿完了」ボタンから呼ばれる）
 * 候補物件シートから building/room/rent を取得して recordSuumoPosting を呼ぶ。
 * 結果: submitting → posted + SUUMO 掲載管理シートに行追加
 */
function markSuumoManuallyPosted(propertyKey) {
  if (!propertyKey) return { success: false, message: 'propertyKey未指定' };

  var sheet = getCandidateSheet_();
  var lastRow = sheet.getLastRow();
  if (lastRow <= 1) return { success: false, message: '候補物件シートが空' };

  var data = sheet.getRange(2, 1, lastRow - 1, SUUMO_CANDIDATE_HEADERS.length).getValues();
  var target = null;
  for (var i = 0; i < data.length; i++) {
    if (String(data[i][0]) === String(propertyKey)) {
      target = {
        key: data[i][0],
        building: data[i][1],
        room: data[i][2],
        rent: data[i][4],
        status: data[i][11]
      };
      break;
    }
  }
  if (!target) return { success: false, message: '該当物件が候補シートに見つかりません: ' + propertyKey };

  // submitting でなくても許可するが、ログ出力
  if (target.status !== 'submitting') {
    Logger.log('markSuumoManuallyPosted: status=' + target.status + ' (submittingではないが処理続行) key=' + propertyKey);
  }

  // recordSuumoPosting を呼んで通常の post_complete(success:true) と同じ処理を実行
  var result = recordSuumoPosting({
    key: target.key,
    building: target.building,
    room: target.room,
    rent: target.rent,
    success: true
  });
  return result;
}

/**
 * 手動で却下扱いに戻す（submittingロックを解除して approved に戻す）
 * AdminPage の「却下扱いで戻す」ボタンから呼ばれる。
 */
function unlockSubmittingProperty(propertyKey) {
  if (!propertyKey) return { success: false, message: 'propertyKey未指定' };
  // recordSuumoPosting に success:false を渡すと submitting → approved に戻す
  var result = recordSuumoPosting({ key: propertyKey, success: false });
  return result;
}

// ═══════════════════════════════════════════════════════════
// SUUMO承認画面用: 画像アップロード（imgbb）
// ═══════════════════════════════════════════════════════════
/**
 * SUUMO承認画面から呼ばれる画像アップロード
 * base64データを画像ホスティングにアップロードしてURLを返す
 * 優先順: Telegra.ph → freeimage.host → imgbb
 */
/**
 * SuumoApprovalPage.html のブラウザJSから google.script.run 経由で呼ばれる。
 * スクリプトプロパティ IMGBB_API_KEY を返すだけ。ブラウザ側からimgbbへ直接
 * アップロードするときに使う(ユーザーIPを使うためGAS共有IPのレート制限を回避)。
 * 個人キー未設定時は空文字列を返す。
 *
 * 名前に _ を入れないことで google.script.run から呼べる状態にしている。
 */
function getImgbbApiKeyForClient() {
  try {
    return PropertiesService.getScriptProperties().getProperty('IMGBB_API_KEY') || '';
  } catch (_) {
    return '';
  }
}

function uploadPropertyImageForSuumo(base64Data, filename, mimeType) {
  var errors = [];
  var decoded = Utilities.base64Decode(base64Data);
  var blob = Utilities.newBlob(decoded, mimeType || 'image/jpeg', filename || 'upload.jpg');

  // スクリプトプロパティ IMGBB_API_KEY に個人キーが設定されているか確認
  var personalImgbbKey = null;
  try {
    personalImgbbKey = PropertiesService.getScriptProperties().getProperty('IMGBB_API_KEY');
  } catch (_) {}

  // -1) imgbb (個人キー設定時のみ最優先)
  //     個人キーなら 32,000回/日・画像容量 32MB まで使えるので、ここで通すのが最速
  if (personalImgbbKey) {
    try {
      var respP = UrlFetchApp.fetch('https://api.imgbb.com/1/upload', {
        method: 'POST',
        payload: {
          key: personalImgbbKey,
          image: base64Data,
          name: (filename || 'upload').replace(/\.[^.]+$/, '')
        },
        muteHttpExceptions: true
      });
      var codeP = respP.getResponseCode();
      var bodyP = respP.getContentText();
      if (codeP === 200) {
        var jsonP = JSON.parse(bodyP);
        if (jsonP && jsonP.success && jsonP.data && jsonP.data.url) {
          return { success: true, url: jsonP.data.url };
        }
        errors.push('imgbb(personal) parse: ' + bodyP.substring(0, 200));
      } else {
        errors.push('imgbb(personal) HTTP ' + codeP + ': ' + bodyP.substring(0, 200));
      }
    } catch (eP) {
      errors.push('imgbb(personal): ' + eP.message);
    }
  }

  // 0) catbox.moe (APIキー不要だが GAS サーバーIPからは412 Invalid uploader の可能性あり)
  try {
    var resp0 = UrlFetchApp.fetch('https://catbox.moe/user/api.php', {
      method: 'POST',
      payload: {
        reqtype: 'fileupload',
        fileToUpload: blob
      },
      muteHttpExceptions: true
    });
    var code0 = resp0.getResponseCode();
    var body0 = resp0.getContentText();
    // catboxはプレーンテキストで https://files.catbox.moe/xxxxxx.jpg を返す
    if (code0 === 200 && body0 && body0.indexOf('https://') === 0) {
      return { success: true, url: body0.trim() };
    }
    errors.push('catbox HTTP ' + code0 + ': ' + body0.substring(0, 200));
  } catch (e0) {
    errors.push('catbox: ' + e0.message);
  }

  // 1) Telegra.ph（APIキー不要、ただし2022年以降spam対策で事実上ほぼ失敗する）
  try {
    var resp1 = UrlFetchApp.fetch('https://telegra.ph/upload', {
      method: 'POST',
      payload: { file: blob },
      muteHttpExceptions: true
    });
    var code1 = resp1.getResponseCode();
    var body1 = resp1.getContentText();
    if (code1 === 200) {
      var json1 = JSON.parse(body1);
      if (Array.isArray(json1) && json1[0] && json1[0].src) {
        return { success: true, url: 'https://telegra.ph' + json1[0].src };
      }
      errors.push('telegraph parse: ' + body1.substring(0, 200));
    } else {
      errors.push('telegraph HTTP ' + code1 + ': ' + body1.substring(0, 200));
    }
  } catch (e1) {
    errors.push('telegraph: ' + e1.message);
  }

  // 2) freeimage.host（imgbb互換API、別サービス）
  try {
    var resp2 = UrlFetchApp.fetch('https://freeimage.host/api/1/upload', {
      method: 'POST',
      payload: {
        key: '6d207e02198a847aa98d0a2a901485a5',
        source: base64Data,
        format: 'json'
      },
      muteHttpExceptions: true
    });
    var code2 = resp2.getResponseCode();
    var body2 = resp2.getContentText();
    if (code2 === 200) {
      var json2 = JSON.parse(body2);
      if (json2 && json2.image && json2.image.url) {
        return { success: true, url: json2.image.url };
      }
      errors.push('freeimage parse: ' + body2.substring(0, 200));
    } else {
      errors.push('freeimage HTTP ' + code2 + ': ' + body2.substring(0, 200));
    }
  } catch (e2) {
    errors.push('freeimage: ' + e2.message);
  }

  // 3) imgbb（個人APIキー優先、無ければ共有キー）
  // スクリプトプロパティ IMGBB_API_KEY に個人キー(https://api.imgbb.com/ 発行)を
  // 設定すると個別レート枠で使える。未設定なら旧共有キーにフォールバック。
  var imgbbKey = '48cdc51fdcc4a2828c3379b59663db7f'; // 旧共有キー(レート制限常時ヒット中)
  try {
    var personalKey = PropertiesService.getScriptProperties().getProperty('IMGBB_API_KEY');
    if (personalKey) imgbbKey = personalKey;
  } catch (_) {}
  try {
    var resp3 = UrlFetchApp.fetch('https://api.imgbb.com/1/upload', {
      method: 'POST',
      payload: {
        key: imgbbKey,
        image: base64Data,
        name: (filename || 'upload').replace(/\.[^.]+$/, '')
      },
      muteHttpExceptions: true
    });
    var code3 = resp3.getResponseCode();
    var body3 = resp3.getContentText();
    if (code3 === 200) {
      var json3 = JSON.parse(body3);
      if (json3 && json3.success && json3.data && json3.data.url) {
        return { success: true, url: json3.data.url };
      }
      errors.push('imgbb parse: ' + body3.substring(0, 200));
    } else {
      errors.push('imgbb HTTP ' + code3 + ': ' + body3.substring(0, 200));
    }
  } catch (e3) {
    errors.push('imgbb: ' + e3.message);
  }

  return { success: false, message: errors.join(' | ') };
}
