/**
 * StateManager.gs - ユーザー会話状態管理
 *
 * PropertiesService.getUserProperties() を使い、
 * userId をキーに JSON 文字列で状態を保存する。
 *
 * 状態オブジェクト:
 * {
 *   step: "STEP_NAME",          // 現在のステップ
 *   data: { ... },              // 収集済みデータ（name, reason, rent_max, layouts, walk, area_min, building_age, building_structures, equipment, petType, notes）
 *   areaMethod: "",             // 'route' | 'city'
 *   selectedRoutes: [],         // 選択済み路線
 *   selectedCities: [],         // 選択済み市区町村
 *   selectedTowns: {},          // { '市区町村名': ['町名丁目', ...], ... }
 *   selectedStations: {},       // { '路線名': ['駅A','駅B'], ... }
 *   updatedAt: 1234567890       // 最終更新タイムスタンプ
 * }
 */

// STEPS は Config.js で定義済み（ファイル読み込み順序の問題を回避するため）

/**
 * ユーザーの会話状態を取得する。
 * @param {string} userId
 * @return {Object} 状態オブジェクト
 */
function getState(userId) {
  const props = PropertiesService.getUserProperties();
  const raw = props.getProperty('state_' + userId);
  if (!raw) return createInitialState();

  try {
    const state = JSON.parse(raw);
    // タイムアウトチェック
    // ⚠️ 条件登録（STEP_*）だけは期限で消さない (2026-09-17)。
    //   実測では、条件登録を途中でやめた人のほとんどが「条件選択ページ」か
    //   「お部屋探しの理由の選択」で止まっていた。どちらも自由入力を受け取らないので、
    //   後日の無関係なメッセージを答えとして取り込む心配がない。
    //   消さずに残しておけば、何か月後でも選択肢をタップして続きから進められる。
    //   自由入力を受け取る3か所（理由・居住者の自由入力、その他ご希望）だけは
    //   ConversationFlow.js 側で「24時間を過ぎていたら保存せず聞き直す」と守っている。
    if (state.updatedAt
        && !_stateNeverExpires_(state.step)
        && (Date.now() - state.updatedAt > CONVERSATION_TIMEOUT_MS)) {
      clearState(userId);
      return createInitialState();
    }
    return state;
  } catch (e) {
    // 旧フォーマット（既存ボットの単純文字列ステート）との互換
    const s = createInitialState();
    s.step = raw;
    return s;
  }
}

/**
 * ユーザーの会話状態を保存する。
 * @param {string} userId
 * @param {Object} state
 */
function saveState(userId, state) {
  state.updatedAt = Date.now();
  const props = PropertiesService.getUserProperties();
  props.setProperty('state_' + userId, JSON.stringify(state));
}

/**
 * ユーザーの会話状態をクリアする。
 * @param {string} userId
 */
function clearState(userId) {
  const props = PropertiesService.getUserProperties();
  props.deleteProperty('state_' + userId);
}

/**
 * 期限で消さないステップか。条件登録フロー（STEP_ で始まる）だけが該当する。
 * 空室確認・入居申込・配信停止まわりは、放っておくと後日のメッセージを
 * 拾ってしまうので今まで通り24時間で消す。
 */
function _stateNeverExpires_(step) {
  return String(step || '').indexOf('STEP_') === 0;
}

/**
 * 自由入力を答えとして受け取ってよいか。
 * 期限を過ぎた状態に届いた文は、答えではなく別件の可能性が高いので取り込まない。
 */
function isStateFreshForFreeText(state) {
  if (!state || !state.updatedAt) return true;
  return (Date.now() - state.updatedAt) <= CONVERSATION_TIMEOUT_MS;
}

/**
 * 初期状態オブジェクトを生成する。
 * @return {Object}
 */
function createInitialState() {
  return {
    step: STEPS.IDLE,
    data: {},
    areaMethod: '',
    selectedRoutes: [],
    selectedCities: [],
    selectedTowns: {},
    selectedStations: {},
    updatedAt: Date.now()
  };
}

/**
 * 状態データの特定フィールドを更新する。
 * @param {Object} state - 現在の状態
 * @param {string} key - データキー
 * @param {*} value - 値
 * @return {Object} 更新された状態
 */
function updateStateData(state, key, value) {
  state.data[key] = value;
  return state;
}
