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
  { id: 'strongSignal', label: '強い合図（電話する）',         parent: '', mine: true, urgent: true },
  { id: 'replyLine',    label: 'LINEに返信',                   parent: '', mine: true, urgent: true },
  { id: 'taskDue',      label: '約束の日（次の連絡・内見）',     parent: '', mine: true, urgent: true },
  { id: 'inquiry',      label: '反響',                         parent: '' },
  { id: 'mailOnly',     label: 'メールだけ（自動メール）',       parent: 'inquiry' },
  { id: 'callQueue',    label: '架電待ち（今日かける）',          parent: 'inquiry', mine: true },
  { id: 'callWait',     label: '架電待ち（今日はかけない）',       parent: 'inquiry' },
  { id: 'line',         label: 'LINEに来た',                    parent: 'inquiry' },
  { id: 'noCriteria',   label: '条件登録待ち（自動で催促）',     parent: 'line' },
  { id: 'registered',   label: '条件登録済み',                  parent: 'line' },
  { id: 'firstWait',    label: '初回配信まだ（0件）',            parent: 'registered' },
  { id: 'following',    label: '追客中',                        parent: 'registered' },
  { id: 'neverViewed',  label: '1件も見ていない（自動で再送）',   parent: 'following' },
  { id: 'noSend14',     label: '物件を送れていない（条件を見直す）',         parent: 'following', mine: true },
  { id: 'pausedNotEnd', label: '配信停止なのに終了でない',        parent: 'following', mine: true },
  { id: 'viewing',      label: '内見の予定あり',                  parent: 'following' },
  { id: 'waitNext',     label: '次の連絡を待つ（日付を決めた）',   parent: 'following' },
  { id: 'applied',      label: '申込',                          parent: 'following' },
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
// 3枠ともつながらなければ、サヨナラのメールを1通送って終了（ユーザー決定 2026-09-28）。
// ⚠️ 回数や日数では切らない。忙しくて連続でかけられない日があっても枠が埋まるまで待つ。
var CRM_TREE_MAIL_DAYS = 14;        // メールだけの人は、反響からこの日数でLINEに来なければ終了
var CRM_TREE_NUDGE_FALLBACK_D = 7;  // 催促の記録が無い登録待ちの人は、反響からこの日数で終了
var CRM_TREE_NUDGE_WAIT_H = 24;     // 催促のあと、この時間 何も無ければ終了
var CRM_TREE_FIRST_WAIT_DAYS = 7;   // 登録からこの日数 1件も送れていなければ「送れていない」へ
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
  var ss = SpreadsheetApp.openById(CRITERIA_SHEET_ID);
  var sh = ss.getSheetByName(CRM_TREE_REPLY_SHEET);
  if (!sh) {
    sh = ss.insertSheet(CRM_TREE_REPLY_SHEET);
    sh.appendRow(['userId', '受信日時', '本文']);
  }
  sh.appendRow([userId, new Date(), String(text || '').substring(0, 200)]);
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
  if (c.sig.strong) return 'strongSignal';
  if (c.sig.reply) return 'replyLine';

  if (c.stage === '終了' || c.archived) return 'ended';
  if (c.taskDueNow) return 'taskDue';
  if (c.stage === '申込') return 'applied';
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
      if (c.callSlots.done) { c.endWhy = '架電3枠つながらず'; return 'ended'; }
      return c.callSlots.today ? 'callQueue' : 'callWait';
    }
    // 電話で話せた／条件がある（メールで配信中）人は下の追客中の判定へ
  } else if (!c.hasCriteria) {
    if (c.nudgedMs && Date.now() - c.nudgedMs > CRM_TREE_NUDGE_WAIT_H * 3600000
        && !(c.lineMs > c.nudgedMs)) {
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
  if (!c.hasCriteria) return 'lost';   // LINEなし・話せた・条件なし

  if (st === 'paused' || st === 'auto_paused' || st === 'stopped' || st === 'snoozed') return 'pausedNotEnd';
  if (c.daysSinceSent === null || c.daysSinceSent === undefined) {
    // 登録から7日たっても1件も送れていない＝条件が厳しい。人が見直す
    return (c.daysSinceInquiry !== null && c.daysSinceInquiry > CRM_TREE_FIRST_WAIT_DAYS) ? 'noSend14' : 'firstWait';
  }
  if (c.daysSinceSent >= CRM_TREE_NO_SEND_DAYS) return 'noSend14';
  if (c.daysSinceViewed === null || c.daysSinceViewed === undefined) return 'neverViewed';
  return 'following';
}

/** 対応ログ: 顧客名 → { failed: つながらなかった回数, failedMs: その時刻の配列, lastMs: 最後に何か記録した時刻 } */
function _crmTreeContactLog_(ss) {
  var out = {};
  try {
    var sh = ss.getSheetByName(CONTACT_LOG_SHEET_NAME);
    if (!sh || sh.getLastRow() < 2) return out;
    var rows = sh.getRange(2, 1, sh.getLastRow() - 1, 4).getValues();
    for (var i = 0; i < rows.length; i++) {
      var name = String(rows[i][0] || '').trim();
      if (!name) continue;
      var r = out[name] || (out[name] = { failed: 0, failedMs: [], lastMs: 0 });
      var ms = _cellToEpochMs_(rows[i][1]);
      if (_contactLogOutcome_(rows[i][2], rows[i][3]) === 'failed') { r.failed++; if (ms) r.failedMs.push(ms); }
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
  var isWeekend = function (m) { var d = new Date(m + 9 * 3600000).getUTCDay(); return d === 0 || d === 6; };
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
function _crmTreeSignals_(acts, handledMs, replyMs) {
  var sig = { apply: 0, strong: 0, reply: 0, note: '' };
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
    if (a.act === 'view' && a.ms >= since) {
      if (!viewsByRoom[a.room]) { viewsByRoom[a.room] = 0; rooms++; }
      viewsByRoom[a.room]++;
      if (viewsByRoom[a.room] >= CRM_TREE_VIEW_REPEAT || rooms >= CRM_TREE_VIEW_ROOMS) {
        sig.strong = Math.max(sig.strong, a.ms);
        if (!sig.note) sig.note = (rooms >= CRM_TREE_VIEW_ROOMS)
          ? rooms + '件の物件を開いた' : '同じ物件を' + viewsByRoom[a.room] + '回開いた';
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

  // LINEに来たが、名前がまだ無い人（条件登録も空室確認もしていない）。
  // 検索条件シートに行が無いので、友だち追加の記録から足す。控えた時刻より後に来た人だけ。
  Object.keys(friends).forEach(function (uid) {
    var f = friends[uid];
    if (knownUid[uid] || !f.addedMs || f.addedMs < old.frozenMs) return;
    customers.push({
      name: (f.displayName || '（名前なし）') + '〔LINEのみ〕', lineOnly: true, uid: uid,
      status: '', stage: '', hasLine: true, hasPhone: false, hasCriteria: false,
      daysSinceTalk: null, daysSinceSent: null, daysSinceViewed: null, registeredAt: ''
    });
  });

  var names = {};
  customers.forEach(function (c) { names[c.name] = true; });
  var log = _crmTreeContactLog_(ss);
  var acts = _crmTreeActions_(ss, names);
  var replyByUid = _crmTreeReplyByUid_(ss);
  var lineMsByUid = _crmTreeLineMsByUid_(ss);
  var todayIdx = _jstDayIndex_(Date.now());
  var tasks = _crmTreeOpenTasks_(ss);
  var todayStr = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd');

  var count = {};
  customers.forEach(function (c) {
    var uid = c.uid || uidByName[c.name] || '';
    c.uid = uid;
    var cl = log[c.name] || { failed: 0, failedMs: [], lastMs: 0 };
    c.failedCalls = cl.failed;
    c.callSlots = _crmTreeCallSlots_(cl.failedMs);
    c.lineMs = uid ? (lineMsByUid[uid] || 0) : 0;
    c.nudgedMs = (uid && friends[uid]) ? friends[uid].nudgedMs : 0;
    var regMs = c.registeredAt ? new Date(c.registeredAt).getTime() : 0;
    c.daysSinceInquiry = regMs ? (todayIdx - _jstDayIndex_(regMs)) : null;
    c.sig = _crmTreeSignals_(acts[c.name], cl.lastMs, uid ? (replyByUid[uid] || 0) : 0);
    var ts = tasks[c.name] || [];
    c.tasks = ts;
    c.taskDueNow = ts.some(function (t) { return t.due && t.due <= todayStr; });
    c.hasViewingTask = ts.some(function (t) { return t.content.indexOf('内見') >= 0; });
    c.nextTaskDue = ts.filter(function (t) { return t.due; }).map(function (t) { return t.due; }).sort()[0] || '';
    c.node = _crmTreeNodeOf_(c);
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
function _crmTreeForPage_() {
  var t = getCrmTree();
  return {
    nodes: t.nodes,
    oldCount: t.oldCount,
    customers: t.customers.map(function (c) {
      return {
        name: c.name, node: c.node, lineOnly: !!c.lineOnly,
        phone: c.phone || '', hasLine: !!c.hasLine, hasCriteria: !!c.hasCriteria,
        daysSinceInquiry: c.daysSinceInquiry, failedCalls: c.failedCalls || 0,
        callSlots: (c.callSlots && c.callSlots.first !== undefined) ? c.callSlots.label : '',
        email: c.email || '',
        daysSinceSent: c.daysSinceSent, daysSinceViewed: c.daysSinceViewed,
        lastTalkAt: c.lastTalkAt || '', moveIn: c.moveIn || '',
        note: (c.sig && c.sig.note) || '', endWhy: c.endWhy || '', stage: c.stage || '',
        tasks: (c.tasks || []).map(function (t) { return t.content + (t.due ? '（' + t.due.substring(5).replace('-', '/') + '）' : ''); })
      };
    })
  };
}

/** 画面の再読み込み用（google.script.run）。 */
function getCrmTreeForPage() {
  return _crmTreeForPage_();
}

/** 画面の1タップ記録（google.script.run）。対応ログに1行足して、樹形図を返す。 */
function recordCrmTreeContact(customerName, type) {
  var r = addContactLog(customerName, type, new Date().toISOString(), '');
  if (!r || !r.success) throw new Error((r && r.message) || '記録できませんでした');
  _crmTreeCloseDueTasks_(customerName);
  // 3枠目のつながらずなら、その場でサヨナラのメールを送って終了にする
  if (String(type).indexOf('つながらず') >= 0) {
    try { _crmTreeMaybeGoodbye_(customerName); } catch (e) { console.warn('[架電] サヨナラ: ' + e.message); }
  }
  return _crmTreeForPage_();
}

// ════════════════════════════════════════════
//  架電3枠つながらず → サヨナラのメール → 終了
// ════════════════════════════════════════════
// ⚠️ 終了にする前には必ず1通送る（ユーザー決定）。相手はLINEに来ていない人なのでメール。
//   メールアドレスが無ければ送れないので、そのまま終了にする（電話しか無い人）。
// ⚠️ 送るのは「架電3枠が埋まった瞬間」（📵 を押した直後）。トリガーは使わない。
var CRM_GOODBYE_SUBJECT = 'お問い合わせの件（合同会社えほうまき）';
var CRM_GOODBYE_SENDER = '合同会社えほうまき';
var LINE_ADD_FRIEND_URL = 'https://lin.ee/XLsSg6L';   // 公式アカウントの友だち追加

var CRM_MAIL_SIGNATURE = [
  '****************************************************',
  '合同会社えほうまき',
  '',
  '西村',
  '',
  'Tel:045-900-3912',
  'mobile:090-6503-6161',
  'e-mail:',
  'support@ehomaki.com',
  '',
  '****************************************************'
];

/** サヨナラのメール。text と html の両方を返す（HTMLが出ないメールソフト向けに text も持つ）。 */
function _crmGoodbyeMail_(customerName) {
  var dear = String(customerName || '').trim() + ' 様';
  var text = dear + '\n\n'
    + 'お問い合わせいただきありがとうございます。\n'
    + '何度かお電話しましたが、つながらなかったため、メールでご連絡しました。\n\n'
    + 'お部屋探しを続けていらっしゃいましたら、LINEでご希望をお伺いします。\n'
    + LINE_ADD_FRIEND_URL + '\n\n'
    + CRM_MAIL_SIGNATURE.join('\n');
  var esc = function (t) { return String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); };
  var html = '<div style="font-family:-apple-system,BlinkMacSystemFont,\'Hiragino Sans\',\'Noto Sans JP\',sans-serif;font-size:15px;line-height:1.9;color:#222;max-width:560px">'
    + '<p style="margin:0 0 16px">' + esc(dear) + '</p>'
    + '<p style="margin:0 0 16px">お問い合わせいただきありがとうございます。<br>'
    + '何度かお電話しましたが、つながらなかったため、メールでご連絡しました。</p>'
    + '<p style="margin:0 0 20px">お部屋探しを続けていらっしゃいましたら、LINEでご希望をお伺いします。</p>'
    + '<p style="margin:0 0 8px"><a href="' + LINE_ADD_FRIEND_URL + '" style="display:inline-block;background:#06c755;color:#fff;text-decoration:none;font-weight:bold;padding:12px 28px;border-radius:6px">LINEで相談する</a></p>'
    + '<p style="margin:0 0 28px;font-size:12px;color:#888">ボタンが開かない場合: <a href="' + LINE_ADD_FRIEND_URL + '" style="color:#888">' + esc(LINE_ADD_FRIEND_URL) + '</a></p>'
    + '<pre style="margin:0;font-family:inherit;font-size:13px;line-height:1.7;color:#555;white-space:pre-wrap">' + esc(CRM_MAIL_SIGNATURE.join('\n')) + '</pre>'
    + '</div>';
  return { text: text, html: html };
}

/** 架電3枠が埋まっていればサヨナラのメールを送って終了にする。 */
function _crmTreeMaybeGoodbye_(customerName) {
  var t = getCrmTree();
  var c = t.customers.filter(function (x) { return x.name === customerName; })[0];
  if (!c || !c.callSlots || !c.callSlots.done) return false;
  if (c.hasLine || (c.daysSinceTalk !== null && c.daysSinceTalk !== undefined)) return false;
  if (c.stage === '終了') return false;
  var sent = false;
  if (c.email) {
    var m = _crmGoodbyeMail_(customerName);
    GmailApp.sendEmail(c.email, CRM_GOODBYE_SUBJECT, m.text, { htmlBody: m.html, name: CRM_GOODBYE_SENDER });
    sent = true;
  }
  addContactLog(customerName, 'その他', new Date().toISOString(),
    sent ? 'サヨナラのメールを送信（架電3枠つながらず）' : '架電3枠つながらず（メールアドレス無し）');
  endCustomerAsSilent(customerName, '', '架電3枠つながらず');
  console.log('[架電] ' + customerName + ' を終了にしました（メール' + (sent ? '送信' : '無し') + '）');
  return true;
}

/** 【GASエディタで実行: CrmTree.gs】サヨナラのメールを自分宛てに送って見た目を確かめる。 */
function testSendGoodbyeMail() {
  var me = Session.getActiveUser().getEmail();
  var m = _crmGoodbyeMail_('西村');
  GmailApp.sendEmail(me, CRM_GOODBYE_SUBJECT, m.text, { htmlBody: m.html, name: CRM_GOODBYE_SENDER });
  console.log(me + ' に送りました');
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
  tpl.adminUrl = _jsonForInlineScript_(getAdminPageUrl(''));
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
    var r = addCustomerTask(customerName, CRM_NEXT_TASK, _crmDateAfter_(days), TASK_OWNER_DEFAULT);
    if (!r || !r.success) throw new Error((r && r.message) || '次の連絡日を保存できませんでした');
  }
  return _crmTreeForPage_();
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
  return _crmTreeForPage_();
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
    if (stage === '終了') sh.getRange(row, 20).setValue('終了: ' + (reason || 'その他'));   // T列
    if (stage === '') {
      sh.getRange(row, 20).setValue('');
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
  return _crmTreeForPage_();
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
    if (archived) sh.getRange(row, 45).setValue('');
    console.log('[樹形図] 再問い合わせのため追客に戻しました: ' + customerName);
    return true;
  } catch (e) {
    console.warn('[樹形図] 戻せません: ' + customerName + ' / ' + e.message);
    return false;
  }
}
