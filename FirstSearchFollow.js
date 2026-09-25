/**
 * FirstSearchFollow.gs — 条件登録後、最初の検索で1件も送れなかった人に、すぐ条件変更を提案する
 *
 * 狙い（2026-09-22）:
 *   登録した直後に何も来ないのが、いちばん冷めるタイミング。
 *   10日おきの一律の提案（廃止予定）ではなく、その日のうちに手を打つ。
 *   提案を無視した人はもう追わない。戻ってくれば元に戻す（AutoEnd.gs）。
 *
 * どう分かるか:
 *   「最初の検索が走った」 … 検索条件シート AC列(29) に検索日が入る（拡張が書く）
 *   「1件も送れなかった」 … 承認待ち物件に sent / pending の行が無い
 *   「条件を変えた」       … writeToSheet が AC列を空に戻す。それが反応の印
 *
 * いつ動くか（2026-09-23）:
 *   拡張は1人分の検索（REINS・いえらぶ・itandi）を全部終えたあとに、その人の検索日を
 *   update_reins_search_date で報告する。0件でも報告される。そこから firstSearchOnSearchDone
 *   を呼んで、その場で提案する。1時間おきの processFirstSearchFollow は取りこぼしの保険と、
 *   24時間たった人を終了にするためのもの。
 * ⚠️ 昔から0件のまま止まっている人を巻き込まないこと。FIRST_SEARCH_MAX_AGE_D で足切り。
 *   その人たちは電話で拾う（顧客管理ページの仕事）。
 * ⚠️ 提案の文面と形は既存の buildConditionSuggestionFlex_ をそのまま使う。
 *   Z列（最終提案日）も書いておき、旧仕組みが同じ日に重ねて送らないようにする。
 */

var FIRST_SEARCH_SHEET = '初回検索の確認';

// 送信を止めるスイッチ。false なら数えるだけ。中身と仕組みが決まるまで false。
var FIRST_SEARCH_ENABLED = false;
// 返事をこれだけ待って、無ければ終了
var FIRST_SEARCH_REPLY_H = 24;
// これより前に登録した人は拾わない
var FIRST_SEARCH_MAX_AGE_D = 7;

function _firstSearchSheet_() {
  var ss = SpreadsheetApp.openById(CRITERIA_SHEET_ID);
  var sh = ss.getSheetByName(FIRST_SEARCH_SHEET);
  if (!sh) {
    sh = ss.insertSheet(FIRST_SEARCH_SHEET);
    sh.appendRow(['顧客名', '登録日時', '提案した日時', '反応', '状態']);
    try {
      sh.getRange(1, 1, 1, 5).setFontWeight('bold').setBackground('#e0e0e0');
      sh.setFrozenRows(1);
    } catch (_) {}
  }
  return sh;
}

/** 承認待ち物件に sent / pending の行がある顧客名の集合。 */
function _firstSearchNamesWithProps_() {
  var set = {};
  try {
    var sh = SpreadsheetApp.openById(SPREADSHEET_ID).getSheetByName(PENDING_SHEET_NAME);
    if (!sh || sh.getLastRow() < 2) return set;
    var rows = sh.getRange(2, 1, sh.getLastRow() - 1, 11).getValues();   // A:顧客名 … K:status
    for (var i = 0; i < rows.length; i++) {
      var st = String(rows[i][10] || '').trim();
      if (st === 'sent' || st === 'pending') set[String(rows[i][0] || '').trim()] = true;
    }
  } catch (e) { console.warn('[初回検索] 承認待ち物件を読めません: ' + e.message); }
  try {
    var sh2 = SpreadsheetApp.openById(SPREADSHEET_ID).getSheetByName(SEEN_SHEET_NAME);
    if (sh2 && sh2.getLastRow() > 1) {
      var names = sh2.getRange(2, 1, sh2.getLastRow() - 1, 1).getValues();
      for (var j = 0; j < names.length; j++) set[String(names[j][0] || '').trim()] = true;
    }
  } catch (e2) { console.warn('[初回検索] 通知済み物件を読めません: ' + e2.message); }
  return set;
}

