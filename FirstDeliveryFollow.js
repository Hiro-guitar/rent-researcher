/**
 * FirstDeliveryFollow.gs — 初回配信を見ていない人に、翌日もう一度送る
 *
 * 狙い（2026-09-20）:
 *   条件登録済みのお客様には「契約に進む道」しかなく、止まった人を見つける仕組みが無かった。
 *   初回に送ったお部屋を1件も開かない、というのは一番早くて一番はっきりした合図なので、
 *   そこを起点にする。翌日もう一度送って、それでも開かなければ「止まっている人」とみなす。
 *
 * 流れ（営業時間内に15分おきのトリガー1本）:
 *   processFirstDeliveryFollow()
 *     1. 前回の回で確認を頼んだ人 → 結果を見て、募集中だったものだけ一言を添えて再送
 *     2. 新しく時刻が来た人 → 未読物件を空室確認キューに入れる（1回につき1人だけ）
 *
 * ⚠️ 決まった時刻に一斉送信しないこと。毎日10:00ちょうどに届くと機械だと分かる。
 *   送る時刻は「初回配信 + 25時間15分」で人それぞれ。営業時間外なら翌朝に回すが、
 *   そこも getNextBusinessMorning が 10:16〜10:33 でばらしてくれる。
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

// 初回配信からどれだけ空けるか。25時間15分（2026-09-20 ユーザー判断）。
// ⚠️ ちょうど24時間にしないこと。前に送ったのと同じ時刻に届くと、それだけで機械だと分かる。
//   丸1日みてもらったうえで、時刻が前回とずれるように半端な値にしてある。
var FIRST_DELIVERY_WAIT_MS = 25 * 60 * 60 * 1000 + 15 * 60 * 1000;
// これより古い初回配信は拾わない。仕組みを入れる前のお客様を巻き込まないための歯止め。
var FIRST_DELIVERY_MAX_AGE_H = 72;
// 1人に再送する最大件数。未読が10件あっても全部は送らない。
var FIRST_DELIVERY_MAX_ITEMS = 5;
// 確認を頼んでから、結果を見に行くまでの最短時間（分）。
var FIRST_DELIVERY_CHECK_WAIT_MIN = 10;

/**
 * いつ送るか。初回配信 + 25時間15分。その時刻が営業時間外なら翌朝に回す。
 * 翌朝は getNextBusinessMorning が 10:16〜10:33 でばらしてくれるので、そこも固まらない。
 */
