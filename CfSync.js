/**
 * CfSync.gs — スプレッドシートの写しを Cloudflare（CRM の Cloudflare 版）へ送る。
 *
 * 本物はシートのまま。Cloudflare の D1 は写し。CRM の Cloudflare 版は写しを読んで画面を組み立てる。
 * 詳しい方針は ~/crm-worker/PLAN.md。
 *
 * 鍵: スクリプトプロパティ CF_SYNC_TOKEN（送るときの合言葉）と CF_CRM_KEY（画面を開く鍵）。
 *     cfSetup() を1回だけ実行すると作って Cloudflare に登録する（gitには書かない）。
 */

var CF_CRM_BASE = 'https://ehomaki-crm.delicate-bush-f5a9.workers.dev';
// Cloudflare版から「画面はこちらで組み立てる」と言われたとき（lite）は、1人分の作り直しを省いて早く返す
var _CRM_PAGE_LITE_ = false;
// 1回に送る大きさ（Cloudflare 無料の CPU 上限 1回10ms に収めるため小分けにする）
var CF_CHUNK_BYTES = 200000;

/**
 * 【GASエディタで実行: CfSync.gs】最初に1回だけ。鍵を作って Cloudflare に登録し、全シートを送る。
 * 終わったらログに出る「Cloudflare版のURL」を開くと入れる（以後は CRM の ☰ からも開ける）。
 */
function cfSetup() {
  var props = PropertiesService.getScriptProperties();
  if (props.getProperty('CF_SYNC_TOKEN')) {
    console.log('もう登録済みです。Cloudflare版のURL: ' + cfCrmUrl());
    return;
  }
  var mk = function () { return (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, ''); };
  var sync = mk(), key = mk();
  var res = UrlFetchApp.fetch(CF_CRM_BASE + '/register', {
    method: 'post', contentType: 'application/json', payload: JSON.stringify({ sync: sync, key: key }), muteHttpExceptions: true
  });
  if (res.getResponseCode() !== 200) throw new Error('登録できませんでした: ' + res.getResponseCode() + ' ' + res.getContentText());
  props.setProperties({ CF_SYNC_TOKEN: sync, CF_CRM_KEY: key });
  console.log('登録しました。全シートを送ります…');
  cfSyncAll();
  console.log('Cloudflare版のURL: ' + cfCrmUrl());
}

/** Cloudflare版の CRM を開く URL（鍵つき。開くと鍵は Cookie に入り、URL からは消える）。 */
function cfCrmUrl() {
  var key = PropertiesService.getScriptProperties().getProperty('CF_CRM_KEY') || '';
  return key ? CF_CRM_BASE + '/?key=' + encodeURIComponent(key) : '';
}

// 行の中身を写し用の形に。日付は {"$d": ミリ秒}（ブラウザで Date に戻す）
function _cfCell_(v) {
  if (v instanceof Date) return { $d: v.getTime() };
  return v;
}

// 承認待ち物件は J列（物件の中身の JSON）が大きい（全体で約30MB）。CRM に要らない大きな項目は落として送る。
function _cfSlimPending_(row) {
  var out = row.slice();
  try {
    var j = JSON.parse(row[9] || '{}');
    var slim = {};
    Object.keys(j).forEach(function (k) {
      var v = j[k];
      // 写真: 新着（pending）は編集画面で全部使うので全部。送った・見送ったは1枚目しか使わないので8枚まで
      if (k === 'image_urls' || k === 'image_categories') { slim[k] = String(row[10]) === 'pending' ? (v || []) : (v || []).slice(0, 8); return; }
      var s = JSON.stringify(v);
      if (s && s.length > 3000) return;   // 大きい項目（生の HTML など）は送らない
      slim[k] = v;
    });
    out[9] = JSON.stringify(slim);
  } catch (e) {}
  return out;
}

function _cfRowJson_(sheetName, row) {
  var r = sheetName === PENDING_SHEET_NAME ? _cfSlimPending_(row) : row;
  return JSON.stringify(r.map(_cfCell_));
}

function _cfPost_(body) {
  var tok = PropertiesService.getScriptProperties().getProperty('CF_SYNC_TOKEN');
  if (!tok) return false;   // まだ cfSetup していない
  // Cloudflare の1日の上限に当たったら、しばらく送らない（失敗を繰り返して書き込みを遅くしないように）
  var cache = CacheService.getScriptCache();
  if (cache.get('cfBlocked')) return false;
  var res = UrlFetchApp.fetch(CF_CRM_BASE + '/sync', {
    method: 'post', contentType: 'application/json', payload: JSON.stringify(body),
    headers: { Authorization: 'Bearer ' + tok }, muteHttpExceptions: true
  });
  if (res.getResponseCode() !== 200) {
    var txt = res.getContentText();
    if (/limit|exceeded/i.test(txt)) cache.put('cfBlocked', '1', 1800);
    throw new Error('Cloudflareに送れませんでした: ' + res.getResponseCode() + ' ' + txt.substring(0, 200));
  }
  return true;
}

