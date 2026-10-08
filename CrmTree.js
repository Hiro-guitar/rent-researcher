/**
 * 顧客を樹形図の枝に乗せる（CRMリニューアル 2026-09-28〜）。
 *
 * 新しい顧客管理ページは「樹形図そのもの」を画面にする。
 * 全員がどれか1つの枝に乗り、自分が動く枝（mine）だけ赤く人数を出す。
 * どの枝にも当てはまらない人は「迷子」に入れる。迷子が0人であることが
 * 「全員を管理できている」の条件。
 *
 * 材料は _getCustomerListForCRM_（コード.js）の結果に、合図（LINEの文・申込/内見・閲覧）を足して使う。
 * 判定は上から順に見て、最初に当てはまった枝に置く。
 *
 * 🔴 の合図は「そのあとに対応ログが1行でも付いたら済み」とする。
 * 電話でもLINEでも、記録を付ければ枝から消える。
 */

// 枝の定義。parent で樹形図の形を作る。mine=true は自分が動く枝（赤）。
var CRM_TREE_NODES = [
  { id: 'wantApply',    label: '申込・内見の希望が来た',       parent: '', mine: true, urgent: true },
  { id: 'reInquiry',    label: '再問い合わせが来た',           parent: '', mine: true, urgent: true },
  { id: 'strongSignal', label: '申込・内見の画面を開いて送らなかった', parent: '', mine: true, urgent: true },
  { id: 'replyLine',    label: 'LINEに返信',                   parent: '', mine: true, urgent: true },
  { id: 'taskDue',      label: '約束の日（次の連絡・内見）',     parent: '', mine: true, urgent: true },
  { id: 'moveInSoon',   label: '引越しが近い（電話する）',       parent: '', mine: true, urgent: true },
  { id: 'inquiry',      label: '反響',                         parent: '' },
  { id: 'mailOnly',     label: 'メールだけ（自動メール）',       parent: 'inquiry' },
  { id: 'callQueue',    label: '架電待ち（今日かける）',          parent: 'inquiry', mine: true },
  { id: 'callWait',     label: '架電待ち（今日はかけない）',       parent: 'inquiry' },
  { id: 'callDone',     label: '架電3枠つながらず（毎日のメール中）', parent: 'inquiry' },
  { id: 'talkedNoLine', label: '話せた・LINE待ち',                parent: 'inquiry' },
  { id: 'line',         label: 'LINEに来た',                    parent: 'inquiry' },
  { id: 'noCriteria',   label: '条件登録待ち（自動で催促）',     parent: 'line' },
  { id: 'registered',   label: '条件登録済み',                  parent: 'line' },
  { id: 'firstWait',    label: '初回配信まだ（0件）',            parent: 'registered' },
  { id: 'following',    label: '追客中',                        parent: 'registered' },
  { id: 'neverViewed',  label: '1件も見ていない（自動で再送）',   parent: 'following' },
  { id: 'neverViewed30', label: '30日 1件も見ていない（電話する）', parent: 'following', mine: true },
  { id: 'noSend14',     label: '物件を送れていない（条件を見直す）',         parent: 'following', mine: true },
  { id: 'viewing',      label: '内見の予定あり',                  parent: 'following' },
  { id: 'waitNext',     label: '次の連絡を待つ（日付を決めた）',   parent: 'following' },
  { id: 'applied',      label: '申込',                          parent: 'following' },
  { id: 'appliedStale', label: '申込から14日 動きなし（確認する）', parent: 'applied', mine: true },
  { id: 'won',          label: '成約',                          parent: 'applied' },
  { id: 'ended',        label: '終了',                          parent: '' },
  { id: 'lost',         label: '迷子（どの枝にも入らない）',      parent: '', mine: true }
];

// ⚠️ 樹形図に乗せるのは「これから来る人」だけ（ユーザー判断 2026-09-28）。
//   それまでの顧客は freezeOldCustomers で名前を控え、樹形図から外す。
//   旧顧客への自動の仕組み（配信・催促など）は今までどおり動かし、止めない。
//   登録日（検索条件シートA列）は条件を変えるたびに上書きされるので、日付では分けられない。
var CRM_TREE_OLD_SHEET = '樹形図の対象外（旧顧客）';
// 2026-09-28 14時: 出口が揃って古い人は自動で「終了」に流れるようになったので、旧顧客も入れることにした
// （赤い箱は合計32人で収まることを previewCrmTreeWithOld で確認済み）。false に戻せば旧顧客を外す。
var CRM_TREE_INCLUDE_OLD = true;
// ボットが答えなかったLINEの文（＝人が返信する文）。doPost の最後で書く。
var CRM_TREE_REPLY_SHEET = 'LINE要返信';

// 架電は「直後（最初の1回・いつでもよい）／平日（別の平日に1回）／土日（土か日に1回）」の3枠。
// 3枠ともつながらず、毎日のフォローアップメール（反響から14日）も終わったら終了（ユーザー決定 2026-09-29）。
// ⚠️ 回数や日数では切らない。忙しくて連続でかけられない日があっても枠が埋まるまで待つ。
var CRM_TREE_MAIL_DAYS = 14;        // メールだけの人は、反響からこの日数でLINEに来なければ終了
var CRM_TREE_NUDGE_FALLBACK_D = 7;  // 催促の記録が無い登録待ちの人は、反響からこの日数で終了
var CRM_TREE_NUDGE_WAIT_H = 24;     // 催促のあと、この時間 何も無ければ終了
var CRM_TREE_MOVEIN_SOON_D = 14;    // 引越し予定までこの日数を切ったら1回だけ赤く出す（ルールE 14日前）
var CRM_TREE_FIRST_WAIT_DAYS = 7;
var CRM_TREE_CALL_LIMIT_D = 14;     // 架電リストに出すのは反響からこの日数まで。過ぎたら枠が空いていても終了（2026-09-29 ユーザー決定。毎日のメール14日と揃う）
var CRM_TREE_TALKED_WAIT_D = 14;    // 電話で話せたがLINEに来ない人は、話してからこの日数で終了
var CRM_TREE_APPLIED_STALE_D = 14;  // 申込にしてから（最後の記録から）この日数 動きが無ければ赤
var CRM_TREE_NEVER_VIEWED_D = 30;   // 登録からこの日数 1件も見ていなければ赤   // 登録からこの日数 1件も送れていなければ「送れていない」へ
var CRM_TREE_NO_SEND_DAYS = 14;     // 物件を送れていない日数
var CRM_TREE_VIEW_REPEAT = 3;       // 同じ物件をこの回数以上 開いたら強い合図
var CRM_TREE_VIEW_ROOMS = 3;        // この件数以上の物件を開いたら強い合図
var CRM_TREE_SIGNAL_DAYS = 7;       // 閲覧の合図はこの日数以内のものだけ数える
var CRM_TREE_APPLY_DAYS = 14;       // 申込・内見の希望はこの日数以内のものだけ（それより前は対応済みとみなす）

var _DAY_MS_ = 24 * 60 * 60 * 1000;

/**
 * 【doPost から呼ぶ】ボットが答えなかった文を控える。
 * ⚠️ 速さ優先。appendRow 1回だけにして、名前の解決は読む側でやる。
 */
function recordLineNeedsReply(userId, text) {
  if (!userId) return;
  _crmTouch_('LINEの返信');
  var ss = SpreadsheetApp.openById(CRITERIA_SHEET_ID);
  var sh = ss.getSheetByName(CRM_TREE_REPLY_SHEET);
  if (!sh) {
    sh = ss.insertSheet(CRM_TREE_REPLY_SHEET);
    sh.appendRow(['userId', '受信日時', '本文']);
  }
  sh.appendRow([userId, new Date(), String(text || '').substring(0, 200)]);
  try { cfSyncRows(CRM_TREE_REPLY_SHEET, [sh.getLastRow()], 'LINEの返信'); } catch (eCf) {}
}

/**
 * 1人ぶんの枝を決める。
 * @param {Object} c getCrmTree で材料を足した1件
 * @return {string} 枝の id
 */
function _crmTreeNodeOf_(c) {
  var st = String(c.status || '').toLowerCase();
  if (c.stage === '成約') return 'won';
  if (st === 'blocked') return 'ended';

  // 🔴 合図は工程より先に見る（申込中・終了の人から来ても拾う）
  if (c.sig.apply) return 'wantApply';
  if (c.sig.reInquiry) return 'reInquiry';
  if (c.sig.strong) return 'strongSignal';
  if (c.sig.reply) return 'replyLine';

  if (c.stage === '終了' || c.archived) return 'ended';
  if (c.taskDueNow) return 'taskDue';
  // 引越し予定まで14日を切った、条件登録済みの人。その期間に一度も記録が無ければ赤く出す
  if (c.hasCriteria && c.stage !== '申込' && typeof c.daysToMoveIn === 'number'
      && c.daysToMoveIn >= 0 && c.daysToMoveIn <= CRM_TREE_MOVEIN_SOON_D && !c.moveInSoonHandled) return 'moveInSoon';
  if (c.stage === '申込') {
    return (c.daysSinceHandled === null || c.daysSinceHandled > CRM_TREE_APPLIED_STALE_D) ? 'appliedStale' : 'applied';
  }
  if (c.hasViewingTask) return 'viewing';
  if (c.nextTaskDue) return 'waitNext';   // 次の連絡日を決めてある人は、その日まで赤くしない

  var talked = (c.daysSinceTalk !== null && c.daysSinceTalk !== undefined);
  if (!c.hasLine) {
    if (!c.hasPhone && !c.hasCriteria) {
      // 自動メールは14日で終わる。それまでにLINEに来なければ終了
      if (c.daysSinceInquiry !== null && c.daysSinceInquiry > CRM_TREE_MAIL_DAYS) {
        c.endWhy = 'メールだけで' + c.daysSinceInquiry + '日';
        return 'ended';
      }
      return 'mailOnly';
    }
    if (c.hasPhone && !talked) {
      if (c.callSlots.done) {
        // 最後の1通は毎日のフォローアップメール（reply.py・反響から14日・LINE友だち追加入り）が担う。
        // それが終わるまで待ってから終了にする（ユーザー決定 2026-09-29。別のサヨナラのメールは送らない）
        if (c.daysSinceInquiry !== null && c.daysSinceInquiry <= CRM_TREE_MAIL_DAYS) return 'callDone';
        c.endWhy = '架電3枠つながらず・毎日のメール14日終了'; return 'ended';
      }
      if (c.daysSinceInquiry !== null && c.daysSinceInquiry > CRM_TREE_CALL_LIMIT_D) {
        c.endWhy = '架電の枠が埋まらないまま反響から' + c.daysSinceInquiry + '日'; return 'ended';
      }
      return c.callSlots.today ? 'callQueue' : 'callWait';
    }
    // 電話で話せた／条件がある（メールで配信中）人は下の追客中の判定へ
  } else if (!c.hasCriteria) {
    // ⚠️ 反応は「文を送ってきた」だけで数える（2026-09-29）。LINE Activity はボタンを押しても更新されるので、
    //   催促のあと何かタップしただけの人が永久に「条件登録待ち」に残っていた。
    if (c.nudgedMs && Date.now() - c.nudgedMs > CRM_TREE_NUDGE_WAIT_H * 3600000
        && !(c.replyMs > c.nudgedMs) && !(c.linkedMs > c.nudgedMs)) {
      // linkedMs: LINE と顧客がつながった時刻。空室確認でメールを送って本人が決まった人は、ボットが答えるので
      //   「返事の要る文」には残らない。それを反応なしと数えて終了にしていた（2026-10-08 ルーカスさん）
      c.endWhy = '催促のあと反応なし';
      return 'ended';
    }
    // 催促の記録が無い人（催促の仕組みより前に来た人など）は、7日で終了
    if (!c.nudgedMs && c.daysSinceInquiry !== null && c.daysSinceInquiry > CRM_TREE_NUDGE_FALLBACK_D) {
      c.endWhy = '条件登録されず' + c.daysSinceInquiry + '日';
      return 'ended';
    }
    return 'noCriteria';
  }
  if (!c.hasCriteria) {
    // 電話で話せたが、LINEにも来ず条件も無い人（「あとでLINEします」）。次の連絡日を決めていればそちら
    if (c.nextTaskDue) return 'waitNext';
    if (c.daysSinceTalk !== null && c.daysSinceTalk > CRM_TREE_TALKED_WAIT_D) {
      c.endWhy = '話せたがLINEに来ないまま' + c.daysSinceTalk + '日'; return 'ended';
    }
    return 'talkedNoLine';
  }

  // 配信停止＝終了（2026-09-29）。停止した時点で終了にするようになったが、それ以前に止めた人もここで終了に入れる。
  // 一時停止（snoozed）は解除日が来れば自動で戻るので終了にしない。
  if (st === 'paused' || st === 'auto_paused' || st === 'stopped') { c.endWhy = '配信停止'; return 'ended'; }
  if (c.daysSinceSent === null || c.daysSinceSent === undefined) {
    // 登録から7日たっても1件も送れていない＝条件が厳しい。人が見直す
    return (c.daysSinceInquiry !== null && c.daysSinceInquiry > CRM_TREE_FIRST_WAIT_DAYS) ? 'noSend14' : 'firstWait';
  }
  if (c.daysSinceSent >= CRM_TREE_NO_SEND_DAYS) return 'noSend14';
  if (c.daysSinceViewed === null || c.daysSinceViewed === undefined) {
    // 少しずつしか届かない人は継続確認（30日で10件以上）にも入らないので、ここで人が拾う
    var handledRecently = c.daysSinceHandled !== null && c.daysSinceHandled <= CRM_TREE_NEVER_VIEWED_D;
    if (c.daysSinceInquiry !== null && c.daysSinceInquiry > CRM_TREE_NEVER_VIEWED_D && !handledRecently) return 'neverViewed30';
    return 'neverViewed';
  }
  return 'following';
}

