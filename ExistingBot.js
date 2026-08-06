/**
 * ExistingBot.gs - 既存ボット機能の移植
 *
 * 元の「自動返信」プロジェクト (コード.gs) の機能:
 *   1. 専有面積検索: 数字送信 → スプレッドシートから面積一致物件をFlexで返信
 *   2. 入居申込フロー: 個人/法人 → 国籍 → 名前 → フリガナ → 入居日 → メール
 *
 * PROPERTY_SHEET_ID / PROPERTY_SHEET_NAME を参照。
 */

// ══════════════════════════════════════════════════════════
//  Postback ハンドラー（入居申込フロー）
// ══════════════════════════════════════════════════════════

/**
 * 既存ボットの Postback を処理する。
 * @param {string} replyToken
 * @param {string} userId
 * @param {string} data - postback data
 * @param {Object} state - 現在の状態
 * @param {Object} event - LINE event (datetimepicker用)
 * @return {boolean} 処理したかどうか
 */
function handleExistingPostback(replyToken, userId, data, state, event) {
  // 申込開始 → 種別選択
  if (data.startsWith('apply|')) {
    const newState = { step: STEPS.EXISTING_WAITING_TYPE, data: {}, selectedRoutes: [], selectedCompany: '', updatedAt: Date.now() };
    saveState(userId, newState);
    replyMessage(replyToken, [{
      type: 'template',
      altText: '申込種別を選択してください',
      template: {
        type: 'buttons',
        text: '申込種別を選択してください',
        actions: [
          { type: 'postback', label: '個人', data: 'type|individual', displayText: '個人' },
          { type: 'postback', label: '法人', data: 'type|corporate', displayText: '法人' }
        ]
      }
    }]);
    return true;
  }

  // 種別選択 → 国籍へ
  if (data.startsWith('type|')) {
    const newState = { step: STEPS.EXISTING_WAITING_NATIONALITY, data: {}, selectedRoutes: [], selectedCompany: '', updatedAt: Date.now() };
    saveState(userId, newState);
    replyMessage(replyToken, [{
      type: 'template',
      altText: '国籍を選択してください',
      template: {
        type: 'buttons',
        text: '国籍を選択してください',
        actions: [
          { type: 'postback', label: '日本国籍', data: 'nation|jp', displayText: '日本国籍' },
          { type: 'postback', label: '外国籍', data: 'nation|other', displayText: '外国籍' }
        ]
      }
    }]);
    return true;
  }

  // 国籍選択 → 名前入力へ
  if (data.startsWith('nation|')) {
    const newState = { step: STEPS.EXISTING_WAITING_NAME, data: {}, selectedRoutes: [], selectedCompany: '', updatedAt: Date.now() };
    saveState(userId, newState);
    replyMessage(replyToken, [textMsg('ご契約名義人になる方のお名前（フルネーム）を教えてください。')]);
    return true;
  }

  // 入居希望日（カレンダー）からの受信
  if (state.step === STEPS.EXISTING_WAITING_MOVEIN && event.postback && event.postback.params && event.postback.params.date) {
    const selectedDate = event.postback.params.date;
    const newState = { step: STEPS.EXISTING_WAITING_EMAIL, data: {}, selectedRoutes: [], selectedCompany: '', updatedAt: Date.now() };
    saveState(userId, newState);
    replyMessage(replyToken, [textMsg('入居希望日：' + selectedDate + '\n\n申し込み用フォームをお送りします。\n受信するメールアドレスをご入力ください。')]);
    return true;
  }

  return false;
}

// ══════════════════════════════════════════════════════════
//  テキストメッセージハンドラー（入居申込 + 面積検索）
// ══════════════════════════════════════════════════════════

/**
 * 既存ボットのテキストメッセージを処理する。
 * @param {string} replyToken
 * @param {string} userId
 * @param {string} message
 * @param {Object} state
 * @return {boolean} 処理したかどうか
 */
function handleExistingText(replyToken, userId, message, state) {
  // ── 入居申込フロー（テキスト入力ステップ） ──

  // お名前入力 → フリガナへ
  if (state.step === STEPS.EXISTING_WAITING_NAME) {
    const newState = { step: STEPS.EXISTING_WAITING_FURIGANA, data: {}, selectedRoutes: [], selectedCompany: '', updatedAt: Date.now() };
    saveState(userId, newState);
    replyMessage(replyToken, [textMsg('フリガナを教えてください。')]);
    return true;
  }

  // フリガナ入力 → 入居希望日へ
  if (state.step === STEPS.EXISTING_WAITING_FURIGANA) {
    const newState = { step: STEPS.EXISTING_WAITING_MOVEIN, data: {}, selectedRoutes: [], selectedCompany: '', updatedAt: Date.now() };
    saveState(userId, newState);
    replyMessage(replyToken, [{
      type: 'template',
      altText: '入居希望日を選択してください',
      template: {
        type: 'buttons',
        text: '入居希望日を選択してください',
        actions: [
          {
            type: 'datetimepicker',
            label: '日付を選ぶ',
            data: 'movein_date',
            mode: 'date'
          }
        ]
      }
    }]);
    return true;
  }

  // メールアドレス入力 → 完了
  if (state.step === STEPS.EXISTING_WAITING_EMAIL) {
    const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (emailPattern.test(message)) {
      clearState(userId);
      replyMessage(replyToken, [textMsg('スタッフが確認し申し込みフォームをお送りいたしますので、お待ちください。')]);
      return true;
    }
    // メール形式でない場合は再入力を促す
    replyMessage(replyToken, [textMsg('正しいメールアドレスを入力してください。\n例: example@email.com')]);
    return true;
  }

  // 数字単独入力での自動面積検索は廃止（空室確認モード経由のみ受付）
  return false;
}

// ══════════════════════════════════════════════════════════
//  空室確認クエリ（state=WAITING_VACANCY 中のみ呼ばれる）
// ══════════════════════════════════════════════════════════

/** NFKC正規化＋空白記号除去（建物名・住所マッチ用） */
function normalizeForMatch(s) {
  if (s == null) return '';
  return String(s).normalize('NFKC')
    .replace(/[\s\u3000・\-－ｰ()（）,，.。、]/g, '')
    .toUpperCase();
}

/**
 * ラベル付き複数行入力 (例:「物件名：VIVACE301\n所在地：...\n最寄駅：...」) から
 * ラベル部分を除去して各値だけを抽出する。
 * 全角/半角コロン両対応。 ラベル無しの行はそのまま値として採用。
 *
 * @param {string} raw - ユーザー入力
 * @returns {string[]} 抽出された値の配列 (順序維持)
 */
function extractStructuredValues(raw) {
  if (!raw) return [];
  var lines = String(raw).split(/\r?\n/);
  var values = [];
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i].trim();
    if (!line) continue;
    // 「ラベル：値」 形式 (ラベル長は 20 文字以内、 値部分にコロンが含まれてもOK)
    var m = line.match(/^[^:：\n]{1,20}[:：]\s*(.+)$/);
    values.push(m ? m[1].trim() : line);
  }
  return values;
}

/**
 * 空室確認の入力として無視すべき相槌・お礼・挨拶のみのメッセージか判定する。
 *
 * 2026-07-31 の事故:
 *   お客様が SUUMO URL を送って物件がヒットした直後に「おねがいします」と送信。
 *   これが物件名として検索され 0 件 →「該当する物件が見つかりませんでした」が
 *   ヒット通知の直後に届き、矛盾したメッセージになった。
 *
 * 該当した場合は検索も返信もせず、state もそのまま維持する（スタッフが手動返信する）。
 */
var VACANCY_FILLER_TEXTS = [
  // 依頼・お願い
  'おねがい', 'おねがいします', 'おねがいいたします', 'おねがいします',
  'お願い', 'お願いします', 'お願いいたします', 'お願い致します',
  'よろしく', 'よろしくです', 'よろしくおねがいします', 'よろしくおねがいいたします',
  'よろしくお願いします', 'よろしくお願いいたします', 'よろしくお願い致します',
  '宜しくお願いします', '宜しくお願いいたします', '宜しくお願い致します',
  // お礼
  'ありがとう', 'ありがとうございます', 'ありがとうございました', 'ありがとうです',
  'たすかります', '助かります',
  // 相槌・了承
  'はい', 'うん', 'ok', 'おk', 'おけ',
  '了解', '了解です', 'りょうかい', 'りょうかいです',
  'わかりました', '分かりました', '承知しました', '承知です', 'かしこまりました',
  '大丈夫です', 'だいじょうぶです',
  // 謝罪・挨拶
  'すみません', 'すいません', 'ごめんなさい',
  'こんにちは', 'こんばんは', 'おはよう', 'おはようございます', 'はじめまして',
  'お世話になります', 'お世話になっております'
];

