/**
 * MoveInDeadline.gs — 引越し予定の時期を過ぎた人に、時期を聞き直す
 *
 * 狙い（2026-09-22）:
 *   条件登録済みのお客様が「追客中」に溜まり続けていた。出口がブロックと
 *   条件変更提案の打ち切りしか無く、後者は配信を止めるだけで終了にならない。
 *
 *   引越し予定日は**お客様自身が申告した日付**なので、こちらが勘で決めた日数より
 *   はるかに強い根拠になる。過ぎたら聞き直し、返事が無ければ終了とみなす。
 *
 * ⚠️「いい物件見つかり次第」の人はここでは扱わない。期限が無いので判定できない。
 *   その人たちの出口は別に決める（未定）。
 *
 * ⚠️ 仕組みを入れる前から期限を過ぎている人を巻き込まないこと。
 *   MOVE_IN_MAX_OVERDUE_D で足切りする。初回配信の再送と同じ考え方。
 */

var MOVE_IN_SHEET = '引越し時期の確認';

// 送信を止めるスイッチ。false にすると、数えるだけで何もしない。
var MOVE_IN_ENABLED = false;

// 期限を何日過ぎたら聞くか。0 なら当日。
var MOVE_IN_ASK_AFTER_D = 0;
// 返事を何時間待つか。過ぎたら終了とみなす。
// ⚠️ 短くてよい。あとから返事が来れば戻せる仕組みがあるので、長く待つ意味がない。
var MOVE_IN_WAIT_H = 24;
// これより古い期限切れは拾わない。仕組みを入れる前のお客様を巻き込まない歯止め。
var MOVE_IN_MAX_OVERDUE_D = 30;

function _moveInSheet_() {
  var ss = SpreadsheetApp.openById(CRITERIA_SHEET_ID);
  var sh = ss.getSheetByName(MOVE_IN_SHEET);
  if (!sh) {
    sh = ss.insertSheet(MOVE_IN_SHEET);
    sh.appendRow(['顧客名', '元の引越し時期', '聞いた日時', '返事', '返事の日時', '状態']);
    try {
      sh.getRange(1, 1, 1, 6).setFontWeight('bold').setBackground('#e0e0e0');
      sh.setFrozenRows(1);
    } catch (_) {}
  }
  return sh;
}

/**
 * 期限を過ぎた人を集める。送信はしない。
 * @return {Array<{name:string, moveIn:string, overdue:number, tooOld:boolean, stage:string}>}
 */
function collectMoveInOverdue() {
  var out = [];
  var sh = SpreadsheetApp.openById(CRITERIA_SHEET_ID).getSheetByName(CRITERIA_SHEET_NAME);
  if (!sh || sh.getLastRow() < 2) return out;

  var data = sh.getDataRange().getValues();
  var todayIdx = _jstDayIndex_(Date.now());
  var seen = {};

  for (var i = data.length - 1; i >= 1; i--) {     // 同名は後の行（新しいほう）を採る
    var name = String(data[i][1] || '').trim();    // B列: 顧客名
    if (!name || seen[name]) continue;
    if (typeof _rowHasCriteria_ === 'function' && !_rowHasCriteria_(data[i])) continue;
    seen[name] = true;

    if (String(data[i][32] || '').trim() === '終了') continue;   // AG列(33): 営業ステージ

    var raw = String(data[i][14] || '').trim();    // O列(15): 引越し時期
    if (!raw) continue;
    var mi = _parseMoveInDeadline_(raw);
    if (!mi || mi.asap) continue;                  // 「見つかり次第」は対象外

    var overdue = todayIdx - _jstDayIndex_(mi.ms);
    if (overdue < MOVE_IN_ASK_AFTER_D) continue;

    out.push({
      name: name,
      moveIn: raw,
      overdue: overdue,
      tooOld: overdue > MOVE_IN_MAX_OVERDUE_D,
      stage: String(data[i][32] || '').trim() || '（未設定）'
    });
  }
  out.sort(function (a, b) { return a.overdue - b.overdue; });
  return out;
}

/**
 * 【GASエディタで実行】引越し予定を過ぎた人が何人いるかを数える。
 * ⚠️ 何も送らない。仕組みを入れる前に、足切りの日数を決めるためのもの。
 */
