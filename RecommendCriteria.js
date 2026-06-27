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

/** 入居時期セルの値を文字列化（Sheetsが日付に自動変換した場合は yyyy-MM-dd に整形）。 */
function _recMoveInStr_(v) {
  if (v instanceof Date) return Utilities.formatDate(v, 'Asia/Tokyo', 'yyyy-MM-dd');
  var s = String(v == null ? '' : v).trim();
  // 過去にJSのDate文字列で保存された値（例: "Fri Jun 26 2026 00:00:00 GMT+0900 (日本標準時)"）を整形
  if (s.indexOf('GMT') >= 0) {
    var d = new Date(s);
    if (!isNaN(d.getTime())) return Utilities.formatDate(d, 'Asia/Tokyo', 'yyyy-MM-dd');
  }
  return s;
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
      move_in_date: _recMoveInStr_(row[14]),
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
  var eqArr = _splitCSV(row[12]);
  if (eqArr.length) parts.push('設備: ' + eqArr.join('・'));
  var miStr = _recMoveInStr_(row[14]);
  if (miStr) {
    var strict = String(row[26] || '').trim().toLowerCase() === 'true';
    parts.push('入居: ' + miStr + (strict ? '（厳守）' : ''));
  }
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
      moveInDate: _recMoveInStr_(data[i][14]),
      moveInStrict: String(data[i][26] || '').trim().toLowerCase() === 'true',
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

/**
 * google.script.run 用: おすすめ条件の入居時期・厳守を設定する。
 * @param {string} id
 * @param {string} moveInDate 入居時期（空文字で未指定）
 * @param {boolean} strict 厳守するか
 */
function setRecommendMoveIn(id, moveInDate, strict) {
  id = String(id || '').trim();
  var sheet = _getRecommendSheet_();
  var data = sheet.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][34] || '').trim() === id) {
      sheet.getRange(i + 1, 15).setNumberFormat('@').setValue(String(moveInDate || '')); // O列(15): 入居時期（テキスト固定）
      sheet.getRange(i + 1, 27).setValue(strict ? 'true' : '');      // AA列(27): 厳守
      return { ok: true };
    }
  }
  return { ok: false, message: '該当なし' };
}

/**
 * おすすめ条件の前回REINS検索日（AC列=29）を記録する。本人条件とは独立。
 * REINSの登録年月日フィルタの起点になり、次回はこの日付以降を検索する。
 */
function setRecommendLastReinsSearch(id, searchDate) {
  id = String(id || '').trim();
  if (!id) return { ok: false, message: 'IDがありません' };
  var sheet = _getRecommendSheet_();
  var data = sheet.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][34] || '').trim() === id) {
      sheet.getRange(i + 1, 29).setValue(searchDate); // AC列(29): 前回REINS検索日
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
        sheet.getRange(i + 1, 15).setNumberFormat('@'); // O列(入居時期)を日付自動変換させない
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
  try { sheet.getRange(sheet.getLastRow(), 15).setNumberFormat('@').setValue(String(rowVals[14] || '')); } catch (e) {} // O列を日付自動変換させない
  return { ok: true, id: newId };
}

/**
 * 編集用: おすすめ条件1件を、条件フォームのシード形式で返す。
 * @return {Object|null} {label, areaMethod, selectedRoutes, selectedCities, selectedStations, selectedTowns, data}
 */