function isVacancyFillerText(raw) {
  if (raw == null) return false;
  // NFKC正規化 → 空白・句読点・記号・絵文字まわりを除去して素の語だけにする
  var n = String(raw).normalize('NFKC')
    .replace(/[\s　]/g, '')
    .replace(/[!！?？。、．，,.~〜ー…\-‐−ｰ()（）「」『』]/g, '')
    .toLowerCase();
  if (!n) return true;           // 空・記号のみ → 検索しない
  if (n.length > 20) return false; // 長文は本文が入っている可能性が高いので検索へ回す
  for (var i = 0; i < VACANCY_FILLER_TEXTS.length; i++) {
    var f = String(VACANCY_FILLER_TEXTS[i]).normalize('NFKC')
      .replace(/[\s　]/g, '').toLowerCase();
    if (n === f) return true;
  }
  return false;
}

/** 返信文にお客様の入力をそのまま載せるとURL等で長くなるので短く丸める */
function _shortenForReply_(raw) {
  var s = String(raw == null ? '' : raw).replace(/[\r\n]+/g, ' ').trim();
  return s.length > 30 ? s.substring(0, 30) + '…' : s;
}

/** 入力から面積を抽出（「24」「24.32」「24m²」「24㎡」「24平米」等に対応） */
function extractAreaNumber(message) {
  if (message == null) return null;
  var n = String(message).normalize('NFKC').trim();
  var m = n.match(/^(\d{1,3}(?:\.\d{1,2})?)\s*(?:m2|m²|㎡|平米|平方メートル)?$/i);
  if (m) return parseFloat(m[1]);
  return null;
}

/** 入力からSUUMO bc番号を抽出 */
function extractBcNumber(message) {
  if (!message) return null;
  var m = String(message).match(/bc[_=](\d+)/i);
  return m ? m[1] : null;
}

/**
 * 空室確認クエリを処理する。state=WAITING_VACANCY 中のみ呼ばれる。
 * 入力種別: SUUMO URL/bc番号 / 面積数値 / 物件名・部屋番号・所在地・最寄駅 のテキスト
 */
function handleVacancyQuery(replyToken, userId, raw) {
  try {
    // 相槌・お礼だけのメッセージ（「おねがいします」等）は物件名ではないので検索しない。
    // 返信もせず state も維持する（ミスカウントも増やさない）。
    if (isVacancyFillerText(raw)) {
      console.log('[空室確認] 相槌のため検索スキップ: ' + raw);
      return;
    }
    var ss = SpreadsheetApp.openById(PROPERTY_SHEET_ID);
    var sheet = ss.getSheetByName(PROPERTY_SHEET_NAME);
    if (!sheet) {
      replyMessage(replyToken, [textMsg('システムエラーが発生しました。担当者にお問い合わせください。')]);
      return;
    }
    var data = sheet.getDataRange().getValues();
    var matched = [];
    var seen = {};
    var addRow = function(row, idx) { if (!seen[idx]) { seen[idx] = true; matched.push(row); } };

    // 1. SUUMO URL / bc番号
    var bc = extractBcNumber(raw);
    if (bc) {
      for (var i = 1; i < data.length; i++) {
        if (String(data[i][9]).indexOf(bc) !== -1) addRow(data[i], i);
      }
    }

    // 2. 面積（完全一致）
    if (matched.length === 0) {
      var areaNum = extractAreaNumber(raw);
      if (areaNum !== null) {
        for (var i = 1; i < data.length; i++) {
          var a = parseFloat(data[i][7]);
          if (!isNaN(a) && a === areaNum) addRow(data[i], i);
        }
      }
    }

    // 3. 自由テキスト（物件名+部屋番号 / 所在地 / 最寄駅 を全部対象に部分一致）
    //
    // ⚠️ 双方向の包含チェック (2026-05-07 修正):
    //   旧: nameRoom.indexOf(q) のみ = 「シート値の中に入力全体が含まれるか」
    //       → ユーザーが「物件名：VIVACE301\n最寄り駅：...\n所在地：...」 のような
    //         ラベル付き複数行で送ると、 入力がシート値より長くて絶対にマッチしない
    //   新: 双方向 (シート値 ⊆ 入力) もチェック
    //       → 入力に「VIVACE301」 が含まれていればシートの「VIVACE301」 にマッチ
    //
    // 加えて、 ラベル付き複数行入力は extractStructuredValues で各値を抽出し、
    // 個別に検索することで誤検知 (例: ラベル文字「物件名」 が他物件にマッチ) を防ぐ。
    if (matched.length === 0) {
      var queries = [];
      // (a) 入力全体を 1 つの query として
      var qWhole = normalizeForMatch(raw);
      if (qWhole.length >= 2) queries.push(qWhole);
      // (b) ラベル付き複数行入力 → 各値も個別 query に追加
      var structuredValues = extractStructuredValues(raw);
      for (var sv = 0; sv < structuredValues.length; sv++) {
        var qv = normalizeForMatch(structuredValues[sv]);
        if (qv.length >= 2 && queries.indexOf(qv) === -1) queries.push(qv);
      }

      if (queries.length > 0) {
        for (var i = 1; i < data.length; i++) {
          var nameRoom = normalizeForMatch(String(data[i][0]) + String(data[i][1]));
          var addr = normalizeForMatch(data[i][2]);
          var stn  = normalizeForMatch(data[i][3]);
          var sheetVals = [nameRoom, addr, stn];
          var hit = false;
          for (var qi = 0; qi < queries.length && !hit; qi++) {
            var q = queries[qi];
            for (var sj = 0; sj < sheetVals.length && !hit; sj++) {
              var sv2 = sheetVals[sj];
              if (!sv2 || sv2.length < 2) continue;
              // 双方向の包含チェック
              if (sv2.indexOf(q) !== -1 || q.indexOf(sv2) !== -1) hit = true;
            }
          }
          if (hit) addRow(data[i], i);
        }
      }
    }

    // 0件 → 1回で空室確認モードを終了し、やり直しボタンを提示する。
    //
    // 2026-07-31 変更: 以前は「3回外したら自動終了」だったが
    //   - お客様には同じ案内が繰り返されるだけでループ感がある
    //   - 回数を稼ぐ間ずっと空室確認モードが生きるため、その後に届いた
    //     無関係なメッセージまで検索クエリとして拾い、
    //     「該当する物件が見つかりませんでした」を返してしまう
    // ため1回で終了に変更。やり直しはボタン（＝明示的な再開）で行う。
    if (matched.length === 0) {
      clearState(userId);
      replyMessage(replyToken, [textMsgWithQuickReply(
        '「' + _shortenForReply_(raw) + '」では該当する物件が見つかりませんでした。\n\n' +
        'もう一度お調べする場合は、下のボタンをタップしてください。',
        [qrMessage('🏠 もう一度空室確認', '空室確認')]
      )]);
      return;
    }

    // 件数超過 → 件数のみ返して絞込誘導（絞り込み中なのでモードは継続。期限は延長する）
    if (matched.length > 12) {
      var prevState2 = getState(userId) || {};
      prevState2.step = STEPS.WAITING_VACANCY;
      prevState2.data = prevState2.data || {};
      delete prevState2.data.vacancyMissCount;  // 旧カウンタの残骸を掃除
      prevState2.data.vacancyExpireAt = Date.now() + VACANCY_MODE_TTL_MS;
      saveState(userId, prevState2);
      replyMessage(replyToken, [textMsgWithQuickReply(
        '「' + _shortenForReply_(raw) + '」で' + matched.length + '件見つかりました。\n\n' +
        '物件名や専有面積でも絞り込めますので、別の条件でもお試しください。',
        [qrMessage('✖️ 中止する', 'キャンセル')]
      )]);
      return;
    }

    // ヒット確定 → この時点で空室確認モードを抜ける。
    // ⚠️ 返信・キュー追加・Discord通知(最大3回リトライ)の後に解除していたため、
    //    その数十秒の間に届いた次のメッセージがまだ空室確認モード扱いで検索に回り、
    //    「該当する物件が見つかりませんでした」が誤送信された (2026-07-31 事故)。
    //    以降で例外が出ても state が残らないという副次的な利点もある。
    clearState(userId);

    // ヒット → Flex Carousel 返信
    var bubbles = [];
    var unavailable = [];
    var requiresStaffCheck = [];  // ステータス「要確認」物件 → スタッフ向けDiscordに通知
    for (var i = 0; i < matched.length; i++) {
      var row = matched[i];
      var rawUrl = row[9] ? String(row[9]).trim() : '';
      bubbles.push(createPropertyBubble({
        name: row[0], room: row[1], address: row[2], station: row[3],
        rent: row[4], fee: row[5], layout: row[6], area: row[7], status: row[8],
        url: (rawUrl && rawUrl.indexOf('http') === 0) ? rawUrl : ''
      }));
      // 「要確認」はスタッフの手動確認待ち。自動「ご案内不可」を送るとスタッフ未対応でも
      // 顧客に募集終了が飛んでしまうため、遅延返信(ご案内不可)キューには入れない。
      if (row[8] !== '募集中' && String(row[8]).trim() !== '要確認') {
        unavailable.push({ name: String(row[0]), room: String(row[1]) });
      }
      // 「要確認」= 自動で空室確認できない物件(REINS等)。スタッフに手動確認を依頼する。
      if (String(row[8]).trim() === '要確認') {
        requiresStaffCheck.push({
          name: String(row[0]), room: String(row[1]),
          address: String(row[2]), station: String(row[3]),
          rent: String(row[4]), layout: String(row[6]), area: String(row[7]),
          vacancyUrl: row[12] ? String(row[12]).trim() : ''  // M列: 空室確認URL(REINS物件番号検索リンク等)
        });
      }
    }
    replyMessage(replyToken, [{
      type: 'flex', altText: '該当する物件一覧です',
      contents: { type: 'carousel', contents: bubbles }
    }]);

    // 非募集中物件は遅延返信キューに追加
    for (var q2 = 0; q2 < unavailable.length; q2++) {
      enqueueDelayedReply(userId, unavailable[q2].name, unavailable[q2].room);
    }

    // 「要確認」物件は自動確認できないため、スタッフ向けDiscordに空室確認依頼を通知
    if (requiresStaffCheck.length > 0) {
      try {
        _notifyVacancyCheckRequestToDiscord_(_getLineUserName_(userId), userId, requiresStaffCheck);
      } catch (eDiscord) {
        console.error('要確認Discord通知エラー: ' + eDiscord.message);
      }
    }
    // ※ state解除は検索ヒット直後に実施済み（上記コメント参照）
  } catch (e) {
    console.error('handleVacancyQuery Error: ' + e.message + '\n' + e.stack);
    replyMessage(replyToken, [textMsg('検索中にエラーが発生しました。もう一度お試しください。')]);
  }
}

