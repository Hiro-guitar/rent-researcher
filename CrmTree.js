/**
 * 顧客を樹形図の枝に乗せる（CRMリニューアル 2026-09-28〜）。
 *
 * 新しい顧客管理ページは「樹形図そのもの」を画面にする。
 * 全員がどれか1つの枝に乗り、自分が動く枝（mine）だけ赤く人数を出す。
 * どの枝にも当てはまらない人は「迷子」に入れる。迷子が0人であることが
 * 「全員を管理できている」の条件。
 *
 * 材料は _getCustomerListForCRM_（コード.js）の結果をそのまま使う。
 * 判定は上から順に見て、最初に当てはまった枝に置く。
 */

// 枝の定義。parent で樹形図の形を作る。mine=true は自分が動く枝（赤）。
var CRM_TREE_NODES = [
  { id: 'inquiry',      label: '反響',                     parent: '' },
  { id: 'mailOnly',     label: 'メールだけ（自動メール）',   parent: 'inquiry' },
  { id: 'callQueue',    label: '架電待ち',                  parent: 'inquiry', mine: true },
  { id: 'callDone',     label: '架電3回つながらず',          parent: 'inquiry', mine: true },
  { id: 'line',         label: 'LINEに来た',                parent: 'inquiry' },
  { id: 'noCriteria',   label: '条件登録待ち（自動で催促）', parent: 'line' },
  { id: 'firstWait',    label: '初回配信まだ（0件）',        parent: 'line' },
  { id: 'following',    label: '追客中',                    parent: 'line' },
  { id: 'neverViewed',  label: '1件も見ていない（自動で再送）', parent: 'following' },
  { id: 'noSend14',     label: '14日 物件を送れていない',     parent: 'following', mine: true },
  { id: 'pausedNotEnd', label: '配信停止なのに終了でない',    parent: 'following', mine: true },
  { id: 'applied',      label: '申込',                      parent: 'following' },
  { id: 'won',          label: '成約',                      parent: '' },
  { id: 'ended',        label: '終了',                      parent: '' },
  { id: 'lost',         label: '迷子（どの枝にも入らない）',  parent: '', mine: true }
];

var CRM_TREE_CALL_MAX = 3;          // 架電はこの回数まで
var CRM_TREE_NO_SEND_DAYS = 14;     // 物件を送れていない日数

/**
 * 1人ぶんの枝を決める。
 * @param {Object} c _getCustomerListForCRM_ の1件（failedCalls を足してあること）
 * @return {string} 枝の id
 */
function _crmTreeNodeOf_(c) {
  var st = String(c.status || '').toLowerCase();
  if (c.stage === '成約') return 'won';
  if (c.stage === '申込') return 'applied';
  if (c.stage === '終了' || c.archived || st === 'blocked') return 'ended';

  var talked = (c.daysSinceTalk !== null && c.daysSinceTalk !== undefined);
  if (!c.hasLine) {
    if (!c.hasPhone && !c.hasCriteria) return 'mailOnly';
    if (c.hasPhone && !talked) return (c.failedCalls >= CRM_TREE_CALL_MAX) ? 'callDone' : 'callQueue';
    // 電話で話せた／条件がある（メールで配信中）人は追客中の扱いに落とす
  } else if (!c.hasCriteria) {
    return 'noCriteria';
  }
  if (!c.hasCriteria) return 'lost';   // LINEなし・話せた・条件なし

  if (st === 'paused' || st === 'auto_paused' || st === 'stopped' || st === 'snoozed') return 'pausedNotEnd';
  if (c.daysSinceSent === null || c.daysSinceSent === undefined) return 'firstWait';
  if (c.daysSinceSent >= CRM_TREE_NO_SEND_DAYS) return 'noSend14';
  if (c.daysSinceViewed === null || c.daysSinceViewed === undefined) return 'neverViewed';
  return 'following';
}

