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
  { id: 'inquiry',      label: '反響',                         parent: '' },
  { id: 'mailOnly',     label: 'メールだけ（自動メール）',       parent: 'inquiry' },
  { id: 'callQueue',    label: '架電待ち',                      parent: 'inquiry', mine: true },
  { id: 'line',         label: 'LINEに来た',                    parent: 'inquiry' },
  { id: 'noCriteria',   label: '条件登録待ち（自動で催促）',     parent: 'line' },
  { id: 'registered',   label: '条件登録済み',                  parent: 'line' },
  { id: 'firstWait',    label: '初回配信まだ（0件）',            parent: 'registered' },
  { id: 'following',    label: '追客中',                        parent: 'registered' },
  { id: 'neverViewed',  label: '1件も見ていない（自動で再送）',   parent: 'following' },
  { id: 'noSend14',     label: '14日 物件を送れていない',         parent: 'following', mine: true },
  { id: 'pausedNotEnd', label: '配信停止なのに終了でない',        parent: 'following', mine: true },
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
// ボットが答えなかったLINEの文（＝人が返信する文）。doPost の最後で書く。
var CRM_TREE_REPLY_SHEET = 'LINE要返信';

var CRM_TREE_CALL_MAX = 3;          // 架電はこの回数まで
var CRM_TREE_MAIL_DAYS = 14;        // メールだけの人は、反響からこの日数でLINEに来なければ終了
var CRM_TREE_CALL_DAYS = 7;         // 反響からこの日数を過ぎたら架電待ちから外す（終了）
var CRM_TREE_NUDGE_WAIT_H = 24;     // 催促のあと、この時間 何も無ければ終了
var CRM_TREE_NO_SEND_DAYS = 14;     // 物件を送れていない日数
var CRM_TREE_VIEW_REPEAT = 3;       // 同じ物件をこの回数以上 開いたら強い合図
var CRM_TREE_VIEW_ROOMS = 3;        // この件数以上の物件を開いたら強い合図
var CRM_TREE_SIGNAL_DAYS = 7;       // 閲覧の合図はこの日数以内のものだけ数える

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

  if (c.stage === '申込') return 'applied';
  if (c.stage === '終了' || c.archived) return 'ended';

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
      var expired = c.failedCalls >= CRM_TREE_CALL_MAX
        || (c.daysSinceInquiry !== null && c.daysSinceInquiry > CRM_TREE_CALL_DAYS);
      if (expired) { c.endWhy = '架電' + c.failedCalls + '回・反響から' + c.daysSinceInquiry + '日'; return 'ended'; }
      return 'callQueue';
    }
    // 電話で話せた／条件がある（メールで配信中）人は下の追客中の判定へ
  } else if (!c.hasCriteria) {
    if (c.nudgedMs && Date.now() - c.nudgedMs > CRM_TREE_NUDGE_WAIT_H * 3600000
        && !(c.lineMs > c.nudgedMs)) {
      c.endWhy = '催促のあと反応なし';
      return 'ended';
    }
    return 'noCriteria';
  }
  if (!c.hasCriteria) return 'lost';   // LINEなし・話せた・条件なし

  if (st === 'paused' || st === 'auto_paused' || st === 'stopped' || st === 'snoozed') return 'pausedNotEnd';
  if (c.daysSinceSent === null || c.daysSinceSent === undefined) return 'firstWait';
  if (c.daysSinceSent >= CRM_TREE_NO_SEND_DAYS) return 'noSend14';
  if (c.daysSinceViewed === null || c.daysSinceViewed === undefined) return 'neverViewed';
  return 'following';
}