/**
 * LINE userId から表示名を取得する（LINE Usersシートの顧客名 → LINEプロフィール名）。
 * @param {string} userId
 * @return {string} 表示名（取得できなければ空文字）
 */
function _getLineUserName_(userId) {
  var userName = '';
  try {
    var ss = SpreadsheetApp.openById(CRITERIA_SHEET_ID);
    var luSheet = ss.getSheetByName(LINE_USERS_SHEET_NAME);
    if (luSheet) {
      var luData = luSheet.getDataRange().getValues();
      for (var j = 1; j < luData.length; j++) {
        if (luData[j][0] === userId && luData[j][1]) {
          userName = luData[j][1];
          break;
        }
      }
    }
    if (!userName) {
      var profile = getLineProfile(userId);
      userName = profile ? profile.displayName : '';
    }
  } catch (e) {
    console.error('_getLineUserName_ エラー: ' + e.message);
  }
  return userName;
}

/**
 * ステータス「要確認」物件の空室確認依頼をスタッフ向けDiscordに通知する。
 * 自動で空室確認できない物件(REINS等)に、お客さんから公式LINEで空室確認依頼が
 * 来たときに呼ぶ。M列の空室確認URL(REINS物件番号検索リンク)を含めるので、
 * スタッフはクリックして物件番号検索→詳細表示できる。
 * @param {string} userName - 依頼したお客さんの表示名
 * @param {Array<{name,room,address,station,rent,layout,area,vacancyUrl}>} props
 */
function _notifyVacancyCheckRequestToDiscord_(userName, userId, props) {
  if (!props || props.length === 0) return;
  var sp = PropertiesService.getScriptProperties();
  var webhookUrl = sp.getProperty('DISCORD_WEBHOOK_AVAILABILITY_URL')
                || sp.getProperty('DISCORD_WEBHOOK_URL');
  if (!webhookUrl) {
    console.warn('[要確認通知] Discord webhook 未設定のためスキップ');
    return;
  }
  var webAppUrl = '';
  try { webAppUrl = ScriptApp.getService().getUrl(); } catch (_) {}
  var apiKey = sp.getProperty('REINS_API_KEY') || '';
  var lines = [];
  lines.push('🔔 **空室確認依頼（要確認物件）**');
  lines.push('お客様: ' + (userName || '(不明)') + ' 様 が空室確認を希望しています。');
  lines.push('━━━━━━━━━━━━━━━━');
  for (var i = 0; i < props.length; i++) {
    var p = props[i];
    lines.push('**' + p.name + ' ' + (p.room || '') + '号室**');
    if (p.address) lines.push('所在地: ' + p.address + (p.station ? '（' + p.station + '駅）' : ''));
    var spec = [];
    if (p.rent) spec.push('賃料 ' + p.rent + '万円');
    if (p.layout) spec.push(p.layout);
    if (p.area) spec.push(p.area + 'm²');
    if (spec.length) lines.push(spec.join(' / '));
    if (p.vacancyUrl) lines.push('📋 物件番号検索: <' + p.vacancyUrl + '>');
    // スタッフ返信ボタン: クリックするとお客様にLINEで結果を自動返信する
    if (webAppUrl) {
      var baseUrl = webAppUrl + '?action=staff_reply_vacancy'
        + '&user_id=' + encodeURIComponent(userId || '')
        + '&building=' + encodeURIComponent(p.name || '')
        + '&room=' + encodeURIComponent(p.room || '')
        + '&api_key=' + encodeURIComponent(apiKey);
      lines.push('🟢 [このお客様に「募集中」と返信](<' + baseUrl + '&status=available>)');
      lines.push('🔴 [このお客様に「ご案内不可」と返信](<' + baseUrl + '&status=closed>)');
    }
    lines.push('');
  }
  lines.push('→ 元付業者に確認のうえ、上のボタンでお客様にLINE返信してください。');
  var payload = { content: lines.join('\n') };
  try {
    _sendDiscordWithRetry_(webhookUrl, payload, 3);
  } catch (e) {
    console.error('[要確認通知] Discord送信失敗: ' + e.message);
  }
}

/**
 * スタッフがDiscordで選んだ空室確認結果を、お客さんにLINEで返信する。
 * staff_reply_vacancy ハンドラ(コード.js)から呼ばれる。
 * 物件は「物件空室管理」シートを物件名+部屋番号で再検索して取得する。
 * @param {string} userId - お客さんのLINE userId
 * @param {string} building - 物件名
 * @param {string} room - 部屋番号
 * @param {string} status - 'available'(募集中) | 'closed'(ご案内不可)
 * @return {{ok:boolean, message?:string, displayName?:string}}
 */
function _replyVacancyResultToCustomer_(userId, building, room, status) {
  if (!userId) return { ok: false, message: 'user_id が空です' };
  var ss = SpreadsheetApp.openById(PROPERTY_SHEET_ID);
  var sheet = ss.getSheetByName(PROPERTY_SHEET_NAME);
  if (!sheet) return { ok: false, message: '物件空室管理シートが見つかりません' };
  var data = sheet.getDataRange().getValues();
  var bN = normalizeForMatch(building);
  var rN = normalizeForMatch(room);
  var found = null;
  for (var i = 1; i < data.length; i++) {
    if (normalizeForMatch(String(data[i][0])) === bN
        && normalizeForMatch(String(data[i][1] || '')) === rN) {
      found = data[i];
      break;
    }
  }
  if (!found) return { ok: false, message: '物件が見つかりません: ' + building + ' ' + room };

  var displayName = String(found[0]) + (found[1] ? ' ' + found[1] + '号室' : '');

  if (status === 'available') {
    // 募集中 → 申込ボタン付きFlex（createPropertyBubble 流用）
    var rawUrl = found[9] ? String(found[9]).trim() : '';
    var url = (rawUrl && rawUrl.indexOf('http') === 0) ? rawUrl : '';
    var bubble = createPropertyBubble({
      name: found[0], room: found[1], address: found[2], station: found[3],
      rent: found[4], fee: found[5], layout: found[6], area: found[7],
      status: '募集中', url: url
    });
    pushMessage(userId, [
      { type: 'text', text: 'お待たせいたしました。\n「' + displayName + '」は現在【募集中】です！\nぜひご検討ください。' },
      { type: 'flex', altText: '「' + displayName + '」は募集中です', contents: bubble }
    ]);
  } else {
    // ご案内不可 → 「ご案内が難しい」+ 条件登録誘導（遅延返信と共通の文面）
    pushMessage(userId, _buildVacancyUnavailableMessages_(userId, displayName, String(found[0]), String(found[1] || '')));
  }
  return { ok: true, displayName: displayName };
}

/**
 * 物件Flex Bubbleを作成する。
 * @param {Object} p - 物件データ
 * @return {Object} Flex Bubble
 */
