/**
 * VacancyRequest.gs - 空室確認の入口と「まとめて依頼 → 1通で返す」仕組み
 *
 * 流れ（SPEC_CRMリニューアル.md「空室確認の作り替え」2026-09-16）
 *   1. 「空室確認」タップ
 *      - 本人が分かっていない → お問い合わせ時のメールアドレスを聞く（＋「別の物件を調べる」）
 *      - メールが反響（問い合わせシート）と一致 → 問い合わせた物件をボタンで並べる。
 *        ここで LINE と顧客カードを結びつける（統合）。フォローアップメールも止まる
 *      - 本人が分かっている → メールは聞かず、問い合わせた物件のボタン（無ければ物件名/URL入力へ）
 *   2. 「別の物件を調べる」→ 物件名 または URL。複数あれば1通にまとめて送ってよい
 *   3. 受け取った物件は 物件空室管理シート で自動判定。判定できないものが1つでもあれば
 *      お客様には「お調べしてご連絡します」の1通だけ返し、スタッフへ Discord で依頼する
 *   4. スタッフは回答フォーム（?action=vacancy_answer_form）で全件に「募集中／ご案内不可」を付けて送信。
 *      お客様への返事は1通に合成し、空室回答キュー（5分遅れ・営業時間内）に乗せる
 *
 * 1件だけで自動判定できたときは、従来どおり物件カード＋遅延返信（暫定条件カード）で返す。
 */

var VACANCY_REQUEST_SHEET = '空室確認依頼';
var VACANCY_REQUEST_MAX_ITEMS = 10;     // 1通で受け付ける物件数の上限
var VACANCY_INQUIRY_MAX_BUTTONS = 5;    // 問い合わせ物件ボタンの上限
var VACANCY_TOO_MANY_HITS = 12;         // これを超えて当たったら絞り込みをお願いする

// ═══════════════════════════════════════════════════════════
//  入口
// ═══════════════════════════════════════════════════════════

/**
 * リッチメニュー「空室確認」タップ時。
 * @param {{forceNew?:boolean}} [opts] forceNew: 初問い合わせの人として扱う（テスト用）
 */
function startVacancyEntry(replyToken, userId, opts) {
  opts = opts || {};
  var ctx = opts.forceNew
    ? { lineName: '', emails: [], identified: false, inquiries: [] }
    : _vacancyEntryContext_(userId);
  console.log('[空室確認入口] identified=' + ctx.identified + ' inquiries=' + ctx.inquiries.length
    + ' emails=' + ctx.emails.length + (opts.forceNew ? ' (テスト:初問い合わせ扱い)' : ''));
  if (ctx.inquiries.length > 0) {
    saveState(userId, { step: STEPS.WAITING_VACANCY, data: { vcMode: 'choose' } });
    replyMessage(replyToken, [_vacancyChooserMessage_(ctx.inquiries)]);
    return;
  }
  if (!ctx.identified) {
    saveState(userId, { step: STEPS.WAITING_VACANCY, data: { vcMode: 'email' } });
    replyMessage(replyToken, [textMsgWithQuickReply(
      'お問い合わせ時のメールアドレスを送ってください。\n' +
      'お問い合わせいただいた物件をお調べしてご連絡します。\n\n' +
      'ほかの物件をお調べしたい場合は、下の「別の物件を調べる」をタップしてください。',
      [qrPostback('🔍 別の物件を調べる', 'vc:other')]
    )]);
    return;
  }
  _vacancyPromptOther_(replyToken, userId, '');
}

/** 「別の物件を調べる」の案内。lead は先頭に付ける一文（省略可）。 */
function _vacancyPromptOther_(replyToken, userId, lead) {
  saveState(userId, { step: STEPS.WAITING_VACANCY, data: { vcMode: 'other' } });
  replyMessage(replyToken, [textMsg(
    (lead ? lead + '\n\n' : '') +
    'お調べしたいお部屋のURL、または物件名をお送りください。\n\n' +
    'どのサイトで見つけたお部屋でも大丈夫です。\n\n' +
    '複数ある場合は、' + VACANCY_REQUEST_MAX_ITEMS + '件までまとめて1通で送っていただけます。\n\n' +
    '※この受付は24時間有効です。\n' +
    '過ぎてしまった場合は、下のメニューから「空室確認」をもう一度タップしてください。'
  )]);
}

/** postback "vc:..." を処理する。 */
function handleVacancyPostback(replyToken, userId, data) {
  if (data === 'vc:other') {
    _vacancyPromptOther_(replyToken, userId, '');
    return;
  }
  if (data.indexOf('vc:inq:') === 0) {
    var renban = data.substring('vc:inq:'.length);
    var inq = _vacancyFindInquiryByRenban_(renban);
    if (!inq) {
      _vacancyPromptOther_(replyToken, userId, 'お問い合わせの記録が見つかりませんでした。');
      return;
    }
    clearState(userId);
    handleVacancyRequest(replyToken, userId, [{
      text: inq.building, url: inq.url, label: inq.building
    }], { fromInquiry: true });
    return;
  }
  console.warn('[空室確認] 未知のpostback: ' + data);
}

/** 空室確認モード中に届いたメールアドレス。 */
function handleVacancyEmail(replyToken, userId, rawEmail) {
  var email = String(rawEmail || '').trim().toLowerCase();
  // テストユーザーは実データを汚さない（LINE登録メールに行を作らない）。
  // 顧客カードの結びつけは _vacancyLinkByEmail_ 側でもテストユーザーを外している。
  var isTester = false;
  try {
    isTester = (typeof TEST_ALLOWED_NAMES !== 'undefined')
      && TEST_ALLOWED_NAMES.indexOf(_vacancyLineUserName_(userId)) !== -1;
  } catch (_eT) {}
  if (isTester) {
    console.log('[空室確認] テストユーザーのためメールは保存しない: ' + email);
  } else {
    try {
      var saved = saveLineRegisteredEmail(userId, email);
      console.log('[空室確認] メール受領 ' + email + ' / 新規=' + saved);
    } catch (eS) {
      console.warn('[空室確認] LINE登録メール保存失敗: ' + eS.message);
    }
  }
  try {
    var link = _vacancyLinkByEmail_(userId, email);
    console.log('[空室確認] 本人確定: ' + JSON.stringify(link));
  } catch (eL) {
    console.error('[空室確認] 本人確定に失敗: ' + eL.message + '\n' + eL.stack);
  }
  var inqs = _vacancyFindInquiriesByEmails_([email]);
  if (inqs.length > 0) {
    saveState(userId, { step: STEPS.WAITING_VACANCY, data: { vcMode: 'choose', email: email } });
    replyMessage(replyToken, [
      textMsg('ありがとうございます。お問い合わせの記録が見つかりました。'),
      _vacancyChooserMessage_(inqs)
    ]);
    return;
  }
  _vacancyPromptOther_(replyToken, userId,
    'ありがとうございます。\n\n' +
    'お問い合わせの記録が見つからなかったので、\n' +
    'お調べしたいお部屋を教えてください。');
}

/**
 * 空室確認モード中のテキスト。メールアドレスなら本人確定へ、それ以外は物件として受ける。
 * コード.js の WAITING_VACANCY 分岐から呼ばれる。
 */
function handleVacancyText(replyToken, userId, message, state) {
  var m = String(message || '').trim();
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(m)) {
    handleVacancyEmail(replyToken, userId, m);
    return;
  }
  var items = _splitVacancyItems_(m);
  if (items.length === 0) {
    // 相槌・記号だけ → 何もしない（モードは維持）
    console.log('[空室確認] 物件として読めないためスキップ: ' + _shortenForReply_(m));
    return;
  }
  handleVacancyRequest(replyToken, userId, items, { raw: m });
}

