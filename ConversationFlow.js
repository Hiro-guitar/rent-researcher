/**
 * ConversationFlow.gs - 検索条件収集 会話フロー
 *
 * 一問一答で検索条件を収集し、Google Sheets「検索条件」シートに書き込む。
 * sheets.py が期待する A:V（22列）フォーマットに完全一致させる。
 *
 * フロー:
 *   NAME → REASON → [REASON_CUSTOM] → RESIDENT → [RESIDENT_CUSTOM]
 *   → MOVE_IN_DATE → CRITERIA_SELECT(LIFFページ) → CONFIRM → DONE
 *
 * CRITERIA_SELECT (LIFFページ) で処理する項目:
 *   - エリア選択（路線・駅 or 市区町村）
 *   - 家賃上限（スライダー）
 *   - 間取り（チェックボックス）
 *   - 徒歩分数（スライダー）
 *   - 面積（スライダー）
 *   - 築年数（スライダー）
 *   - 建物構造（チェックボックス）
 *   - こだわり条件（チェックボックス）
 */

// ── 選択肢データ ──────────────────────────────────────────

const REASONS = [
  '転勤・転職', '就職', '進学（大学・専門学校）', '結婚', '同棲',
  '出産・家族が増える', '契約更新に伴う住み替え', 'もっと広い部屋に住みたい',
  'もっと便利な場所に住みたい', 'ペットを飼いたい', 'その他'
];

const RESIDENTS = ['一人暮らし', '二人暮らし（カップル・夫婦）', 'ファミリー（お子様あり）', '子供のために探している', '親のために探している', 'その他'];

// ── 前ステップマッピング ──────────────────────────────────
const PREV_STEP = {};
// NAME ステップは廃止（LINEの表示名を自動取得）
// PREV_STEP[STEPS.REASON] は設定しない（REASONが最初のステップ）
PREV_STEP[STEPS.REASON_CUSTOM] = STEPS.REASON;
PREV_STEP[STEPS.RESIDENT] = STEPS.REASON;
PREV_STEP[STEPS.RESIDENT_CUSTOM] = STEPS.RESIDENT;
PREV_STEP[STEPS.MOVE_IN_DATE] = STEPS.RESIDENT;
PREV_STEP[STEPS.MOVE_IN_PERIOD] = STEPS.MOVE_IN_DATE;
PREV_STEP[STEPS.CRITERIA_SELECT] = STEPS.MOVE_IN_DATE;
PREV_STEP[STEPS.NOTES] = STEPS.CRITERIA_SELECT;
PREV_STEP[STEPS.CONFIRM] = STEPS.CRITERIA_SELECT;

// ══════════════════════════════════════════════════════════
//  会話フロー開始
// ══════════════════════════════════════════════════════════

/**
 * 検索条件登録フローを開始する。
 * @param {string} replyToken
 * @param {string} userId
 */
function startSearchFlow(replyToken, userId) {
  var state = createInitialState();

  // LINEの表示名を自動取得（名前入力ステップをスキップ）
  var profile = getLineProfile(userId);
  var name = profile ? profile.displayName : '';
  state = updateStateData(state, 'name', name);

  // REASONステップへ直接進む
  state.step = STEPS.REASON;
  saveState(userId, state);

  var items = REASONS.map(r => qrPostback(r.length > 20 ? r.substring(0, 17) + '...' : r, 'reason|' + r, r));
  replyMessage(replyToken, [
    textMsg('お部屋探しの条件を登録します！\nいくつかの質問にお答えください。\n\n途中でやめたい場合は「キャンセル」と送ってください。'),
    textMsgWithQuickReply('お部屋探しの理由を教えてください。', items)
  ]);
}

// ══════════════════════════════════════════════════════════
//  条件変更フロー開始
// ══════════════════════════════════════════════════════════

/**
 * 条件変更フローを開始する。
 * 既存の登録済み条件をスプレッドシートから読み込み、LIFFの条件選択ページに直接遷移する。
 * @param {string} replyToken
 * @param {string} userId
 */
