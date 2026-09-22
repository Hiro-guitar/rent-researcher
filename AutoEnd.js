/**
 * AutoEnd.gs — 音信不通の人を自動で「終了」にする／戻ってきたら元に戻す
 *
 * なぜ1か所にまとめるか（2026-09-22）:
 *   追客中から終了へ抜ける道が3本あり、どれも同じ形をしている。
 *     ・引越し予定の時期を過ぎて聞いたのに、24時間 返事が無い   （MoveInDeadline.gs）
 *     ・条件変更提案を3回送って、最後の確認も24時間 無視された   （ConditionSuggestion.gs）
 *     ・初回配信を2回送って、どちらも開かれなかった           （FirstDeliveryFollow.gs・これから）
 *   終了にする処理と、戻ってきたときに元に戻す処理は共通なので、ここに置く。
 *
 * ⚠️ 片道切符にしないこと。
 *   終了にしても配信状態は auto_paused にしておく。お客様から何か届けば
 *   コード.js の自動復帰が active に戻し、そのとき restoreStageIfAutoEnded が
 *   ステージも元に戻す。「戻ってきた人は、また探している人」。
 *
 * ⚠️ 手で「終了」にした人と混ぜないこと。
 *   自動で終了にしたときだけ、停止理由の欄（T列）に AUTO_END_MARK と元のステージを書く。
 *   復元はこの印がある行にしか働かない。担当者が自分で終了にした人は戻さない。
 *
 * 終了の理由は「音信不通」。自動でつくのはこれだけ。ほかの理由は担当者が付ける。
 */

/** 自動で終了にした印。このあとに元のステージが続く。 */
var AUTO_END_MARK = '音信不通（自動）／元:';

/** 顧客名 → LINE userId（LINE Users シート。同名は後の行が勝つ）。 */
function _autoEndUserId_(customerName) {
  try {
    var sh = SpreadsheetApp.openById(CRITERIA_SHEET_ID).getSheetByName(LINE_USERS_SHEET_NAME);
    if (!sh || sh.getLastRow() < 2) return '';
    var rows = sh.getRange(2, 1, sh.getLastRow() - 1, 2).getValues();
    var uid = '';
    for (var i = 0; i < rows.length; i++) {
      if (String(rows[i][1] || '').trim() === customerName) uid = String(rows[i][0] || '').trim();
    }
    return uid;
  } catch (e) {
    console.warn('[自動終了] LINE Users を読めません: ' + e.message);
    return '';
  }
}

/** 検索条件シートで、その人の条件が入っている行番号（同名は後の行）。無ければ -1。 */
function _autoEndCriteriaRow_(data, customerName) {
  var rowNum = -1;
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][1] || '').trim() !== customerName) continue;
    if (typeof _rowHasCriteria_ === 'function' && !_rowHasCriteria_(data[i])) continue;
    rowNum = i + 1;
  }
  return rowNum;
}

/**
 * 音信不通として終了にする。
 * @param {string} customerName
 * @param {string} [userId]  無ければ顧客名から引く
 * @param {string} [why]     ログに残す理由（例: 引越し期限の返事なし）
 * @return {boolean} 終了にしたか
 */
function endCustomerAsSilent(customerName, userId, why) {
  customerName = String(customerName || '').trim();
  if (!customerName) return false;
  var sh = SpreadsheetApp.openById(CRITERIA_SHEET_ID).getSheetByName(CRITERIA_SHEET_NAME);
  var data = sh.getDataRange().getValues();
  var rowNum = _autoEndCriteriaRow_(data, customerName);
  if (rowNum < 0) throw new Error('条件の行が見つかりません: ' + customerName);

  var current = String(data[rowNum - 1][32] || '').trim();
  if (current === '終了') return false;                            // すでに終了。印も上書きしない

  var before = current || '未反応';
  sh.getRange(rowNum, 33).setValue('終了');                        // AG列: 営業ステージ
  sh.getRange(rowNum, 20).setValue(AUTO_END_MARK + before);        // T列: 停止理由
  if (!userId) userId = _autoEndUserId_(customerName);
  if (userId && typeof setDeliveryStatus === 'function') setDeliveryStatus(userId, 'auto_paused');
  console.log('[自動終了] ' + customerName + ' を終了にしました（' + (why || '音信不通') + '／元: ' + before + '）');
  return true;
}