// ═══════════════════════════════════════════════════════════
//  本人の特定
// ═══════════════════════════════════════════════════════════

/** LINE Users シートに登録された顧客名（無ければ ''）。プロフィール名にはフォールバックしない。 */
function _vacancyLineUserName_(userId) {
  try {
    var ss = SpreadsheetApp.openById(CRITERIA_SHEET_ID);
    var sh = ss.getSheetByName(LINE_USERS_SHEET_NAME);
    if (!sh || sh.getLastRow() < 2) return '';
    var data = sh.getRange(2, 1, sh.getLastRow() - 1, 2).getValues();
    for (var i = 0; i < data.length; i++) {
      if (String(data[i][0] || '').trim() === String(userId) && data[i][1]) {
        return String(data[i][1]).trim();
      }
    }
  } catch (e) {
    console.warn('_vacancyLineUserName_: ' + e.message);
  }
  return '';
}

/** この LINE ユーザーに結びついているメールアドレス（LINE登録メール ＋ 検索条件シートのAF列）。 */
function _vacancyEmailsForUser_(userId, lineName) {
  var out = [];
  var seen = {};
  function add(e) {
    e = String(e || '').trim().toLowerCase();
    if (e && e.indexOf('@') > 0 && !seen[e]) { seen[e] = true; out.push(e); }
  }
  try {
    var ss = SpreadsheetApp.openById(CRITERIA_SHEET_ID);
    var le = ss.getSheetByName(LINE_EMAIL_SHEET_NAME);
    if (le && le.getLastRow() > 1) {
      var leData = le.getRange(2, 1, le.getLastRow() - 1, 2).getValues();
      for (var i = 0; i < leData.length; i++) {
        if (String(leData[i][1] || '').trim() === String(userId)) add(leData[i][0]);
      }
    }
    if (lineName) {
      var cs = ss.getSheetByName(CRITERIA_SHEET_NAME);
      if (cs && cs.getLastRow() > 1) {
        var rows = cs.getRange(2, 1, cs.getLastRow() - 1, 32).getValues();
        for (var r = 0; r < rows.length; r++) {
          if (String(rows[r][1] || '').trim() === lineName) add(rows[r][31]);
        }
      }
    }
  } catch (e) {
    console.warn('_vacancyEmailsForUser_: ' + e.message);
  }
  return out;
}

function _vacancyEntryContext_(userId) {
  var lineName = _vacancyLineUserName_(userId);
  var emails = _vacancyEmailsForUser_(userId, lineName);
  return {
    lineName: lineName,
    emails: emails,
    identified: !!lineName || emails.length > 0,
    inquiries: emails.length ? _vacancyFindInquiriesByEmails_(emails) : []
  };
}

/**
 * 問い合わせシートから、メールが一致する（メール反響の）物件を新しい順に返す。
 * 同じ建物は1つにまとめる。電話反響はメールが無いので自然に外れる。
 * @return {Array<{renban,building,url,name,at}>}
 */
function _vacancyFindInquiriesByEmails_(emails) {
  var set = {};
  for (var i = 0; i < (emails || []).length; i++) {
    var e = String(emails[i] || '').trim().toLowerCase();
    if (e) set[e] = true;
  }
  if (!Object.keys(set).length) return [];
  var out = [];
  try {
    var ss = SpreadsheetApp.openById(CRITERIA_SHEET_ID);
    var sh = ss.getSheetByName(INQUIRY_SHEET_NAME);
    if (!sh || sh.getLastRow() < 2) return [];
    var data = sh.getRange(2, 1, sh.getLastRow() - 1, INQUIRY_HEADERS.length).getValues();
    for (var r = 0; r < data.length; r++) {
      var em = String(data[r][4] || '').trim().toLowerCase();
      if (!em || !set[em]) continue;
      var building = String(data[r][8] || '').trim();
      if (!building) continue;
      out.push({
        renban: String(data[r][1] || ''),
        building: building,
        url: String(data[r][15] || '').trim(),
        name: String(data[r][2] || '').trim(),
        at: (data[r][0] instanceof Date) ? data[r][0].getTime() : 0
      });
    }
  } catch (e) {
    console.warn('_vacancyFindInquiriesByEmails_: ' + e.message);
    return [];
  }
  out.sort(function (a, b) { return b.at - a.at; });
  var seen = {};
  var dedup = [];
  for (var k = 0; k < out.length; k++) {
    var key = (typeof _mcNormBuilding_ === 'function') ? _mcNormBuilding_(out[k].building) : out[k].building;
    if (seen[key]) continue;
    seen[key] = true;
    dedup.push(out[k]);
    if (dedup.length >= VACANCY_INQUIRY_MAX_BUTTONS) break;
  }
  return dedup;
}

/** 連番で問い合わせ1件を引く（URL付き）。 */
function _vacancyFindInquiryByRenban_(renban) {
  try {
    var ss = SpreadsheetApp.openById(CRITERIA_SHEET_ID);
    var sh = ss.getSheetByName(INQUIRY_SHEET_NAME);
    if (!sh || sh.getLastRow() < 2) return null;
    var key = (typeof _normRenban_ === 'function') ? _normRenban_(renban) : String(renban || '').trim();
    var data = sh.getRange(2, 1, sh.getLastRow() - 1, INQUIRY_HEADERS.length).getValues();
    for (var r = 0; r < data.length; r++) {
      var k = (typeof _normRenban_ === 'function') ? _normRenban_(data[r][1]) : String(data[r][1] || '').trim();
      if (k !== key) continue;
      return {
        renban: String(data[r][1] || ''),
        building: String(data[r][8] || '').trim(),
        url: String(data[r][15] || '').trim(),
        name: String(data[r][2] || '').trim(),
        email: String(data[r][4] || '').trim().toLowerCase()
      };
    }
  } catch (e) {
    console.warn('_vacancyFindInquiryByRenban_: ' + e.message);
  }
  return null;
}

/**
 * メールアドレスで LINE ユーザーと顧客カードを結びつける。
 *   - 検索条件シートにそのメールの行（反響から作られたリード）がある
 *       - LINE 側にまだカードが無い → LINE Users をその名前に向ける
 *       - LINE 側に別名のカードがある → 統合（反響側の名前を残す）
 *   - リード行が無いが問い合わせに名前がある → LINE Users をその名前に向ける
 * テストユーザーは実顧客と混ざらないよう何もしない。
 * @return {{customerName:string, action:string}}
 */
