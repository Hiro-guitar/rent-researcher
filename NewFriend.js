/**
 * NewFriend.gs - 友だち追加の記録と、「登録だけで止まっている人」へのひと押し
 *
 * 背景（SPEC_CRMリニューアル.md ②LINEに来た / 登録だけ）
 *   友だち追加のイベントは届いていたが、どこにも記録していなかった。
 *   そのため「追加したけれど何もしていない人」が誰で、いつ追加したのかが分からなかった。
 *   過去に止まっている人はもう触らない方針なので、ここから先の追加だけを記録する。
 *
 * 「何もしていない」の見分け方
 *   LINE Activity シートは、メッセージ送信・ボタンのタップがあったときだけ行ができる
 *   （doPost の recordLineActivity）。つまり、友だち追加の記録があって
 *   LINE Activity に行が無い人 ＝ 追加しただけで一度も動いていない人。
 *
 * リマインドは NEW_FRIEND_REMIND_ENABLED が true のときだけ送る。
 * 送るのは1人につき一度きりで、営業時間内（processReplyQueue から呼ばれる）。
 */

var NEW_FRIEND_SHEET = 'LINE友だち追加';
var NEW_FRIEND_REMIND_AFTER_DAYS = 3;
// 文面が決まるまでは送らない。true にすると processReplyQueue が送り始める。
var NEW_FRIEND_REMIND_ENABLED = false;

// 押しメッセージは1通ぶん課金されるので、メッセージは1つだけにする。
var NEW_FRIEND_REMIND_TEXT =
  'えほうまきです。\n' +
  'お部屋探しのお手伝いをさせてください。\n\n' +
  '▼ お問い合わせいただいた物件が気になる方\n' +
  '　下のメニューの「空室確認」をタップ\n\n' +
  '▼ ほかのお部屋も探したい方\n' +
  '　下のメニューの「条件を登録」をタップ（3分で完了）\n\n' +
  'ご質問はこのままLINEにお送りください。担当者が返信します。';

function _newFriendSheet_() {
  var ss = SpreadsheetApp.openById(CRITERIA_SHEET_ID);
  var sh = ss.getSheetByName(NEW_FRIEND_SHEET);
  if (!sh) {
    sh = ss.insertSheet(NEW_FRIEND_SHEET);
    sh.appendRow(['userId', '追加日時', '表示名', '状態', '状態になった日時']);
    try {
      sh.getRange(1, 1, 1, 5).setFontWeight('bold').setBackground('#e0e0e0');
      sh.setFrozenRows(1);
    } catch (_) {}
  }
  return sh;
}

/**
 * 友だち追加を記録する。doPost の follow イベントから呼ばれる。
 * すでに行があれば追加日時は書き換えない（ブロック解除でも follow は届くため）。
 */
function recordNewFriend(userId) {
  try {
    if (!userId) return;
    var sh = _newFriendSheet_();
    var last = sh.getLastRow();
    if (last >= 2) {
      var ids = sh.getRange(2, 1, last - 1, 1).getValues();
      for (var i = 0; i < ids.length; i++) {
        if (String(ids[i][0] || '').trim() === String(userId)) {
          console.log('[友だち追加] すでに記録あり（ブロック解除など）: ' + userId);
          return;
        }
      }
    }
    var displayName = '';
    try {
      var p = getLineProfile(userId);
      displayName = (p && p.displayName) ? p.displayName : '';
    } catch (_e) {}
    // 条件登録済みの人が再追加した場合は、最初から「動きあり」にしておく
    var already = '';
    try { if (readLatestCriteria(userId)) already = '条件登録済み'; } catch (_e2) {}
    sh.appendRow([userId, new Date(), displayName, already, already ? new Date() : '']);
    console.log('[友だち追加] 記録: ' + (displayName || userId) + (already ? ' (' + already + ')' : ''));
  } catch (e) {
    console.warn('[友だち追加] 記録に失敗: ' + e.message);
  }
}

/** LINE Activity シートにある userId の集合。一度でもメッセージ・タップがあった人。 */
function _newFriendActiveUserIds_() {
  var set = {};
  try {
    var sh = SpreadsheetApp.openById(CRITERIA_SHEET_ID).getSheetByName('LINE Activity');
    if (!sh || sh.getLastRow() < 2) return set;
    var ids = sh.getRange(2, 1, sh.getLastRow() - 1, 1).getValues();
    for (var i = 0; i < ids.length; i++) {
      var u = String(ids[i][0] || '').trim();
      if (u) set[u] = true;
    }
  } catch (e) {
    console.warn('[友だち追加] LINE Activity を読めません: ' + e.message);
  }
  return set;
}