function createPropertyBubble(p) {
  var nm = (p.name != null ? String(p.name) : '');
  var rm = (p.room != null ? String(p.room) : '');
  var ad = (p.address != null ? String(p.address) : '');
  var st = (p.station != null ? String(p.station) : '');
  var rn = (p.rent != null ? String(p.rent) : '---');
  var fe = (p.fee != null ? String(p.fee) : '---');
  var ly = (p.layout != null ? String(p.layout) : '---');
  var ar = (p.area != null ? String(p.area) : '---');

  // 営業時間判定
  var _now = new Date();
  var _jstHour = (typeof getJstHour === 'function') ? getJstHour(_now) : _now.getUTCHours() + 9;
  var _isOpen = (_jstHour >= 10 && _jstHour < 20);

  // ヘッダー: 共通で「お問い合わせありがとうございます」
  var _headerBg = '#1a7f37';

  // ステータスメッセージ（物件情報の下に表示）
  var _statusBox = null;
  if (p.status !== '募集中') {
    var _statusLine = _isOpen ? 'スタッフが確認中です' : 'お問い合わせを受け付けました';
    var _isNeedsCheck = (String(p.status).trim() === '要確認');
    var _etaMsg;
    if (_isNeedsCheck) {
      _etaMsg = _isOpen
        ? '担当者が確認のうえ、分かり次第ご連絡いたします'
        : '営業時間外のため、翌営業日に担当者よりご連絡いたします';
    } else {
      _etaMsg = _isOpen
        ? '数分以内にスタッフよりご返信いたします'
        : '営業時間外のため、翌営業日の朝にスタッフよりご返信いたします';
    }
    _statusBox = {
      type: 'box', layout: 'vertical', backgroundColor: '#eef6e9', cornerRadius: 'lg',
      paddingAll: 'lg', spacing: 'xs',
      contents: [
        { type: 'text', text: _statusLine, size: 'sm', weight: 'bold', color: '#1a7f37', wrap: true },
        { type: 'text', text: _etaMsg, size: 'xs', color: '#4a8a5a', wrap: true }
      ]
    };
  }

  const bodyContents = [
    {
      type: 'box', layout: 'vertical', backgroundColor: '#f8f9fa', cornerRadius: 'lg',
      paddingAll: 'lg', spacing: 'sm', borderColor: '#e0e0e0', borderWidth: '1px',
      contents: [
        { type: 'text', text: nm + ' ' + rm + '号室', weight: 'bold', size: 'md', wrap: true, color: '#1a2538' },
        { type: 'text', text: ad + ' (' + st + '駅)', size: 'xs', color: '#666666', wrap: true },
        { type: 'separator', color: '#eeeeee', margin: 'md' },
        {
          type: 'box', layout: 'horizontal', margin: 'md', contents: [
            { type: 'text', text: '賃料', size: 'xs', color: '#999999', flex: 0 },
            { type: 'text', text: rn + '万円', size: 'sm', color: '#111111', weight: 'bold', align: 'end' }
          ]
        },
        {
          type: 'box', layout: 'horizontal', contents: [
            { type: 'text', text: '管理費', size: 'xs', color: '#999999', flex: 0 },
            { type: 'text', text: fe + '円', size: 'sm', color: '#111111', align: 'end' }
          ]
        },
        {
          type: 'box', layout: 'horizontal', contents: [
            { type: 'text', text: '間取り', size: 'xs', color: '#999999', flex: 0 },
            { type: 'text', text: ly, size: 'sm', color: '#111111', align: 'end' }
          ]
        },
        {
          type: 'box', layout: 'horizontal', contents: [
            { type: 'text', text: '専有面積', size: 'xs', color: '#999999', flex: 0 },
            { type: 'text', text: ar + 'm²', size: 'sm', color: '#111111', align: 'end' }
          ]
        }
      ]
    }
  ];
  if (_statusBox) bodyContents.push(_statusBox);

  const footerButtons = [];
  if (p.url) {
    footerButtons.push({
      type: 'button', style: 'link', height: 'sm',
      action: { type: 'uri', label: '🔍 詳細を見る', uri: p.url }
    });
  }
  if (p.status === '募集中') {
    footerButtons.push({
      type: 'button', style: 'primary', height: 'sm', color: '#6ea814',
      action: {
        type: 'postback',
        label: '🏠 入居申込をする',
        data: 'apply|' + p.name + '|' + p.room,
        displayText: '🏠 入居申込をする'
      }
    });
  }

  // フッターが空の場合はフッターなしで返す（LINE APIは空contentsを拒否する）
  const bubble = {
    type: 'bubble',
    size: 'mega',
    header: {
      type: 'box',
      layout: 'vertical',
      backgroundColor: _headerBg,
      paddingAll: 'xl',
      paddingTop: 'xxl',
      paddingBottom: 'xl',
      spacing: 'sm',
      contents: [
        { type: 'text', text: 'お問い合わせありがとうございます', weight: 'bold', size: 'md', color: '#ffffff', align: 'center', wrap: true }
      ]
    },
    body: { type: 'box', layout: 'vertical', spacing: 'lg', paddingAll: 'xl', paddingTop: 'lg', contents: bodyContents }
  };
  if (footerButtons.length > 0) {
    bubble.footer = { type: 'box', layout: 'vertical', spacing: 'sm', paddingAll: 'lg', contents: footerButtons };
  }
  return bubble;
}

// ══════════════════════════════════════════════════════════
//  遅延自動返信キュー
// ══════════════════════════════════════════════════════════

/**
 * JST の時（0-23）を返す。
 * @param {Date} date
 * @return {number}
 */
function getJstHour(date) {
  return (date.getUTCHours() + 9) % 24;
}

/**
 * Date を JST 文字列（YYYY/MM/DD HH:mm:ss）に変換する。
 * @param {Date} date
 * @return {string}
 */
function toJstString(date) {
  var jst = new Date(date.getTime() + 9 * 60 * 60 * 1000);
  var y = jst.getUTCFullYear();
  var m = ('0' + (jst.getUTCMonth() + 1)).slice(-2);
  var d = ('0' + jst.getUTCDate()).slice(-2);
  var h = ('0' + jst.getUTCHours()).slice(-2);
  var min = ('0' + jst.getUTCMinutes()).slice(-2);
  var s = ('0' + jst.getUTCSeconds()).slice(-2);
  return y + '/' + m + '/' + d + ' ' + h + ':' + min + ':' + s;
}

/**
 * 翌営業日の朝（10:00 JST + ランダム16〜33分）を返す。
 * @param {Date} fromDate
 * @return {Date}
 */
function getNextBusinessMorning(fromDate) {
  // JST基準で正しい日付を計算する（UTC/JST日付ズレ対策）
  var JST_OFFSET = 9 * 60 * 60 * 1000;
  var jstTime = new Date(fromDate.getTime() + JST_OFFSET);
  var jstHour = jstTime.getUTCHours();

  var targetJstDate;
  if (jstHour < 10) {
    // JST で「今日」の10:00
    targetJstDate = jstTime;
  } else {
    // JST で「翌日」の10:00
    targetJstDate = new Date(jstTime.getTime() + 24 * 60 * 60 * 1000);
  }

  // JST日付の 10:00 JST = 01:00 UTC（同じ暦日）
  var d = new Date(Date.UTC(
    targetJstDate.getUTCFullYear(),
    targetJstDate.getUTCMonth(),
    targetJstDate.getUTCDate(),
    1, 0, 0, 0
  ));

  // ランダム16〜33分追加
  var randomMin = 16 + Math.floor(Math.random() * 18);
  d = new Date(d.getTime() + randomMin * 60 * 1000);
  return d;
}

/**
 * 非募集中物件の遅延返信をキューに追加する。
 * @param {string} userId - LINE userId
 * @param {string} propertyName - 物件名
 * @param {string} roomNumber - 部屋番号
 */
