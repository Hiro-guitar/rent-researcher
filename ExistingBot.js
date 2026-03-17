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
    return handleAreaSearch(replyToken, userId, message);
  }

  return false;
}

/**
 * 専有面積で物件を検索し、Flexメッセージで返信する。
 * @param {string} replyToken
 * @param {string} userId - LINE userId
 * @param {string} areaText - 面積テキスト（数字）
 * @return {boolean}
 */
function handleAreaSearch(replyToken, userId, areaText) {
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
    var unavailableProperties = [];

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

        // 非募集中の物件を遅延返信キューに追加
        if (data[i][8] !== '募集中') {
          unavailableProperties.push({ name: String(data[i][0]), room: String(data[i][1]) });
        }
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

    // 非募集中物件をキューに追加（返信後に実行）
    for (var q = 0; q < unavailableProperties.length; q++) {
      enqueueDelayedReply(userId, unavailableProperties[q].name, unavailableProperties[q].room);
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
                text: '「' + displayName + '」の確認結果',
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
                color: '#06C755',
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
              color: '#06C755',
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