function _firstDeliverySendTime_(firstMs) {
  var t = new Date(firstMs + FIRST_DELIVERY_WAIT_MS);
  var h = (typeof getJstHour === 'function') ? getJstHour(t) : t.getHours();
  if (h >= 10 && h < 20) return t;
  return getNextBusinessMorning(t);
}

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
 * 送る時刻が来た人を1人だけ選んで、未読物件を空室確認キューに入れる。
 * 送信はしない。次の回（15分後）の processFirstDeliveryResends が送る。
 * ⚠️ 直接呼ばず processFirstDeliveryFollow から呼ぶこと（営業時間の判定がそこにある）。
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
    if (ageH > FIRST_DELIVERY_MAX_AGE_H) continue;        // 古すぎる（仕組みを入れる前の人）
    if (nowMs < _firstDeliverySendTime_(b.firstMs).getTime()) continue;   // まだその時刻になっていない

    var userId = null;
    try { userId = findLineUserId(name); } catch (_e) {}
    if (!userId) { skipped++; continue; }

    // 担当者とやり取りしている最中なら割り込まない。動いている人はそもそも対象外。
    try {
      var act = _newFriendLastActivityMap_();
      if (act[userId] && (nowMs - act[userId]) < FIRST_DELIVERY_WAIT_MS) {
        sh.appendRow([name, new Date(b.firstMs), '', '', '見送り', 'LINEでやり取り中']);
        skipped++;
        continue;
      }
    } catch (_eA) {}

    // ⚠️ 「初回配信のぶんを見たか」ではなく「**1度でも**物件を見たか」で判定する。
    //   目的は動いていない人を見つけることなので、あとから送った物件を見ている人は
    //   もう動いている。催促する必要がない（2026-09-21 ユーザー判断）。
    //   募集終了になったものも含めて数えるため includeClosed を渡す。
    var seen = [];
    try { seen = getSeenPropertiesForResend(name, { includeClosed: true }) || []; } catch (eS) {
      console.warn('[初回配信] 送付済み物件を読めません: ' + name + ' / ' + eS.message);
      continue;
    }
    var anyViewed = false;
    for (var v = 0; v < seen.length; v++) {
      if (seen[v].viewed) { anyViewed = true; break; }
    }
    if (anyViewed) {
      sh.appendRow([name, new Date(b.firstMs), '', '', '見た', '物件を見ている']);
      skipped++;
      continue;
    }
    // 送り直す候補は初回配信のぶんから。未読で、今も募集中のもの。
    var inBatch = {};
    for (var r = 0; r < b.rooms.length; r++) inBatch[b.rooms[r].roomId] = true;
    var target = [];
    for (var s2 = 0; s2 < seen.length; s2++) {
      if (!inBatch[seen[s2].roomId]) continue;
      if (seen[s2].viewed) continue;
      if (seen[s2].manualClosed) continue;
      if (['closed', 'applied'].indexOf(String(seen[s2].currentStatus || '')) >= 0) continue;
      target.push(seen[s2].roomId);
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

/**
 * 【トリガー・営業時間内に15分おき】この仕組みの入口。
 *
 * 1回の呼び出しで2つやる。
 *   1. 前回の回で確認を頼んだ人を再送する（印が30分で切れるので、次の回で送りきる）
 *   2. 新しく時刻が来た人の確認を頼む（時刻が来た人はまとめて）
 * 順番は再送が先。先に頼むと、同じ回で送ろうとして確認が間に合わない。
 *
 * ⚠️ 人数を絞らないこと。以前「1回1人」にしていたが、理由が2つとも間違いだった。
 *   ・同時に届くと機械に見える → お客様同士は比べようがないので関係ない
 *   ・サイトへのアクセスが増える → 物件検索が毎日その何十倍も叩いている
 */
function processFirstDeliveryFollow() {
  var h = (typeof getJstHour === 'function') ? getJstHour(new Date()) : new Date().getHours();
  if (h < 10 || h >= 20) return;   // 営業時間外は何もしない
  try { processFirstDeliveryResends(); } catch (e) { console.error('[初回配信] 再送で失敗: ' + e.message); }
  try { processFirstDeliveryChecks(); } catch (e) { console.error('[初回配信] 確認依頼で失敗: ' + e.message); }
}

/** 再送に添える一言。⚠️ 通知に出るのはこの文章。 */
function buildFirstDeliveryResendText() {
  // ⚠️ 「まだ募集中のものを」とは書かないこと（2026-09-21）。残り物を送っている感じになる。
  //   見る理由を先に伝えて、最後は返事ではなく希望を聞く形にする。
  return '先日お送りしたお部屋は、ご覧いただけましたでしょうか。\n\n'
    + 'ご希望の条件に合うものを、スタッフが一件ずつ見てお送りしています。\n'
    + '検索サイトに出ていないお部屋もご紹介できます。\n\n'
    + 'もう少しこういうお部屋がいい、などございましたら\n'
    + 'お気軽にお申し付けください。';
}

/** 再送に添えるボタン。カルーセルのいちばん下に出る。 */
function buildFirstDeliveryQuickReply() {
  if (typeof qrMessage !== 'function') return null;
  return [qrMessage('条件を変更する', '条件変更')];
}

/**
 * 確認が返ってきた人に、募集中の物件だけを再送する。
 * ⚠️ 直接呼ばず processFirstDeliveryFollow から呼ぶこと。
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
      var r = resendPropertyNotifications(name, ids,
        buildFirstDeliveryResendText(), buildFirstDeliveryQuickReply());
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
  console.log('（初回配信から25時間15分たって、まだ1度も物件を見ていない人。'
    + FIRST_DELIVERY_MAX_AGE_H + '時間より古い初回配信は対象外）');
  for (var name in batches) {
    var b = batches[name];
    var ageH = (nowMs - b.firstMs) / (60 * 60 * 1000);
    var why = '';
    if (done[name]) why = '扱い済み(' + done[name].state + ')';
    else if (!sendable[name]) why = '配信停止・終了・アーカイブ';
    else if (nowMs < _firstDeliverySendTime_(b.firstMs).getTime()) {
      why = 'まだ（送るのは ' + Utilities.formatDate(_firstDeliverySendTime_(b.firstMs), 'Asia/Tokyo', 'M/d HH:mm') + ' 以降）';
    }
    else if (ageH > FIRST_DELIVERY_MAX_AGE_H) why = '古い（' + Math.floor(ageH / 24) + '日前）';
    if (why) continue;

    var seen = [];
    try { seen = getSeenPropertiesForResend(name, { includeClosed: true }) || []; } catch (_e) { continue; }
    // 1度でも見ていれば対象外（本番と同じ判定）
    var viewed = 0;
    for (var v = 0; v < seen.length; v++) if (seen[v].viewed) viewed++;
    if (viewed > 0) continue;
    var inBatch = {};
    for (var r = 0; r < b.rooms.length; r++) inBatch[b.rooms[r].roomId] = true;
    var unread = 0, alive = 0;
    for (var s = 0; s < seen.length; s++) {
      if (!inBatch[seen[s].roomId]) continue;
      unread++;
      if (seen[s].currentStatus === 'available' && !seen[s].manualClosed) alive++;
    }
    hit++;
    console.log('  ' + name + ' … 初回配信 ' + Math.floor(ageH) + '時間前 / 未読 ' + unread
      + '件（うち今も募集中 ' + alive + '件）');
  }
  if (!hit) console.log('  （今は対象がいません）');
  console.log('');
  console.log('※ 「今も募集中」は最後に確認した時点のもの。実際に送る直前にもう一度確認します。');
}