function previewMoveInOverdue() {
  var list = collectMoveInOverdue();
  var fresh = list.filter(function (x) { return !x.tooOld; });
  var old = list.filter(function (x) { return x.tooOld; });

  console.log('=== 引越し予定の時期を過ぎた人 ===');
  console.log('（「いい物件見つかり次第」の人と、営業ステージが「終了」の人は除いています）');
  console.log('');
  console.log('■ ' + MOVE_IN_MAX_OVERDUE_D + '日以内に過ぎた人: ' + fresh.length + '人');
  for (var i = 0; i < fresh.length; i++) {
    console.log('   ' + fresh[i].overdue + '日経過  ' + fresh[i].name
      + '  （申告: ' + fresh[i].moveIn + ' / ' + fresh[i].stage + '）');
  }
  console.log('');
  console.log('■ ' + MOVE_IN_MAX_OVERDUE_D + '日より前に過ぎた人: ' + old.length + '人 ← 自動では触りません');
  var show = Math.min(old.length, 20);
  for (var j = 0; j < show; j++) {
    console.log('   ' + old[j].overdue + '日経過  ' + old[j].name
      + '  （申告: ' + old[j].moveIn + ' / ' + old[j].stage + '）');
  }
  if (old.length > show) console.log('   ほか ' + (old.length - show) + '人');
  console.log('');
  console.log('※ 送信はまだ実装していません。数えているだけです。');
  return { fresh: fresh.length, old: old.length };
}

/**
 * 【GASエディタで実行】「いい物件見つかり次第」の人が何人いるか。
 * この出口が使えない人たちなので、別枠の仕組みが要るかの判断材料にする。
 */
function previewMoveInAsap() {
  var sh = SpreadsheetApp.openById(CRITERIA_SHEET_ID).getSheetByName(CRITERIA_SHEET_NAME);
  if (!sh || sh.getLastRow() < 2) return 0;
  var data = sh.getDataRange().getValues();
  var seen = {}, asap = 0, dated = 0, blank = 0;

  for (var i = data.length - 1; i >= 1; i--) {
    var name = String(data[i][1] || '').trim();
    if (!name || seen[name]) continue;
    if (typeof _rowHasCriteria_ === 'function' && !_rowHasCriteria_(data[i])) continue;
    seen[name] = true;
    if (String(data[i][32] || '').trim() === '終了') continue;

    var raw = String(data[i][14] || '').trim();
    if (!raw) { blank++; continue; }
    var mi = _parseMoveInDeadline_(raw);
    if (!mi) { blank++; continue; }
    if (mi.asap) asap++; else dated++;
  }
  console.log('=== 追客中のお客様の引越し時期 ===');
  console.log('  日付で申告      : ' + dated + '人 ← この出口が使える');
  console.log('  見つかり次第    : ' + asap + '人 ← 別枠が要る');
  console.log('  空欄・読めない  : ' + blank + '人');
  return { dated: dated, asap: asap, blank: blank };
}

// ═══════════════════════════════════════════════════════════
//  聞く／締める
// ═══════════════════════════════════════════════════════════

/** 顧客名 → LINE userId */
function _moveInUserIds_() {
  var map = {};
  try {
    var sh = SpreadsheetApp.openById(CRITERIA_SHEET_ID).getSheetByName(LINE_USERS_SHEET_NAME);
    if (!sh || sh.getLastRow() < 2) return map;
    var rows = sh.getRange(2, 1, sh.getLastRow() - 1, 2).getValues();
    for (var i = 0; i < rows.length; i++) {
      var name = String(rows[i][1] || '').trim();
      if (name) map[name] = String(rows[i][0] || '').trim();   // 後の行が勝つ
    }
  } catch (e) { console.warn('[引越し期限] LINE Users を読めません: ' + e.message); }
  return map;
}

/** userId → 最後にLINEで反応した日時(ms)。聞いたあとに動いたかを見る。 */
function _moveInLastActivity_() {
  var map = {};
  try {
    var sh = SpreadsheetApp.openById(CRITERIA_SHEET_ID).getSheetByName('LINE Activity');
    if (!sh || sh.getLastRow() < 2) return map;
    var rows = sh.getRange(2, 1, sh.getLastRow() - 1, 2).getValues();
    for (var i = 0; i < rows.length; i++) {
      var uid = String(rows[i][0] || '').trim();
      if (!uid) continue;
      var ms = _fdMs_(rows[i][1]);
      if (ms && (!map[uid] || ms > map[uid])) map[uid] = ms;
    }
  } catch (e) { console.warn('[引越し期限] LINE Activity を読めません: ' + e.message); }
  return map;
}

