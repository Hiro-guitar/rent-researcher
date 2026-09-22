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

// 送信を止めるスイッチ。文面と日数が決まるまで false。
var MOVE_IN_ENABLED = false;

// 期限を何日過ぎたら聞くか。0 なら当日。
var MOVE_IN_ASK_AFTER_D = 0;
// 返事を何日待つか。過ぎたら終了とみなす。
var MOVE_IN_WAIT_D = 7;
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
