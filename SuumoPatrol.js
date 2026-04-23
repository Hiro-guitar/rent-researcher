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
  '徒歩', '構造JSON', '設備JSON'
];

var SUUMO_CANDIDATE_HEADERS = [
  '物件キー', '建物名', '部屋番号', '住所', '賃料', '管理費', '間取り', '面積',
  '最寄駅', '検出日時', 'ソース', 'ステータス', 'property_data_json',
  '画像ジャンルJSON', '巡回条件ID', 'SUUMO設備チェックJSON',
  'submittingTs', 'discordSentTs'
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
  '危険度スコア', '最終取得日時'
];

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

function getListingSheet_() {
  return getSuumoSheet_(SUUMO_LISTING_SHEET, SUUMO_LISTING_HEADERS);
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

  var areaJson = typeof data.area === 'string' ? data.area : JSON.stringify(data.area || {});
  var layoutsJson = typeof data.layouts === 'string' ? data.layouts : JSON.stringify(data.layouts || []);
  var structuresJson = typeof data.structures === 'string' ? data.structures : JSON.stringify(data.structures || []);
  var equipmentJson = typeof data.equipment === 'string' ? data.equipment : JSON.stringify(data.equipment || []);

  if (data.id) {
    // 既存条件の更新
    var criteria = getPatrolCriteria();
    for (var i = 0; i < criteria.length; i++) {
      if (criteria[i].id === data.id) {
        var row = criteria[i].rowIndex;
        sheet.getRange(row, 2, 1, 7).setValues([[
          data.name || criteria[i].name,
          areaJson,
          data.rentMin || '',
          data.rentMax || '',
          layoutsJson,
          data.areaMin || '',
          data.buildingAge || ''
        ]]);
        // 徒歩・構造・設備 (列12,13,14)
        sheet.getRange(row, 12, 1, 3).setValues([[
          data.walk || '',
          structuresJson,
          equipmentJson
        ]]);
        if (data.enabled !== undefined) {
          sheet.getRange(row, 9).setValue(data.enabled);
        }
        return { success: true, id: data.id, action: 'updated' };
      }
    }
    return { success: false, message: '条件ID ' + data.id + ' が見つかりません' };
  } else {
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
      equipmentJson
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

  var data = sheet.getRange(2, 1, lastRow - 1, SUUMO_CANDIDATE_HEADERS.length).getValues();
  var now = Date.now();
  var recovered = 0;

  for (var i = 0; i < data.length; i++) {
    if (data[i][11] === 'submitting') {
      var ts = Number(data[i][16] || 0);
      if (!ts || (now - ts) > SUUMO_SUBMITTING_TIMEOUT_MS) {
        sheet.getRange(i + 2, 12).setValue('approved');
        sheet.getRange(i + 2, 17).setValue('');
        recovered++;
      }
    }
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
  var key = data.key || '';
  if (!key) return { success: false, message: 'key未指定' };

  // 失敗報告: submittingロックを解除してapprovedに戻す
  if (data.success === false) {
    updateCandidateStatus_(key, 'approved');
    clearSubmittingTimestamp_(key);
    return { success: false, key: key, recovered: true };
  }

  var sheet = getListingSheet_();
  var now = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd HH:mm:ss');

  // 掲載管理シートに追加
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
    ''
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
function findStopCandidates(topN) {
  var limit = topN || 10;
  var sheet = getListingSheet_();
  var lastRow = sheet.getLastRow();
  if (lastRow <= 1) return [];

  var headerLen = SUUMO_LISTING_HEADERS.length;
  var data = sheet.getRange(2, 1, lastRow - 1, headerLen).getValues();
  var now = new Date();

  var candidates = [];
  for (var i = 0; i < data.length; i++) {
    if (data[i][8] !== 'active') continue;

    var suumoListedDays = Number(data[i][14]) || 0; // 15列目: 掲載日数(SUUMO最大45)。参考情報
    var compLv1 = Number(data[i][15]) || 0;  // 16列目: 第1基準値競合数
    var compLv2 = Number(data[i][16]) || 0;  // 17列目: 第2基準値競合数
    var compLv3 = Number(data[i][17]) || 0;  // 18列目: 第3基準値競合数
    var inquiries = Number(data[i][13]) || 0; // 14列目: 問い合わせ数(SUUMOビジネス集計値)
    if (!inquiries) inquiries = Number(data[i][6]) || 0; // フォールバック: 旧7列目

    // シート上での掲載開始日からの経過日数(これが保護・スコア両方の基準)
    var sheetDays = 0;
    var startRaw = data[i][3];
    if (startRaw) {
      var startDate = (startRaw instanceof Date) ? startRaw : new Date(startRaw);
      if (!isNaN(startDate.getTime())) {
        sheetDays = Math.floor((now.getTime() - startDate.getTime()) / (24 * 60 * 60 * 1000));
      }
    }

    // 実効掲載日数 = max(シート日数, SUUMO集計日数)
    // SUUMOビジネス側の「掲載日数」は最大45でcap される。45達成 = 少なくとも
    // 45日以上SUUMO掲載中と判断できる。初期投入でシート日数が浅い物件でも
    // SUUMO側の実績で保護判定/45日ボーナス判定できる。
    var effectiveDays = Math.max(sheetDays, suumoListedDays);

    // 保護判定
    if (effectiveDays < 7) continue;                           // 新着7日保護
    if (inquiries >= 1 && effectiveDays < 45) continue;        // 問合あり&45日未満 保護

    // 危険度スコア
    // 問合は1件あたり -100 (第1基準値競合10件相殺相当)
    // 60日ボーナスは「シート上の実日数」で判定(SUUMO側は45で頭打ちなので識別不能)
    var weightedComp = (compLv3 * 2.1) + (compLv2 * 1.6) + (compLv1 * 1.0);
    var riskScore = weightedComp * 10
                  - inquiries * 100
                  + (sheetDays >= 60 ? 9999 : 0)
                  + (effectiveDays >= 45 ? 500 : 0);

    candidates.push({
      key: data[i][0],
      building: data[i][1],
      room: data[i][2],
      startDate: startRaw,
      rent: data[i][4],
      pv: Number(data[i][12]) || Number(data[i][5]) || 0, // 合計詳細PV優先
      inquiries: inquiries,
      score: riskScore,
      suumoPropertyCode: String(data[i][10] || ''),
      suumoListedDays: suumoListedDays,
      sheetDays: sheetDays,
      compLv1: compLv1,
      compLv2: compLv2,
      compLv3: compLv3,
      rowIndex: i + 2
    });
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
  for (var i = 0; i < keys.length; i++) {
    if (keys[i][0] === key) {
      var row = i + 2;
      sheet.getRange(row, 9).setValue('stopped');
      sheet.getRange(row, 10).setValue(now);
      return { success: true };
    }
  }
  return { success: false, message: '物件が見つかりません' };
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
 * SUUMO候補物件のDiscord通知を送信
 * @param {Array} newProperties - addSuumoCandidates()の戻り値のnewProperties
 * @param {string} criteriaName - 巡回条件名
 */
function sendSuumoDiscordNotification(newProperties, criteriaName) {
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

    var payload = {
      content: content,
      thread_name: building + ' ' + room + '号室 - ' + rentDisplay
    };

    // 429/5xxは指数バックオフでリトライ（最大3回）
    var sendSuccess = false;
    var lastErrMsg = '';
    for (var attempt = 0; attempt < 3; attempt++) {
      try {
        var resp = UrlFetchApp.fetch(webhookUrl, {
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

  var shouldLock = e.parameter.lock === 'true' || e.parameter.lock === '1';
  var queue = shouldLock ? getAndLockSuumoApprovalQueue() : getSuumoApprovalQueue();
  var listingCount = getActiveListingCount();
  // 50件超過時のみ候補を計算(計算コスト節約)
  var stopCandidates = listingCount >= 50 ? findStopCandidates(10) : [];
  var stopCandidate = stopCandidates.length > 0 ? stopCandidates[0] : null;

  return ContentService.createTextOutput(JSON.stringify({
    queue: queue,
    locked: shouldLock,
    activeListingCount: listingCount,
    stopCandidate: stopCandidate,       // 後方互換(旧Chrome拡張が読む単数)
    stopCandidates: stopCandidates      // 新API: 上位10件のリスト
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

  // Cloudflare 1015 等で Discord通知が失敗した過去の物件（24時間以内）も再送対象に加える
  var unsentProps = [];
  try {
    unsentProps = getUnsentSuumoCandidates_(json.patrolCriteriaId || '');
    if (unsentProps.length > 0) {
      console.log('[SUUMO巡回] 未通知物件 ' + unsentProps.length + ' 件を再送対象に追加');
    }
  } catch (e) {
    console.warn('[SUUMO巡回] 未通知物件取得失敗:', e && e.message);
  }
  // 新着の先頭に未通知を追加（古い順、重複は物件キー一致でスキップ）
  var combinedProps = [];
  var seenKeys = {};
  for (var u = 0; u < unsentProps.length; u++) {
    var upkey = unsentProps[u].row && unsentProps[u].row[0];
    if (!upkey || seenKeys[upkey]) continue;
    seenKeys[upkey] = true;
    combinedProps.push(unsentProps[u]);
  }
  for (var v = 0; v < (result.newProperties || []).length; v++) {
    var npkey = result.newProperties[v].row && result.newProperties[v].row[0];
    if (!npkey || seenKeys[npkey]) continue;
    seenKeys[npkey] = true;
    combinedProps.push(result.newProperties[v]);
  }
  result.newProperties = combinedProps;

  // 新着があればDiscord通知
  var discordResult = null;
  if (result.newProperties && result.newProperties.length > 0) {
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
    try {
      discordResult = sendSuumoDiscordNotification(result.newProperties, criteriaName);
    } catch (err) {
      discordResult = { error: err.message };
      console.error('Discord通知例外: ' + err.message);
    }
  }

  return ContentService.createTextOutput(JSON.stringify({
    success: true,
    added: result.added,
    duplicates: result.duplicates,
    discord: discordResult,
    webhookSet: !!webhookUrl
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
  var autoStopSkipReason = '';

  // A. stopped 復活: 受信セットに含まれる code がシート上 stopped なら active に戻す
  //    + マッチ判定のために codeToSheetRow マップ構築
  var codeToSheetRow = {};
  for (var i = 0; i < data.length; i++) {
    var code = String(data[i][10] || '').replace(/[^0-9]/g, '');
    if (code) codeToSheetRow[code] = { sheetRow: i + 2, status: data[i][8] };
  }
  for (var c2 in liveCodeSet) {
    var t = codeToSheetRow[c2];
    if (!t) { unmatched++; continue; }
    if (t.status === 'stopped') {
      sheet.getRange(t.sheetRow, 9).setValue('active');
      sheet.getRange(t.sheetRow, 10).setValue('');
      reactivated++;
    }
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
    skipped: autoStopSkipReason
  })).setMimeType(ContentService.MimeType.JSON);
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
      sheet.getRange(targetRow, 11, 1, extended.length).setValues([extended]);
      updated++;
      matchedSheetRows[targetRow] = true;

      // 初マッチ時にsuumo_property_codeを記録済みに更新(キー一致だったケース)
      if (matchBy === 'key' && suumoCode) {
        codeToRow[suumoCode] = targetRow;
      }

      // マッチ時にステータスが stopped のまま復活したケースに備えて active に戻す
      // (同一物件を再入稿するなどのフロー)
      if (existing[targetRow - 2] && existing[targetRow - 2][8] === 'stopped') {
        sheet.getRange(targetRow, 9).setValue('active');
        sheet.getRange(targetRow, 10).setValue('');
      }
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

  // Daily Search結果に現れなかったactive行を自動でstoppedに変更
  //
  // 理由: SUUMOビジネスの集計は「今日-2日」までなので、この間にSUUMO側で既に
  //       掲載終了した物件はシート上activeのまま残る。Daily Search のレスポンスは
  //       現在SUUMOに掲載中の物件すべてを含むため、レスポンスに現れなかった
  //       active行は「既に掲載終了」と判定できる。
  //
  // 安全ガード:
  //   - fetch件数が少なすぎる(<10件)時は自動消去しない(部分fetchの可能性)
  //   - 消去対象数が全active行の半分超え(>50%)の時も自動消去しない
  //     (万一API障害などで大量の行が消されないよう)
  var autoStopped = 0;
  var autoStoppedSkipReason = '';
  if (rows.length < 10) {
    autoStoppedSkipReason = `fetch件数(${rows.length})が少なすぎる`;
  } else {
    // 消去対象候補をカウント
    var candidateRows = [];
    for (var j = 0; j < existing.length; j++) {
      var sheetRowJ = j + 2;
      var statusJ = existing[j][8];
      if (statusJ === 'active' && !matchedSheetRows[sheetRowJ]) {
        candidateRows.push(sheetRowJ);
      }
    }
    // active総数を計算
    var activeCount = 0;
    for (var k = 0; k < existing.length; k++) {
      if (existing[k][8] === 'active') activeCount++;
    }
    if (activeCount > 0 && candidateRows.length > activeCount / 2) {
      autoStoppedSkipReason = `消去候補(${candidateRows.length})がactive総数(${activeCount})の半分超え→安全のため中止`;
    } else {
      // 実行: 各候補をstoppedに
      for (var m = 0; m < candidateRows.length; m++) {
        var r = candidateRows[m];
        sheet.getRange(r, 9).setValue('stopped');
        sheet.getRange(r, 10).setValue(now + ' (自動)');
        autoStopped++;
      }
    }
  }

  return {
    success: true,
    updated: updated,
    inserted: inserted,
    matchedByCode: matchedByCode,
    matchedByKey: matchedByKey,
    unmatched: unmatched,
    autoStopped: autoStopped,
    autoStoppedSkipReason: autoStoppedSkipReason,
    receivedRows: rows.length
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
function confirmSuumoApproveFromClient(key, imageGenres, featureIds, updatedImageUrls) {
  var imageGenresJson = imageGenres ? JSON.stringify(imageGenres) : '';
  var featureIdsJson = featureIds ? JSON.stringify(featureIds) : '';

  // 手動追加画像がある場合、property_data_json の image_urls を更新
  if (updatedImageUrls && Array.isArray(updatedImageUrls) && updatedImageUrls.length > 0) {
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
            propData.image_urls = updatedImageUrls;
            sheet.getRange(row, 13).setValue(JSON.stringify(propData));
          } catch (ex) {
            // パース失敗時はスキップ（画像URL更新なし）
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