/** 対応ログ: 顧客名 → { failed, failedMs, lastMs: 最後に人が記録した時刻（反響の自動記録は除く）, inquiryMs: 反響の時刻 } */
function _crmTreeContactLog_(ss) {
  var out = {};
  try {
    var sh = ss.getSheetByName(CONTACT_LOG_SHEET_NAME);
    if (!sh || sh.getLastRow() < 2) return out;
    var rows = sh.getRange(2, 1, sh.getLastRow() - 1, 4).getValues();
    for (var i = 0; i < rows.length; i++) {
      var name = String(rows[i][0] || '').trim();
      if (!name) continue;
      var r = out[name] || (out[name] = { failed: 0, failedMs: [], lastMs: 0, inquiryMs: [], contactMs: [], talkMs: 0 });
      var ms = _cellToEpochMs_(rows[i][1]);
      var type = String(rows[i][2] || '').trim();
      // ⚠️ 反響の取込が自動で書く行は「対応した」の印にしない（2026-09-29）。
      //   印にすると、再問い合わせの瞬間に直前の合図（申込希望など）が全部「済み」になっていた。
      if (type.indexOf('反響') >= 0) { if (ms) r.inquiryMs.push(ms); continue; }
      var outcome = _contactLogOutcome_(rows[i][2], rows[i][3]);
      if (outcome === 'failed') { r.failed++; if (ms) r.failedMs.push(ms); }
      // 電話で話せた＝お客様が応じた（無視の数え直し）。LINE の記録は「こちらが送った」なので含めない
      if (outcome === 'talked' && type.indexOf('電話') >= 0 && ms > r.talkMs) r.talkMs = ms;
      if (ms) r.contactMs.push(ms);
      if (ms > r.lastMs) r.lastMs = ms;
    }
  } catch (e) { console.warn('[樹形図] 対応ログ: ' + e.message); }
  return out;
}

/**
 * 架電の3枠がどこまで埋まったか。
 *   first   … 最初の1回（いつでもよい）
 *   weekday … first と別の日で、平日
 *   weekend … first と別の日で、土日
 * today … 今日かけるべきか（平日なら first か weekday が空いている／土日なら first か weekend が空いている）
 */
function _crmTreeCallSlots_(failedMs) {
  var ms = (failedMs || []).slice().sort(function (a, b) { return a - b; });
  var dayOf = function (m) { return _jstDayIndex_(m); };
  var isWeekend = function (m) { return _crmIsWeekendOrHoliday_(m); };   // 土日＋祝日
  var s = { first: 0, weekday: 0, weekend: 0 };
  if (ms.length) s.first = ms[0];
  for (var i = 1; i < ms.length; i++) {
    if (dayOf(ms[i]) === dayOf(s.first)) continue;
    if (isWeekend(ms[i])) { if (!s.weekend) s.weekend = ms[i]; }
    else { if (!s.weekday) s.weekday = ms[i]; }
  }
  s.done = !!(s.first && s.weekday && s.weekend);
  var todayWeekend = isWeekend(Date.now());
  s.today = !s.done && (!s.first || (todayWeekend ? !s.weekend : !s.weekday));
  s.label = (s.first ? '直後✓' : '直後－') + ' ' + (s.weekday ? '平日✓' : '平日－') + ' ' + (s.weekend ? '土日✓' : '土日－');
  return s;
}

/**
 * アクションログから合図を拾う。顧客名 → 行の配列（必要な人だけ）。
 * A=顧客名 / B=room_id / C=アクション / I=日時
 */
function _crmTreeActions_(ss, names) {
  var out = {};
  try {
    var sh = ss.getSheetByName('アクションログ');
    if (!sh || sh.getLastRow() < 2) return out;
    var rows = sh.getRange(2, 1, sh.getLastRow() - 1, 9).getValues();
    for (var i = 0; i < rows.length; i++) {
      var n = String(rows[i][0] || '').trim();
      if (!n || !names[n]) continue;
      var act = String(rows[i][2] || '').trim().toLowerCase();
      if (['view', 'hold', 'viewing', 'hold_intent', 'viewing_intent'].indexOf(act) < 0) continue;
      var ms = _cellToEpochMs_(rows[i][8]);
      if (!ms) continue;
      (out[n] = out[n] || []).push({ room: String(rows[i][1] || ''), act: act, ms: ms });
    }
  } catch (e) { console.warn('[樹形図] アクションログ: ' + e.message); }
  return out;
}

/**
 * 合図を判定する。どれも「最後に対応ログを付けた時刻」より後のものだけ数える。
 *   apply  … 申込・内見の希望を送ってきた
 *   strong … 申込・内見の画面を開いて送らなかった／同じ物件を3回以上／3件以上 開いた
 *   reply  … ボットが答えなかったLINEの文が来ている
 */
function _crmTreeSignals_(acts, handledMs, replyMs, inquiryMs) {
  var sig = { apply: 0, strong: 0, reply: 0, reInquiry: 0, note: '', viewNote: '' };
  // 2回目以降の反響が、最後の記録より後に来ている＝再問い合わせ
  var inq = (inquiryMs || []).slice().sort(function (a, b) { return a - b; });
  // ⚠️ 初回の反響と同じ日のものは数えない（同時に2物件へ問い合わせる人がいる）
  // ⚠️ 直近 CRM_TREE_APPLY_DAYS 日のものだけ（2026-09-29）。期限が無いと、昔2回問い合わせて
  //   その後記録の無い人が何か月前のものでも全員赤くなった（16人）。
  if (inq.length >= 2 && inq[inq.length - 1] > handledMs
      && inq[inq.length - 1] >= Date.now() - CRM_TREE_APPLY_DAYS * _DAY_MS_
      && _jstDayIndex_(inq[inq.length - 1]) > _jstDayIndex_(inq[0])) {
    sig.reInquiry = inq[inq.length - 1];
    sig.note = '再問い合わせ';
  }
  var submitted = {};
  (acts || []).forEach(function (a) {
    if (a.ms <= handledMs) return;
    if ((a.act === 'hold' || a.act === 'viewing') && a.ms >= Date.now() - CRM_TREE_APPLY_DAYS * _DAY_MS_) {
      sig.apply = Math.max(sig.apply, a.ms);
      submitted[a.room + '|' + (a.act === 'hold' ? 'hold' : 'viewing')] = true;
    }
  });
  var viewsByRoom = {}, rooms = 0, since = Date.now() - CRM_TREE_SIGNAL_DAYS * _DAY_MS_;
  (acts || []).forEach(function (a) {
    if (a.ms <= handledMs) return;
    if ((a.act === 'hold_intent' || a.act === 'viewing_intent') && a.ms >= since) {
      var kind = (a.act === 'hold_intent') ? 'hold' : 'viewing';
      if (!submitted[a.room + '|' + kind]) {
        sig.strong = Math.max(sig.strong, a.ms);
        sig.note = (kind === 'hold' ? '申込' : '内見') + 'の画面を開いて送らなかった';
      }
    }
    // 閲覧だけの合図は赤くしない（2026-09-29 ユーザー判断）。よく見ている人ほど毎日赤くなるため。印として添えるだけ
    if (a.act === 'view' && a.ms >= since) {
      if (!viewsByRoom[a.room]) { viewsByRoom[a.room] = 0; rooms++; }
      viewsByRoom[a.room]++;
      if (viewsByRoom[a.room] >= CRM_TREE_VIEW_REPEAT || rooms >= CRM_TREE_VIEW_ROOMS) {
        sig.viewNote = (rooms >= CRM_TREE_VIEW_ROOMS)
          ? '直近' + CRM_TREE_SIGNAL_DAYS + '日で' + rooms + '件の物件を開いた' : '同じ物件を' + viewsByRoom[a.room] + '回開いた';
      }
    }
  });
  if (replyMs > handledMs) sig.reply = replyMs;
  return sig;
}

/** userId → 最後に「要返信」の文が来た時刻 */
function _crmTreeReplyByUid_(ss) {
  var out = {};
  var sh = ss.getSheetByName(CRM_TREE_REPLY_SHEET);
  if (!sh || sh.getLastRow() < 2) return out;
  sh.getRange(2, 1, sh.getLastRow() - 1, 2).getValues().forEach(function (r) {
    var uid = String(r[0] || '').trim();
    var ms = _cellToEpochMs_(r[1]);
    if (uid && ms > (out[uid] || 0)) out[uid] = ms;
  });
  return out;
}

/** userId → 最後にLINEで何か（文・タップ）があった時刻 */
function _crmTreeLineMsByUid_(ss) {
  var out = {};
  var sh = ss.getSheetByName('LINE Activity');
  if (!sh || sh.getLastRow() < 2) return out;
  sh.getRange(2, 1, sh.getLastRow() - 1, 2).getValues().forEach(function (r) {
    var uid = String(r[0] || '').trim();
    var ms = _cellToEpochMs_(r[1]);
    if (uid && ms > (out[uid] || 0)) out[uid] = ms;
  });
  return out;
}

/** LINE友だち追加: userId → { addedMs, nudgedMs, displayName } */
function _crmTreeNewFriends_(ss) {
  var out = {};
  var sh = ss.getSheetByName(NEW_FRIEND_SHEET);
  if (!sh || sh.getLastRow() < 2) return out;
  sh.getRange(2, 1, sh.getLastRow() - 1, NEW_FRIEND_NUDGED_AT_COL).getValues().forEach(function (r) {
    var uid = String(r[0] || '').trim();
    if (!uid) return;
    out[uid] = {
      addedMs: _cellToEpochMs_(r[1]),
      displayName: String(r[2] || '').trim(),
      nudgedMs: _cellToEpochMs_(r[NEW_FRIEND_NUDGED_AT_COL - 1])
    };
  });
  return out;
}

/** 旧顧客のうち、控えたあとに動いた人の名前の集合。 */
function _crmTreeOldCameBack_(ss, old, all) {
  var out = {};
  if (!old.frozenMs) return out;
  try {
    // 再問い合わせ（取込が対応ログに「SUUMO反響」を書く）
    var sh = ss.getSheetByName(CONTACT_LOG_SHEET_NAME);
    if (sh && sh.getLastRow() > 1) {
      sh.getRange(2, 1, sh.getLastRow() - 1, 3).getValues().forEach(function (r) {
        var n = String(r[0] || '').trim();
        if (old.names[n] && String(r[2] || '').indexOf('反響') >= 0 && _cellToEpochMs_(r[1]) > old.frozenMs) out[n] = true;
      });
    }
    // 返信が要るLINEの文
    var uidByName = (typeof _getLineUserIdMapByCustomerName_ === 'function') ? _getLineUserIdMapByCustomerName_() : {};
    var replyByUid = _crmTreeReplyByUid_(ss);
    Object.keys(old.names).forEach(function (n) {
      var uid = uidByName[n];
      if (uid && replyByUid[uid] > old.frozenMs) out[n] = true;
    });
    // 申込・内見の希望
    var acts = _crmTreeActions_(ss, old.names);
    Object.keys(acts).forEach(function (n) {
      acts[n].forEach(function (a) {
        if ((a.act === 'hold' || a.act === 'viewing') && a.ms > old.frozenMs) out[n] = true;
      });
    });
  } catch (e) { console.warn('[樹形図] 旧顧客の戻り: ' + e.message); }
  return out;
}

/** 旧顧客の名前の集合と、控えた時刻。シートが無ければ空（＝全員が樹形図に乗る）。 */
function _crmTreeOld_(ss) {
  var out = { names: {}, frozenMs: 0 };
  var sh = ss.getSheetByName(CRM_TREE_OLD_SHEET);
  if (!sh || sh.getLastRow() < 2) return out;
  sh.getRange(2, 1, sh.getLastRow() - 1, 2).getValues().forEach(function (r) {
    var n = String(r[0] || '').trim();
    if (n) out.names[n] = true;
    var ms = _cellToEpochMs_(r[1]);
    if (ms > out.frozenMs) out.frozenMs = ms;
  });
  return out;
}

/**
 * 樹形図に全員を乗せた結果を返す（顧客管理ページから呼ぶ）。
 * @return {{nodes:Array, customers:Array, oldCount:number}}
 */