function _vacancyLinkByEmail_(userId, email) {
  email = String(email || '').trim().toLowerCase();
  var lineName = _vacancyLineUserName_(userId);
  if (lineName && typeof TEST_ALLOWED_NAMES !== 'undefined' && TEST_ALLOWED_NAMES.indexOf(lineName) !== -1) {
    console.log('[本人確定] テストユーザーのため紐付けしない: ' + lineName);
    return { customerName: lineName, action: 'test_skip' };
  }
  var ss = SpreadsheetApp.openById(CRITERIA_SHEET_ID);
  var cs = ss.getSheetByName(CRITERIA_SHEET_NAME);
  var leadName = '';
  var lineHasRow = false;
  if (cs && cs.getLastRow() > 1) {
    var rows = cs.getRange(2, 1, cs.getLastRow() - 1, 32).getValues();
    for (var r = 0; r < rows.length; r++) {
      var nm = String(rows[r][1] || '').trim();
      if (!nm) continue;
      if (lineName && nm === lineName) lineHasRow = true;
      if (!leadName && String(rows[r][31] || '').trim().toLowerCase() === email) leadName = nm;
    }
  }

  if (leadName) {
    if (!lineName) {
      saveLineUser(userId, leadName);
      console.log('[本人確定] LINE Users を ' + leadName + ' に紐付け（メール一致）');
      return { customerName: leadName, action: 'linked' };
    }
    if (lineName === leadName) return { customerName: leadName, action: 'already' };
    if (lineHasRow) {
      var res = executeCustomerMerge(leadName, lineName, null);
      if (res && res.success) {
        console.log('[本人確定] 統合: ' + lineName + ' → ' + leadName + '（メール一致）');
        return { customerName: leadName, action: 'merged', detail: lineName };
      }
      console.error('[本人確定] 統合に失敗: ' + (res && res.message));
      return { customerName: lineName, action: 'merge_failed', detail: res && res.message };
    }
    // LINE Users に名前はあるが検索条件の行が無い → 向け直すだけ
    saveLineUser(userId, leadName);
    console.log('[本人確定] LINE Users を ' + lineName + ' から ' + leadName + ' に向け直し');
    return { customerName: leadName, action: 'relinked', detail: lineName };
  }

  // リード行が無い（自動リード化より前の問い合わせなど）
  if (!lineName) {
    var inqs = _vacancyFindInquiriesByEmails_([email]);
    var inqName = (inqs.length && inqs[0].name) ? inqs[0].name : '';
    if (inqName) {
      saveLineUser(userId, inqName);
      console.log('[本人確定] LINE Users を問い合わせ者名 ' + inqName + ' に紐付け');
      return { customerName: inqName, action: 'linked_inquiry' };
    }
  }
  return { customerName: lineName, action: 'none' };
}

// ═══════════════════════════════════════════════════════════
//  メッセージ部品
// ═══════════════════════════════════════════════════════════

function _vacancyChooserMessage_(inqs) {
  var buttons = [];
  for (var i = 0; i < inqs.length; i++) {
    var label = inqs[i].building;
    if (label.length > 20) label = label.substring(0, 19) + '…';
    buttons.push({
      type: 'button', style: 'primary', color: '#6ea814', height: 'sm',
      action: { type: 'postback', label: label, data: 'vc:inq:' + inqs[i].renban, displayText: inqs[i].building }
    });
  }
  buttons.push({
    type: 'button', style: 'secondary', height: 'sm',
    action: { type: 'postback', label: '別の物件を調べる', data: 'vc:other', displayText: '別の物件を調べる' }
  });
  return {
    type: 'flex', altText: '空室確認：確認したい物件をタップしてください',
    contents: {
      type: 'bubble',
      body: {
        type: 'box', layout: 'vertical', spacing: 'sm', paddingAll: 'xl',
        contents: [
          { type: 'text', text: '空室確認', weight: 'bold', size: 'md', color: '#333333' },
          { type: 'text', text: 'お問い合わせいただいた物件をお調べします。\n確認したい物件をタップしてください。',
            size: 'sm', color: '#555555', wrap: true, margin: 'md' }
        ]
      },
      footer: { type: 'box', layout: 'vertical', spacing: 'sm', paddingAll: 'lg', contents: buttons }
    }
  };
}

/**
 * 1通のテキストを物件ごとに分ける。URL は1つずつ、残りは行ごと。
 * 「物件名：…／所在地：…」のようなラベル付き複数行は1件として扱う（従来互換）。
 * @return {Array<{text:string,url:string}>}
 */