function enqueueDelayedReply(userId, propertyName, roomNumber) {
  var now = new Date();
  var jstHour = getJstHour(now);
  var scheduledAt;

  if (jstHour >= 10 && jstHour < 20) {
    // 営業時間内: 2〜8分後 (確認後すぐ感を演出しつつ自動感を抑える)
    var delayMin = 2 + Math.floor(Math.random() * 7);
    scheduledAt = new Date(now.getTime() + delayMin * 60 * 1000);
    // 送信予定が営業時間外になる場合は翌日に繰り延べ
    if (getJstHour(scheduledAt) >= 20 || getJstHour(scheduledAt) < 10) {
      scheduledAt = getNextBusinessMorning(now);
    }
  } else {
    // 営業時間外: 翌営業日の10:16〜10:33
    scheduledAt = getNextBusinessMorning(now);
  }

  // ユーザー名を取得（LINE Users の顧客名 → LINE プロフィール名）
  var userName = _getLineUserName_(userId);

  var ss = SpreadsheetApp.openById(CRITERIA_SHEET_ID);
  var sheet = ss.getSheetByName('返信キュー');
  if (!sheet) {
    sheet = ss.insertSheet('返信キュー');
    sheet.appendRow(['userId', '物件名', '部屋番号', '受付時刻', '送信予定時刻', 'ステータス', 'ユーザー名']);
  }
  // ヘッダーにユーザー名列がなければ追加
  var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  if (headers.length < 7 || headers[6] !== 'ユーザー名') {
    sheet.getRange(1, 7).setValue('ユーザー名');
  }
  // 同じ userId + 物件名 + 部屋番号 で pending のエントリがあればスキップ
  var queueData = sheet.getDataRange().getValues();
  for (var k = 1; k < queueData.length; k++) {
    if (queueData[k][0] === userId &&
        queueData[k][1] === propertyName &&
        String(queueData[k][2]) === String(roomNumber || '') &&
        queueData[k][5] === 'pending') {
      return; // 重複 → 追加しない
    }
  }
  sheet.appendRow([
    userId, propertyName, roomNumber || '',
    toJstString(now), toJstString(scheduledAt), 'pending', userName
  ]);
}

// ══════════════════════════════════════════════════════════
//  終了物件 → 検索条件への変換
//  空室確認で「ご案内が難しい」となった物件のスペックから、
//  似た部屋を探すための暫定条件を組み立てる。
//
//  物件空室管理シートには 徒歩分数・築年数 が無い（FN Forrentの一覧に
//  出ていないため取り込めない）ので、SUUMO掲載管理シートを
//  建物名+部屋番号 で引いて補う。突合できなければ無しで組み立てる。
// ══════════════════════════════════════════════════════════

/** SUUMO掲載管理シートから 徒歩・築年数・路線 を引く。見つからなければ null。 */
function _findListingSpecs_(buildingName, roomNumber) {
  try {
    if (typeof SUUMO_LISTING_HEADERS === 'undefined') return null;
    var ss = SpreadsheetApp.openById(CRITERIA_SHEET_ID);
    var sheet = ss.getSheetByName(SUUMO_LISTING_SHEET);
    if (!sheet || sheet.getLastRow() < 2) return null;
    var idxName = SUUMO_LISTING_HEADERS.indexOf('建物名');
    var idxRoom = SUUMO_LISTING_HEADERS.indexOf('部屋番号');
    var idxWalk = SUUMO_LISTING_HEADERS.indexOf('徒歩');
    var idxAge  = SUUMO_LISTING_HEADERS.indexOf('築年数');
    var idxRoute = SUUMO_LISTING_HEADERS.indexOf('路線名');
    var idxSta  = SUUMO_LISTING_HEADERS.indexOf('最寄り駅');
    var idxEquip = SUUMO_LISTING_HEADERS.indexOf('設備');
    if (idxName < 0 || idxRoom < 0) return null;

    var norm = function (v) { return String(v == null ? '' : v).trim().replace(/号室$/, ''); };
    var targetName = norm(buildingName);
    var targetRoom = norm(roomNumber);
    var data = sheet.getRange(2, 1, sheet.getLastRow() - 1, SUUMO_LISTING_HEADERS.length).getValues();
    for (var i = 0; i < data.length; i++) {
      if (norm(data[i][idxName]) !== targetName) continue;
      if (targetRoom && norm(data[i][idxRoom]) !== targetRoom) continue;
      return {
        walk: idxWalk >= 0 ? String(data[i][idxWalk] || '').trim() : '',
        buildingAge: idxAge >= 0 ? String(data[i][idxAge] || '').trim() : '',
        route: idxRoute >= 0 ? String(data[i][idxRoute] || '').trim() : '',
        station: idxSta >= 0 ? String(data[i][idxSta] || '').trim() : '',
        equipment: idxEquip >= 0 ? String(data[i][idxEquip] || '') : ''
      };
    }
  } catch (e) {
    console.warn('[条件変換] 掲載管理シートの参照に失敗（続行）: ' + e.message);
  }
  return null;
}

// ── SUUMOの条件入力の選択肢に合わせる ──────────────────────
// 暫定条件はお客さんが自分で入れ直すときの基準にもなるので、
// 中途半端な数字（12.3万・27m²）ではなく SUUMO と同じ刻みに丸める。
// 実際の選択肢と違っていたらこの配列を直すだけでよい。
// SUUMOの賃貸検索フォームから実際の選択肢を取得して転記（2026-08-04時点）
var SUUMO_RENT_STEPS = (function () {          // 万円
  var a = [];
  for (var i = 30; i <= 200; i += 5) a.push(i / 10);   //  3.0〜20.0 を 0.5万刻み
  for (var j = 21; j <= 30; j++) a.push(j);            // 21〜30 を 1万刻み
  return a.concat([35, 40, 50, 100]);
})();
var SUUMO_WALK_STEPS = [1, 5, 7, 10, 15, 20];                  // 分以内
var SUUMO_AGE_STEPS  = [1, 3, 5, 7, 10, 15, 20, 25, 30];       // 年以内（新築=0は別扱い）
var SUUMO_AREA_STEPS = [20, 25, 30, 35, 40, 45, 50, 55, 60, 65, 70, 80, 90, 100];  // m²以上

/**
 * 上限系（賃料・徒歩・築年数）を、その物件が満たす最小の選択肢に丸める。
 * ちょうど選択肢と同じ値ならその値をそのまま使う。
 *   14.8万 → 15万 / 15.0万 → 15万 / 徒歩7分 → 7分以内 / 築16年 → 20年以内
 * 選択肢の最大を超える場合は null＝「指定しない」。
 * 存在しない選択肢（21分以内・築33年以内など）を作らないため。
 */
function _snapUpToStep_(v, steps) {
  if (v == null || isNaN(v)) return null;
  for (var i = 0; i < steps.length; i++) {
    if (v <= steps[i]) return steps[i];
  }
  return null;
}

/**
 * 下限系（面積）を、その物件が満たす最大の選択肢に丸める。
 * ちょうど選択肢と同じ値ならその値をそのまま使う。
 *   25.07m² → 25 / 25.0m² → 25 / 24.99m² → 20
 * 最小の選択肢を下回る場合は null＝「指定しない」。
 */
function _snapDownToStep_(v, steps) {
  if (v == null || isNaN(v)) return v;
  for (var i = steps.length - 1; i >= 0; i--) {
    if (v >= steps[i]) return steps[i];
  }
  return null;
}

/**
 * 設備テキストからバス・トイレ別かを判定する。
 * SUUMO「バストイレ別」/ REINS等「バス・トイレ別」の両方に対応。
 */
function _hasSeparateBathToilet_(text) {
  return /バス・?トイレ別/.test(String(text || ''));
}

/**
 * 設備テキストから独立洗面台かを判定する。
 * SUUMOは「洗面所独立」と書くので、それも拾う。
 */
function _hasIndependentWashstand_(text) {
  return /独立洗面台|洗面所独立|洗面台独立|独立洗面所/.test(String(text || ''));
}

/**
 * 「路線＋駅」が1つの文字列になっているものを分解する。
 * 物件空室管理シートの最寄り駅は FN Forrent 由来で「ＪＲ総武線/小岩」の形。
 * そのまま駅名として使うと拡張の駅コード解決が全滅する（実際に発生）。
 *   「ＪＲ総武線/小岩」        → {route:'ＪＲ総武線', station:'小岩'}
 *   「ＪＲ総武線 小岩駅 徒歩7分」 → {route:'ＪＲ総武線', station:'小岩'}
 *   「小岩」                   → {route:'', station:'小岩'}
 */
function _splitRouteStation_(text) {
  var t = String(text == null ? '' : text).trim();
  if (!t) return { route: '', station: '' };

  // 「路線/駅」「路線・駅」区切り
  var m = t.match(/^(.+?線)\s*[\/／]\s*(.+)$/);
  if (m) return { route: m[1].trim(), station: _cleanStationName_(m[2]) };

  // 「路線 駅名駅 徒歩◯分」
  m = t.match(/^(.+?線)\s+(.+?)駅/);
  if (m) return { route: m[1].trim(), station: _cleanStationName_(m[2]) };

  // 「路線 駅名」
  m = t.match(/^(.+?線)\s+(.+)$/);
  if (m) return { route: m[1].trim(), station: _cleanStationName_(m[2]) };

  return { route: '', station: _cleanStationName_(t) };
}

/** 駅名から「駅」や徒歩情報を落とす。 */
function _cleanStationName_(v) {
  return String(v == null ? '' : v)
    .replace(/徒歩.*$/, '')
    .trim()
    .replace(/駅$/, '')
    .trim();
}