/**
 * 戻ってきた人を元に戻す。コード.js の auto_paused 自動復帰から呼ばれる。
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
    var rowNum = _autoEndCriteriaRow_(data, name);
    if (rowNum < 0) return '';

    var reason = String(data[rowNum - 1][19] || '').trim();          // T列
    if (reason.indexOf(AUTO_END_MARK) !== 0) return '';             // 手で終了にした人は触らない
    if (String(data[rowNum - 1][32] || '').trim() !== '終了') return '';

    var before = reason.substring(AUTO_END_MARK.length).trim() || '未反応';
    sh.getRange(rowNum, 33).setValue(before);
    sh.getRange(rowNum, 20).setValue('');
    console.log('[自動終了] 戻ってきたので ' + before + ' に戻しました: ' + name);
    return before;
  } catch (e) {
    console.warn('[自動終了] 復元できません: ' + e.message);
    return '';
  }
}

/**
 * 【GASエディタで実行】いま auto_paused なのに終了になっていない人を数える。
 * この仕組みを入れる前に auto_paused になった人が残っているはず。
 * ⚠️ 何も変えない。まとめて終了にするかどうかを決めるためのもの。
 */
function previewAutoPausedNotEnded() {
  var sh = SpreadsheetApp.openById(CRITERIA_SHEET_ID).getSheetByName(CRITERIA_SHEET_NAME);
  var data = sh.getDataRange().getValues();
  var seen = {};
  var list = [];
  for (var i = data.length - 1; i >= 1; i--) {
    var name = String(data[i][1] || '').trim();
    if (!name || seen[name]) continue;
    if (typeof _rowHasCriteria_ === 'function' && !_rowHasCriteria_(data[i])) continue;
    seen[name] = true;
    if (String(data[i][18] || '').trim().toLowerCase() !== 'auto_paused') continue;   // S列
    var stage = String(data[i][32] || '').trim();
    if (stage === '終了') continue;
    list.push(name + '  （' + (stage || '未設定') + '）');
  }
  console.log('=== auto_paused なのに終了になっていない人: ' + list.length + '人 ===');
  for (var k = 0; k < list.length; k++) console.log('  ' + list[k]);
  console.log('');
  console.log('※ 何も変えていません。まとめて終了にするなら endAllAutoPausedAsSilent を実行。');
  return list.length;
}

/**
 * 【GASエディタで実行・一度だけ】上で数えた人を、まとめて終了（音信不通）にする。
 * 戻ってくれば元に戻るのは、これから自動で終了になる人と同じ。
 */
function endAllAutoPausedAsSilent() {
  var sh = SpreadsheetApp.openById(CRITERIA_SHEET_ID).getSheetByName(CRITERIA_SHEET_NAME);
  var data = sh.getDataRange().getValues();
  var seen = {};
  var done = 0;
  for (var i = data.length - 1; i >= 1; i--) {
    var name = String(data[i][1] || '').trim();
    if (!name || seen[name]) continue;
    if (typeof _rowHasCriteria_ === 'function' && !_rowHasCriteria_(data[i])) continue;
    seen[name] = true;
    if (String(data[i][18] || '').trim().toLowerCase() !== 'auto_paused') continue;
    if (String(data[i][32] || '').trim() === '終了') continue;
    try {
      if (endCustomerAsSilent(name, '', '条件変更提案を3回無視（まとめて）')) done++;
    } catch (e) {
      console.warn('[自動終了] ' + name + ': ' + e.message);
    }
  }
  console.log('=== ' + done + '人を終了にしました ===');
  return done;
}