function _splitVacancyItems_(raw) {
  raw = String(raw == null ? '' : raw).trim();
  if (!raw) return [];
  var urlRe = /https?:\/\/[^\s<>「」『』()（）]+/g;
  var urls = raw.match(urlRe) || [];
  var rest = raw.replace(urlRe, '\n');
  var lines = rest.split(/\r?\n/).map(function (l) { return l.trim(); }).filter(function (l) { return !!l; });

  var textItems = [];
  var labeled = lines.filter(function (l) { return /^[^:：]{1,20}[:：]/.test(l); }).length;
  if (urls.length === 0 && lines.length >= 2 && labeled * 2 >= lines.length) {
    textItems = [raw];
  } else {
    for (var i = 0; i < lines.length; i++) {
      var l = lines[i];
      var m = l.match(/^[^:：\n]{1,20}[:：]\s*(.+)$/);
      if (m) l = m[1].trim();
      if (!l || l.length < 2) continue;
      // 「1.」「2)」「③」のような番号だけの行は捨てる（「24」「25.5」は面積なので残す）
      if (/^[\d０-９]{1,2}[.．)）、:：]$/.test(l) || /^[①-⑳]$/.test(l)) continue;
      // URLと一緒に添えられた「空いてますか？」のような文は物件ではない
      if (urls.length > 0 && /(ですか|ますか|ください|お願い|でしょうか|[?？。]$)/.test(l)) continue;
      // アプリの「共有」で付いてくるタイトル文（「○○マンション 1K 8.5万円」「【SUUMO】…」）も物件ではない
      if (urls.length > 0 && /(万円|【|】|SUUMO|スーモ|HOME'?S|ホームズ|LIFULL|at ?home|アットホーム)/i.test(l)) continue;
      // URLに添えた「これも」「あと」のようなひらがなだけの行も物件ではない
      if (urls.length > 0 && /^[぀-ゟ\s、。ー〜！？!?]+$/.test(l)) continue;
      if (typeof isVacancyFillerText === 'function' && isVacancyFillerText(l)) continue;
      textItems.push(l);
    }
  }
  var items = [];
  for (var u = 0; u < urls.length; u++) items.push({ url: urls[u], text: '' });
  for (var t = 0; t < textItems.length; t++) items.push({ url: '', text: textItems[t] });
  // ⚠️ 上限を超えた分を黙って捨てないこと (2026-09-19)。
  //   お客様は全部お調べしたと思ったまま、一部の答えしか受け取れなくなる。
  //   何件あふれたかを呼び出し側に伝えて、その場で知らせる。
  var kept = items.slice(0, VACANCY_REQUEST_MAX_ITEMS);
  kept.overflow = Math.max(0, items.length - VACANCY_REQUEST_MAX_ITEMS);
  return kept;
}

// ═══════════════════════════════════════════════════════════
//  物件空室管理シートでの照合
// ═══════════════════════════════════════════════════════════

/**
 * 1件の入力（URL または テキスト）を物件空室管理シートに当てる。
 * 順序は従来どおり SUUMO bc番号 → 面積 → 物件名/所在地/駅の部分一致。
 * @return {{rows:Array<{idx:number,row:Array}>, tooMany:boolean}}
 */
function _matchVacancyRows_(data, q, opts) {
  opts = opts || {};
  var matched = [];
  var seen = {};
  function addRow(i) { if (!seen[i]) { seen[i] = true; matched.push({ idx: i, row: data[i] }); } }

  var bc = extractBcNumber(q);
  if (bc) {
    for (var i = 1; i < data.length; i++) {
      if (String(data[i][9]).indexOf(bc) !== -1) addRow(i);
    }
  }
  var isUrl = /^https?:\/\//.test(q);
  if (matched.length === 0 && !isUrl) {
    var areaNum = extractAreaNumber(q);
    if (areaNum !== null) {
      for (var a = 1; a < data.length; a++) {
        var ar = parseFloat(data[a][7]);
        if (!isNaN(ar) && ar === areaNum) addRow(a);
      }
    }
  }
  if (matched.length === 0 && !isUrl) {
    var queries = [];
    var qWhole = normalizeForMatch(q);
    if (qWhole.length >= 2) queries.push(qWhole);
    var structured = extractStructuredValues(q);
    for (var sv = 0; sv < structured.length; sv++) {
      var qv = normalizeForMatch(structured[sv]);
      if (qv.length >= 2 && queries.indexOf(qv) === -1) queries.push(qv);
    }
    if (queries.length > 0) {
      for (var r = 1; r < data.length; r++) {
        // 建物名(+部屋番号)・所在地・最寄駅 を対象にする。
        // nameOnly のときは建物名だけ。物件ページの題名で当て直すときに使う。
        // 題名は「新宿」のような地名を含むことがあり、所在地や駅に当たると別物件を拾うため。
        var sheetVals = opts.nameOnly
          ? [normalizeForMatch(String(data[r][0]) + String(data[r][1]))]
          : [
              normalizeForMatch(String(data[r][0]) + String(data[r][1])),
              normalizeForMatch(data[r][2]),
              normalizeForMatch(data[r][3])
            ];
        var hit = false;
        for (var qi = 0; qi < queries.length && !hit; qi++) {
          for (var sj = 0; sj < sheetVals.length && !hit; sj++) {
            var s2 = sheetVals[sj];
            if (!s2 || s2.length < 2) continue;
            if (s2.indexOf(queries[qi]) !== -1 || queries[qi].indexOf(s2) !== -1) hit = true;
          }
        }
        if (hit) addRow(r);
      }
    }
  }
  return { rows: matched, tooMany: matched.length > VACANCY_TOO_MANY_HITS };
}

/**
 * 物件ページのURLから物件名を取る。og:title か <title> を読み、サイト名や住所の飾りを落とす。
 * 取れなければ ''（呼び出し側はURLのまま使う）。
 *   SUUMO : 「【SUUMO】グランダジュール八丁堀／東京都中央区入船／八丁堀駅の賃貸…」→「グランダジュール八丁堀」
 *   HOME'S: 「○○マンション 3階の賃貸情報 | LIFULL HOME'S」→「○○マンション 3階」
 */
function _vacancyFetchTitle_(url) {
  try {
    if (typeof _addFetchCount_ === 'function') _addFetchCount_('物件ページ題名', 1);
    var res = UrlFetchApp.fetch(url, {
      muteHttpExceptions: true, followRedirects: true,
      headers: { 'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1' }
    });
    if (res.getResponseCode() !== 200) {
      console.warn('[物件ページ題名] HTTP ' + res.getResponseCode() + ' ' + url);
      return '';
    }
    var html = res.getContentText().substring(0, 200000);
    var t = '';
    var og = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i)
          || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["']/i);
    if (og) t = og[1];
    if (!t) {
      var tt = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
      if (tt) t = tt[1];
    }
    t = String(t || '').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim();
    if (!t) return '';
    t = t.replace(/^【[^】]*】\s*/, '');                         // 【SUUMO】
    t = t.split(/[／|｜]| - /)[0].trim();                           // ／住所… | サイト名
    t = t.replace(/(の賃貸情報|の賃貸・部屋探し情報|の賃貸マンション|の賃貸アパート|の物件情報|の賃貸物件情報|の賃貸)\s*.*$/, '').trim();
    if (t.length > 40) t = t.substring(0, 40);
    return t;
  } catch (e) {
    console.warn('[物件ページ題名] 取得失敗: ' + url + ' / ' + e.message);
    return '';
  }
}

/** 自社シートで当たった物件の募集URL（J列）。無ければ ''。 */
function _vacancyOwnListingUrl_(item) {
  try {
    if (!item.rowIdx || !item.rowIdx.length) return '';
    var data = SpreadsheetApp.openById(PROPERTY_SHEET_ID).getSheetByName(PROPERTY_SHEET_NAME).getDataRange().getValues();
    var row = data[item.rowIdx[0]];
    var u = row && row[9] ? String(row[9]).trim() : '';
    return (u.indexOf('http') === 0) ? u : '';
  } catch (e) {
    return '';
  }
}

function _vacancyRowLabel_(row) {
  return String(row[0]) + (row[1] ? ' ' + row[1] + '号室' : '');
}

function _vacancyRowToBubbleProp_(row, status) {
  var rawUrl = row[9] ? String(row[9]).trim() : '';
  return {
    name: row[0], room: row[1], address: row[2], station: row[3],
    rent: row[4], fee: row[5], layout: row[6], area: row[7],
    status: status || row[8],
    url: (rawUrl && rawUrl.indexOf('http') === 0) ? rawUrl : ''
  };
}

// ═══════════════════════════════════════════════════════════
//  依頼の受付
// ═══════════════════════════════════════════════════════════

/**
 * 物件の一覧を受け取り、自動判定 → 1件で済むなら従来の返し方、
 * それ以外は依頼を作ってスタッフへ（全部自動で判定できたら回答も自動）。
 * @param {Array<{text,url,label?}>} items
 * @param {{fromInquiry?:boolean, raw?:string}} opts
 */
function handleVacancyRequest(replyToken, userId, items, opts) {
  opts = opts || {};
  try {
    var ss = SpreadsheetApp.openById(PROPERTY_SHEET_ID);
    var sheet = ss.getSheetByName(PROPERTY_SHEET_NAME);
    if (!sheet) {
      replyMessage(replyToken, [textMsg('システムエラーが発生しました。担当者にお問い合わせください。')]);
      return;
    }
    var data = sheet.getDataRange().getValues();

    var judged = [];
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      var label = it.label || it.text || it.url;
      var m = _matchVacancyRows_(data, it.url || it.text);

      // URLで当たらなかったときは、手がかりを増やしてもう一度当てる。
      //   ・問い合わせボタン経由なら建物名を持っている（it.text）
      //   ・持っていなければ物件ページの題名を取る
      // SUUMOのURLでも bc 番号が入っていないものがあり、そのままだと自社物件なのに
      // 当たらず、スタッフに回ってしまう（2026-09-16 実際に発生）。
      if (!m.tooMany && m.rows.length === 0 && it.url) {
        var alt = it.text;
        if (!alt) {
          var title = _vacancyFetchTitle_(it.url);
          if (title) { label = title; alt = title; }
        }
        if (alt) {
          var m2 = _matchVacancyRows_(data, alt, { nameOnly: true });
          if (m2.rows.length > 0 || m2.tooMany) m = m2;
        }
      }

      var auto = '';
      var rows = [];
      if (m.tooMany) {
        auto = '';
      } else if (m.rows.length > 0) {
        var avail = [], needs = [], closed = [];
        for (var r = 0; r < m.rows.length; r++) {
          var st = String(m.rows[r].row[8] || '').trim();
          if (st === '募集中') avail.push(m.rows[r]);
          else if (st === '要確認') needs.push(m.rows[r]);
          else closed.push(m.rows[r]);
        }
        if (avail.length) { auto = 'available'; rows = avail; }
        else if (needs.length) { auto = ''; rows = needs; }
        else { auto = 'closed'; rows = closed; }
        if (rows.length) label = _vacancyRowLabel_(rows[0].row);
      }
      judged.push({
        n: i + 1, text: it.text || '', url: it.url || '', label: label,
        auto: auto, tooMany: !!m.tooMany,
        rowIdx: rows.map(function (x) { return x.idx; })
      });
    }

    var needsStaff = judged.some(function (j) { return !j.auto; });

    // 空室確認を最後まで進めた人（メニューを押しただけの人と区別する。NewFriend.js）
    if (typeof markNewFriendState === 'function') markNewFriendState(userId, '空室確認あり');

    // ── 1件・自動判定できた → 従来どおり（物件カード＋遅延返信） ──
    if (items.length === 1 && !needsStaff) {
      clearState(userId);
      _replySingleAutoVacancy_(replyToken, userId, judged[0], data);
      return;
    }
    // ── 1件・テキスト・当たりすぎ → 絞り込みをお願い（従来どおり） ──
    if (items.length === 1 && judged[0].tooMany && !judged[0].url && !opts.fromInquiry) {
      var prev = getState(userId) || {};
      prev.step = STEPS.WAITING_VACANCY;
      prev.data = prev.data || {};
      prev.data.vcMode = 'other';
      saveState(userId, prev);
      replyMessage(replyToken, [textMsgWithQuickReply(
        '「' + _shortenForReply_(items[0].text) + '」で多くの物件が見つかりました。\n\n' +
        '物件名や専有面積でも絞り込めますので、別の条件でもお試しください。',
        [qrMessage('✖️ 中止する', 'キャンセル')]
      )]);
      return;
    }

    // ── 依頼を作る ──
    clearState(userId);
    var customerName = _getLineUserName_(userId);

    // ⚠️ せっかちなお客様が同じ物件を続けて送ると、依頼が2件できてしまう。
    //   片方に答えても、もう片方がDiscordに残り続ける（2026-09-18 実際に発生）。
    //   まだ答えていない同じ内容の依頼があれば、作り直さず受付だけ返す。
    var dup = _findPendingSameRequest_(userId, judged);
    if (dup) {
      console.log('[空室確認依頼] 同じ内容の依頼がまだ未回答のため作りません: ' + dup.id);
      replyMessage(replyToken, [textMsg('承知しました。ただいまお調べしています。\nもうしばらくお待ちください。')]);
      return;
    }

    var req = _createVacancyRequest_(userId, customerName, judged);

    var overflow = (items && items.overflow) || 0;
    var jstHour = getJstHour(new Date());
    var open = (jstHour >= 10 && jstHour < 20);
    // 自社シートに無い物件だけならスタッフがその場で返すので時間の断りは入れない。
    // それ以外（自動判定だけ／自社シートの要確認を含む）は営業時間内のキューに乗るので、時間外ならその旨を添える。
    var immediateReply = needsStaff && _vacancyRequestSendsImmediately_(judged);
    replyMessage(replyToken, [textMsg(
      '承知しました。お調べしてご連絡します。' +
      (overflow > 0
        ? '\n\n一度にお調べできるのは' + VACANCY_REQUEST_MAX_ITEMS + '件までです。'
          + 'はじめの' + VACANCY_REQUEST_MAX_ITEMS + '件をお調べしますので、'
          + '残りの' + overflow + '件はこのあともう一度お送りください。'
        : '') +
      (immediateReply || open ? '' : '\n\n営業時間外のため、翌営業日のご連絡になります。')
    )]);

    if (!needsStaff) {
      // 全部自動で判定できた → 回答を合成してキューへ。スタッフには静かに知らせる
      var answers = judged.map(function (j) { return { n: j.n, answer: j.auto, label: j.label }; });
      var scheduledAt = _finalizeVacancyAnswer_(req, answers, '', '', false);
      _notifyVacancyRequestToDiscord_(req, { autoDone: true, scheduledAt: scheduledAt });
    } else {
      _notifyVacancyRequestToDiscord_(req, {});
    }
    console.log('[空室確認依頼] ' + req.id + ' ' + judged.length + '件 / staff=' + needsStaff);
  } catch (e) {
    console.error('handleVacancyRequest Error: ' + e.message + '\n' + e.stack);
    replyMessage(replyToken, [textMsg('検索中にエラーが発生しました。もう一度お試しください。')]);
  }
}

