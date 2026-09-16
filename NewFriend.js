/**
 * NewFriend.gs - 友だち追加の記録と、「登録だけで止まっている人」へのひと押し
 *
 * 背景（SPEC_CRMリニューアル.md ②LINEに来た / 登録だけ）
 *   友だち追加のイベントは届いていたが、どこにも記録していなかった。
 *   そのため「追加したけれど何もしていない人」が誰で、いつ追加したのかが分からなかった。
 *   過去に止まっている人はもう触らない方針なので、ここから先の追加だけを記録する。
 *
 * 「何もしていない」の見分け方
 *   ⚠️ LINE Activity（メッセージ・タップがあると行ができる）だけで見てはいけない。
 *     メニューの「空室確認」を押すとテキストが1通送られるので、押しただけで
 *     物件名を送らずに終わった人まで「動きあり」になってしまう。実質は登録だけの人。
 *   そこで、意味のある所まで進んだときにこのシートの「状態」を進める。
 *     （空）登録だけ < 空室確認あり < 条件登録済み
 *   状態が空のままの人が「登録だけの人」。ただし、いま担当者とやり取りしている
 *   最中の人に割り込まないよう、直近のやり取りが新しい人には送らない。
 *
 * リマインドは NEW_FRIEND_REMIND_ENABLED が true のときだけ送る。
 * 送るのは1人につき一度きりで、営業時間内（processReplyQueue から呼ばれる）。
 */

var NEW_FRIEND_SHEET = 'LINE友だち追加';
// 状態の段階。後ろほど進んでいる。戻すことはしない。
var NEW_FRIEND_STATES = ['空室確認あり', '条件登録済み'];
// 翌日に送る。営業時間内にしか送らないので、16時間にしておくと
// 日中に追加した人はその日には飛ばず、必ず翌日の10時以降になる。
var NEW_FRIEND_REMIND_AFTER_HOURS = 16;
// 文面が決まるまでは送らない。true にすると processReplyQueue が送り始める。
var NEW_FRIEND_REMIND_ENABLED = false;

// 押しメッセージは1通ぶん課金されるので、メッセージは1つだけにする。
// 目的は「空室確認」か「条件を登録」のどちらかを押してもらうこと。
// 挨拶と同じ案内を繰り返しても動かないので、押す場所をこのカードの中に置く。
// ⚠️ 「お問い合わせいただいた物件」とは書かないこと。電話で問い合わせた人や
//   紹介で友だち追加しただけの人には当てはまらず、話が噛み合わなくなる。
function buildNewFriendRemindMessages() {
  return [{
    type: 'flex', altText: 'お部屋探し、お手伝いします',
    contents: {
      type: 'bubble',
      body: {
        type: 'box', layout: 'vertical', spacing: 'sm', paddingAll: 'xl',
        contents: [
          { type: 'text', text: 'お部屋探し、お手伝いします', weight: 'bold', size: 'md', color: '#333333' },
          { type: 'text', text: '気になるお部屋があれば、空き状況をすぐお調べします。\nご希望の条件を登録いただくと、条件に合うお部屋が出たときにお知らせします。',
            size: 'sm', color: '#555555', wrap: true, margin: 'md' }
        ]
      },
      footer: {
        type: 'box', layout: 'vertical', spacing: 'sm', paddingAll: 'lg',
        contents: [
          { type: 'button', style: 'primary', color: '#6ea814', height: 'sm',
            action: { type: 'message', label: '空室確認する', text: '空室確認' } },
          { type: 'button', style: 'primary', color: '#6ea814', height: 'sm',
            action: { type: 'message', label: '条件を登録する（3分）', text: '条件登録' } }
        ]
      }
    }
  }];
}

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

/**
 * その人の状態を進める。今より前の段階には戻さない。
 * 記録が無い人（この仕組みより前に友だち追加した人）は何もしない。
 *   - 空室確認あり  … 物件名やURLを送って空室確認が進んだとき（VacancyRequest.js）
 *   - 条件登録済み  … 条件を登録し終えたとき（SheetWriter.js writeToSheet）
 */