/** 「3」「徒歩3分」「3分」→ 3 。取れなければ null。 */
function _parseWalkMinutes_(v) {
  var m = String(v == null ? '' : v).match(/(\d{1,3})/);
  return m ? parseInt(m[1], 10) : null;
}

/**
 * 物件空室管理シートの1行から暫定の検索条件を作る。
 * 見つからなければ null。
 *
 * 方針: 条件は緩めず、その物件に近いものだけが出るようにする。
 *       緩めて件数を稼ぐと「思っていたのと違う」が届いて離脱するため。
 */
function _propertyToCriteria_(buildingName, roomNumber) {
  try {
    var ss = SpreadsheetApp.openById(PROPERTY_SHEET_ID);
    var sheet = ss.getSheetByName(PROPERTY_SHEET_NAME);
    if (!sheet) return null;
    var data = sheet.getDataRange().getValues();
    var norm = function (v) { return String(v == null ? '' : v).trim().replace(/号室$/, ''); };
    var tName = norm(buildingName), tRoom = norm(roomNumber);
    var row = null;
    for (var i = 1; i < data.length; i++) {
      if (norm(data[i][0]) !== tName) continue;
      if (tRoom && norm(data[i][1]) !== tRoom) continue;
      row = data[i];
      break;
    }
    if (!row) return null;

    var specs = _findListingSpecs_(buildingName, roomNumber) || {};

    // 駅: 掲載管理の「最寄り駅」を優先（路線が分かるため）。無ければ物件シートのD列。
    // ⚠️ 物件シートのD列は「ＪＲ総武線/小岩」形式なので、必ず分解してから使う。
    var station = _cleanStationName_(specs.station || '');
    var route = specs.route || '';
    if (!station) {
      var rs = _splitRouteStation_(row[3]);
      station = rs.station;
      if (!route) route = rs.route;
    }
    // 徒歩: 掲載管理から取る。物件空室管理シートには入っていない項目。
    var walkNum = _parseWalkMinutes_(specs.walk);
    // 徒歩・築年数・面積・賃料とも、加算/減算はせず「選択肢を1段階だけ緩める」で揃える。
    // 以前は +3分 / +5年 / -10% を足してから丸めていたが、丸めと二重になって
    // 築16年 → 築25年以内（実質+9年）のように緩くなりすぎていた。
    // 徒歩が取れない物件はグリッド上の10分をそのまま使う（推測値なのでこれ以上緩めない）。
    var walk = (walkNum != null) ? _snapUpToStep_(walkNum, SUUMO_WALK_STEPS) : 10;
    // 賃料上限: 賃料+管理費を SUUMO の選択肢に丸める（14.8万 → 15万 / 12.3万 → 12.5万）。
    var rentYen = Number(String(row[4] || '').replace(/[^0-9.]/g, '')) || 0;
    var feeYen = Number(String(row[5] || '').replace(/[^0-9.]/g, '')) || 0;
    if (rentYen > 0 && rentYen < 1000) rentYen = rentYen * 10000;  // 「15.4」万円表記への保険
    var rentMax = rentYen > 0 ? _snapUpToStep_((rentYen + feeYen) / 10000, SUUMO_RENT_STEPS) : '';  // 万円
    var layout = String(row[6] || '').trim();
    var areaNum = parseFloat(String(row[7] || '').replace(/[^0-9.]/g, ''));
    // 面積はその物件が満たす最大の選択肢を採る（ちょうどならその値）。
    //   25.07m² → 25 / 25.0m² → 25 / 24.99m² → 20
    var areaMin = isNaN(areaNum) ? '' : _snapDownToStep_(areaNum, SUUMO_AREA_STEPS);
    // 築年数: 掲載管理から取る。物件空室管理シートには入っていない項目。
    var ageNum = _parseWalkMinutes_(specs.buildingAge);
    var _ageSnap = (ageNum != null) ? _snapUpToStep_(ageNum, SUUMO_AGE_STEPS) : null;
    var buildingAge = (_ageSnap != null) ? String(_ageSnap) : '';

    // 設備は「バス・トイレ別」「独立洗面台」だけ引き継ぐ。
    // 条件に入れる人が非常に多く、無いと的外れな物件が届くため。
    // それ以外の設備は絞ると0件になりやすいので入れない。
    // 表記ゆれに注意。SUUMOは「バストイレ別」「洗面所独立」、
    // REINS/itandi等は「バス・トイレ別」「独立洗面台」と書く。
    var equipment = [];
    var equipSrc = String(specs.equipment || '');
    if (_hasSeparateBathToilet_(equipSrc)) equipment.push('バス・トイレ別');
    if (_hasIndependentWashstand_(equipSrc)) equipment.push('独立洗面台');

    if (!station && !rentMax) return null;   // 材料が無さすぎる

    var summaryParts = [];
    if (station) summaryParts.push(station + '駅' + (walk ? ' 徒歩' + walk + '分以内' : ''));
    if (rentMax) summaryParts.push(rentMax + '万円以下');
    if (layout) summaryParts.push(layout + '以上');
    if (areaMin) summaryParts.push(areaMin + 'm²以上');
    if (buildingAge) summaryParts.push('築' + buildingAge + '年以内');
    for (var eq = 0; eq < equipment.length; eq++) summaryParts.push(equipment[eq]);

    return {
      station: station, route: route, walk: walk, rentMax: rentMax,
      layout: layout, areaMin: areaMin, buildingAge: buildingAge, equipment: equipment,
      matchedListing: !!specs.station,
      summary: summaryParts.join(' / ')
    };
  } catch (e) {
    console.error('[条件変換] 失敗: ' + e.message);
    return null;
  }
}

/**
 * 変換結果を _buildConditionSummaryRows_ が読める形（state 相当）に詰め替える。
 * 登録完了カードと同じ見た目で条件を見せるために使う。
 */
function _convToSummaryState_(conv) {
  var stations = {};
  if (conv.route && conv.station) stations[conv.route] = [conv.station];
  return {
    areaMethod: 'route',
    selectedRoutes: (conv.route && conv.station) ? [conv.route] : [],
    selectedCities: [],
    selectedStations: stations,
    selectedTowns: {},
    data: {
      rent_max: conv.rentMax ? String(conv.rentMax) : '',
      layouts: conv.layout ? [conv.layout] : [],
      walk: conv.walk ? String(conv.walk) : '',
      area_min: conv.areaMin ? String(conv.areaMin) : '',
      building_age: conv.buildingAge ? (conv.buildingAge + '年以内') : '',
      building_structures: [],
      equipment: conv.equipment || []
    }
  };
}

/**
 * 「ご案内が難しい物件」のお客さん向け返信メッセージ配列を生成する。
 * 条件登録済みならテキストのみ、未登録なら条件登録誘導Flexを返す。
 * processReplyQueue（遅延返信）と staff_reply_vacancy（スタッフ即時返信）で共用。
 * @param {string} userId
 * @param {string} displayName - 「物件名 202号室」形式
 * @return {Array} LINE messages 配列
 */
/**
 * 空室確認カードの選択肢ボタン。2択を同じ重さで並べるための共通化。
 * 片方だけ primary（ベタ塗り）、もう片方を link（文字だけ）にすると
 * 「はい」へ誘導する形になるため、両方ともベタ塗りで揃える。
 */
function _vacancyChoiceButton_(label, data, color) {
  // ⚠️ 過去に失敗した2案（どちらにも戻さないこと / 2026-08-06）
  //   ・枠線だけのボタン（白背景＋borderColor）→ 中が抜けて見えてボタンに見えない
  //   ・2つとも同じ緑のベタ塗り → 隣接して2行の1つの文章に見える
  //   サイズは揃えたまま色だけ変える。どちらもベタ塗りなので押しやすさは同じで、
  //   「はい」に誘導せずに2択だと分かる。
  return {
    type: 'button', style: 'primary', color: color, height: 'sm',
    action: { type: 'postback', label: label, data: data, displayText: label }
  };
}