/**
 * 1枚のシートを丸ごと送る。Cloudflare 側は中身が変わった行だけ書く（同じ行は書かない）ので、何度送っても書き込みは増えない。
 * ⚠️ 以前は「#new に貯めて入れ替える」やり方で1行につき3回書いていて、1日の上限（10万行）を使い切った（2026-10-07）。
 */
function cfSyncSheet(sheetName, why) {
  if (!PropertiesService.getScriptProperties().getProperty('CF_SYNC_TOKEN')) return;
  var sh = SpreadsheetApp.openById(CRITERIA_SHEET_ID).getSheetByName(sheetName);
  if (!sh) return;
  var lastRow = sh.getLastRow(), lastCol = sh.getLastColumn();
  var values = (lastRow > 0 && lastCol > 0) ? sh.getRange(1, 1, lastRow, lastCol).getValues() : [];
  var chunk = [], bytes = 0;
  for (var i = 0; i < values.length; i++) {
    var v = _cfRowJson_(sheetName, values[i]);
    chunk.push([i + 1, v]); bytes += v.length * 2;
    if (bytes > CF_CHUNK_BYTES) { if (!_cfPost_({ sheet: sheetName, mode: 'rows', rows: chunk })) return false; chunk = []; bytes = 0; }
  }
  return _cfPost_({ sheet: sheetName, mode: 'rows', rows: chunk, truncateAfter: values.length, why: why || '' });
}

/** 決まった行だけ送る（行番号はシートの行。1 始まり）。行が減ったときは truncateAfter に今の最終行を入れる。 */
function cfSyncRows(sheetName, rowNumbers, why) {
  try {
    if (!PropertiesService.getScriptProperties().getProperty('CF_SYNC_TOKEN')) return;
    var sh = SpreadsheetApp.openById(CRITERIA_SHEET_ID).getSheetByName(sheetName);
    if (!sh) return;
    var lastCol = sh.getLastColumn();
    var rows = [];
    (rowNumbers || []).forEach(function (r) {
      if (r < 1) return;
      rows.push([r, _cfRowJson_(sheetName, sh.getRange(r, 1, 1, lastCol).getValues()[0])]);
    });
    if (rows.length) _cfPost_({ sheet: sheetName, mode: 'rows', rows: rows, why: why || '' });
  } catch (e) {
    console.warn('[Cloudflare写し] ' + sheetName + ' の行を送れません: ' + e.message);
  }
}

// CRM が読むシート。小さいものは丸ごと送る
// ⚠️ 関数にしておくこと。ファイルの外側で別ファイルの名前（CRITERIA_SHEET_NAME など）を使うと、
//   読み込み順（CfSync が Config より先）のせいで GAS 全体が読み込みエラーになる（2026-10-07 実際に起きた）。
function _cfSheets_() { return [
  CRITERIA_SHEET_NAME, LINE_USERS_SHEET_NAME, CONTACT_LOG_SHEET_NAME, TASK_SHEET_NAME, INQUIRY_SHEET_NAME,
  CRM_GROUP_SHEET, CRM_MEMO_SHEET, CRM_FAMILY_SHEET, CRM_TREE_REPLY_SHEET, CRM_TREE_OLD_SHEET,
  NEW_FRIEND_SHEET, LINE_BLOCKED_ONLY_SHEET, SEEN_SHEET_NAME, ACTION_LOG_SHEET_NAME, VIEW_LOG_SHEET_NAME,
  STILL_SHEET, MOVE_IN_SHEET, PHONE_ASK_SHEET, FIRST_DELIVERY_SHEET, FIRST_SEARCH_SHEET,
  UNSUBSCRIBE_SHEET_NAME, LINE_EMAIL_SHEET_NAME, 'LINE Activity', 'メール送信履歴', CRM_CAND_SHEET,
  PENDING_SHEET_NAME
]; }

/**
 * 【GASエディタで実行: CfSync.gs】全部を丸ごと送り直す（夜のトリガーでも動く）。送り漏れのずれを直す。
 */
