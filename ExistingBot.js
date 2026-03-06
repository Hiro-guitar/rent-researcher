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

  // ── 専有面積検索 ──
  if (/^\d{1,3}(\.\d{1,2})?$/.test(message) && !isNaN(message)) {
    return handleAreaSearch(replyToken, message);
  }

  return false;
}

/**
 * 専有面積で物件を検索し、Flexメッセージで返信する。
 * @param {string} replyToken
 * @param {string} areaText - 面積テキスト（数字）
 * @return {boolean}
 */
function handleAreaSearch(replyToken, areaText) {
  try {
    const ss = SpreadsheetApp.openById(PROPERTY_SHEET_ID);
    const sheet = ss.getSheetByName(PROPERTY_SHEET_NAME);
    if (!sheet) {
      console.error('handleAreaSearch: シート "' + PROPERTY_SHEET_NAME + '" が見つかりません');
      replyMessage(replyToken, [textMsg('システムエラーが発生しました。管理者にお問い合わせください。')]);
      return true;
    }

    const data = sheet.getDataRange().getValues();
    const bubbles = [];

    for (let i = 1; i < data.length; i++) {
      const area = data[i][7];
      if (area === null || area === undefined || area === '') continue;
      // 数値比較: parseFloat で統一（"25" と 25 の型差異を吸収）
      const areaNum = parseFloat(area);
      const inputNum = parseFloat(areaText);
      if (isNaN(areaNum) || isNaN(inputNum)) continue;
      if (areaNum === inputNum) {
        const rawUrl = data[i][9] ? data[i][9].toString().trim() : '';
        const property = {
          name: data[i][0],
          room: data[i][1],
          address: data[i][2],
          station: data[i][3],
          rent: data[i][4],
          fee: data[i][5],
          layout: data[i][6],
          area: data[i][7],
          status: data[i][8],
          url: (rawUrl && rawUrl.startsWith('http')) ? rawUrl : ''
        };
        bubbles.push(createPropertyBubble(property));
      }
    }

    console.log('handleAreaSearch: area=' + areaText + ' matched=' + bubbles.length);

    if (bubbles.length > 0) {
      var flexMsg = { type: 'flex', altText: '該当する物件一覧です', contents: { type: 'carousel', contents: bubbles.slice(0, 10) } };
      try {
        replyMessage(replyToken, [flexMsg]);
      } catch (flexErr) {
        console.error('Flex送信エラー: ' + flexErr.message + '\nBubble[0]: ' + JSON.stringify(bubbles[0]));
        // Flexが失敗した場合テキストでフォールバック
        replyMessage(replyToken, [textMsg('物件が' + bubbles.length + '件見つかりましたが、表示エラーが発生しました。管理者にお問い合わせください。')]);
      }
    } else {
      replyMessage(replyToken, [textMsg('お探しの専有面積に合致する物件が見つかりませんでした。\n\nもう一度ご確認の上、別の条件でお試しください。')]);
    }
    return true;
  } catch (e) {
    console.error('handleAreaSearch Error: ' + e.message + '\nStack: ' + e.stack);
    replyMessage(replyToken, [textMsg('検索中にエラーが発生しました。もう一度お試しください。')]);
    return true;
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
      size: 'md', margin: 'md', color: '#00B900', wrap: true
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
      type: 'button', style: 'primary', height: 'sm', color: '#00B900',
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