function startChangeFlow(replyToken, userId) {
  var existing = readLatestCriteria(userId);
  if (!existing) {
    replyMessage(replyToken, [
      textMsg('まだ条件が登録されていません。\n\n「条件登録」と送って、まず条件を登録してください。')
    ]);
    return;
  }

  // 既存条件をstateに復元してCRITERIA_SELECTステップへ
  var state = createInitialState();
  state.step = STEPS.CRITERIA_SELECT;
  state.isChangeFlow = true;
  state.areaMethod = existing.areaMethod;
  state.selectedRoutes = existing.selectedRoutes;
  state.selectedCities = existing.selectedCities;
  state.selectedStations = existing.selectedStations;
  state.data = {
    name: existing.name,
    reason: existing.reason,
    resident: existing.resident,
    move_in_date: existing.move_in_date,
    rent_max: existing.rent_max,
    layouts: existing.layouts,
    walk: existing.walk,
    area_min: existing.area_min,
    building_age: existing.building_age,
    building_structures: existing.building_structures,
    equipment: existing.equipment,
    petType: existing.petType,
    notes: existing.notes
  };
  saveState(userId, state);

  // 現在の登録条件サマリーを作成
  var summary = '';
  try {
    summary = formatConditionSummary(state);
  } catch (e) {
    console.error('formatConditionSummary error: ' + e.message);
    summary = '（条件の読み込みに失敗しました）';
  }

  showCriteriaSelectLink(replyToken, userId, null, true, summary);
}

// ══════════════════════════════════════════════════════════
//  テキストメッセージハンドラー
// ══════════════════════════════════════════════════════════

/**
 * 検索条件フローのテキストメッセージを処理する。
 */
function handleSearchFlowText(replyToken, userId, message, state) {
  // キャンセル処理
  if (message === 'キャンセル' || message === 'きゃんせる') {
    clearState(userId);
    replyMessage(replyToken, [textMsg('条件登録をキャンセルしました。\nまた登録したい場合は「条件登録」と送ってください。')]);
    return true;
  }

  switch (state.step) {
    case STEPS.NAME:
      return handleNameInput(replyToken, userId, message, state);
    case STEPS.REASON_CUSTOM:
      return handleReasonCustomInput(replyToken, userId, message, state);
    case STEPS.RESIDENT_CUSTOM:
      return handleResidentCustomInput(replyToken, userId, message, state);
    case STEPS.CRITERIA_SELECT:
      replyMessage(replyToken, [textMsg(
        '条件選択ページで条件を選んでください。\nチャットに送られたリンクをタップして開いてください。\n\nやり直す場合は「キャンセル」と送ってください。'
      )]);
      return true;
    case STEPS.NOTES:
      return handleNotesInput(replyToken, userId, message, state);
    default:
      return false;
  }
}

// ── 名前入力 ──────────────────────────────────────────────

function handleNameInput(replyToken, userId, message, state) {
  state = updateStateData(state, 'name', message);
  state.step = STEPS.REASON;
  saveState(userId, state);

  var items = REASONS.map(r => qrPostback(r.length > 20 ? r.substring(0, 17) + '...' : r, 'reason|' + r, r));
  items.push(qrPostback('◀ 戻る', 'action=back', '戻る'));
  replyMessage(replyToken, [textMsgWithQuickReply('お部屋探しの理由を教えてください。', items)]);
  return true;
}

// ── その他理由の自由入力 ──────────────────────────────────

function handleReasonCustomInput(replyToken, userId, message, state) {
  state = updateStateData(state, 'reason', 'その他: ' + message);
  state.step = STEPS.RESIDENT;
  saveState(userId, state);
  showResidentSelect(replyToken);
  return true;
}

// ── 居住者の自由入力 ──────────────────────────────────────

