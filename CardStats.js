/**
 * CardStats.gs - 「募集終了カード」がどう使われているかを数える
 *
 * 空室確認で募集終了だった未登録のお客様に出しているカードが、実際に押されているのか
 * 誰も知らなかった。文面を直す前に、今の姿を数える（2026-09-18）。
 *
 * A/Bテストは量が足りない。月100件ほどでは2つに分けても差を見分けられないので、
 * まず今の1パターンの成績を測る。文面を変えたあとの比較の基準にもなる。
 *
 * 見たいもの
 *   ・何人に出たか
 *   ・「はい、お願いします」を押したか（条件がそのまま登録される）
 *   ・「いいえ、条件を自分で決める」を押したか（質問フローが始まる）
 *   ・何も押さなかったか
 *   ・そのあとブロックしたか
 *
 * 使い方（GASエディタ・CardStats.gs）
 *   showVacancyCardStats()  … 集計を出す。読み取りだけ
 */

var VACANCY_CARD_SHEET = '募集終了カード記録';
// ボタンを押したことにする期間。これより古い記録には結び付けない。
var VACANCY_CARD_ATTRIBUTION_MS = 7 * 24 * 60 * 60 * 1000;

function _vacancyCardSheet_() {
  var ss = SpreadsheetApp.openById(CRITERIA_SHEET_ID);
  var sh = ss.getSheetByName(VACANCY_CARD_SHEET);
  if (!sh) {
    sh = ss.insertSheet(VACANCY_CARD_SHEET);
    sh.appendRow(['userId', '顧客名', '物件', '出した日時', '種類', '押したボタン', '押した日時']);
    try {
      sh.getRange(1, 1, 1, 7).setFontWeight('bold').setBackground('#e0e0e0');
      sh.setFrozenRows(1);
    } catch (_) {}
  }
  return sh;
}

/**
 * カードを出したことを記録する。_buildVacancyUnavailableMessages_ から呼ばれる。
 * 記録に失敗してもカードの送信は止めない。
 * @param {string} variant '条件あり'（2択カード） | '条件なし'（お部屋を探すのみ）
 */
function recordVacancyCardShown(userId, propertyLabel, variant) {
  try {
    if (!userId) return;
    var name = '';
    try { name = _getLineUserName_(userId) || ''; } catch (_) {}
    _vacancyCardSheet_().appendRow([
      userId, name, String(propertyLabel || ''), new Date(), variant || '', '', ''
    ]);
  } catch (e) {
    console.warn('[募集終了カード] 記録に失敗: ' + e.message);
  }
}

/**
 * ボタンが押されたことを記録する。押されていない一番新しい記録に結び付ける。
 * 「条件登録」の postback はカード以外からも来るので、期間で区切って取り違えを防ぐ。
 * @param {string} button 'はい' | 'いいえ'
 */
function recordVacancyCardPressed(userId, button) {
  try {
    if (!userId) return;
    var sh = _vacancyCardSheet_();
    var last = sh.getLastRow();
    if (last < 2) return;
    var rows = sh.getRange(2, 1, last - 1, 6).getValues();
    var now = Date.now();
    // 新しい方から探す。同じ人に何度も出ているので、直近のものに結び付ける。
    for (var i = rows.length - 1; i >= 0; i--) {
      if (String(rows[i][0] || '').trim() !== String(userId)) continue;
      if (String(rows[i][5] || '').trim() !== '') continue;      // すでに押されている
      var shownAt = rows[i][3];
      if (!(shownAt instanceof Date)) continue;
      if (now - shownAt.getTime() > VACANCY_CARD_ATTRIBUTION_MS) return;  // 古すぎる。別経路とみなす
      sh.getRange(i + 2, 6, 1, 2).setValues([[button, new Date()]]);
      console.log('[募集終了カード] ' + button + ' が押されました: ' + (rows[i][1] || userId));
      return;
    }
  } catch (e) {
    console.warn('[募集終了カード] 押下の記録に失敗: ' + e.message);
  }
}

/**
 * 【GASエディタから実行】集計を出す。読み取りだけで何も書き換えない。
 */
