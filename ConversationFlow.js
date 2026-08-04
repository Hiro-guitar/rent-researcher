/**
 * ConversationFlow.gs - 検索条件収集 会話フロー
 *
 * 一問一答で検索条件を収集し、Google Sheets「検索条件」シートに書き込む。
 * sheets.py が期待する A:V（22列）フォーマットに完全一致させる。
 *
 * フロー:
 *   NAME → REASON → [REASON_CUSTOM] → RESIDENT → [RESIDENT_CUSTOM]
 *   → AGE → MOVE_IN_DATE → CRITERIA_SELECT(LIFFページ) → CONFIRM → DONE
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

const AGE_RANGES = ['10代', '20代', '30代', '40代', '50代', '60代以上'];

const GUIDE_TEXT_BUTTON = '下のボタンから選択してください 👇';

// ── 前ステップマッピング ──────────────────────────────────
const PREV_STEP = {};
// NAME ステップは廃止（LINEの表示名を自動取得）
// PREV_STEP[STEPS.REASON] は設定しない（REASONが最初のステップ）
PREV_STEP[STEPS.REASON_CUSTOM] = STEPS.REASON;
PREV_STEP[STEPS.RESIDENT] = STEPS.REASON;
PREV_STEP[STEPS.RESIDENT_CUSTOM] = STEPS.RESIDENT;
PREV_STEP[STEPS.AGE] = STEPS.RESIDENT;
PREV_STEP[STEPS.MOVE_IN_DATE] = STEPS.AGE;
PREV_STEP[STEPS.MOVE_IN_PERIOD] = STEPS.MOVE_IN_DATE;
PREV_STEP[STEPS.MOVE_IN_STRICT] = STEPS.MOVE_IN_DATE;
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
  // [PERF-flow] 計測用 — 条件登録の遅延調査のため一時的に追加 (2026-04-29)
  var _t = Date.now();
  console.log('[PERF-flow] start userId=' + userId);
  var state = createInitialState();
  console.log('[PERF-flow] +' + (Date.now() - _t) + 'ms createInitialState');

  // 名前はフロー後半（CONFIRM or 保存時）で取得する（体感速度向上のためここでは取得しない）
  state = updateStateData(state, 'name', '');

  // REASONステップへ直接進む
  state.step = STEPS.REASON;
  saveState(userId, state);
  console.log('[PERF-flow] +' + (Date.now() - _t) + 'ms saveState');

  var items = REASONS.map(r => qrPostback(r.length > 20 ? r.substring(0, 17) + '...' : r, 'reason|' + r, r));
  // 開始時に全体の問数を伝える。「あと何問あるか分からない」状態を作らない。
  replyMessage(replyToken, [
    textMsg('お部屋探しの条件を登録します！\n全' + FLOW_GAUGE_ORDER.length + '問、順番にお答えください。\n\n途中でやめたい場合は「キャンセル」と送ってください。'),
    textMsgWithQuickReply(_flowGauge_(STEPS.REASON) + '\n\nお部屋探しの理由を教えてください。', items)
  ]);
  console.log('[PERF-flow] +' + (Date.now() - _t) + 'ms replyMessage完了');
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
function startChangeFlow(replyToken, userId, prefixMessages) {
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
  state.selectedTowns = existing.selectedTowns || {};
  state.selectedStations = existing.selectedStations;
  state.data = {
    name: existing.name,
    reason: existing.reason,
    resident: existing.resident,
    move_in_date: existing.move_in_date,
    move_in_strict: existing.move_in_strict || false,
    rent_max: existing.rent_max,
    layouts: existing.layouts,
    walk: existing.walk,
    area_min: existing.area_min,
    building_age: existing.building_age,
    building_structures: existing.building_structures,
    equipment: existing.equipment,
    petType: existing.petType,
    carModel: existing.carModel,
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

  // state を渡すと _buildConditionSummaryRows_ で構造化レンダリング (summary 文字列は無視)
  // prefixMessages があれば返信の先頭に差し込む (「すでに登録されています」案内など)
  showCriteriaSelectLink(replyToken, userId, (prefixMessages && prefixMessages.length) ? prefixMessages : null, true, state);
}

// 「条件登録」コマンド用のルーター。
// すでに条件を登録済みのユーザーが「条件登録」を送った場合は、
// 新規登録ではなく「条件変更」フロー(既存条件を読み込んで変更)として扱う。
// その際、通常の「条件変更」とは違い「すでに条件が登録されています」の案内を先頭に出す。
function startSearchOrChangeFlow(replyToken, userId) {
  try {
    if (readLatestCriteria(userId)) {
      var notice = textMsg(
        'すでに条件が登録されています。\n\n' +
        '現在ご登録の条件を表示します。変更する場合は下のボタンからお進みください。'
      );
      startChangeFlow(replyToken, userId, [notice]);
      return;
    }
  } catch (e) {
    console.error('startSearchOrChangeFlow: readLatestCriteria error: ' + e.message);
  }
  startSearchFlow(replyToken, userId);
}

// ══════════════════════════════════════════════════════════
//  テキストメッセージハンドラー
// ══════════════════════════════════════════════════════════

/**
 * 検索条件フローのテキストメッセージを処理する。
 */