/** 対応ログから「つながらなかった架電」の回数を数える（話せた後の分も含む）。 */
function _crmTreeFailedCalls_() {
  var out = {};
  try {
    var sh = SpreadsheetApp.openById(CRITERIA_SHEET_ID).getSheetByName(CONTACT_LOG_SHEET_NAME);
    if (!sh || sh.getLastRow() < 2) return out;
    var rows = sh.getRange(2, 1, sh.getLastRow() - 1, 4).getValues();
    for (var i = 0; i < rows.length; i++) {
      var name = String(rows[i][0] || '').trim();
      if (!name) continue;
      if (_contactLogOutcome_(rows[i][2], rows[i][3]) === 'failed') out[name] = (out[name] || 0) + 1;
    }
  } catch (e) { console.warn('[樹形図] 対応ログ: ' + e.message); }
  return out;
}

/**
 * 樹形図に全員を乗せた結果を返す（顧客管理ページから呼ぶ）。
 * @return {{nodes:Array, customers:Array}}
 */
function getCrmTree() {
  var customers = _getCustomerListForCRM_();
  var failed = _crmTreeFailedCalls_();
  var count = {};
  for (var i = 0; i < customers.length; i++) {
    var c = customers[i];
    c.failedCalls = failed[c.name] || 0;
    c.node = _crmTreeNodeOf_(c);
    count[c.node] = (count[c.node] || 0) + 1;
  }
  var nodes = CRM_TREE_NODES.map(function (n) {
    return { id: n.id, label: n.label, parent: n.parent, mine: !!n.mine, count: count[n.id] || 0 };
  });
  return { nodes: nodes, customers: customers };
}

/**
 * 【GASエディタで実行: CrmTree.gs】枝ごとの人数と、赤い枝・迷子の顔ぶれをログに出す。
 * 何も変えない。
 */
function previewCrmTree() {
  var t = getCrmTree();
  var byNode = {};
  t.customers.forEach(function (c) { (byNode[c.node] = byNode[c.node] || []).push(c); });
  var lines = ['全 ' + t.customers.length + ' 人'];
  t.nodes.forEach(function (n) {
    var depth = n.parent ? (n.parent === 'inquiry' ? 1 : 2) : 0;
    if (n.parent === 'line') depth = 2;
    if (n.parent === 'following') depth = 3;
    lines.push(new Array(depth + 1).join('　') + (n.mine ? '🔴 ' : '・') + n.label + '【' + n.count + '】');
  });
  console.log(lines.join('\n'));

  // 架電待ちを反響からの日数で分ける（まだ一度もかけていない人をどう扱うか決めるため）
  var todayIdx = _jstDayIndex_(Date.now());
  var buckets = { '3日以内': 0, '4〜7日': 0, '8〜30日': 0, '31〜90日': 0, '91日以上': 0, '日付なし': 0 };
  (byNode.callQueue || []).forEach(function (c) {
    var ms = c.registeredAt ? new Date(c.registeredAt).getTime() : 0;
    if (!ms) { buckets['日付なし']++; return; }
    var d = todayIdx - _jstDayIndex_(ms);
    buckets[d <= 3 ? '3日以内' : d <= 7 ? '4〜7日' : d <= 30 ? '8〜30日' : d <= 90 ? '31〜90日' : '91日以上']++;
  });
  console.log('■ 架電待ちの反響からの日数\n' + Object.keys(buckets).map(function (k) { return k + ': ' + buckets[k] + '人'; }).join('\n'));

  t.nodes.forEach(function (n) {
    if (!n.mine || !n.count || n.id === 'callQueue') return;
    var list = (byNode[n.id] || []).map(function (c) {
      return c.name + '(旧列:' + (c.stage || '-') + ' / S:' + (c.status || '-')
        + ' / LINE:' + (c.hasLine ? '有' : '無') + ' / 電話:' + (c.hasPhone ? '有' : '無')
        + ' / 条件:' + (c.hasCriteria ? '有' : '無') + ' / 架電失敗:' + c.failedCalls
        + ' / 最終送信:' + (c.daysSinceSent === null ? '-' : c.daysSinceSent + '日前') + ')';
    });
    console.log('■ ' + n.label + '（' + n.count + '人）\n' + list.join('\n'));
  });
}