function getCrmTree(opts) {
  opts = opts || {};
  var ss = SpreadsheetApp.openById(CRITERIA_SHEET_ID);
  var all = _getCustomerListForCRM_();
  var old = (opts.includeOld || CRM_TREE_INCLUDE_OLD) ? { names: {}, frozenMs: 0 } : _crmTreeOld_(ss);
  // ⚠️ 旧顧客でも、控えたあとに動いた人（再問い合わせ・返信が要るLINE・申込/内見の希望）は樹形図に戻す。
  //   捨てたのは「放っておいた過去」であって、今また来た人ではない。
  var back = _crmTreeOldCameBack_(ss, old, all);
  all = all.filter(function (c) {
    return !(typeof TEST_ALLOWED_NAMES !== 'undefined' && TEST_ALLOWED_NAMES.indexOf(c.name) >= 0);   // テスト用（本人）
  });
  var customers = all.filter(function (c) { return !old.names[c.name] || back[c.name]; });
  var oldCount = all.length - customers.length;

  var uidByName = (typeof _getLineUserIdMapByCustomerName_ === 'function') ? _getLineUserIdMapByCustomerName_() : {};
  var knownUid = {};
  Object.keys(uidByName).forEach(function (n) { knownUid[uidByName[n]] = true; });
  var friends = _crmTreeNewFriends_(ss);
  var blockedOnly = (typeof _lineBlockedOnlyIds_ === 'function') ? _lineBlockedOnlyIds_() : {};
  var family = _crmFamily_(ss);   // 家族のLINE（親の顧客にぶら下がる）

  // LINEに来たが、名前がまだ無い人（条件登録も空室確認もしていない）。
  // 検索条件シートに行が無いので、友だち追加の記録から足す。控えた時刻より後に来た人だけ。
  Object.keys(friends).forEach(function (uid) {
    var f = friends[uid];
    if (knownUid[uid] || family.byUid[uid] || !f.addedMs || f.addedMs < old.frozenMs) return;   // 家族としてつないだ人は出さない
    customers.push({
      name: (f.displayName || '（名前なし）') + '〔LINEのみ〕', lineOnly: true, uid: uid,
      status: blockedOnly[uid] ? 'blocked' : '', stage: '', hasLine: true, hasPhone: false, hasCriteria: false,
      daysSinceTalk: null, daysSinceSent: null, daysSinceViewed: null,
      registeredAt: Utilities.formatDate(new Date(f.addedMs), 'Asia/Tokyo', 'yyyy/MM/dd')
    });
  });

  // 1人分だけ作り直すとき（ボタンを押したあと）。全員分を作り直すと遅いので（2026-10-05）
  if (opts.only) customers = customers.filter(function (c) { return c.name === opts.only; });
  var names = {};
  customers.forEach(function (c) { names[c.name] = true; });
  var log = _crmTreeContactLog_(ss);
  var acts = _crmTreeActions_(ss, names);
  var replyByUid = _crmTreeReplyByUid_(ss);
  // LINE と顧客がつながった（顧客名が入った）時刻。LINE Users の C列（登録・更新した日時）
  var linkedByUid = {};
  try {
    var _lu = ss.getSheetByName(LINE_USERS_SHEET_NAME);
    if (_lu && _lu.getLastRow() > 1) _lu.getRange(2, 1, _lu.getLastRow() - 1, 3).getValues().forEach(function (r) {
      var u = String(r[0] || '').trim(); if (u && String(r[1] || '').trim()) linkedByUid[u] = _cellToEpochMs_(r[2]);
    });
  } catch (eLu) {}
  // 空室確認を頼んできた時刻も反応に数える（催促のカードで物件をタップした人を「反応なし」にしない）
  try {
    var _vr = ss.getSheetByName(VACANCY_REQUEST_SHEET);
    if (_vr && _vr.getLastRow() > 1) _vr.getRange(2, 1, _vr.getLastRow() - 1, 4).getValues().forEach(function (r) {
      var u = String(r[1] || '').trim(), ms = _cellToEpochMs_(r[3]);
      if (u && ms > (linkedByUid[u] || 0)) linkedByUid[u] = ms;
    });
  } catch (eVr) {}
  var lineMsByUid = _crmTreeLineMsByUid_(ss);
  var todayIdx = _jstDayIndex_(Date.now());
  var tasks = _crmTreeOpenTasks_(ss);
  var groups = _crmGroups_(ss);
  var autoCtx = _crmTreeAutoContext_(ss, friends);
  var todayStr = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd');

  var count = {};
  customers.forEach(function (c) {
    var uid = c.uid || uidByName[c.name] || '';
    c.uid = uid;
    c.lineMs = uid ? (lineMsByUid[uid] || 0) : 0;
    var cl = log[c.name] || { failed: 0, failedMs: [], lastMs: 0, inquiryMs: [], contactMs: [], talkMs: 0 };
    c.contactedToday = cl.lastMs ? (_jstDayIndex_(cl.lastMs) === todayIdx) : false;
    // 無視の日数: 最後にお客様が応じた時刻（LINEの文・タップ・電話で話せた）より後に、こちらが連絡した日の数
    c.respondedMs = Math.max(c.lineMs || 0, (uid ? (replyByUid[uid] || 0) : 0), cl.talkMs || 0);
    var _ignDays = {};
    (cl.contactMs || []).forEach(function (m) { if (m > c.respondedMs) _ignDays[_jstDayIndex_(m)] = true; });
    c.ignoreDays = Object.keys(_ignDays).length;
    c.group = groups[c.name] || '';
    c.failedCalls = cl.failed;
    c.callSlots = _crmTreeCallSlots_(cl.failedMs);
    // 14日前に入った日（＝引越し予定の14日前）以降に記録があれば済み
    if (typeof c.daysToMoveIn === 'number') {
      var soonStartMs = Date.now() - (CRM_TREE_MOVEIN_SOON_D - c.daysToMoveIn) * _DAY_MS_;
      c.moveInSoonHandled = cl.lastMs >= soonStartMs;
    }
    c.nudgedMs = (uid && friends[uid]) ? friends[uid].nudgedMs : 0;
    var regMs = c.registeredAt ? new Date(c.registeredAt).getTime() : 0;
    c.daysSinceInquiry = regMs ? (todayIdx - _jstDayIndex_(regMs)) : null;
    c.replyMs = uid ? (replyByUid[uid] || 0) : 0;
    c.linkedMs = uid ? (linkedByUid[uid] || 0) : 0;
    // 家族のLINEから来た文も、親の顧客の「返信待ち」に数える
    (family.byName[c.name] || []).forEach(function (fm) { if ((replyByUid[fm.uid] || 0) > c.replyMs) c.replyMs = replyByUid[fm.uid]; });
    c.family = (family.byName[c.name] || []).map(function (fm) { return { uid: fm.uid, disp: fm.disp }; });
    c.daysSinceHandled = cl.lastMs ? (todayIdx - _jstDayIndex_(cl.lastMs)) : null;
    c.sig = _crmTreeSignals_(acts[c.name], cl.lastMs, c.replyMs, cl.inquiryMs);
    var ts = tasks[c.name] || [];
    c.tasks = ts;
    c.taskDueNow = ts.some(function (t) { return t.due && t.due <= todayStr; });
    c.hasViewingTask = ts.some(function (t) { return t.content.indexOf('内見') >= 0; });
    c.nextTaskDue = ts.filter(function (t) { return t.due; }).map(function (t) { return t.due; }).sort()[0] || '';
    c.node = _crmTreeNodeOf_(c);
    c.stageId = _crmStageOf_(c);
    try { c.nextAuto = _crmTreeNextAuto_(c, autoCtx); } catch (eNA) { c.nextAuto = ''; }
    count[c.node] = (count[c.node] || 0) + 1;
  });

  var nodes = CRM_TREE_NODES.map(function (n) {
    return { id: n.id, label: n.label, parent: n.parent, mine: !!n.mine, urgent: !!n.urgent, count: count[n.id] || 0 };
  });
  return { nodes: nodes, customers: customers, oldCount: oldCount };
}

/**
 * 【GASエディタで実行: CrmTree.gs】今いる全顧客を「旧顧客」として控える。1回だけ。
 * これ以降に来た人だけが樹形図に乗る。すでに控えてあれば何もしない。
 * 旧顧客への自動配信などは何も変えない。
 */
function freezeOldCustomers() {
  var ss = SpreadsheetApp.openById(CRITERIA_SHEET_ID);
  if (ss.getSheetByName(CRM_TREE_OLD_SHEET)) {
    console.log('すでに控えてあります（' + CRM_TREE_OLD_SHEET + '）。何もしません');
    return;
  }
  // 反響から7日以内でまだ電話していない人だけは残す（まだ間に合う。2026-09-28）。
  // 反響だけの人は条件が無いので、A列の日付＝取り込んだ日のまま動かない。
  var names = getCrmTree().customers.filter(function (c) {
    return !(c.node === 'callQueue' && c.daysSinceInquiry !== null && c.daysSinceInquiry <= 7);
  }).map(function (c) { return c.name; });
  var sh = ss.insertSheet(CRM_TREE_OLD_SHEET);
  var now = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy/MM/dd HH:mm');
  var rows = [['顧客名', '控えた日時']].concat(names.map(function (n) { return [n, now]; }));
  sh.getRange(1, 1, rows.length, 2).setValues(rows);
  console.log('旧顧客として ' + names.length + ' 人を控えました。これ以降に来た人だけが樹形図に乗ります');
}

/**
 * 【GASエディタで実行: CrmTree.gs】枝ごとの人数と、赤い枝・迷子の顔ぶれをログに出す。
 * 何も変えない。
 */
function previewCrmTree(opts) {
  var t = getCrmTree(opts);
  var byNode = {};
  t.customers.forEach(function (c) { (byNode[c.node] = byNode[c.node] || []).push(c); });
  var depthOf = function (n) {
    var d = 0, p = n.parent;
    while (p) { d++; p = (CRM_TREE_NODES.filter(function (x) { return x.id === p; })[0] || {}).parent; }
    return d;
  };
  var lines = ['樹形図 ' + t.customers.length + ' 人（旧顧客 ' + t.oldCount + ' 人は対象外）'];
  t.nodes.forEach(function (n) {
    lines.push(new Array(depthOf(n) + 1).join('　') + (n.mine ? '🔴 ' : '・') + n.label + '【' + n.count + '】');
  });
  console.log(lines.join('\n'));

  t.nodes.forEach(function (n) {
    if (!n.count) return;
    var list = (byNode[n.id] || []).map(function (c) {
      return c.name + '（反響から' + (c.daysSinceInquiry === null ? '-' : c.daysSinceInquiry) + '日'
        + ' / LINE:' + (c.hasLine ? '有' : '無') + ' / 電話:' + (c.hasPhone ? '有' : '無')
        + ' / 条件:' + (c.hasCriteria ? '有' : '無') + ' / 架電:' + (c.callSlots ? c.callSlots.label : '-')
        + (c.sig && c.sig.note ? ' / 合図:' + c.sig.note : '')
        + (c.endWhy ? ' / 終了理由:' + c.endWhy : '') + '）';
    });
    var more = list.length > 40 ? '\n…ほか' + (list.length - 40) + '人' : '';
    console.log('■ ' + n.label + '（' + n.count + '人）\n' + list.slice(0, 40).join('\n') + more);
  });
}

/** 画面に渡す形に絞る（顧客ごとの項目を必要なものだけにして軽くする）。 */
function _crmTreeForPage_(only) {
  // ボタンで書いたあと（1人分の作り直し）は、CRM が書くシートの変わった行を写しへ送ってから返す（CfSync.gs）。
  // ⚠️ 送っていないと、Cloudflare版で写しを取り込み直したときに、押した操作が元に戻って見えた（2026-10-08）
  if (only && typeof cfSyncAfterCrmWrite_ === 'function') { try { cfSyncAfterCrmWrite_(); } catch (eCf) { console.warn('[Cloudflare写し] ' + eCf.message); } }
  // Cloudflare版が自分で組み立てるとき（CfSync.gs の lite）は作り直さない。保存だけして早く返す
  if (only && typeof _CRM_PAGE_LITE_ !== 'undefined' && _CRM_PAGE_LITE_) return { lite: true, onlyName: only };
  var t = getCrmTree(only ? { only: only } : {});
  var ex = _crmExtrasAll_(t.customers);
  var crits = _crmCriteriaAll_();
  var pend = (typeof _crmPendingAll_ === 'function') ? _crmPendingAll_(crits, only) : {};
  var watch = (typeof _crmWatchAll_ === 'function') ? _crmWatchAll_() : {};
  var cands = (typeof _crmCandidatesAll_ === 'function') ? _crmCandidatesAll_() : {};
  var page = {
    nodes: t.nodes,
    oldCount: t.oldCount,
    stages: CRM_STAGES,
    customers: t.customers.map(function (c) {
      var chip = _crmChipOf_(c);
      return {
        stageId: c.stageId, todo: chip.todo, chipStatus: chip.status,
        flags: chip.flags.concat((pend[c.name] || []).length && c.stageId !== 'ended' ? ['📦新着' + pend[c.name].length + '件'] : [])
          .concat((watch[c.name] || []).some(function (w) { return w.status === 'available'; }) ? ['🔔キャンセル待ちが空いた'] : []),
        // ⚠️ キャンセル待ちの件数は名前の横に出さない（それほど大事ではない。⏳待ちのタブで見られる）
        // やること（タスク）: 済んでいないものを期日順に。行番号は直す・消すときの目印
        taskList: (c.tasks || []).map(function (t) { return { row: t.row, content: t.content, due: t.due || '' }; })
          .sort(function (a, b) { return (a.due || '9999') < (b.due || '9999') ? -1 : (a.due || '9999') > (b.due || '9999') ? 1 : 0; }),
        watch: watch[c.name] || [],
        inquiries: (ex.inq[c.name] || []), memo: ex.memo[c.name] || '',
        lineUid: !!(c.uid && !c.lineOnly && String(c.uid).indexOf('admin_') !== 0),
        uid: c.lineOnly ? (c.uid || '') : '',   // 〔LINEのみ〕の人を顧客とつなぐときだけ使う
        family: c.family || [],
        // cand: 送信候補に入れた物件（☆候補のタブに出る）
        pending: (c.stageId !== 'ended' && c.stageId !== 'won') ? (pend[c.name] || []).map(function (p) { p.cand = !!(cands[c.name] && cands[c.name][p.roomId]); return p; }) : [],
        criteria: (c.stageId !== 'ended' && c.stageId !== 'won') ? (crits[c.name] || null) : null,
        group: c.group || '', contactedToday: !!c.contactedToday, ignoreDays: c.ignoreDays || 0,
        name: c.name, node: c.node, lineOnly: !!c.lineOnly,
        phone: c.phone || '', hasLine: !!c.hasLine, hasCriteria: !!c.hasCriteria,
        daysSinceInquiry: c.daysSinceInquiry, failedCalls: c.failedCalls || 0,
        callSlots: (c.callSlots && c.callSlots.first !== undefined) ? c.callSlots.label : '',
        email: c.email || '',
        daysSinceSent: c.daysSinceSent, daysSinceViewed: c.daysSinceViewed,
        lastTalkAt: c.lastTalkAt || '', moveIn: c.moveIn || '',
        note: (c.sig && c.sig.note) || '', viewNote: (c.sig && c.sig.viewNote) || '',
        endWhy: c.endWhy || '', stage: c.stage || '', nextAuto: c.nextAuto || '',
        tasks: (c.tasks || []).map(function (t) { return t.content + (t.due ? '（' + t.due.substring(5).replace('-', '/') + '）' : ''); })
      };
    })
  };
  // 1人分だけ: 画面はその人だけ差し替える（いなくなったら消す。終了で樹形図から外れた人など）
  if (only) return { one: page.customers[0] || null, onlyName: only };
  page.ver = Date.now();   // この時点までの動きは画面に入っている
  return page;
}

