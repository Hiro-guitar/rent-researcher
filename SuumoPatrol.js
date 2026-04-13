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
  '画像ジャンルJSON', '巡回条件ID'
];

var SUUMO_LISTING_HEADERS = [
  '物件キー', '建物名', '部屋番号', '掲載開始日', '賃料', '最終PV数',
  '最終問合数', 'パフォーマンススコア', 'ステータス', '停止日'
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

    newProperties.push({ row: row, property: p });
    sheet.appendRow(row);
  }

  // 巡回条件の最終実行日時を更新
  if (criteriaId) {
    updatePatrolLastRun_(criteriaId);
  }

  return { added: added, duplicates: duplicates, newProperties: newProperties };
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
 * 承認待ち（pending）の候補物件を取得（Chrome拡張ポーリング用）
 */
function getSuumoApprovalQueue() {
  var sheet = getCandidateSheet_();
  var lastRow = sheet.getLastRow();
  if (lastRow <= 1) return [];

  var data = sheet.getRange(2, 1, lastRow - 1, SUUMO_CANDIDATE_HEADERS.length).getValues();
  var result = [];
  for (var i = 0; i < data.length; i++) {
    if (data[i][11] === 'approved') {
      var propertyData = {};
      try { propertyData = JSON.parse(data[i][12]); } catch (ex) {}
      var imageGenres = {};
      try { imageGenres = JSON.parse(data[i][13]); } catch (ex) {}

      result.push({
        key: data[i][0],
        building: data[i][1],
        room: data[i][2],
        address: data[i][3],
        source: data[i][10],
        propertyData: propertyData,
        imageGenres: imageGenres,
        rowIndex: i + 2
      });
    }
  }
  return result;
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
function approveSuumoCandidate(key, imageGenresJson) {
  var sheet = getCandidateSheet_();
  var lastRow = sheet.getLastRow();
  if (lastRow <= 1) return { success: false, message: '候補物件が見つかりません' };

  var keys = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
  for (var i = 0; i < keys.length; i++) {
    if (keys[i][0] === key) {
      var row = i + 2;
      sheet.getRange(row, 12).setValue('approved');
      sheet.getRange(row, 14).setValue(imageGenresJson || '');
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
 */
function recordSuumoPosting(data) {
  var sheet = getListingSheet_();
  var candidateSheet = getCandidateSheet_();
  var now = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd HH:mm:ss');

  var key = data.key || '';

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

  // 候補物件シートのステータスをpostedに更新
  updateCandidateStatus_(key, 'posted');

  return { success: true, key: key };
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
 * 掲載停止すべき物件を特定
 * - 1ヶ月以上経過した物件はパフォーマンス無関係で停止候補
 * - それ以外は最低パフォーマンスの物件
 */
function findStopCandidate() {
  var sheet = getListingSheet_();
  var lastRow = sheet.getLastRow();
  if (lastRow <= 1) return null;

  var data = sheet.getRange(2, 1, lastRow - 1, SUUMO_LISTING_HEADERS.length).getValues();
  var now = new Date();
  var oneMonthAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

  var activeListings = [];
  var oldListings = []; // 1ヶ月以上経過

  for (var i = 0; i < data.length; i++) {
    if (data[i][8] !== 'active') continue;

    var listing = {
      key: data[i][0],
      building: data[i][1],
      room: data[i][2],
      startDate: new Date(data[i][3]),
      rent: data[i][4],
      pv: Number(data[i][5]) || 0,
      inquiries: Number(data[i][6]) || 0,
      score: Number(data[i][7]) || 0,
      rowIndex: i + 2
    };

    activeListings.push(listing);

    if (listing.startDate < oneMonthAgo) {
      oldListings.push(listing);
    }
  }

  // 1ヶ月以上経過した中で最低スコアを優先
  if (oldListings.length > 0) {
    oldListings.sort(function(a, b) { return a.score - b.score; });
    return oldListings[0];
  }

  // 全体から最低スコア
  if (activeListings.length > 0) {
    activeListings.sort(function(a, b) { return a.score - b.score; });
    return activeListings[0];
  }

  return null;
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
  // 実行時にスクリプトプロパティから取得（Config.jsの定数はデプロイ時固定のため）
  var webhookUrl = PropertiesService.getScriptProperties().getProperty('SUUMO_DISCORD_WEBHOOK_URL') || SUUMO_DISCORD_WEBHOOK_URL || '';
  if (!webhookUrl || newProperties.length === 0) return;
  console.log('SUUMO Discord通知: ' + newProperties.length + '件送信, URL=' + webhookUrl.substring(0, 50) + '...');

  var gasUrl = ScriptApp.getService().getUrl();

  for (var i = 0; i < newProperties.length; i++) {
    var entry = newProperties[i];
    var p = entry.property;
    var row = entry.row;

    var building = p.building_name || p.buildingName || p.building || '(建物名なし)';
    var room = p.room_number || p.roomNumber || p.room || '';
    var rent = p.rent || '不明';
    var mgmtFee = p.management_fee || p.managementFee || p.commonServiceFee || '-';
    var layout = p.layout || ((p.madoriRoomCount || '') + (p.madoriType || ''));
    var area = p.area || p.usageArea || '';
    var address = (p.pref || '') + (p.addr1 || '') + (p.addr2 || '');
    var source = p.sourceType || '';

    var stationInfo = '';
    if (p.access && p.access.length > 0) {
      stationInfo = (p.access[0].line || '') + ' ' + (p.access[0].station || '') + '駅 徒歩' + (p.access[0].walk || '') + '分';
    }

    var approveUrl = gasUrl + '?action=suumo_approve&key=' + encodeURIComponent(row[0]);

    var content =
      '**🏠 新着SUUMO候補物件**\n' +
      '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n' +
      '**' + building + '  ' + room + '号室** `[' + source + ']`\n' +
      '賃料: **' + rent + '** (管理費: ' + mgmtFee + ')\n' +
      '間取り: ' + layout + ' / 面積: ' + area + 'm²\n' +
      '住所: ' + address + '\n' +
      '交通: ' + stationInfo + '\n' +
      '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n' +
      '[📋 承認ページを開く](' + approveUrl + ')\n' +
      '巡回条件: ' + (criteriaName || '不明');

    var payload = {
      content: content
    };

    try {
      UrlFetchApp.fetch(webhookUrl, {
        method: 'post',
        contentType: 'application/json',
        payload: JSON.stringify(payload),
        muteHttpExceptions: true
      });
      // レートリミット対策
      if (i < newProperties.length - 1) {
        Utilities.sleep(1000);
      }
    } catch (err) {
      console.error('SUUMO Discord通知失敗: ' + err.message);
    }
  }
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
 */
function handleGetSuumoQueue(e) {
  if (!_validateReinsApiKey(e.parameter.api_key)) {
    return ContentService.createTextOutput(JSON.stringify({ error: 'unauthorized' }))
      .setMimeType(ContentService.MimeType.JSON);
  }

  var queue = getSuumoApprovalQueue();
  var listingCount = getActiveListingCount();
  var stopCandidate = listingCount >= 50 ? findStopCandidate() : null;

  return ContentService.createTextOutput(JSON.stringify({
    queue: queue,
    activeListingCount: listingCount,
    stopCandidate: stopCandidate
  })).setMimeType(ContentService.MimeType.JSON);
}

/**
 * POST: 候補物件追加
 */
function handleAddSuumoCandidate(json) {
  var result = addSuumoCandidates(json);

  // 新着があればDiscord通知
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
    sendSuumoDiscordNotification(result.newProperties, criteriaName);
  }

  return ContentService.createTextOutput(JSON.stringify({
    success: true,
    added: result.added,
    duplicates: result.duplicates
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
function confirmSuumoApproveFromClient(key, imageGenres) {
  var imageGenresJson = imageGenres ? JSON.stringify(imageGenres) : '';
  return approveSuumoCandidate(key, imageGenresJson);
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
