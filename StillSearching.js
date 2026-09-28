/**
 * StillSearching.gs — 長く反応がない人に「引き続きお送りしてよいか」を1回だけ聞く
 *
 * 狙い（2026-09-28）:
 *   引越し時期が「いい物件見つかり次第」の人には期限が無く、MoveInDeadline では出口が作れない。
 *   旧「条件変更提案 10日×3回」がその出口を兼ねていたが、廃止するのでこちらが受け持つ。
 *   ユーザーの決め: **終了にする前には必ず1通送る。** 黙って終了にはしない。
 *
 * 対象:
 *   - 最後に物件を見てから STILL_IDLE_D 日たっている（1度も見ていない人は登録から数える）
 *   - その間に STILL_MIN_SENT 件以上 送っている（送れていない人は「条件を見直す」の枝で人が拾う）
 *
 * ⚠️ 物件は添えない（2026-09-28）。「新しく出ています」は送る時点で埋まっていれば嘘になり、
 *   空室確認はChrome拡張が動いていないと進まない（PCを閉じていると送れない）。
 *   文面は事実だけ（「引き続きお送りしてよいか」）にして、確実に届くことを優先する。
 *
 * ⚠️ 文面で閲覧履歴に触れないこと。「ご覧いただけていない」等は禁止（閲覧を取っているのは内緒）。
 * ⚠️ 宛名なし・ボタンは全部同じ緑・クイックリプライ不可・2通に分けない（LINE文面の作法）。
 * ⚠️ 仕組みを入れる前から止まっている人を一気に巻き込まないよう、送るのは1日 STILL_MAX_PER_DAY 人まで。
 */

var STILL_SHEET = '継続確認';

// 送信を止めるスイッチ。false だと数えるだけ。
var STILL_ENABLED = false;

var STILL_IDLE_D = 30;        // 最終閲覧（無ければ登録）からこの日数
var STILL_MIN_SENT = 10;      // その間に送った件数がこれ以上
var STILL_WAIT_H = 24;        // 返事を待つ時間。過ぎたら終了
var STILL_MAX_PER_DAY = 5;    // 1日に聞く人数の上限

function _stillSheet_() {
  var ss = SpreadsheetApp.openById(CRITERIA_SHEET_ID);
  var sh = ss.getSheetByName(STILL_SHEET);
  if (!sh) {
    sh = ss.insertSheet(STILL_SHEET);
    sh.appendRow(['顧客名', '最終閲覧', '送った件数', '聞いた日時', '返事', '返事の日時', '状態']);
    try { sh.getRange(1, 1, 1, 7).setFontWeight('bold').setBackground('#e0e0e0'); sh.setFrozenRows(1); } catch (_) {}
  }
  return sh;
}

/** 顧客名 → { total: STILL_IDLE_D 日内に送った件数 } */
function _stillSentCounts_() {
  var out = {};
  try {
    var sh = SpreadsheetApp.openById(SPREADSHEET_ID).getSheetByName(SEEN_SHEET_NAME);
    if (!sh || sh.getLastRow() < 2) return out;
    var rows = sh.getRange(2, 1, sh.getLastRow() - 1, 4).getValues();   // A=顧客名 / D=送信日時
    var now = Date.now();
    for (var i = 0; i < rows.length; i++) {
      var name = String(rows[i][0] || '').trim();
      var ms = _cellToEpochMs_(rows[i][3]);
      if (!name || !ms) continue;
      var age = (now - ms) / 86400000;
      var r = out[name] || (out[name] = { total: 0 });
      if (age <= STILL_IDLE_D) r.total++;
    }
  } catch (e) { console.warn('[継続確認] 通知済み物件を読めません: ' + e.message); }
  return out;
}

/**
 * 対象を集める。送信はしない。
 * @return {Array<{name, idleDays, total, ok, why}>}
 */
