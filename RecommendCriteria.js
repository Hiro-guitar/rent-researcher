/**
 * RecommendCriteria.js - おすすめ検索条件（裏条件）
 *
 * お客さんが登録した検索条件（検索条件シート）とは別に、こちら（仲介側）が
 * 設定する「おすすめ条件」を別シートで管理する。お客さんの登録は一切変更しない。
 * 1顧客に複数のおすすめ条件を持てる。自動検索(handleGetCriteria)が両方を回す。
 *
 * シート列レイアウト（検索条件シートと同じ並びにして parse を共通化）:
 *   A(0) タイムスタンプ / B(1) 顧客名 / C(2) 都道府県 / D(3) 市区町村
 *   E(4) 路線(駅名) / F(5) 駅名 / G(6) 徒歩 / H(7) 賃料上限 / I(8) 間取り
 *   J(9) 面積 / K(10) 築年数 / L(11) 構造 / M(12) 設備 / N(13) 理由(未使用)
 *   O(14) 引越し時期 / P(15) その他 / Q(16) ペット(未使用) / R(17) 居住者(未使用)
 *   Y(24) 町名丁目JSON / AA(26) 入居時期厳守
 *   AH(33) ラベル / AI(34) ID / AJ(35) 有効フラグ('0'で無効)
 */

var RECOMMEND_SHEET_NAME = 'おすすめ検索条件';
var RECOMMEND_COL_LABEL = 34;   // AH (1-based)
var RECOMMEND_COL_ID = 35;      // AI
var RECOMMEND_COL_ENABLED = 36; // AJ