/** 1件だけ・自動判定できたときの従来の返し方（カード＋遅延返信）。 */
function _replySingleAutoVacancy_(replyToken, userId, j, data) {
  var bubbles = [];
  var unavailable = [];
  for (var i = 0; i < j.rowIdx.length && bubbles.length < 12; i++) {
    var row = data[j.rowIdx[i]];
    bubbles.push(createPropertyBubble(_vacancyRowToBubbleProp_(row)));
    if (String(row[8] || '').trim() !== '募集中') {
      unavailable.push({ name: String(row[0]), room: String(row[1]) });
    }
  }
  replyMessage(replyToken, [{
    type: 'flex', altText: '該当する物件一覧です',
    contents: { type: 'carousel', contents: bubbles }
  }]);
  var enq = 0;
  for (var q = 0; q < unavailable.length; q++) {
    try {
      enqueueDelayedReply(userId, unavailable[q].name, unavailable[q].room);
      enq++;
    } catch (eQ) {
      console.error('[空室確認] 返信キュー追加に失敗: ' + unavailable[q].name + ' ' + unavailable[q].room + ' / ' + eQ.message);
    }
  }
  console.log('[空室確認] 1件自動: ' + bubbles.length + '件ヒット / 自動確認(返信キュー)=' + enq + '/' + unavailable.length);
}

// ═══════════════════════════════════════════════════════════
//  依頼シート
// ═══════════════════════════════════════════════════════════

function _vacancyRequestSheet_() {
  var ss = SpreadsheetApp.openById(CRITERIA_SHEET_ID);
  var sh = ss.getSheetByName(VACANCY_REQUEST_SHEET);
  if (!sh) {
    sh = ss.insertSheet(VACANCY_REQUEST_SHEET);
    sh.appendRow(['依頼ID', 'userId', '顧客名', '受付時刻', '件数', '物件(JSON)', 'ステータス', '回答(JSON)', '回答時刻', '送信予定時刻']);
    try { sh.getRange(1, 1, 1, 10).setFontWeight('bold').setBackground('#e0e0e0'); } catch (_) {}
  }
  return sh;
}

function _createVacancyRequest_(userId, customerName, judged) {
  var now = new Date();
  var id = 'VR' + Utilities.formatDate(now, 'Asia/Tokyo', 'yyMMddHHmmss') + String(Math.floor(Math.random() * 900) + 100);
  var sh = _vacancyRequestSheet_();
  sh.appendRow([id, userId, customerName || '', toJstString(now), judged.length,
    JSON.stringify(judged), 'pending', '', '', '']);
  return { id: id, userId: userId, customerName: customerName || '', receivedAt: toJstString(now), items: judged, status: 'pending' };
}

/**
 * まだ答えていない、同じ内容の依頼を探す。
 * 中身（URLか物件名の並び）が一致し、24時間以内のものだけを重複とみなす。
 */