function collectStillSearching() {
  var out = [];
  var customers = _getCustomerListForCRM_();
  var sent = _stillSentCounts_();
  var todayIdx = _jstDayIndex_(Date.now());
  for (var i = 0; i < customers.length; i++) {
    var c = customers[i];
    if (!c.hasCriteria || !c.hasLine) continue;
    if (c.stage === '終了' || c.stage === '成約' || c.stage === '申込' || c.archived) continue;
    var st = String(c.status || '').toLowerCase();
    if (st !== 'active' && st !== 'lead') continue;
    var idle = (c.daysSinceViewed !== null && c.daysSinceViewed !== undefined) ? c.daysSinceViewed
      : (c.registeredAt ? todayIdx - _jstDayIndex_(new Date(c.registeredAt).getTime()) : null);
    if (idle === null || idle < STILL_IDLE_D) continue;
    var s = sent[c.name] || { total: 0 };
    var why = (s.total < STILL_MIN_SENT) ? '送った件数が' + s.total + '件（' + STILL_MIN_SENT + '件未満）' : '';
    out.push({ name: c.name, idleDays: idle, total: s.total, ok: !why, why: why });
  }
  return out;
}

/**
 * 聞くメッセージ。初回配信の再送カード（右端のバブル）の言い回しを引き継いだ（ユーザー判断 2026-09-28）。
 * ⚠️ 物件が出ているとは言わない（嘘になりうる）。閲覧履歴にも触れない。今の条件の表も出さない。
 */
function buildStillAskMessages() {
  var text = 'ご希望の条件に合うお部屋を、引き続きお探ししています。\n'
    + 'もう少しこういうお部屋がいい、などございましたら\nお気軽にお申し付けください。';
  var btn = function (label, data) {
    return { type: 'button', style: 'primary', color: '#6ea814', height: 'sm',
      action: { type: 'postback', label: label, data: data, displayText: label } };
  };
  return [{
    type: 'flex',
    altText: 'ご希望の条件に合うお部屋を、引き続きお探ししています。',
    contents: {
      type: 'bubble',
      body: { type: 'box', layout: 'vertical', paddingAll: 'xl',
        contents: [{ type: 'text', text: text, size: 'sm', color: '#555555', wrap: true, lineSpacing: '6px' }] },
      footer: { type: 'box', layout: 'vertical', spacing: 'sm', paddingAll: 'lg',
        contents: [btn('条件を変更する', 'still:change'), btn('このままで続ける', 'still:go'), btn('探すのをやめた', 'still:stop')] }
    }
  }];
}

/** 対象に聞く（1日の上限つき・一度きり）。 */
function _stillAsk_() {
  var list = collectStillSearching().filter(function (x) { return x.ok; });
  if (!list.length) return 0;
  var sh = _stillSheet_();
  var asked = {};
  var todayStr = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd');
  var sentToday = 0;
  if (sh.getLastRow() > 1) {
    var rows = sh.getRange(2, 1, sh.getLastRow() - 1, 7).getValues();
    for (var r = 0; r < rows.length; r++) {
      asked[String(rows[r][0] || '').trim()] = true;
      var d = rows[r][3];
      if (d instanceof Date && Utilities.formatDate(d, 'Asia/Tokyo', 'yyyy-MM-dd') === todayStr) sentToday++;
    }
  }
  var uids = _moveInUserIds_();
  var sent = 0;
  for (var i = 0; i < list.length; i++) {
    if (sentToday + sent >= STILL_MAX_PER_DAY) break;
    var t = list[i];
    if (asked[t.name]) continue;
    var uid = uids[t.name];
    if (!uid) continue;
    if (!STILL_ENABLED) { console.log('[継続確認] 対象（まだ送りません）: ' + t.name); continue; }
    try {
      pushMessage(uid, buildStillAskMessages());
      sh.appendRow([t.name, t.idleDays + '日前', t.total, new Date(), '', '', '返事待ち']);
      sent++;
      console.log('[継続確認] 聞きました: ' + t.name);
    } catch (e) { console.warn('[継続確認] 送れません: ' + t.name + ' / ' + e.message); }
  }
  return sent;
}

