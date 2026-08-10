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
 *   (S〜X: 配信管理用)
 *   Y(25列目): 町名丁目（JSON形式）
 *   (Z: 未使用)
 *   AA(27列目): 入居時期厳守フラグ
 *   AB(28列目): 年齢
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

  // 18列の行データを構築（A:R）— S列以降は配信管理用なので含めない
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
  ];
  // 町名丁目はY列（25列目）に別途書き込み（S列以降の配信管理カラムを避ける）
  const townsJson = Object.keys(selectedTowns).length > 0 ? JSON.stringify(selectedTowns) : '';

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

  // 変更前の値を控えておく（Discord通知と条件変更履歴で差分を出すため）
  var beforeRow = null;
  if (existingRowIndex > 0) {
    try { beforeRow = sheet.getRange(existingRowIndex, 1, 1, row.length).getValues()[0]; } catch (_eB) {}
  }

  if (existingRowIndex > 0) {
    // 既存行を上書き更新（順番を維持）— A〜R列のみ
    sheet.getRange(existingRowIndex, 1, 1, row.length).setValues([row]);
    // Y列（25列目）に町名丁目を書き込み
    sheet.getRange(existingRowIndex, 25).setValue(townsJson);
    // AA列（27列目）に入居時期厳守フラグを書き込み
    sheet.getRange(existingRowIndex, 27).setValue(d.move_in_strict ? 'true' : '');
    // AB列（28列目）に年齢を書き込み。
    // 年齢を持たない state から保存された場合に既存の値を消さないよう、
    // undefined のときは touch しない（条件変更で年齢が消える事故があった）。
    if (d.age !== undefined) sheet.getRange(existingRowIndex, 28).setValue(d.age || '');
    // AC列（29列目）: 条件変更時は最終REINS検索日をクリア（次回検索で全期間から検索し直す）
    sheet.getRange(existingRowIndex, 29).setValue('');
    // AD列（30列目）: 条件変更完了 → 条件変更提案の連続送信カウントをリセット
    sheet.getRange(existingRowIndex, 30).setValue(0);
    // AN列（40列目）: 車種（駐車場ありのとき）
    sheet.getRange(existingRowIndex, 40).setValue(d.carModel || '');
    // AP列(42)=希望階数 / AQ列(43)=部屋番号の数字合計（フォームから来た時だけ更新）
    if (d.allowedFloors !== undefined) sheet.getRange(existingRowIndex, 42).setValue(String(d.allowedFloors || ''));
    if (d.roomDigitSums !== undefined) sheet.getRange(existingRowIndex, 43).setValue(String(d.roomDigitSums || ''));
    if (d.minFloor !== undefined) sheet.getRange(existingRowIndex, 44).setValue(String(d.minFloor || ''));
  } else {
    // 新規顧客は末尾に追加
    sheet.appendRow(row);
    // appendRowの後にY列・AA列・AB列を書き込み
    var newRowIndex = sheet.getLastRow();
    sheet.getRange(newRowIndex, 25).setValue(townsJson);
    sheet.getRange(newRowIndex, 27).setValue(d.move_in_strict ? 'true' : '');
    sheet.getRange(newRowIndex, 28).setValue(d.age || '');
    // AN列（40列目）: 車種
    sheet.getRange(newRowIndex, 40).setValue(d.carModel || '');
    if (d.allowedFloors) sheet.getRange(newRowIndex, 42).setValue(String(d.allowedFloors));
    if (d.roomDigitSums) sheet.getRange(newRowIndex, 43).setValue(String(d.roomDigitSums));
    if (d.minFloor) sheet.getRange(newRowIndex, 44).setValue(String(d.minFloor));
  }

  // LINE Users シートにも記録
  saveLineUser(userId, d.name || '');

  // 条件が変わったら履歴に残し、担当者へ通知する（新規登録時は差分なしなので出ない）
  try {
    var changes = _diffCriteriaRow_(beforeRow, row);
    if (changes.length > 0) {
      var source = _criteriaChangeSource_(state);
      _appendCriteriaHistory_(customerName, source, changes);
      _notifyCriteriaChangeToDiscord_(customerName, source, changes);
    }
  } catch (eHist) {
    // 履歴・通知の失敗で条件の保存自体を壊さない
    console.error('[条件変更履歴] 失敗（条件の保存は完了）: ' + eHist.message);
  }
}

