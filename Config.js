/**
 *  * Config.gs - 設定定数
  *
   * LINE Channel Access Token と各種シートIDを管理する。
    * デプロイ前に自分の値に書き換えること。
     */

     // ── LINE Messaging API ────────────────────────────────
     const CHANNEL_ACCESS_TOKEN = PropertiesService.getScriptProperties().getProperty('CHANNEL_ACCESS_TOKEN') || '';

     // ── Google Sheets ─────────────────────────────────────
     // 検索条件シート（物件検索条件スプレッドシート）
     const CRITERIA_SHEET_ID = '1u6NHowKJNqZm_Qv-MQQEDzMWjPOJfJiX1yhaO4Wj6lY';
     const CRITERIA_SHEET_NAME = '検索条件';

     // 既存ボット用 物件一覧シート
     const PROPERTY_SHEET_ID = '1oZKxfoZbFWzTfZvSU_ZVHtnWLDmJDYNd6MSfNqlB074';
     const PROPERTY_SHEET_NAME = 'シート1';

     // LINE Users シート（userId ↔ 顧客名マッピング）
     const LINE_USERS_SHEET_NAME = 'LINE Users';

     // ── SUUMO自動入稿関連シート ──────────────────────────────
     const SUUMO_PATROL_CRITERIA_SHEET = 'SUUMO巡回条件';
     const SUUMO_CANDIDATE_SHEET = 'SUUMO候補物件';
     const SUUMO_LISTING_SHEET = 'SUUMO掲載管理';

     // ── SUUMO Discord Webhook ────────────────────────────────
     const SUUMO_DISCORD_WEBHOOK_URL = PropertiesService.getScriptProperties().getProperty('SUUMO_DISCORD_WEBHOOK_URL') || '';

     // ── LIFF（LINE Front-end Framework）────────────────────
     const LIFF_ID = '2009257618-mx8s5Vuk';

     // ── 会話タイムアウト（ミリ秒）───────────────────────────
     const CONVERSATION_TIMEOUT_MS = 24 * 60 * 60 * 1000; // 24時間

// ── 会話ステップ定数 ──────────────────────────────────────
const STEPS = {
  IDLE:                 'IDLE',
  NAME:                 'STEP_NAME',
  REASON:               'STEP_REASON',
  REASON_CUSTOM:        'STEP_REASON_CUSTOM',
  MOVE_IN_DATE:         'STEP_MOVE_IN_DATE',
  MOVE_IN_PERIOD:       'STEP_MOVE_IN_PERIOD',
  CRITERIA_SELECT:      'STEP_CRITERIA_SELECT',
  RESIDENT:             'STEP_RESIDENT',
  RESIDENT_CUSTOM:      'STEP_RESIDENT_CUSTOM',
  NOTES:                'STEP_NOTES',
  CONFIRM:              'STEP_CONFIRM',
  DONE:                 'DONE',
  AREA_METHOD:          'STEP_AREA_METHOD',
  ROUTE_FLAT:           'STEP_ROUTE_FLAT',
  STATION_SELECT:       'STEP_STATION_SELECT',
  CITY_SELECT:          'STEP_CITY_SELECT',
  RENT_MAX:             'STEP_RENT_MAX',
  LAYOUTS:              'STEP_LAYOUTS',
  WALK:                 'STEP_WALK',
  AREA_MIN:             'STEP_AREA_MIN',
  BUILDING_AGE:         'STEP_BUILDING_AGE',
  BUILDING_TYPE:        'STEP_BUILDING_TYPE',
  EQUIPMENT:            'STEP_EQUIPMENT',
  EXISTING_WAITING_TYPE:        'waiting_for_type',
  EXISTING_WAITING_NATIONALITY: 'waiting_for_nationality',
  EXISTING_WAITING_NAME:        'waiting_for_name',
  EXISTING_WAITING_FURIGANA:    'waiting_for_furigana',
  EXISTING_WAITING_MOVEIN:      'waiting_for_movein_date',
  EXISTING_WAITING_EMAIL:       'waiting_for_email',
  WAITING_VACANCY:              'WAITING_VACANCY',
  WAITING_STOP_REASON:          'WAITING_STOP_REASON',
  WAITING_STOP_REASON_CUSTOM:   'WAITING_STOP_REASON_CUSTOM',
  WAITING_SNOOZE_PERIOD:        'WAITING_SNOOZE_PERIOD',
  WAITING_FREQUENCY:            'WAITING_FREQUENCY',
  WAITING_MISMATCH_CHOICE:      'WAITING_MISMATCH_CHOICE'
};
