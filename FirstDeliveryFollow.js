/**
 * FirstDeliveryFollow.gs — 初回配信を見ていない人に、翌日もう一度送る
 *
 * 狙い（2026-09-20）:
 *   条件登録済みのお客様には「契約に進む道」しかなく、止まった人を見つける仕組みが無かった。
 *   初回に送ったお部屋を1件も開かない、というのは一番早くて一番はっきりした合図なので、
 *   そこを起点にする。翌日もう一度送って、それでも開かなければ「止まっている人」とみなす。
 *
 * 流れ（1日2回のトリガー）:
 *   10:00 processFirstDeliveryChecks()  … 対象者の未読物件を空室確認キューに入れる
 *   10:20 processFirstDeliveryResends() … 募集中だったものだけ、一言を添えて再送する
 *
 * ⚠️ 全物件の定期巡回は復活させないこと。
 *   規約違反（機械的アクセス）によるBANリスクのため、拡張側で意図的に止めてある
 *   （chrome_extension/background.js の「定期空室確認【廃止】」）。
 *   ここで確認するのは「これから再送する人の、未読の物件だけ」。1日10件前後に収まる。
 *
 * ⚠️ 確認結果をお客様に通知しない印は30分で切れる（requestVacancyCheckForResend）。
 *   依頼から再送までを30分以内に終わらせること。朝に頼んで夕方に送る組み方はできない。
 *
 * ⚠️ 今すでに探しているお客様は対象外。初回配信はとっくに過ぎているため、
 *   FIRST_DELIVERY_MAX_AGE_H で古い初回配信を切って自然に外している（ユーザー判断 2026-09-20）。
 */

var FIRST_DELIVERY_SHEET = '初回配信フォロー';

// 文面が決まるまでは送らない。true にすると動き出す。
var FIRST_DELIVERY_ENABLED = false;

// 初回配信とみなす幅。最初の1件から この時間内 に送ったものを同じ配信として扱う。
var FIRST_DELIVERY_WINDOW_H = 24;
// 初回配信からこれだけ経ったら「翌日」とみなす。16時間 + 営業時間内トリガーで翌日になる。
var FIRST_DELIVERY_WAIT_H = 16;
// これより古い初回配信は拾わない。仕組みを入れる前のお客様を巻き込まないための歯止め。
var FIRST_DELIVERY_MAX_AGE_H = 72;
// 1人に再送する最大件数。未読が10件あっても全部は送らない。
var FIRST_DELIVERY_MAX_ITEMS = 5;
// 確認を頼んでから、結果を見に行くまでの最短時間（分）。
var FIRST_DELIVERY_CHECK_WAIT_MIN = 10;

/** シートの値（Date でも 'yyyy/MM/dd HH:mm:ss' でも 'yyyy-MM-dd HH:mm:ss' でも）を ms にする。 */
function _fdMs_(v) {
  if (v instanceof Date) return v.getTime();
  var s = String(v == null ? '' : v).trim();
  if (!s) return 0;
  var t = Date.parse(s.replace(/-/g, '/'));
  return isNaN(t) ? 0 : t;
}

function _firstDeliverySheet_() {
  var ss = SpreadsheetApp.openById(CRITERIA_SHEET_ID);
  var sh = ss.getSheetByName(FIRST_DELIVERY_SHEET);
  if (!sh) {
    sh = ss.insertSheet(FIRST_DELIVERY_SHEET);
    sh.appendRow(['顧客名', '初回配信日時', '確認を頼んだ日時', '再送した日時', '状態', '備考']);
    try {
      sh.getRange(1, 1, 1, 6).setFontWeight('bold').setBackground('#e0e0e0');
      sh.setFrozenRows(1);
    } catch (_) {}
  }
  return sh;
}