function handleResidentCustomInput(replyToken, userId, message, state) {
  state = updateStateData(state, 'resident', 'その他: ' + message);
  state.step = STEPS.MOVE_IN_DATE;
  saveState(userId, state);
  showMoveInMonthSelect(replyToken);
  return true;
}

// ── その他ご希望 ──────────────────────────────────────────

function handleNotesInput(replyToken, userId, message, state) {
  if (message !== 'スキップ') {
    state = updateStateData(state, 'notes', message);
  }
  state.step = STEPS.CONFIRM;
  saveState(userId, state);
  showConfirmation(replyToken, state);
  return true;
}

// ══════════════════════════════════════════════════════════
//  Postback ハンドラー
// ══════════════════════════════════════════════════════════

/**
 * 検索条件フローの Postback を処理する。
 * @param {string} replyToken
 * @param {string} userId
 * @param {string} data - postback data
 * @param {Object} state - 会話状態
 * @param {Object} [event] - LINE イベントオブジェクト（datetimepicker用）
 */
function handleSearchFlowPostback(replyToken, userId, data, state, event) {

  // ── 戻るボタン ──
  if (data === 'action=back') {
    return handleBackAction(replyToken, userId, state);
  }

  // ── 理由選択 → 引越し時期へ ──
  if (data.startsWith('reason|')) {
    const reason = data.substring(7);
    state = updateStateData(state, 'reason', reason);
    state = updateStateData(state, 'prefecture', '東京都');

    if (reason === 'その他') {
      // その他 → 自由入力ステップへ
      state.step = STEPS.REASON_CUSTOM;
      saveState(userId, state);
      replyMessage(replyToken, [
        textMsgWithQuickReply(
          'お部屋探しの理由を教えてください。\n自由に入力してください。',
          [qrPostback('◀ 戻る', 'action=back', '戻る')]
        )
      ]);
    } else {
      // 通常理由 → 居住者選択へ
      state.step = STEPS.RESIDENT;
      saveState(userId, state);
      showResidentSelect(replyToken);
    }
    return true;
  }

  // ── 居住者選択 → 引越し時期へ ──
  if (data.startsWith('resident|')) {
    const resident = data.substring(9);
    state = updateStateData(state, 'resident', resident);

    if (resident === 'その他') {
      // その他 → 自由入力ステップへ
      state.step = STEPS.RESIDENT_CUSTOM;
      saveState(userId, state);
      replyMessage(replyToken, [
        textMsgWithQuickReply(
          '部屋に住む方を教えてください。\n自由に入力してください。',
          [qrPostback('◀ 戻る', 'action=back', '戻る')]
        )
      ]);
    } else {
      // 通常選択 → 引越し時期へ
      state.step = STEPS.MOVE_IN_DATE;
      saveState(userId, state);
      showMoveInMonthSelect(replyToken);
    }
    return true;
  }

  // ── 条件変更フローから確定 ──
  if (data === 'change_confirm') {
    if (!state.isChangeFlow) {
      replyMessage(replyToken, [textMsg('このボタンは無効です。\n「条件変更」と送ってやり直してください。')]);
      return true;
    }
    writeToSheet(userId, state);
    clearState(userId);
    var confirmSummary = buildRegistrationSummary(state);
    replyMessage(replyToken, [
      textMsg('条件を更新しました！\n\n' + confirmSummary + '\n条件に合う新着物件が見つかり次第、お知らせいたします。\n\n再度変更したい場合は「条件変更」と送ってください。')
    ]);
    return true;
  }

  // ── 条件変更フローから入居時期変更 ──
  if (data === 'change_movein') {
    if (!state.isChangeFlow) {
      replyMessage(replyToken, [textMsg('このボタンは無効です。\n「条件変更」と送ってやり直してください。')]);
      return true;
    }
    state.step = STEPS.MOVE_IN_DATE;
    saveState(userId, state);
    showMoveInMonthSelect(replyToken);
    return true;
  }

  // ── 引越し時期: いい物件見つかり次第 ──
  if (data === 'movein|asap') {
    state = updateStateData(state, 'move_in_date', 'いい物件見つかり次第');
    if (state.isChangeFlow) {
      writeToSheet(userId, state);
      clearState(userId);
      replyMessage(replyToken, [
        textMsg('条件を更新しました！\n\n' + buildRegistrationSummary(state) + '\n条件に合う新着物件が見つかり次第、お知らせいたします。\n\n再度変更したい場合は「条件変更」と送ってください。')
      ]);
      return true;
    }
    state.step = STEPS.CRITERIA_SELECT;
    saveState(userId, state);
    showCriteriaSelectLink(replyToken, userId);
    return true;
  }

  // ── 引越し時期: 月選択 → 期間選択へ ──
  if (data.startsWith('movein_month|')) {
    var monthInfo = data.substring(13); // 'YYYY-MM' 形式
    state = updateStateData(state, 'move_in_month', monthInfo);
    state.step = STEPS.MOVE_IN_PERIOD;
    saveState(userId, state);
    var parts = monthInfo.split('-');
    showMoveInPeriod(replyToken, parseInt(parts[1], 10), monthInfo);
    return true;
  }

  // ── 引越し時期: 上旬/中旬/下旬 選択 ──
  if (data.startsWith('movein_period|')) {
    var period = data.substring(14); // '上旬', '中旬', '下旬'
    var monthData = (state.data.move_in_month || '').split('-');
    var displayDate = parseInt(monthData[1], 10) + '月' + period;
    state = updateStateData(state, 'move_in_date', displayDate);
    if (state.isChangeFlow) {
      writeToSheet(userId, state);
      clearState(userId);
      replyMessage(replyToken, [
        textMsg('条件を更新しました！\n\n' + buildRegistrationSummary(state) + '\n条件に合う新着物件が見つかり次第、お知らせいたします。\n\n再度変更したい場合は「条件変更」と送ってください。')
      ]);
      return true;
    }
    state.step = STEPS.CRITERIA_SELECT;
    saveState(userId, state);
    showCriteriaSelectLink(replyToken, userId);
    return true;
  }

  // ── 引越し時期: 具体的な日付（カレンダー選択）──
  if (data === 'movein_exact_date') {
    var selectedDate = '';
    if (event && event.postback && event.postback.params && event.postback.params.date) {
      selectedDate = event.postback.params.date; // 'YYYY-MM-DD'
    }
    if (selectedDate) {
      var dp = selectedDate.split('-');
      var displayDate2 = parseInt(dp[1], 10) + '月' + parseInt(dp[2], 10) + '日';
      state = updateStateData(state, 'move_in_date', displayDate2);
      state.step = STEPS.CRITERIA_SELECT;
      saveState(userId, state);
      // カレンダー選択はdisplayTextが無いので、選択結果をテキストで表示
      if (state.isChangeFlow) {
        writeToSheet(userId, state);
        clearState(userId);
        replyMessage(replyToken, [
          textMsg('条件を更新しました！\n\n' + buildRegistrationSummary(state) + '\n条件に合う新着物件が見つかり次第、お知らせいたします。\n\n再度変更したい場合は「条件変更」と送ってください。')
        ]);
      } else {
        showCriteriaSelectLink(replyToken, userId, [textMsg(displayDate2 + ' を選択しました')]);
      }
    }
    return true;
  }

  // ── その他スキップ ──
  if (data === 'notes_skip') {
    state.step = STEPS.CONFIRM;
    saveState(userId, state);
    showConfirmation(replyToken, state);
    return true;
  }

  // ── 確認OK → シートに書き込み ──
  if (data === 'confirm_ok') {
    writeToSheet(userId, state);
    clearState(userId);
    replyMessage(replyToken, [
      textMsg('ご登録ありがとうございます！\n条件に合う新着物件が見つかり次第、お知らせいたします。\n\n条件を変更したい場合は「条件変更」と送ってください。')
    ]);
    return true;
  }

  // ── 確認やり直し ──
  if (data === 'confirm_redo') {
    clearState(userId);
    startSearchFlow(replyToken, userId);
    return true;
  }

  return false;
}