function markNewFriendState(userId, state) {
  try {
    if (!userId || NEW_FRIEND_STATES.indexOf(state) < 0) return;
    var sh = _newFriendSheet_();
    var last = sh.getLastRow();
    if (last < 2) return;
    var rows = sh.getRange(2, 1, last - 1, 4).getValues();
    for (var i = 0; i < rows.length; i++) {
      if (String(rows[i][0] || '').trim() !== String(userId)) continue;
      var cur = String(rows[i][3] || '').trim();
      var curRank = NEW_FRIEND_STATES.indexOf(cur);          // 未知/空なら -1
      var newRank = NEW_FRIEND_STATES.indexOf(state);
      if (curRank >= newRank) return;                        // すでに同じか先に進んでいる
      sh.getRange(i + 2, 4, 1, 2).setValues([[state, new Date()]]);
      console.log('[友だち追加] 状態を更新: ' + (rows[i][2] || userId) + ' → ' + state);
      return;
    }
  } catch (e) {
    console.warn('[友だち追加] 状態の更新に失敗: ' + e.message);
  }
}

/**
 * その人が会話フローの途中にいるか（空室確認・条件登録・入居申込のどれか）。
 * 途中の人は「途中離脱のひと押し」が担当するので、こちらでは送らない。
 */
function _hasLiveFlowState_(userId) {
  try {
    var raw = PropertiesService.getUserProperties().getProperty('state_' + userId);
    if (!raw) return false;
    var st = JSON.parse(raw);
    return !!_abandonedRemindKind_(st && st.step);
  } catch (e) {
    return false;
  }
}

/** userId → 直近のやり取り時刻(ms)。LINE Activity シートから。 */
function _newFriendLastActivityMap_() {
  var map = {};
  try {
    var sh = SpreadsheetApp.openById(CRITERIA_SHEET_ID).getSheetByName('LINE Activity');
    if (!sh || sh.getLastRow() < 2) return map;
    var rows = sh.getRange(2, 1, sh.getLastRow() - 1, 2).getValues();
    for (var i = 0; i < rows.length; i++) {
      var u = String(rows[i][0] || '').trim();
      var at = rows[i][1];
      if (u && at instanceof Date) map[u] = at.getTime();
    }
  } catch (e) {
    console.warn('[友だち追加] LINE Activity を読めません: ' + e.message);
  }
  return map;
}

/**
 * 追加から一定時間たっても何もしていない人に、ひと押しを1回だけ送る（翌日）。
 * processReplyQueue（5分おき・営業時間内のみ）から呼ばれる。
 * 状態が空の行だけが対象なので、同じ人に二度送ることはない。
 */
