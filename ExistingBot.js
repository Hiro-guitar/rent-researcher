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
    if (matched.length === 0) {
      var q = normalizeForMatch(raw);
      if (q.length >= 2) {
        for (var i = 1; i < data.length; i++) {
          var nameRoom = normalizeForMatch(String(data[i][0]) + String(data[i][1]));
          var addr = normalizeForMatch(data[i][2]);
          var stn  = normalizeForMatch(data[i][3]);
          if (nameRoom.indexOf(q) !== -1 || addr.indexOf(q) !== -1 || stn.indexOf(q) !== -1) {
            addRow(data[i], i);
          }
        }
      }
    }

    // 0件 → 数回まで再入力受付。既定回数を超えたら自動終了 (永遠ループ防止)
    var MAX_VACANCY_MISS = 3;
    if (matched.length === 0) {
      var prevState = getState(userId);
      var missCount = (prevState.data && prevState.data.vacancyMissCount) || 0;
      missCount++;
      if (missCount >= MAX_VACANCY_MISS) {
        // 自動終了 (Quick Replyで再開ボタン提示)
        clearState(userId);
        replyMessage(replyToken, [textMsgWithQuickReply(
          '何度かお調べしましたが、該当する物件が見つかりませんでした。\n\n' +
          '空室確認を一度終了します。\n' +
          'もう一度お調べしたい場合は下のボタンをタップしてください。',
          [qrMessage('🏠 空室確認', '空室確認')]
        )]);
        return;
      }
      // 継続して再入力待ち (missCount を保存)
      prevState.data = prevState.data || {};
      prevState.data.vacancyMissCount = missCount;
      saveState(userId, prevState);
      replyMessage(replyToken, [textMsg(
        '該当する物件が見つかりませんでした。(' + missCount + '/' + MAX_VACANCY_MISS + ')\n\n' +
        '以下のいずれかでお調べできます：\n\n' +
        '　・物件名（例: ○○マンション101）\n' +
        '　・所在地（例: 渋谷区神宮前）\n' +
        '　・最寄駅（例: 新宿駅）\n' +
        '　・専有面積（例: 25.5）\n' +
        '　・募集ページのURL\n\n' +
        '中止する場合は「キャンセル」とお送りください。'
      )]);
      return;
    }

    // 件数超過 → 件数のみ返して絞込誘導（state継続、ただしミスカウントはリセット）
    if (matched.length > 12) {
      var prevState2 = getState(userId);
      if (prevState2.data && prevState2.data.vacancyMissCount) {
        prevState2.data.vacancyMissCount = 0;
        saveState(userId, prevState2);
      }
      replyMessage(replyToken, [textMsg(
        '「' + raw + '」で' + matched.length + '件見つかりました。\n\n' +
        '物件名や専有面積でも絞り込めますので、別の条件でもお試しください。'
      )]);
      return;
    }

    // ヒット → Flex Carousel 返信
    var bubbles = [];
    var unavailable = [];
    for (var i = 0; i < matched.length; i++) {
      var row = matched[i];
      var rawUrl = row[9] ? String(row[9]).trim() : '';
      bubbles.push(createPropertyBubble({
        name: row[0], room: row[1], address: row[2], station: row[3],
        rent: row[4], fee: row[5], layout: row[6], area: row[7], status: row[8],
        url: (rawUrl && rawUrl.indexOf('http') === 0) ? rawUrl : ''
      }));
      if (row[8] !== '募集中') {
        unavailable.push({ name: String(row[0]), room: String(row[1]) });
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

    // 検索完了 → state解除
    clearState(userId);
  } catch (e) {
    console.error('handleVacancyQuery Error: ' + e.message + '\n' + e.stack);
    replyMessage(replyToken, [textMsg('検索中にエラーが発生しました。もう一度お試しください。')]);
  }
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

  const bodyContents = [
    { type: 'text', text: nm + ' ' + rm + '号室', weight: 'bold', size: 'lg', wrap: true },
    { type: 'text', text: ad + ' (' + st + '駅)', size: 'sm', color: '#555555', wrap: true },
    {
      type: 'box', layout: 'baseline', margin: 'md', contents: [
        { type: 'text', text: '賃料：' + rn + '万円', size: 'sm', color: '#111111' },
        { type: 'text', text: '管理費：' + fe + '円', size: 'sm', color: '#aaaaaa', margin: 'md' }
      ]
    },
    { type: 'text', text: '間取り：' + ly + '　専有面積：' + ar + 'm²', size: 'sm', margin: 'md', color: '#111111', wrap: true }
  ];

  // 募集状況テキスト
  if (p.status === '募集中') {
    // 募集中 → ステータスのみ（スタッフメッセージ不要）
    bodyContents.push({
      type: 'text',
      text: '募集状況：募集中',
      size: 'md', margin: 'md', color: '#8ec41d', wrap: true
    });
  } else {
    // I列が空欄 or その他 → スタッフ確認メッセージを表示
    bodyContents.push({
      type: 'text',
      text: 'スタッフが確認してご返信いたしますので、お待ちください。',
      size: 'md', margin: 'md', color: '#aa0000', wrap: true
    });
  }

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
    body: { type: 'box', layout: 'vertical', contents: bodyContents }
  };
  if (footerButtons.length > 0) {
    bubble.footer = { type: 'box', layout: 'vertical', spacing: 'sm', contents: footerButtons };
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
    // 営業時間内: 4〜23分後
    var delayMin = 4 + Math.floor(Math.random() * 20);
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
    console.error('enqueueDelayedReply: ユーザー名取得エラー: ' + e.message);
  }

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

    // Push メッセージ送信（Flex - 確認結果 + 類似物件の提案）
    pushMessage(userId, [
      {
        type: 'flex',
        altText: '「' + displayName + '」の確認結果をお知らせします',
        contents: {
          type: 'bubble',
          body: {
            type: 'box',
            layout: 'vertical',
            spacing: 'md',
            contents: [
              {
                type: 'text',
                text: 'お待たせいたしました。' + displayName + 'について確認いたしましたが、残念ながら現在こちらの物件はご案内が難しい状況でした。',
                wrap: true,
                size: 'sm',
                color: '#666666'
              },
              { type: 'separator' },
              {
                type: 'text',
                text: '似た条件の物件のご案内はご希望されますか？',
                wrap: true,
                size: 'md',
                color: '#333333',
                weight: 'bold'
              }
            ]
          },
          footer: {
            type: 'box',
            layout: 'horizontal',
            spacing: 'md',
            contents: [
              {
                type: 'box',
                layout: 'vertical',
                flex: 1,
                cornerRadius: 'md',
                backgroundColor: '#6ea814',
                paddingAll: 'sm',
                justifyContent: 'center',
                alignItems: 'center',
                action: {
                  type: 'message',
                  label: 'はい',
                  text: '条件登録'
                },
                contents: [
                  {
                    type: 'text',
                    text: 'はい',
                    color: '#FFFFFF',
                    weight: 'bold',
                    size: 'sm',
                    align: 'center'
                  }
                ]
              },
              {
                type: 'box',
                layout: 'vertical',
                flex: 1,
                cornerRadius: 'md',
                backgroundColor: '#EEEEEE',
                paddingAll: 'sm',
                justifyContent: 'center',
                alignItems: 'center',
                action: {
                  type: 'message',
                  label: 'いいえ',
                  text: '類似物件不要'
                },
                contents: [
                  {
                    type: 'text',
                    text: 'いいえ',
                    color: '#666666',
                    weight: 'bold',
                    size: 'sm',
                    align: 'center'
                  }
                ]
              }
            ]
          }
        }
      }
    ]);

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