// ── 「新しい動きがあります」の知らせ ──
// CRMの外でシートが変わったら、何が・いつ変わったかだけを覚えておく（スクリプトキャッシュ。6時間で消える）。
// CRMは1分ごとに getCrmVersion で確かめ、ページを開いた後の動きがあれば上に知らせを出す。
function _crmTouch_(why) {
  try {
    var c = CacheService.getScriptCache(), now = Date.now();
    var w = {};
    try { w = JSON.parse(c.get('crmWhy') || '{}'); } catch (e0) {}
    w[why] = now;
    Object.keys(w).forEach(function (k) { if (now - w[k] > 6 * 3600 * 1000) delete w[k]; });
    c.putAll({ crmVer: String(now), crmWhy: JSON.stringify(w) }, 21600);
  } catch (e) {}
}
function getCrmVersion() {
  var c = CacheService.getScriptCache(), w = {};
  try { w = JSON.parse(c.get('crmWhy') || '{}'); } catch (e) {}
  return { ver: Number(c.get('crmVer') || 0), whys: w, now: Date.now() };
}

/** 画面: 1人分だけ取り直す（保存に失敗したとき、画面を今の状態に戻す）。 */
function getCrmOne(customerName) {
  return _crmTreeForPage_(customerName);
}

/** Cloudflare版CRM: ページに埋め込んでいた値（アドレス・選択肢の一部）。GAS版の handleCrmTreePage と同じもの。 */
function getCrmPageConsts() {
  return {
    customerPageUrl: getCustomerDetailPageUrl(),
    adminUrl: getAdminPageUrl(''),
    approveBaseUrl: getGasBaseUrl() + '?action=approve&collect=1',
    mobileSearchUrl: getMobileSearchWrappedUrl(),
    listings: _crmActiveListings_()
  };
}

/** 画面の再読み込み用（google.script.run）。 */
function getCrmTreeForPage() {
  return _crmTreeForPage_();
}

/** 画面の1タップ記録（google.script.run）。対応ログに1行足して、樹形図を返す。 */
function recordCrmTreeContact(customerName, type, memo) {
  var r = addContactLog(customerName, type, new Date().toISOString(), String(memo || ''));
  if (!r || !r.success) throw new Error((r && r.message) || '記録できませんでした');
  _crmTreeCloseDueTasks_(customerName);
  return _crmTreeForPage_(customerName);
}