/**
 * 最初の検索が走ったのに1件も送れていない人を集める。送信はしない。
 * @return {Array<{name, rowIndex, registeredMs, searchedOn, hoursSinceReg, tooOld}>}
 */
function collectFirstSearchZero() {
  var out = [];
  var sh = SpreadsheetApp.openById(CRITERIA_SHEET_ID).getSheetByName(CRITERIA_SHEET_NAME);
  if (!sh || sh.getLastRow() < 2) return out;
  var data = sh.getDataRange().getValues();
  var hasProps = _firstSearchNamesWithProps_();
  var now = Date.now();
  var seen = {};

  for (var i = data.length - 1; i >= 1; i--) {
    var name = String(data[i][1] || '').trim();
    if (!name || seen[name]) continue;
    if (typeof _rowHasCriteria_ === 'function' && !_rowHasCriteria_(data[i])) continue;
    seen[name] = true;

    if (String(data[i][32] || '').trim() === '終了') continue;                       // AG列: ステージ
    var status = String(data[i][18] || '').trim().toLowerCase() || 'active';         // S列: 配信状態
    if (status !== 'active') continue;
    var searchedOn = String(data[i][28] || '').trim();                                // AC列: 検索日
    if (!searchedOn) continue;                                                        // まだ検索していない
    if (hasProps[name]) continue;                                                     // 送れている

    var regMs = _fdMs_(data[i][0]);                                                   // A列: 登録日時
    if (!regMs) continue;
    var hours = (now - regMs) / 3600000;

    out.push({
      name: name, rowIndex: i + 1, registeredMs: regMs, searchedOn: searchedOn,
      hoursSinceReg: Math.floor(hours), tooOld: hours > FIRST_SEARCH_MAX_AGE_D * 24
    });
  }
  out.sort(function (a, b) { return a.hoursSinceReg - b.hoursSinceReg; });
  return out;
}

/** 【GASエディタで実行】今その状態の人を数える。何も送らない。 */
function previewFirstSearchZero() {
  var list = collectFirstSearchZero();
  var fresh = list.filter(function (x) { return !x.tooOld; });
  var old = list.filter(function (x) { return x.tooOld; });
  console.log('=== 最初の検索が走ったのに、1件も送れていない人 ===');
  console.log('■ 登録から' + FIRST_SEARCH_MAX_AGE_D + '日以内: ' + fresh.length + '人 ← 提案の対象');
  for (var i = 0; i < fresh.length; i++) {
    console.log('   登録から' + fresh[i].hoursSinceReg + '時間  ' + fresh[i].name + '  （検索日 ' + fresh[i].searchedOn + '）');
  }
  console.log('■ それより前: ' + old.length + '人 ← 自動では触らない。電話の対象');
  for (var j = 0; j < Math.min(old.length, 20); j++) {
    console.log('   登録から' + Math.floor(old[j].hoursSinceReg / 24) + '日  ' + old[j].name);
  }
  if (old.length > 20) console.log('   ほか ' + (old.length - 20) + '人');
  console.log('');
  console.log('※ 送信は' + (FIRST_SEARCH_ENABLED ? '有効です' : 'まだ止めてあります') + '。');
}

/** 提案を送る。 */
function _firstSearchAsk_() {
  var list = collectFirstSearchZero().filter(function (x) { return !x.tooOld; });
  if (!list.length) return 0;

  var sh = _firstSearchSheet_();
  var asked = {};
  if (sh.getLastRow() > 1) {
    var rows = sh.getRange(2, 1, sh.getLastRow() - 1, 5).getValues();
    for (var r = 0; r < rows.length; r++) asked[String(rows[r][0] || '').trim()] = true;
  }
  var todo = list.filter(function (x) { return !asked[x.name]; });
  if (!todo.length) return 0;

  // 提案カードは既存の候補オブジェクトから作る（条件の緩め方を具体的に示すもの）
  var byName = {};
  var cands = getConditionSuggestionCandidates_({ names: todo.map(function (x) { return x.name; }) });
  for (var c = 0; c < cands.length; c++) byName[cands[c].name] = cands[c];

  var sent = 0;
  for (var i = 0; i < todo.length; i++) {
    if (_firstSearchSendTo_(todo[i], byName[todo[i].name], sh)) sent++;
  }
  return sent;
}

