/**
 * StaffNarrowing.gs — こちらで絞り込む条件（お客様には見せない）
 *
 * きっかけ（2026-09-20）:
 *   お客様が登録した条件が緩すぎるとき、こちらで絞りを足したい。
 *   裏条件（おすすめ検索条件）は「もう1本の検索を増やす」仕組みなので、
 *   広げるのには使えても狭めるのには使えない。同じ1本を狭くする道が要る。
 *
 * 考え方:
 *   お客様の条件はそのまま。入れた項目だけを上から当てて検索する。
 *   空欄の項目はお客様の条件のまま。
 *
 *   例) お客様: 家賃15万以下 / 築年数 指定なし
 *       絞り込み: 築年数 20年以内
 *       → 実際の検索: 家賃15万以下 かつ 築20年以内
 *
 * ⚠️ お客様には絶対に見せないこと。
 *   条件確認カードは検索条件シートの通常の列から作るので、ここに入れた値は出ない。
 *   お客様が条件変更しても別の列なので消えない。
 *
 * ⚠️ 見えないぶん担当者が忘れる。顧客管理ページには必ず出すこと。
 *   「なぜこの人に物件が来ないのか」を追えなくなる。
 *
 * 保存場所: 検索条件シート AV列(48) にJSON。
 *   {"rent_max":"12","building_age":"20年以内","walk":"10","area_min":"30",
 *    "layouts":["1LDK"],"structures":["鉄筋系"],"equipment":["バス・トイレ別"]}
 */

var STAFF_NARROW_COL = 48;   // AV列

/** 上書きできる項目。ここに無いものは触らない（エリアは絞ると事故りやすいので入れない）。 */
var STAFF_NARROW_FIELDS = ['rent_max', 'walk', 'area_min', 'building_age', 'layouts', 'structures', 'equipment'];

/** 配列で持つ項目。 */
var STAFF_NARROW_ARRAY_FIELDS = ['layouts', 'structures', 'equipment'];

function _staffNarrowSheet_() {
  return SpreadsheetApp.openById(CRITERIA_SHEET_ID).getSheetByName(CRITERIA_SHEET_NAME);
}

/** 顧客名 → 絞り込み（無ければ {}）。handleGetCriteria から一括で使えるようにまとめて返す。 */
function loadAllStaffNarrowing() {
  var map = {};
  try {
    var sh = _staffNarrowSheet_();
    if (!sh || sh.getLastRow() < 2) return map;
    var last = sh.getLastRow();
    var names = sh.getRange(2, 2, last - 1, 1).getValues();          // B列: 顧客名
    var vals = sh.getRange(2, STAFF_NARROW_COL, last - 1, 1).getValues();
    for (var i = 0; i < names.length; i++) {
      var n = String(names[i][0] || '').trim();
      var raw = String(vals[i][0] || '').trim();
      if (!n || !raw) continue;
      try {
        var o = JSON.parse(raw);
        if (o && typeof o === 'object') map[n] = o;   // 同名が複数行なら後の行が勝つ
      } catch (_e) {}
    }
  } catch (e) {
    console.warn('[絞り込み] 読めません: ' + e.message);
  }
  return map;
}

/**
 * 検索条件に絞り込みを当てる。**入っている項目だけ**上書きする。
 * @param {Object} c handleGetCriteria が組み立てた条件（この場で書き換える）
 * @param {Object} narrow 絞り込み
 * @return {boolean} 1つでも当てたか
 */
function applyStaffNarrowing(c, narrow) {
  if (!c || !narrow) return false;
  var applied = false;
  for (var i = 0; i < STAFF_NARROW_FIELDS.length; i++) {
    var k = STAFF_NARROW_FIELDS[i];
    var v = narrow[k];
    if (v === undefined || v === null) continue;
    if (STAFF_NARROW_ARRAY_FIELDS.indexOf(k) >= 0) {
      if (!Array.isArray(v) || v.length === 0) continue;
      // equipment だけは文字列で渡す決まりになっている（検索側がそう読む）
      c[k] = (k === 'equipment') ? v.join(', ') : v.slice();
      applied = true;
    } else {
      var s = String(v).trim();
      if (!s) continue;
      c[k] = s;
      applied = true;
    }
  }
  if (applied) c.staffNarrowed = true;
  return applied;
}

