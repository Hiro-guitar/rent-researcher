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
    if (state.updatedAt && (Date.now() - state.updatedAt > CONVERSATION_TIMEOUT_MS)) {
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
