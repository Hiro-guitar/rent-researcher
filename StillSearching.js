/**
 * StillSearching.gs — 「いい物件見つかり次第」の人に、まだ探しているかを聞く
 *
 * なぜ別の仕組みが要るか（2026-09-22）:
 *   引越し時期を「いい物件見つかり次第」で登録している人が21人いて、追客中のうち最多。
 *   期限が無いので MoveInDeadline.gs の出口が使えない。
 *
 * ⚠️ 日数だけで切らないこと。
 *   急いでいない人なので、3ヶ月後にいい部屋が出て決まることが普通にある。
 *   むしろこのサービスが一番向いている相手で、時間で切ると良い客を捨てる。
 *
 * ⚠️ 判断は「送っているのに見ていない」で行う。
 *   こちらが送れていないなら、それはお客様の問題ではない（そちらはルールD＝
 *   7日で近況・14日で条件を広げる提案 の担当）。
 *   送っているのに開かない、が止まっている合図になる。
 *
 * まだ数字を決めていないので、いまは分布を見るだけ。
 */

/**
 * 【GASエディタで実行】「見つかり次第」の人の、閲覧と送付の様子を見る。
 * ⚠️ 何も送らない。切る日数を実データから決めるためのもの。
 */
function previewStillSearching() {
  var all = _getCustomerListForCRM_();
  var target = all.filter(function (c) {
    if (c.stage === '終了' || c.stage === '成約' || c.stage === '申込') return false;
    return !!c.moveInAsap;
  });

  console.log('=== 「いい物件見つかり次第」の人 ' + target.length + '人 ===');
  console.log('（終了・申込・成約は除いています）');
  console.log('');

  // 何件送って、そのうち何件見たか
  var counts = _stillSearchingCounts_(target.map(function (c) { return c.name; }));

  target.sort(function (a, b) {
    var av = (a.daysSinceViewed === null || a.daysSinceViewed === undefined) ? 99999 : a.daysSinceViewed;
    var bv = (b.daysSinceViewed === null || b.daysSinceViewed === undefined) ? 99999 : b.daysSinceViewed;
    return bv - av;
  });

  console.log('最終閲覧から  最終送信から  送った  見た   顧客名');
  for (var i = 0; i < target.length; i++) {
    var c = target[i];
    var n = counts[c.name] || { sent: 0, viewed: 0 };
    console.log(
      _pad_((c.daysSinceViewed === null || c.daysSinceViewed === undefined) ? '一度もなし' : c.daysSinceViewed + '日', 12) +
      _pad_((c.daysSinceSent === null || c.daysSinceSent === undefined) ? '一度もなし' : c.daysSinceSent + '日', 13) +
      _pad_(n.sent + '件', 8) + _pad_(n.viewed + '件', 7) + c.name + '  （' + (c.stage || '未設定') + '）'
    );
  }

  console.log('');
  console.log('=== 「最終閲覧からN日以上、かつ送った件数がM件以上」で何人が当たるか ===');
  var days = [30, 45, 60, 90];
  var mins = [5, 10, 20];
  for (var d = 0; d < days.length; d++) {
    var line = days[d] + '日以上: ';
    for (var m = 0; m < mins.length; m++) {
      var hit = target.filter(function (c) {
        var n = counts[c.name] || { sent: 0 };
        var dv = (c.daysSinceViewed === null || c.daysSinceViewed === undefined) ? 99999 : c.daysSinceViewed;
        return dv >= days[d] && n.sent >= mins[m];
      }).length;
      line += _pad_(mins[m] + '件以上=' + hit + '人', 18);
    }
    console.log(line);
  }
  console.log('');
  console.log('※ 送信はまだ実装していません。数えているだけです。');
}

/**
 * 顧客名 → {sent, viewed}。
 * 送った数は通知済み物件シート、見た数はアクションログの view から数える。
 * ⚠️ 同じ部屋を何度見ても1件として数える。知りたいのは「何部屋に興味を持ったか」。
 */
function _stillSearchingCounts_(names) {
  var want = {};
  for (var i = 0; i < names.length; i++) want[names[i]] = { sent: 0, viewed: 0 };
  var ss = SpreadsheetApp.openById(SPREADSHEET_ID);

  try {
    var sh = ss.getSheetByName(SEEN_SHEET_NAME);
    if (sh && sh.getLastRow() > 1) {
      var rows = sh.getRange(2, 1, sh.getLastRow() - 1, 1).getValues();
      for (var r = 0; r < rows.length; r++) {
        var name = String(rows[r][0] || '').trim();
        if (want[name]) want[name].sent++;
      }
    }
  } catch (e) {
    console.warn('[まだ探していますか] 通知済み物件を読めません: ' + e.message);
  }

  try {
    var al = ss.getSheetByName(ACTION_LOG_SHEET_NAME);
    if (al && al.getLastRow() > 1) {
      var aRows = al.getRange(2, 1, al.getLastRow() - 1, 3).getValues();
      var seen = {};
      for (var a = 0; a < aRows.length; a++) {
        var n = String(aRows[a][0] || '').trim();
        if (!want[n]) continue;
        if (String(aRows[a][2] || '').trim() !== 'view') continue;
        var key = n + '\u0000' + String(aRows[a][1] || '').trim();
        if (seen[key]) continue;
        seen[key] = true;
        want[n].viewed++;
      }
    }
  } catch (e2) {
    console.warn('[まだ探していますか] アクションログを読めません: ' + e2.message);
  }
  return want;
}

/** 実行ログを表で読めるように、全角も数えて幅を揃える。 */
function _pad_(s, width) {
  s = String(s == null ? '' : s);
  var w = 0;
  for (var i = 0; i < s.length; i++) w += (s.charCodeAt(i) > 0xff) ? 2 : 1;
  while (w < width) { s += ' '; w++; }
  return s;
}
