/**
 * CustomerSignals.gs — 今お部屋を探しているお客様の「動き」を1画面で見る
 *
 * きっかけ（2026-09-20）:
 *   検索が回っているお客様が40人ほどいるが、誰が本気で探していて誰がそうでないのか
 *   分からない状態だった。優先度の付け方を決める前に、まず実物を見る。
 *
 * ⚠️ 読み取りだけ。何も書き換えない。
 * ⚠️ ここで層に分けているのは**仮**。境目は勘で置いてある。
 *   分布を見てから決め直すためのもので、この区切りをそのまま仕組みに入れないこと。
 *
 * 使い方（GASエディタ・CustomerSignals.gs）
 *   showCustomerSignals()        … 一覧とまとめを出す
 *   showCustomerSignals('山田')  … 名前で絞る（部分一致）
 *
 * 見ているもの
 *   ・送った物件を開いたか（承認待ち物件の送信日時 × 閲覧ログ）
 *   ・送ってから開くまでの早さ … 待っている人ほど早い
 *   ・強い合図（内見希望・申込・お気に入り）
 *   ・空室確認を使った回数 … 他社サイトの物件をこちらに聞いてくる＝窓口にしている
 *   ・最後に動いた日
 */

var CS_STRONG_ACTIONS = ['viewing_intent', 'hold_intent', 'favorite'];

/** シートの値（Date でも 'yyyy/MM/dd HH:mm:ss' でも 'yyyy-MM-dd HH:mm:ss' でも）を ms にする。 */
function _csMs_(v) {
  if (v instanceof Date) return v.getTime();
  var s = String(v == null ? '' : v).trim();
  if (!s) return 0;
  var t = Date.parse(s.replace(/-/g, '/'));
  return isNaN(t) ? 0 : t;
}

function _csDays_(ms, nowMs) {
  if (!ms) return null;
  return Math.floor((nowMs - ms) / (24 * 60 * 60 * 1000));
}

/** 中央値。空なら null。 */
function _csMedian_(arr) {
  if (!arr || !arr.length) return null;
  var a = arr.slice().sort(function (x, y) { return x - y; });
  var m = Math.floor(a.length / 2);
  return (a.length % 2) ? a[m] : (a[m - 1] + a[m]) / 2;
}

/** 時間差（ミリ秒）を読みやすくする。 */
function _csGapLabel_(ms) {
  if (ms == null) return '-';
  var h = ms / (60 * 60 * 1000);
  if (h < 1) return Math.round(h * 60) + '分';
  if (h < 48) return (h < 10 ? h.toFixed(1) : Math.round(h)) + '時間';
  return Math.round(h / 24) + '日';
}

/**
 * 【GASエディタから実行】今探しているお客様の動きを一覧で出す。読み取りだけ。
 * @param {string} [filterName] 名前で絞る（部分一致）。省略で全員
 */