function _findPendingSameRequest_(userId, judged) {
  try {
    var key = judged.map(function (j) { return (j.url || j.text || '').trim(); }).sort().join('|');
    if (!key) return null;
    var sh = _vacancyRequestSheet_();
    var last = sh.getLastRow();
    if (last < 2) return null;
    var from = Math.max(2, last - 50);   // 直近だけ見る
    var rows = sh.getRange(from, 1, last - from + 1, 7).getValues();
    var cutoff = Date.now() - 24 * 60 * 60 * 1000;
    for (var i = rows.length - 1; i >= 0; i--) {
      if (String(rows[i][1] || '').trim() !== String(userId)) continue;
      if (String(rows[i][6] || '').trim() !== 'pending') continue;
      var at = rows[i][3];
      var ms = (at instanceof Date) ? at.getTime() : Date.parse(String(at).replace(/-/g, '/'));
      if (!ms || ms < cutoff) continue;
      var items = [];
      try { items = JSON.parse(rows[i][5] || '[]'); } catch (_) { continue; }
      var k2 = items.map(function (j) { return (j.url || j.text || '').trim(); }).sort().join('|');
      if (k2 === key) return { id: String(rows[i][0]), rowIndex: from + i };
    }
  } catch (e) {
    console.warn('[空室確認依頼] 重複の確認に失敗: ' + e.message);
  }
  return null;
}

function getVacancyRequest(reqId) {
  var sh = _vacancyRequestSheet_();
  if (sh.getLastRow() < 2) return null;
  var data = sh.getRange(2, 1, sh.getLastRow() - 1, 10).getValues();
  for (var i = 0; i < data.length; i++) {
    if (String(data[i][0]) !== String(reqId)) continue;
    var items = [];
    try { items = JSON.parse(data[i][5] || '[]'); } catch (_) {}
    var answers = null;
    try { answers = data[i][7] ? JSON.parse(data[i][7]) : null; } catch (_) {}
    return {
      rowIndex: i + 2, id: String(data[i][0]), userId: String(data[i][1]), customerName: String(data[i][2] || ''),
      receivedAt: String(data[i][3] || ''), items: items, status: String(data[i][6] || ''),
      answers: answers, answeredAt: String(data[i][8] || ''), scheduledAt: String(data[i][9] || '')
    };
  }
  return null;
}

// ═══════════════════════════════════════════════════════════
//  Discord 依頼
// ═══════════════════════════════════════════════════════════

function _vacancyAnswerFormUrl_(reqId) {
  var webAppUrl = '';
  try { webAppUrl = ScriptApp.getService().getUrl(); } catch (_) {}
  if (!webAppUrl) return '';
  var apiKey = PropertiesService.getScriptProperties().getProperty('REINS_API_KEY') || '';
  return webAppUrl + '?action=vacancy_answer_form&req=' + encodeURIComponent(reqId)
    + '&api_key=' + encodeURIComponent(apiKey);
}

function _vacancyAutoMark_(j) {
  if (j.auto === 'available') return '🟢 募集中（' + j.label + '）※自動判定';
  if (j.auto === 'closed') return '🔴 ご案内不可（' + j.label + '）※自動判定';
  if (j.tooMany) return '❓ 当たりが多すぎて特定できず';
  if (j.rowIdx && j.rowIdx.length) return '❓ 要確認（' + j.label + '）';
  return '❓ 自社シートに無し' + (j.url && j.label && j.label !== j.url ? '（' + j.label + '）' : '');
}

function _notifyVacancyRequestToDiscord_(req, opts) {
  opts = opts || {};
  var sp = PropertiesService.getScriptProperties();
  var webhookUrl = sp.getProperty('DISCORD_WEBHOOK_AVAILABILITY_URL') || sp.getProperty('DISCORD_WEBHOOK_URL');
  if (!webhookUrl) { console.warn('[空室確認依頼] Discord webhook 未設定'); return; }
  var name = req.customerName || '(名前未登録)';
  var lines = [];
  lines.push((opts.autoDone ? '✅ **空室確認（自動回答）** ' : '🔔 **空室確認依頼** ') + req.id);
  lines.push('お客様: ' + name + ' 様（' + req.items.length + '件）');
  lines.push('━━━━━━━━━━━━━━━━');
  for (var i = 0; i < req.items.length; i++) {
    var j = req.items[i];
    var src = j.url ? '<' + j.url + '>' : j.text;
    lines.push(j.n + '. ' + src);
    lines.push('　→ ' + _vacancyAutoMark_(j));
  }
  lines.push('━━━━━━━━━━━━━━━━');
  var formUrl = _vacancyAnswerFormUrl_(req.id);
  if (opts.autoDone) {
    lines.push('全件自動で判定できたので、回答を **'
      + (opts.scheduledAt ? Utilities.formatDate(opts.scheduledAt, 'Asia/Tokyo', 'M月d日 HH:mm') + '以降' : 'しばらくして')
      + '** に自動送信します。');
    if (formUrl) lines.push('変えたいときは [回答フォーム](<' + formUrl + '>) で答え直してください（自動送信の前なら差し替え、後なら追加で届きます）。');
  } else {
    lines.push('お客様にはまだ結果を送っていません。');
    var imm = _vacancyRequestSendsImmediately_(req.items);
    if (formUrl) lines.push('📝 [回答フォームを開く](<' + formUrl + '>) — 全件に 募集中／ご案内不可 を付けて送信'
      + (imm ? 'すると、その場でお客様に届きます（自社シートに無い物件のみのため）。'
             : 'してください。自社シートの要確認物件を含むので、5分置いて営業時間内に届きます。'));
  }
  var content = lines.join('\n');
  var threadName = '🔔 空室確認: ' + name + ' 様';
  var result = { ok: false };
  try {
    // 一時的なエラーや短時間の連続投稿の制限(429)で落ちることがあるので、少し待って最大3回送る。
    // 12:49 の依頼が Discord に届かず、あとから送り直したら 200 だった (2026-09-16)。
    var res = null;
    var silent = !!opts.autoDone;
    for (var attempt = 1; attempt <= 3; attempt++) {
      if (typeof _addFetchCount_ === 'function') _addFetchCount_('Discord', 1);
      res = _postDiscordAdaptive_(webhookUrl, content, threadName, '', silent);
      if (res && res.ok) break;
      console.warn('[空室確認依頼] Discord送信失敗(' + attempt + '回目): HTTP ' + (res && res.code) + ' body=' + (res && res.body));
      // 静かな投稿（flags=4096）が弾かれる宛先もあるので、2回目からは普通の投稿にする
      if (silent) silent = false;
      if (attempt < 3) Utilities.sleep(res && res.code === 429 ? 5000 : 2000);
    }
    if (res && res.ok) console.log('[空室確認依頼] Discord送信成功: ' + req.id);
    else console.error('[空室確認依頼] Discord送信を諦めました: ' + req.id + ' / 回答フォーム: ' + _vacancyAnswerFormUrl_(req.id));
    result = res || result;
  } catch (e) {
    console.error('[空室確認依頼] Discord送信で例外: ' + e.message);
    result = { ok: false, error: e.message };
  }
  return result;
}

/**
 * 【診断用】GASエディタから実行する（VacancyRequest.gs）。
 * 直近の空室確認依頼と、その回答キューの状態をログに出し、
 * 最新の依頼の Discord 通知を送り直して HTTP の結果を出す。
 */