function cfSyncAll() {
  if (!PropertiesService.getScriptProperties().getProperty('CF_SYNC_TOKEN')) return;
  var t0 = Date.now(), done = [], failed = [];
  _cfSheets_().forEach(function (n) {
    try { cfSyncSheet(n, ''); done.push(n); } catch (e) { failed.push(n + '（' + e.message + '）'); }
  });
  console.log('[Cloudflare写し] 全部送りました ' + done.length + '枚 / ' + Math.round((Date.now() - t0) / 1000) + '秒'
    + (failed.length ? ' / 送れなかった: ' + failed.join('、') : ''));
}

// ── 送り漏れを拾う（5分ごとのトリガー）──
// 書き込みの場所ごとに送っているが、行を消した（片付けなど）ときや、送る処理を入れていない場所で書いたときは
// 写しがずれる。5分ごとに中身の指紋を比べて、変わったシートを送り直す。承認待ち物件は変わった行だけ。
function _cfHash_(s) {
  var h = 0x811c9dc5;
  for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = (h * 16777619) >>> 0; }
  return h.toString(36);
}

/** 【トリガー: 5分ごと】変わった行だけ Cloudflare の写しに送り直す（行ごとの指紋を覚えて比べる）。 */
function cfSyncCheck() {
  var props = PropertiesService.getScriptProperties();
  if (!props.getProperty('CF_SYNC_TOKEN')) return;
  var cache = CacheService.getScriptCache();
  if (cache.get('cfBlocked')) return;
  var ss = SpreadsheetApp.openById(CRITERIA_SHEET_ID);
  var sent = [];
  _cfSheets_().forEach(function (name) {
    try {
      var sh = ss.getSheetByName(name);
      if (!sh) return;
      var n = _cfCheckSheet_(sh, name, cache);
      if (n) sent.push(name + ' ' + n + '行');
    } catch (e) { console.warn('[Cloudflare写し] 点検できません: ' + name + ' / ' + e.message); }
  });
  if (sent.length) console.log('[Cloudflare写し] 送り直しました: ' + sent.join('、'));
}

// 1枚を点検して、変わった行だけ送る。返すのは送った行の数
function _cfCheckSheet_(sh, name, cache) {
  var lr = sh.getLastRow(), lc = sh.getLastColumn();
  var isPending = name === PENDING_SHEET_NAME;
  var values = null, hs;
  if (lr < 1 || lc < 1) hs = [];
  else if (isPending) {
    // 承認待ち物件: J列（物件の中身・全体で約30MB）は読まずに比べる（写真・一言・直した項目は書いた所で送っている）
    var ai = sh.getRange(1, 1, lr, 9).getValues(), ko = sh.getRange(1, 11, lr, 5).getValues();
    hs = ai.map(function (row, i) { return _cfHash_(JSON.stringify(row) + '|' + JSON.stringify(ko[i])); });
  } else {
    values = sh.getRange(1, 1, lr, lc).getValues();
    hs = values.map(function (row) { return _cfHash_(JSON.stringify(row)); });
  }
  var key = 'cfr:' + name, prev = null;
  try { prev = JSON.parse(cache.get(key) || 'null'); } catch (e) {}
  var save = function () { try { cache.put(key, JSON.stringify(hs), 21600); } catch (e) {} };
  // 覚えが無いときは丸ごと送る（Cloudflare 側は変わった行だけ書く）
  if (!prev) { if (cfSyncSheet(name, '')) { save(); return hs.length; } return 0; }
  var changed = [];
  for (var i = 0; i < hs.length; i++) if (hs[i] !== prev[i]) changed.push(i);
  var shrank = hs.length < prev.length;
  if (!changed.length && !shrank) { save(); return 0; }
  var rows = changed.map(function (i) {
    var row = values ? values[i] : sh.getRange(i + 1, 1, 1, lc).getValues()[0];
    return [i + 1, _cfRowJson_(name, row)];
  });
  // ⚠️ 送れなかったとき（上限で休んでいる等で _cfPost_ が false）は、指紋を覚え直さないこと。
  //   覚え直すと「送った」ことになり、その行は二度と送られず写しから抜け落ちる（2026-10-08 実際に起きた）
  var ok = true;
  for (var k = 0; k < rows.length; k += 100) {
    var last = k + 100 >= rows.length;
    ok = _cfPost_({ sheet: name, mode: 'rows', rows: rows.slice(k, k + 100), truncateAfter: last && shrank ? hs.length : undefined }) && ok;
  }
  if (!rows.length && shrank) ok = _cfPost_({ sheet: name, mode: 'rows', rows: [], truncateAfter: hs.length }) && ok;
  if (ok) save();
  return ok ? rows.length : 0;
}