function _buildVacancyUnavailableMessages_(userId, displayName, propertyName, roomNumber) {
  var _hasRegistered = false;
  try {
    var _existing = (typeof readLatestCriteria === 'function') ? readLatestCriteria(userId) : null;
    _hasRegistered = !!_existing;
  } catch (_) {}
  // テスト用: 条件登録済みでも暫定条件カードを確認できるようにする。
  //   - _forceVacancyFlexForTest: testSendVacancyCard / テストカードコマンドが一時的に立てる
  //   - TEST_ALLOWED_NAMES: 普通に空室確認しただけでもカードが出るようにする
  //     （遅延返信は別実行なのでフラグが残らず、顧客名で判定する必要がある）
  if (globalThis._forceVacancyFlexForTest) _hasRegistered = false;
  if (_hasRegistered && typeof TEST_ALLOWED_NAMES !== 'undefined') {
    try {
      if (TEST_ALLOWED_NAMES.indexOf(_getLineUserName_(userId)) !== -1) _hasRegistered = false;
    } catch (_eT) {}
  }

  if (_hasRegistered) {
    // 既に条件登録済み: 条件登録への誘導は不要、テキスト通知のみ
    return [{
      type: 'text',
      text: 'お待たせいたしました。\n「' + displayName + '」について確認いたしましたが、現在ご案内が難しい状況でした。\n\n引き続き、ご希望の条件に合うお部屋が見つかり次第すぐにご案内いたします。'
    }];
  }
  // 未登録: 確認結果 + 「この条件で探す」/「自分で決める」の2択。
  //
  // 2026-08-01 変更: 以前は「お部屋を探す」/「あとで」で、「あとで」を押すと
  // 会話がそこで終わって取りこぼしていた。両方を前に進む選択肢に置き換える。
  // 「あとで」という出口自体は残さない（押さない人は既読スルーになるだけなので、
  //  出口を消すのではなく、出口を全部前進させるという考え方）。
  var conv = null;
  try { conv = _propertyToCriteria_(propertyName || displayName, roomNumber); } catch (_e) {}

  var bodyContents = [
    { type: 'text', text: '確認結果のお知らせ', weight: 'bold', size: 'md', color: '#333333' },
    { type: 'text', text: '「' + displayName + '」は、今回はご案内が難しい状況でした。', size: 'sm', color: '#555555', wrap: true, margin: 'md' }
  ];
  var footerContents = [];

  if (conv && conv.summary) {
    // 変換できた: どんな条件で探すのかを見せてから押してもらう。
    // 黙って自動登録すると「頼んでいないのに物件が届く」ことになるため必ず提示する。
    // 「ご覧の」で条件の出どころを示す。お客さん自身が言った条件ではないので、
    // 唐突に数字が並んで見えないようにする。直後に問いかけがあるのでここは断定形。
    bodyContents.push({ type: 'text', text: 'ご覧のお部屋に近い条件で、お探しできます。', size: 'sm', color: '#555555', wrap: true, margin: 'md' });
    // 登録完了カードと同じ「項目名＋値」の行で見せる。
    // 「/」区切りの一行だと、何がどの条件なのか読み取りにくいため。
    var condRows = null;
    try {
      if (typeof _buildConditionSummaryRows_ === 'function') {
        condRows = _buildConditionSummaryRows_(_convToSummaryState_(conv));
      }
    } catch (_eRows) { condRows = null; }
    if (condRows && condRows.length) {
      bodyContents.push({
        type: 'box', layout: 'vertical', margin: 'md', paddingAll: 'md', spacing: 'sm',
        backgroundColor: '#F5F9EE', cornerRadius: 'md',
        contents: condRows
      });
    } else {
      // 行が組めなかったときは従来の一行表示に落とす（カードを出せなくしない）
      bodyContents.push({
        type: 'box', layout: 'vertical', margin: 'md', paddingAll: 'md',
        backgroundColor: '#F5F9EE', cornerRadius: 'md',
        contents: [{ type: 'text', text: conv.summary, size: 'sm', color: '#3D6909', wrap: true, weight: 'bold' }]
      });
    }
    // 「この条件で探してもらう / 条件を自分で決める」の2択から、はい/いいえ形式に変更 (2026-08-04)。
    // どちらの道を選ぶかを考えさせるより、YES/NOのほうが判断が軽く押されやすい。
    // なお「合っていますか」ではなく「お探ししますか」にしている。お客さん自身は
    // この条件を言っていないので、合否を尋ねる形だと違和感が出るため。
    bodyContents.push({ type: 'text', text: 'この条件でお探ししますか？', size: 'sm', color: '#333333', wrap: true, weight: 'bold', margin: 'md' });
    // ⚠️ 2つのボタンは必ず同じ見た目にすること（2026-08-06）。
    //   以前は「はい」だけ緑ベタ塗り・「いいえ」を文字リンクにしていたが、
    //   ここで提示している条件はお客さん自身が一度も言っていない推測値であり、
    //   勢いで「はい」を押されると精度の低い条件が登録される。
    //   自分で条件を決めてもらったほうが精度は高く、どちらを選んでも前進するので、
    //   片方に寄せる理由がない。
    footerContents.push(_vacancyChoiceButton_(
      'はい、お願いします',
      'action=auto_criteria&name=' + encodeURIComponent(propertyName || '') + '&room=' + encodeURIComponent(roomNumber || ''),
      '#6ea814'
    ));
    footerContents.push(_vacancyChoiceButton_('いいえ、条件を自分で決める', '条件登録', '#5f6b7a'));
  } else {
    // 変換できなかった（物件が見つからない・材料不足）: 従来どおり条件登録へ誘導
    bodyContents.push({ type: 'text', text: 'よろしければ、ご希望に近いお部屋をこちらでお探ししてお知らせします。', size: 'sm', color: '#555555', wrap: true, margin: 'md' });
    footerContents.push({
      type: 'button', style: 'primary', color: '#6ea814', height: 'sm',
      action: { type: 'postback', label: 'お部屋を探す', data: '条件登録', displayText: 'お部屋を探す' }
    });
  }

  return [{
    type: 'flex',
    altText: '「' + displayName + '」の確認結果',
    contents: {
      type: 'bubble',
      body: { type: 'box', layout: 'vertical', spacing: 'md', paddingAll: 'xl', contents: bodyContents },
      footer: { type: 'box', layout: 'vertical', spacing: 'sm', paddingAll: 'lg', paddingTop: 'none', contents: footerContents }
    }
  }];
}

/**
 * 「この条件で探してもらう」が押されたときに、暫定条件を検索条件シートへ登録する。
 * 既に条件が登録されている顧客には何もしない（上書き事故を防ぐ）。
 * @return {{ok:boolean, summary?:string, message?:string}}
 */
function registerAutoCriteriaFromProperty(userId, propertyName, roomNumber, opts) {
  try {
    opts = opts || {};
    // 既に条件がある人は上書きしない（連打・古いカードの再タップでの事故を防ぐ）。
    // ただしテストユーザーは登録まで通しで確認したいので force で抜けられるようにする。
    // ⚠️ force を使うと writeToSheet が既存行(A〜R列)を上書きする。
    var _wasRegistered = (typeof readLatestCriteria === 'function') && !!readLatestCriteria(userId);
    if (_wasRegistered && !opts.force) {
      return { ok: false, message: 'already_registered' };
    }
    var conv = _propertyToCriteria_(propertyName, roomNumber);
    if (!conv) return { ok: false, message: 'convert_failed' };

    var name = _getLineUserName_(userId);
    var stations = {};
    var routes = [];
    if (conv.route && conv.station) {
      routes = [conv.route];
      stations[conv.route] = [conv.station];
    }

    // writeToSheet を再利用する（列の知識を1箇所に保つ）
    var state = {
      data: {
        name: name,
        walk: String(conv.walk || ''),
        rent_max: String(conv.rentMax || ''),
        layouts: conv.layout ? [conv.layout] : [],
        area_min: String(conv.areaMin || ''),
        building_age: conv.buildingAge ? (conv.buildingAge + '年以内') : '',
        building_structures: [],
        equipment: conv.equipment || [],   // バス・トイレ別／独立洗面台のみ
        notes: ''               // その他ご希望はお客さんが書く欄なので、こちらでは埋めない
      },
      selectedRoutes: routes,
      selectedStations: stations,
      selectedCities: [],
      selectedTowns: {}
    };
    writeToSheet(userId, state);
    _markCriteriaProvisional_(name);
    return {
      ok: true, summary: conv.summary,
      matchedListing: !!conv.matchedListing,
      overwrote: _wasRegistered            // テストで既存条件を上書きしたか
    };
  } catch (e) {
    console.error('[条件自動登録] 失敗: ' + e.message);
    return { ok: false, message: e.message };
  }
}

/**
 * 暫定条件を自動登録したことを担当者向けDiscordに知らせる。
 *
 * ⚠️ これが無いと機能しない。拡張の顧客フィルタは「新しい条件は既定OFF」なので、
 *    担当者がチェックを入れるまで検索が走らず、登録しただけで放置される。
 */