/** 顧客名 → この仕組みで既に扱った行 {rowIndex, checkedAt, resentAt, state} */
function _firstDeliveryDone_() {
  var sh = _firstDeliverySheet_();
  var map = {};
  var last = sh.getLastRow();
  if (last < 2) return map;
  var rows = sh.getRange(2, 1, last - 1, 6).getValues();
  for (var i = 0; i < rows.length; i++) {
    var n = String(rows[i][0] || '').trim();
    if (!n) continue;
    map[n] = {
      rowIndex: i + 2,
      firstSentAt: rows[i][1],
      checkedAt: rows[i][2],
      resentAt: rows[i][3],
      state: String(rows[i][4] || '').trim()
    };
  }
  return map;
}

/** その顧客に物件を送ってよいか（配信停止・ブロック・終了・アーカイブを外す）。 */
function _firstDeliverySendable_() {
  var ok = {};
  var cs = SpreadsheetApp.openById(CRITERIA_SHEET_ID).getSheetByName(CRITERIA_SHEET_NAME);
  if (!cs || cs.getLastRow() < 2) return ok;
  var data = cs.getRange(2, 1, cs.getLastRow() - 1, 45).getValues();
  for (var i = 0; i < data.length; i++) {
    var name = String(data[i][1] || '').trim();
    if (!name) continue;
    var status = String(data[i][18] || '').trim();      // S列: 配信ステータス
    if (status === 'blocked' || status === 'paused') continue;
    if (String(data[i][32] || '').trim() === '終了') continue;   // AG列: 営業ステージ
    if (String(data[i][44] || '').trim()) continue;              // AS列: アーカイブ済み
    ok[name] = true;
  }
  return ok;
}

/**
 * 初回配信の日時を顧客ごとに出す。通知済み物件シートの sentAt（D列）を見る。
 * O列が watch_only の行は「送っていない」ので数えない。
 * @return {Object} 顧客名 → {firstMs, rooms:[{roomId, sentMs}]}
 */
function _firstDeliveryBatches_() {
  var out = {};
  var sh = SpreadsheetApp.openById(SPREADSHEET_ID).getSheetByName(SEEN_SHEET_NAME);
  if (!sh || sh.getLastRow() < 2) return out;
  var data = sh.getRange(2, 1, sh.getLastRow() - 1, 16).getValues();
  for (var i = 0; i < data.length; i++) {
    var name = String(data[i][0] || '').trim();
    var room = String(data[i][1] || '').trim();
    if (!name || !room) continue;
    if (String(data[i][14] || '').trim() === 'watch_only') continue;   // O列: 送っていない
    var ms = _fdMs_(data[i][3]);
    if (!ms) continue;
    if (!out[name]) out[name] = { firstMs: ms, rooms: [] };
    if (ms < out[name].firstMs) out[name].firstMs = ms;
    out[name].rooms.push({ roomId: room, sentMs: ms });
  }
  // 初回配信のぶんだけ残す
  for (var n in out) {
    var lim = out[n].firstMs + FIRST_DELIVERY_WINDOW_H * 60 * 60 * 1000;
    out[n].rooms = out[n].rooms.filter(function (r) { return r.sentMs <= lim; });
  }
  return out;
}

/**
 * 【日次トリガー 10:00】初回配信を見ていない人を探し、未読物件を空室確認キューに入れる。
 * 送信はしない。20分後の processFirstDeliveryResends が送る。
 */