function debugLastVacancyRequests() {
  var sh = _vacancyRequestSheet_();
  var n = sh.getLastRow();
  if (n < 2) { console.log('依頼はまだ1件もありません'); return; }
  var from = Math.max(2, n - 2);
  var rows = sh.getRange(from, 1, n - from + 1, 10).getValues();
  var last = null;
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    console.log('依頼 ' + r[0] + ' / ' + (r[2] || '(名前なし)') + ' / ' + r[3] + ' / ' + r[4] + '件 / status=' + r[6]
      + ' / 回答時刻=' + r[8] + ' / 送信予定=' + r[9]);
    console.log('  物件: ' + r[5]);
    last = r;
  }
  try {
    var q = SpreadsheetApp.openById(CRITERIA_SHEET_ID).getSheetByName(VACANCY_ANSWER_QUEUE_SHEET);
    if (q && q.getLastRow() > 1) {
      var qd = q.getDataRange().getValues();
      for (var k = 1; k < qd.length; k++) {
        if (String(qd[k][2]).indexOf('REQ:') === 0) {
          console.log('キュー ' + qd[k][2] + ' / ' + qd[k][1] + ' / 回答=' + qd[k][4] + ' / 予定=' + qd[k][5] + ' / ' + qd[k][6]);
        }
      }
    } else {
      console.log('空室回答キューは空です');
    }
  } catch (eQ) { console.log('キュー読み取り失敗: ' + eQ.message); }

  var sp = PropertiesService.getScriptProperties();
  console.log('webhook設定: AVAILABILITY=' + (sp.getProperty('DISCORD_WEBHOOK_AVAILABILITY_URL') ? 'あり' : 'なし')
    + ' / DEFAULT=' + (sp.getProperty('DISCORD_WEBHOOK_URL') ? 'あり' : 'なし'));

  var req = getVacancyRequest(last[0]);
  var res = _notifyVacancyRequestToDiscord_(req, {});
  console.log('最新の依頼 ' + req.id + ' のDiscord再送: ' + JSON.stringify(res));
  console.log('回答フォーム: ' + _vacancyAnswerFormUrl_(req.id));
}

// ═══════════════════════════════════════════════════════════
//  回答フォーム（スタッフ用）と回答の確定
// ═══════════════════════════════════════════════════════════