/**
 * 0件のときの文章（2026-09-24 確定）。
 * ⚠️ 条件を文章に並べないこと。下のカードに表で出る。並べると申込書のように見える。
 * ⚠️ 件数や「良さそう」とは言わないこと。目視で落ちる物件があるので約束になる。
 * ⚠️「提案します」「伺います」と言わないこと。ボタンが「相談する」なので、文章も相談で揃える。
 *   お客様が譲るのではなく、こちらから相談を頼む形にする。
 * 「お申し込みが入ってしまっているお部屋が多く」は、SUUMOに載っているのに送れない事情の説明。
 */
function buildFirstSearchZeroText(cand) {
  return 'ご希望の条件でお探ししたところ、お申し込みが入ってしまっているお部屋が多く、現在ご紹介できるものがありませんでした。\n\n'
    + '条件を少し見直すと見つかりやすくなりますので、一度ご相談させていただけますでしょうか。\n\n'
    + 'お電話でもLINEでも大丈夫です。';
}

/**
 * 0件のときのカード。条件登録完了と同じ表（左がグレーのラベル）で今の条件を見せ、
 * 相談か自分で変えるかを選んでもらう。
 * ⚠️ ボタンに優劣を付けないこと。3つとも同じ緑。1つだけ緑にすると「LINEが本命」に見える。
 * ⚠️ 条件が読めなかったら表は出さない。空の表を見せるより無いほうがよい。
 */
function buildFirstSearchZeroCard(customerName) {
  var body = [];
  try {
    var crit = (typeof loadCustomerCriteriaByName === 'function') ? loadCustomerCriteriaByName(customerName) : null;
    var rows = (crit && typeof _buildConditionSummaryRows_ === 'function') ? _buildConditionSummaryRows_(crit) : null;
    if (rows && rows.length) {
      body.push({
        type: 'box', layout: 'vertical', paddingAll: 'md', spacing: 'none',
        backgroundColor: '#f5f9ee', cornerRadius: 'md',
        contents: [
          { type: 'text', text: '現在ご登録の条件', size: 'xs', color: '#3d6909', weight: 'bold', align: 'center' },
          { type: 'separator', margin: 'sm', color: '#d4e7a8' }
        ].concat(rows)
      });
    }
  } catch (e) { console.warn('[初回検索] 条件を出せません: ' + e.message); }
  if (!body.length) body.push({ type: 'text', text: 'ご希望をお聞かせください。', size: 'sm', color: '#555555', wrap: true });

  var btn = function (label, action) {
    return { type: 'button', style: 'primary', color: '#6ea814', height: 'sm', action: action };   // 3つとも同じ緑
  };
  return {
    type: 'flex',
    altText: '条件の広げ方をご提案できますので、お電話かLINEでお伺いできますでしょうか。',
    contents: {
      type: 'bubble',
      body: { type: 'box', layout: 'vertical', spacing: 'sm', paddingAll: 'xl', contents: body },
      footer: {
        type: 'box', layout: 'vertical', spacing: 'sm', paddingAll: 'lg', paddingTop: 'none',
        contents: [
          btn('電話で相談する', { type: 'postback', label: '電話で相談する', data: 'fs:tel', displayText: '電話で相談する' }),
          btn('LINEで相談する', { type: 'postback', label: 'LINEで相談する', data: 'fs:line', displayText: 'LINEで相談する' }),
          btn('自分で条件を変更する', { type: 'message', label: '自分で条件を変更する', text: '条件変更' })
        ]
      }
    }
  };
}