function processFirstDeliveryChecks() {
  var nowMs = Date.now();
  var batches = _firstDeliveryBatches_();
  var done = _firstDeliveryDone_();
  var sendable = _firstDeliverySendable_();
  var sh = _firstDeliverySheet_();
  var queued = 0, skipped = 0;

  for (var name in batches) {
    if (done[name]) { skipped++; continue; }              // 一度きり
    if (!sendable[name]) { skipped++; continue; }
    var b = batches[name];
    var ageH = (nowMs - b.firstMs) / (60 * 60 * 1000);
    if (ageH < FIRST_DELIVERY_WAIT_H) continue;           // まだ翌日になっていない
    if (ageH > FIRST_DELIVERY_MAX_AGE_H) continue;        // 古すぎる（仕組みを入れる前の人）

    var userId = null;
    try { userId = findLineUserId(name); } catch (_e) {}
    if (!userId) { skipped++; continue; }

    // 担当者とやり取りしている最中なら割り込まない。動いている人はそもそも対象外。
    try {
      var act = _newFriendLastActivityMap_();
      if (act[userId] && (nowMs - act[userId]) < FIRST_DELIVERY_WAIT_H * 60 * 60 * 1000) {
        sh.appendRow([name, new Date(b.firstMs), '', '', '見送り', 'LINEでやり取り中']);
        skipped++;
        continue;
      }
    } catch (_eA) {}

    // 1件でも開いていれば対象外。見ている人は止まっていない。
    var seen = [];
    try { seen = getSeenPropertiesForResend(name) || []; } catch (eS) {
      console.warn('[初回配信] 送付済み物件を読めません: ' + name + ' / ' + eS.message);
      continue;
    }
    var inBatch = {};
    for (var r = 0; r < b.rooms.length; r++) inBatch[b.rooms[r].roomId] = true;
    var target = [], anyViewed = false;
    for (var s = 0; s < seen.length; s++) {
      if (!inBatch[seen[s].roomId]) continue;
      if (seen[s].viewed) { anyViewed = true; break; }
      target.push(seen[s].roomId);
    }
    if (anyViewed) {
      sh.appendRow([name, new Date(b.firstMs), '', '', '見た', '初回配信を開いている']);
      skipped++;
      continue;
    }
    if (!target.length) { skipped++; continue; }
    target = target.slice(0, FIRST_DELIVERY_MAX_ITEMS);

    if (!FIRST_DELIVERY_ENABLED) {
      console.log('[初回配信] 対象（まだ送りません）: ' + name + ' / 未読 ' + target.length + '件');
      skipped++;
      continue;
    }
    // 空室確認キューへ。結果はお客様に通知されない印がつく（30分有効）。
    var q = { ok: false, queued: 0 };
    try { q = requestVacancyCheckForResend(name, target) || q; } catch (eQ) {
      console.warn('[初回配信] 空室確認を頼めません: ' + name + ' / ' + eQ.message);
    }
    sh.appendRow([name, new Date(b.firstMs), new Date(), '', '確認待ち',
      '未読' + target.length + '件 / キュー' + (q.queued || 0) + '件']);
    queued++;
  }
  console.log('[初回配信] 確認を頼んだ: ' + queued + '人 / 見送り: ' + skipped + '人'
    + (FIRST_DELIVERY_ENABLED ? '' : '（送信はまだ止めてあります）'));
}

/** 再送に添える一言。⚠️ 通知に出るのはこの文章。 */
function buildFirstDeliveryResendText() {
  return '先日お送りしたお部屋は、ご覧いただけましたでしょうか。\n\n'
    + 'まだ募集中のものを、もう一度お送りします。\n\n'
    + '気になるものがありましたら、そのままLINEでお知らせください。';
}

/**
 * 【日次トリガー 10:20】確認が返ってきた人に、募集中の物件だけを再送する。
 */
