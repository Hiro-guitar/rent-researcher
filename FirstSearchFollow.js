/**
 * FirstSearchFollow.gs — 条件登録後、最初の検索で1件も送れなかった人に、すぐ条件変更を提案する
 *
 * 狙い（2026-09-22）:
 *   登録した直後に何も来ないのが、いちばん冷めるタイミング。
 *   10日おきの一律の提案（廃止予定）ではなく、その日のうちに手を打つ。
 *   提案を無視した人はもう追わない。戻ってくれば元に戻す（AutoEnd.gs）。
 *
 * どう分かるか:
 *   「最初の検索が走った」 … 検索条件シート AC列(29) に検索日が入る（拡張が書く）
 *   「1件も送れなかった」 … 承認待ち物件に sent / pending の行が無い
 *   「条件を変えた」       … writeToSheet が AC列を空に戻す。それが反応の印
 *
 * ⚠️ 登録から3時間は待つこと。REINS以外（いえらぶ・itandi・いい生活）が
 *   まだ回っている途中で「0件」と決めつけない。
 * ⚠️ 昔から0件のまま止まっている人を巻き込まないこと。FIRST_SEARCH_MAX_AGE_D で足切り。
 *   その人たちは電話で拾う（顧客管理ページの仕事）。
 * ⚠️ 提案の文面と形は既存の buildConditionSuggestionFlex_ をそのまま使う。
 *   Z列（最終提案日）も書いておき、旧仕組みが同じ日に重ねて送らないようにする。
 */

var FIRST_SEARCH_SHEET = '初回検索の確認';

// 送信を止めるスイッチ。false なら数えるだけ。
var FIRST_SEARCH_ENABLED = false;
// 登録からこれだけ経ってから判定する（他サイトの検索を待つ）
var FIRST_SEARCH_WAIT_H = 3;
// 返事をこれだけ待って、無ければ終了
var FIRST_SEARCH_REPLY_H = 24;
// これより前に登録した人は拾わない
var FIRST_SEARCH_MAX_AGE_D = 7;

function _firstSearchSheet_() {
  var ss = SpreadsheetApp.openById(CRITERIA_SHEET_ID);
  var sh = ss.getSheetByName(FIRST_SEARCH_SHEET);
  if (!sh) {
    sh = ss.insertSheet(FIRST_SEARCH_SHEET);
    sh.appendRow(['顧客名', '登録日時', '提案した日時', '反応', '状態']);
    try {
      sh.getRange(1, 1, 1, 5).setFontWeight('bold').setBackground('#e0e0e0');
      sh.setFrozenRows(1);
    } catch (_) {}
  }
  return sh;
}

/** 承認待ち物件に sent / pending の行がある顧客名の集合。 */
function _firstSearchNamesWithProps_() {
  var set = {};
  try {
    var sh = SpreadsheetApp.openById(SPREADSHEET_ID).getSheetByName(PENDING_SHEET_NAME);
    if (!sh || sh.getLastRow() < 2) return set;
    var rows = sh.getRange(2, 1, sh.getLastRow() - 1, 11).getValues();   // A:顧客名 … K:status
    for (var i = 0; i < rows.length; i++) {
      var st = String(rows[i][10] || '').trim();
      if (st === 'sent' || st === 'pending') set[String(rows[i][0] || '').trim()] = true;
    }
  } catch (e) { console.warn('[初回検索] 承認待ち物件を読めません: ' + e.message); }
  try {
    var sh2 = SpreadsheetApp.openById(SPREADSHEET_ID).getSheetByName(SEEN_SHEET_NAME);
    if (sh2 && sh2.getLastRow() > 1) {
      var names = sh2.getRange(2, 1, sh2.getLastRow() - 1, 1).getValues();
      for (var j = 0; j < names.length; j++) set[String(names[j][0] || '').trim()] = true;
    }
  } catch (e2) { console.warn('[初回検索] 通知済み物件を読めません: ' + e2.message); }
  return set;
}

/**
 * 最初の検索が走ったのに1件も送れていない人を集める。送信はしない。
 * @return {Array<{name, rowIndex, registeredMs, searchedOn, hoursSinceReg, tooOld}>}
 */
