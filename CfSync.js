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
      if (k === 'image_urls' || k === 'image_categories') { slim[k] = (v || []).slice(0, 8); return; }
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
  var res = UrlFetchApp.fetch(CF_CRM_BASE + '/sync', {
    method: 'post', contentType: 'application/json', payload: JSON.stringify(body),
    headers: { Authorization: 'Bearer ' + tok }, muteHttpExceptions: true
  });
  if (res.getResponseCode() !== 200) throw new Error('Cloudflareに送れませんでした: ' + res.getResponseCode() + ' ' + res.getContentText().substring(0, 200));
  return true;
}

/** 1枚のシートを丸ごと送る（送っている途中も、画面は前の写しのまま見える）。 */
function cfSyncSheet(sheetName, why) {
  if (!PropertiesService.getScriptProperties().getProperty('CF_SYNC_TOKEN')) return;
  var sh = SpreadsheetApp.openById(CRITERIA_SHEET_ID).getSheetByName(sheetName);
  if (!sh) return;
  var lastRow = sh.getLastRow(), lastCol = sh.getLastColumn();
  var values = (lastRow > 0 && lastCol > 0) ? sh.getRange(1, 1, lastRow, lastCol).getValues() : [];
  _cfPost_({ sheet: sheetName, mode: 'begin' });
  var chunk = [], bytes = 0;
  for (var i = 0; i < values.length; i++) {
    var v = _cfRowJson_(sheetName, values[i]);
    chunk.push([i + 1, v]); bytes += v.length * 2;
    if (bytes > CF_CHUNK_BYTES) { _cfPost_({ sheet: sheetName, mode: 'chunk', rows: chunk }); chunk = []; bytes = 0; }
  }
  if (chunk.length) _cfPost_({ sheet: sheetName, mode: 'chunk', rows: chunk });
  _cfPost_({ sheet: sheetName, mode: 'end', why: why || '' });
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
  UNSUBSCRIBE_SHEET_NAME, LINE_EMAIL_SHEET_NAME, 'LINE Activity', 'メール送信履歴',
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