// ══════════════════════════════════════════════════════════
//  条件変更の記録と通知
//  writeToSheet が条件書き込みの唯一の入口なので、ここに置けば
//  LINEの条件変更・条件選択ページからの保存・空室確認からの自動登録を
//  すべて拾える。
// ══════════════════════════════════════════════════════════

// A〜R列のうち、変更を追う対象と表示名（S列以降は配信管理なので対象外）
var CRITERIA_DIFF_LABELS = {
  3: '市区町村', 4: '沿線・駅', 6: '駅徒歩', 7: '賃料上限', 8: '間取り',
  9: '専有面積', 10: '築年数', 11: '構造', 12: '設備',
  13: '探し理由', 14: '入居時期', 15: 'その他', 16: 'ペット', 17: '居住者'
};

/** 変更前後の行を比べて [{label, before, after}] を返す。新規登録(before無し)は空配列。 */
function _diffCriteriaRow_(beforeRow, afterRow) {
  var out = [];
  if (!beforeRow || !afterRow) return out;
  for (var idx in CRITERIA_DIFF_LABELS) {
    var i = Number(idx);
    var b = String(beforeRow[i] == null ? '' : beforeRow[i]).trim();
    var a = String(afterRow[i] == null ? '' : afterRow[i]).trim();
    if (b === a) continue;
    out.push({ label: CRITERIA_DIFF_LABELS[i], before: b || '（なし）', after: a || '（なし）' });
  }
  return out;
}

/** 何をきっかけに変わったかを state から判定する。 */
function _criteriaChangeSource_(state) {
  if (!state) return '不明';
  if (state.isAutoFollowup) return '空室確認からの自動登録';
  if (state.isChangeFlow) return 'お客様による条件変更';
  if (state.changeSource) return String(state.changeSource);
  return 'お客様による条件変更';
}

/** 条件変更履歴シートに1行残す。 */
function _appendCriteriaHistory_(customerName, source, changes) {
  var ss = SpreadsheetApp.openById(CRITERIA_SHEET_ID);
  var sheet = ss.getSheetByName('条件変更履歴');
  if (!sheet) {
    sheet = ss.insertSheet('条件変更履歴');
    sheet.appendRow(['日時', '顧客名', 'きっかけ', '変更内容']);
    try {
      sheet.getRange(1, 1, 1, 4).setFontWeight('bold').setBackground('#e0e0e0');
      sheet.setFrozenRows(1);
    } catch (e) {}
  }
  var body = changes.map(function (c) {
    return c.label + ': ' + c.before + ' → ' + c.after;
  }).join('\n');
  sheet.appendRow([new Date(), customerName, source, body]);
}