/**
 * その人に今日いつ送るか（10時〜18時のどれか）。
 * ⚠️ 全員に同じ時刻で届けないこと。名前から決めるので保存は要らず、毎回同じ答えになる。
 */
function _moveInSendHour_(name) {
  var h = 0;
  for (var i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 100000;
  return 10 + (h % 9);
}

/** 聞くメッセージ。 */
function buildMoveInAskMessages(customerName, moveIn) {
  return [textMsgWithQuickReply(
    customerName + 'さま\n\n' +
    'ご登録いただいた引越し予定の時期（' + moveIn + '）を過ぎましたが、\n' +
    'お部屋探しはお続けでしょうか。\n\n' +
    '時期が変わっている場合は、下のボタンから教えてください。\n' +
    'あらためてご希望に合うお部屋をお送りします。',
    [
      qrPostback('時期を更新する', 'movein:renew', '時期を更新する'),
      qrPostback('探すのをやめた', 'movein:stop', '探すのをやめた')
    ]
  )];
}

/** 期限を過ぎた人に聞く。 */
function _moveInAsk_(nowHour) {
  var list = collectMoveInOverdue().filter(function (x) { return !x.tooOld; });
  if (!list.length) return 0;

  var sh = _moveInSheet_();
  var asked = {};
  if (sh.getLastRow() > 1) {
    var rows = sh.getRange(2, 1, sh.getLastRow() - 1, 6).getValues();
    for (var r = 0; r < rows.length; r++) asked[String(rows[r][0] || '').trim()] = true;
  }
  var uids = _moveInUserIds_();
  var sent = 0;

  for (var i = 0; i < list.length; i++) {
    var t = list[i];
    if (asked[t.name]) continue;                       // 一度きり
    if (_moveInSendHour_(t.name) !== nowHour) continue;
    var uid = uids[t.name];
    if (!uid) { console.log('[引越し期限] LINE が繋がっていません: ' + t.name); continue; }

    if (!MOVE_IN_ENABLED) {
      console.log('[引越し期限] 対象（まだ送りません）: ' + t.name + ' / ' + t.moveIn);
      continue;
    }
    try {
      pushMessage(uid, buildMoveInAskMessages(t.name, t.moveIn));
      sh.appendRow([t.name, t.moveIn, new Date(), '', '', '返事待ち']);
      sent++;
      console.log('[引越し期限] 聞きました: ' + t.name + ' / ' + t.moveIn);
    } catch (e) {
      console.warn('[引越し期限] 送れません: ' + t.name + ' / ' + e.message);
    }
  }
  return sent;
}

/**
 * 聞いてから24時間、何も無い人を終了にする。
 * ⚠️ 片道切符にしないこと。配信状態は auto_paused にしておき、
 *   あとからメッセージが来たら既存の自動復帰が拾って元に戻す。
 */
function _moveInCloseNoReply_() {
  var sh = _moveInSheet_();
  if (sh.getLastRow() < 2) return 0;
  var rows = sh.getRange(2, 1, sh.getLastRow() - 1, 6).getValues();
  var uids = _moveInUserIds_();
  var acts = _moveInLastActivity_();
  var now = Date.now();
  var closed = 0;

  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i][5] || '').trim() !== '返事待ち') continue;
    var askedMs = _fdMs_(rows[i][2]);
    if (!askedMs || now - askedMs < MOVE_IN_WAIT_H * 60 * 60 * 1000) continue;

    var name = String(rows[i][0] || '').trim();
    var uid = uids[name];

    // 聞いたあとに何か反応があれば、まだ探している人とみなす。
    if (uid && acts[uid] && acts[uid] > askedMs) {
      sh.getRange(i + 2, 4).setValue('反応あり');
      sh.getRange(i + 2, 5).setValue(new Date(acts[uid]));
      sh.getRange(i + 2, 6).setValue('継続');
      continue;
    }

    if (!MOVE_IN_ENABLED) { console.log('[引越し期限] 終了の対象（まだ何もしません）: ' + name); continue; }
    try {
      _moveInEndAsSilent_(name, uid);
      sh.getRange(i + 2, 6).setValue('終了（音信不通）');
      closed++;
      console.log('[引越し期限] 終了にしました: ' + name);
    } catch (e) {
      console.warn('[引越し期限] 終了にできません: ' + name + ' / ' + e.message);
    }
  }
  return closed;
}

/**
 * 音信不通として終了にする。
 * 元のステージを停止理由の欄に書き添えておき、戻ってきたときに復元できるようにする。
 */