function processNewFriendReminders() {
  var sh = _newFriendSheet_();
  var last = sh.getLastRow();
  if (last < 2) return;
  var data = sh.getRange(2, 1, last - 1, 5).getValues();
  var cutoff = Date.now() - NEW_FRIEND_REMIND_AFTER_HOURS * 60 * 60 * 1000;

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

  // ⚠️ 「メニューを押した」だけでは進んだことにしない。押しただけで止まった人こそ対象。
  //   ただし、いま担当者とやり取りしている最中の人に割り込まないよう、
  //   直近のやり取りが新しい人は今回は見送る（次の回に持ち越す）。
  var lastActivity = _newFriendLastActivityMap_();

  // ⚠️ 状態が進んでいなくても、実は条件が登録されている人がいる。
  //   電話のお客様のように、担当者が代わりに登録する場合、
  //   管理画面がLINEのIDを持っていないと状態を進められないため。
  //   ここで検索条件シートを見て、登録済みなら送らない。
  var registeredUserIds = {};
  try {
    var ss2 = SpreadsheetApp.openById(CRITERIA_SHEET_ID);
    var lu2 = ss2.getSheetByName(LINE_USERS_SHEET_NAME);
    var cs2 = ss2.getSheetByName(CRITERIA_SHEET_NAME);
    var withCriteria2 = {};
    if (cs2 && cs2.getLastRow() > 1) {
      var csRows2 = cs2.getRange(2, 1, cs2.getLastRow() - 1, cs2.getLastColumn()).getValues();
      for (var q = 0; q < csRows2.length; q++) {
        var nmq = String(csRows2[q][1] || '').trim();
        if (nmq && _rowHasCriteria_(csRows2[q])) withCriteria2[nmq] = true;
      }
    }
    if (lu2 && lu2.getLastRow() > 1) {
      var luRows2 = lu2.getRange(2, 1, lu2.getLastRow() - 1, 2).getValues();
      for (var w = 0; w < luRows2.length; w++) {
        var uw = String(luRows2[w][0] || '').trim();
        var nw = String(luRows2[w][1] || '').trim();
        if (uw && nw && withCriteria2[nw]) registeredUserIds[uw] = true;
      }
    }
  } catch (eR) {
    console.error('[友だち追加] 登録済みかを確かめられないため今回は送りません: ' + eR.message);
    return;
  }

  var now = new Date();
  var sent = 0, skipped = 0;
  for (var c = 0; c < candidates.length; c++) {
    var t = candidates[c];
    if (!t.userId) continue;
    if (registeredUserIds[t.userId]) {
      // 担当者が代わりに登録した人。催促は要らない。
      sh.getRange(t.rowIndex, 4, 1, 2).setValues([['条件登録済み', now]]);
      skipped++;
      continue;
    }
    var la = lastActivity[t.userId];
    if (la && la > cutoff) { skipped++; continue; }   // やり取りが続いている
    // フローの途中で止まっている人は、あちら（途中離脱のひと押し）の担当。
    // 両方が同じ回に動くと2通届いてしまう。役割をはっきり分ける。
    if (_hasLiveFlowState_(t.userId)) { skipped++; continue; }
    if (!NEW_FRIEND_REMIND_ENABLED) continue;         // 文面が決まるまでは送らない
    try {
      pushMessage(t.userId, buildNewFriendRemindMessages());
      sh.getRange(t.rowIndex, 4, 1, 2).setValues([['ひと押し送信', now]]);
      sent++;
    } catch (e) {
      sh.getRange(t.rowIndex, 4, 1, 2).setValues([['送信できず: ' + e.message, now]]);
      console.error('[友だち追加] ひと押しの送信に失敗: ' + (t.name || t.userId) + ' / ' + e.message);
    }
  }
  if (sent || skipped) {
    console.log('[友だち追加] ひと押し ' + sent + '件 / 登録済み・やり取り中のため見送り ' + skipped + '件'
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
  var lastActivity = _newFriendLastActivityMap_();
  var byState = {};
  var stuck = [];
  var chatting = [];
  var cutoff = Date.now() - NEW_FRIEND_REMIND_AFTER_HOURS * 60 * 60 * 1000;
  for (var i = 0; i < data.length; i++) {
    var st = String(data[i][3] || '').trim() || '(登録だけ)';
    byState[st] = (byState[st] || 0) + 1;
    var uid = String(data[i][0] || '').trim();
    var addedAt = data[i][1];
    if (String(data[i][3] || '').trim() !== '') continue;
    if (!(addedAt instanceof Date) || addedAt.getTime() > cutoff) continue;
    var label = (data[i][2] || uid) + '（' + Utilities.formatDate(addedAt, 'Asia/Tokyo', 'M/d') + '追加'
      + (lastActivity[uid] ? '・メニューは触っている' : '・一度も触っていない') + '）';
    if (lastActivity[uid] && lastActivity[uid] > cutoff) chatting.push(label);
    else stuck.push(label);
  }
  console.log('友だち追加の記録: ' + data.length + '件');
  for (var k in byState) console.log('  ' + k + ': ' + byState[k] + '人');
  console.log('うち ' + NEW_FRIEND_REMIND_AFTER_HOURS + '時間たっても先へ進んでいない人: ' + stuck.length + '人');
  if (stuck.length) console.log('  ' + stuck.slice(0, 40).join(' / '));
  if (chatting.length) {
    console.log('（やり取りが続いているため見送る人: ' + chatting.length + '人）');
    console.log('  ' + chatting.slice(0, 20).join(' / '));
  }
  console.log('ひと押しの送信: ' + (NEW_FRIEND_REMIND_ENABLED ? 'ON' : 'OFF（NewFriend.gs の NEW_FRIEND_REMIND_ENABLED）'));
}

// ═══════════════════════════════════════════════════════════
//  途中でやめた人を見つける
//
//  会話の状態は PropertiesService.getUserProperties() に
//  'state_<userId>' というキーで入っている（StateManager.js）。
//  ウェブアプリは所有者として動くので、全員ぶんが1つの入れ物に入る。
//  つまり、ここを読めば「今どのステップで止まっているか」が全員ぶん分かる。
//
//  これで3つを見分けられる。
//    ・状態があって IDLE でない → 途中でやめた人（どこでやめたかまで分かる）
//    ・状態が無くて一度も動いていない → 追加しただけの人
//    ・状態が無くてやり取りがある → 担当者と会話している人（触らない）
// ═══════════════════════════════════════════════════════════

/** ステップから「どこで止まったか」を日本語にする。分からないものは null（対象外）。 */
function _abandonedStepLabel_(step, state) {
  if (!step || step === STEPS.IDLE) return null;
  if (step === STEPS.WAITING_VACANCY) {
    var mode = (state && state.data && state.data.vcMode) || '';
    if (mode === 'email') return '空室確認: メールアドレス待ち';
    if (mode === 'choose') return '空室確認: 物件を選ぶところ';
    return '空室確認: 物件名やURL待ち';
  }
  if (String(step).indexOf('waiting_for_') === 0) return '入居申込: ' + step;
  if (String(step).indexOf('STEP_') === 0) return '条件登録: ' + step;
  if (String(step).indexOf('WAITING_') === 0) return 'その他: ' + step;
  return 'その他: ' + step;
}

/**
 * 【GASエディタから実行】途中でやめた人を一覧で出す。読み取りだけで何も書き換えない。
 * 次の日にひと押しを送るかどうかを決めるための下見。
 */
function showAbandonedFlows() {
  var props = PropertiesService.getUserProperties();
  var all = props.getProperties();
  var keys = Object.keys(all).filter(function (k) { return k.indexOf('state_') === 0; });
  console.log('会話状態の数: ' + keys.length + '件');

  var now = Date.now();
  var buckets = {};
  var rows = [];
  var totalBytes = 0;
  for (var i = 0; i < keys.length; i++) {
    var raw = all[keys[i]];
    totalBytes += (keys[i].length + String(raw || '').length);
    var st = null;
    try { st = JSON.parse(raw); } catch (_) { continue; }
    var label = _abandonedStepLabel_(st.step, st);
    if (!label) continue;
    var ageH = st.updatedAt ? Math.floor((now - st.updatedAt) / 3600000) : -1;
    var head = label.split(':')[0];
    buckets[head] = (buckets[head] || 0) + 1;
    rows.push({ userId: keys[i].substring(6), label: label, ageH: ageH });
  }
  rows.sort(function (a, b) { return a.ageH - b.ageH; });

  // ⚠️ 状態が残っているだけで、実は登録し終えている人がかなり混ざる。
  //   条件選択ページで登録を終えると状態は消えるはずだが、ページを開いたまま
  //   別経路で登録した場合などに残る。そのまま送ると登録済みの人に
  //   「途中です」と送ってしまうので、必ず本当に未完了かを確かめる。
  var lineUsers = {};
  try {
    var luSh = SpreadsheetApp.openById(CRITERIA_SHEET_ID).getSheetByName(LINE_USERS_SHEET_NAME);
    if (luSh && luSh.getLastRow() > 1) {
      var luRows = luSh.getRange(2, 1, luSh.getLastRow() - 1, 2).getValues();
      for (var l = 0; l < luRows.length; l++) {
        var lu = String(luRows[l][0] || '').trim();
        if (lu) lineUsers[lu] = String(luRows[l][1] || '').trim();
      }
    }
  } catch (_eLu) {}
  var withCriteria = {};
  try {
    var csSh = SpreadsheetApp.openById(CRITERIA_SHEET_ID).getSheetByName(CRITERIA_SHEET_NAME);
    if (csSh && csSh.getLastRow() > 1) {
      var csRows = csSh.getRange(2, 1, csSh.getLastRow() - 1, csSh.getLastColumn()).getValues();
      for (var c2 = 0; c2 < csRows.length; c2++) {
        var nm2 = String(csRows[c2][1] || '').trim();
        if (nm2 && _rowHasCriteria_(csRows[c2])) withCriteria[nm2] = true;
      }
    }
  } catch (_eCs) {}
  var doneCount = 0;
  for (var d2 = 0; d2 < rows.length; d2++) {
    var nm3 = lineUsers[rows[d2].userId];
    rows[d2].done = !!(nm3 && withCriteria[nm3]);
    if (rows[d2].done) doneCount++;
  }
  var real = rows.filter(function (r) { return !r.done; });

  console.log('（保存されている総量: 約 ' + Math.round(totalBytes / 1024) + 'KB / 上限 500KB）');
  console.log('状態が途中のまま残っている人: ' + rows.length + '人');
  for (var k in buckets) console.log('  ' + k + ': ' + buckets[k] + '人');
  console.log('  うち すでに条件登録を終えている（状態が残っているだけ）: ' + doneCount + '人');
  console.log('本当に途中でやめている人: ' + real.length + '人');
  var realBuckets = {};
  for (var rb = 0; rb < real.length; rb++) {
    var h2 = real[rb].label.split(':')[0];
    realBuckets[h2] = (realBuckets[h2] || 0) + 1;
  }
  for (var k2 in realBuckets) console.log('  ' + k2 + ': ' + realBuckets[k2] + '人');
  console.log('--- 本当に途中の人の経過時間 ---');
  var within12 = real.filter(function (r) { return r.ageH >= 0 && r.ageH < 12; }).length;
  var h12to24 = real.filter(function (r) { return r.ageH >= 12 && r.ageH < 24; }).length;
  var over24 = real.filter(function (r) { return r.ageH >= 24; }).length;
  console.log('  12時間以内: ' + within12 + '人 / 12〜24時間: ' + h12to24 + '人 / 24時間超(受付は切れている): ' + over24 + '人');
  console.log('--- 本当に途中の人を新しい順に30件 ---');
  for (var r2 = 0; r2 < Math.min(30, real.length); r2++) {
    console.log('  ' + real[r2].ageH + '時間前 / ' + real[r2].label
      + (lineUsers[real[r2].userId] ? ' / ' + lineUsers[real[r2].userId] : ' / (名前なし)'));
  }
}

// ═══════════════════════════════════════════════════════════
//  翌日のひと押し（途中でやめた人へ）
//
//  会話の状態（state_<userId>）を見て、どこで止まったかに合わせて送る。
//  担当者と普通に会話している人は状態を持たないので、ぶつからない。
//
//  ⚠️ 状態が残っているだけで、実は登録し終えている人が混ざる（実測 146人中59人）。
//    送る前に必ず検索条件シートで確かめる。
//
//  始める前に markExistingFlowsAsNudged() を1回だけ実行すること。
//  今ある87人ぶんの古い状態に送ってしまわないため（過去の人には触らない方針）。
// ═══════════════════════════════════════════════════════════

var ABANDONED_REMIND_ENABLED = false;      // 文面が決まるまでは送らない
var ABANDONED_REMIND_MIN_HOURS = 12;       // これより前には送らない（＝翌日）
var ABANDONED_REMIND_MAX_HOURS = 72;       // これより古いものは今さら送らない

/** そのステップにひと押しを送るか。配信停止まわりの途中には触らない。 */
function _abandonedRemindKind_(step) {
  if (!step || step === STEPS.IDLE) return '';
  if (step === STEPS.WAITING_VACANCY) return 'vacancy';
  if (String(step).indexOf('waiting_for_') === 0) return 'apply';
  if (String(step).indexOf('STEP_') === 0) {
    return (step === STEPS.CRITERIA_SELECT) ? 'criteria_page' : 'criteria_flow';
  }
  return '';   // WAITING_STOP_REASON など。放っておく
}

/** 止まった場所に合わせたメッセージ。 */
function _abandonedRemindMessages_(kind, userId, state) {
  if (kind === 'vacancy') {
    var mode = (state && state.data && state.data.vcMode) || '';
    // 問い合わせ物件のボタンを出したまま止まった人には、物件名を聞き直すより
    // 同じボタンをもう一度出す方が早い。前のカードは流れて見えなくなっている。
    if (mode === 'choose') {
      try {
        var ctx = _vacancyEntryContext_(userId);
        if (ctx.inquiries.length > 0) return [_vacancyChooserMessage_(ctx.inquiries)];
      } catch (_eC) {}
    }
    if (mode === 'email') {
      return [textMsg(
        'お部屋の空室確認、まだ承れていません。\n\n' +
        'お問い合わせ時のメールアドレスをお送りいただければ、すぐにお調べします。\n' +
        '物件名や、SUUMO・HOME\'SなどのURLでも大丈夫です。'
      )];
    }
    return [textMsg(
      'お部屋の空室確認、まだ承れていません。\n\n' +
      'お調べするお部屋の物件名、またはSUUMOやHOME\'SなどのURLをお送りください。\n' +
      '複数ある場合は、まとめて1通で送っていただいて大丈夫です。'
    )];
  }
  if (kind === 'apply') {
    return [textMsg(
      '入居申込のご入力が途中になっています。\n\n' +
      'このまま続きをお答えいただけます。\n' +
      'ご不明な点があれば、そのままLINEにお送りください。担当者が返信します。'
    )];
  }
  if (kind === 'criteria_page') {
    var url = '';
    try {
      var sp = (typeof _criteriaStateParam_ === 'function') ? _criteriaStateParam_(userId) : '';
      url = 'https://liff.line.me/' + LIFF_ID + '?userId=' + encodeURIComponent(userId) + (sp ? '&s=' + sp : '');
    } catch (_) {}
    if (!url) return [textMsg('お部屋探しの条件のご登録が途中になっています。\n下のメニューの「条件を登録」からお願いします。')];
    return [{
      type: 'flex', altText: 'お部屋探しの条件のご登録が途中です',
      contents: {
        type: 'bubble',
        body: {
          type: 'box', layout: 'vertical', spacing: 'sm', paddingAll: 'xl',
          contents: [
            { type: 'text', text: 'あと少しで登録が終わります', weight: 'bold', size: 'md', color: '#333333' },
            { type: 'text', text: 'エリア・家賃・間取りなどを選んでいただくと、条件に合うお部屋が出た時にすぐお知らせします。',
              size: 'sm', color: '#555555', wrap: true, margin: 'md' }
          ]
        },
        footer: {
          type: 'box', layout: 'vertical', paddingAll: 'lg',
          contents: [{ type: 'button', style: 'primary', color: '#6ea814', height: 'sm',
            action: { type: 'uri', label: '続きから選ぶ', uri: url } }]
        }
      }
    }];
  }
  // criteria_flow
  return [textMsg(
    'お部屋探しの条件のご登録が途中になっています。\n\n' +
    'このまま続きをお答えいただけます。\n' +
    '最初からやり直す場合は、下のメニューの「条件を登録」をタップしてください。'
  )];
}

/**
 * 途中でやめた人に、翌日ひと押しを1回だけ送る。
 * processReplyQueue（5分おき・営業時間内のみ）から呼ばれる。
 */
function processAbandonedFlowReminders() {
  var props = PropertiesService.getUserProperties();
  var all = props.getProperties();
  var now = Date.now();

  // まず候補を絞る。ここまではシートを一切読まない。
  var candidates = [];
  for (var key in all) {
    if (key.indexOf('state_') !== 0) continue;
    var st = null;
    try { st = JSON.parse(all[key]); } catch (_) { continue; }
    if (!st || st.__nudged || !st.updatedAt) continue;
    var ageH = (now - st.updatedAt) / 3600000;
    if (ageH < ABANDONED_REMIND_MIN_HOURS || ageH > ABANDONED_REMIND_MAX_HOURS) continue;
    var kind = _abandonedRemindKind_(st.step);
    if (!kind) continue;
    candidates.push({ key: key, userId: key.substring(6), state: st, kind: kind, ageH: Math.round(ageH) });
  }
  if (candidates.length === 0) return;

  // 状態が残っているだけで実は登録済み、という人を外す
  var done = {};
  try {
    var ss = SpreadsheetApp.openById(CRITERIA_SHEET_ID);
    var luSh = ss.getSheetByName(LINE_USERS_SHEET_NAME);
    var csSh = ss.getSheetByName(CRITERIA_SHEET_NAME);
    var names = {};
    if (luSh && luSh.getLastRow() > 1) {
      var luRows = luSh.getRange(2, 1, luSh.getLastRow() - 1, 2).getValues();
      for (var l = 0; l < luRows.length; l++) {
        var u = String(luRows[l][0] || '').trim();
        if (u) names[u] = String(luRows[l][1] || '').trim();
      }
    }
    var withCriteria = {};
    if (csSh && csSh.getLastRow() > 1) {
      var csRows = csSh.getRange(2, 1, csSh.getLastRow() - 1, csSh.getLastColumn()).getValues();
      for (var c = 0; c < csRows.length; c++) {
        var nm = String(csRows[c][1] || '').trim();
        if (nm && _rowHasCriteria_(csRows[c])) withCriteria[nm] = true;
      }
    }
    for (var d = 0; d < candidates.length; d++) {
      var nm2 = names[candidates[d].userId];
      if (nm2 && withCriteria[nm2]) done[candidates[d].userId] = true;
    }
  } catch (e) {
    // 確かめられないときは送らない。登録済みの人に「途中です」と送る方が害が大きい。
    console.error('[途中離脱] 登録済みかを確かめられないため今回は送りません: ' + e.message);
    return;
  }

  var sent = 0, skipped = 0;
  for (var i = 0; i < candidates.length; i++) {
    var t = candidates[i];
    // 条件登録の途中でも、すでに条件を持っている人には送らない（条件変更の中断など）
    if (done[t.userId] && t.kind !== 'vacancy') { skipped++; _markNudged_(props, t); continue; }
    if (!ABANDONED_REMIND_ENABLED) continue;
    try {
      pushMessage(t.userId, _abandonedRemindMessages_(t.kind, t.userId, t.state));
      // 送ったからには続きができるよう、受付の期限も延ばす（24時間で切れるため）
      _markNudged_(props, t, true);
      // 「登録だけの人」向けのひと押しが二重で飛ばないようにする
      _markNewFriendNudged_(t.userId);
      sent++;
      console.log('[途中離脱] ひと押し: ' + t.kind + ' / ' + t.ageH + '時間前に中断');
    } catch (e2) {
      _markNudged_(props, t);   // 送れない相手に何度も試さない
      console.error('[途中離脱] 送信に失敗: ' + t.userId + ' / ' + e2.message);
    }
  }
  if (sent || skipped) {
    console.log('[途中離脱] ひと押し ' + sent + '件 / 登録済みのため見送り ' + skipped + '件'
      + (ABANDONED_REMIND_ENABLED ? '' : '（送信はまだ止めてあります）'));
  }
}

/**
 * 友だち追加の記録側にも「ひと押し済み」を書く。
 * ⚠️ これが無いと、途中離脱のひと押しを受けた人が、少しあとに
 *   「登録だけの人」向けのひと押しも受けてしまう（二重送信）。
 */
function _markNewFriendNudged_(userId) {
  try {
    var sh = _newFriendSheet_();
    var last = sh.getLastRow();
    if (last < 2) return;
    var rows = sh.getRange(2, 1, last - 1, 4).getValues();
    for (var i = 0; i < rows.length; i++) {
      if (String(rows[i][0] || '').trim() !== String(userId)) continue;
      if (String(rows[i][3] || '').trim() !== '') return;   // すでに何か入っている
      sh.getRange(i + 2, 4, 1, 2).setValues([['ひと押し送信', new Date()]]);
      return;
    }
  } catch (e) {
    console.warn('[途中離脱] 友だち追加側の印を書けません: ' + e.message);
  }
}

/** ひと押し済みの印をつける。refresh=true なら受付の期限も今から数え直す。 */
function _markNudged_(props, t, refresh) {
  try {
    t.state.__nudged = Date.now();
    if (refresh) t.state.updatedAt = Date.now();
    props.setProperty(t.key, JSON.stringify(t.state));
  } catch (e) {
    console.warn('[途中離脱] 印をつけられません: ' + t.key + ' / ' + e.message);
  }
}

/**
 * 【GASエディタから1回だけ実行】今ある会話状態すべてに「ひと押し済み」の印をつける。
 * 過去に途中でやめた人には触らない方針なので、送信を始める前に必ず実行する。
 */
function markExistingFlowsAsNudged() {
  var props = PropertiesService.getUserProperties();
  var all = props.getProperties();
  var n = 0;
  for (var key in all) {
    if (key.indexOf('state_') !== 0) continue;
    var st = null;
    try { st = JSON.parse(all[key]); } catch (_) { continue; }
    if (!st || st.__nudged) continue;
    st.__nudged = Date.now();
    props.setProperty(key, JSON.stringify(st));
    n++;
  }
  console.log('既存の会話状態 ' + n + '件に印をつけました。これ以降に中断した人だけが対象になります。');
}

/**
 * 【GASエディタから実行】古い会話状態を消す。既定は30日より前。
 * 状態は放っておくと消えないので、ときどき掃除する。上限は500KB。
 */
function cleanupOldConversationStates(days) {
  days = (typeof days === 'number' && days > 0) ? days : 30;
  var props = PropertiesService.getUserProperties();
  var all = props.getProperties();
  var cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  var deleted = 0, kept = 0;
  for (var key in all) {
    if (key.indexOf('state_') !== 0) continue;
    var st = null;
    try { st = JSON.parse(all[key]); } catch (_) { props.deleteProperty(key); deleted++; continue; }
    if (st && st.updatedAt && st.updatedAt < cutoff) { props.deleteProperty(key); deleted++; }
    else kept++;
  }
  console.log('古い会話状態を ' + deleted + '件消しました（' + days + '日より前）。残り ' + kept + '件。');
}

/**
 * 【GASエディタから実行】今月のメッセージ通数と残りを見る。
 *
 * LINEの数え方:
 *   ・お客様からの送信に対する「返信」は無料でカウントされない
 *   ・こちらから送る「プッシュ」はカウントされる（メッセージの個数 × 人数）
 * 催促メッセージはプッシュなので、ここに乗る。
 */
function showLineMessageQuota() {
  function get(path) {
    var res = UrlFetchApp.fetch('https://api.line.me/v2/bot/message/' + path, {
      headers: { 'Authorization': 'Bearer ' + CHANNEL_ACCESS_TOKEN },
      muteHttpExceptions: true
    });
    if (typeof _addFetchCount_ === 'function') _addFetchCount_('通数確認', 1);
    if (res.getResponseCode() !== 200) {
      console.log('取得できません(' + path + '): HTTP ' + res.getResponseCode() + ' ' + res.getContentText());
      return null;
    }
    return JSON.parse(res.getContentText());
  }
  var quota = get('quota');
  var used = get('quota/consumption');
  if (!quota || !used) return;

  if (quota.type === 'none') {
    console.log('今月の上限: 無制限');
  } else {
    console.log('今月の上限: ' + quota.value + '通');
  }
  console.log('今月すでに使った数: ' + used.totalUsage + '通');
  if (quota.type !== 'none' && quota.value) {
    console.log('残り: ' + (quota.value - used.totalUsage) + '通');
  }
  console.log('※ 返信は無料でここに含まれない。プッシュ（物件のお知らせ・空室確認の遅延返信・催促）だけが乗る。');
  console.log('※ 催促メッセージは1人につき1通。途中離脱が1日1〜2人なので、月に数十通の見込み。');
}