/** おすすめ条件シートを取得（無ければ作成してヘッダーを入れる）。 */
function _getRecommendSheet_() {
  var ss = SpreadsheetApp.openById(CRITERIA_SHEET_ID);
  var sheet = ss.getSheetByName(RECOMMEND_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(RECOMMEND_SHEET_NAME);
    var header = [];
    for (var c = 0; c < 36; c++) header.push('');
    header[0] = '登録日時'; header[1] = '顧客名'; header[2] = '都道府県';
    header[3] = '市区町村'; header[4] = '路線(駅名)'; header[5] = '駅名';
    header[6] = '徒歩'; header[7] = '賃料上限'; header[8] = '間取り';
    header[9] = '面積'; header[10] = '築年数'; header[11] = '構造';
    header[12] = '設備'; header[14] = '引越し時期'; header[15] = 'その他';
    header[24] = '町名丁目JSON'; header[26] = '入居時期厳守';
    header[33] = 'ラベル'; header[34] = 'ID'; header[35] = '有効';
    sheet.getRange(1, 1, 1, header.length).setValues([header]);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function _recStripSuffix_(val) {
  if (!val) return '';
  return String(val).replace(/万円|円|分以内|分|m²|m2|年以内|年|階以上|階/g, '').trim();
}

/** 路線＋選択駅から「路線(駅, 駅)」形式の文字列を作る。 */
function _recBuildRouteStations_(routes, selectedStations) {
  var parts = [];
  routes = routes || [];
  selectedStations = selectedStations || {};
  for (var i = 0; i < routes.length; i++) {
    var stas = selectedStations[routes[i]] || [];
    if (stas.length > 0) parts.push(routes[i] + '(' + stas.join(', ') + ')');
    else parts.push(routes[i]);
  }
  return parts.join(', ');
}

/**
 * handleGetCriteria から呼ばれる。おすすめ条件を criteria 配列に追加する。
 * @param {Array} criteriaArr 追加先（自動検索の検索条件リスト）
 * @param {Object} deliverableNames 配信対象の顧客名 set（ここに無い顧客は検索しない）
 */
function _appendRecommendCriteria_(criteriaArr, deliverableNames) {
  var ss = SpreadsheetApp.openById(CRITERIA_SHEET_ID);
  var sheet = ss.getSheetByName(RECOMMEND_SHEET_NAME);
  if (!sheet || sheet.getLastRow() < 2) return;
  var data = sheet.getDataRange().getValues();
  var added = 0;
  for (var i = 1; i < data.length; i++) {
    var row = data[i];
    var name = String(row[1] || '').trim();
    if (!name) continue;
    if (!deliverableNames[name]) continue; // 顧客が配信対象でない（停止/ブロック等）→検索しない
    var enabled = String(row[35] || '').trim().toLowerCase();
    if (enabled === '0' || enabled === 'false') continue; // 無効化されたおすすめ条件

    var routesWithStations = _parseRoutesWithStations(row[4]);
    var allRoutes = routesWithStations.map(function(r) { return r.route; });
    var allStations = _splitCSV(row[5]);
    var selectedTowns = {};
    var townsJson = String(row[24] || '').trim();
    if (townsJson) { try { selectedTowns = JSON.parse(townsJson); } catch (e) {} }

    // 条件が空なら検索しない（暴走防止。検索条件シートと同じ基準）
    var hasC = (_splitCSV(row[3]).length > 0)
      || allRoutes.length > 0
      || allStations.length > 0
      || String(row[7] || '').trim() !== ''
      || _splitCSV(row[8]).length > 0
      || String(row[9] || '').trim() !== ''
      || String(row[10] || '').trim() !== ''
      || (Object.keys(selectedTowns).length > 0);
    if (!hasC) continue;

    var lastReinsSearch = row[28] || '';
    var lastReinsSearchStr = (lastReinsSearch instanceof Date)
      ? Utilities.formatDate(lastReinsSearch, 'Asia/Tokyo', 'yyyy-MM-dd')
      : String(lastReinsSearch || '').trim();

    criteriaArr.push({
      name: name,
      cities: _splitCSV(row[3]),
      routes: allRoutes,
      stations: allStations,
      routes_with_stations: routesWithStations,
      walk: String(row[6] || ''),
      rent_max: String(row[7] || ''),
      layouts: _splitCSV(row[8]),
      area_min: String(row[9] || ''),
      building_age: String(row[10] || ''),
      structures: _splitCSV(row[11]),
      equipment: String(row[12] || ''),
      move_in_date: String(row[14] || ''),
      move_in_strict: String(row[26] || '').trim().toLowerCase() === 'true',
      notes: String(row[15] || ''),
      selectedTowns: selectedTowns,
      lastReinsSearch: lastReinsSearchStr,
      btMode: '',
      // おすすめ条件であることを示すフラグ（ラベル付け Phase で利用）
      recommend: true,
      recommendId: String(row[34] || ''),
      recommendLabel: String(row[33] || '')
    });
    added++;
  }
  if (added > 0) console.log('[おすすめ条件] 検索対象に追加: ' + added + '件');
}

/** 表示用の条件サマリ文字列を作る。 */
function _recSummary_(row) {
  var parts = [];
  var cities = _splitCSV(row[3]);
  var routes = _parseRoutesWithStations(row[4]).map(function(r) { return r.route; });
  var stations = _splitCSV(row[5]);
  if (cities.length) parts.push('エリア: ' + cities.join('・'));
  if (routes.length) parts.push('路線: ' + routes.join('・'));
  if (stations.length) parts.push('駅: ' + stations.join('・'));
  if (String(row[7] || '').trim()) parts.push('賃料: ' + row[7] + '万円');
  if (_splitCSV(row[8]).length) parts.push('間取り: ' + _splitCSV(row[8]).join('・'));
  if (String(row[9] || '').trim()) parts.push('面積: ' + row[9] + 'm²');
  if (String(row[10] || '').trim()) parts.push('築: ' + row[10]);
  if (String(row[6] || '').trim()) parts.push('徒歩: ' + row[6] + '分');
  return parts.join(' / ');
}

/**
 * google.script.run 用: ある顧客のおすすめ条件一覧を返す。
 * @return {Array} [{id,label,enabled,summary}]
 */
function listRecommendCriteria(customerName) {
  var sheet = _getRecommendSheet_();
  if (sheet.getLastRow() < 2) return [];
  var data = sheet.getRange(2, 1, sheet.getLastRow() - 1, 36).getValues();
  var out = [];
  for (var i = 0; i < data.length; i++) {
    if (String(data[i][1] || '').trim() !== customerName) continue;
    var enabled = String(data[i][35] || '').trim().toLowerCase();
    out.push({
      id: String(data[i][34] || ''),
      label: String(data[i][33] || ''),
      enabled: !(enabled === '0' || enabled === 'false'),
      summary: _recSummary_(data[i])
    });
  }
  return out;
}

/** google.script.run 用: おすすめ条件を削除（ID指定）。 */
function deleteRecommendCriteria(id) {
  id = String(id || '').trim();
  if (!id) return { ok: false, message: 'IDがありません' };
  var sheet = _getRecommendSheet_();
  var data = sheet.getDataRange().getValues();
  for (var i = data.length - 1; i >= 1; i--) {
    if (String(data[i][34] || '').trim() === id) {
      sheet.deleteRow(i + 1);
      return { ok: true };
    }
  }
  return { ok: false, message: '該当なし' };
}

/** google.script.run 用: おすすめ条件の有効/無効を切替。 */
function setRecommendEnabled(id, enabled) {
  id = String(id || '').trim();
  var sheet = _getRecommendSheet_();
  var data = sheet.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][34] || '').trim() === id) {
      sheet.getRange(i + 1, RECOMMEND_COL_ENABLED).setValue(enabled ? '1' : '0');
      return { ok: true };
    }
  }
  return { ok: false, message: '該当なし' };
}