// ══════════════════════════════════════════════════════════
//  戻るボタン処理
// ══════════════════════════════════════════════════════════

function handleBackAction(replyToken, userId, state) {
  // 条件変更フローでCRITERIA_SELECTから戻る場合はフローをキャンセル
  if (state.isChangeFlow && state.step === STEPS.CRITERIA_SELECT) {
    clearState(userId);
    replyMessage(replyToken, [textMsg('条件変更をキャンセルしました。')]);
    return true;
  }

  // 条件変更フローで入居時期変更中に戻る場合はCRITERIA_SELECTに戻る
  if (state.isChangeFlow && (state.step === STEPS.MOVE_IN_DATE || state.step === STEPS.MOVE_IN_PERIOD)) {
    state.step = STEPS.CRITERIA_SELECT;
    saveState(userId, state);
    showCriteriaSelectLink(replyToken, userId, null, true, formatConditionSummary(state));
    return true;
  }

  const prevStep = PREV_STEP[state.step];
  if (!prevStep) {
    replyMessage(replyToken, [textMsg('これ以上戻れません。')]);
    return true;
  }

  state.step = prevStep;
  saveState(userId, state);
  showStepQuestion(replyToken, userId, state);
  return true;
}

/**
 * 指定ステップの質問を再表示する。
 */