/** 条件が変わったことを担当者向けDiscord（顧客専用スレッド）に通知する。 */
function _notifyCriteriaChangeToDiscord_(customerName, source, changes) {
  var sp = PropertiesService.getScriptProperties();
  var webhookUrl = sp.getProperty('DISCORD_WEBHOOK_URL');
  if (!webhookUrl) return;
  var lines = [];
  lines.push('\u270F\uFE0F **' + customerName + '** 様の条件が変わりました（' + source + '）');
  for (var i = 0; i < changes.length; i++) {
    lines.push('> ' + changes[i].label + ': ' + changes[i].before + ' → **' + changes[i].after + '**');
  }
  var payload = { content: lines.join('\n'), flags: 4096 };  // 音は鳴らさない
  var threadId = sp.getProperty('DISCORD_THREAD_' + customerName);
  var url = webhookUrl + (threadId ? '?thread_id=' + threadId : '?wait=true');
  if (!threadId) payload.thread_name = '\uD83C\uDFE0 ' + customerName;
  try {
    if (typeof _sendDiscordWithRetry_ === 'function') _sendDiscordWithRetry_(url, payload, 3);
  } catch (e) {
    console.error('[条件変更通知] Discord送信失敗: ' + e.message);
  }
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
/**
 * 条件変更フローで「触っていない項目」を消したと解釈しないよう、
 * state に無い値を変更前の条件で埋め戻す。
 *
 * 年齢は条件変更のどのステップでも入力しないため、state に乗っていないと
 * 保存時もサマリーカードでも「指定なし」になり、登録済みの値が失われていた。
 * writeToSheet 側でも AB列を触らないようガードしてあるが、それだけでは
 * カードの表示（stateから組み立てる）が「20代 → 指定なし」のままになる。
 *
 * @param {Object} state - 保存しようとしている state（破壊的に更新する）
 * @param {Object} before - readLatestCriteria の戻り値
 */
// 条件変更フローで触らなかった項目。ここに載っている項目は、
// 変更後の state に無ければ変更前の値をそのまま引き継ぐ。
//
// ⚠️ writeToSheet が読む項目(d.xxx)を増やしたら、ここにも足すこと。
//   ここから漏れると「条件変更したら関係ない項目が勝手に消える」というバグになる。
//   実際に年齢(2026-08-09)と探し理由(同日)がこれで消えていた。
//   1項目ずつ足していくと再発するので、writeToSheet が読む項目を全部並べてある。
var _CARRY_OVER_FIELDS = [
  'reason',              // 探し理由
  'resident',            // 居住者
  'age',                 // 年齢
  'move_in_date',        // 入居時期
  'move_in_strict',      // 入居時期の厳守
  'rent_max',            // 家賃上限
  'layouts',             // 間取り
  'walk',                // 駅徒歩
  'area_min',            // 専有面積
  'building_age',        // 築年数
  'building_structures', // 構造
  'equipment',           // こだわり
  'petType',             // ペット種別
  'carModel',            // 車種
  'minFloor',            // 最低階数
  'allowedFloors',       // 希望階数
  'roomDigitSums',       // 部屋番号の数字合計
  'notes'                // その他ご希望
];

// 値が「未入力」かどうか。空文字・null・空配列を未入力とみなす。
// false や 0 は「意図して設定された値」なので引き継ぎ対象にしない。
function _isBlankCriteriaValue_(v) {
  if (v === undefined || v === null) return true;
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === 'string') return v.trim() === '';
  return false;
}

/**
 * 条件変更で触らなかった項目を、変更前の値で補完する。
 * 部分的な条件変更フローは変更した項目しか state に入れないため、
 * これが無いと未入力＝消去として書き込まれてしまう。
 */