/**
 * 追加から一定日数たっても何もしていない人に、ひと押しを1回だけ送る。
 * processReplyQueue（5分おき・営業時間内のみ）から呼ばれる。
 * 状態が空の行だけが対象なので、同じ人に二度送ることはない。
 */
function processNewFriendReminders() {
  var sh = _newFriendSheet_();
  var last = sh.getLastRow();
  if (last < 2) return;
  var data = sh.getRange(2, 1, last - 1, 5).getValues();
  var cutoff = Date.now() - NEW_FRIEND_REMIND_AFTER_DAYS * 24 * 60 * 60 * 1000;

  // まず「日数を過ぎていて、まだ状態が空」の行だけを拾う。
  // 候補がなければ LINE Activity は読まない（毎回読むのは無駄なので）。
  var candidates = [];
  for (var i = 0; i < data.length; i++) {
    if (String(data[i][3] || '').trim() !== '') continue;
    var addedAt = data[i][1];
    if (!(addedAt instanceof Date) || addedAt.getTime() > cutoff) continue;
    candidates.push({ rowIndex: i + 2, userId: String(data[i][0] || '').trim(), name: String(data[i][2] || '') });
  }
  if (candidates.length === 0) return;

  var active = _newFriendActiveUserIds_();
  var now = new Date();
  var sent = 0, moved = 0;
  for (var c = 0; c < candidates.length; c++) {
    var t = candidates[c];
    if (!t.userId) continue;
    if (active[t.userId]) {
      // 追加後に何かしてくれた人。ひと押しは要らない。
      sh.getRange(t.rowIndex, 4, 1, 2).setValues([['動きあり', now]]);
      moved++;
      continue;
    }
    if (!NEW_FRIEND_REMIND_ENABLED) continue;   // 文面が決まるまでは送らない
    try {
      pushMessage(t.userId, [textMsg(NEW_FRIEND_REMIND_TEXT)]);
      sh.getRange(t.rowIndex, 4, 1, 2).setValues([['ひと押し送信', now]]);
      sent++;
    } catch (e) {
      sh.getRange(t.rowIndex, 4, 1, 2).setValues([['送信できず: ' + e.message, now]]);
      console.error('[友だち追加] ひと押しの送信に失敗: ' + (t.name || t.userId) + ' / ' + e.message);
    }
  }
  if (sent || moved) {
    console.log('[友だち追加] ひと押し ' + sent + '件 / 動きありに更新 ' + moved + '件'
      + (NEW_FRIEND_REMIND_ENABLED ? '' : '（送信はまだ止めてあります）'));
  }
}

/**
 * 【GASエディタから実行】今の記録を数えて出す。読み取りだけで何も書き換えない。
 * 「登録だけで止まっている人」が何人いるかを見て、ひと押しを送るか決めるためのもの。
 */
function showNewFriendStats() {
  var sh = _newFriendSheet_();
  var last = sh.getLastRow();
  if (last < 2) {
    console.log('まだ1件も記録がありません（記録は ' + new Date().toLocaleDateString('ja-JP') + ' 以降の友だち追加から）');
    return;
  }
  var data = sh.getRange(2, 1, last - 1, 5).getValues();
  var active = _newFriendActiveUserIds_();
  var byState = {};
  var stuck = [];
  var cutoff = Date.now() - NEW_FRIEND_REMIND_AFTER_DAYS * 24 * 60 * 60 * 1000;
  for (var i = 0; i < data.length; i++) {
    var st = String(data[i][3] || '').trim() || '(何もしていない)';
    byState[st] = (byState[st] || 0) + 1;
    var uid = String(data[i][0] || '').trim();
    var addedAt = data[i][1];
    if (String(data[i][3] || '').trim() === '' && !active[uid]
        && addedAt instanceof Date && addedAt.getTime() <= cutoff) {
      stuck.push((data[i][2] || uid) + '（' + Utilities.formatDate(addedAt, 'Asia/Tokyo', 'M/d') + '追加）');
    }
  }
  console.log('友だち追加の記録: ' + data.length + '件');
  for (var k in byState) console.log('  ' + k + ': ' + byState[k] + '人');
  console.log('うち ' + NEW_FRIEND_REMIND_AFTER_DAYS + '日たっても何もしていない人: ' + stuck.length + '人');
  if (stuck.length) console.log('  ' + stuck.slice(0, 40).join(' / '));
  console.log('ひと押しの送信: ' + (NEW_FRIEND_REMIND_ENABLED ? 'ON' : 'OFF（NewFriend.gs の NEW_FRIEND_REMIND_ENABLED）'));
}