/** 聞いてから STILL_WAIT_H 時間、何も無い人を終了にする（AutoEnd.gs）。 */
function _stillCloseNoReply_() {
  var sh = _stillSheet_();
  if (sh.getLastRow() < 2) return 0;
  var rows = sh.getRange(2, 1, sh.getLastRow() - 1, 7).getValues();
  var uids = _moveInUserIds_();
  var acts = _moveInLastActivity_();
  var now = Date.now();
  var closed = 0;
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i][6] || '').trim() !== '返事待ち') continue;
    var askedMs = _fdMs_(rows[i][3]);
    if (!askedMs || now - askedMs < STILL_WAIT_H * 3600000) continue;
    var name = String(rows[i][0] || '').trim();
    var uid = uids[name];
    if (uid && acts[uid] && acts[uid] > askedMs) {
      sh.getRange(i + 2, 5, 1, 3).setValues([['反応あり', new Date(acts[uid]), '継続']]);
      continue;
    }
    if (!STILL_ENABLED) { console.log('[継続確認] 終了の対象（まだ何もしません）: ' + name); continue; }
    try {
      endCustomerAsSilent(name, uid, '継続確認の返事なし');
      sh.getRange(i + 2, 7).setValue('終了（音信不通）');
      closed++;
    } catch (e) { console.warn('[継続確認] 終了にできません: ' + name + ' / ' + e.message); }
  }
  return closed;
}

/** ボタンの返事を記録する（コード.gs の postback から）。 */
function _stillMarkReply_(userId, reply) {
  try {
    var sh = _stillSheet_();
    if (sh.getLastRow() < 2) return;
    var name = '';
    var lu = SpreadsheetApp.openById(CRITERIA_SHEET_ID).getSheetByName(LINE_USERS_SHEET_NAME);
    lu.getRange(2, 1, lu.getLastRow() - 1, 2).getValues().forEach(function (r) {
      if (String(r[0] || '').trim() === String(userId)) name = String(r[1] || '').trim();
    });
    if (!name) return;
    var rows = sh.getRange(2, 1, sh.getLastRow() - 1, 7).getValues();
    for (var i = rows.length - 1; i >= 0; i--) {
      if (String(rows[i][0] || '').trim() !== name) continue;
      sh.getRange(i + 2, 5, 1, 3).setValues([[reply, new Date(), reply === '探すのをやめた' ? '停止へ' : '継続']]);
      return;
    }
  } catch (e) { console.warn('[継続確認] 返事を記録できません: ' + e.message); }
}

/** postback 'still:*' を処理する。 */
function handleStillPostback(replyToken, userId, data) {
  if (data === 'still:go') {
    _stillMarkReply_(userId, 'このままで続ける');
    replyMessage(replyToken, [textMsg('ありがとうございます。引き続きお送りします。')]);
    return;
  }
  if (data === 'still:change') {
    _stillMarkReply_(userId, '条件を変更する');
    startChangeFlow(replyToken, userId, [textMsg('ありがとうございます。')]);
    return;
  }
  if (data === 'still:stop') {
    _stillMarkReply_(userId, '探すのをやめた');
    if (typeof handleDeliveryStopCommand === 'function') handleDeliveryStopCommand(replyToken, userId);
    else replyMessage(replyToken, [textMsg('承知しました。「配信停止」と送ってください。')]);
  }
}

/** 【トリガー・1時間おき】processMoveInDeadline に相乗りする入口。 */
function processStillSearching() {
  var h = (typeof getJstHour === 'function') ? getJstHour(new Date()) : new Date().getHours();
  if (h < 10 || h >= 18) return;
  try { _stillAsk_(); } catch (e) { console.error('[継続確認] 聞くところで失敗: ' + e.message); }
  try { _stillCloseNoReply_(); } catch (e) { console.error('[継続確認] 締めるところで失敗: ' + e.message); }
}

/** 【GASエディタで実行: StillSearching.gs】対象と、外れる理由をログに出す。何も送らない。 */
function previewStillSearching() {
  var list = collectStillSearching();
  var ok = list.filter(function (x) { return x.ok; });
  var ng = list.filter(function (x) { return !x.ok; });
  console.log('送る対象 ' + ok.length + ' 人（1日 ' + STILL_MAX_PER_DAY + ' 人まで）\n'
    + ok.map(function (x) { return '・' + x.name + '（最終閲覧 ' + x.idleDays + '日前 / 30日で' + x.total + '件）'; }).join('\n'));
  console.log('反応なしだが送らない ' + ng.length + ' 人\n'
    + ng.map(function (x) { return '・' + x.name + '（' + x.why + '）'; }).join('\n'));
}

/** 【GASエディタで実行: StillSearching.gs】カードを Hiroki に送って見た目を確かめる。 */
function testSendStillSearching() {
  var uid = _moveInUserIds_()['Hiroki'];
  if (!uid) { console.log('Hiroki の LINE が見つかりません'); return; }
  pushMessage(uid, buildStillAskMessages());
  console.log('送りました');
}