function _moveInEndAsSilent_(customerName, userId) {
  var sh = SpreadsheetApp.openById(CRITERIA_SHEET_ID).getSheetByName(CRITERIA_SHEET_NAME);
  var data = sh.getDataRange().getValues();
  var rowNum = -1;
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][1] || '').trim() !== customerName) continue;
    if (typeof _rowHasCriteria_ === 'function' && !_rowHasCriteria_(data[i])) continue;
    rowNum = i + 1;
  }
  if (rowNum < 0) throw new Error('条件の行が見つかりません');

  var before = String(data[rowNum - 1][32] || '').trim() || '未反応';
  sh.getRange(rowNum, 33).setValue('終了');                         // AG列: 営業ステージ
  sh.getRange(rowNum, 20).setValue(MOVE_IN_SILENT_MARK + before);   // T列: 停止理由
  if (userId && typeof setDeliveryStatus === 'function') setDeliveryStatus(userId, 'auto_paused');
}

/** 自動で終了にした印。戻ってきたときの復元にも使う。 */
var MOVE_IN_SILENT_MARK = '音信不通（自動）／元:';

/**
 * 戻ってきた人を元に戻す。auto_paused の自動復帰から呼ばれる。
 * @return {string} 戻したステージ（何もしなければ ''）
 */
function restoreStageIfAutoEnded(userId) {
  try {
    var ss = SpreadsheetApp.openById(CRITERIA_SHEET_ID);
    var lu = ss.getSheetByName(LINE_USERS_SHEET_NAME);
    if (!lu || lu.getLastRow() < 2) return '';
    var luRows = lu.getRange(2, 1, lu.getLastRow() - 1, 2).getValues();
    var name = '';
    for (var i = 0; i < luRows.length; i++) {
      if (String(luRows[i][0] || '').trim() === String(userId)) name = String(luRows[i][1] || '').trim();
    }
    if (!name) return '';

    var sh = ss.getSheetByName(CRITERIA_SHEET_NAME);
    var data = sh.getDataRange().getValues();
    var rowNum = -1;
    for (var r = 1; r < data.length; r++) {
      if (String(data[r][1] || '').trim() !== name) continue;
      if (typeof _rowHasCriteria_ === 'function' && !_rowHasCriteria_(data[r])) continue;
      rowNum = r + 1;
    }
    if (rowNum < 0) return '';

    var reason = String(data[rowNum - 1][19] || '').trim();          // T列
    if (reason.indexOf(MOVE_IN_SILENT_MARK) !== 0) return '';
    if (String(data[rowNum - 1][32] || '').trim() !== '終了') return '';

    var before = reason.substring(MOVE_IN_SILENT_MARK.length).trim() || '未反応';
    sh.getRange(rowNum, 33).setValue(before);
    sh.getRange(rowNum, 20).setValue('');
    console.log('[引越し期限] 戻ってきたので ' + before + ' に戻しました: ' + name);
    return before;
  } catch (e) {
    console.warn('[引越し期限] 復元できません: ' + e.message);
    return '';
  }
}

/**
 * 【トリガー・営業時間内に1時間おき】この仕組みの入口。
 *   1. 期限を過ぎた人に聞く（人ごとに時刻を散らす）
 *   2. 聞いてから24時間、何も無い人を終了にする
 */
function processMoveInDeadline() {
  var h = (typeof getJstHour === 'function') ? getJstHour(new Date()) : new Date().getHours();
  if (h < 10 || h >= 20) return;
  try { _moveInAsk_(h); } catch (e) { console.error('[引越し期限] 聞くところで失敗: ' + e.message); }
  try { _moveInCloseNoReply_(); } catch (e) { console.error('[引越し期限] 締めるところで失敗: ' + e.message); }
}

/** 【GASエディタで実行】今日この時間に誰に送るかを、送らずに確かめる。 */
function testMoveInAskNow() {
  var h = (typeof getJstHour === 'function') ? getJstHour(new Date()) : new Date().getHours();
  var list = collectMoveInOverdue().filter(function (x) { return !x.tooOld; });
  console.log('今は ' + h + '時。対象 ' + list.length + '人。');
  for (var i = 0; i < list.length; i++) {
    console.log('  ' + list[i].name + ' … ' + _moveInSendHour_(list[i].name) + '時に送る予定'
      + (_moveInSendHour_(list[i].name) === h ? '  ← 今この回' : ''));
  }
}