/** 1人に提案を送る。成功したら true。 */
function _firstSearchSendTo_(t, cand, sh) {
  if (!cand) { console.log('[初回検索] 提案を作れません（LINE未接続など）: ' + t.name); return false; }
  if (!FIRST_SEARCH_ENABLED) { console.log('[初回検索] 対象（まだ送りません）: ' + t.name); return false; }
  try {
    pushMessage(cand.lineUserId, [textMsg(buildFirstSearchZeroText(cand)), buildFirstSearchZeroCard(t.name)]);
    var criteria = SpreadsheetApp.openById(CRITERIA_SHEET_ID).getSheetByName(CRITERIA_SHEET_NAME);
    criteria.getRange(t.rowIndex, CONDITION_SUGGESTION_SENT_COL).setValue(new Date());   // Z列: 旧仕組みの重複防止
    sh.appendRow([t.name, new Date(t.registeredMs), new Date(), '', '返事待ち']);
    console.log('[初回検索] 提案しました: ' + t.name);
    return true;
  } catch (e) {
    console.warn('[初回検索] 送れません: ' + t.name + ' / ' + e.message);
    return false;
  }
}

/**
 * 【検索完了の報告から呼ばれる】その人が0件なら、その場で提案する。
 * コード.js の _handleUpdateReinsSearchDate が AC列を書いた直後に呼ぶ。
 * ⚠️ ここで例外を投げないこと。検索日の記録そのものを失敗にしてはいけない。
 */
function firstSearchOnSearchDone(customerName) {
  try {
    customerName = String(customerName || '').trim();
    if (!customerName) return false;
    var hit = collectFirstSearchZero().filter(function (x) { return x.name === customerName && !x.tooOld; })[0];
    if (!hit) return false;                                     // 送れている／古い／対象外
    var sh = _firstSearchSheet_();
    if (sh.getLastRow() > 1) {
      var names = sh.getRange(2, 1, sh.getLastRow() - 1, 1).getValues();
      for (var i = 0; i < names.length; i++) {
        if (String(names[i][0] || '').trim() === customerName) return false;   // 一度きり
      }
    }
    var cand = getConditionSuggestionCandidates_({ names: [customerName] })[0];
    return _firstSearchSendTo_(hit, cand, sh);
  } catch (e) {
    console.warn('[初回検索] 検索完了の直後の提案に失敗: ' + customerName + ' / ' + e.message);
    return false;
  }
}

/** 提案から24時間、何も無い人を終了にする。条件を変えた／LINEで何か送った人は継続。 */
function _firstSearchClose_() {
  var sh = _firstSearchSheet_();
  if (sh.getLastRow() < 2) return 0;
  var rows = sh.getRange(2, 1, sh.getLastRow() - 1, 5).getValues();
  var now = Date.now();

  var criteria = SpreadsheetApp.openById(CRITERIA_SHEET_ID).getSheetByName(CRITERIA_SHEET_NAME);
  var cdata = criteria.getDataRange().getValues();
  var searchedOnByName = {};
  for (var i = cdata.length - 1; i >= 1; i--) {
    var n = String(cdata[i][1] || '').trim();
    if (n && !(n in searchedOnByName)) searchedOnByName[n] = String(cdata[i][28] || '').trim();
  }
  var uids = _moveInUserIds_();
  var acts = _moveInLastActivity_();
  var closed = 0;

  for (var r = 0; r < rows.length; r++) {
    if (String(rows[r][4] || '').trim() !== '返事待ち') continue;
    var askedMs = _fdMs_(rows[r][2]);
    if (!askedMs || now - askedMs < FIRST_SEARCH_REPLY_H * 3600000) continue;
    var name = String(rows[r][0] || '').trim();
    var uid = uids[name];

    var changed = (searchedOnByName[name] === '');                       // 条件を変えると AC列が空に戻る
    var talked = !!(uid && acts[uid] && acts[uid] > askedMs);
    if (changed || talked) {
      sh.getRange(r + 2, 4).setValue(changed ? '条件を変えた' : 'LINEで反応');
      sh.getRange(r + 2, 5).setValue('継続');
      continue;
    }
    if (!FIRST_SEARCH_ENABLED) { console.log('[初回検索] 終了の対象（まだ何もしません）: ' + name); continue; }
    try {
      endCustomerAsSilent(name, uid, '初回検索0件の提案を無視');   // AutoEnd.gs
      sh.getRange(r + 2, 5).setValue('終了（音信不通）');
      closed++;
    } catch (e) {
      console.warn('[初回検索] 終了にできません: ' + name + ' / ' + e.message);
    }
  }
  return closed;
}