function showStepQuestion(replyToken, userId, state) {
  switch (state.step) {
    case STEPS.NAME:
      replyMessage(replyToken, [textMsg('お名前を教えてください。\n（例: 山田太郎）')]);
      break;
    case STEPS.REASON:
      var items = REASONS.map(function(r) {
        return qrPostback(r.length > 20 ? r.substring(0, 17) + '...' : r, 'reason|' + r, r);
      });
      items.push(qrPostback('◀ 戻る', 'action=back', '戻る'));
      replyMessage(replyToken, [textMsgWithQuickReply('お部屋探しの理由を教えてください。', items)]);
      break;
    case STEPS.REASON_CUSTOM:
      replyMessage(replyToken, [
        textMsgWithQuickReply(
          'お部屋探しの理由を教えてください。\n自由に入力してください。',
          [qrPostback('◀ 戻る', 'action=back', '戻る')]
        )
      ]);
      break;
    case STEPS.RESIDENT:
      showResidentSelect(replyToken);
      break;
    case STEPS.RESIDENT_CUSTOM:
      replyMessage(replyToken, [
        textMsgWithQuickReply(
          '部屋に住む方を教えてください。\n自由に入力してください。',
          [qrPostback('◀ 戻る', 'action=back', '戻る')]
        )
      ]);
      break;
    case STEPS.MOVE_IN_DATE:
      showMoveInMonthSelect(replyToken);
      break;
    case STEPS.MOVE_IN_PERIOD:
      var mp = (state.data.move_in_month || '').split('-');
      showMoveInPeriod(replyToken, parseInt(mp[1], 10) || 0, state.data.move_in_month || '');
      break;
    case STEPS.CRITERIA_SELECT:
      showCriteriaSelectLink(replyToken, userId, null, state.isChangeFlow, state.isChangeFlow ? formatConditionSummary(state) : undefined);
      break;
    case STEPS.NOTES:
      replyMessage(replyToken, [
        textMsgWithQuickReply(
          'その他ご希望があれば入力してください。\n例: 角部屋希望、南向き、駐車場付き\n\n特になければ「スキップ」をタップ。',
          [
            qrPostback('スキップ', 'notes_skip', 'スキップ'),
            qrPostback('◀ 戻る', 'action=back', '戻る')
          ]
        )
      ]);
      break;
    case STEPS.CONFIRM:
      showConfirmation(replyToken, state);
      break;
    default:
      replyMessage(replyToken, [textMsg('予期しないステップです。「条件登録」と送ってやり直してください。')]);
  }
}