function getRecommendForEdit(id) {
  id = String(id || '').trim();
  if (!id) return null;
  var sheet = _getRecommendSheet_();
  var data = sheet.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][34] || '').trim() !== id) continue;
    var row = data[i];
    var rws = _parseRoutesWithStations(row[4]);
    var routes = rws.map(function(r) { return r.route; });
    var selStations = {};
    rws.forEach(function(r) { if (r.stations && r.stations.length) selStations[r.route] = r.stations; });
    var cities = _splitCSV(row[3]);
    var towns = {};
    try { towns = JSON.parse(String(row[24] || '') || '{}'); } catch (e) {}
    var rawRent = String(row[7] || '').trim();
    var rawWalk = String(row[6] || '').trim();
    var rawArea = String(row[9] || '').trim();
    return {
      label: String(row[33] || ''),
      areaMethod: cities.length > 0 ? 'city' : 'route',
      selectedRoutes: routes,
      selectedCities: cities,
      selectedStations: selStations,
      selectedTowns: towns,
      data: {
        name: String(row[1] || ''),
        rent_max: rawRent ? rawRent + '万円' : '',
        layouts: _splitCSV(row[8]),
        walk: rawWalk ? rawWalk + '分以内' : '指定しない',
        area_min: rawArea ? rawArea + 'm²' : '指定しない',
        building_age: String(row[10] || '') || '指定しない',
        building_structures: _splitCSV(row[11]),
        equipment: _splitCSV(row[12]),
        notes: String(row[15] || ''),
        move_in_date: _recMoveInStr_(row[14]),
        move_in_strict: String(row[26] || '').trim().toLowerCase() === 'true',
        reason: '', resident: ''
      }
    };
  }
  return null;
}

/**
 * google.script.run 用: おすすめ条件1件を、Chrome拡張の検索ページ用オブジェクトで返す。
 * （顧客ページの「検索ページを開く」で使う buildCustomerForExtension と同じ形）
 * @return {Object|null}
 */
function getRecommendForExtension(id) {
  id = String(id || '').trim();
  if (!id) return null;
  var sheet = _getRecommendSheet_();
  var data = sheet.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][34] || '').trim() !== id) continue;
    var row = data[i];
    var rws = _parseRoutesWithStations(row[4]); // [{route, stations[]}]
    var routes = rws.map(function(r) { return r.route; });
    var allStations = [];
    rws.forEach(function(r) { (r.stations || []).forEach(function(s) { allStations.push(s); }); });
    var towns = {};
    try { towns = JSON.parse(String(row[24] || '') || '{}'); } catch (e) {}
    return {
      name: String(row[1] || ''),
      routes_with_stations: rws,
      routes: routes,
      stations: allStations,
      cities: _splitCSV(row[3]),
      selectedTowns: towns,
      rent_max: String(row[7] || ''),   // 既に万円等のサフィックスは除去済み
      layouts: _splitCSV(row[8]),
      walk: String(row[6] || ''),
      area_min: String(row[9] || ''),
      building_age: String(row[10] || ''),
      structures: _splitCSV(row[11]),
      equipment: _splitCSV(row[12]).join(','),
      prefecture: '東京都'
    };
  }
  return null;
}

/**
 * google.script.run 用: おすすめ条件エディタ（既存の条件フォーム）を開くためのURLを返す。
 * 既存の条件フォームを rec:: トークンの一時セッションで開く。顧客フローには影響しない。
 * @param {string} customerName
 * @param {string} recommendId 既存編集時のID（新規は空）
 * @param {string} label おすすめ条件のラベル
 * @return {Object} { ok, url }
 */