/** 【トリガー・1時間おき】取りこぼしの保険と、24時間たった人の終了。営業時間内だけ動く。 */
function processFirstSearchFollow() {
  var h = (typeof getJstHour === 'function') ? getJstHour(new Date()) : new Date().getHours();
  if (h < 10 || h >= 20) return;
  try { _firstSearchAsk_(); } catch (e) { console.error('[初回検索] 提案で失敗: ' + e.message); }
  try { _firstSearchClose_(); } catch (e) { console.error('[初回検索] 締めで失敗: ' + e.message); }
}

/**
 * 【GASエディタで実行・テスト】0件のときの文章＋カードを、自分のLINEに送って見る。
 * ⚠️ TEST_ALLOWED_NAMES に入っている名前にしか送らない。記録シートにもZ列にも書かない。
 * @param {string} [name] 省略時は 'Hiroki'（TEST_ALLOWED_NAMES に入っている顧客名）
 */
function testSendFirstSearch(name) {
  name = String(name || 'Hiroki').trim();
  if (typeof TEST_ALLOWED_NAMES === 'undefined' || TEST_ALLOWED_NAMES.indexOf(name) === -1) {
    console.log('テスト許可の名前ではありません: ' + name + '（TEST_ALLOWED_NAMES を確認）');
    return false;
  }
  var cand = getConditionSuggestionCandidates_({ names: [name] })[0];
  if (!cand) {
    console.log('カードを作れません: ' + name + '（条件が無い／配信停止中／LINE未接続 のどれか）');
    return false;
  }
  pushMessage(cand.lineUserId, [
    textMsg('【テスト】\n\n' + buildFirstSearchZeroText(cand)),
    buildFirstSearchZeroCard(name)
  ]);
  console.log('送りました: ' + name);
  return true;
}

/**
 * 相談ボタンの受け口（コード.js の postback 振り分けから呼ばれる）。
 *   fs:line … LINEで相談する
 *   fs:tel  … 電話で相談する
 * どちらも担当者に Discord で知らせ、記録シートを「継続」にする。提案の中身は人がやる。
 */