// ══════════════════════════════════════════════════════════
//  表示ヘルパー — 居住者選択
// ══════════════════════════════════════════════════════════

function showResidentSelect(replyToken) {
  var items = RESIDENTS.map(function(r) {
    return qrPostback(r, 'resident|' + r, r);
  });
  items.push(qrPostback('◀ 戻る', 'action=back', '戻る'));
  replyMessage(replyToken, [
    textMsgWithQuickReply('どなたが住む予定ですか？', items)
  ]);
}

// ══════════════════════════════════════════════════════════
//  表示ヘルパー — 引越し時期（2ステップ）
// ══════════════════════════════════════════════════════════

/**
 * Step1: 引越し時期の月選択を表示する。
 * 今月〜12ヶ月先 + 「いい物件見つかり次第」
 */
function showMoveInMonthSelect(replyToken) {
  var now = new Date();
  var items = [];

  // 「いい物件見つかり次第」を最初に
  items.push(qrPostback('物件見つかり次第', 'movein|asap', 'いい物件見つかり次第'));

  // 今月〜5ヶ月先（計6ヶ月分）の月ボタンを生成
  for (var i = 0; i < 6; i++) {
    var d = new Date(now.getFullYear(), now.getMonth() + i, 1);
    var year = d.getFullYear();
    var month = d.getMonth() + 1;
    var label = month + '月';
    var monthKey = year + '-' + (month < 10 ? '0' + month : month);
    items.push(qrPostback(label, 'movein_month|' + monthKey, label));
  }

  items.push(qrPostback('◀ 戻る', 'action=back', '戻る'));

  replyMessage(replyToken, [
    textMsgWithQuickReply(
      '引越し予定時期を教えてください。\n\n月を選択するか、「物件見つかり次第」をタップしてください。',
      items
    )
  ]);
}

/**
 * Step2: 選択した月の期間（上旬/中旬/下旬/具体的な日付）を表示する。
 * @param {string} replyToken
 * @param {number} month - 月（1〜12）
 * @param {string} monthKey - 'YYYY-MM' 形式
 */
function showMoveInPeriod(replyToken, month, monthKey) {
  var parts = monthKey.split('-');
  var year = parseInt(parts[0], 10);
  var mon = parseInt(parts[1], 10);

  // カレンダー用: その月の1日〜末日
  var firstDay = monthKey + '-01';
  var lastDate = new Date(year, mon, 0).getDate();
  var lastDay = monthKey + '-' + (lastDate < 10 ? '0' + lastDate : lastDate);
  var midDay = monthKey + '-15';

  var items = [
    qrDatepicker('日付を選ぶ', 'movein_exact_date', 'date', midDay, firstDay, lastDay),
    qrPostback('上旬（1〜10日）', 'movein_period|上旬', month + '月上旬'),
    qrPostback('中旬（11〜20日）', 'movein_period|中旬', month + '月中旬'),
    qrPostback('下旬（21日〜）', 'movein_period|下旬', month + '月下旬'),
    qrPostback('◀ 戻る', 'action=back', '戻る')
  ];

  replyMessage(replyToken, [
    textMsgWithQuickReply(
      month + '月のいつ頃ですか？',
      items
    )
  ]);
}

// ══════════════════════════════════════════════════════════
//  表示ヘルパー — 条件選択LIFFページリンク
// ══════════════════════════════════════════════════════════

/**
 * 総合条件選択Webページへのリンクボタンを送信する。
 * @param {string} replyToken
 * @param {string} userId
 * @param {Array} [prefixMessages] - 前に表示するメッセージ
 * @param {boolean} [isChangeFlow] - 条件変更フローの場合true
 * @param {string} [conditionSummary] - 条件変更時に表示する条件サマリー
 */