/**
 * 【顧客管理ページから呼ばれる】お客様の条件と、こちらの絞り込みをまとめて返す。
 * 左にお客様の条件、右に絞り込みを並べて見せるためのもの。
 */
function getStaffNarrowing(customerName) {
  customerName = String(customerName || '').trim();
  if (!customerName) return { ok: false, message: '顧客名がありません' };
  try {
    var sh = _staffNarrowSheet_();
    var data = sh.getDataRange().getValues();
    var row = null, rowIndex = -1;
    for (var i = 1; i < data.length; i++) {
      if (String(data[i][1] || '').trim() !== customerName) continue;
      if (typeof _rowHasCriteria_ === 'function' && !_rowHasCriteria_(data[i])) continue;
      row = data[i]; rowIndex = i + 1;    // 同名が複数あれば後の行（writeToSheet と同じ考え方）
    }
    if (!row) return { ok: false, message: '条件が見つかりません' };

    var narrow = {};
    try {
      var raw = String(row[STAFF_NARROW_COL - 1] || '').trim();
      if (raw) narrow = JSON.parse(raw) || {};
    } catch (_e) {}

    return {
      ok: true,
      rowIndex: rowIndex,
      customer: {
        rent_max: String(row[7] || ''),
        walk: String(row[6] || ''),
        area_min: String(row[9] || ''),
        building_age: String(row[10] || ''),
        layouts: _splitCSV(row[8]),
        structures: _splitCSV(row[11]),
        equipment: _splitCSV(row[12])
      },
      narrowing: narrow
    };
  } catch (e) {
    return { ok: false, message: e.message };
  }
}

/**
 * 【顧客管理ページから呼ばれる】絞り込みを保存する。
 * 空の項目は取り除いて保存するので、全部空なら列も空になる。
 */
function saveStaffNarrowing(customerName, narrowing) {
  customerName = String(customerName || '').trim();
  if (!customerName) return { ok: false, message: '顧客名がありません' };
  try {
    var clean = {};
    var src = narrowing || {};
    for (var i = 0; i < STAFF_NARROW_FIELDS.length; i++) {
      var k = STAFF_NARROW_FIELDS[i];
      var v = src[k];
      if (v === undefined || v === null) continue;
      if (STAFF_NARROW_ARRAY_FIELDS.indexOf(k) >= 0) {
        var arr = (Array.isArray(v) ? v : String(v).split(','))
          .map(function (x) { return String(x).trim(); })
          .filter(function (x) { return x; });
        if (arr.length) clean[k] = arr;
      } else {
        var s = String(v).trim();
        if (s) clean[k] = s;
      }
    }

    var sh = _staffNarrowSheet_();
    var data = sh.getDataRange().getValues();
    var rowIndex = -1;
    for (var r = 1; r < data.length; r++) {
      if (String(data[r][1] || '').trim() !== customerName) continue;
      if (typeof _rowHasCriteria_ === 'function' && !_rowHasCriteria_(data[r])) continue;
      rowIndex = r + 1;
    }
    if (rowIndex < 0) return { ok: false, message: '条件が見つかりません' };

    if (sh.getMaxColumns() < STAFF_NARROW_COL) {
      sh.insertColumnsAfter(sh.getMaxColumns(), STAFF_NARROW_COL - sh.getMaxColumns());
    }
    if (String(sh.getRange(1, STAFF_NARROW_COL).getValue() || '').trim() === '') {
      sh.getRange(1, STAFF_NARROW_COL).setValue('こちらで絞り込む条件');
    }
    var count = Object.keys(clean).length;
    sh.getRange(rowIndex, STAFF_NARROW_COL).setValue(count ? JSON.stringify(clean) : '');
    console.log('[絞り込み] ' + customerName + ': ' + (count ? JSON.stringify(clean) : '（なし）'));
    return { ok: true, count: count, narrowing: clean };
  } catch (e) {
    return { ok: false, message: e.message };
  }
}