function collectFirstSearchZero() {
  var out = [];
  var sh = SpreadsheetApp.openById(CRITERIA_SHEET_ID).getSheetByName(CRITERIA_SHEET_NAME);
  if (!sh || sh.getLastRow() < 2) return out;
  var data = sh.getDataRange().getValues();
  var hasProps = _firstSearchNamesWithProps_();
  var now = Date.now();
  var seen = {};

  for (var i = data.length - 1; i >= 1; i--) {
    var name = String(data[i][1] || '').trim();
    if (!name || seen[name]) continue;
    if (typeof _rowHasCriteria_ === 'function' && !_rowHasCriteria_(data[i])) continue;
    seen[name] = true;

    if (String(data[i][32] || '').trim() === '終了') continue;                       // AG列: ステージ
    var status = String(data[i][18] || '').trim().toLowerCase() || 'active';         // S列: 配信状態
    if (status !== 'active') continue;
    var searchedOn = String(data[i][28] || '').trim();                                // AC列: 検索日
    if (!searchedOn) continue;                                                        // まだ検索していない
    if (hasProps[name]) continue;                                                     // 送れている

    var regMs = _fdMs_(data[i][0]);                                                   // A列: 登録日時
    if (!regMs) continue;
    var hours = (now - regMs) / 3600000;
    if (hours < FIRST_SEARCH_WAIT_H) continue;                                        // 他サイトを待つ

    out.push({
      name: name, rowIndex: i + 1, registeredMs: regMs, searchedOn: searchedOn,
      hoursSinceReg: Math.floor(hours), tooOld: hours > FIRST_SEARCH_MAX_AGE_D * 24
    });
  }
  out.sort(function (a, b) { return a.hoursSinceReg - b.hoursSinceReg; });
  return out;
}

/** 【GASエディタで実行】今その状態の人を数える。何も送らない。 */
function previewFirstSearchZero() {
  var list = collectFirstSearchZero();
  var fresh = list.filter(function (x) { return !x.tooOld; });
  var old = list.filter(function (x) { return x.tooOld; });
  console.log('=== 最初の検索が走ったのに、1件も送れていない人 ===');
  console.log('■ 登録から' + FIRST_SEARCH_MAX_AGE_D + '日以内: ' + fresh.length + '人 ← 提案の対象');
  for (var i = 0; i < fresh.length; i++) {
    console.log('   登録から' + fresh[i].hoursSinceReg + '時間  ' + fresh[i].name + '  （検索日 ' + fresh[i].searchedOn + '）');
  }
  console.log('■ それより前: ' + old.length + '人 ← 自動では触らない。電話の対象');
  for (var j = 0; j < Math.min(old.length, 20); j++) {
    console.log('   登録から' + Math.floor(old[j].hoursSinceReg / 24) + '日  ' + old[j].name);
  }
  if (old.length > 20) console.log('   ほか ' + (old.length - 20) + '人');
  console.log('');
  console.log('※ 送信は' + (FIRST_SEARCH_ENABLED ? '有効です' : 'まだ止めてあります') + '。');
}