function showCriteriaSelectLink(replyToken, userId, prefixMessages, isChangeFlow, conditionSummary) {
  const selectUrl = 'https://liff.line.me/' + LIFF_ID + '?action=selectCriteria&userId=' + encodeURIComponent(userId);

  var footerContents = [
    {
      type: 'button',
      style: 'primary',
      color: '#06C755',
      action: { type: 'uri', label: isChangeFlow ? '条件を変更する' : '条件を選択する', uri: selectUrl }
    }
  ];

  // 条件変更フローでは入居時期変更・キャンセルボタンを追加
  if (isChangeFlow) {
    footerContents.push({
      type: 'button',
      style: 'primary',
      color: '#06C755',
      action: { type: 'postback', label: '入居時期を変更', data: 'change_movein', displayText: '入居時期を変更' }
    });
    footerContents.push({
      type: 'button',
      style: 'secondary',
      action: { type: 'postback', label: 'キャンセル', data: 'action=back', displayText: 'キャンセル' }
    });
  } else {
    footerContents.push({
      type: 'button',
      style: 'secondary',
      action: { type: 'postback', label: '◀ 戻る', data: 'action=back', displayText: '戻る' }
    });
  }

  // body contents
  var bodyContents = [];

  if (isChangeFlow && conditionSummary) {
    bodyContents.push({ type: 'text', text: '現在の登録条件', weight: 'bold', size: 'xl' });
    bodyContents.push({
      type: 'text',
      text: conditionSummary,
      wrap: true, margin: 'md', size: 'sm', color: '#333333'
    });
    bodyContents.push({
      type: 'separator', margin: 'lg'
    });
    bodyContents.push({
      type: 'text',
      text: '変更したい項目のボタンをタップしてください。',
      wrap: true, margin: 'md', size: 'sm', color: '#666666'
    });
  } else {
    bodyContents.push({ type: 'text', text: 'お部屋の条件選択', weight: 'bold', size: 'xl' });
    bodyContents.push({
      type: 'text',
      text: '下のボタンをタップして、条件選択ページを開いてください。\n\nエリア・家賃・間取り・こだわり条件などをまとめて選択できます。',
      wrap: true, margin: 'md', size: 'sm', color: '#666666'
    });
  }

  const flexMessage = {
    type: 'flex',
    altText: 'お部屋の条件を選択してください',
    contents: {
      type: 'bubble',
      body: {
        type: 'box',
        layout: 'vertical',
        contents: bodyContents
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        spacing: 'sm',
        contents: footerContents
      }
    }
  };

  var messages = prefixMessages ? prefixMessages.slice() : [];
  messages.push(flexMessage);
  replyMessage(replyToken, messages);
}

// ══════════════════════════════════════════════════════════
//  表示ヘルパー — 確認画面
// ══════════════════════════════════════════════════════════

/**
 * 条件サマリー文字列を生成する（条件変更時の表示用）。
 */