/**
 * テスト用: 条件登録ボタン付きFlexメッセージを手動送信する。
 * GASエディタから実行し、動作確認後に削除すること。
 */
function testSendConditionButton() {
  var userId = 'U4af55e66b9a082a6d52ed1a7b30c6496'; // テスト用ユーザーID（要変更）
  pushMessage(userId, [
    {
      type: 'flex',
      altText: 'テスト: 類似物件提案メッセージ確認',
      contents: {
        type: 'bubble',
        body: {
          type: 'box',
          layout: 'vertical',
          spacing: 'md',
          contents: [
            {
              type: 'text',
              text: '「テスト物件 101号室」の確認結果',
              weight: 'bold',
              size: 'lg',
              wrap: true
            },
            {
              type: 'text',
              text: 'お問い合わせありがとうございます。確認したところ、現在こちらの物件はご案内が難しい状況でした。',
              wrap: true,
              size: 'sm',
              color: '#666666'
            },
            { type: 'separator' },
            {
              type: 'text',
              text: '似た条件の物件をお探ししましょうか？',
              wrap: true,
              size: 'md',
              color: '#333333',
              weight: 'bold'
            }
          ]
        },
        footer: {
          type: 'box',
          layout: 'horizontal',
          spacing: 'md',
          contents: [
            {
              type: 'button',
              style: 'primary',
              color: '#6ea814',
              height: 'sm',
              flex: 1,
              action: {
                type: 'message',
                label: 'はい、お願いします',
                text: '条件登録'
              }
            },
            {
              type: 'button',
              style: 'secondary',
              height: 'sm',
              flex: 1,
              action: {
                type: 'message',
                label: 'いいえ、大丈夫です',
                text: '類似物件不要'
              }
            }
          ]
        }
      }
    }
  ]);
  console.log('テストメッセージ送信完了');
}