function showVacancyCardStats() {
  var sh = _vacancyCardSheet_();
  var last = sh.getLastRow();
  if (last < 2) {
    console.log('まだ記録がありません（記録はこの仕組みを入れた 2026-09-18 以降のカードから）');
    return;
  }
  var rows = sh.getRange(2, 1, last - 1, 7).getValues();

  // ブロック状況を顧客名で引けるようにする。S列(19)=配信ステータス / U列(21)=停止・ブロック日時
  var blockedAt = {};
  try {
    var cs = SpreadsheetApp.openById(CRITERIA_SHEET_ID).getSheetByName(CRITERIA_SHEET_NAME);
    if (cs && cs.getLastRow() > 1) {
      var cd = cs.getRange(2, 1, cs.getLastRow() - 1, 22).getValues();
      for (var c = 0; c < cd.length; c++) {
        var nm = String(cd[c][1] || '').trim();
        if (!nm) continue;
        if (String(cd[c][18] || '').trim() === 'blocked') blockedAt[nm] = cd[c][20] || true;
      }
    }
  } catch (e) {
    console.warn('ブロック状況を読めません: ' + e.message);
  }

  var total = 0, yes = 0, no = 0, none = 0, blocked = 0;
  var byVariant = {};
  var noneList = [];
  var other = 0, byButton = {};
  for (var i = 0; i < rows.length; i++) {
    var uid = String(rows[i][0] || '').trim();
    // テスト送信（TEST_ALLOWED_NAMES の人）は数えない。基準の数字がにごる
    if (typeof TEST_ALLOWED_NAMES !== 'undefined' && TEST_ALLOWED_NAMES.indexOf(String(rows[i][1] || '').trim()) !== -1) continue;
    if (!uid) continue;
    total++;
    var variant = String(rows[i][4] || '(不明)');
    if (!byVariant[variant]) byVariant[variant] = { n: 0, yes: 0, no: 0 };
    byVariant[variant].n++;
    var btn = String(rows[i][5] || '').trim();
    // ボタン名は決め打ちしない（2026-09-27 に「はい／いいえ」から
    // 「この条件をもとに登録する／登録完了（緑）／条件を自分で決める」に変わった）
    if (btn) byButton[btn] = (byButton[btn] || 0) + 1;
    if (btn === 'はい' || btn === '登録完了（緑）') { yes++; byVariant[variant].yes++; }
    else if (btn === 'いいえ' || btn === '条件を自分で決める') { no++; byVariant[variant].no++; }
    else if (btn) { other++; byVariant[variant].other = (byVariant[variant].other || 0) + 1; }
    else {
      none++;
      var shownAt = rows[i][3];
      noneList.push((rows[i][1] || uid) + '（'
        + (shownAt instanceof Date ? Utilities.formatDate(shownAt, 'Asia/Tokyo', 'M/d') : '?') + '）');
    }
    var nm2 = String(rows[i][1] || '').trim();
    if (nm2 && blockedAt[nm2]) blocked++;
  }

  function pct(n) { return total ? ' (' + (n * 100 / total).toFixed(1) + '%)' : ''; }
  console.log('募集終了カードを出した数: ' + total + '件');
  console.log('  登録した（旧「はい」＋ 緑→送信まで）: ' + yes + '件' + pct(yes));
  console.log('  自分で決める（旧「いいえ」＋ グレー）: ' + no + '件' + pct(no));
  if (other) console.log('  緑を押したが送信まで行っていない: ' + other + '件' + pct(other));
  console.log('  ボタン別: ' + Object.keys(byButton).map(function (k) { return k + ' ' + byButton[k]; }).join(' / '));
  console.log('  何も押さなかった: ' + none + '件' + pct(none));
  console.log('  そのお客様が今ブロック中: ' + blocked + '件' + pct(blocked));
  console.log('--- カードの種類ごと ---');
  for (var v in byVariant) {
    var b = byVariant[v];
    console.log('  ' + v + ': ' + b.n + '件 / はい ' + b.yes + ' / いいえ ' + b.no
      + ' / 無反応 ' + (b.n - b.yes - b.no));
  }
  if (noneList.length) {
    console.log('--- 何も押さなかった人（新しい順に30件）---');
    console.log('  ' + noneList.slice(-30).reverse().join(' / '));
  }
  console.log('※ 「条件登録」のボタンはカード以外からも押せるため、'
    + VACANCY_CARD_ATTRIBUTION_MS / 86400000 + '日以内の記録にだけ結び付けています。');
}