function formatConditionSummary(state) {
  const d = state.data;
  const routes = state.selectedRoutes || [];
  const cities = state.selectedCities || [];
  const stations = state.selectedStations || {};
  var lines = [];

  // 入居時期
  if (d.move_in_date) lines.push('入居時期: ' + d.move_in_date);

  // エリア
  if (state.areaMethod === 'city' && cities.length > 0) {
    lines.push('エリア: ' + cities.join(', '));
  }
  if (state.areaMethod === 'route') {
    if (routes.length > 0) lines.push('路線: ' + routes.join(', '));
    var allStations = [];
    for (var i = 0; i < routes.length; i++) {
      var stas = stations[routes[i]] || [];
      for (var j = 0; j < stas.length; j++) {
        if (allStations.indexOf(stas[j]) === -1) allStations.push(stas[j]);
      }
    }
    if (allStations.length > 0) lines.push('駅: ' + allStations.join(', '));
  }

  // 物件条件
  if (d.rent_max) {
    var rentDisplay = d.rent_max;
    if (!isNaN(d.rent_max)) rentDisplay = String(parseFloat(d.rent_max)) + '万円';
    lines.push('賃料上限: ' + rentDisplay);
  }
  if (d.layouts && d.layouts.length > 0) lines.push('間取り: ' + d.layouts.join(', '));
  if (d.walk && d.walk !== '指定しない') {
    var walkDisplay = d.walk;
    if (!isNaN(d.walk)) walkDisplay = d.walk + '分以内';
    lines.push('駅徒歩: ' + walkDisplay);
  }
  if (d.area_min && d.area_min !== '指定しない') {
    var areaDisplay = d.area_min;
    if (!isNaN(d.area_min)) areaDisplay = d.area_min + '㎡以上';
    lines.push('面積: ' + areaDisplay);
  }
  if (d.building_age && d.building_age !== '指定しない') {
    var ageDisplay = d.building_age;
    if (!isNaN(d.building_age)) ageDisplay = '築' + d.building_age + '年以内';
    lines.push('築年数: ' + ageDisplay);
  }
  if (d.building_structures && d.building_structures.length > 0) lines.push('建物構造: ' + d.building_structures.join(', '));
  if (d.equipment && d.equipment.length > 0) lines.push('こだわり: ' + d.equipment.join(', '));
  if (d.petType) lines.push('ペット: ' + d.petType);

  return lines.length > 0 ? lines.join('\n') : '（条件なし）';
}

function showConfirmation(replyToken, state) {
  const d = state.data;
  const routes = state.selectedRoutes || [];
  const cities = state.selectedCities || [];
  const stations = state.selectedStations || {};

  var sep = '\n';
  var details = '';

  // 基本情報
  details += '── お客様情報 ──\n';
  details += '・お名前: ' + (d.name || '未入力') + '\n';
  details += '・理由: ' + (d.reason || '未選択') + '\n';
  details += '・居住者: ' + (d.resident || '未選択') + '\n';
  details += '・引越し時期: ' + (d.move_in_date || '未選択') + '\n';
  details += sep;

  // エリア
  details += '── エリア ──\n';
  details += '・東京都\n';
  if (state.areaMethod === 'city' && cities.length > 0) {
    details += '・市区町村: ' + cities.join(', ') + '\n';
  }
  if (state.areaMethod === 'route') {
    if (routes.length > 0) details += '・路線: ' + routes.join(', ') + '\n';
    var allStations = [];
    for (var i = 0; i < routes.length; i++) {
      var stas = stations[routes[i]] || [];
      for (var j = 0; j < stas.length; j++) {
        if (allStations.indexOf(stas[j]) === -1) allStations.push(stas[j]);
      }
    }
    if (allStations.length > 0) details += '・駅: ' + allStations.join(', ') + '\n';
  }
  details += sep;

  // 物件条件
  details += '── 物件条件 ──\n';
  details += '・賃料上限: ' + (d.rent_max || '未設定') + '\n';
  if (d.layouts && d.layouts.length > 0) details += '・間取り: ' + d.layouts.join(', ') + '\n';
  details += '・駅徒歩: ' + (d.walk || '指定しない') + '\n';
  details += '・面積: ' + (d.area_min || '指定しない') + '\n';
  details += '・築年数: ' + (d.building_age || '指定しない') + '\n';
  if (d.building_structures && d.building_structures.length > 0) details += '・建物構造: ' + d.building_structures.join(', ') + '\n';
  if (d.equipment && d.equipment.length > 0) {
    details += sep;
    details += '── こだわり条件 ──\n';
    details += d.equipment.join(' / ') + '\n';
  }
  if (d.petType) details += '・ペット: ' + d.petType + '\n';
  if (d.notes) {
    details += sep;
    details += '── その他 ──\n';
    details += d.notes + '\n';
  }

  replyMessage(replyToken, [buildConfirmFlex(details)]);
}