function _carryOverUntouchedCriteria_(state, before) {
  if (!state || !state.data || !before) return;
  var carried = [];
  for (var i = 0; i < _CARRY_OVER_FIELDS.length; i++) {
    var key = _CARRY_OVER_FIELDS[i];
    if (!_isBlankCriteriaValue_(state.data[key])) continue;   // 今回入力された → そのまま
    if (_isBlankCriteriaValue_(before[key])) continue;        // 変更前も空 → 補完不要
    state.data[key] = before[key];
    carried.push(key);
  }
  // エリア(路線/駅/市区町村/町名)は state 直下にあるので別扱い。
  // 4つまとめて空のときだけ引き継ぐ。片方だけ引き継ぐと路線と駅がちぐはぐになる。
  var _areaBlank = _isBlankCriteriaValue_(state.selectedRoutes)
    && _isBlankCriteriaValue_(state.selectedCities)
    && _isBlankCriteriaValue_(state.selectedStations && Object.keys(state.selectedStations))
    && _isBlankCriteriaValue_(state.selectedTowns && Object.keys(state.selectedTowns));
  var _beforeHasArea = !_isBlankCriteriaValue_(before.selectedRoutes)
    || !_isBlankCriteriaValue_(before.selectedCities);
  if (_areaBlank && _beforeHasArea) {
    state.selectedRoutes = before.selectedRoutes || [];
    state.selectedCities = before.selectedCities || [];
    state.selectedStations = before.selectedStations || {};
    state.selectedTowns = before.selectedTowns || {};
    carried.push('エリア');
  }
  if (carried.length > 0) {
    console.log('[条件変更] 触っていない項目を変更前の値で引き継ぎ: ' + carried.join(', '));
  }
}

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
    // 引越し時期: Google Sheets が「7月1日」 を Date オブジェクトとして自動解釈する
    // ことがあり、 String(Date) すると "Wed Jul 01 2026 00:00:00 GMT+0900 (日本標準時)"
    // のような英語表記になってしまう。 Date 型なら日本語フォーマットに変換する。
    var rawMoveIn = latestRow[14];
    var moveInDate = '';
    if (rawMoveIn instanceof Date) {
      moveInDate = (rawMoveIn.getMonth() + 1) + '月' + rawMoveIn.getDate() + '日';
    } else if (rawMoveIn) {
      moveInDate = String(rawMoveIn);
    }
    var notes = latestRow[15] ? String(latestRow[15]) : '';
    var petType = latestRow[16] ? String(latestRow[16]) : '';
    var carModel = latestRow[39] ? String(latestRow[39]) : '';  // AN列（40列目、index 39）: 車種
    var minFloor = latestRow[43] ? String(latestRow[43]) : '';  // AR列（44列目、index 43）: 最低階数
    var resident = latestRow[17] ? String(latestRow[17]) : '';
    var townsJson = latestRow[24] ? String(latestRow[24]) : '';  // Y列（25列目、index 24）
    var moveInStrict = String(latestRow[26] || '').trim().toLowerCase() === 'true';  // AA列（27列目、index 26）
    var age = latestRow[27] ? String(latestRow[27]) : '';  // AB列（28列目、index 27）
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
      carModel: carModel,
      minFloor: minFloor,
      notes: notes,
      age: age,
      areaMethod: cities.length > 0 ? 'city' : 'route',
      selectedRoutes: routes,
      selectedCities: cities,
      selectedStations: selectedStations,
      selectedTowns: selectedTownsObj,
      move_in_strict: moveInStrict
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

    // upsert: 既存行があれば更新、なければ追加（重複を防ぐ）
    var data = sheet.getDataRange().getValues();
    var foundRow = -1;
    for (var i = 1; i < data.length; i++) {
      if (String(data[i][0]) === String(userId)) {
        foundRow = i + 1; // 1-based row number
        break;
      }
    }
    if (foundRow > 0) {
      sheet.getRange(foundRow, 2).setValue(new Date());
      if (displayName) sheet.getRange(foundRow, 3).setValue(displayName);
    } else {
      sheet.appendRow([userId, new Date(), displayName]);
    }
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
  var ss = SpreadsheetApp.openById(CRITERIA_SHEET_ID);
  var sheet = ss.getSheetByName('LINE Activity');
  if (!sheet) {
    console.log('cleanupLineActivitySheet: sheet not found');
    return;
  }
  var data = sheet.getDataRange().getValues();
  console.log('cleanupLineActivitySheet: total rows=' + data.length + ', cols=' + (data[0] ? data[0].length : 0));
  if (data.length <= 1) {
    console.log('cleanupLineActivitySheet: no data rows');
    return;
  }
  var header = data[0];
  var latest = {};
  var totalWithUid = 0;
  for (var i = 1; i < data.length; i++) {
    var uid = String(data[i][0]).trim();
    if (!uid) continue;
    totalWithUid++;
    var ts = data[i][1] ? new Date(data[i][1]).getTime() : 0;
    if (!latest[uid] || latest[uid].ts < ts) {
      latest[uid] = { ts: ts, row: data[i] };
    }
  }
  var uniqueCount = Object.keys(latest).length;
  console.log('cleanupLineActivitySheet: rows with userId=' + totalWithUid + ', unique userIds=' + uniqueCount);
  var newRows = [header];
  Object.keys(latest).forEach(function(k) { newRows.push(latest[k].row); });
  // ヘッダーはA:Cの3列だけに制限（余計な空列を除去）
  var colCount = 3;
  var trimmedRows = newRows.map(function(row) { return row.slice(0, colCount); });
  sheet.clear(); // clearContents + formatting
  sheet.getRange(1, 1, trimmedRows.length, colCount).setValues(trimmedRows);
  console.log('cleanupLineActivitySheet: done. wrote ' + trimmedRows.length + ' rows');
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