function startRecommendEditor(customerName, recommendId, label) {
  customerName = String(customerName || '').trim();
  if (!customerName) return { ok: false, message: '顧客名がありません' };
  recommendId = String(recommendId || '').trim();
  var seedLabel = String(label || '').trim();

  var seed = null;
  if (recommendId) {
    seed = getRecommendForEdit(recommendId);
    if (seed && !seedLabel) seedLabel = seed.label || '';
  }
  if (!seed) {
    // 新規は「お客さんの現条件」を初期値にする（こちらで緩めて保存する想定）
    var c = loadCustomerCriteriaByName(customerName);
    if (c) {
      seed = {
        areaMethod: c.areaMethod, selectedRoutes: c.selectedRoutes, selectedCities: c.selectedCities,
        selectedStations: c.selectedStations, selectedTowns: c.selectedTowns,
        data: {
          name: customerName, rent_max: c.rent_max, layouts: c.layouts, walk: c.walk,
          area_min: c.area_min, building_age: c.building_age, building_structures: c.building_structures,
          equipment: c.equipment, petType: c.petType, notes: c.notes, move_in_date: c.move_in_date,
          move_in_strict: c.move_in_strict, reason: '', resident: ''
        }
      };
    }
  }
  if (!seed) {
    seed = {
      areaMethod: 'route', selectedRoutes: [], selectedCities: [], selectedStations: {}, selectedTowns: {},
      data: {
        name: customerName, rent_max: '', layouts: [], walk: '指定しない', area_min: '指定しない',
        building_age: '指定しない', building_structures: [], equipment: [], notes: '', move_in_date: '',
        move_in_strict: false, reason: '', resident: ''
      }
    };
  }
  if (!seedLabel) seedLabel = 'おすすめ条件';

  var token = Utilities.getUuid().replace(/-/g, '').substring(0, 16);
  var userId = 'rec::' + token;
  var state = createInitialState();
  state.step = STEPS.CRITERIA_SELECT;
  state.isChangeFlow = true;
  state.areaMethod = seed.areaMethod || 'route';
  state.selectedRoutes = seed.selectedRoutes || [];
  state.selectedCities = seed.selectedCities || [];
  state.selectedStations = seed.selectedStations || {};
  state.selectedTowns = seed.selectedTowns || {};
  state.data = seed.data || {};
  saveState(userId, state);

  CacheService.getScriptCache().put('recedit_' + token,
    JSON.stringify({ customerName: customerName, recommendId: recommendId, label: seedLabel }), 1800);

  var baseUrl = ScriptApp.getService().getUrl();
  var url = baseUrl + '?action=selectCriteria&userId=' + encodeURIComponent(userId);
  return { ok: true, url: url };
}

/**
 * 条件フォーム送信(processCriteriaSelection)から rec:: の場合に呼ばれる。
 * フォーム形式の criteria を おすすめ条件として保存する。顧客の登録は触らない。
 */
function _saveRecommendFromForm_(userId, criteria) {
  try {
    var token = String(userId).substring('rec::'.length);
    var cache = CacheService.getScriptCache();
    var raw = cache.get('recedit_' + token);
    if (!raw) return { success: false, message: 'セッションが切れました。お手数ですがもう一度開いてください。' };
    var meta = JSON.parse(raw);
    criteria = criteria || {};
    // 条件フォームには入居時期の入力が無いため、シードした state（お客さんの入居時期 or
    // 編集元のおすすめ条件）から引き継ぐ。これで自動検索でも入居時期が考慮される。
    var seedData = {};
    try { var st = getState(userId); if (st && st.data) seedData = st.data; } catch (e) {}
    var miDate = criteria.move_in_date || seedData.move_in_date || '';
    var miStrict = criteria.move_in_date ? !!criteria.move_in_strict : !!seedData.move_in_strict;
    var fields = {
      cities: criteria.selectedCities || [],
      routes: criteria.selectedRoutes || [],
      selectedStations: criteria.selectedStations || {},
      stations: [],
      walk: (criteria.walkMax && criteria.walkMax !== '指定しない') ? criteria.walkMax : '',
      rent_max: criteria.rentMax || '',
      layouts: criteria.layouts || [],
      area_min: (criteria.areaMin && criteria.areaMin !== '指定しない') ? criteria.areaMin : '',
      building_age: (criteria.buildingAge && criteria.buildingAge !== '指定しない') ? criteria.buildingAge : '',
      structures: criteria.buildingStructures || [],
      equipment: criteria.equipment || [],
      notes: criteria.otherConditions || '',
      move_in_date: miDate,
      move_in_strict: miStrict,
      towns: criteria.selectedTowns || {}
    };
    var res = saveRecommendCriteria({
      customerName: meta.customerName, id: meta.recommendId || '',
      label: meta.label || 'おすすめ条件', fields: fields
    });
    try { clearState(userId); } catch (e) {}
    cache.remove('recedit_' + token);
    if (!res.ok) return { success: false, message: res.message || '保存に失敗しました' };
    return { success: true, message: 'おすすめ条件を保存しました。この画面は閉じてください。' };
  } catch (err) {
    return { success: false, message: '保存エラー: ' + err.message };
  }
}