/** doGet(action=crm) — 樹形図の顧客管理ページ。 */
function handleCrmTreePage(e) {
  if (!_validateReinsApiKey(e.parameter.api_key)) {
    return HtmlService.createHtmlOutput(
      '<html><body style="text-align:center;padding:40px;font-family:sans-serif;">' +
      '<h3>認証エラー</h3><p>api_key が正しくありません。</p></body></html>'
    ).setTitle('認証エラー');
  }
  // ?customer=<名前> 付きで来たら、その人の詳細（旧画面）をそのまま開く。古いリンクを生かすため
  if (e.parameter.customer) return handleCustomerPage(e);
  var tpl = HtmlService.createTemplateFromFile('CrmTreePage');
  tpl.treeJson = _jsonForInlineScript_(_crmTreeForPage_());
  tpl.customerPageUrl = _jsonForInlineScript_(getCustomerDetailPageUrl());
  // 条件入力の選択肢（管理画面と同じマスター）
  tpl.masterJson = _jsonForInlineScript_({
    routeCompanies: ROUTE_COMPANIES, stations: STATION_DATA, cities: TOKYO_CITIES, equipment: EQUIPMENT_CATEGORIES,
    listings: _crmActiveListings_()
  });
  tpl.adminUrl = _jsonForInlineScript_(getAdminPageUrl(''));
  tpl.approveBaseUrl = _jsonForInlineScript_(getGasBaseUrl() + '?action=approve&collect=1');
  tpl.cfUrl = _jsonForInlineScript_(typeof cfCrmUrl === 'function' ? cfCrmUrl() : '');
  // ⚠️ 物件検索のURLはここで埋め込んでリンクにする（google.script.run の応答後に開くとブロックされる）
  tpl.mobileSearchUrl = _jsonForInlineScript_(getMobileSearchWrappedUrl());
  return tpl.evaluate()
    .setTitle('顧客管理')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

function getCrmTreePageUrl() {
  var apiKey = PropertiesService.getScriptProperties().getProperty('REINS_API_KEY') || '';
  return ScriptApp.getService().getUrl() + '?action=crm&api_key=' + encodeURIComponent(apiKey);
}

/** 【GASエディタで実行: CrmTree.gs】樹形図ページのURLをログに出す。 */
function showCrmTreePageUrl() {
  console.log(getCrmTreePageUrl());
}

/**
 * 【GASエディタで実行: CrmTree.gs】旧顧客も樹形図に入れたらどうなるかをログに出す。何も変えない。
 * 入れてよければ「樹形図の対象外（旧顧客）」シートを消せば、画面にもそのまま出る。
 */
function previewCrmTreeWithOld() {
  previewCrmTree({ includeOld: true });
}

// ════════════════════════════════════════════
//  次の一手（タスクシートを使う）
// ════════════════════════════════════════════
// 次回接触日・内見の確認は、既存の「タスク」シート（コード.js TASK_SHEET_NAME）に書く。
// 旧画面の詳細にも同じものが出るので、どちらから見ても揃う。
var CRM_NEXT_TASK = '次の連絡';

/** 未完了で「自分」ボールのタスク: 顧客名 → [{row, content, due('yyyy-MM-dd')}] */
function _crmTreeOpenTasks_(ss) {
  var out = {};
  try {
    var sh = ss.getSheetByName(TASK_SHEET_NAME);
    if (!sh || sh.getLastRow() < 2) return out;
    var rows = sh.getRange(2, 1, sh.getLastRow() - 1, 6).getValues();
    for (var i = 0; i < rows.length; i++) {
      var n = String(rows[i][0] || '').trim();
      if (!n) continue;
      if (String(rows[i][3] || '') === 'TRUE' || rows[i][3] === true) continue;
      if (_normalizeTaskOwner_(rows[i][5]) !== TASK_OWNER_DEFAULT) continue;
      var d = rows[i][2];
      var due = (d instanceof Date) ? Utilities.formatDate(d, 'Asia/Tokyo', 'yyyy-MM-dd') : '';
      (out[n] = out[n] || []).push({ row: i + 2, content: String(rows[i][1] || ''), due: due });
    }
  } catch (e) { console.warn('[樹形図] タスク: ' + e.message); }
  return out;
}

/** 期限が今日までの「自分」タスクを完了にする（記録を付けた＝その約束は果たした）。 */
function _crmTreeCloseDueTasks_(customerName) {
  var ss = SpreadsheetApp.openById(CRITERIA_SHEET_ID);
  var todayStr = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd');
  var mine = _crmTreeOpenTasks_(ss)[customerName] || [];
  var sh = ss.getSheetByName(TASK_SHEET_NAME);
  mine.forEach(function (t) {
    // 内見の前日確認・結果確認は、その日が来ていれば一緒に閉じる。次の連絡も同じ
    if (t.due && t.due <= todayStr) sh.getRange(t.row, 4).setValue('TRUE');
  });
}

function _crmDateAfter_(days) {
  return Utilities.formatDate(new Date(Date.now() + days * _DAY_MS_), 'Asia/Tokyo', 'yyyy-MM-dd');
}

/** 画面: 次の連絡日を決める（days=0 なら決めない）。 */
function setCrmNextContact(customerName, days) {
  days = Number(days) || 0;
  if (days > 0) {
    // 前に決めた「次の連絡」は閉じて、新しい日だけにする（選び直したら、そちらが赤くする日になる）
    try {
      var ss = SpreadsheetApp.openById(CRITERIA_SHEET_ID), sh = ss.getSheetByName(TASK_SHEET_NAME);
      (_crmTreeOpenTasks_(ss)[customerName] || []).forEach(function (t) {
        if (t.content === CRM_NEXT_TASK) { sh.getRange(t.row, 4).setValue('TRUE'); try { cfSyncRows(TASK_SHEET_NAME, [t.row], '次の連絡'); } catch (eCf) {} }
      });
    } catch (eClose) { console.warn('[次の連絡] 前の日を閉じられません: ' + eClose.message); }
    var r = addCustomerTask(customerName, CRM_NEXT_TASK, _crmDateAfter_(days), TASK_OWNER_DEFAULT);
    if (!r || !r.success) throw new Error((r && r.message) || '次の連絡日を保存できませんでした');
  }
  return _crmTreeForPage_(customerName);
}

// ── やること（タスク）──  タスクシート: A 顧客名 / B 内容 / C 期日 / D 済み(TRUE) / E 作成 / F 担当 / G 更新
// 行番号で指すが、行がずれていたら（消したなど）名前と内容で探し直す
function _crmTaskRowOf_(sh, customerName, row, content) {
  var lr = sh.getLastRow();
  if (row >= 2 && row <= lr) {
    var v = sh.getRange(row, 1, 1, 2).getValues()[0];
    if (String(v[0]).trim() === customerName && String(v[1]) === String(content)) return row;
  }
  if (lr < 2) return -1;
  var all = sh.getRange(2, 1, lr - 1, 4).getValues();
  for (var i = 0; i < all.length; i++) {
    if (String(all[i][0]).trim() === customerName && String(all[i][1]) === String(content) && String(all[i][3]) !== 'TRUE' && all[i][3] !== true) return i + 2;
  }
  return -1;
}
/** 画面: やることを足す（due は yyyy-MM-dd か空）。 */
function addCrmTask(customerName, content, due) {
  content = String(content || '').trim();
  if (!content) throw new Error('やることを入れてください');
  var r = addCustomerTask(customerName, content, due || '', TASK_OWNER_DEFAULT);
  if (!r || !r.success) throw new Error((r && r.message) || '足せませんでした');
  var page = _crmTreeForPage_(customerName); page.savedMessage = 'やることを足しました'; return page;
}
/** 画面: やることを済みにする。 */
function doneCrmTask(customerName, row, content) {
  var sh = SpreadsheetApp.openById(CRITERIA_SHEET_ID).getSheetByName(TASK_SHEET_NAME);
  var r = _crmTaskRowOf_(sh, customerName, row, content);
  if (r < 0) throw new Error('そのやることが見つかりません（もう済んでいるかもしれません）');
  sh.getRange(r, 4).setValue('TRUE'); sh.getRange(r, 7).setValue(new Date());
  try { cfSyncRows(TASK_SHEET_NAME, [r], 'やること'); } catch (eCf) {}
  var page = _crmTreeForPage_(customerName); page.savedMessage = '済みにしました'; return page;
}
/** 画面: やることの期日を直す（due は yyyy-MM-dd か空）。 */
function setCrmTaskDue(customerName, row, content, due) {
  var sh = SpreadsheetApp.openById(CRITERIA_SHEET_ID).getSheetByName(TASK_SHEET_NAME);
  var r = _crmTaskRowOf_(sh, customerName, row, content);
  if (r < 0) throw new Error('そのやることが見つかりません');
  var d = due ? new Date(String(due).replace(/-/g, '/')) : '';
  sh.getRange(r, 3).setValue(d && !isNaN(d.getTime()) ? d : ''); sh.getRange(r, 7).setValue(new Date());
  try { cfSyncRows(TASK_SHEET_NAME, [r], 'やること'); } catch (eCf) {}
  var page = _crmTreeForPage_(customerName); page.savedMessage = '期日を直しました'; return page;
}
/** 画面: やることを消す（間違えて足したときなど）。 */
function deleteCrmTask(customerName, row, content) {
  var sh = SpreadsheetApp.openById(CRITERIA_SHEET_ID).getSheetByName(TASK_SHEET_NAME);
  var r = _crmTaskRowOf_(sh, customerName, row, content);
  if (r < 0) throw new Error('そのやることが見つかりません');
  sh.deleteRow(r);
  try { cfSyncSheet(TASK_SHEET_NAME, 'やること'); } catch (eCf) {}
  var page = _crmTreeForPage_(customerName); page.savedMessage = '消しました'; return page;
}

/** 画面: 内見の予定を入れる。前日に確認、翌日に結果を聞く、の2つをタスクにする。 */
function planCrmViewing(customerName, dateStr) {
  var d = new Date(String(dateStr).replace(/-/g, '/'));
  if (isNaN(d.getTime())) throw new Error('日付を選んでください');
  var label = Utilities.formatDate(d, 'Asia/Tokyo', 'M/d') + ' 内見';
  var before = Utilities.formatDate(new Date(d.getTime() - _DAY_MS_), 'Asia/Tokyo', 'yyyy-MM-dd');
  var after = Utilities.formatDate(new Date(d.getTime() + _DAY_MS_), 'Asia/Tokyo', 'yyyy-MM-dd');
  addCustomerTask(customerName, '内見の前日確認（' + label + '）', before, TASK_OWNER_DEFAULT);
  addCustomerTask(customerName, '内見の結果を聞く（' + label + '）', after, TASK_OWNER_DEFAULT);
  addContactLog(customerName, '内見予定', new Date().toISOString(), label);
  return _crmTreeForPage_(customerName);
}

/**
 * 画面: 工程を変える。stage = '申込' | '成約' | '終了' | ''（追客中に戻す）
 * 終了は理由を T列 に書く（自動終了の印とは別の文言なので、自動の復活は効かない）。
 */
var CRM_END_REASONS = ['音信不通', '他社で決定', '条件が合わない', '引越し中止', 'その他'];
function setCrmStage(customerName, stage, reason) {
  var r = setCustomerStage(customerName, stage);
  if (!r || !r.ok) throw new Error((r && r.message) || '変更できませんでした');
  var sh = SpreadsheetApp.openById(CRITERIA_SHEET_ID).getSheetByName(CRITERIA_SHEET_NAME);
  var data = sh.getDataRange().getValues();
  var row = _autoEndCriteriaRow_(data, customerName);
  if (row > 0) {
    if (stage === '終了') {
      sh.getRange(row, 20).setValue('終了: ' + (reason || 'その他'));   // T列
      sh.getRange(row, 21).setValue(new Date());                        // U列: 止めた日時（送付履歴の片付けの起点）
    }
    if (stage === '') {
      sh.getRange(row, 20).setValue('');
      sh.getRange(row, 21).setValue('');
      if (String(data[row - 1][44] || '').trim()) sh.getRange(row, 45).setValue('');   // AS列: アーカイブを外す
    }
  }
  if (stage !== '') {
    // 申込・成約・終了にしたら、残っている「次の連絡」「内見」の約束は閉じる
    var ss = SpreadsheetApp.openById(CRITERIA_SHEET_ID);
    var tsh = ss.getSheetByName(TASK_SHEET_NAME);
    (_crmTreeOpenTasks_(ss)[customerName] || []).forEach(function (t) {
      if (t.content === CRM_NEXT_TASK || t.content.indexOf('内見') >= 0) tsh.getRange(t.row, 4).setValue('TRUE');
    });
  }
  addContactLog(customerName, 'その他', new Date().toISOString(),
    stage ? ('工程: ' + stage + (reason ? '（' + reason + '）' : '')) : '工程: 追客中に戻す');
  return _crmTreeForPage_(customerName);
}

/**
 * 終了・アーカイブの人が再問い合わせしてきたら追客に戻す（InquiryImport.js から呼ぶ）。
 * 成約の人はそのまま。
 * @return {boolean} 戻したか
 */
function reviveEndedCustomer(customerName) {
  try {
    var sh = SpreadsheetApp.openById(CRITERIA_SHEET_ID).getSheetByName(CRITERIA_SHEET_NAME);
    var data = sh.getDataRange().getValues();
    var row = _autoEndCriteriaRow_(data, customerName);
    if (row < 0) return false;
    var stage = String(data[row - 1][32] || '').trim();
    var archived = !!String(data[row - 1][44] || '').trim();
    if (stage !== '終了' && !archived) return false;
    if (stage === '終了') sh.getRange(row, 33).setValue('');
    sh.getRange(row, 20).setValue('');
    sh.getRange(row, 21).setValue('');
    if (archived) sh.getRange(row, 45).setValue('');
    console.log('[樹形図] 再問い合わせのため追客に戻しました: ' + customerName);
    return true;
  } catch (e) {
    console.warn('[樹形図] 戻せません: ' + customerName + ' / ' + e.message);
    return false;
  }
}

/**
 * 【GASエディタで実行: CrmTree.gs】引越し予定まで14日以内の人を全員出し、
 * 「引越しが近い」に入らなかった理由（いる枝・記録済みか・条件の有無）を添える。何も変えない。
 */
function previewMoveInSoon() {
  var t = getCrmTree({ includeOld: true });
  var list = t.customers.filter(function (c) {
    return typeof c.daysToMoveIn === 'number' && c.daysToMoveIn >= 0 && c.daysToMoveIn <= CRM_TREE_MOVEIN_SOON_D;
  });
  var label = {};
  t.nodes.forEach(function (n) { label[n.id] = n.label; });
  console.log('引越し予定まで' + CRM_TREE_MOVEIN_SOON_D + '日以内: ' + list.length + '人\n' + list.map(function (c) {
    return (c.node === 'moveInSoon' ? '🔴 ' : '・') + c.name + '（' + c.moveIn + '・あと' + c.daysToMoveIn + '日）'
      + ' いる枝: ' + (label[c.node] || c.node)
      + (c.moveInSoonHandled ? ' / この期間に記録あり' : '')
      + (c.hasCriteria ? '' : ' / 条件なし')
      + (c.stage ? ' / 工程: ' + c.stage : '');
  }).join('\n'));
}

/** userId → 顧客名（LINE Users）。⚠️ _getLineUserName_ はニックネームを返すことがあるので、こちらを使う。 */
function _crmNameByUid_(userId) {
  try {
    var sh = SpreadsheetApp.openById(CRITERIA_SHEET_ID).getSheetByName(LINE_USERS_SHEET_NAME);
    if (!sh || sh.getLastRow() < 2) return '';
    var rows = sh.getRange(2, 1, sh.getLastRow() - 1, 2).getValues();
    for (var i = rows.length - 1; i >= 0; i--) {
      if (String(rows[i][0] || '').trim() === String(userId)) return String(rows[i][1] || '').trim();
    }
  } catch (e) { console.warn('[樹形図] LINE Users: ' + e.message); }
  return '';
}

/** 終了の理由を T列 に書く（手で終了にしたのと同じ書式。自動終了の印ではないので、自動では戻らない）。 */
function _markEndReasonT_(customerName, reason) {
  var sh = SpreadsheetApp.openById(CRITERIA_SHEET_ID).getSheetByName(CRITERIA_SHEET_NAME);
  var row = _autoEndCriteriaRow_(sh.getDataRange().getValues(), customerName);
  if (row > 0) sh.getRange(row, 20).setValue('終了: ' + reason);
}

// ════════════════════════════════════════════
//  次の自動メッセージ（2026-09-29）
// ════════════════════════════════════════════
// 顧客ごとに「このあと自動で何が、いつ届くか」を1〜2件出す。各仕組みの判定をなぞった**目安**で、
// 送るかどうかの最終判断は各仕組み（送る直前の確認）に任せる。

/** 各仕組みの記録シートを1回ずつ読んでおく。 */
function _crmTreeAutoContext_(ss, friends) {
  var ctx = { fdDone: {}, fdFirst: {}, moveInAsked: {}, waiting: {}, stillLast: {}, fsAsked: {}, friends: friends || {},
    phoneAsk: (typeof _phoneAskPlanned_ === 'function') ? _phoneAskPlanned_() : {} };
  var read = function (sheetName, cols, fn) {
    try {
      var sh = ss.getSheetByName(sheetName);
      if (!sh || sh.getLastRow() < 2) return;
      sh.getRange(2, 1, sh.getLastRow() - 1, cols).getValues().forEach(fn);
    } catch (e) { console.warn('[次の自動] ' + sheetName + ': ' + e.message); }
  };
  read(FIRST_DELIVERY_SHEET, 6, function (r) { ctx.fdDone[String(r[0] || '').trim()] = true; });
  read(MOVE_IN_SHEET, 6, function (r) {
    var n = String(r[0] || '').trim();
    ctx.moveInAsked[n + '|' + String(r[1] || '').trim()] = true;
    if (String(r[5] || '').trim() === '返事待ち') ctx.waiting[n] = { ms: _fdMs_(r[2]) + MOVE_IN_WAIT_H * 3600000, what: '引越し時期の確認' };
  });
  read(STILL_SHEET, 7, function (r) {
    var n = String(r[0] || '').trim();
    var ms = _fdMs_(r[3]);
    if (ms > (ctx.stillLast[n] || 0)) ctx.stillLast[n] = ms;
    if (String(r[6] || '').trim() === '返事待ち') ctx.waiting[n] = { ms: ms + STILL_WAIT_H * 3600000, what: '継続確認' };
  });
  read(FIRST_SEARCH_SHEET, 5, function (r) {
    var n = String(r[0] || '').trim();
    ctx.fsAsked[n] = true;
    if (String(r[4] || '').trim() === '返事待ち') ctx.waiting[n] = { ms: _fdMs_(r[2]) + FIRST_SEARCH_REPLY_H * 3600000, what: '初回検索0件の相談カード' };
  });
  try {
    var b = _firstDeliveryBatches_();
    Object.keys(b).forEach(function (n) { ctx.fdFirst[n] = b[n].firstMs; });
  } catch (e) { console.warn('[次の自動] 初回配信: ' + e.message); }
  return ctx;
}

function _crmFmt_(ms, withTime) {
  return Utilities.formatDate(new Date(ms), 'Asia/Tokyo', withTime ? 'M/d H:mm' : 'M/d');
}

/** 1人ぶんの「次の自動メッセージ」。無ければ ''。 */
function _crmTreeNextAuto_(c, ctx) {
  if (c.node === 'ended' || c.node === 'won' || String(c.status || '').toLowerCase() === 'blocked') return '';
  var now = Date.now();
  var items = [];   // {ms, text}
  var st = String(c.status || '').toLowerCase();
  var delivering = !(st === 'paused' || st === 'auto_paused' || st === 'stopped' || st === 'snoozed');

  // 条件登録直後の「お電話で5分ほど」
  if (ctx.phoneAsk[c.name]) items.push({ ms: ctx.phoneAsk[c.name], text: '電話のお願い（' + _crmFmt_(ctx.phoneAsk[c.name], true) + 'ごろ）' });

  // 返事待ち → 期限で終了（これが一番近い予定）
  var w = ctx.waiting[c.name];
  if (w && w.ms) items.push({ ms: w.ms, text: w.what + 'に返事がなければ終了（' + _crmFmt_(w.ms, true) + '）' });

  // LINEに来ていない人: 毎日のフォローアップメール（reply.py・反響から14日）
  if (!c.hasLine && c.email && c.daysSinceInquiry !== null && c.daysSinceInquiry < CRM_TREE_MAIL_DAYS) {
    var endMs = now + (CRM_TREE_MAIL_DAYS - c.daysSinceInquiry) * _DAY_MS_;
    items.push({ ms: now, text: '毎日のメール（あと' + (CRM_TREE_MAIL_DAYS - c.daysSinceInquiry) + '日・' + _crmFmt_(endMs) + 'まで）' });
  }

  // 友だち追加だけの人: 16時間後の案内（1回きり）
  if (c.uid && ctx.friends[c.uid] && !c.hasCriteria && !c.nudgedMs && ctx.friends[c.uid].addedMs) {
    var nMs = ctx.friends[c.uid].addedMs + NEW_FRIEND_REMIND_AFTER_HOURS * 3600000;
    if (nMs > now - _DAY_MS_) items.push({ ms: Math.max(nMs, now), text: '友だち追加の案内（' + _crmFmt_(Math.max(nMs, now), true) + 'ごろ・営業時間内）' });
  }

  if (c.hasCriteria && c.hasLine && delivering && c.stage !== '申込' && c.stage !== '成約') {
    // 初回配信の再送（25時間15分後・1件も見ていない人・1回きり）
    var fm = ctx.fdFirst[c.name];
    if (fm && !ctx.fdDone[c.name] && (c.daysSinceViewed === null || c.daysSinceViewed === undefined)
        && now - fm < FIRST_DELIVERY_MAX_AGE_H * 3600000) {
      var rMs = fm + FIRST_DELIVERY_WAIT_MS;
      items.push({ ms: rMs, text: '初回配信の再送（' + _crmFmt_(Math.max(rMs, now), true) + 'ごろ・見ていなければ）' });
    }
    // 初回検索が0件なら相談カード（登録7日以内・まだ1件も送っていない）
    if ((c.daysSinceSent === null || c.daysSinceSent === undefined) && !ctx.fsAsked[c.name]
        && c.daysSinceInquiry !== null && c.daysSinceInquiry <= FIRST_SEARCH_MAX_AGE_D) {
      items.push({ ms: now, text: '次の検索が0件なら相談カード' });
    }
    // 引越し時期の確認（申告した時期を過ぎたら・同じ時期には1回）
    if (typeof c.daysToMoveIn === 'number' && !ctx.moveInAsked[c.name + '|' + c.moveIn] && !w) {
      if (c.daysToMoveIn >= -MOVE_IN_MAX_OVERDUE_D) {
        var mMs = now + Math.max(c.daysToMoveIn, 0) * _DAY_MS_;
        items.push({ ms: mMs, text: '引越し時期の確認（' + _crmFmt_(mMs) + '・10〜18時）' });
      }
    }
    // 継続確認（最後に見てから30日・その30日に10件以上送っていれば・前回から30日あける）
    var baseDays = (c.daysSinceViewed !== null && c.daysSinceViewed !== undefined) ? c.daysSinceViewed : c.daysSinceInquiry;
    if (baseDays !== null && baseDays !== undefined && !w) {
      var sMs = now + Math.max(STILL_IDLE_D - baseDays, 0) * _DAY_MS_;
      if (ctx.stillLast[c.name]) sMs = Math.max(sMs, ctx.stillLast[c.name] + STILL_REASK_D * _DAY_MS_);
      items.push({ ms: sMs, text: '継続確認（' + _crmFmt_(sMs) + '以降・送った件数しだい）' });
    }
  }
  items.sort(function (a, b) { return a.ms - b.ms; });
  return items.slice(0, 2).map(function (x) { return x.text; }).join(' ／ ');
}

/**
 * その日が土日か祝日か。
 * ⚠️ 祝日は Google カレンダーから読まないこと（2026-09-30）。このスクリプトにはカレンダーの権限が無く、
 *   足すと全体の承認をやり直すことになる。公開データ（holidays-jp、権限不要）を1日1回だけ取りに行く。
 */
var _crmHolidaySet_ = null;
function _crmHolidays_() {
  if (_crmHolidaySet_) return _crmHolidaySet_;
  var cache = CacheService.getScriptCache();
  var raw = cache.get('JP_HOLIDAYS');
  if (!raw) {
    try {
      var r = UrlFetchApp.fetch('https://holidays-jp.github.io/api/v1/date.json', { muteHttpExceptions: true });
      if (r.getResponseCode() === 200) { raw = r.getContentText(); cache.put('JP_HOLIDAYS', raw, 21600); }
    } catch (e) { console.warn('[祝日] 取れません（土日だけで判定）: ' + e.message); }
  }
  try { _crmHolidaySet_ = raw ? JSON.parse(raw) : {}; } catch (_e) { _crmHolidaySet_ = {}; }
  return _crmHolidaySet_;
}
function _crmIsWeekendOrHoliday_(ms) {
  var jst = new Date(ms + 9 * 3600000);
  var d = jst.getUTCDay();
  if (d === 0 || d === 6) return true;
  var key = jst.getUTCFullYear() + '-' + ('0' + (jst.getUTCMonth() + 1)).slice(-2) + '-' + ('0' + jst.getUTCDate()).slice(-2);
  return !!_crmHolidays_()[key];
}

// ════════════════════════════════════════════
//  樹形図 第2版（2026-09-30）: 段階の横に名前を並べる
// ════════════════════════════════════════════
// ユーザーの方針:
//  - 条件登録済みは A（本気で探している＝電話・内見などで直接話して分かった）／B（返事はくれる）／C（返事なし）を本人が手で選ぶ
//  - 全員に毎日1回連絡する。今日まだ連絡していない人の名前を赤く
//  - 3日連続で無視されたら終了（LINEに来ている人）。反響だけの人は14日で終了
var CRM_STAGES = [
  { id: 'inquiry',   label: '反響',                     parent: '' },
  { id: 'mail',      label: 'メールだけ（毎日のメール中）', parent: 'inquiry' },
  { id: 'call',      label: '架電待ち',                  parent: 'inquiry' },
  { id: 'talked',    label: '話せた・LINE待ち',           parent: 'inquiry' },
  { id: 'line',      label: 'LINEに来た・条件登録待ち',    parent: '' },
  { id: 'registered',label: '条件登録済み',               parent: '' },
  { id: 'A',         label: 'A 本気で探している',         parent: 'registered' },
  { id: 'B',         label: 'B 返事はくれる',             parent: 'registered' },
  { id: 'C',         label: 'C 返事なし',                 parent: 'registered' },
  { id: 'none',      label: 'まだ分けていない',            parent: 'registered' },
  { id: 'applied',   label: '申込',                      parent: '' },
  { id: 'won',       label: '成約',                      parent: '' },
  { id: 'ended',     label: '終了',                      parent: '' }
];
var CRM_IGNORE_END_DAYS = 3;     // この日数 続けて返事が無ければ終了
var CRM_GROUP_SHEET = 'CRMグループ';

/** 顧客名 → 'A' | 'B' | 'C' */
function _crmGroups_(ss) {
  var out = {};
  var sh = ss.getSheetByName(CRM_GROUP_SHEET);
  if (!sh || sh.getLastRow() < 2) return out;
  sh.getRange(2, 1, sh.getLastRow() - 1, 2).getValues().forEach(function (r) {
    var n = String(r[0] || '').trim();
    if (n) out[n] = String(r[1] || '').trim();
  });
  return out;
}

/** 画面: グループを決める（g = 'A' | 'B' | 'C' | '' で外す）。 */
function setCrmGroup(customerName, g) {
  var ss = SpreadsheetApp.openById(CRITERIA_SHEET_ID);
  var sh = ss.getSheetByName(CRM_GROUP_SHEET);
  if (!sh) { sh = ss.insertSheet(CRM_GROUP_SHEET); sh.appendRow(['顧客名', 'グループ', '更新日時']); }
  var last = sh.getLastRow();
  if (last > 1) {
    var names = sh.getRange(2, 1, last - 1, 1).getValues();
    for (var i = 0; i < names.length; i++) {
      if (String(names[i][0] || '').trim() === customerName) {
        sh.getRange(i + 2, 2, 1, 2).setValues([[g || '', new Date()]]);
        return _crmTreeForPage_(customerName);
      }
    }
  }
  sh.appendRow([customerName, g || '', new Date()]);
  return _crmTreeForPage_(customerName);
}

/** 段階を決める。上から順に見る。 */
function _crmStageOf_(c) {
  var st = String(c.status || '').toLowerCase();
  if (c.stage === '成約') return 'won';
  if (st === 'blocked' || st === 'paused' || st === 'auto_paused' || st === 'stopped') return 'ended';
  if (c.stage === '終了' || c.archived) return 'ended';
  if (c.hasLine && c.ignoreDays >= CRM_IGNORE_END_DAYS && c.stage !== '申込') {
    c.endWhy = c.ignoreDays + '日続けて返事なし'; return 'ended';
  }
  if (c.stage === '申込') return 'applied';
  // 「内見」の段はなくした（2026-10-08）。内見の予定がある人もグループの段に並ぶ。予定はやること（タスク）で見る
  var talked = (c.daysSinceTalk !== null && c.daysSinceTalk !== undefined);
  if (c.hasCriteria) {
    return (c.group === 'A' || c.group === 'B' || c.group === 'C') ? c.group : 'none';
  }
  if (c.hasLine) {
    return (c.node === 'ended') ? 'ended' : 'line';   // 催促のあとの終了などは第1版の判定を使う
  }
  // LINEに来ていない人は反響から14日で終了（電話の枠に関係なく。2026-09-30 ユーザー決定）
  // 反響の日を1日目として14日目まで（daysSinceInquiry 0〜13）。15日目になったら終了
  if (c.daysSinceInquiry !== null && c.daysSinceInquiry >= CRM_TREE_MAIL_DAYS) {
    c.endWhy = '反響から' + c.daysSinceInquiry + '日'; return 'ended';
  }
  if (talked) return 'talked';
  return c.hasPhone ? 'call' : 'mail';
}

/** 名前の横に出す短い状態と、赤くするか。 */
function _crmChipOf_(c) {
  var flags = [];
  if (c.sig && c.sig.apply) flags.push('⚡申込・内見希望');
  if (c.sig && c.sig.reInquiry) flags.push('⚡再問い合わせ');
  if (c.sig && c.sig.strong) flags.push('⚡申込画面を開いた');
  // 💬返信待ちは出さない（2026-10-08）。LINE Chat やスマホの公式LINEから返しても、こちらからは分からず消えないため
  // 期日が来たタスクがあれば、その中身を短く出す（「約束の日」だけでは何をするか分からない）
  if (c.taskDueNow) {
    var _td = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd');
    var _due = (c.tasks || []).filter(function (t) { return t.due && t.due <= _td; }).sort(function (a, b) { return a.due < b.due ? -1 : 1; })[0];
    var _txt = _due ? String(_due.content) : '約束の日';
    flags.push('📅' + (_txt.length > 14 ? _txt.substring(0, 13) + '…' : _txt));
  }
  if (typeof c.daysToMoveIn === 'number' && c.daysToMoveIn >= 0 && c.daysToMoveIn <= CRM_TREE_MOVEIN_SOON_D) flags.push('🏠引越しまで' + c.daysToMoveIn + '日');
  if (c.hasCriteria && (c.daysSinceSent === null || c.daysSinceSent === undefined || c.daysSinceSent >= CRM_TREE_NO_SEND_DAYS)
      && c.daysSinceInquiry !== null && c.daysSinceInquiry > CRM_TREE_FIRST_WAIT_DAYS) flags.push('📭物件なし');

  var parts = [], todo = false;
  var sid = c.stageId;
  if (sid === 'ended') return { todo: false, status: c.endWhy || '', flags: [] };
  if (sid === 'won') return { todo: false, status: '', flags: [] };
  if (sid === 'mail') {
    parts.push('メール' + ((c.daysSinceInquiry || 0) + 1) + '日目');
  } else if (sid === 'call') {
    var recall = (c.tasks || []).filter(function (t) { return t.content.indexOf('かけ直し') === 0; })[0];
    if (recall) {
      // かけ直しを頼まれた人は、その日まで赤くしない。その日になったら赤
      parts.push(recall.content.replace(/[（）]/g, ' ').trim());
      todo = !!c.taskDueNow && !c.contactedToday;
    } else {
      parts.push(c.callSlots ? c.callSlots.label.replace('土日', '休日') : '');
      todo = !!(c.callSlots && c.callSlots.today) && !c.contactedToday;
    }
    parts.push('反響' + ((c.daysSinceInquiry || 0) + 1) + '日目');
  } else {
    // 次に連絡する日（タスクの日付）が先にある人は、その日まで赤くしない。その日になったら赤（連絡すれば黒）
    var _today = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd');
    var _waiting = !!(c.nextTaskDue && c.nextTaskDue > _today);
    parts.push(_waiting ? '次 ' + c.nextTaskDue.substring(5).replace('-', '/') : (c.contactedToday ? '今日 ✓' : '今日 未'));
    if (c.ignoreDays) parts.push('無視' + c.ignoreDays + '日目');
    todo = !_waiting && !c.contactedToday;
  }
  if (sid === 'viewing' && c.tasks) {
    var v = c.tasks.filter(function (t) { return t.content.indexOf('内見') >= 0; })[0];
    if (v) parts.push(v.content.replace(/^.*（/, '').replace('）', ''));
  }
  return { todo: todo, status: parts.filter(Boolean).join('・'), flags: flags };
}

/**
 * 【トリガー・毎日21時】3日続けて返事が無い人を終了にする（AG列に書き、物件の検索を止める）。
 * 画面の判定（_crmStageOf_）と同じ条件。お客様からは配信中に見えたまま（endCustomerAsSilent）。
 * 何か来れば restoreStageIfAutoEnded で戻る。
 */
function processCrmIgnoreEnd() {
  var t = getCrmTree();
  var n = 0;
  t.customers.forEach(function (c) {
    if (c.stageId !== 'ended' || !c.endWhy || c.endWhy.indexOf('返事なし') < 0) return;
    if (c.stage === '終了' || c.lineOnly) return;
    try { if (endCustomerAsSilent(c.name, c.uid, c.endWhy)) n++; } catch (e) { console.warn('[無視で終了] ' + c.name + ': ' + e.message); }
  });
  console.log('[無視で終了] ' + n + '人');
}

/** 【GASエディタで実行: CrmTree.gs】第2版の段階ごとの人数と、赤い人を出す。何も変えない。 */
function previewCrmStages() {
  var t = getCrmTree();
  var by = {};
  t.customers.forEach(function (c) { (by[c.stageId] = by[c.stageId] || []).push(c); });
  var lines = [];
  CRM_STAGES.forEach(function (s) {
    var list = by[s.id] || [];
    var red = list.filter(function (c) { return _crmChipOf_(c).todo; });
    lines.push((s.parent ? '　' : '') + s.label + '【' + list.length + '】' + (red.length ? ' 赤' + red.length + ': ' + red.map(function (c) { return c.name; }).slice(0, 15).join('、') : ''));
  });
  console.log(lines.join('\n'));
}

// ════════════════════════════════════════════
//  右側: 問い合わせた物件・メモ（2026-09-30）
// ════════════════════════════════════════════
var CRM_MEMO_SHEET = 'CRMメモ';   // スタッフだけが見るメモ。お客様には見えない

/**
 * 右側に出す「問い合わせた物件」と「メモ」を全員分まとめて読む（画面を開いた時点で持っておく）。
 * ⚠️ 名前を押してから取りに行くと、GASの往復で数秒「読み込み中」になっていた（2026-09-30）。
 */
function _crmExtrasAll_(customers) {
  var ss = SpreadsheetApp.openById(CRITERIA_SHEET_ID);
  var out = { inq: {}, memo: {} };
  var byEmail = {}, names = {};
  customers.forEach(function (c) {
    names[c.name] = true;
    if (c.email) byEmail[String(c.email).trim().toLowerCase()] = c.name;
  });
  try {
    var inq = ss.getSheetByName(INQUIRY_SHEET_NAME);
    if (inq && inq.getLastRow() > 1) {
      inq.getRange(2, 1, inq.getLastRow() - 1, 16).getValues().forEach(function (r) {
        var nm = String(r[2] || '').trim(), em = String(r[4] || '').trim().toLowerCase();
        var who = names[nm] ? nm : (em && byEmail[em]) || '';
        if (!who) return;
        (out.inq[who] = out.inq[who] || []).push({
          date: (r[0] instanceof Date) ? Utilities.formatDate(r[0], 'Asia/Tokyo', 'M/d H:mm') : String(r[0] || '').substring(0, 16),
          property: String(r[8] || ''), rent: String(r[10] || ''), layout: String(r[11] || ''),
          area: String(r[12] || ''), station: String(r[13] || ''), address: String(r[14] || ''),
          content: String(r[7] || ''), url: String(r[15] || '')
        });
      });
    }
  } catch (e) { console.warn('[右側] 問い合わせ: ' + e.message); }
  try {
    var ms = ss.getSheetByName(CRM_MEMO_SHEET);
    if (ms && ms.getLastRow() > 1) {
      ms.getRange(2, 1, ms.getLastRow() - 1, 2).getValues().forEach(function (r) {
        var n = String(r[0] || '').trim();
        if (n) out.memo[n] = String(r[1] || '');
      });
    }
  } catch (e2) { console.warn('[右側] メモ: ' + e2.message); }
  return out;
}

/**
 * 画面: 条件フォームをその場で開くためのURLを作る（右側に埋め込む）。
 * お客様が使う条件フォームと同じもの。送信すると、お客様にも条件のカードが届く（ユーザーの希望）。
 * ⚠️ 担当者が入れた印（changeSource）を付けること。付けないと「電話のお願い」が送られてしまう。
 * ⚠️ そのお客様のLINEの会話の状態を「条件を入れる途中」に上書きする。
 */
function prepareCrmCriteriaForm(customerName) {
  var uid = (typeof _getLineUserIdMapByCustomerName_ === 'function') ? (_getLineUserIdMapByCustomerName_()[customerName] || '') : '';
  if (!uid) return _prepareCrmFormNoLine_(customerName);   // LINEが無い人は顧客名で保存する
  var existing = readLatestCriteria(uid);
  var state = createInitialState();
  state.step = STEPS.CRITERIA_SELECT;
  state.changeSource = '担当者による条件変更';
  if (existing) {
    state.isChangeFlow = true;
    state.areaMethod = existing.areaMethod;
    state.selectedRoutes = existing.selectedRoutes;
    state.selectedCities = existing.selectedCities;
    state.selectedTowns = existing.selectedTowns || {};
    state.selectedStations = existing.selectedStations;
    state.data = {
      name: existing.name, reason: existing.reason, resident: existing.resident,
      move_in_date: existing.move_in_date, move_in_strict: existing.move_in_strict || false,
      rent_max: existing.rent_max, layouts: existing.layouts, walk: existing.walk, area_min: existing.area_min,
      building_age: existing.building_age, building_structures: existing.building_structures,
      equipment: existing.equipment, petType: existing.petType, carModel: existing.carModel,
      notes: existing.notes, age: existing.age
    };
  } else {
    state.isChangeFlow = false;
    state.data = { name: customerName };
  }
  saveState(uid, state);
  var sParam = (typeof _criteriaStateParam_ === 'function') ? _criteriaStateParam_(uid) : '';
  return CRITERIA_FORM_URL + '?userId=' + encodeURIComponent(uid) + (sParam ? '&s=' + sParam : '');
}

/** 画面: メモを保存する（お客様には見えない）。 */
function saveCrmMemo(customerName, text) {
  var ss = SpreadsheetApp.openById(CRITERIA_SHEET_ID);
  var sh = ss.getSheetByName(CRM_MEMO_SHEET);
  if (!sh) { sh = ss.insertSheet(CRM_MEMO_SHEET); sh.appendRow(['顧客名', 'メモ', '更新日時']); }
  var last = sh.getLastRow();
  if (last > 1) {
    var names = sh.getRange(2, 1, last - 1, 1).getValues();
    for (var i = 0; i < names.length; i++) {
      if (String(names[i][0] || '').trim() === customerName) { sh.getRange(i + 2, 2, 1, 2).setValues([[text, new Date()]]); return true; }
    }
  }
  sh.appendRow([customerName, text, new Date()]);
  return true;
}

/**
 * LINEの無いお客様の条件フォーム。お客様用のフォームを crm::トークン の一時セッションで開き、
 * 送信されたら顧客名で保存する（管理画面の登録と同じ processAdminCriteria を通す）。
 * お客様にはカードは届かない（LINEが無いため）。LINEに来たら、そのとき紐付く。
 */
function _prepareCrmFormNoLine_(customerName) {
  var c = loadCustomerCriteriaByName(customerName);
  var token = Utilities.getUuid().replace(/-/g, '').substring(0, 16);
  var userId = 'crm::' + token;
  var state = createInitialState();
  state.step = STEPS.CRITERIA_SELECT;
  state.isChangeFlow = !!c;
  state.crmName = customerName;
  state.areaMethod = (c && c.areaMethod) || 'route';
  state.selectedRoutes = (c && c.selectedRoutes) || [];
  state.selectedCities = (c && c.selectedCities) || [];
  state.selectedStations = (c && c.selectedStations) || {};
  state.selectedTowns = (c && c.selectedTowns) || {};
  state.data = c ? {
    name: customerName, rent_max: c.rent_max, layouts: c.layouts, walk: c.walk, area_min: c.area_min,
    building_age: c.building_age, building_structures: c.building_structures, equipment: c.equipment,
    petType: c.petType, carModel: c.carModel || '', notes: c.notes, move_in_date: c.move_in_date,
    move_in_strict: c.move_in_strict
  } : { name: customerName };
  saveState(userId, state);
  var sParam = (typeof _criteriaStateParam_ === 'function') ? _criteriaStateParam_(userId) : '';
  return CRITERIA_FORM_URL + '?userId=' + encodeURIComponent(userId) + (sParam ? '&s=' + sParam : '');
}

/** 条件フォームの送信（crm::）を、顧客名で保存する。 */
function _saveCrmFormNoLine_(userId, criteria) {
  var st = getState(userId);
  var name = st && st.crmName;
  if (!name) return { success: false, message: '開いてから時間がたちすぎました。顧客管理の画面から開き直してください。' };
  var mapped = {
    areaMethod: criteria.areaMethod, selectedRoutes: criteria.selectedRoutes, selectedStations: criteria.selectedStations,
    selectedCities: criteria.selectedCities, selectedTowns: criteria.selectedTowns,
    rentMax: criteria.rentMax, layouts: criteria.layouts, walkMax: criteria.walkMax, areaMin: criteria.areaMin,
    buildingAge: criteria.buildingAge, buildingStructures: criteria.buildingStructures, equipment: criteria.equipment,
    petType: criteria.petType, carModel: criteria.carModel, otherConditions: criteria.otherConditions,
    moveInDate: criteria.move_in_date || '', moveInStrict: !!criteria.move_in_strict
  };
  var r = processAdminCriteria(name, '', mapped, '');
  try { clearState(userId); } catch (_e) {}
  if (r && r.success === false) return r;
  return { success: true, message: '条件を登録しました。' };
}

// ════════════════════════════════════════════
//  右側の条件入力（2026-09-30。お客様用フォームではなく、この画面用に作った）
// ════════════════════════════════════════════

/** 検索条件シートを1回だけ読み、顧客名 → 今の条件（画面に入れる形）を作る。同名は最後の行。 */
function _crmCriteriaAll_() {
  var out = {};
  var sh = SpreadsheetApp.openById(CRITERIA_SHEET_ID).getSheetByName(CRITERIA_SHEET_NAME);
  var data = sh.getDataRange().getValues();
  var split = function (v) { return v ? String(v).split(/[,、]\s*/).filter(function (x) { return x; }) : []; };
  for (var i = 1; i < data.length; i++) {
    var r = data[i];
    var name = String(r[1] || '').trim();
    if (!name) continue;
    // 路線(駅, 駅), 路線2(駅) の形をほどく
    var routes = {}, raw = String(r[4] || ''), depth = 0, cur = '', parts = [];
    for (var k = 0; k < raw.length; k++) {
      var ch = raw[k];
      if (ch === '(') depth++;
      if (ch === ')') depth--;
      if (ch === ',' && depth === 0) { parts.push(cur.trim()); cur = ''; } else cur += ch;
    }
    if (cur.trim()) parts.push(cur.trim());
    parts.forEach(function (pt) {
      var m = pt.match(/^(.*?)\((.*)\)$/);
      var rn = m ? m[1].trim() : pt.trim();
      var stas = m ? split(m[2]) : [];
      try { if (typeof _resolveRouteName_ === 'function') rn = _resolveRouteName_(rn, stas) || rn; } catch (_e) {}
      if (rn) routes[rn] = stas;
    });
    var towns = {};
    try { towns = r[24] ? JSON.parse(String(r[24])) : {}; } catch (_e2) {}
    var rent = String(r[7] || '').replace('万円', '');
    out[name] = {
      areaMethod: Object.keys(routes).length ? 'route' : (split(r[3]).length ? 'city' : 'route'),
      routes: routes, cities: split(r[3]), towns: towns,
      rentMax: rent, layouts: split(r[8]),
      walk: String(r[6] || ''), areaMin: String(r[9] || ''), age: String(r[10] || ''),
      structures: split(r[11]), equipment: split(r[12]),
      moveIn: (r[14] instanceof Date) ? Utilities.formatDate(r[14], 'Asia/Tokyo', 'yyyy/MM/dd') : String(r[14] || ''),
      moveInStrict: String(r[26] || '').toLowerCase() === 'true',
      notes: String(r[15] || ''), petType: String(r[16] || ''), carModel: String(r[39] || ''),
      has: !!(Object.keys(routes).length || split(r[3]).length || r[7] || split(r[8]).length)
    };
  }
  return out;
}

/**
 * 画面: 条件を保存する。担当者の登録として保存し（電話のお願いは送らない）、
 * send=true で LINE がつながっていれば、お客様に条件のカードも送る（初めてなら登録、あれば変更として）。
 */
function saveCrmCriteria(customerName, f, send) {
  var hadBefore = !!loadCustomerCriteriaByName(customerName) && !!(_crmCriteriaAll_()[customerName] || {}).has;
  var selectedRoutes = [], selectedStations = {};
  Object.keys(f.routes || {}).forEach(function (rn) { selectedRoutes.push(rn); selectedStations[rn] = f.routes[rn] || []; });
  var criteria = {
    areaMethod: f.areaMethod || 'route',
    selectedRoutes: f.areaMethod === 'city' ? [] : selectedRoutes,
    selectedStations: f.areaMethod === 'city' ? {} : selectedStations,
    selectedCities: f.areaMethod === 'city' ? (f.cities || []) : [],
    // 町名を選んでいない市区は全域（空の配列は持たない）
    selectedTowns: f.areaMethod === 'city' ? (function (t) {
      var o = {}; Object.keys(t || {}).forEach(function (k) { if ((t[k] || []).length && (f.cities || []).indexOf(k) >= 0) o[k] = t[k]; }); return o;
    })(f.towns) : {},
    rentMax: f.rentMax ? String(f.rentMax).replace(/万円$/, '') + '万円' : '',
    layouts: f.layouts || [], walkMax: f.walk || '', areaMin: f.areaMin || '', buildingAge: f.age || '',
    buildingStructures: f.structures || [], equipment: f.equipment || [],
    petType: f.petType || '', carModel: f.carModel || '', otherConditions: f.notes || '',
    moveInDate: f.moveIn || '', moveInStrict: !!f.moveInStrict
  };
  var uid = (_getLineUserIdMapByCustomerName_()[customerName]) || '';
  var r = processAdminCriteria(customerName, uid, criteria, '');
  if (!r || r.success === false) throw new Error((r && r.message) || '保存できませんでした');
  var sentMsg = '';
  if (send && uid) {
    var sr = sendConditionSummaryToLine(customerName, hadBefore ? 'changed' : 'new');
    sentMsg = (sr && sr.success) ? '（お客様にLINEで送りました）' : '（LINEで送れませんでした: ' + ((sr && sr.message) || '') + '）';
  }
  addContactLog(customerName, 'その他', new Date().toISOString(), '条件を' + (hadBefore ? '変更' : '登録') + sentMsg);
  var page = _crmTreeForPage_(customerName);
  page.savedMessage = '条件を保存しました' + sentMsg;
  return page;
}

/**
 * 画面: 電話で話せたときの記録。メモと結果をまとめて残す（2026-10-02）。
 * outcome: 'continue'（続けて探す）| 'recall'（かけ直し: when='yyyy-MM-ddTHH:mm'）| 'end'（終了: reason）
 */
function recordCrmTalk(customerName, memo, outcome, when, reason) {
  memo = String(memo || '').trim();
  var tag = outcome === 'end' ? '【終了】' : '';
  // かけ直しは「話せた」に数えない（架電待ちのまま、かけ直す日に赤くする）
  var r = addContactLog(customerName, outcome === 'recall' ? '電話（かけ直し）' : '電話（話せた）', new Date().toISOString(), tag + memo);
  if (!r || !r.success) throw new Error((r && r.message) || '記録できませんでした');
  _crmTreeCloseDueTasks_(customerName);
  if (outcome === 'recall') {
    // 時刻は任意（2026-10-02）。'yyyy-MM-dd' だけなら日付だけで予定に入れる
    var hasTime = String(when || '').indexOf('T') >= 0;
    var d = new Date(String(when || '').replace('T', ' ').replace(/-/g, '/'));
    if (isNaN(d.getTime())) throw new Error('かけ直す日を選んでください');
    var label = Utilities.formatDate(d, 'Asia/Tokyo', hasTime ? 'M/d H:mm' : 'M/d');
    addCustomerTask(customerName, 'かけ直し（' + label + '）', Utilities.formatDate(d, 'Asia/Tokyo', 'yyyy-MM-dd'), TASK_OWNER_DEFAULT);
  }
  if (outcome === 'end') return setCrmStage(customerName, '終了', reason || 'その他');
  return _crmTreeForPage_(customerName);
}

// ════════════════════════════════════════════
//  お客様を手で追加する（電話の反響・リピーター・その他）2026-10-02
// ════════════════════════════════════════════

/**
 * 掲載中の物件の名前（「建物名 部屋番号」）。掲載物件管理ページと同じ書き方。
 * ⚠️ 電話の反響はこの中から選ばせること。物件ごとの問い合わせ数は、問い合わせシートの物件名と
 *   この名前を突き合わせて数えている（ListingDashboard.html）。自由入力だとずれて数えられない。
 */
function _crmActiveListings_() {
  var out = [];
  try {
    var sh = getListingSheet_();
    if (sh.getLastRow() < 2) return out;
    sh.getRange(2, 1, sh.getLastRow() - 1, 9).getValues().forEach(function (r) {
      if (String(r[8]) !== 'active') return;
      var label = String(r[1] || '') + (r[2] ? ' ' + String(r[2]) : '');
      if (label.trim() && out.indexOf(label) < 0) out.push(label);
    });
  } catch (e) { console.warn('[お客様を追加] 掲載中の物件: ' + e.message); }
  return out.sort();
}

/**
 * 画面: お客様を追加する／昔のお客様を戻す。
 * f = { name, phone, email, route: 'phone'|'repeat'|'other', property, talked, memo, reviveName }
 *  - 電話の反響は掲載中の物件が必須。掲載物件管理の「＋ 追加」と同じ addManualInquiry を通す（問い合わせ数とそろえる）
 *  - reviveName があれば、その顧客を終了から戻し、反響の日を今日にする（14日の数え直し）
 */
function addCrmCustomer(f) {
  var name = String(f.reviveName || f.name || '').trim();
  if (!name) throw new Error('名前を入れてください');
  var phone = String(f.phone || '').replace(/[^0-9-]/g, '');
  var email = String(f.email || '').trim();
  var memo = String(f.memo || '').trim();
  if (f.route === 'phone' && !f.property) throw new Error('電話の反響は、問い合わせの物件を選んでください');

  var ss = SpreadsheetApp.openById(CRITERIA_SHEET_ID);
  var sh = ss.getSheetByName(CRITERIA_SHEET_NAME);

  // 問い合わせの記録（物件があれば問い合わせシートにも。掲載物件の問い合わせ数に入る）
  if (f.property) {
    var r = addManualInquiry(f.property, name, phone, memo);
    if (!r || !r.success) throw new Error((r && r.message) || '問い合わせを追加できませんでした');
  }

  // 顧客の行（無ければ作る。addManualInquiry が作っていればそれを使う）
  var data = sh.getDataRange().getValues();
  var row = -1;
  for (var i = 1; i < data.length; i++) if (String(data[i][1] || '').trim() === name) row = i + 1;
  if (row < 0) {
    var nr = [];
    for (var c = 0; c < 19; c++) nr.push('');
    nr[0] = new Date(); nr[1] = name; nr[18] = 'lead';
    sh.appendRow(nr);
    row = sh.getLastRow();
  } else {
    // 戻す: 終了・アーカイブを外し、反響の日を今日にする
    var cur = data[row - 1];
    if (String(cur[32] || '').trim() === '終了') sh.getRange(row, 33).setValue('');
    sh.getRange(row, 20).setValue(''); sh.getRange(row, 21).setValue(''); sh.getRange(row, 45).setValue('');
    if (!(typeof _rowHasCriteria_ === 'function' && _rowHasCriteria_(cur))) sh.getRange(row, 1).setValue(new Date());
    var st = String(cur[18] || '').trim().toLowerCase();
    if (st === 'paused' || st === 'auto_paused') sh.getRange(row, 19).setValue('active');
  }
  if (email) sh.getRange(row, 32).setValue(email);                              // AF列
  if (phone) sh.getRange(row, 35).setNumberFormat('@').setValue(phone);          // AI列（先頭の0を落とさない）

  var label = f.route === 'phone' ? '電話反響' : (f.route === 'repeat' ? 'リピーター反響' : 'その他反響');
  if (!f.property) addContactLog(name, label, new Date().toISOString(), memo);
  if (f.talked) addContactLog(name, '電話（話せた）', new Date().toISOString(), memo);
  if (memo) saveCrmMemo(name, memo);

  var page = _crmTreeForPage_();
  page.savedMessage = (f.reviveName ? name + ' さんを戻しました' : name + ' さんを追加しました');
  page.newName = name;
  return page;
}

// ════════════════════════════════════════════
//  LINE とつなぐ（2026-10-02）
// ════════════════════════════════════════════
// LINE の友だちだが LINE Users に名前が無い人（LINE Activity にだけいる人、〔LINEのみ〕）を、
// 顧客管理の画面から顧客とつなぐ。書き込みは登録と同じ saveLineUser（LINE Users に1行）。

/** 画面: つなげる候補の LINE アカウント（LINE Activity）。最近やり取りした順。 */
function getCrmLineCandidates() {
  var ss = SpreadsheetApp.openById(CRITERIA_SHEET_ID);
  var linked = {};
  var lu = ss.getSheetByName(LINE_USERS_SHEET_NAME);
  if (lu && lu.getLastRow() > 1) {
    lu.getRange(2, 1, lu.getLastRow() - 1, 4).getValues().forEach(function (r) {
      var uid = String(r[0] || '').trim();
      if (uid) linked[uid] = { name: String(r[1] || '').trim(), disp: String(r[3] || '').trim() };
    });
  }
  var out = {}, sh = ss.getSheetByName('LINE Activity');
  if (sh && sh.getLastRow() > 1) {
    sh.getRange(2, 1, sh.getLastRow() - 1, 3).getValues().forEach(function (r) {
      var uid = String(r[0] || '').trim();
      if (!uid || uid.indexOf('U') !== 0) return;
      var ms = _cellToEpochMs_(r[1]);
      if (out[uid] && out[uid].ms >= ms) return;
      out[uid] = { uid: uid, disp: String(r[2] || '').trim() || (linked[uid] && linked[uid].disp) || '（表示名なし）',
        ms: ms, last: ms ? Utilities.formatDate(new Date(ms), 'Asia/Tokyo', 'yyyy/M/d') : '',
        linkedName: linked[uid] ? linked[uid].name : '' };
    });
  }
  return Object.keys(out).map(function (k) { return out[k]; }).sort(function (a, b) { return b.ms - a.ms; });
}

/**
 * 画面: 顧客と LINE アカウントをつなぐ。
 * ⚠️ そのLINEがすでに別の顧客につながっていたら、force=true のときだけ付け替える。
 */
function linkCrmLine(customerName, uid, force) {
  customerName = String(customerName || '').trim();
  uid = String(uid || '').trim();
  if (!customerName || uid.indexOf('U') !== 0) throw new Error('つなぐ相手が正しくありません');
  var lu = SpreadsheetApp.openById(CRITERIA_SHEET_ID).getSheetByName(LINE_USERS_SHEET_NAME);
  if (lu && lu.getLastRow() > 1) {
    var rows = lu.getRange(2, 1, lu.getLastRow() - 1, 2).getValues();
    for (var i = 0; i < rows.length; i++) {
      var other = String(rows[i][1] || '').trim();
      if (String(rows[i][0]).trim() === uid && other && other !== customerName && !force) {
        throw new Error('このLINEは「' + other + '」さんにつながっています。付け替える場合はもう一度押してください');
      }
    }
  }
  saveLineUser(uid, customerName);
  try { if (loadCustomerCriteriaByName(customerName) && typeof linkRichMenuAfter === 'function') linkRichMenuAfter(uid); } catch (_e) {}
  addContactLog(customerName, 'その他', new Date().toISOString(), 'LINEとつないだ');
  var page = _crmTreeForPage_();
  page.savedMessage = customerName + ' さんをLINEとつなぎました';
  page.newName = customerName;
  return page;
}

// ════════════════════════════════════════════
//  家族のLINE（親子）2026-10-02
// ════════════════════════════════════════════
// 夫婦・カップルなど、同じお部屋を一緒に探す家族のLINEを、親の顧客にもう1つつなぐ。
//  - 条件は親の1つを共有する。顧客管理から送る物件と一言は、親と家族の両方に届く
//  - 家族から来た文は、親の「返信待ち」に出る
//  - ⚠️ 家族は LINE Users に入れないこと。入れると「名前→LINE」の引き当てが家族に向き、
//    継続確認・引越し時期の確認などボットの自動の案内まで家族に届いてしまう。別シートに控える
var CRM_FAMILY_SHEET = 'LINE家族';

function _crmFamily_(ss) {
  var out = { byUid: {}, byName: {} };
  try {
    var sh = (ss || SpreadsheetApp.openById(CRITERIA_SHEET_ID)).getSheetByName(CRM_FAMILY_SHEET);
    if (!sh || sh.getLastRow() < 2) return out;
    sh.getRange(2, 1, sh.getLastRow() - 1, 3).getValues().forEach(function (r) {
      var uid = String(r[0] || '').trim(), name = String(r[1] || '').trim();
      if (!uid || !name) return;
      out.byUid[uid] = name;
      (out.byName[name] = out.byName[name] || []).push({ uid: uid, disp: String(r[2] || '').trim() });
    });
  } catch (e) { console.warn('[家族のLINE] ' + e.message); }
  return out;
}

/** 顧客名 → 家族のLINEの userId の配列（送るときに使う）。 */
function _crmFamilyUids_(name) {
  return (_crmFamily_().byName[name] || []).map(function (f) { return f.uid; });
}

/** 画面: 〔LINEのみ〕の人を、親の顧客の家族としてつなぐ。〔LINEのみ〕のときの記録・メモは親に引き継ぐ。 */
function linkCrmFamily(parentName, uid, pseudoName) {
  parentName = String(parentName || '').trim();
  uid = String(uid || '').trim();
  if (!parentName || uid.indexOf('U') !== 0) throw new Error('つなぐ相手が正しくありません');
  var ss = SpreadsheetApp.openById(CRITERIA_SHEET_ID);
  var sh = ss.getSheetByName(CRM_FAMILY_SHEET);
  if (!sh) { sh = ss.insertSheet(CRM_FAMILY_SHEET); sh.appendRow(['LINE userId', '親の顧客名', 'LINEの表示名', 'つないだ日時']); }
  if (sh.getLastRow() > 1 && sh.getRange(2, 1, sh.getLastRow() - 1, 1).getValues().some(function (r) { return String(r[0]).trim() === uid; })) {
    throw new Error('このLINEはもう家族としてつながっています');
  }
  var disp = '';
  try { var pf = getLineProfile(uid); disp = (pf && pf.displayName) || ''; } catch (_e) {}
  if (!disp) disp = String(pseudoName || '').replace('〔LINEのみ〕', '');
  sh.appendRow([uid, parentName, disp, new Date()]);
  if (pseudoName) _crmRenameAux_(pseudoName, parentName);
  addContactLog(parentName, 'その他', new Date().toISOString(), '家族のLINE（' + disp + '）をつないだ');
  var page = _crmTreeForPage_();
  page.savedMessage = disp + ' さんを ' + parentName + ' さんの家族としてつなぎました';
  page.newName = parentName;
  return page;
}

/** 画面: 家族のLINEを外す。 */
function unlinkCrmFamily(uid) {
  var sh = SpreadsheetApp.openById(CRITERIA_SHEET_ID).getSheetByName(CRM_FAMILY_SHEET);
  if (sh && sh.getLastRow() > 1) {
    var v = sh.getRange(2, 1, sh.getLastRow() - 1, 1).getValues();
    for (var i = v.length - 1; i >= 0; i--) if (String(v[i][0]).trim() === String(uid)) sh.deleteRow(i + 2);
  }
  return _crmTreeForPage_();
}

// ════════════════════════════════════════════
//  名前を付ける・名前を変える（2026-10-02）
// ════════════════════════════════════════════
// renameCustomer（コード.js）が書き換えない、顧客管理まわりのシートの名前も書き換える。
var _CRM_NAME_SHEETS_ = ['対応ログ', 'タスク', 'CRMメモ', 'CRMグループ', '電話のお願い', '継続確認', '引越し時期の確認', '初回配信フォロー', '初回検索の確認', 'LINE家族'];
function _crmRenameAux_(oldName, newName) {
  var ss = SpreadsheetApp.openById(CRITERIA_SHEET_ID);
  _CRM_NAME_SHEETS_.forEach(function (sheetName) {
    try {
      var sh = ss.getSheetByName(sheetName);
      if (!sh || sh.getLastRow() < 2) return;
      var col = (sheetName === 'LINE家族') ? 2 : 1;
      var rng = sh.getRange(2, col, sh.getLastRow() - 1, 1);
      var v = rng.getValues(), hit = false;
      for (var i = 0; i < v.length; i++) if (String(v[i][0] || '').trim() === oldName) { v[i][0] = newName; hit = true; }
      if (hit) rng.setValues(v);
    } catch (e) { console.warn('[名前の書き換え] ' + sheetName + ': ' + e.message); }
  });
  // Discord の顧客スレッドも引き継ぐ（顧客名で引いているため、引き継がないと別スレッドができる）
  try {
    var pp = PropertiesService.getScriptProperties();
    var th = pp.getProperty('DISCORD_THREAD_' + oldName);
    if (th && !pp.getProperty('DISCORD_THREAD_' + newName)) pp.setProperty('DISCORD_THREAD_' + newName, th);
  } catch (_e) {}
}

/** 画面: 顧客の名前を変える。 */
function renameCrmCustomer(oldName, newName) {
  newName = String(newName || '').trim();
  if (!newName || newName === oldName) throw new Error('新しい名前を入れてください');
  var r = renameCustomer(oldName, newName);
  if (!r || r.success === false) throw new Error((r && r.message) || '名前を変えられませんでした');
  _crmRenameAux_(oldName, newName);
  var page = _crmTreeForPage_();
  page.savedMessage = '「' + oldName + '」を「' + newName + '」に変えました';
  page.newName = newName;
  return page;
}

/** 画面: 〔LINEのみ〕の人に名前を付けて顧客にする（LINE ともつなぐ）。同じ名前の顧客がいればそこにつなぐ。 */
function nameCrmLineOnly(pseudoName, uid, newName) {
  newName = String(newName || '').trim();
  if (!newName) throw new Error('名前を入れてください');
  if (String(uid || '').indexOf('U') !== 0) throw new Error('LINEのIDが分かりません');
  var sh = SpreadsheetApp.openById(CRITERIA_SHEET_ID).getSheetByName(CRITERIA_SHEET_NAME);
  var exists = sh.getRange(2, 2, Math.max(sh.getLastRow() - 1, 1), 1).getValues().some(function (r) { return String(r[0] || '').trim() === newName; });
  if (!exists) {
    var nr = []; for (var c = 0; c < 19; c++) nr.push('');
    nr[0] = new Date(); nr[1] = newName; nr[18] = 'lead';
    sh.appendRow(nr);
  }
  saveLineUser(uid, newName);
  _crmRenameAux_(pseudoName, newName);   // 〔LINEのみ〕のときに付けた記録・メモを引き継ぐ
  var page = _crmTreeForPage_();
  page.savedMessage = newName + ' さんとして登録しました（LINEもつなぎました）';
  page.newName = newName;
  return page;
}