function handleFirstSearchPostback(replyToken, userId, data) {
  var name = (typeof _getLineUserName_ === 'function') ? _getLineUserName_(userId) : '';

  if (data === 'fs:tel') {
    // ⚠️ 時間帯を聞く前に、番号を確かめること (2026-09-23)。
    //   番号が分かっている人には「末尾○○○○にかけます」と伝えてから時間帯を聞く。
    //   分かっていない人には先に番号を聞く。
    // ⚠️ 時間帯は聞かないこと (2026-09-25)。「電話して」と言った人に質問を返すのは一手多い。
    //   営業時間内にかければよく、出なければかけ直せばよい。都合の悪い時間だけ任意で書いてもらう。
    var phone = _firstSearchPhone_(name);
    if (phone) {
      clearState(userId);
      replyMessage(replyToken, [textMsg(
        'ありがとうございます。\n\n' +
        'ご登録いただいている番号（末尾 ' + phone.slice(-4) + '）にお電話します。\n\n' +
        'ご都合の悪い時間帯があれば、お知らせください。'
      )]);
      try { _firstSearchNotifyStaff_(name, userId, '電話', { phone: phone }); } catch (eN) { console.warn('[初回検索] 担当者通知に失敗: ' + eN.message); }
    } else {
      saveState(userId, { step: FS_STEP_TEL_NUMBER, data: {} });
      replyMessage(replyToken, [textMsg(
        'ありがとうございます。\n\nお電話番号を教えていただけますでしょうか。'
      )]);
    }
    try { _firstSearchMarkReply_(name, '電話で相談'); } catch (e) { console.warn('[初回検索] 記録できません: ' + e.message); }
    return;
  }

  // ⚠️「担当者から」と言わないこと (2026-09-25)。今までは担当者ではなかった、と言うのと同じ。
  //   同じ人がそのまま続ける形にする。
  replyMessage(replyToken, [textMsg(
    'ありがとうございます。\n\nご登録の条件を確認して、LINEでご連絡します。'
  )]);
  try { _firstSearchMarkReply_(name, 'LINEで相談'); } catch (e3) { console.warn('[初回検索] 記録できません: ' + e3.message); }
  try { _firstSearchNotifyStaff_(name, userId, 'LINE', {}); } catch (e2) { console.warn('[初回検索] 担当者通知に失敗: ' + e2.message); }
}

// 電話の相談で使う会話の段階。コード.js の文章の振り分けが見る。
var FS_STEP_TEL_NUMBER = 'FS_TEL_NUMBER';   // 番号を待っている

/**
 * 【コード.js の文章の振り分けから呼ばれる】電話の相談の続き。
 * @return {boolean} 受け取ったら true
 */
function handleFirstSearchText(replyToken, userId, message, state) {
  if (!state || state.step !== FS_STEP_TEL_NUMBER) return false;
  var name = (typeof _getLineUserName_ === 'function') ? _getLineUserName_(userId) : '';
  var m = String(message || '').trim();

  // 何日も経ってから届いた文は、答えではなく別件の可能性が高い
  if (typeof isStateFreshForFreeText === 'function' && !isStateFreshForFreeText(state)) {
    clearState(userId);
    return false;
  }

  if (state.step === FS_STEP_TEL_NUMBER) {
    var digits = m.replace(/[^0-9０-９]/g, '').replace(/[０-９]/g, function (c) { return String.fromCharCode(c.charCodeAt(0) - 0xFEE0); });
    if (!/^0\d{9,10}$/.test(digits)) {
      var tries = (state.data && state.data.fsTries) || 0;
      if (tries >= 1) {
        // 2回読めなければ、人に渡す。黙って終わらせない
        clearState(userId);
        replyMessage(replyToken, [textMsg('承知しました。LINEでご連絡します。')]);
        try { _firstSearchNotifyStaff_(name, userId, '電話', { note: '番号を読み取れず。本文: ' + m }); } catch (_e) {}
        return true;
      }
      saveState(userId, { step: FS_STEP_TEL_NUMBER, data: { fsTries: tries + 1 } });
      replyMessage(replyToken, [textMsg('番号として読み取れませんでした。\nハイフン無しの数字だけでも大丈夫です。')]);
      return true;
    }
    try { _firstSearchSavePhone_(name, digits); } catch (eS) { console.warn('[初回検索] 番号を保存できません: ' + eS.message); }
    clearState(userId);
    replyMessage(replyToken, [textMsg(
      'ありがとうございます。\n\nこの番号にお電話します。\nご都合の悪い時間帯があれば、お知らせください。'
    )]);
    try { _firstSearchNotifyStaff_(name, userId, '電話', { phone: digits }); } catch (eN) { console.warn('[初回検索] 担当者通知に失敗: ' + eN.message); }
    return true;
  }
  return false;
}