/** doGet: ?action=vacancy_answer_form&req=ID&api_key=... */
function handleVacancyAnswerForm(e) {
  if (!_validateReinsApiKey(e.parameter.api_key)) {
    return HtmlService.createHtmlOutput('<h2>❌ 認証エラー</h2><p>api_keyが不正です。</p>');
  }
  var req = getVacancyRequest(e.parameter.req || '');
  if (!req) {
    return HtmlService.createHtmlOutput('<h2>❌ 依頼が見つかりません</h2><p>' + (e.parameter.req || '') + '</p>');
  }
  var tpl = HtmlService.createTemplateFromFile('VacancyAnswerPage');
  tpl.reqJson = JSON.stringify(req);
  tpl.apiKey = String(e.parameter.api_key || '');
  return tpl.evaluate()
    .setTitle('空室確認の回答 ' + req.id)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/**
 * 回答フォームの送信（google.script.run から）。
 * @param {string} payloadJson {answers:[{n,answer,label}], comment:string, freeText:string}
 */
function submitVacancyAnswerForm(reqId, apiKey, payloadJson) {
  if (!_validateReinsApiKey(apiKey)) return { ok: false, message: 'api_keyが不正です' };
  var req = getVacancyRequest(reqId);
  if (!req) return { ok: false, message: '依頼が見つかりません: ' + reqId };
  var payload;
  try { payload = JSON.parse(payloadJson || '{}'); } catch (_) { return { ok: false, message: '回答を読めません' }; }
  var answers = payload.answers || [];
  var freeText = String(payload.freeText || '').trim();
  if (!freeText) {
    for (var i = 0; i < req.items.length; i++) {
      var a = answers.filter(function (x) { return Number(x.n) === Number(req.items[i].n); })[0];
      if (!a || ['available', 'closed'].indexOf(a.answer) < 0) {
        return { ok: false, message: req.items[i].n + '件目の答えが付いていません' };
      }
    }
  }
  var immediate = _vacancyRequestSendsImmediately_(req.items);
  var sentAt = _finalizeVacancyAnswer_(req, answers, String(payload.comment || '').trim(), freeText, immediate);
  return {
    ok: true,
    immediate: immediate,
    scheduledAt: sentAt ? Utilities.formatDate(sentAt, 'Asia/Tokyo', 'M月d日 HH:mm') : ''
  };
}

/**
 * スタッフの回答をその場で送るか（ユーザー指示 2026-09-16）。
 *   - 自社シートに無い物件だけの依頼 → その場で送る（営業時間も関係なし）
 *   - 自社シートにあるが自動判定できなかった（要確認・当たりすぎ）物件を含む → 従来どおり
 *     5分置いて営業時間内に送る
 */
function _vacancyRequestSendsImmediately_(items) {
  for (var i = 0; i < (items || []).length; i++) {
    var j = items[i];
    if (j.auto) continue;                                   // 自動判定済みは関係ない
    if ((j.rowIdx && j.rowIdx.length) || j.tooMany) return false;  // 自社シートにあるが要確認
  }
  return true;
}

/** 空室回答キューに残っている同じ依頼の未送信分を取り消す（その場で送るとき用）。 */
function _cancelPendingVacancyAnswer_(userId, label) {
  try {
    var sh = SpreadsheetApp.openById(CRITERIA_SHEET_ID).getSheetByName(VACANCY_ANSWER_QUEUE_SHEET);
    if (!sh || sh.getLastRow() < 2) return;
    var data = sh.getDataRange().getValues();
    for (var i = 1; i < data.length; i++) {
      if (String(data[i][6]) === 'pending' && String(data[i][0]) === String(userId) && String(data[i][2]) === label) {
        sh.getRange(i + 1, 7).setValue('replaced');
      }
    }
  } catch (e) {
    console.warn('[空室確認依頼] キュー取り消し失敗: ' + e.message);
  }
}

/**
 * 回答を合成して送り、依頼シートを更新する。
 * immediate=true ならその場で push（スタッフ回答）、false なら空室回答キュー（自動判定）。
 * @return {Date|null} 送信（予定）時刻
 */
function _finalizeVacancyAnswer_(req, answers, comment, freeText, immediate) {
  var messages = _composeVacancyAnswer_(req, answers, comment, freeText);
  var label = 'REQ:' + req.id;
  var scheduledAt;
  if (immediate) {
    _cancelPendingVacancyAnswer_(req.userId, label);
    pushMessage(req.userId, messages);
    scheduledAt = new Date();
    console.log('[空室確認依頼] その場で送信: ' + req.id);
  } else {
    scheduledAt = _sendVacancyAnswer_(req.userId, messages, label, req.customerName);
  }
  try {
    var sh = _vacancyRequestSheet_();
    var row = req.rowIndex;
    if (!row) {
      var fresh = getVacancyRequest(req.id);
      row = fresh ? fresh.rowIndex : 0;
    }
    if (row) {
      sh.getRange(row, 7, 1, 4).setValues([[
        immediate ? 'sent' : 'answered',
        JSON.stringify({ answers: answers, comment: comment || '', freeText: freeText || '' }),
        toJstString(new Date()),
        scheduledAt ? toJstString(scheduledAt) : ''
      ]]);
    }
  } catch (e) {
    console.warn('[空室確認依頼] シート更新失敗: ' + e.message);
  }
  return scheduledAt;
}

/** お客様への返事を1通（＋募集中カード）に合成する。 */
function _composeVacancyAnswer_(req, answers, comment, freeText) {
  var registered = false;
  try { registered = !!readLatestCriteria(req.userId); } catch (_) {}
  var qr = registered ? null : [qrPostback('🏠 条件を登録する', '条件登録', '条件登録')];

  if (freeText) {
    return [qr ? textMsgWithQuickReply(freeText, qr) : textMsg(freeText)];
  }

  var byN = {};
  for (var i = 0; i < (answers || []).length; i++) byN[Number(answers[i].n)] = answers[i];
  var avail = [], closed = [];
  for (var k = 0; k < req.items.length; k++) {
    var it = req.items[k];
    var a = byN[Number(it.n)] || {};
    var label = String(a.label || it.label || it.text || it.url || '').trim();
    if (a.answer === 'available') avail.push({ item: it, label: label });
    else closed.push({ item: it, label: label });
  }

  var messages = [];
  var text;
  if (avail.length > 0) {
    // 物件名の下にURLも付ける（お客様がどの物件か見返せるように）。自社シートの物件は募集URL、
    // それ以外はお客様が送ってきたURL。
    text = 'お待たせいたしました。\nお調べした結果をお知らせします。\n\n【ご紹介できるお部屋】\n'
      + avail.map(function (x) {
          var u = x.item.url || _vacancyOwnListingUrl_(x.item);
          return '・' + x.label + (u && u !== x.label ? '\n' + u : '');
        }).join('\n\n');
    if (closed.length > 0) text += '\n\nそれ以外の物件は、現在ご案内できませんでした。';
    if (comment) text += '\n\n' + comment;
    text += '\n\n気になるお部屋があれば、このままLINEでお知らせください。';
    messages.push(textMsg(text));
    // 自社シートの募集中物件はカードも付ける（申込ボタン付き）
    var bubbles = [];
    try {
      var data = SpreadsheetApp.openById(PROPERTY_SHEET_ID).getSheetByName(PROPERTY_SHEET_NAME).getDataRange().getValues();
      for (var b = 0; b < avail.length && bubbles.length < 10; b++) {
        var idxs = avail[b].item.rowIdx || [];
        for (var c = 0; c < idxs.length && bubbles.length < 10; c++) {
          var row = data[idxs[c]];
          if (row && String(row[8] || '').trim() === '募集中') {
            bubbles.push(createPropertyBubble(_vacancyRowToBubbleProp_(row, '募集中')));
          }
        }
      }
    } catch (eB) { console.warn('[空室確認依頼] カード作成失敗: ' + eB.message); }
    if (bubbles.length) {
      messages.push({ type: 'flex', altText: 'ご紹介できるお部屋', contents: { type: 'carousel', contents: bubbles } });
    }
  } else {
    // 1件だけなら、自動判定のときと同じカードを出す。
    // 自社シートにある物件なら条件を組み立てた2択カード、無ければ「お部屋を探す」の1択カードになる。
    // ⚠️ 以前は文章＋クイックリプライだけで、押される前に消えることがあった (2026-09-18)。
    if (req.items.length === 1 && typeof _buildVacancyUnavailableMessages_ === 'function') {
      var one = req.items[0];
      var lbl = String((byN[Number(one.n)] || {}).label || one.label || one.text || '').trim();
      var nm = lbl, rm = '';
      var mm = lbl.match(/^(.*?)\s*([0-9A-Za-z\-]+)\s*号室$/);
      if (mm) { nm = mm[1].trim(); rm = mm[2]; }
      try {
        var card = _buildVacancyUnavailableMessages_(req.userId, lbl || nm, nm, rm);
        if (card && card.length) {
          if (comment) messages.push(textMsg(comment));
          return messages.concat(card);
        }
      } catch (eC) { console.warn('[空室確認依頼] カードを作れず文章で返します: ' + eC.message); }
    }
    text = 'お待たせいたしました。\nお送りいただいた物件は、いずれも現在ご案内できませんでした。';
    if (comment) text += '\n\n' + comment;
    text += registered
      ? '\n\n引き続き、ご希望の条件に合うお部屋が見つかり次第ご案内いたします。'
      : '\n\nご希望の条件を登録いただければ、近いお部屋が出た時にすぐお知らせします。';
    messages.push(qr ? textMsgWithQuickReply(text, qr) : textMsg(text));
  }
  return messages;
}

// ═══════════════════════════════════════════════════════════
//  確認用（GASエディタ・VacancyRequest.gs から実行）
// ═══════════════════════════════════════════════════════════

/**
 * 「条件登録済み」の判定が正しいかを、実データで数えて確かめる。読み取りだけで何も書き換えない。
 *
 * 2026-09-16 の不具合の確認用。空室確認でメールから顧客カードを結びつけるようにしたため、
 * 条件が何も入っていないリード行しか持たない人でも LINE Users に行ができるようになった。
 * readLatestCriteria がそれを「登録済み」と返していたので、初問い合わせの人に
 * 条件登録の誘導が出なくなっていた。直っていれば「条件なし」の人が下に並ぶ。
 */
function diagnoseRegisteredJudgement() {
  var ss = SpreadsheetApp.openById(CRITERIA_SHEET_ID);
  var lu = ss.getSheetByName(LINE_USERS_SHEET_NAME);
  var cs = ss.getSheetByName(CRITERIA_SHEET_NAME);
  if (!lu || !cs || lu.getLastRow() < 2 || cs.getLastRow() < 2) {
    console.log('シートが読めません');
    return;
  }
  // 顧客名ごとに「条件の入った行を持っているか」を1回のシート読みで作る
  var rows = cs.getRange(2, 1, cs.getLastRow() - 1, cs.getLastColumn()).getValues();
  var hasCriteria = {};
  var hasAnyRow = {};
  for (var r = 0; r < rows.length; r++) {
    var nm = String(rows[r][1] || '').trim();
    if (!nm) continue;
    hasAnyRow[nm] = true;
    if (_rowHasCriteria_(rows[r])) hasCriteria[nm] = true;
  }

  var luData = lu.getRange(2, 1, lu.getLastRow() - 1, 2).getValues();
  var registered = [], leadOnly = [], noRow = [];
  var seen = {};
  for (var i = 0; i < luData.length; i++) {
    var uid = String(luData[i][0] || '').trim();
    var name = String(luData[i][1] || '').trim();
    if (!uid || !name || seen[uid]) continue;
    seen[uid] = true;
    if (hasCriteria[name]) registered.push(name);
    else if (hasAnyRow[name]) leadOnly.push(name);
    else noRow.push(name);
  }

  console.log('LINE Users ' + Object.keys(seen).length + '人');
  console.log('  条件あり（登録済みとして扱う）: ' + registered.length + '人');
  console.log('  条件なしのリード行だけ（未登録として扱う）: ' + leadOnly.length + '人');
  if (leadOnly.length) console.log('    ' + leadOnly.slice(0, 30).join(' / '));
  console.log('  検索条件シートに行が無い: ' + noRow.length + '人');
  if (noRow.length) console.log('    ' + noRow.slice(0, 30).join(' / '));

  // 本物の readLatestCriteria と食い違っていないか、両方から数人ずつ実際に呼んで確かめる
  console.log('--- readLatestCriteria の実測（数人だけ）---');
  var samples = [];
  for (var s2 = 0; s2 < luData.length && samples.length < 6; s2++) {
    var u2 = String(luData[s2][0] || '').trim();
    var n2 = String(luData[s2][1] || '').trim();
    if (!u2 || !n2) continue;
    var want = !!hasCriteria[n2];
    if (samples.filter(function (x) { return x.want === want; }).length >= 3) continue;
    samples.push({ uid: u2, name: n2, want: want });
  }
  for (var s3 = 0; s3 < samples.length; s3++) {
    var got = false;
    try { got = !!readLatestCriteria(samples[s3].uid); } catch (_) {}
    console.log((got === samples[s3].want ? '  OK  ' : '  ちがう ') + samples[s3].name
      + ' 期待=' + (samples[s3].want ? '登録済み' : '未登録')
      + ' 実際=' + (got ? '登録済み' : '未登録'));
  }
}
