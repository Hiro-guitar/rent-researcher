/**
 * SheetWriter.gs - 検索条件をスプレッドシートに書き込む
 *
 * sheets.py が期待する A:R（18列）フォーマットに一致させる。
 *
 * 列マッピング（A:R 18列）:
 *   A: タイムスタンプ
 *   B: お客様名
 *   C: 都道府県（固定: 東京都）
 *   D: 市区町村（カンマ区切り）
 *   E: 駅名（カンマ区切り）
 *   F: 駅徒歩（数値のみ）
 *   G: 賃料上限（万円、数値のみ）
 *   H: 間取り（カンマ区切り）
 *   I: 専有面積下限（数値のみ）
 *   J: 築年数
 *   K: 構造（カンマ区切り）
 *   L: 設備（カンマ区切り）
 *   M: 部屋探しの理由
 *   N: 引越し時期
 *   O: 路線（全社結合、カンマ区切り）
 *   P: その他ご希望
 *   Q: ペット種類
 *   R: 居住者
 */

/**
 * 収集した検索条件をスプレッドシートに書き込む。
 * @param {string} userId - LINE userId（LINE Users シートにも記録）
 * @param {Object} state - 会話状態オブジェクト
 */
function writeToSheet(userId, state) {
  const d = state.data;
  const selectedRoutes = state.selectedRoutes || [];
  const selectedCities = state.selectedCities || [];
  const selectedStations = state.selectedStations || {};

  // 駅名をフラットに集約（重複排除）
  const allStations = [];
  for (const route of selectedRoutes) {
    const stas = selectedStations[route] || [];
    for (const s of stas) {
      if (allStations.indexOf(s) === -1) allStations.push(s);
    }
  }

  // タイムスタンプ
  const now = new Date();
  const timestamp = Utilities.formatDate(now, 'Asia/Tokyo', 'yyyy/MM/dd HH:mm:ss');

  // suffix除去ヘルパー
  function stripSuffix(val) {
    if (!val) return '';
    return String(val).replace(/万円|円|分以内|分|m²|m2|年以内|年|階以上|階/g, '').trim();
  }

  // 17列の行データを構築（A:Q）
  const row = [
    timestamp,                                    // A: タイムスタンプ
    d.name || '',                                  // B: お客様名
    '東京都',                                      // C: 都道府県（固定）
    selectedCities.join(', '),                     // D: 市区町村
    selectedRoutes.join(', '),          // E: 路線 (全社結合)
    allStations.join(', '),                        // E: 駅名
    stripSuffix(d.walk),                           // F: 駅徒歩
    stripSuffix(d.rent_max),                       // G: 賃料上限
    (d.layouts || []).join(', '),                   // H: 間取り
    stripSuffix(d.area_min),                       // I: 専有面積下限
    d.building_age || '',                          // J: 築年数
    (d.building_structures || []).join(', '),       // K: 構造
    (d.equipment || []).join(', '),                 // L: 設備
    d.reason || '',                                // M: 部屋探しの理由
    d.move_in_date || '',                          // N: 引越し時期
    d.notes || '',                                 // P: その他ご希望
    d.petType || '',                               // Q: ペット種類
    d.resident || ''                               // R: 居住者
  ];

  // スプレッドシートに追記
  const ss = SpreadsheetApp.openById(CRITERIA_SHEET_ID);
  const sheet = ss.getSheetByName(CRITERIA_SHEET_NAME);
  sheet.appendRow(row);

  // LINE Users シートにも記録
  saveLineUser(userId, d.name || '');
}

/**
 * LINE userId と顧客名の紐付けを保存する。
 * @param {string} userId
 * @param {string} customerName
 */
function saveLineUser(userId, customerName) {
  const ss = SpreadsheetApp.openById(CRITERIA_SHEET_ID);
  let sheet = ss.getSheetByName(LINE_USERS_SHEET_NAME);

  // シートがなければ作成
  if (!sheet) {
    sheet = ss.insertSheet(LINE_USERS_SHEET_NAME);
    sheet.appendRow(['LINE userId', '顧客名', '登録日時']);
  }

  // 既存エントリをチェック
  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (data[i][0] === userId) {
      // 既存 → 顧客名を更新
      sheet.getRange(i + 1, 2).setValue(customerName);
      sheet.getRange(i + 1, 3).setValue(new Date());
      return;
    }
  }

  // 新規追加
  const now = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy/MM/dd HH:mm:ss');
  sheet.appendRow([userId, customerName, now]);
}

/**
 * LINE ユーザーの最終やり取り時刻を記録する。
 * 「LINE Activity」シートに userId と timestamp を保存（upsert）。
 * @param {string} userId - LINE userId
 */
function recordLineActivity(userId) {
  try {
    var ss = SpreadsheetApp.openById(CRITERIA_SHEET_ID);
    var sheetName = 'LINE Activity';
    var sheet = ss.getSheetByName(sheetName);

    if (!sheet) {
      sheet = ss.insertSheet(sheetName);
      sheet.appendRow(['userId', 'lastMessageAt']);
    }

    var now = new Date();
    var data = sheet.getDataRange().getValues();
    for (var i = 1; i < data.length; i++) {
      if (data[i][0] === userId) {
        sheet.getRange(i + 1, 2).setValue(now);
        return;
      }
    }
    sheet.appendRow([userId, now]);
  } catch (e) {
    // アクティビティ記録の失敗はメッセージ処理をブロックしない
    console.error('recordLineActivity error: ' + e.message);
  }
}

/**
 * 全ユーザーの最終やり取り時刻を取得する。
 * @return {Object} { userId: timestamp(ms), ... }
 */
function getLineActivityMap() {
  try {
    var ss = SpreadsheetApp.openById(CRITERIA_SHEET_ID);
    var sheet = ss.getSheetByName('LINE Activity');
    if (!sheet) return {};

    var data = sheet.getDataRange().getValues();
    var map = {};
    for (var i = 1; i < data.length; i++) {
      if (data[i][0] && data[i][1]) {
        map[data[i][0]] = new Date(data[i][1]).getTime();
      }
    }
    return map;
  } catch (e) {
    return {};
  }
}