/** 提案を送る。 */
function _firstSearchAsk_() {
  var list = collectFirstSearchZero().filter(function (x) { return !x.tooOld; });
  if (!list.length) return 0;

  var sh = _firstSearchSheet_();
  var asked = {};
  if (sh.getLastRow() > 1) {
    var rows = sh.getRange(2, 1, sh.getLastRow() - 1, 5).getValues();
    for (var r = 0; r < rows.length; r++) asked[String(rows[r][0] || '').trim()] = true;
  }
  var todo = list.filter(function (x) { return !asked[x.name]; });
  if (!todo.length) return 0;

  // 提案カードは既存の候補オブジェクトから作る（条件の緩め方を具体的に示すもの）
  var byName = {};
  var cands = getConditionSuggestionCandidates_({ names: todo.map(function (x) { return x.name; }) });
  for (var c = 0; c < cands.length; c++) byName[cands[c].name] = cands[c];

  var criteria = SpreadsheetApp.openById(CRITERIA_SHEET_ID).getSheetByName(CRITERIA_SHEET_NAME);
  var sent = 0;
  for (var i = 0; i < todo.length; i++) {
    var t = todo[i];
    var cand = byName[t.name];
    if (!cand) { console.log('[初回検索] 提案を作れません（LINE未接続など）: ' + t.name); continue; }
    if (!FIRST_SEARCH_ENABLED) {
      console.log('[初回検索] 対象（まだ送りません）: ' + t.name);
      continue;
    }
    try {
      var flex = buildConditionSuggestionFlex_(cand);
      pushMessage(cand.lineUserId, [
        textMsg('ご登録ありがとうございます。\n\nいまの条件で探したところ、ご紹介できるお部屋がまだ見つかりませんでした。\n条件を少し広げると見つかることが多いので、よろしければ下からご確認ください。'),
        flex
      ]);
      criteria.getRange(t.rowIndex, CONDITION_SUGGESTION_SENT_COL).setValue(new Date());   // Z列: 旧仕組みの重複防止
      sh.appendRow([t.name, new Date(t.registeredMs), new Date(), '', '返事待ち']);
      sent++;
      console.log('[初回検索] 提案しました: ' + t.name);
    } catch (e) {
      console.warn('[初回検索] 送れません: ' + t.name + ' / ' + e.message);
    }
  }
  return sent;
}

/** 提案から24時間、何も無い人を終了にする。条件を変えた／LINEで何か送った人は継続。 */
function _firstSearchClose_() {
  var sh = _firstSearchSheet_();
  if (sh.getLastRow() < 2) return 0;
  var rows = sh.getRange(2, 1, sh.getLastRow() - 1, 5).getValues();
  var now = Date.now();

  var criteria = SpreadsheetApp.openById(CRITERIA_SHEET_ID).getSheetByName(CRITERIA_SHEET_NAME);
  var cdata = criteria.getDataRange().getValues();
  var searchedOnByName = {};
  for (var i = cdata.length - 1; i >= 1; i--) {
    var n = String(cdata[i][1] || '').trim();
    if (n && !(n in searchedOnByName)) searchedOnByName[n] = String(cdata[i][28] || '').trim();
  }
  var uids = _moveInUserIds_();
  var acts = _moveInLastActivity_();
  var closed = 0;

  for (var r = 0; r < rows.length; r++) {
    if (String(rows[r][4] || '').trim() !== '返事待ち') continue;
    var askedMs = _fdMs_(rows[r][2]);
    if (!askedMs || now - askedMs < FIRST_SEARCH_REPLY_H * 3600000) continue;
    var name = String(rows[r][0] || '').trim();
    var uid = uids[name];

    var changed = (searchedOnByName[name] === '');                       // 条件を変えると AC列が空に戻る
    var talked = !!(uid && acts[uid] && acts[uid] > askedMs);
    if (changed || talked) {
      sh.getRange(r + 2, 4).setValue(changed ? '条件を変えた' : 'LINEで反応');
      sh.getRange(r + 2, 5).setValue('継続');
      continue;
    }
    if (!FIRST_SEARCH_ENABLED) { console.log('[初回検索] 終了の対象（まだ何もしません）: ' + name); continue; }
    try {
      endCustomerAsSilent(name, uid, '初回検索0件の提案を無視');   // AutoEnd.gs
      sh.getRange(r + 2, 5).setValue('終了（音信不通）');
      closed++;
    } catch (e) {
      console.warn('[初回検索] 終了にできません: ' + name + ' / ' + e.message);
    }
  }
  return closed;
}

/** 【トリガー・1時間おき】入口。営業時間内だけ動く。 */
function processFirstSearchFollow() {
  var h = (typeof getJstHour === 'function') ? getJstHour(new Date()) : new Date().getHours();
  if (h < 10 || h >= 20) return;
  try { _firstSearchAsk_(); } catch (e) { console.error('[初回検索] 提案で失敗: ' + e.message); }
  try { _firstSearchClose_(); } catch (e) { console.error('[初回検索] 締めで失敗: ' + e.message); }
}