// ── Cloudflare版CRMのボタン → 今の GAS の関数を呼ぶ口（doPost action=crm_call）──
// Worker が Cookie の鍵を key に付けて送ってくる。呼べるのは画面が使う関数だけ（下の一覧）。
function _cfCrmCallable_() {
  return ['addCrmCustomer', 'addCrmWatchFromPending', 'copyCrmPropertyTo', 'deleteDuplicateLeads', 'deletePendingForCleanup',
    'getCrmLineCandidates', 'getCrmOne', 'getCrmPropLists', 'getCrmPropListsAll', 'getCrmPropertyDetails', 'getCrmTreeForPage',
    'getCrmVersion', 'importSuumoInquiries', 'linkCrmFamily', 'linkCrmLine', 'logCrmManualMessage', 'nameCrmLineOnly',
    'planCrmViewing', 'previewDuplicateLeads', 'previewPendingCleanup', 'recordCrmTalk', 'recordCrmTreeContact',
    'renameCrmCustomer', 'resendCrmToFamily', 'saveCrmCriteria', 'saveCrmMemo', 'saveCrmPropertyEdit', 'sendCrmProperties',
    'setCrmClosed', 'setCrmGroup', 'setCrmNextContact', 'setCrmStage', 'setCrmWatch', 'skipCrmProperties', 'skipCrmProperty',
    'unlinkCrmFamily', 'unskipCrmProperty', 'uploadPropertyImage', 'getCrmPageConsts', 'setCrmCandidates',
    'addCrmTask', 'doneCrmTask', 'setCrmTaskDue', 'deleteCrmTask'];
}
function _cfCrmCall_(e) {
  var out;
  try {
    var key = PropertiesService.getScriptProperties().getProperty('CF_CRM_KEY');
    if (!key || String(e.parameter.key || '') !== key) throw new Error('鍵が違います');
    var b = JSON.parse((e.postData && e.postData.contents) || '{}');
    var fn = String(b.fn || '');
    if (_cfCrmCallable_().indexOf(fn) < 0) throw new Error('呼べない関数です: ' + fn);
    _CRM_PAGE_LITE_ = !!b.lite;
    var f = (typeof globalThis !== 'undefined' && globalThis[fn]) || this[fn];
    if (typeof f !== 'function') throw new Error('関数がありません: ' + fn);
    out = { ok: true, result: f.apply(null, b.args || []) };
  } catch (err) {
    out = { ok: false, error: String(err && err.message || err) };
  }
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}

/**
 * CRM のボタンで書いたあとに呼ぶ（_crmTreeForPage_ の1人分）。CRM が書くシートを行ごとに見比べて、変わった行だけ写しへ送る。
 * 承認待ち物件は書いた所で行ごとに送っているので、ここでは見ない（大きいので）。
 */
function cfSyncAfterCrmWrite_() {
  if (!PropertiesService.getScriptProperties().getProperty('CF_SYNC_TOKEN')) return;
  var cache = CacheService.getScriptCache();
  if (cache.get('cfBlocked')) return;
  var ss = SpreadsheetApp.openById(CRITERIA_SHEET_ID);
  [CRITERIA_SHEET_NAME, CRM_GROUP_SHEET, CRM_MEMO_SHEET, CRM_CAND_SHEET, TASK_SHEET_NAME, CONTACT_LOG_SHEET_NAME,
    CRM_FAMILY_SHEET, LINE_USERS_SHEET_NAME, SEEN_SHEET_NAME].forEach(function (name) {
    try { var sh = ss.getSheetByName(name); if (sh) _cfCheckSheet_(sh, name, cache); }
    catch (e) { console.warn('[Cloudflare写し] ' + name + ': ' + e.message); }
  });
}

/** 全部の送り直しを頼む口（doGet action=cf_resync&key=CF鍵）。上限が戻った直後に写しを本物とそろえるため。指紋の覚えも消す。 */
function cfResyncFromWeb_(e) {
  var key = PropertiesService.getScriptProperties().getProperty('CF_CRM_KEY');
  if (!key || String(e.parameter.key || '') !== key) return ContentService.createTextOutput('{"error":"unauthorized"}').setMimeType(ContentService.MimeType.JSON);
  var cache = CacheService.getScriptCache();
  cache.remove('cfBlocked');
  cache.removeAll(_cfSheets_().map(function (n) { return 'cfr:' + n; }));
  var t0 = Date.now(); cfSyncAll();
  return ContentService.createTextOutput(JSON.stringify({ ok: true, sec: Math.round((Date.now() - t0) / 1000) })).setMimeType(ContentService.MimeType.JSON);
}