/** 対応ログ: 顧客名 → { failed: つながらなかった回数, lastMs: 最後に何か記録した時刻 } */
function _crmTreeContactLog_(ss) {
  var out = {};
  try {
    var sh = ss.getSheetByName(CONTACT_LOG_SHEET_NAME);
    if (!sh || sh.getLastRow() < 2) return out;
    var rows = sh.getRange(2, 1, sh.getLastRow() - 1, 4).getValues();
    for (var i = 0; i < rows.length; i++) {
      var name = String(rows[i][0] || '').trim();
      if (!name) continue;
      var r = out[name] || (out[name] = { failed: 0, lastMs: 0 });
      if (_contactLogOutcome_(rows[i][2], rows[i][3]) === 'failed') r.failed++;
      var ms = _cellToEpochMs_(rows[i][1]);
      if (ms > r.lastMs) r.lastMs = ms;
    }
  } catch (e) { console.warn('[樹形図] 対応ログ: ' + e.message); }
  return out;
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
    if (a.act === 'hold' || a.act === 'viewing') {
      sig.apply = Math.max(sig.apply, a.ms);
      submitted[a.room + '|' + (a.act === 'hold' ? 'hold' : 'viewing')] = true;
    }
  });
  var viewsByRoom = {}, rooms = 0, since = Date.now() - CRM_TREE_SIGNAL_DAYS * _DAY_MS_;
  (acts || []).forEach(function (a) {
    if (a.ms <= handledMs) return;
    if (a.act === 'hold_intent' || a.act === 'viewing_intent') {
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
function getCrmTree() {
  var ss = SpreadsheetApp.openById(CRITERIA_SHEET_ID);
  var all = _getCustomerListForCRM_();
  var old = _crmTreeOld_(ss);
  // ⚠️ 旧顧客でも、控えたあとに動いた人（再問い合わせ・返信が要るLINE・申込/内見の希望）は樹形図に戻す。
  //   捨てたのは「放っておいた過去」であって、今また来た人ではない。
  var back = _crmTreeOldCameBack_(ss, old, all);
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

  var count = {};
  customers.forEach(function (c) {
    var uid = c.uid || uidByName[c.name] || '';
    c.uid = uid;
    var cl = log[c.name] || { failed: 0, lastMs: 0 };
    c.failedCalls = cl.failed;
    c.lineMs = uid ? (lineMsByUid[uid] || 0) : 0;
    c.nudgedMs = (uid && friends[uid]) ? friends[uid].nudgedMs : 0;
    var regMs = c.registeredAt ? new Date(c.registeredAt).getTime() : 0;
    c.daysSinceInquiry = regMs ? (todayIdx - _jstDayIndex_(regMs)) : null;
    c.sig = _crmTreeSignals_(acts[c.name], cl.lastMs, uid ? (replyByUid[uid] || 0) : 0);
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
function previewCrmTree() {
  var t = getCrmTree();
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
        + ' / 条件:' + (c.hasCriteria ? '有' : '無') + ' / 架電失敗:' + (c.failedCalls || 0)
        + (c.sig && c.sig.note ? ' / 合図:' + c.sig.note : '')
        + (c.endWhy ? ' / 終了理由:' + c.endWhy : '') + '）';
    });
    console.log('■ ' + n.label + '（' + n.count + '人）\n' + list.join('\n'));
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
        daysSinceSent: c.daysSinceSent, daysSinceViewed: c.daysSinceViewed,
        lastTalkAt: c.lastTalkAt || '', moveIn: c.moveIn || '',
        note: (c.sig && c.sig.note) || '', endWhy: c.endWhy || ''
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
  return _crmTreeForPage_();
}

/** doGet(action=crm) — 樹形図の顧客管理ページ。 */
function handleCrmTreePage(e) {
  if (!_validateReinsApiKey(e.parameter.api_key)) {
    return HtmlService.createHtmlOutput(
      '<html><body style="text-align:center;padding:40px;font-family:sans-serif;">' +
      '<h3>認証エラー</h3><p>api_key が正しくありません。</p></body></html>'
    ).setTitle('認証エラー');
  }
  var tpl = HtmlService.createTemplateFromFile('CrmTreePage');
  tpl.treeJson = _jsonForInlineScript_(_crmTreeForPage_());
  tpl.customerPageUrl = _jsonForInlineScript_(getCustomerPageUrl());
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