/** 検索条件シート AI列(35) の電話番号。無ければ ''。 */
function _firstSearchPhone_(name) {
  if (!name) return '';
  try {
    var sh = SpreadsheetApp.openById(CRITERIA_SHEET_ID).getSheetByName(CRITERIA_SHEET_NAME);
    var data = sh.getDataRange().getValues();
    var row = _autoEndCriteriaRow_(data, name);          // AutoEnd.gs
    if (row < 0) return '';
    return String(data[row - 1][34] || '').replace(/[^0-9]/g, '');
  } catch (e) { return ''; }
}

/** 聞いた番号を AI列(35) に保存する。 */
function _firstSearchSavePhone_(name, digits) {
  if (!name || !digits) return;
  var sh = SpreadsheetApp.openById(CRITERIA_SHEET_ID).getSheetByName(CRITERIA_SHEET_NAME);
  var data = sh.getDataRange().getValues();
  var row = _autoEndCriteriaRow_(data, name);
  if (row < 0) return;
  sh.getRange(row, 35).setValue(digits);
  console.log('[初回検索] 番号を保存: ' + name);
}

/** 記録シートのその人を「継続」にする。 */
function _firstSearchMarkReply_(name, reply) {
  if (!name) return;
  var sh = _firstSearchSheet_();
  if (sh.getLastRow() < 2) return;
  var rows = sh.getRange(2, 1, sh.getLastRow() - 1, 5).getValues();
  for (var i = rows.length - 1; i >= 0; i--) {
    if (String(rows[i][0] || '').trim() !== name) continue;
    sh.getRange(i + 2, 4).setValue(reply);
    sh.getRange(i + 2, 5).setValue('継続');
    return;
  }
}

/**
 * 担当者に知らせる。提案はここから人がやる。
 * 宛先はその顧客のスレッド（🏠 顧客名）。閲覧通知と同じ作り:
 *   DISCORD_THREAD_<顧客名> にスレッドIDがあればそこへ、無ければ thread_name で作って保存する。
 * @param {{phone?:string, note?:string}} info
 */
function _firstSearchNotifyStaff_(name, userId, how, info) {
  info = info || {};
  var props = PropertiesService.getScriptProperties();
  var webhookUrl = props.getProperty('DISCORD_WEBHOOK_URL');
  if (!webhookUrl) { console.warn('[初回検索] Discord webhook 未設定'); return; }
  var STAFF = '1459814543600390341';   // 閲覧通知と同じ相手にメンション

  var lines = ['<@' + STAFF + '>', '🙋 **' + (name || '(不明)') + '** 様から条件の相談希望（初回検索で0件）', '希望: ' + how + 'で相談'];
  if (info.phone) lines.push('電話番号: ' + info.phone);
  if (info.note) lines.push(info.note);
  lines.push(how === '電話' ? '営業時間内にお電話して、条件の広げ方を提案してください。都合の悪い時間があればLINEに書いてあります。' : 'LINEで条件の広げ方を提案してください。');

  var threadKey = 'DISCORD_THREAD_' + name;
  var threadId = name ? props.getProperty(threadKey) : '';
  var payload = { content: lines.join('\n'), allowed_mentions: { users: [STAFF] } };
  if (!threadId) payload.thread_name = '\uD83C\uDFE0 ' + (name || '(不明)');

  var resp = UrlFetchApp.fetch(webhookUrl + (threadId ? '?thread_id=' + threadId : '?wait=true'), {
    method: 'post', contentType: 'application/json',
    payload: JSON.stringify(payload), muteHttpExceptions: true
  });
  var code = resp.getResponseCode();
  // 新しく作ったスレッドは、次から同じ所に投げられるよう保存する（閲覧通知と同じ）
  if (!threadId && code === 200 && name) {
    try {
      var body = JSON.parse(resp.getContentText());
      if (body.channel_id) props.setProperty(threadKey, body.channel_id);
    } catch (_e) {}
  }
  console.log('[初回検索] Discord通知 ' + code + ' → ' + (name || '(不明)') + ' / ' + how + (threadId ? '（既存スレッド）' : '（スレッド作成）'));
}
