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

  // スプレッドシートに書き込み（同じ顧客の古い行を削除してから追記）
  const ss = SpreadsheetApp.openById(CRITERIA_SHEET_ID);
  const sheet = ss.getSheetByName(CRITERIA_SHEET_NAME);

  // 同じ顧客名の既存行を探す
  var customerName = d.name || '';
  var existingRowIndex = -1;
  if (customerName) {
    var existingData = sheet.getDataRange().getValues();
    for (var i = 1; i < existingData.length; i++) {
      if (existingData[i][1] === customerName) {
        existingRowIndex = i + 1; // 1-indexed
        break;
      }
    }
  }

  if (existingRowIndex > 0) {
    // 既存行を上書き更新（順番を維持）
    sheet.getRange(existingRowIndex, 1, 1, row.length).setValues([row]);
  } else {
    // 新規顧客は末尾に追加
    sheet.appendRow(row);
  }

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
 * ユーザーの最新の登録済み検索条件をスプレッドシートから読み込む。
 * @param {string} userId - LINE userId
 * @return {Object|null} 条件データ（見つからない場合は null）
 */
function readLatestCriteria(userId) {
  try {
    // LINE Users シートから顧客名を取得
    var ss = SpreadsheetApp.openById(CRITERIA_SHEET_ID);
    var luSheet = ss.getSheetByName(LINE_USERS_SHEET_NAME);
    if (!luSheet) return null;

    var luData = luSheet.getDataRange().getValues();
    var customerName = null;
    for (var i = 1; i < luData.length; i++) {
      if (luData[i][0] === userId) {
        customerName = luData[i][1];
        break;
      }
    }
    if (!customerName) return null;

    // 検索条件シートから最新行を取得（同名の最後の行）
    var sheet = ss.getSheetByName(CRITERIA_SHEET_NAME);
    if (!sheet) return null;

    var data = sheet.getDataRange().getValues();
    var latestRow = null;
    for (var j = 1; j < data.length; j++) {
      if (data[j][1] === customerName) {
        latestRow = data[j];
      }
    }
    if (!latestRow) return null;

    // 行データをstate形式に変換
    function splitCSV(val) {
      if (!val) return [];
      return String(val).split(/[,、]\s*/).filter(function(s) { return s.length > 0; });
    }

    var cities = splitCSV(latestRow[3]);
    var routes = splitCSV(latestRow[4]);
    var stations = splitCSV(latestRow[5]);
    var walkRaw = latestRow[6] ? String(latestRow[6]) : '';
    var rentRaw = latestRow[7] ? String(latestRow[7]) : '';
    var layouts = splitCSV(latestRow[8]);
    var areaRaw = latestRow[9] ? String(latestRow[9]) : '';

    // シート保存時にstripSuffixで除去されたサフィックスを復元
    // フォーム（RouteSelectPage.html）の値と一致させるために必要
    var walk = walkRaw && walkRaw !== '指定しない' && !/分/.test(walkRaw) ? walkRaw + '分以内' : walkRaw;
    var rentMax = rentRaw && !/万円/.test(rentRaw) ? rentRaw + '万円' : rentRaw;
    var areaMin = areaRaw && areaRaw !== '指定しない' && !/m²|m2/.test(areaRaw) ? areaRaw + 'm²' : areaRaw;

    var buildingAge = latestRow[10] ? String(latestRow[10]) : '';
    var buildingStructures = splitCSV(latestRow[11]);
    var equipment = splitCSV(latestRow[12]);
    var reason = latestRow[13] ? String(latestRow[13]) : '';
    var moveInDate = latestRow[14] ? String(latestRow[14]) : '';
    var notes = latestRow[15] ? String(latestRow[15]) : '';
    var petType = latestRow[16] ? String(latestRow[16]) : '';
    var resident = latestRow[17] ? String(latestRow[17]) : '';

    // selectedStations を路線→駅のマッピングに再構築
    var selectedStations = {};
    if (routes.length > 0 && stations.length > 0) {
      for (var r = 0; r < routes.length; r++) {
        var routeName = routes[r];
        var routeStations = STATION_DATA[routeName] || [];
        var matched = [];
        for (var s = 0; s < stations.length; s++) {
          if (routeStations.indexOf(stations[s]) >= 0) {
            matched.push(stations[s]);
          }
        }
        if (matched.length > 0) {
          selectedStations[routeName] = matched;
        }
      }
    }

    return {
      name: customerName,
      reason: reason,
      resident: resident,
      move_in_date: moveInDate,
      rent_max: rentMax,
      layouts: layouts,
      walk: walk || '指定しない',
      area_min: areaMin || '指定しない',
      building_age: buildingAge || '指定しない',
      building_structures: buildingStructures,
      equipment: equipment,
      petType: petType,
      notes: notes,
      areaMethod: cities.length > 0 ? 'city' : 'route',
      selectedRoutes: routes,
      selectedCities: cities,
      selectedStations: selectedStations
    };
  } catch (e) {
    console.error('readLatestCriteria error: ' + e.message);
    return null;
  }
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