function handleSearchFlowText(replyToken, userId, message, state) {
  _setFlowGaugeMode_(state);
  // キャンセル処理
  if (message === 'キャンセル' || message === 'きゃんせる') {
    clearState(userId);
    replyMessage(replyToken, [textMsg('条件登録をキャンセルしました。\nまた登録したい場合は「条件登録」と送ってください。')]);
    return true;
  }

  switch (state.step) {
    case STEPS.NAME:
      return handleNameInput(replyToken, userId, message, state);
    case STEPS.REASON:
      return handleButtonStepTextInput(replyToken, userId, message, state, REASONS, 'reason', 'お部屋探しの理由');
    case STEPS.REASON_CUSTOM:
      return handleReasonCustomInput(replyToken, userId, message, state);
    case STEPS.RESIDENT:
      return handleButtonStepTextInput(replyToken, userId, message, state, RESIDENTS, 'resident', 'どなたが住む予定か');
    case STEPS.RESIDENT_CUSTOM:
      return handleResidentCustomInput(replyToken, userId, message, state);
    case STEPS.CRITERIA_SELECT:
      // 条件選択待ち中に普通のメッセージが来ても、促しメッセージは送らない（何も返さず待ち状態は保持）。
      // お客さんが条件選択ページのリンクから選べば完了する。中断したい場合は「キャンセル」(上で処理)で可能。
      return true;
    case STEPS.NOTES:
      return handleNotesInput(replyToken, userId, message, state);
    case STEPS.AGE:
    case STEPS.MOVE_IN_DATE:
    case STEPS.MOVE_IN_PERIOD:
    case STEPS.MOVE_IN_STRICT:
    case STEPS.CONFIRM:
      // ボタン選択ステップで手入力された場合、案内メッセージ付きで質問を再表示
      showStepQuestion(replyToken, userId, state, GUIDE_TEXT_BUTTON);
      return true;
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
  replyWithGauge(replyToken, STEPS.REASON, [textMsgWithQuickReply('お部屋探しの理由を教えてください。', items)]);
  return true;
}

// ── ボタン選択ステップでのテキスト入力ハンドラ ──────────────
// 選択肢と一致すればそのまま進める。一致しなければボタンを再表示する。

function handleButtonStepTextInput(replyToken, userId, message, state, choices, dataKey, label) {
  var trimmed = message.trim();
  var matched = choices.find(function(c) { return c === trimmed; });
  if (matched) {
    // 選択肢と完全一致 → postbackと同じ処理へ
    state = updateStateData(state, dataKey, matched);
    if (matched === 'その他') {
      state.step = dataKey === 'reason' ? STEPS.REASON_CUSTOM : STEPS.RESIDENT_CUSTOM;
      saveState(userId, state);
      var customPrompt = dataKey === 'reason'
        ? 'お部屋探しの理由を教えてください。\n自由に入力してください。'
        : '部屋に住む方を教えてください。\n自由に入力してください。';
      replyMessage(replyToken, [
        textMsgWithQuickReply(customPrompt, [qrPostback('◀ 戻る', 'action=back', '戻る')])
      ]);
    } else {
      if (dataKey === 'reason') {
        state = updateStateData(state, 'prefecture', '東京都');
        state.step = STEPS.RESIDENT;
        saveState(userId, state);
        showResidentSelect(replyToken);
      } else {
        state.step = STEPS.MOVE_IN_DATE;
        saveState(userId, state);
        showMoveInMonthSelect(replyToken);
      }
    }
  } else {
    // 一致しない → 案内メッセージ付きでボタンを再表示
    showStepQuestion(replyToken, userId, state, GUIDE_TEXT_BUTTON);
  }
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
  state.step = STEPS.AGE;
  saveState(userId, state);
  showAgeSelect(replyToken);
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
  _setFlowGaugeMode_(state);

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
      if (state.isAutoFollowup) persistAutoFollowupAnswers(userId, state);
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
      // 通常選択 → 年齢へ
      state.step = STEPS.AGE;
      saveState(userId, state);
      if (state.isAutoFollowup) persistAutoFollowupAnswers(userId, state);
      showAgeSelect(replyToken);
    }
    return true;
  }

  // ── 年齢選択 → 引越し時期へ ──
  if (data.startsWith('age|')) {
    const age = data.substring(4);
    state = updateStateData(state, 'age', age);
    state.step = STEPS.MOVE_IN_DATE;
    saveState(userId, state);
    if (state.isAutoFollowup) persistAutoFollowupAnswers(userId, state);
    showMoveInMonthSelect(replyToken);
    return true;
  }

  // ── 条件変更フローから確定 ──
  if (data === 'change_confirm') {
    if (!state.isChangeFlow) {
      replyMessage(replyToken, [textMsg('このボタンは無効です。\n「条件変更」と送ってやり直してください。')]);
      return true;
    }
    _confirmConditionChange_(replyToken, userId, state);
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
    if (state.isAutoFollowup) persistAutoFollowupAnswers(userId, state);
    showMoveInMonthSelect(replyToken);
    return true;
  }

  // ── 引越し時期: いい物件見つかり次第 ──
  if (data === 'movein|asap') {
    state = updateStateData(state, 'move_in_date', 'いい物件見つかり次第');
    if (state.isChangeFlow) {
      _confirmConditionChange_(replyToken, userId, state);
      return true;
    }
    if (state.isAutoFollowup) { finishAutoFollowup(replyToken, userId, state); return true; }
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

  // ── 引越し時期: 上旬/中旬/下旬 選択 → 入居厳守確認へ ──
  if (data.startsWith('movein_period|')) {
    var period = data.substring(14); // '上旬', '中旬', '下旬'
    var monthData = (state.data.move_in_month || '').split('-');
    var displayDate = parseInt(monthData[1], 10) + '月' + period;
    state = updateStateData(state, 'move_in_date', displayDate);
    state.step = STEPS.MOVE_IN_STRICT;
    saveState(userId, state);
    showMoveInStrictSelect(replyToken);
    return true;
  }

  // ── 引越し時期: 具体的な日付（カレンダー選択）→ 入居厳守確認へ ──
  if (data === 'movein_exact_date') {
    var selectedDate = '';
    if (event && event.postback && event.postback.params && event.postback.params.date) {
      selectedDate = event.postback.params.date; // 'YYYY-MM-DD'
    }
    if (selectedDate) {
      var dp = selectedDate.split('-');
      var displayDate2 = parseInt(dp[1], 10) + '月' + parseInt(dp[2], 10) + '日';
      state = updateStateData(state, 'move_in_date', displayDate2);
      state.step = STEPS.MOVE_IN_STRICT;
      saveState(userId, state);
      // カレンダー選択はdisplayTextが無いので、選択結果をテキストで表示してから厳守確認へ
      showMoveInStrictSelect(replyToken, [textMsg(displayDate2 + ' を選択しました')]);
    }
    return true;
  }

  // ── 入居時期厳守 選択 ──
  if (data.startsWith('movein_strict|')) {
    var isStrict = data.substring(14) === 'true';
    state = updateStateData(state, 'move_in_strict', isStrict);
    if (state.isChangeFlow) {
      _confirmConditionChange_(replyToken, userId, state);
      return true;
    }
    if (state.isAutoFollowup) { finishAutoFollowup(replyToken, userId, state); return true; }
    state.step = STEPS.CRITERIA_SELECT;
    saveState(userId, state);
    showCriteriaSelectLink(replyToken, userId);
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
      buildConditionSummaryFlex(state, 'ご登録ありがとうございます'),
      textMsg('条件に合う新着物件が見つかり次第、お知らせいたします。')
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
  if (state.isChangeFlow && (state.step === STEPS.MOVE_IN_DATE || state.step === STEPS.MOVE_IN_PERIOD || state.step === STEPS.MOVE_IN_STRICT)) {
    state.step = STEPS.CRITERIA_SELECT;
    saveState(userId, state);
    showCriteriaSelectLink(replyToken, userId, null, true, state);
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
function showStepQuestion(replyToken, userId, state, guideText) {
  var prefix = guideText ? [textMsg(guideText)] : [];
  switch (state.step) {
    case STEPS.NAME:
      replyWithGauge(replyToken, state.step, prefix.concat([textMsg('お名前を教えてください。\n（例: 山田太郎）')]));
      break;
    case STEPS.REASON:
      var items = REASONS.map(function(r) {
        return qrPostback(r.length > 20 ? r.substring(0, 17) + '...' : r, 'reason|' + r, r);
      });
      items.push(qrPostback('◀ 戻る', 'action=back', '戻る'));
      replyWithGauge(replyToken, state.step, prefix.concat([textMsgWithQuickReply('お部屋探しの理由を教えてください。', items)]));
      break;
    case STEPS.REASON_CUSTOM:
      replyWithGauge(replyToken, state.step, prefix.concat([
        textMsgWithQuickReply(
          'お部屋探しの理由を教えてください。\n自由に入力してください。',
          [qrPostback('◀ 戻る', 'action=back', '戻る')]
        )
      ]));
      break;
    case STEPS.RESIDENT:
      showResidentSelect(replyToken, prefix);
      break;
    case STEPS.RESIDENT_CUSTOM:
      replyWithGauge(replyToken, state.step, prefix.concat([
        textMsgWithQuickReply(
          '部屋に住む方を教えてください。\n自由に入力してください。',
          [qrPostback('◀ 戻る', 'action=back', '戻る')]
        )
      ]));
      break;
    case STEPS.AGE:
      showAgeSelect(replyToken, prefix);
      break;
    case STEPS.MOVE_IN_DATE:
      showMoveInMonthSelect(replyToken, prefix);
      break;
    case STEPS.MOVE_IN_PERIOD:
      var mp = (state.data.move_in_month || '').split('-');
      showMoveInPeriod(replyToken, parseInt(mp[1], 10) || 0, state.data.move_in_month || '', prefix);
      break;
    case STEPS.MOVE_IN_STRICT:
      showMoveInStrictSelect(replyToken, prefix);
      break;
    case STEPS.CRITERIA_SELECT:
      showCriteriaSelectLink(replyToken, userId, null, state.isChangeFlow, state.isChangeFlow ? state : undefined);
      break;
    case STEPS.NOTES:
      replyWithGauge(replyToken, state.step, prefix.concat([
        textMsgWithQuickReply(
          'その他ご希望があれば入力してください。\n例: 角部屋希望、南向き、駐車場付き\n\n特になければ「スキップ」をタップ。',
          [
            qrPostback('スキップ', 'notes_skip', 'スキップ'),
            qrPostback('◀ 戻る', 'action=back', '戻る')
          ]
        )
      ]));
      break;
    case STEPS.CONFIRM:
      showConfirmation(replyToken, state, prefix);
      break;
    default:
      replyWithGauge(replyToken, state.step, [textMsg('予期しないステップです。「条件登録」と送ってやり直してください。')]);
  }
}

// ══════════════════════════════════════════════════════════
//  表示ヘルパー — 居住者選択
// ══════════════════════════════════════════════════════════

// ══════════════════════════════════════════════════════════
//  進捗ゲージ
//  条件登録は質問が続くので、あとどれくらいで終わるかを毎問の先頭に出す。
//  「まだ何問あるか分からない」状態が離脱の一因になるため。
// ══════════════════════════════════════════════════════════
// 実際に遷移するステップだけを並べる。
// NAME と NOTES は state.step に設定される箇所が無く（レガシー）通らないので入れない。
// ここに無いステップでは _flowGauge_ が空文字を返し、ゲージは出ない。
var FLOW_GAUGE_ORDER = [
  STEPS.REASON,           // 1 お部屋探しの理由
  STEPS.RESIDENT,         // 2 どなたが住むか
  STEPS.AGE,              // 3 年齢
  STEPS.MOVE_IN_DATE,     // 4 入居時期（期間・厳守もここに含める）
  STEPS.CRITERIA_SELECT   // 5 条件選択ページ
];
// 確認カードは結果を見せるだけで質問ではないので、ゲージ自体を出さない。
// （ここに無いステップでは _flowGauge_ が空文字を返し、何も差し込まれない）


// 1項目の中で質問が続くとき（入居時期の「いつ頃」「遅くなる物件も可か」、
// 理由・居住者の自由入力）は、ゲージを出さない。
// 同じ「4/5」が何度も並ぶと、進んでいるのに止まって見えるため。
// 数字とバーは常に一致させる（食い違うと壊れて見える）。
// ══════════════════════════════════════════════════════════
//  空室確認からの自動登録後の追加質問
//
//  自動変換で作れるのは物件から逆算できる条件（エリア・賃料・間取り・面積・築年数）
//  だけで、引越し理由・居住者・年齢・入居時期は聞かないと分からない。
//  ⚠️ 先に条件は登録済みなので、この4問は「答えてもらえたら精度が上がる」おまけ。
//     質問を前提にすると途中離脱でまた取りこぼすため、順序を逆にしないこと。
//  ⚠️ writeToSheet はA〜R列をまとめて上書きするので使わない。
//     自動登録した物件条件を消さないよう、回答ごとに該当セルだけ書く。
//     こうすれば3問目で離脱しても2問分は残る。
// ══════════════════════════════════════════════════════════

/** 検索条件シートの1セルだけ更新する（顧客名で行を引く）。 */
function _updateCriteriaCell_(customerName, col, value) {
  try {
    if (!customerName) return false;
    var sheet = SpreadsheetApp.openById(CRITERIA_SHEET_ID).getSheetByName(CRITERIA_SHEET_NAME);
    if (!sheet) return false;
    var data = sheet.getDataRange().getValues();
    for (var i = 1; i < data.length; i++) {
      if (String(data[i][1] || '').trim() === String(customerName).trim()) {
        sheet.getRange(i + 1, col).setValue(value);
        return true;
      }
    }
  } catch (e) {
    console.error('_updateCriteriaCell_ エラー: ' + e.message);
  }
  return false;
}

/** 追加質問の回答を、今わかっている分だけシートに書く（毎回呼んでよい）。 */
function persistAutoFollowupAnswers(userId, state) {
  var d = (state && state.data) || {};
  var name = d.name || _getLineUserName_(userId);
  if (!name) return;
  if (d.reason) _updateCriteriaCell_(name, 14, d.reason);        // N列: 部屋探しの理由
  if (d.move_in_date) _updateCriteriaCell_(name, 15, d.move_in_date); // O列: 引越し時期
  if (d.resident) _updateCriteriaCell_(name, 18, d.resident);    // R列: 居住者
  if (d.move_in_strict) _updateCriteriaCell_(name, 27, 'true');  // AA列: 入居時期厳守
  if (d.age) _updateCriteriaCell_(name, 28, d.age);              // AB列: 年齢
}

/**
 * 追加質問を開始する。
 * ⚠️ 長くしないこと。読まれずに離脱するし、次のボタンも押されなくなる。
 *    受付の一言＋ゲージ＋質問を1通にまとめる。条件の内容は直前のカードに
 *    出ているので繰り返さない。
 * @param {string} leadText 受付の一言（省略可）
 */
function startAutoFollowupQuestions(replyToken, userId, leadText) {
  var state = createInitialState();
  state.step = STEPS.REASON;
  state.isAutoFollowup = true;
  state.data = { name: _getLineUserName_(userId) };
  saveState(userId, state);
  _setFlowGaugeMode_(state);

  var items = REASONS.map(function (r) {
    return qrPostback(r.length > 20 ? r.substring(0, 17) + '...' : r, 'reason|' + r, r);
  });
  var head = leadText ? (leadText + '\n\n') : '';
  replyMessage(replyToken, [
    textMsgWithQuickReply(
      head + _flowGauge_(STEPS.REASON) + '\n\nお引越しの理由を教えてください。',
      items
    )
  ]);
}

/**
 * 追加質問の完了。条件選択ページへは進まず、まとめを見せて終わる。
 * まとめは state ではなくシートから読み直す。追加質問の state には
 * 物件から自動生成した条件（エリア・賃料など）が入っていないため。
 * 直前に persistAutoFollowupAnswers で書いているので、読み直せば全部揃う。
 */
function finishAutoFollowup(replyToken, userId, state) {
  persistAutoFollowupAnswers(userId, state);
  clearState(userId);

  var existing = null;
  try {
    existing = (typeof readLatestCriteria === 'function') ? readLatestCriteria(userId) : null;
  } catch (e) {
    console.error('finishAutoFollowup: readLatestCriteria error: ' + e.message);
  }
  if (!existing) {
    // 読み直せなくてもフローは終わらせる（行き止まりにしない）
    replyMessage(replyToken, [textMsgWithQuickReply(
      'ありがとうございます。ぴったりのお部屋をお探しします。',
      [qrMessage('条件を変更する', '条件変更')]
    )]);
    return;
  }

  var view = createInitialState();
  view.areaMethod = existing.areaMethod;
  view.selectedRoutes = existing.selectedRoutes;
  view.selectedCities = existing.selectedCities;
  view.selectedTowns = existing.selectedTowns || {};
  view.selectedStations = existing.selectedStations;
  view.data = {
    name: existing.name,
    reason: existing.reason,
    resident: existing.resident,
    move_in_date: existing.move_in_date,
    move_in_strict: existing.move_in_strict || false,
    rent_max: existing.rent_max,
    layouts: existing.layouts,
    walk: existing.walk,
    area_min: existing.area_min,
    building_age: existing.building_age,
    building_structures: existing.building_structures,
    equipment: existing.equipment,
    petType: existing.petType,
    carModel: existing.carModel,
    notes: existing.notes
  };
  // 通常の条件登録と同じ確認カードを使う。
  // カード自体に「ご登録ありがとうございます」が入っているので前置きは付けない。
  showConfirmation(replyToken, view);
}

// 空室確認からの自動登録後に聞く4問（条件選択ページは自動で入っているので飛ばす）
var FLOW_GAUGE_FOLLOWUP_ORDER = [
  STEPS.REASON, STEPS.RESIDENT, STEPS.AGE, STEPS.MOVE_IN_DATE
];

/** 追加質問モードかどうかを1リクエスト内で共有する（show* 系は state を受け取らないため）。 */
function _setFlowGaugeMode_(state) {
  globalThis._flowGaugeFollowup = !!(state && state.isAutoFollowup);
}

var FLOW_GAUGE_CONTINUATION = [
  STEPS.REASON_CUSTOM,
  STEPS.RESIDENT_CUSTOM,
  STEPS.MOVE_IN_PERIOD,
  STEPS.MOVE_IN_STRICT
];

/** 例) "■■■■□ 4/5" 。続きの質問と対象外のステップでは空文字。 */
function _flowGauge_(step) {
  if (FLOW_GAUGE_CONTINUATION.indexOf(step) !== -1) return '';
  var order = globalThis._flowGaugeFollowup ? FLOW_GAUGE_FOLLOWUP_ORDER : FLOW_GAUGE_ORDER;
  var idx = order.indexOf(step);
  if (idx < 0) return '';
  var total = order.length;
  var done = idx + 1;
  var bar = '';
  for (var i = 0; i < total; i++) bar += (i < done) ? '■' : '□';
  return bar + ' ' + done + '/' + total;
}


/**
 * 質問メッセージの先頭にゲージを差し込んで送る。
 * 別バブルにすると毎問2通になって鬱陶しいので、最初のテキストに混ぜる。
 */
function replyWithGauge(replyToken, step, msgs) {
  var line = _flowGauge_(step);
  if (line && msgs && msgs.length) {
    var injected = false;
    for (var i = 0; i < msgs.length; i++) {
      var m = msgs[i];
      if (m && m.type === 'text' && typeof m.text === 'string') {
        var copy = {};
        for (var k in m) copy[k] = m[k];
        copy.text = line + '\n\n' + m.text;
        msgs[i] = copy;
        injected = true;
        break;
      }
    }
    // Flex(カード)しか無い質問は、カード本文の先頭に差し込む。
    // 別バブルにすると質問のたびに2通になって鬱陶しいため、あくまで1通に収める。
    // 条件選択ページと完了カードがこれに当たる（無いとゲージが4/6で止まって見える）。
    if (!injected) {
      for (var j = 0; j < msgs.length; j++) {
        var fm = msgs[j];
        if (!fm || fm.type !== 'flex' || !fm.contents || fm.contents.type !== 'bubble') continue;
        var body = fm.contents.body;
        if (!body || body.type !== 'box' || !body.contents || !body.contents.length) continue;
        // 元のオブジェクトを壊さないよう、差し替える階層だけ複製する
        var newBody = {}; for (var k2 in body) newBody[k2] = body[k2];
        newBody.contents = [{
          type: 'text', text: line, size: 'xs', color: '#999999', weight: 'bold'
        }].concat(body.contents);
        var newBubble = {}; for (var k3 in fm.contents) newBubble[k3] = fm.contents[k3];
        newBubble.body = newBody;
        var newMsg = {}; for (var k4 in fm) newMsg[k4] = fm[k4];
        newMsg.contents = newBubble;
        msgs[j] = newMsg;
        injected = true;
        break;
      }
    }
  }
  replyMessage(replyToken, msgs);
}

function showResidentSelect(replyToken, prefixMessages) {
  var items = RESIDENTS.map(function(r) {
    return qrPostback(r, 'resident|' + r, r);
  });
  items.push(qrPostback('◀ 戻る', 'action=back', '戻る'));
  replyWithGauge(replyToken, STEPS.RESIDENT, (prefixMessages || []).concat([
    textMsgWithQuickReply('どなたが住む予定ですか？', items)
  ]));
}

// ══════════════════════════════════════════════════════════
//  表示ヘルパー — 年齢選択
// ══════════════════════════════════════════════════════════

function showAgeSelect(replyToken, prefixMessages) {
  var items = AGE_RANGES.map(function(a) {
    return qrPostback(a, 'age|' + a, a);
  });
  items.push(qrPostback('◀ 戻る', 'action=back', '戻る'));
  replyWithGauge(replyToken, STEPS.AGE, (prefixMessages || []).concat([
    textMsgWithQuickReply('ご年齢を教えてください。', items)
  ]));
}

// ══════════════════════════════════════════════════════════
//  表示ヘルパー — 引越し時期（2ステップ）
// ══════════════════════════════════════════════════════════

/**
 * Step1: 引越し時期の月選択を表示する。
 * 今月〜12ヶ月先 + 「いい物件見つかり次第」
 */
function showMoveInMonthSelect(replyToken, prefixMessages) {
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

  replyWithGauge(replyToken, STEPS.MOVE_IN_DATE, (prefixMessages || []).concat([
    textMsgWithQuickReply(
      '引越し予定時期を教えてください。\n\n月を選択するか、「物件見つかり次第」をタップしてください。',
      items
    )
  ]));
}

/**
 * Step2: 選択した月の期間（上旬/中旬/下旬/具体的な日付）を表示する。
 * @param {string} replyToken
 * @param {number} month - 月（1〜12）
 * @param {string} monthKey - 'YYYY-MM' 形式
 */
function showMoveInPeriod(replyToken, month, monthKey, prefixMessages) {
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

  replyWithGauge(replyToken, STEPS.MOVE_IN_PERIOD, (prefixMessages || []).concat([
    textMsgWithQuickReply(
      month + '月のいつ頃ですか？',
      items
    )
  ]));
}

// ══════════════════════════════════════════════════════════
//  表示ヘルパー — 入居時期厳守確認
// ══════════════════════════════════════════════════════════

/**
 * 入居時期を必ず守りたいか、できればで良いかを確認する。
 * @param {string} replyToken
 * @param {Array} [prefixMessages] - 前に表示するメッセージ
 */
function showMoveInStrictSelect(replyToken, prefixMessages) {
  var items = [
    qrPostback('紹介してほしい', 'movein_strict|false', '紹介してほしい'),
    qrPostback('間に合う物件だけ', 'movein_strict|true', '間に合う物件だけ'),
    qrPostback('◀ 戻る', 'action=back', '戻る')
  ];
  replyWithGauge(replyToken, STEPS.MOVE_IN_STRICT, (prefixMessages || []).concat([
    textMsgWithQuickReply(
      'ご希望の時期よりご入居が遅くなる物件もご紹介してもいいですか？',
      items
    )
  ]));
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
/**
 * 条件変更画面の現在条件サマリ用ヘルパ: state から Flex contents の配列を返す。
 * 各行は vertical layout で「ラベル(小・グレー) + 値(通常・黒)」のフォーム風。
 * 駅・市区町村は路線/市ごとに改行して詰まらないようにする。
 */
function _buildConditionSummaryRows_(state, before) {
  function fmtUnit(v, suffixRe, suffix) {
    if (!v || v === '指定しない') return '指定なし';
    var s = String(v);
    return suffixRe.test(s) ? s : s + suffix;
  }

  // state / フラット条件(readLatestCriteria等) 両対応で data / area を取り出す
  function dataOf(s) { return (s && s.data) ? s.data : (s || {}); }
  function areaOf(s) {
    return {
      method: s && s.areaMethod,
      routes: (s && s.selectedRoutes) || [],
      cities: (s && s.selectedCities) || [],
      stations: (s && s.selectedStations) || {},
      towns: (s && s.selectedTowns) || {}
    };
  }

  // ── 各フィールドの表示文字列（変更前・変更後で同じロジックを使う） ──
  function dispMoveIn(s) { var d = dataOf(s); return d.move_in_date ? String(d.move_in_date) : ''; }
  function areaLabel(s) { var a = areaOf(s); return (a.method === 'city' && a.cities.length > 0) ? '市区町村' : (a.method === 'route' && a.routes.length > 0) ? '沿線・駅' : 'エリア'; }
  function dispArea(s) {
    var a = areaOf(s);
    if (a.method === 'city' && a.cities.length > 0) {
      return a.cities.map(function (c) { var ct = a.towns[c] || []; return ct.length > 0 ? c + '（' + ct.join('、') + '）' : c; }).join('\n');
    } else if (a.method === 'route' && a.routes.length > 0) {
      return a.routes.map(function (r) { var st = a.stations[r] || []; return st.length > 0 ? r + '（' + st.join('、') + '）' : r; }).join('\n');
    }
    return '指定なし';
  }
  function dispRent(s) {
    var d = dataOf(s);
    if (!d.rent_max) return '指定なし';
    var r = String(d.rent_max);
    if (!/万円/.test(r)) r = (!isNaN(d.rent_max) ? parseFloat(d.rent_max) : d.rent_max) + '万円';
    return r;
  }
  function dispLayout(s) { var d = dataOf(s); return (d.layouts && d.layouts.length > 0) ? d.layouts.join('、') : '指定なし'; }
  function dispAreaMin(s) { var d = dataOf(s); return fmtUnit(d.area_min, /(m²|m2|㎡).*以上$|(m²|m2|㎡)$/, '㎡以上'); }
  function dispAge(s) {
    var d = dataOf(s);
    if (!d.building_age || d.building_age === '指定しない') return '指定なし';
    var a = String(d.building_age);
    if (a === '新築') return '新築';
    if (/年/.test(a)) return /以内$/.test(a) ? a : a + '以内';
    return a + '年以内';
  }
  function dispWalk(s) { var d = dataOf(s); return fmtUnit(d.walk, /分以内$|分$/, '分以内'); }
  function dispStruct(s) { var d = dataOf(s); return (d.building_structures && d.building_structures.length > 0) ? d.building_structures.join('、') : ''; }
  function dispEquip(s) { var d = dataOf(s); return (d.equipment && d.equipment.length > 0) ? d.equipment.join('、') : '指定なし'; }
  function dispPet(s) { var d = dataOf(s); return d.petType ? String(d.petType) : ''; }
  function dispAgeYears(s) { var d = dataOf(s); return d.age ? String(d.age) : ''; }
  function dispNotes(s) { var d = dataOf(s); return d.notes ? String(d.notes) : ''; }

  // 変更後の値セル。beforeがあり値が変わっていれば「変更前 → 変更後」を表示する。
  function valueCell(beforeVal, afterVal) {
    var changed = (before && beforeVal != null && String(beforeVal) !== String(afterVal));
    if (!changed) {
      return { type: 'text', text: String(afterVal || ''), size: 'sm', color: '#222222', weight: 'bold', wrap: true, flex: 7 };
    }
    var b = (beforeVal === '' || beforeVal == null) ? '指定なし' : String(beforeVal);
    var a = (afterVal === '' || afterVal == null) ? '指定なし' : String(afterVal);
    var isLong = b.indexOf('\n') >= 0 || a.indexOf('\n') >= 0 || b.length > 16 || a.length > 16;
    if (isLong) {
      // 長い項目（沿線・駅など）: 変更前 ↓ 変更後 の縦積み
      return {
        type: 'box', layout: 'vertical', spacing: 'xs', flex: 7,
        contents: [
          { type: 'text', text: b, size: 'sm', color: '#aaaaaa', wrap: true },
          { type: 'text', text: '↓', size: 'sm', color: '#d35400', weight: 'bold' },
          { type: 'text', text: a, size: 'sm', color: '#222222', weight: 'bold', wrap: true }
        ]
      };
    }
    // 短い項目: 変更前 → 変更後 の横並び（矢印はオレンジで強調）
    return {
      type: 'box', layout: 'horizontal', spacing: 'sm', flex: 7,
      contents: [
        { type: 'text', text: b, size: 'sm', color: '#aaaaaa', wrap: true, flex: 0 },
        { type: 'text', text: '→', size: 'sm', color: '#d35400', weight: 'bold', flex: 0 },
        { type: 'text', text: a, size: 'sm', color: '#222222', weight: 'bold', wrap: true }
      ]
    };
  }

  function row(label, valueContent) {
    var valBox = (typeof valueContent === 'string')
      ? { type: 'text', text: String(valueContent || ''), size: 'sm', color: '#222222', weight: 'bold', wrap: true, flex: 7 }
      : valueContent;
    return {
      type: 'box',
      layout: 'horizontal',
      spacing: 'md',
      contents: [
        { type: 'text', text: label, size: 'xs', color: '#888888', flex: 3, gravity: 'top', wrap: false },
        valBox
      ]
    };
  }

  // ── 複数選択の項目（路線・駅／間取り／建物構造／こだわり）用の値セル ──
  // 変更時は全リストを並べず「追加：… / 削除：…」だけを表示する方が分かりやすい。
  function arrOf(v) { return (v && v.length) ? v.slice() : []; }
  function layoutsOf(s) { return arrOf(dataOf(s).layouts); }
  function structsOf(s) { return arrOf(dataOf(s).building_structures); }
  function equipsOf(s) { return arrOf(dataOf(s).equipment); }
  function areaItems(s) {
    var a = areaOf(s), items = [];
    if (a.method === 'city' && a.cities.length > 0) {
      a.cities.forEach(function (c) { var ct = a.towns[c] || []; if (ct.length) ct.forEach(function (t) { items.push(c + '・' + t); }); else items.push(c); });
    } else if (a.method === 'route' && a.routes.length > 0) {
      a.routes.forEach(function (r) { var st = a.stations[r] || []; if (st.length) st.forEach(function (x) { items.push(x); }); else items.push(r); });
    }
    return items;
  }
  function listChanged(beforeArr, afterArr) {
    var bset = {}, aset = {};
    (beforeArr || []).forEach(function (x) { bset[x] = 1; });
    (afterArr || []).forEach(function (x) { aset[x] = 1; });
    var added = (afterArr || []).filter(function (x) { return !bset[x]; });
    var removed = (beforeArr || []).filter(function (x) { return !aset[x]; });
    return { added: added, removed: removed };
  }
  // 路線/市区町村単位の賢い差分: 既存/新規に関わらず、常に「路線名（駅…）」の形で表示する。
  function areaDiff(beforeS, afterS) {
    var ba = areaOf(beforeS), aa = areaOf(afterS);
    if (aa.method === 'route' && ba.method === 'route') {
      return _groupedDiff_(ba.routes, ba.stations, aa.routes, aa.stations);
    }
    if (aa.method === 'city' && ba.method === 'city') {
      return _groupedDiff_(ba.cities, ba.towns, aa.cities, aa.towns);
    }
    // 方式が違う場合はフラット差分にフォールバック
    return listChanged(areaItems(beforeS), areaItems(afterS));
  }
  // グループ(路線/市区町村)ごとに差分。追加/削除した子は常に「親（子…）」の形にする。
  function _groupedDiff_(bGroups, bChild, aGroups, aChild) {
    var added = [], removed = [];
    var bMap = {}; (bGroups || []).forEach(function (g) { bMap[g] = bChild[g] || []; });
    var aMap = {}; (aGroups || []).forEach(function (g) { aMap[g] = aChild[g] || []; });
    (aGroups || []).forEach(function (g) {
      var aC = aMap[g], bC = bMap[g];
      if (bC === undefined) { added.push(aC.length ? g + '（' + aC.join('、') + '）' : g); }  // 新規グループごと
      else { var addC = aC.filter(function (x) { return bC.indexOf(x) < 0; }); if (addC.length) added.push(g + '（' + addC.join('、') + '）'); }
    });
    (bGroups || []).forEach(function (g) {
      var bC = bMap[g], aC = aMap[g];
      if (aC === undefined) { removed.push(bC.length ? g + '（' + bC.join('、') + '）' : g); }  // グループごと削除
      else { var remC = bC.filter(function (x) { return aC.indexOf(x) < 0; }); if (remC.length) removed.push(g + '（' + remC.join('、') + '）'); }
    });
    return { added: added, removed: removed };
  }
  // diff: {added,removed}。現在の条件(currentDisplay)を表示し、変更があれば下に追加/削除を付ける。
  function valueCellList(diff, currentDisplay) {
    var current = { type: 'text', text: String(currentDisplay || ''), size: 'sm', color: '#222222', weight: 'bold', wrap: true, flex: 7 };
    if (!before || (diff.added.length === 0 && diff.removed.length === 0)) {
      return current;
    }
    var contents = [{ type: 'text', text: String(currentDisplay || '指定なし'), size: 'sm', color: '#222222', weight: 'bold', wrap: true }];
    if (diff.added.length) contents.push({ type: 'text', text: '追加：' + diff.added.join('、'), size: 'sm', color: '#1a7f37', weight: 'bold', wrap: true, margin: 'sm' });
    if (diff.removed.length) contents.push({ type: 'text', text: '削除：' + diff.removed.join('、'), size: 'sm', color: '#c0392b', weight: 'bold', wrap: true, margin: diff.added.length ? 'xs' : 'sm' });
    return { type: 'box', layout: 'vertical', spacing: 'none', flex: 7, contents: contents };
  }

  var rows = [];
  var hasBefore = !!before;

  // 入居時期（値があるか、変更されていれば表示）
  var moveInA = dispMoveIn(state), moveInB = hasBefore ? dispMoveIn(before) : null;
  if (moveInA || (hasBefore && moveInB && moveInB !== moveInA)) rows.push(row('入居時期', valueCell(moveInB, moveInA)));

  // エリア（沿線・駅 / 市区町村）: 追加・削除の駅/エリアを表示
  var areaD = hasBefore ? areaDiff(before, state) : { added: [], removed: [] };
  rows.push(row(areaLabel(state), valueCellList(areaD, dispArea(state))));

  // 家賃上限
  rows.push(row('家賃の上限', valueCell(hasBefore ? dispRent(before) : null, dispRent(state))));

  // 間取り: 追加・削除を表示
  var layoutD = hasBefore ? listChanged(layoutsOf(before), layoutsOf(state)) : { added: [], removed: [] };
  rows.push(row('間取り', valueCellList(layoutD, dispLayout(state))));

  // 専有面積
  rows.push(row('専有面積', valueCell(hasBefore ? dispAreaMin(before) : null, dispAreaMin(state))));

  // 築年数
  rows.push(row('築年数', valueCell(hasBefore ? dispAge(before) : null, dispAge(state))));

  // 駅徒歩
  rows.push(row('駅徒歩', valueCell(hasBefore ? dispWalk(before) : null, dispWalk(state))));

  // 建物構造（値があるか、変更されていれば表示）: 追加・削除を表示
  var structDiff = hasBefore ? listChanged(structsOf(before), structsOf(state)) : { added: [], removed: [] };
  if (structsOf(state).length > 0 || structDiff.added.length || structDiff.removed.length) {
    rows.push(row('建物構造', valueCellList(structDiff, dispStruct(state) || '指定なし')));
  }

  // こだわり: 追加・削除を表示
  var equipD = hasBefore ? listChanged(equipsOf(before), equipsOf(state)) : { added: [], removed: [] };
  rows.push(row('こだわり', valueCellList(equipD, dispEquip(state))));

  // ペット
  var petA = dispPet(state), petB = hasBefore ? dispPet(before) : null;
  if (petA || (hasBefore && petB && petB !== petA)) rows.push(row('ペット', valueCell(petB, petA)));

  // 年齢
  var ageA = dispAgeYears(state), ageB = hasBefore ? dispAgeYears(before) : null;
  if (ageA || (hasBefore && ageB && ageB !== ageA)) rows.push(row('年齢', valueCell(ageB, ageA)));

  // その他（備考・コメント）
  var notesA = dispNotes(state), notesB = hasBefore ? dispNotes(before) : null;
  if (notesA || (hasBefore && notesB && notesB !== notesA)) rows.push(row('その他', valueCell(notesB, notesA)));

  return rows;
}

function showCriteriaSelectLink(replyToken, userId, prefixMessages, isChangeFlow, conditionSummary) {
  // LIFF endpoint = https://form.ehomaki.com/criteria.html に設定済み (静的HTML版)
  // 旧: GAS Web App (テンプレ処理で遅い)
  // 新: form.ehomaki.com の静的HTML (即表示 + fetch でstate取得)
  const selectUrl = 'https://liff.line.me/' + LIFF_ID + '?userId=' + encodeURIComponent(userId);

  var footerContents = [
    {
      type: 'button',
      style: 'primary',
      color: '#6ea814',
      action: { type: 'uri', label: isChangeFlow ? '条件を変更する' : '条件を選択する', uri: selectUrl }
    }
  ];

  // 条件変更フローでは入居時期変更・キャンセルボタンを追加
  if (isChangeFlow) {
    footerContents.push({
      type: 'button',
      style: 'primary',
      color: '#6ea814',
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

  // body / header contents
  var bodyContents = [];
  var headerBlock = null;
  // 条件変更フローでは state から構造化されたサマリ行を作る (見やすさ重視)
  // conditionSummary に state オブジェクトが渡されていれば使い、文字列なら従来通り
  var stateForSummary = null;
  if (isChangeFlow && conditionSummary && typeof conditionSummary === 'object' && conditionSummary.data) {
    stateForSummary = conditionSummary;
  }

  if (isChangeFlow) {
    // ヘッダー: 緑のカラーブロック + 白文字タイトル中央寄せ (条件変更提案メッセージと統一)
    headerBlock = {
      type: 'box',
      layout: 'vertical',
      backgroundColor: '#6ea814',
      paddingAll: 'xl',
      paddingTop: 'lg',
      paddingBottom: 'lg',
      contents: [
        { type: 'text', text: 'お部屋の条件変更', weight: 'bold', size: 'lg', color: '#ffffff', wrap: true, align: 'center' }
      ]
    };

    var summaryRows;
    if (stateForSummary) {
      summaryRows = _buildConditionSummaryRows_(stateForSummary);
    } else {
      // 後方互換: 文字列が渡されたらそのまま表示
      summaryRows = [{ type: 'text', text: String(conditionSummary || ''), wrap: true, size: 'sm', color: '#222222' }];
    }

    // 現在の条件カード (薄緑背景)
    bodyContents.push({
      type: 'box',
      layout: 'vertical',
      backgroundColor: '#f5f9ee',
      cornerRadius: 'md',
      paddingAll: 'lg',
      spacing: 'lg',
      contents: [
        { type: 'text', text: '現在ご登録の条件', size: 'sm', color: '#3d6909', weight: 'bold' },
        { type: 'separator', margin: 'sm', color: '#d4e7a8' }
      ].concat(summaryRows)
    });

  } else {
    bodyContents.push({ type: 'text', text: 'お部屋の条件選択', weight: 'bold', size: 'xl', wrap: true });
    bodyContents.push({
      type: 'text',
      text: '下のボタンをタップして、条件選択ページを開いてください。\n\nエリア・家賃・間取り・こだわり条件などをまとめて選択できます。',
      wrap: true, margin: 'md', size: 'sm', color: '#666666'
    });
  }

  var bubble = {
    type: 'bubble',
    size: 'mega',
    body: {
      type: 'box',
      layout: 'vertical',
      spacing: 'lg',
      paddingAll: 'xl',
      contents: bodyContents
    },
    footer: {
      type: 'box',
      layout: 'vertical',
      spacing: 'sm',
      paddingAll: 'lg',
      contents: footerContents
    }
  };
  if (headerBlock) bubble.header = headerBlock;

  const flexMessage = {
    type: 'flex',
    altText: 'お部屋の条件を選択してください',
    contents: bubble
  };

  var messages = prefixMessages ? prefixMessages.slice() : [];
  messages.push(flexMessage);
  replyWithGauge(replyToken, STEPS.CRITERIA_SELECT, messages);

  // LINE返信後、フォームHTMLを事前レンダリングしてCacheServiceに保存する。
  // ユーザーがLIFFボタンをタップする前にキャッシュが準備できるため、
  // doGet 側はキャッシュヒット → テンプレ処理スキップで瞬時にHTMLを返却可能。
  // 失敗してもユーザー体験には影響しない (通常レンダリングにフォールバック)。
  try {
    if (typeof prerenderAndCacheCriteriaHtml_ === 'function') {
      prerenderAndCacheCriteriaHtml_(userId);
    }
  } catch (e) {
    console.warn('showCriteriaSelectLink プリレンダ失敗: ' + (e && e.message));
  }
}

/**
 * 条件サマリーの Flex Message を構築する（登録完了・条件更新時に顧客に送信）。
 * _buildRichConditionBubble_ を使ってリッチなデザインで生成する。
 * @param {Object} state - 条件 state オブジェクト
 * @param {string} headerText - ヘッダーに表示するテキスト
 * @returns {Object} LINE Flex Message オブジェクト
 */
function buildConditionSummaryFlex(state, headerText, before) {
  var summaryRows = _buildConditionSummaryRows_(state, before);
  // headerText に「更新」が含まれていれば条件変更扱い
  var isChanged = /更新|変更/.test(headerText);
  var bubble = _buildRichConditionBubble_(summaryRows, isChanged, '');
  // ヘッダーのタイトル・サブテキストを呼び出し元に合わせて上書き
  if (bubble.header && bubble.header.contents && bubble.header.contents.length > 0) {
    bubble.header.contents[0].text = headerText;
    // 新規登録の場合はサブテキストを非表示にする
    if (/登録/.test(headerText) && bubble.header.contents.length > 1) {
      bubble.header.contents.splice(1, 1);
    }
  }
  return {
    type: 'flex',
    altText: headerText,
    contents: bubble
  };
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
  if (d.move_in_date) {
    var moveInLine = '入居時期: ' + d.move_in_date;
        lines.push(moveInLine);
  }

  // エリア
  if (state.areaMethod === 'city' && cities.length > 0) {
    lines.push('エリア: ' + cities.join(', '));
    var towns = state.selectedTowns || {};
    for (var ci = 0; ci < cities.length; ci++) {
      var cityTowns = towns[cities[ci]];
      if (cityTowns && cityTowns.length > 0) {
        lines.push('  ' + cities[ci] + ': ' + cityTowns.join(', '));
      }
    }
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
  if (d.carModel) lines.push('駐車場(車種): ' + d.carModel);
  if (d.age) lines.push('年齢: ' + d.age);

  return lines.length > 0 ? lines.join('\n') : '（条件なし）';
}

// ══════════════════════════════════════════════════════════
//  条件変更の差分（変更前→変更後）ユーティリティ
//  state / readLatestCriteria / loadCustomerCriteriaByName のいずれの形状でも扱える。
//  （state は scalar が .data 配下、フラット形状はトップレベル。area系はどちらもトップレベル）
// ══════════════════════════════════════════════════════════
function _condData_(src) { return (src && src.data) ? src.data : (src || {}); }
function _cvNum_(v) { var m = String(v == null ? '' : v).match(/[0-9]+(\.[0-9]+)?/); return m ? m[0] : ''; }
function _cvRent_(v) { var n = _cvNum_(v); return n ? (parseFloat(n) + '万円') : ''; }
function _cvWalk_(v) { if (!v || v === '指定しない') return ''; var n = _cvNum_(v); return n ? (n + '分以内') : String(v); }
function _cvArea_(v) { if (!v || v === '指定しない') return ''; var n = _cvNum_(v); return n ? (n + '㎡以上') : String(v); }
function _cvAge_(v)  { if (!v || v === '指定しない') return ''; var n = _cvNum_(v); return n ? ('築' + n + '年以内') : String(v); }
function _cvArr_(a)  { return (a && a.length) ? a.slice().sort().join('、') : ''; }

function _cvAreaStr_(src) {
  var cities = src.selectedCities || [];
  var towns = src.selectedTowns || {};
  var routes = src.selectedRoutes || [];
  var stations = src.selectedStations || {};
  var isCity = (src.areaMethod === 'city') || (cities.length > 0 && routes.length === 0);
  if (isCity) {
    return cities.map(function (c) { var t = towns[c]; return (t && t.length) ? c + '(' + t.join('・') + ')' : c; }).join('、');
  }
  return routes.map(function (r) { var s = stations[r] || []; return (s.length) ? r + '(' + s.join('・') + ')' : r; }).join('、');
}

/**
 * 条件を「ラベル→表示文字列」の順序付き配列に正規化する（差分比較用）。
 * before/after を同じ関数に通すことで書式差による誤検知を防ぐ。
 */
function _conditionSnapshot_(src) {
  var d = _condData_(src);
  var moveIn = d.move_in_date ? (String(d.move_in_date) + (d.move_in_strict ? '（必須）' : '')) : '';
  return [
    { label: '駅・エリア', val: _cvAreaStr_(src) },
    { label: '入居時期',   val: moveIn },
    { label: '賃料上限',   val: _cvRent_(d.rent_max) },
    { label: '間取り',     val: _cvArr_(d.layouts) },
    { label: '駅徒歩',     val: _cvWalk_(d.walk) },
    { label: '面積',       val: _cvArea_(d.area_min) },
    { label: '築年数',     val: _cvAge_(d.building_age) },
    { label: '建物構造',   val: _cvArr_(d.building_structures) },
    { label: 'こだわり',   val: _cvArr_(d.equipment) },
    { label: 'ペット',     val: d.petType ? String(d.petType) : '' }
  ];
}

/**
 * 変更前後のスナップショットを突き合わせ、変わった項目の行配列を返す。
 * 例: "・賃料上限：8万円 → 10万円"
 */
function _conditionDiffLines_(before, after) {
  var b = _conditionSnapshot_(before);
  var a = _conditionSnapshot_(after);
  var lines = [];
  for (var i = 0; i < a.length; i++) {
    var bv = (b[i] && b[i].val) || '';
    var av = a[i].val || '';
    if (bv === av) continue;
    lines.push('・' + a[i].label + '：' + (bv === '' ? '指定なし' : bv) + ' → ' + (av === '' ? '指定なし' : av));
  }
  return lines;
}

/**
 * 条件更新時に顧客へ送るメッセージ配列を組み立てる。
 * before があれば「変更した項目」の差分を挟む（顧客・スタッフ両経路で共通利用）。
 * @param {Object} state - 更新後の state
 * @param {Object} [before] - 更新前の条件（readLatestCriteria/loadCustomerCriteriaByName 形状）
 */
function buildConditionUpdateMessages_(state, before) {
  // 変更点は各条件行の中に「変更前 → 変更後」で表示する（追加メッセージは送らない）
  return [
    buildConditionSummaryFlex(state, '条件を更新しました', before),
    textMsg('条件に合う新着物件が見つかり次第、お知らせいたします。')
  ];
}

/**
 * 条件変更フローの確定処理（変更前を取得→保存→差分つきで返信）。
 */
function _confirmConditionChange_(replyToken, userId, state) {
  var before = null;
  try { before = readLatestCriteria(userId); } catch (_) {}
  writeToSheet(userId, state);
  clearState(userId);
  replyMessage(replyToken, buildConditionUpdateMessages_(state, before));
}

function showConfirmation(replyToken, state, prefixMessages) {
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
  details += '・引越し時期: ' + (d.move_in_date || '未選択');
    details += '\n';
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
  if (d.carModel) details += '・駐車場(車種): ' + d.carModel + '\n';
  if (d.notes) {
    details += sep;
    details += '── その他 ──\n';
    details += d.notes + '\n';
  }

  replyWithGauge(replyToken, STEPS.CONFIRM, (prefixMessages || []).concat([buildConfirmFlex(details)]));
}