function _notifyAutoCriteriaToDiscord_(userId, propertyName, roomNumber, result) {
  var sp = PropertiesService.getScriptProperties();
  // 空室確認そのものではなく特定の顧客の話なので、物件アクション通知と同じ
  // 顧客専用スレッドに出す（空室確認チャンネルに混ぜると流れが追いにくい）。
  var webhookUrl = sp.getProperty('DISCORD_WEBHOOK_URL');
  if (!webhookUrl) return;
  var userName = _getLineUserName_(userId) || '(不明)';
  var lines = [];
  lines.push('\uD83D\uDCDD **暫定条件を自動登録しました**');
  lines.push('お客様: **' + userName + '** 様');
  lines.push('きっかけ: 「' + propertyName + (roomNumber ? ' ' + roomNumber : '') + '」がご案内不可だったため');
  lines.push('条件: ' + (result && result.summary ? result.summary : '(不明)'));
  if (result && !result.matchedListing) {
    lines.push('> \u26A0\uFE0F 掲載管理シートと突合できず、徒歩・築年数は推定値です');
  }
  lines.push('');
  lines.push('→ 拡張の顧客フィルタは**新規は既定OFF**です。検索を回すにはチェックを入れてください。');
  lines.push('→ 本人に確認して条件の精度を上げてください（暫定のままだと精度が低いままです）。');
  var payload = { content: lines.join('\n'), flags: 4096 };  // 音は鳴らさない
  // 顧客専用スレッドがあればそこへ、無ければ顧客名でスレッドを作る
  var threadId = sp.getProperty('DISCORD_THREAD_' + userName);
  var url = webhookUrl + (threadId ? '?thread_id=' + threadId : '?wait=true');
  if (!threadId) payload.thread_name = '\uD83C\uDFE0 ' + userName;
  try {
    if (typeof _sendDiscordWithRetry_ === 'function') {
      _sendDiscordWithRetry_(url, payload, 3);
    }
  } catch (e) {
    console.error('[条件自動登録] Discord送信失敗: ' + e.message);
  }
}

/**
 * 検索条件シートに「暫定（自動生成）」の印を付ける。AT列(46)。
 * 本人が条件登録フローで登録し直したときは writeToSheet がA〜R列を上書きするだけなので、
 * この印は別途 clear する運用にする（CRM側で色分けして担当者が確認する想定）。
 */
function _markCriteriaProvisional_(customerName) {
  try {
    if (!customerName) return;
    var ss = SpreadsheetApp.openById(CRITERIA_SHEET_ID);
    var sheet = ss.getSheetByName(CRITERIA_SHEET_NAME);
    if (!sheet) return;
    var data = sheet.getDataRange().getValues();
    for (var i = 1; i < data.length; i++) {
      if (String(data[i][1] || '').trim() === String(customerName).trim()) {
        sheet.getRange(i + 1, 46).setValue(new Date());  // AT列: 暫定条件の自動登録日時
        return;
      }
    }
  } catch (e) {
    console.warn('[条件自動登録] 暫定フラグの記録に失敗（続行）: ' + e.message);
  }
}

/**
 * 返信キューを処理し、送信予定時刻を過ぎたメッセージを push 送信する。
 * 5分間隔の定期トリガーから呼ばれる。
 */
function processReplyQueue() {
  var now = new Date();
  var jstHour = getJstHour(now);

  // 営業時間外なら何もしない
  if (jstHour < 10 || jstHour >= 20) return;

  var ss = SpreadsheetApp.openById(CRITERIA_SHEET_ID);
  var sheet = ss.getSheetByName('返信キュー');
  if (!sheet) return;

  var data = sheet.getDataRange().getValues();
  for (var i = data.length - 1; i >= 1; i--) {
    if (data[i][5] !== 'pending') continue;

    var scheduledAt = new Date(data[i][4]);
    if (now < scheduledAt) continue;

    var userId = data[i][0];
    var propertyName = data[i][1];
    var roomNumber = data[i][2];
    var displayName = propertyName + (roomNumber ? ' ' + roomNumber + '号室' : '');

    // 「ご案内が難しい」返信を生成（条件登録済み判定込み）して送信
    // 物件名・部屋番号も渡す: スペックから暫定の検索条件を組み立てて提示するため
    pushMessage(userId, _buildVacancyUnavailableMessages_(userId, displayName, propertyName, roomNumber));

    // ステータスを sent に更新
    sheet.getRange(i + 1, 6).setValue('sent');
  }
}

/**
 * 返信キュー処理用の定期トリガーを設定する。
 * GAS エディタから1回だけ手動実行すること。
 */
function setupReplyQueueTrigger() {
  // 既存のトリガーを削除（重複防止）
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'processReplyQueue') {
      ScriptApp.deleteTrigger(triggers[i]);
    }
  }
  // 5分間隔のトリガーを作成
  ScriptApp.newTrigger('processReplyQueue')
    .timeBased()
    .everyMinutes(5)
    .create();
}

// ══════════════════════════════════════════════════════════
//  テスト用（GASエディタの「関数を選択」から手動実行）
//
//  下の TEST_ 定数を書き換えてから実行する。
//  自分が条件登録済みでも暫定条件カードを確認できるようにしてある。
// ══════════════════════════════════════════════════════════

var TEST_CUSTOMER_NAME = 'Hiroki';                 // LINE Users シートの顧客名
var TEST_PROPERTY_NAME = 'パークキューブ西新宿';    // 物件空室管理シートの物件名
var TEST_ROOM_NUMBER   = '1002';                   // 部屋番号（空文字でも可）

/**
 * 【送信しない】終了物件 → 検索条件の変換結果をログに出すだけ。
 * 何度実行しても顧客には何も届かず、シートも書き換えない。
 * 変換の精度を確かめるのはこれが一番速い。
 */
function testVacancyCriteriaConversion() {
  var conv = _propertyToCriteria_(TEST_PROPERTY_NAME, TEST_ROOM_NUMBER);
  if (!conv) {
    console.log('❌ 変換できませんでした（物件が見つからない or 材料不足）');
    console.log('   物件空室管理シートに「' + TEST_PROPERTY_NAME + ' / ' + TEST_ROOM_NUMBER + '」があるか確認してください');
    return null;
  }
  console.log('■ 変換結果: ' + TEST_PROPERTY_NAME + ' ' + TEST_ROOM_NUMBER);
  console.log('  掲載管理シートとの突合: ' + (conv.matchedListing ? '✅ あり（徒歩・築年数は実測）' : '❌ なし（徒歩10分・築年数なしで代用）'));
  console.log('  お客様に見える文言: ' + conv.summary);
  console.log('  ── シートに書かれる内容 ──');
  console.log('    路線: ' + (conv.route || '(なし)'));
  console.log('    駅  : ' + (conv.station || '(なし)'));
  console.log('    徒歩: ' + conv.walk + '分以内');
  console.log('    賃料: ' + conv.rentMax + '万円以下（管理費込み）');
  console.log('    間取: ' + (conv.layout || '(なし)'));
  console.log('    面積: ' + (conv.areaMin || '(なし)') + 'm²以上');
  console.log('    築年: ' + (conv.buildingAge ? conv.buildingAge + '年以内' : '(指定なし)'));
  return conv;
}

/**
 * 【LINEに届く】「ご案内が難しい」メッセージを自分に送る。
 * 条件登録済みの人でもFlex（暫定条件カード）を確認できるよう、
 * 登録済み判定を一時的に無視する。
 *
 * ⚠️ カードの「この条件で探してもらう」を押しても、既に条件がある顧客には
 *    登録されない（上書き事故を防ぐガードが効く）。表示の確認用と割り切ること。
 */
function testSendVacancyCard() {
  var userId = _findUserIdByCustomerName_(TEST_CUSTOMER_NAME);
  if (!userId) {
    console.log('❌ LINE Users シートに「' + TEST_CUSTOMER_NAME + '」が見つかりません');
    return;
  }
  var displayName = TEST_PROPERTY_NAME + (TEST_ROOM_NUMBER ? ' ' + TEST_ROOM_NUMBER + '号室' : '');
  globalThis._forceVacancyFlexForTest = true;   // 登録済みでもFlexを出す
  try {
    var msgs = _buildVacancyUnavailableMessages_(userId, displayName, TEST_PROPERTY_NAME, TEST_ROOM_NUMBER);
    pushMessage(userId, msgs);
    console.log('✅ 送信しました → ' + TEST_CUSTOMER_NAME + ' (' + displayName + ')');
  } finally {
    globalThis._forceVacancyFlexForTest = false;
  }
}

/** LINE Users シートから顧客名で userId を引く（テスト用）。 */
function _findUserIdByCustomerName_(customerName) {
  try {
    var ss = SpreadsheetApp.openById(CRITERIA_SHEET_ID);
    var sheet = ss.getSheetByName(LINE_USERS_SHEET_NAME);
    if (!sheet || sheet.getLastRow() < 2) return '';
    var data = sheet.getRange(2, 1, sheet.getLastRow() - 1, 2).getValues();
    for (var i = 0; i < data.length; i++) {
      if (String(data[i][1] || '').trim() === String(customerName).trim()) {
        return String(data[i][0] || '').trim();
      }
    }
  } catch (e) {
    console.error('_findUserIdByCustomerName_ エラー: ' + e.message);
  }
  return '';
}
