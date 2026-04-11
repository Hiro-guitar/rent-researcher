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
 *   E: 路線(駅名)（例: ＪＲ山手線(渋谷, 新宿), 東京メトロ銀座線(銀座)）
 *   F: 駅名（カンマ区切り、フラット）
 *   G: 駅徒歩（数値のみ）
 *   H: 賃料上限（万円、数値のみ）
 *   I: 間取り（カンマ区切り）
 *   J: 専有面積下限（数値のみ）
 *   K: 築年数
 *   L: 構造（カンマ区切り）
 *   M: 設備（カンマ区切り）
 *   N: 部屋探しの理由
 *   O: 引越し時期
 *   P: その他ご希望
 *   Q: ペット種類
 *   R: 居住者
 *   S: 町名丁目（JSON形式: {"新宿区":["西新宿一丁目","西新宿二丁目"],"渋谷区":["恵比寿一丁目"]}）
 */

/**
 * 収集した検索条件をスプレッドシートに書き込む。
 * @param {string} userId - LINE userId（LINE Users シートにも記録）
 * @param {Object} state - 会話状態オブジェクト
 */
function writeToSheet(userId, state) {
  const d = state.data;
  // 名前が未取得の場合はここでLINEプロフィールから取得（startSearchFlowでは取得しない）
  if (!d.name) {
    try {
      var _profile = getLineProfile(userId);
      d.name = (_profile && _profile.displayName) ? _profile.displayName : '';
    } catch (e) { d.name = ''; }
  }
  const selectedRoutes = state.selectedRoutes || [];
  const selectedCities = state.selectedCities || [];
  const selectedStations = state.selectedStations || {};
  const selectedTowns = state.selectedTowns || {};

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

  // 路線(駅名)形式の文字列を構築（どの駅がどの路線か分かるように）
  const routeStationParts = [];
  for (const route of selectedRoutes) {
    const stas = selectedStations[route] || [];
    if (stas.length > 0) {
      routeStationParts.push(route + '(' + stas.join(', ') + ')');
    } else {
      routeStationParts.push(route);
    }
  }

  // 17列の行データを構築（A:Q）
  const row = [
    timestamp,                                    // A: タイムスタンプ
    d.name || '',                                  // B: お客様名
    '東京都',                                      // C: 都道府県（固定）
    selectedCities.join(', '),                     // D: 市区町村
    routeStationParts.join(', '),                  // E: 路線(駅名)
    allStations.join(', '),                        // F: 駅名（フラット）
    stripSuffix(d.walk),                           // G: 駅徒歩
    stripSuffix(d.rent_max),                       // H: 賃料上限
    (d.layouts || []).join(', '),                   // I: 間取り
    stripSuffix(d.area_min),                       // J: 専有面積下限
    d.building_age || '',                          // K: 築年数
    (d.building_structures || []).join(', '),       // L: 構造
    (d.equipment || []).join(', '),                 // M: 設備
    d.reason || '',                                // N: 部屋探しの理由
    d.move_in_date || '',                          // O: 引越し時期
    d.notes || '',                                 // P: その他ご希望
    d.petType || '',                               // Q: ペット種類
    d.resident || '',                              // R: 居住者
    Object.keys(selectedTowns).length > 0 ? JSON.stringify(selectedTowns) : ''  // S: 町名丁目（JSON）
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
    var routeStationRaw = String(latestRow[4] || '');
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
    var townsJson = latestRow[18] ? String(latestRow[18]) : '';
    var selectedTownsObj = {};
    if (townsJson) {
      try { selectedTownsObj = JSON.parse(townsJson); } catch(e) {}
    }

    // 路線(駅名)形式をパースして routes / selectedStations を再構築
    var routes = [];
    var selectedStations = {};
    if (routeStationRaw) {
      // "路線A(駅1, 駅2), 路線B(駅3)" 形式をパース
      // カンマが駅区切りと路線区切りの両方で使われるため、括弧の外のカンマで分割
      var parts = [];
      var depth = 0;
      var current = '';
      for (var ci = 0; ci < routeStationRaw.length; ci++) {
        var ch = routeStationRaw[ci];
        if (ch === '(') { depth++; current += ch; }
        else if (ch === ')') { depth--; current += ch; }
        else if (ch === ',' && depth === 0) { parts.push(current.trim()); current = ''; }
        else { current += ch; }
      }
      if (current.trim()) parts.push(current.trim());

      for (var pi = 0; pi < parts.length; pi++) {
        var part = parts[pi];
        var parenIdx = part.indexOf('(');
        if (parenIdx >= 0 && part.charAt(part.length - 1) === ')') {
          var routeName = part.substring(0, parenIdx).trim();
          var stasStr = part.substring(parenIdx + 1, part.length - 1);
          var stas = stasStr.split(/[,、]\s*/).filter(function(s) { return s.length > 0; });
          routes.push(routeName);
          if (stas.length > 0) selectedStations[routeName] = stas;
        } else {
          // 旧形式（括弧なし）にも対応
          var routeName2 = part.trim();
          if (routeName2) {
            routes.push(routeName2);
            // 旧形式: STATION_DATAから推測
            var routeStations2 = STATION_DATA[routeName2] || [];
            var matched2 = [];
            for (var s2 = 0; s2 < stations.length; s2++) {
              if (routeStations2.indexOf(stations[s2]) >= 0) {
                matched2.push(stations[s2]);
              }
            }
            if (matched2.length > 0) selectedStations[routeName2] = matched2;
          }
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
      selectedStations: selectedStations,
      selectedTowns: selectedTownsObj
    };
  } catch (e) {
    console.error('readLatestCriteria error: ' + e.message);
    return null;
  }
}

/**
 * LINE ユーザーの最終やり取り時刻を記録する。
 * 「LINE Activity」シートに userId, timestamp, displayName を保存（upsert）。
 * @param {string} userId - LINE userId
 */
function recordLineActivity(userId) {
  try {
    var ss = SpreadsheetApp.openById(CRITERIA_SHEET_ID);
    var sheetName = 'LINE Activity';
    var sheet = ss.getSheetByName(sheetName);

    if (!sheet) {
      sheet = ss.insertSheet(sheetName);
      sheet.appendRow(['userId', 'lastMessageAt', 'displayName']);
    }

    // displayNameを取得
    var displayName = '';
    try {
      var profile = getLineProfile(userId);
      if (profile && profile.displayName) displayName = profile.displayName;
    } catch (e) {}

    // 追記のみ方式（全行読み込みしないため高速）
    // 読み出し側（getLineActivityMap）で同じuserIdの最新行を採用する
    sheet.appendRow([userId, new Date(), displayName]);
  } catch (e) {
    // アクティビティ記録の失敗はメッセージ処理をブロックしない
    console.error('recordLineActivity error: ' + e.message);
  }
}

/**
 * 全ユーザーの最終やり取り時刻を取得する。
 * @return {Object} { userId: timestamp(ms), ... }
 */
/**
 * LINE Activity シートの重複行を掃除する（各userIdの最新行のみ残す）。
 * 手動実行 or 時間トリガーから呼ぶ想定。
 */
function cleanupLineActivitySheet() {
  try {
    var ss = SpreadsheetApp.openById(CRITERIA_SHEET_ID);
    var sheet = ss.getSheetByName('LINE Activity');
    if (!sheet) return;
    var data = sheet.getDataRange().getValues();
    if (data.length <= 1) return;
    var header = data[0];
    var latest = {};
    for (var i = 1; i < data.length; i++) {
      var uid = data[i][0];
      var ts = data[i][1] ? new Date(data[i][1]).getTime() : 0;
      if (!uid) continue;
      if (!latest[uid] || latest[uid].ts < ts) {
        latest[uid] = { ts: ts, row: data[i] };
      }
    }
    var newRows = [header];
    Object.keys(latest).forEach(function(k) { newRows.push(latest[k].row); });
    sheet.clearContents();
    sheet.getRange(1, 1, newRows.length, header.length).setValues(newRows);
  } catch (e) {
    console.error('cleanupLineActivitySheet error: ' + e.message);
  }
}

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