function processFirstDeliveryResends() {
  if (!FIRST_DELIVERY_ENABLED) { console.log('[初回配信] 送信は止めてあります'); return; }
  var sh = _firstDeliverySheet_();
  var last = sh.getLastRow();
  if (last < 2) return;
  var rows = sh.getRange(2, 1, last - 1, 6).getValues();
  var nowMs = Date.now();
  var sent = 0, skipped = 0;

  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i][4] || '').trim() !== '確認待ち') continue;
    var name = String(rows[i][0] || '').trim();
    var askedAt = rows[i][2];
    var askedMs = (askedAt instanceof Date) ? askedAt.getTime() : 0;
    if (!name || !askedMs) continue;
    var waitedMin = (nowMs - askedMs) / 60000;
    if (waitedMin < FIRST_DELIVERY_CHECK_WAIT_MIN) continue;     // まだ返ってきていない
    if (waitedMin > 30) {
      // 通知しない印が切れた。ここで送ると確認結果が別途お客様に飛ぶ恐れがある。
      sh.getRange(i + 2, 5, 1, 2).setValues([['見送り', '確認が30分以内に返らなかった']]);
      skipped++;
      continue;
    }

    var seen = [];
    try { seen = getSeenPropertiesForResend(name) || []; } catch (eS) {
      console.warn('[初回配信] 送付済み物件を読めません: ' + name + ' / ' + eS.message);
      continue;
    }
    // 確認が返っていて、まだ募集中で、まだ開いていないものだけ
    var ids = [];
    for (var s = 0; s < seen.length && ids.length < FIRST_DELIVERY_MAX_ITEMS; s++) {
      var p = seen[s];
      if (p.viewed) continue;
      if (p.currentStatus !== 'available') continue;
      if (p.manualClosed) continue;
      ids.push(p.roomId);
    }
    if (!ids.length) {
      sh.getRange(i + 2, 5, 1, 2).setValues([['送るものなし', '募集中の未読物件がなかった']]);
      skipped++;
      continue;
    }
    try {
      var r = resendPropertyNotifications(name, ids, buildFirstDeliveryResendText());
      sh.getRange(i + 2, 4, 1, 3).setValues([[new Date(),
        (r && r.ok) ? '再送した' : '送信できず',
        (r && r.message) ? String(r.message) : '']]);
      if (r && r.ok) sent++; else skipped++;
    } catch (eR) {
      sh.getRange(i + 2, 5, 1, 2).setValues([['送信できず', eR.message]]);
      skipped++;
    }
  }
  console.log('[初回配信] 再送: ' + sent + '人 / 見送り: ' + skipped + '人');
}

/**
 * 【GASエディタから実行・FirstDeliveryFollow.gs】
 * 誰が対象になるかを、送らずに確かめる。読み取りだけで何も書き換えない。
 */
function previewFirstDeliveryTargets() {
  var nowMs = Date.now();
  var batches = _firstDeliveryBatches_();
  var done = _firstDeliveryDone_();
  var sendable = _firstDeliverySendable_();
  var hit = 0;
  console.log('=== 初回配信のフォロー対象 ===');
  console.log('（初回配信から ' + FIRST_DELIVERY_WAIT_H + '〜' + FIRST_DELIVERY_MAX_AGE_H + '時間の人）');
  for (var name in batches) {
    var b = batches[name];
    var ageH = (nowMs - b.firstMs) / (60 * 60 * 1000);
    var why = '';
    if (done[name]) why = '扱い済み(' + done[name].state + ')';
    else if (!sendable[name]) why = '配信停止・終了・アーカイブ';
    else if (ageH < FIRST_DELIVERY_WAIT_H) why = 'まだ ' + Math.floor(ageH) + '時間';
    else if (ageH > FIRST_DELIVERY_MAX_AGE_H) why = '古い（' + Math.floor(ageH / 24) + '日前）';
    if (why) continue;

    var seen = [];
    try { seen = getSeenPropertiesForResend(name) || []; } catch (_e) { continue; }
    var inBatch = {};
    for (var r = 0; r < b.rooms.length; r++) inBatch[b.rooms[r].roomId] = true;
    var unread = 0, viewed = 0, alive = 0;
    for (var s = 0; s < seen.length; s++) {
      if (!inBatch[seen[s].roomId]) continue;
      if (seen[s].viewed) { viewed++; continue; }
      unread++;
      if (seen[s].currentStatus === 'available' && !seen[s].manualClosed) alive++;
    }
    if (viewed > 0) continue;
    hit++;
    console.log('  ' + name + ' … 初回配信 ' + Math.floor(ageH) + '時間前 / 未読 ' + unread
      + '件（うち今も募集中 ' + alive + '件）');
  }
  if (!hit) console.log('  （今は対象がいません）');
  console.log('');
  console.log('※ 「今も募集中」は最後に確認した時点のもの。実際に送る直前にもう一度確認します。');
}