function showCustomerSignals(filterName) {
  var nowMs = Date.now();
  var only = String(filterName || '').trim();

  // ── 対象: 条件が入っていて、配信が止まっていない人 ──
  var cs = SpreadsheetApp.openById(CRITERIA_SHEET_ID).getSheetByName(CRITERIA_SHEET_NAME);
  if (!cs || cs.getLastRow() < 2) { console.log('検索条件シートが読めません'); return; }
  var cData = cs.getRange(2, 1, cs.getLastRow() - 1, 45).getValues();
  var people = {};
  for (var i = 0; i < cData.length; i++) {
    var name = String(cData[i][1] || '').trim();
    if (!name) continue;
    if (only && name.indexOf(only) < 0) continue;
    // 条件が空のリード行は対象外（空室確認でメールを結びつけた人など）
    if (typeof _rowHasCriteria_ === 'function' && !_rowHasCriteria_(cData[i])) continue;
    var status = String(cData[i][18] || '').trim();          // S列: 配信ステータス
    var stage = String(cData[i][32] || '').trim();           // AG列: 営業ステージ
    if (status === 'blocked' || status === 'paused') continue;
    if (stage === '終了') continue;
    if (String(cData[i][44] || '').trim()) continue;         // AS列: アーカイブ済み
    people[name] = {
      name: name, status: status, stage: stage,
      sent: 0, opened: 0, gaps: [], lastSentMs: 0, lastViewMs: 0,
      strong: 0, vacancy: 0, lastActMs: 0
    };
  }
  var names = Object.keys(people);
  if (!names.length) { console.log('対象のお客様がいません'); return; }

  // ── 送った物件（承認待ち物件: A顧客名 / C room_id / K status / M 送信日時）──
  var ps = SpreadsheetApp.openById(SPREADSHEET_ID).getSheetByName(PENDING_SHEET_NAME);
  var sentAt = {};                    // 'name\troom' → ms
  if (ps && ps.getLastRow() > 1) {
    var pData = ps.getRange(2, 1, ps.getLastRow() - 1, 13).getValues();
    for (var p = 0; p < pData.length; p++) {
      var pn = String(pData[p][0] || '').trim();
      if (!people[pn]) continue;
      if (String(pData[p][10] || '').trim() !== 'sent') continue;
      var room = String(pData[p][2] || '').trim();
      var ms = _csMs_(pData[p][12]);
      if (!room || !ms) continue;
      var key = pn + '\t' + room;
      // 同じ物件を2回送っていたら最初の送信を起点にする
      if (!sentAt[key] || ms < sentAt[key]) sentAt[key] = ms;
      people[pn].sent++;
      if (ms > people[pn].lastSentMs) people[pn].lastSentMs = ms;
    }
  }

  // ── 開いた物件（閲覧ログ: 顧客名 / room_id / 物件名 / 閲覧日時）──
  var vs = SpreadsheetApp.openById(SPREADSHEET_ID).getSheetByName(VIEW_LOG_SHEET_NAME);
  var firstView = {};                 // 'name\troom' → 最初に開いた ms
  if (vs && vs.getLastRow() > 1) {
    var vData = vs.getRange(2, 1, vs.getLastRow() - 1, 4).getValues();
    for (var v = 0; v < vData.length; v++) {
      var vn = String(vData[v][0] || '').trim();
      if (!people[vn]) continue;
      var vms = _csMs_(vData[v][3]);
      if (!vms) continue;
      if (vms > people[vn].lastViewMs) people[vn].lastViewMs = vms;
      var vkey = vn + '\t' + String(vData[v][1] || '').trim();
      if (!firstView[vkey] || vms < firstView[vkey]) firstView[vkey] = vms;
    }
  }

  // 送った物件ごとに「送ってから開くまで」を出す
  for (var k in sentAt) {
    var fv = firstView[k];
    if (!fv || fv < sentAt[k]) continue;        // 開いていない、または送信前の閲覧
    var who = k.split('\t')[0];
    if (!people[who]) continue;
    people[who].opened++;
    people[who].gaps.push(fv - sentAt[k]);
  }

  // ── 強い合図（アクションログ: 顧客名 / room_id / アクション / … / 日時）──
  var as = SpreadsheetApp.openById(SPREADSHEET_ID).getSheetByName(ACTION_LOG_SHEET_NAME);
  if (as && as.getLastRow() > 1) {
    var aData = as.getRange(2, 1, as.getLastRow() - 1, 9).getValues();
    for (var a = 0; a < aData.length; a++) {
      var an = String(aData[a][0] || '').trim();
      if (!people[an]) continue;
      var ams = _csMs_(aData[a][8]);
      if (ams > people[an].lastActMs) people[an].lastActMs = ams;
      if (CS_STRONG_ACTIONS.indexOf(String(aData[a][2] || '').trim()) >= 0) people[an].strong++;
    }
  }

  // ── 空室確認を使った回数（依頼シート: 3列目が顧客名）──
  try {
    var rs = SpreadsheetApp.openById(CRITERIA_SHEET_ID).getSheetByName(VACANCY_REQUEST_SHEET);
    if (rs && rs.getLastRow() > 1) {
      var rData = rs.getRange(2, 1, rs.getLastRow() - 1, 4).getValues();
      for (var r = 0; r < rData.length; r++) {
        var rn = String(rData[r][2] || '').trim();
        if (people[rn]) people[rn].vacancy++;
      }
    }
  } catch (eV) { console.warn('空室確認の記録を読めません: ' + eV.message); }

  // ── まとめて並べる ──
  var list = [];
  for (var n = 0; n < names.length; n++) {
    var q = people[names[n]];
    q.rate = q.sent ? (q.opened / q.sent) : null;
    q.medGap = _csMedian_(q.gaps);
    q.lastMoveMs = Math.max(q.lastViewMs, q.lastActMs);
    q.daysSinceMove = _csDays_(q.lastMoveMs, nowMs);
    q.daysSinceSent = _csDays_(q.lastSentMs, nowMs);
    list.push(q);
  }
  // 最後に動いた順。動いていない人は後ろ
  list.sort(function (x, y) { return (y.lastMoveMs || 0) - (x.lastMoveMs || 0); });

  console.log('=== 今お部屋を探しているお客様: ' + list.length + '人 ===');
  console.log('（送った / 開いた / 開封率 / 開くまでの中央値 / 最後に動いてから / 強い合図 / 空室確認）');
  console.log('');
  for (var L = 0; L < list.length; L++) {
    var c = list[L];
    console.log(
      _csPad_(c.name, 14)
      + ' 送' + _csPad_(String(c.sent), 3)
      + ' 開' + _csPad_(String(c.opened), 3)
      + ' ' + _csPad_(c.rate == null ? '-' : Math.round(c.rate * 100) + '%', 5)
      + ' ' + _csPad_(_csGapLabel_(c.medGap), 7)
      + ' ' + _csPad_(c.daysSinceMove == null ? '動きなし' : c.daysSinceMove + '日前', 8)
      + ' ' + (c.strong ? '合図' + c.strong : '    ')
      + ' ' + (c.vacancy ? '空室' + c.vacancy : '')
    );
  }

  // ── 仮の層分け（⚠️ 境目は勘。分布を見て決め直すためのもの）──
  var b = { 'よく開く': 0, 'たまに開く': 0, '送っているが開かない': 0, 'まだ送っていない': 0 };
  var strongPeople = 0, movedIn7 = 0, silent30 = 0;
  for (var s2 = 0; s2 < list.length; s2++) {
    var d = list[s2];
    if (!d.sent) b['まだ送っていない']++;
    else if (d.rate >= 0.5) b['よく開く']++;
    else if (d.opened > 0) b['たまに開く']++;
    else b['送っているが開かない']++;
    if (d.strong) strongPeople++;
    if (d.daysSinceMove != null && d.daysSinceMove <= 7) movedIn7++;
    if (d.daysSinceMove == null || d.daysSinceMove >= 30) silent30++;
  }
  console.log('');
  console.log('--- 開き方（⚠️ 境目は仮です）---');
  for (var key in b) console.log('  ' + key + ': ' + b[key] + '人');
  console.log('--- 動き ---');
  console.log('  直近7日に動いた: ' + movedIn7 + '人');
  console.log('  30日以上動いていない（または一度も）: ' + silent30 + '人');
  console.log('  内見希望・申込・お気に入りを押したことがある: ' + strongPeople + '人');
  console.log('');
  console.log('※ この層分けは分布を見るための仮置きです。実際の山がどこにあるかを見てから、');
  console.log('  優先度の境目を決めてください。');
}

/** 全角を2文字ぶんと数えて幅を揃える（ログを読みやすくするだけ）。 */
function _csPad_(s, width) {
  var t = String(s == null ? '' : s);
  var w = 0;
  for (var i = 0; i < t.length; i++) w += (t.charCodeAt(i) > 0xFF) ? 2 : 1;
  while (w < width) { t += ' '; w++; }
  return t;
}