/**
 * おすすめ条件を保存（新規追加 or ID指定で更新）。
 * @param {Object} payload {customerName, id?, label, fields}
 *   fields: {cities[], routes[], selectedStations{}, stations[], walk, rent_max,
 *            layouts[], area_min, building_age, structures[], equipment[],
 *            notes, move_in_date, move_in_strict, towns{}}
 * @return {Object} { ok, id }
 */
function saveRecommendCriteria(payload) {
  payload = payload || {};
  var customerName = String(payload.customerName || '').trim();
  if (!customerName) return { ok: false, message: '顧客名がありません' };
  var f = payload.fields || {};
  var label = String(payload.label || '').trim() || 'おすすめ条件';

  var routes = f.routes || [];
  var selectedStations = f.selectedStations || {};
  var allStations = [];
  for (var r = 0; r < routes.length; r++) {
    var stas = selectedStations[routes[r]] || [];
    for (var s = 0; s < stas.length; s++) {
      if (allStations.indexOf(stas[s]) === -1) allStations.push(stas[s]);
    }
  }
  if (Array.isArray(f.stations)) {
    for (var s2 = 0; s2 < f.stations.length; s2++) {
      if (allStations.indexOf(f.stations[s2]) === -1) allStations.push(f.stations[s2]);
    }
  }
  var townsJson = (f.towns && Object.keys(f.towns).length > 0) ? JSON.stringify(f.towns) : '';

  var sheet = _getRecommendSheet_();
  var id = String(payload.id || '').trim();
  var now = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy/MM/dd HH:mm:ss');

  // 行データ（36列）
  var rowVals = [];
  for (var c = 0; c < 36; c++) rowVals.push('');
  rowVals[0] = now;
  rowVals[1] = customerName;
  rowVals[2] = '東京都';
  rowVals[3] = (f.cities || []).join(', ');
  rowVals[4] = _recBuildRouteStations_(routes, selectedStations);
  rowVals[5] = allStations.join(', ');
  rowVals[6] = _recStripSuffix_(f.walk);
  rowVals[7] = _recStripSuffix_(f.rent_max);
  rowVals[8] = (f.layouts || []).join(', ');
  rowVals[9] = _recStripSuffix_(f.area_min);
  rowVals[10] = f.building_age || '';
  rowVals[11] = (f.structures || []).join(', ');
  rowVals[12] = (f.equipment || []).join(', ');
  rowVals[14] = f.move_in_date || '';
  rowVals[15] = f.notes || '';
  rowVals[24] = townsJson;
  rowVals[26] = f.move_in_strict ? 'true' : '';
  rowVals[33] = label;

  if (id) {
    // 既存IDを更新
    var data = sheet.getDataRange().getValues();
    for (var i = 1; i < data.length; i++) {
      if (String(data[i][34] || '').trim() === id) {
        rowVals[34] = id;
        rowVals[35] = (String(data[i][35] || '').trim().toLowerCase() === '0') ? '0' : '1';
        sheet.getRange(i + 1, 1, 1, 36).setValues([rowVals]);
        return { ok: true, id: id };
      }
    }
    // 見つからなければ新規扱い
  }

  // 新規追加
  var newId = Utilities.getUuid();
  rowVals[34] = newId;
  rowVals[35] = '1';
  sheet.appendRow(rowVals);
  return { ok: true, id: newId };
}
