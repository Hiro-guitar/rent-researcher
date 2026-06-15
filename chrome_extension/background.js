/**
 * background.js (Service Worker)
 * 物件自動取得の中核 — スケジューリング、検索オーケストレーション、状態管理
 * REINS + いえらぶBB対応
 *
 * 重要な技術的制約:
 * - REINSはVue 2 SPA。execute()をJS直接呼び出しすると認証エラーになる
 * - 条件セットはVue $dataに直接代入（scriptタグ注入・MAIN world）
 * - 検索実行・OKダイアログはDOMクリック（人間操作と同じ）
 * - 検索フォームへの遷移はURL直接遷移NG → メニューボタンクリック経由
 */

// 駅名解決失敗を蓄積するグローバル変数（検索サイクルごとにリセット）
// { customerName: { service: [stationName, ...], ... }, ... }
let _unresolvedStations = {};

// ═══ REINS検索カウンター（日次＋月次累計） ═══
// REINSの課金対象アクセス数を日別に記録し、月次累計も算出可能にする
// { month: 'YYYY-MM', days: { 'YYYY-MM-DD': { s: N, d: N }, ... } }
globalThis.__reinsUsageMonthly = { month: '', days: {} };
chrome.storage.local.get(['reinsUsageMonthly'], (d) => {
  const now = new Date();
  const curMonth = now.toLocaleDateString('sv-SE').slice(0, 7); // YYYY-MM
  if (d.reinsUsageMonthly && d.reinsUsageMonthly.month === curMonth) {
    globalThis.__reinsUsageMonthly = d.reinsUsageMonthly;
  } else {
    globalThis.__reinsUsageMonthly = { month: curMonth, days: {} };
    chrome.storage.local.set({ reinsUsageMonthly: globalThis.__reinsUsageMonthly });
  }
});
globalThis.__incrementReinsUsage = (type) => {
  const today = new Date().toLocaleDateString('sv-SE'); // YYYY-MM-DD
  const curMonth = today.slice(0, 7);
  if (globalThis.__reinsUsageMonthly.month !== curMonth) {
    globalThis.__reinsUsageMonthly = { month: curMonth, days: {} };
  }
  if (!globalThis.__reinsUsageMonthly.days[today]) {
    globalThis.__reinsUsageMonthly.days[today] = { s: 0, d: 0 };
  }
  const day = globalThis.__reinsUsageMonthly.days[today];
  if (type === 'search') day.s++;
  else if (type === 'detail') day.d++;
  chrome.storage.local.set({ reinsUsageMonthly: globalThis.__reinsUsageMonthly });
};


// 他サイトで「申込あり」として弾いた物件のキーを永続化(30日TTL)
// 形式: { "<building>|<room>": { ts: <timestamp>, url: <検出時の物件URL>, source: <検出元サイト名> }, ... }
// 旧形式 ({ "<key>": <timestamp> }) との後方互換も維持。
// REINS が最後に走るため、前段で収集したキーを参照して「前回実行で他サイトが申込ありと判定」を検知する。
const __MOSHIKOMI_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30日。期間内に他サイトが再度申込ありを検出すれば都度延長される
globalThis.__moshikomiSkipMap = {};
chrome.storage.local.get(['moshikomiSkipMap'], (d) => {
  const m = d.moshikomiSkipMap || {};
  const now = Date.now();
  for (const k in m) {
    const v = m[k];
    const ts = (typeof v === 'number') ? v : ((v && v.ts) || 0);
    if (ts && now - ts < __MOSHIKOMI_TTL_MS) {
      globalThis.__moshikomiSkipMap[k] = (typeof v === 'number') ? { ts: v, url: '', source: '' } : v;
    }
  }
});
globalThis.__normMoshikomiKey = (building, room) => {
  const nb = String(building || '').replace(/\s+/g, '').toLowerCase();
  const nr = String(room || '').replace(/[^\d]/g, '');
  if (!nb || !nr) return '';
  return `${nb}|${nr}`;
};
globalThis.__addMoshikomiKey = (building, room, url, source) => {
  const k = globalThis.__normMoshikomiKey(building, room);
  if (!k) return;
  globalThis.__moshikomiSkipMap[k] = {
    ts: Date.now(),
    url: url || '',
    source: source || ''
  };
  // 保存(デバウンスせず都度。サイズは小さい想定)
  chrome.storage.local.set({ moshikomiSkipMap: globalThis.__moshikomiSkipMap }).catch(()=>{});
};
globalThis.__removeMoshikomiKey = (building, room) => {
  const k = globalThis.__normMoshikomiKey(building, room);
  if (!k) return;
  if (globalThis.__moshikomiSkipMap[k]) {
    delete globalThis.__moshikomiSkipMap[k];
    chrome.storage.local.set({ moshikomiSkipMap: globalThis.__moshikomiSkipMap }).catch(()=>{});
  }
};
globalThis.__hasMoshikomiKey = (building, room) => {
  const k = globalThis.__normMoshikomiKey(building, room);
  if (!k) return false;
  const v = globalThis.__moshikomiSkipMap[k];
  const ts = (typeof v === 'number') ? v : (v && v.ts);
  return !!(ts && (Date.now() - ts < __MOSHIKOMI_TTL_MS));
};
// 申込ありとして弾いた時の検出元情報 (URL, source) を返す
globalThis.__getMoshikomiInfo = (building, room) => {
  const k = globalThis.__normMoshikomiKey(building, room);
  if (!k) return null;
  const v = globalThis.__moshikomiSkipMap[k];
  if (!v) return null;
  if (typeof v === 'number') return { ts: v, url: '', source: '' };
  return v;
};

// スキップログ末尾に追記する「物件URL」を返すヘルパー (空文字 or 先頭スペース付きURL)。
// - prop.url があればそれ
// - REINS 物件は url を持たないため、reins_property_number から「REINS で開く」相当URLを構築
//   (background.js の Discord リンクと同じ形式)
globalThis.__formatPropSkipUrl = (prop) => {
  if (!prop) return '';
  if (prop.url) return ' ' + prop.url;
  if (prop.reins_property_number) {
    const clean = String(prop.reins_property_number).replace(/\D/g, '');
    if (clean) return ' https://system.reins.jp/main/BK/GBK004100#bukken=' + clean;
  }
  return '';
};

// reason に応じてスキップログ末尾に付ける URL を切り替えるヘルパー。
// - reason が「他サイトで申込あり」を含む場合: 申込ありを最初に検出したサイトのURLを返す
//   (例: itandi で申込あり判定 → REINSスキップ時に itandi の物件URLが見たい)
// - それ以外: 通常通り当該物件のURL (__formatPropSkipUrl)
globalThis.__formatPropSkipUrlWithReason = (prop, reason) => {
  if (prop && typeof reason === 'string' && reason.includes('他サイトで申込あり')) {
    const info = globalThis.__getMoshikomiInfo && globalThis.__getMoshikomiInfo(prop.building_name, prop.room_number);
    if (info && info.url) {
      return ' ' + info.url + (info.source ? ` (${info.source}検出)` : '');
    }
  }
  return globalThis.__formatPropSkipUrl(prop);
};

// ─────────────────────────────────────────────────────────────
// 通知済み物件の重複検知 (お客様向け検索のみ、SUUMO巡回は対象外)
//
// 同じ物件が別管理会社・別サイト・別タイミングで複数登録されるケース
// (例: 今日itandiに「ラック上北沢 201」、明日REINSに「LUCK上北沢 201」が
//  別物件番号でアップ) で、お客様に同じ物件が30日以内に重複通知されないようにする。
//
// 識別キー = __buildPropertyDedupKey(prop) =
//   住所(町・丁目まで) + 部屋番号 + 面積(小数2桁) + 間取り
// 建物名は表記揺れ (カタカナ/英字、全角/半角等) が大きすぎるため使わない。
// 住所は番地以降を切り捨てて掲載粒度の差を吸収。
//
// 形式: { "<customer>": { "<dedupKey>": { ts, source, url }, ... }, ... }
const __NOTIFIED_DEDUP_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30日
globalThis.__notifiedDedupMap = {};
chrome.storage.local.get(['notifiedDedupMap'], (d) => {
  const m = d.notifiedDedupMap || {};
  const now = Date.now();
  for (const cust in m) {
    const inner = m[cust] || {};
    const cleaned = {};
    for (const k in inner) {
      const v = inner[k];
      const ts = (typeof v === 'number') ? v : (v && v.ts) || 0;
      if (ts && now - ts < __NOTIFIED_DEDUP_TTL_MS) {
        cleaned[k] = (typeof v === 'number') ? { ts: v, source: '', url: '' } : v;
      }
    }
    if (Object.keys(cleaned).length > 0) globalThis.__notifiedDedupMap[cust] = cleaned;
  }
});

// 全角英数字 → 半角に正規化するヘルパー (重複検知の安定化用、 2026-05-06 追加)
// String.toLowerCase() は ASCII しか変換しないため、 全角「Ｋ」 と半角「k」 が
// マッチせず重複検知が効かないケースがあった (例: いえらぶ「1K」 vs REINS「1Ｋ」)。
const __toHalfWidthAlnum = (s) => {
  return String(s || '').replace(/[Ａ-Ｚａ-ｚ０-９]/g, c =>
    String.fromCharCode(c.charCodeAt(0) - 0xFEE0)
  );
};

// 漢数字 → アラビア数字 (住所の「五丁目」 vs 「5丁目」 揺れに対応)
// 1〜10 程度の単純数字のみ対応 (住所の丁目数字に十分)。
// 「十一」 等の複合表現は実用上 丁目では出ないため非対応。
const __KANJI_DIGITS = { '一':'1','二':'2','三':'3','四':'4','五':'5','六':'6','七':'7','八':'8','九':'9','十':'10' };
const __kanjiToArabic = (s) => {
  return String(s || '').replace(/[一二三四五六七八九十]/g, c => __KANJI_DIGITS[c] || c);
};

// 間取りの表記揺れ統一
// - 「ワンルーム」「わんるーむ」 → 「1r」 (1R と同義扱い)
// - 全角英字を半角に、 lowercase 化
const __normalizeLayoutForKey = (s) => {
  let v = __toHalfWidthAlnum(s).replace(/\s+/g, '').toLowerCase();
  v = v.replace(/ワンルーム|わんるーむ|wanru-mu/g, '1r');
  return v;
};

// 都道府県プレフィックス除去 (47都道府県をカバー)。
// itandi API は時に "渋谷区..." と都道府県なしで来るが、いえらぶは詳細スクレイピング
// で「東京都...」と必ず付ける → dedup キーが食い違う原因だった。
// マッチパターン: 東京都 / 北海道 / 大阪府 / 京都府 / N文字+県 (43県)
const __PREF_PREFIX_RE = /^(東京都|北海道|大阪府|京都府|.{2,3}県)/;
const __stripPrefecturePrefix = (s) => String(s || '').replace(__PREF_PREFIX_RE, '');

// 識別キー生成
globalThis.__buildPropertyDedupKey = (prop) => {
  if (!prop) return '';
  // 住所: 全角英数字 → 半角、 漢数字 → アラビア、 都道府県プレフィックス除去、
  //       「N丁目X-Y」 等の番地以降切り捨て
  let addr = __toHalfWidthAlnum(prop.address);
  addr = __kanjiToArabic(addr);
  addr = __stripPrefecturePrefix(addr);
  addr = addr.replace(/(\d+)丁目.*$/, '$1丁目');
  addr = addr.replace(/\s+/g, '').toLowerCase();
  // 部屋番号: 全角→半角 + 漢数字→アラビア + 数字以外を除去
  // (「301号室」 「三〇一」 「301」 等いずれも「301」 にしたいが漢数字混じりは
  //  「三〇一」 → 「3〇1」 で 〇 が残る。 〇 (漢数字のゼロ U+3007) も 0 に変換)
  let room = __toHalfWidthAlnum(prop.room_number);
  room = __kanjiToArabic(room).replace(/[〇○]/g, '0');
  room = room.replace(/[^\d]/g, '');
  const area = Math.round((parseFloat(prop.area) || 0) * 100);
  // 間取り: 全角英字を半角化 + lowercase + 「ワンルーム」 を「1r」 に統一
  const layout = __normalizeLayoutForKey(prop.layout);
  // 4要素揃わない物件はキー化できない (= 重複判定対象外、通常通り通知)
  if (!addr || !room || !area || !layout) {
    // どの要素が欠けているかを log.html ダッシュボードログにも記録
    try {
      const missing = [];
      if (!addr) missing.push('address');
      if (!room) missing.push('room_number');
      if (!area) missing.push('area');
      if (!layout) missing.push('layout');
      const line = '[重複検知] キー生成不可: 欠落=' + missing.join(',')
        + ' building=' + (prop.building_name || '?')
        + ' source=' + (prop.source || '?')
        + ' addr="' + (prop.address || '').substring(0, 40) + '"'
        + ' room="' + (prop.room_number || '') + '"'
        + ' area="' + (prop.area || '') + '"'
        + ' layout="' + (prop.layout || '') + '"';
      console.log(line);
      if (typeof setStorageData === 'function') setStorageData({ debugLog: line });
    } catch (_) {}
    return '';
  }
  var key = `${addr}|${room}|${area}|${layout}`;
  return key;
};

// 重複検知の調査用ログ。ダッシュボードログ (log.html) にも出す。
// matchedBy: 'primary' / 'secondary(<existingKey>)' / ''
function _logDedupEvent_(action, customerName, prop, key, matched, matchedBy) {
  try {
    var line = '[重複検知/' + action + '] '
      + (customerName || '?')
      + ' [' + (prop.source || '?') + '] '
      + (prop.building_name || prop.buildingName || '?')
      + ' ' + (prop.room_number || prop.roomNumber || '')
      + ' key=' + (key || '(空)')
      + (matched ? ' → ヒット(スキップ' + (matchedBy ? ' by ' + matchedBy : '') + ')' : '');
    if (typeof setStorageData === 'function') {
      setStorageData({ debugLog: line });
    }
    console.log(line);
  } catch (_) {}
}

globalThis.__hasNotifiedDedupKey = (customerName, prop) => {
  const k = customerName ? globalThis.__buildPropertyDedupKey(prop) : '';
  let matched = false;
  let matchedBy = '';
  if (customerName) {
    const inner = globalThis.__notifiedDedupMap[customerName];
    if (inner) {
      // 1段目: プライマリキー (住所|部屋|面積|間取り) で完全一致
      if (k) {
        const v = inner[k];
        const ts = (typeof v === 'number') ? v : (v && v.ts);
        if (ts && (Date.now() - ts < __NOTIFIED_DEDUP_TTL_MS)) {
          matched = true;
          matchedBy = 'primary';
        }
      }
      // 2段目: セカンダリキー (建物名(正規化)+部屋号(数字)) で照合
      // 管理会社による住所/面積/間取りの表記揺れで primary が外れた時の保険。
      // 建物名+部屋号は通常一意性が高いので false positive リスクは低い。
      if (!matched) {
        const newSecondary = _buildSecondaryDedupKey_(prop);
        if (newSecondary) {
          for (const existingKey of Object.keys(inner)) {
            const v = inner[existingKey];
            const ts = (typeof v === 'number') ? v : (v && v.ts);
            if (!ts || (Date.now() - ts) > __NOTIFIED_DEDUP_TTL_MS) continue;
            if (v && v.secondary === newSecondary) {
              matched = true;
              matchedBy = 'secondary[' + existingKey + ']';
              break;
            }
          }
        }
      }
    }
  }
  // 早期 return ケース (customerName 無し / キー生成失敗) も含めて必ず出力。
  _logDedupEvent_('check', customerName || '(顧客名なし)', prop, k || '(キー生成不可)', matched, matchedBy);
  return matched;
};

globalThis.__getNotifiedDedupInfo = (customerName, prop) => {
  if (!customerName) return null;
  const k = globalThis.__buildPropertyDedupKey(prop);
  if (!k) return null;
  const inner = globalThis.__notifiedDedupMap[customerName];
  if (!inner) return null;
  const v = inner[k];
  if (!v) return null;
  if (typeof v === 'number') return { ts: v, source: '', url: '' };
  return v;
};

// セカンダリキー: 建物名(正規化) + 部屋番号(数字のみ)
// プライマリキー (address|room|area|layout) が食い違ったケースを自動検知するために
// 並行で計算する。
function _buildSecondaryDedupKey_(prop) {
  if (!prop) return '';
  var name = String(prop.building_name || prop.buildingName || '');
  name = name.normalize('NFKC').replace(/[\s　]+/g, '').replace(/[()（）\-－ｰ・,、.。]/g, '').toUpperCase();
  if (!name) return '';
  var room = String(prop.room_number || prop.roomNumber || '');
  room = room.normalize('NFKC').replace(/[^\d]/g, '');
  return name + '|' + room;
}

globalThis.__addNotifiedDedupKey = (customerName, prop, source) => {
  const k = customerName ? globalThis.__buildPropertyDedupKey(prop) : '';
  if (customerName && k) {
    if (!globalThis.__notifiedDedupMap[customerName]) globalThis.__notifiedDedupMap[customerName] = {};

    // ── dedup 漏れ自動検知 ──
    // 同顧客のマップで「建物名+部屋号が同じ・プライマリキーが違う」エントリが
    // 30日 (dedupTTL) 以内にあれば、dedup が効くべきだったのに効かなかった
    // 可能性が高い。注意: 同じプライマリキーで上書きされる場合は警告しない
    // (それは正常な更新)。
    try {
      const newSecondary = _buildSecondaryDedupKey_(prop);
      if (newSecondary) {
        const inner = globalThis.__notifiedDedupMap[customerName];
        for (const existingKey of Object.keys(inner)) {
          if (existingKey === k) continue;
          const v = inner[existingKey];
          const ts = (typeof v === 'number') ? v : (v && v.ts);
          if (!ts || (Date.now() - ts) > __NOTIFIED_DEDUP_TTL_MS) continue;
          const evSecondary = v && v.secondary;
          if (evSecondary && evSecondary === newSecondary) {
            const elapsedMin = Math.round((Date.now() - ts) / 60000);
            const warn = '[重複検知/⚠️漏れ] ' + customerName
              + ': 同物件 (' + (prop.building_name || '?') + ' ' + (prop.room_number || '') + ')'
              + ' が異なるキーで2回追加された。dedupが効くべきだった可能性大。\n'
              + '  既存 key: ' + existingKey + ' (元: ' + (v.source || '?') + ', ' + elapsedMin + '分前)\n'
              + '  新規 key: ' + k + ' (元: ' + (source || prop.source || '?') + ')';
            console.warn(warn);
            if (typeof setStorageData === 'function') setStorageData({ debugLog: warn });
            break;
          }
        }
      }
    } catch (warnErr) {
      console.warn('[重複検知] 漏れ判定エラー:', warnErr.message);
    }

    globalThis.__notifiedDedupMap[customerName][k] = {
      ts: Date.now(),
      source: source || (prop && prop.source) || '',
      url: (prop && prop.url) || '',
      // セカンダリキー (建物名+部屋号) もマップに保存して、次回の漏れ判定で参照できるようにする
      secondary: _buildSecondaryDedupKey_(prop)
    };
    chrome.storage.local.set({ notifiedDedupMap: globalThis.__notifiedDedupMap }).catch(() => {});
  }
  // 調査用ログ: 早期 return ケースも含めて必ず出力する。
  _logDedupEvent_('add', customerName || '(顧客名なし)', prop, k || '(キー生成不可)', false, '');
};

// バス・トイレ別の処理モード（'alert' or 'skip'）— options画面で設定
let __btMode = 'alert';
chrome.storage.local.get(['btMode'], (d) => { if (d.btMode) __btMode = d.btMode; });
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.btMode) __btMode = changes.btMode.newValue || 'alert';
});

// REINS条件セット関数（Vue $data注入）
importScripts('reins-criteria-func.js');
// いえらぶBB関連ファイルを読み込み
importScripts('ielove-config.js', 'ielove-oaza-config.js', 'ielove-background.js');
// itandi BB関連ファイルを読み込み
importScripts('itandi-config.js', 'itandi-background.js');
// itandi BB条件セット関数（React互換フォーム入力 + 駅選択モーダル）
importScripts('itandi-criteria-func.js');
// ES-Square関連ファイルを読み込み
importScripts('essquare-config.js', 'essquare-background.js');
// SUUMO巡回・入稿関連ファイルを読み込み
// suumo-competitor.js は suumo-patrol.js から countSuumoCompetitors を参照するので先にロード
importScripts('suumo-competitor.js', 'suumo-patrol.js');
// SUUMOビジネス Daily Search からの掲載実績取得(Phase 1)
importScripts('suumo-business-fetch.js');
// 空室状況チェック (通知済み物件の current_status 更新)
importScripts('availability-checker.js');
// ForRent掲載停止(保留化)自動操作(Phase 3)
importScripts('forrent-stop.js');
// ForRent確認画面の登録ボタン自動クリック(Phase 5)
importScripts('forrent-final-submit.js');
// ForRent PUB1R2801 の成約状態をシートに直読み同期
importScripts('forrent-status-sync.js');
// SUUMO広告一括更新(1日1回、SUUMO巡回終了後フック)
// forrent-status-sync.js の doForrentLogin_ と suumo-patrol.js の getOrCreateSuumoDailyThread_ を参照するため最後にロード
importScripts('suumo-bulk-update.js');
// LIFULL HOME'S 画像候補検索 (SUUMO承認時の入稿画像補完用)
importScripts('homes-search.js');
// 反響予測スコア計算 (4サイト共通の物件評価)
importScripts('inquiry-score.js');
// SUUMO検索から相場中央値を取得 (反響予測スコアの相場ソース)
importScripts('suumo-market-median.js');

// 拡張アイコンクリックでダッシュボード（log.html）を開く
chrome.action.onClicked.addListener(() => {
  openLogTab();
});


// === REINS物件番号オートサーチ（Discordリンクから #bukken=XXX で起動） ===
const __reinsAutoSearchHandled = new Set(); // tabIdごとに進行中フラグ
async function __getAutomationTabId() {
  try {
    const r = await new Promise(res => chrome.storage.local.get(['reinsAutomationTabId'], res));
    return r?.reinsAutomationTabId || null;
  } catch (e) { return null; }
}
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (!tab.url || !tab.url.includes('system.reins.jp')) return;
  const m = tab.url.match(/[#?&]bukken=(\d+)/);
  if (!m) return;
  if (changeInfo.status !== 'complete' && !changeInfo.url) return;
  const num = m[1];
  // 自動取得タブまたは検索結果/詳細ページがbukkenで上書きされた → 元に戻して別タブで開く
  const automationTabId = await __getAutomationTabId();
  const isAutomationTab = automationTabId === tabId;
  const isAutomationPage = /GBK002200|GBK003200/.test(tab.url);
  if (isAutomationTab || isAutomationPage) {
    // 自動取得タブには触らない（goBackするとVue状態が壊れる）。新規タブで開く
    try { await chrome.tabs.create({ url: 'https://system.reins.jp/main/BK/GBK004100#bukken=' + num, active: true }); } catch (e) {}
    return;
  }
  const key = tabId + ':' + num;
  if (__reinsAutoSearchHandled.has(key)) return;
  __reinsAutoSearchHandled.add(key);
  try {
    await reinsAutoSearchByNumber(tabId, num);
  } catch (e) {
    console.error('reinsAutoSearchByNumber error:', e);
  } finally {
    setTimeout(() => __reinsAutoSearchHandled.delete(key), 60000);
  }
});

async function reinsAutoSearchByNumber(tabId, num) {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  // ログイン画面なら諦める
  const tab0 = await chrome.tabs.get(tabId);
  if (/login|GKG001/i.test(tab0.url || '')) return;

  // 1) 物件番号検索ページへ遷移（Vueルーター経由）
  await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: () => {
      try {
        const n = window.$nuxt;
        if (n && n.$router) { n.$router.push('/main/BK/GBK004100'); return 'router'; }
      } catch (e) {}
      location.assign('https://system.reins.jp/main/BK/GBK004100');
      return 'location';
    }
  });

  // 2) GBK004100到達 & 物件番号入力欄出現を待つ
  for (let i = 0; i < 30; i++) {
    await sleep(500);
    const t = await chrome.tabs.get(tabId);
    if (!t.url?.includes('GBK004100')) continue;
    const ready = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const inputs = [...document.querySelectorAll('input[type="text"], input:not([type])')];
        for (const el of inputs) {
          const ctx = el.closest('.p-label, .form-group, div')?.parentElement?.textContent || '';
          if (ctx.includes('物件番号')) return true;
        }
        return false;
      }
    });
    if (ready?.[0]?.result) break;
  }

  // 3) 物件番号入力 → 検索ボタンクリック（MAIN worldでVue互換）
  await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: (number) => {
      const inputs = [...document.querySelectorAll('input[type="text"], input:not([type])')];
      let target = null;
      for (const el of inputs) {
        const ctx = el.closest('.p-label, .form-group, div')?.parentElement?.textContent || '';
        if (ctx.includes('物件番号')) { target = el; break; }
      }
      if (!target) return 'no_input';
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(target, number);
      target.dispatchEvent(new Event('input', { bubbles: true }));
      target.dispatchEvent(new Event('change', { bubbles: true }));
      setTimeout(() => {
        const btn = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === '検索');
        if (btn) btn.click();
      }, 300);
      return 'ok';
    },
    args: [num]
  });

  // 4) 検索結果ページ到達(GBK004200) → 詳細ボタンクリック
  for (let i = 0; i < 30; i++) {
    await sleep(500);
    const t = await chrome.tabs.get(tabId);
    if (!t.url?.includes('GBK004200')) continue;
    const clicked = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const detail = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === '詳細');
        if (detail) { detail.click(); return true; }
        return false;
      }
    });
    if (clicked?.[0]?.result) break;
  }
}

// === GAS API クライアント（inline） ===
async function getConfig() {
  return new Promise((resolve) => {
    chrome.storage.local.get(['gasWebappUrl', 'gasApiKey', 'discordWebhookUrl'], resolve);
  });
}

async function gasGet(action, params = {}) {
  const { gasWebappUrl, gasApiKey } = await getConfig();
  if (!gasWebappUrl) throw new Error('GAS URLが設定されていません');
  const url = new URL(gasWebappUrl);
  url.searchParams.set('action', action);
  url.searchParams.set('api_key', gasApiKey || '');
  url.searchParams.set('_t', Date.now()); // キャッシュバスティング
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v);
  }
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 30000);
  try {
    const resp = await fetch(url.toString(), { redirect: 'follow', signal: controller.signal, cache: 'no-store' });
    clearTimeout(timeoutId);
    if (!resp.ok) throw new Error(`GAS応答エラー: ${resp.status}`);
    return resp.json();
  } catch (err) {
    clearTimeout(timeoutId);
    if (err.name === 'AbortError') throw new Error(`GASリクエストタイムアウト (${action})`);
    throw err;
  }
}

async function gasPost(body) {
  const { gasWebappUrl, gasApiKey } = await getConfig();
  if (!gasWebappUrl) throw new Error('GAS URLが設定されていません');
  body.api_key = gasApiKey || '';
  const resp = await fetch(gasWebappUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: JSON.stringify(body),
    redirect: 'follow'
  });
  if (!resp.ok) throw new Error(`GAS応答エラー: ${resp.status}`);
  return resp.json();
}

async function fetchCriteria() { return gasGet('get_criteria'); }
async function fetchSeenIds() { return gasGet('get_seen_ids'); }
async function submitProperties(customerName, properties) {
  // SUUMO巡回モードではGASに顧客向け送信しない（コレクターに追加）
  if (globalThis._suumoPatrolMode && globalThis._suumoPatrolCollector) {
    for (const prop of properties) {
      // コレクターが async push を持つ場合は await（都度送信モード）
      await globalThis._suumoPatrolCollector.push(prop);
    }
    return { success: true, added: properties.length, _patrolCollected: true };
  }
  const threadId = discordThreadIds[customerName] || '';
  return gasPost({ action: 'add_reins_property', customer_name: customerName, properties, discord_thread_id: threadId });
}
// === END GAS API クライアント ===

// === 手動検索の顧客コンテキスト（タブID → 顧客名）===
// 手動検索機能で開いたタブの顧客名を覚えておき、手動送信パネルの顧客セレクトを
// 自動選択するために使う。storage.session に保存し、service worker 再起動後も
// 保持する（ブラウザを閉じると消える）。
async function recordManualSearchCustomer(tabId, customerName) {
  if (!tabId || !customerName) return;
  try {
    const { manualSearchCustomerByTab = {} } = await chrome.storage.session.get('manualSearchCustomerByTab');
    manualSearchCustomerByTab[String(tabId)] = customerName;
    await chrome.storage.session.set({ manualSearchCustomerByTab });
  } catch (e) { /* session storage 不可でも致命的ではない */ }
}
async function getManualSearchCustomer(tabId) {
  if (!tabId) return '';
  try {
    const { manualSearchCustomerByTab = {} } = await chrome.storage.session.get('manualSearchCustomerByTab');
    return manualSearchCustomerByTab[String(tabId)] || '';
  } catch (e) { return ''; }
}
// === END 手動検索の顧客コンテキスト ===

// ─────────────────────────────────────────────
// 手動送信(REINS)用: 詳細ページを開いて画像・詳細情報を取得する自己完結関数
//
// 自動巡回 searchForCustomer のインライン実装（詳細クリック→抽出→画像base64→
// catboxアップロード→一覧へ戻る）から、手動送信に必要な部分だけを複製した。
// searchForCustomer 本体には一切手を入れず、フィルタ/seen記録/統計などの副作用は持たない。
//
// @param {number} tabId      REINS検索結果(or詳細)が表示されているタブ
// @param {{propertyNumber:string, index:number}} target 物件番号と一覧での行index
// @param {{alreadyOnDetail?:boolean}} opts alreadyOnDetail=true なら既に詳細ページを開いている前提でクリック/戻るを省略（B案）
// @return {Promise<{ok:boolean, detail?:object, imageUrls?:string[], imageFailed?:number, error?:string}>}
//   detail は buildPropertyFlex 互換の camelCase（一覧アダプタと同じキー構成）
// ─────────────────────────────────────────────
async function fetchReinsDetailForManual(tabId, target, opts = {}) {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const alreadyOnDetail = !!opts.alreadyOnDetail;
  const propertyNumber = String((target && target.propertyNumber) || '');
  const rowIndex = (target && typeof target.index === 'number') ? target.index : -1;

  try {
    // ── 1. 詳細ボタンをクリックして詳細ページへ（B案=alreadyOnDetail はスキップ）──
    if (!alreadyOnDetail) {
      let clickStatus = 'not_found';
      for (let waitTry = 0; waitTry < 20; waitTry++) {
        const cr = await chrome.scripting.executeScript({
          target: { tabId },
          func: (propNum, rIdx) => {
            // 連続閲覧警告等のダイアログが出ていれば閉じる
            const dialogs = document.querySelectorAll('[role="dialog"], .modal.show');
            for (const dialog of dialogs) {
              const okBtn = [...dialog.querySelectorAll('button')].find(b => /OK|閉じる|はい/.test(b.textContent.trim()));
              if (okBtn) { okBtn.click(); return 'dialog_closed'; }
            }
            const rows = document.querySelectorAll('.p-table-body-row');
            if (rows.length === 0) return 'no_rows';
            // index で直接特定（同建物連続物件でも確実）
            if (rIdx >= 0 && rows[rIdx] && rows[rIdx].textContent.includes(propNum)) {
              const btn = [...rows[rIdx].querySelectorAll('button')].find(b => b.textContent.trim() === '詳細');
              if (btn) { btn.click(); return 'clicked'; }
            }
            // index がズレた場合は物件番号で末尾完全一致フォールバック
            for (const r of rows) {
              const items = r.querySelectorAll(':scope > .p-table-body-item');
              const cellText = (items[3] && items[3].textContent || '').trim();
              const m = cellText.match(/\b(100\d{8,})\b/);
              if (m && m[1] === propNum) {
                const btn = [...r.querySelectorAll('button')].find(b => b.textContent.trim() === '詳細');
                if (btn) { btn.click(); return 'clicked_fallback'; }
              }
            }
            return 'not_found_in_' + rows.length + '_rows';
          },
          args: [propertyNumber, rowIndex]
        });
        clickStatus = (cr && cr[0] && cr[0].result) || 'error';
        if (clickStatus === 'clicked' || clickStatus === 'clicked_fallback') break;
        await sleep(500);
      }
      if (clickStatus !== 'clicked' && clickStatus !== 'clicked_fallback') {
        return { ok: false, error: `詳細ボタンが見つからない(${clickStatus})` };
      }
      // SPA遷移: 詳細ページのラベル要素出現で描画完了を検知（遅延セクション含めて minCount を増やす）
      await waitForDomReady(tabId, '.p-label-title', { timeout: 15000, minCount: 5 });
      await waitForDomReady(tabId, '.p-label-title', { timeout: 15000, minCount: 20 });
    } else {
      // 既に詳細ページ前提でも、念のため描画完了を待つ
      await waitForDomReady(tabId, '.p-label-title', { timeout: 15000, minCount: 5 });
    }

    // ── 2. 詳細値を抽出（content-detail.js を注入してメッセージで取得）──
    // content-detail.js は GBK003200 にマッチするが SPA遷移(pushState)では再注入されないため、
    // ここで明示注入する。再注入ガードがあるので二重登録は起きない。
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: ['content-detail.js'] });
    } catch (e) {
      return { ok: false, error: 'content-detail.js注入失敗: ' + e.message };
    }
    await sleep(150);
    let detailResp;
    try {
      detailResp = await chrome.tabs.sendMessage(tabId, { type: 'EXTRACT_PROPERTY_DETAIL' });
    } catch (e) {
      return { ok: false, error: '詳細抽出メッセージ失敗: ' + e.message };
    }
    if (!detailResp || !detailResp.success || !detailResp.data) {
      return { ok: false, error: '詳細抽出失敗: ' + ((detailResp && detailResp.error) || 'no data') };
    }
    const d = detailResp.data; // snake_case

    // ── 3. 画像を base64 で取得（$nuxt→bkknGzuList、ページ内fetchでcookie付き）──
    let imageBase64s = [];
    try {
      const imageResults = await Promise.race([
        chrome.scripting.executeScript({
          target: { tabId },
          world: 'MAIN',
          func: async () => {
            async function fetchAsBase64(url) {
              try {
                const r = await fetch(url, { credentials: 'include' });
                if (!r.ok) return null;
                const blob = await r.blob();
                if (!blob || blob.size < 1000) return null;
                return await new Promise((resolve, reject) => {
                  const reader = new FileReader();
                  reader.onloadend = () => resolve(reader.result);
                  reader.onerror = reject;
                  reader.readAsDataURL(blob);
                });
              } catch (e) { return null; }
            }
            const sleep2 = (ms) => new Promise(r => setTimeout(r, ms));
            const images = [];
            const findList = () => {
              const walk = (c, depth = 0) => {
                if (depth > 10 || !c) return null;
                if (c.$data && Array.isArray(c.$data.bkknGzuList) && c.$data.bkknGzuList.length > 0) {
                  return c.$data.bkknGzuList;
                }
                const children = c.$children || [];
                for (const ch of children) {
                  const r = walk(ch, depth + 1);
                  if (r) return r;
                }
                return null;
              };
              return walk(window.$nuxt);
            };
            let list = null;
            for (let i = 0; i < 25; i++) {
              list = findList();
              if (list && list.length > 0) break;
              await sleep2(200);
            }
            if (!list || list.length === 0) return images;
            const sorted = [...list].sort((a, b) => {
              const an = parseInt(a.gzuBngu, 10) || 0;
              const bn = parseInt(b.gzuBngu, 10) || 0;
              return an - bn;
            });
            for (const item of sorted) {
              let url = item.bkknGzuSrc;
              if (!url) continue;
              if (url.startsWith('/')) url = location.origin + url;
              try {
                const base64 = await fetchAsBase64(url);
                if (base64) images.push(base64);
              } catch (e) {}
            }
            return images;
          }
        }),
        new Promise((resolve) => setTimeout(() => resolve(null), 120000))
      ]);
      const imgResult = (imageResults && imageResults[0] && imageResults[0].result) || [];
      imageBase64s = Array.isArray(imgResult) ? imgResult : (imgResult.images || []);
    } catch (e) {
      imageBase64s = [];
    }

    // ── 4. base64 を catbox 等へアップロードして公開URL化（並列6・3回リトライ）──
    let imageUrls = [];
    let imageFailed = 0;
    if (imageBase64s.length > 0) {
      async function uploadOne(b64) {
        const MAX_ATTEMPTS = 3;
        for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
          try {
            const publicUrl = await Promise.race([
              uploadBase64ToCatbox(b64),
              new Promise((_, reject) => setTimeout(() => reject(new Error('upload_overall_timeout_60s')), 60000))
            ]);
            if (publicUrl) return publicUrl;
            if (attempt < MAX_ATTEMPTS - 1) await sleep(1000);
          } catch (e) {
            if (attempt >= MAX_ATTEMPTS - 1) return null;
            if (e && e.rateLimited) {
              await sleep(2000 * Math.pow(2, attempt) + Math.floor(Math.random() * 500));
            } else {
              await sleep(1000);
            }
          }
        }
        return null;
      }
      const BATCH = 6;
      for (let i = 0; i < imageBase64s.length; i += BATCH) {
        const chunk = imageBase64s.slice(i, i + BATCH);
        const results = await Promise.all(chunk.map(uploadOne));
        for (const r of results) {
          if (r) imageUrls.push(r);
          else imageFailed++;
        }
      }
    }

    // ── 5. content-detail.js の snake_case フル詳細をそのまま使う（自動検索と同じ情報量）──
    //     承認パイプライン(add_reins_property)は snake_case をそのまま受けるため、
    //     camelCaseに削らず d を温存し、画像だけ公開URL化したものに差し替える。
    //     room_id(d.room_id) も温存（承認ページURL構築に使う）。
    const detail = Object.assign({}, d);
    detail.image_urls = imageUrls;
    detail.image_url = imageUrls[0] || '';
    detail.reins_property_number = d.reins_property_number || propertyNumber;
    detail.source = 'reins';

    // ── 6. 検索結果一覧(GBK002200)へ戻る（B案=alreadyOnDetail はスキップ）──
    if (!alreadyOnDetail) {
      try {
        // 残留モーダルを閉じる
        await chrome.scripting.executeScript({
          target: { tabId }, world: 'MAIN',
          func: () => {
            for (let i = 0; i < 3; i++) {
              const m = document.querySelector('.modal.show, .image-view');
              if (!m) break;
              const cb = document.querySelector('.modal.show .btn.btn-outline, .modal.show .close, .modal .btn.btn-outline');
              if (cb) cb.click();
              document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true }));
            }
          }
        });
        await sleep(500);
        // 戻る操作（UI戻るボタン→Vue Router→history）
        await chrome.scripting.executeScript({
          target: { tabId }, world: 'MAIN',
          func: () => {
            const backBtn = document.querySelector('.p-btn-back')
              || [...document.querySelectorAll('button')].find(el => /^(←|戻る|検索結果に戻る)/.test(el.textContent.trim()));
            if (backBtn) { backBtn.click(); return; }
            const nuxt = window.$nuxt;
            if (nuxt && nuxt.$router) { nuxt.$router.back(); return; }
            history.back();
          }
        });
        // 一覧に戻り、行が再描画されるまで待つ（次の物件処理のため）
        for (let bw = 0; bw < 20; bw++) {
          await sleep(500);
          const bt = await chrome.tabs.get(tabId);
          if (bw >= 6 && bt.url && bt.url.includes('GBK003200')) {
            await chrome.scripting.executeScript({
              target: { tabId }, world: 'MAIN',
              func: () => {
                const backBtn = document.querySelector('.p-btn-back')
                  || [...document.querySelectorAll('button')].find(el => /^(←|戻る|検索結果に戻る)/.test(el.textContent.trim()));
                if (backBtn) { backBtn.click(); return; }
                const nuxt = window.$nuxt;
                if (nuxt && nuxt.$router) nuxt.$router.back();
              }
            });
          }
          if (bt.url && bt.url.includes('GBK002200')) {
            const rowsCheck = await chrome.scripting.executeScript({
              target: { tabId },
              func: () => document.querySelectorAll('.p-table-body-row').length
            });
            if ((rowsCheck && rowsCheck[0] && rowsCheck[0].result) > 0) break;
          }
        }
      } catch (e) {
        // 戻り失敗は致命的ではない（detail は取得済み）。ログのみ。
        await setStorageData({ debugLog: `[手動送信] 一覧へ戻り失敗: ${e.message}` });
      }
    }

    return { ok: true, detail, imageUrls, imageFailed };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
}

/**
 * いえらぶ手動送信: 詳細ページを新タブで開いて情報を取得し閉じる。
 * REINS版(fetchReinsDetailForManual)と同じパイプラインに乗せるための前処理。
 */
async function fetchIeloveDetailForManual(baseProp) {
  // baseProp: いえらぶ一覧collectのcamelCase prop（url,rent,buildingName等）。後方互換で文字列URLも可。
  const bp = (typeof baseProp === 'string') ? { url: baseProp } : (baseProp || {});
  const detailUrl = bp.url || '';
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  let tabId = null;
  try {
    if (!detailUrl) return { ok: false, error: 'URLなし' };
    const tab = await chrome.tabs.create({ url: detailUrl, active: false });
    tabId = tab.id;
    await waitForTabLoad(tabId);
    await sleep(1500);

    // ログインチェック
    const tabInfo = await chrome.tabs.get(tabId);
    if (tabInfo.url && tabInfo.url.includes('/login')) {
      return { ok: false, error: 'いえらぶ未ログイン' };
    }

    // 詳細情報を抽出
    let detailResult;
    try {
      detailResult = await sendContentMessage(tabId, { type: 'IELOVE_EXTRACT_DETAIL' }, 15000);
    } catch (err) {
      return { ok: false, error: '詳細抽出失敗: ' + err.message };
    }
    if (!detailResult || !detailResult.ok || !detailResult.detail) {
      return { ok: false, error: '詳細データなし: ' + ((detailResult && detailResult.error) || '') };
    }

    const detail = detailResult.detail;
    detail.source = 'ielove';
    detail.url = detailUrl;

    // room_id が無ければ URL から生成
    if (!detail.room_id) {
      const m = detailUrl.match(/\/detail\/id\/(\d+)/);
      if (m) detail.room_id = 'ielove_' + m[1];
    }

    // 構造名の正規化（自動検索と同じ）
    if (detail.structure && typeof IELOVE_STRUCTURE_NORMALIZE !== 'undefined') {
      detail.structure = IELOVE_STRUCTURE_NORMALIZE[detail.structure] || detail.structure;
    }

    // 詳細ページで取れなかったフィールドを一覧(baseProp)からフォールバック。
    // いえらぶ詳細は span.rent_cost が無いページで賃料0になることがあるため、一覧の賃料を引き継ぐ。
    if (!detail.rent && bp.rent) detail.rent = Number(bp.rent) || 0;
    if (!detail.management_fee && bp.managementFee) detail.management_fee = Number(bp.managementFee) || 0;
    if (!detail.building_name && bp.buildingName) detail.building_name = bp.buildingName;
    if (!detail.room_number && bp.roomNumber) detail.room_number = bp.roomNumber;
    if (!detail.layout && bp.layout) detail.layout = bp.layout;
    if (!detail.area && bp.area) detail.area = bp.area;
    if (!detail.deposit && bp.deposit) detail.deposit = bp.deposit;
    if (!detail.key_money && bp.keyMoney) detail.key_money = bp.keyMoney;
    if (!detail.building_age && bp.buildingAge) detail.building_age = bp.buildingAge;
    if (!detail.station_info && bp.stationInfo) detail.station_info = bp.stationInfo;
    if (!detail.address && bp.address) detail.address = bp.address;
    if ((!detail.image_urls || !detail.image_urls.length) && bp.imageUrls && bp.imageUrls.length) detail.image_urls = bp.imageUrls;

    return { ok: true, detail };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  } finally {
    if (tabId) {
      try { await chrome.tabs.remove(tabId); } catch (_) {}
    }
  }
}

/**
 * itandi手動送信: 一覧アダプタが渡した基本物件(baseProp)に対し、詳細ページを
 * 新タブで開いて ITANDI_EXTRACT_DETAIL の結果をマージする。
 * 自動検索 searchItandiForCustomer の詳細マージと同じフィールド処理を踏襲。
 * @param {object} baseProp 一覧から取得した snake_case の基本物件（url, building_name 等）
 */
async function fetchItandiDetailForManual(baseProp) {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  let tabId = null;
  try {
    const detailUrl = (baseProp && baseProp.url) || '';
    if (!detailUrl) return { ok: false, error: 'URLなし' };

    const tab = await chrome.tabs.create({ url: detailUrl, active: false });
    tabId = tab.id;
    await waitForTabLoad(tabId);
    await sleep(2500); // React SPA の描画待ち

    // ログインチェック
    const tabInfo = await chrome.tabs.get(tabId);
    if (tabInfo.url && (tabInfo.url.includes('itandi-accounts.com') || tabInfo.url.includes('/login'))) {
      return { ok: false, error: 'itandi未ログイン' };
    }

    const prop = Object.assign({}, baseProp);
    prop.source = 'itandi';

    let detailResult;
    try {
      detailResult = await sendItandiContentMessage(tabId, { type: 'ITANDI_EXTRACT_DETAIL' }, 15000);
    } catch (err) {
      return { ok: false, error: '詳細抽出失敗: ' + err.message };
    }

    if (detailResult && detailResult.ok && detailResult.detail) {
      const d = detailResult.detail;
      // 詳細情報をマージ（searchItandiForCustomer と同一ロジック）
      if (d.image_urls && d.image_urls.length) {
        prop.image_urls = d.image_urls;
        if (!prop.image_url && d.image_urls[0]) prop.image_url = d.image_urls[0];
      }
      if (d.listing_status) prop.listing_status = d.listing_status;
      if (d.web_badge_count !== undefined) prop.web_badge_count = d.web_badge_count;
      if (d.needs_confirmation) prop.needs_confirmation = d.needs_confirmation;
      if (d.facilities) prop.facilities = d.facilities;
      if (d.guarantee_info) prop.guarantee_info = d.guarantee_info;

      const detailFields = [
        'floor_text', 'structure', 'total_units', 'lease_type', 'contract_period',
        'cancellation_notice', 'renewal_info', 'sunlight', 'shikibiki', 'pet_deposit',
        'free_rent', 'renewal_fee', 'renewal_admin_fee', 'fire_insurance',
        'key_exchange_fee', 'support_fee_24h', 'additional_deposit', 'guarantee_deposit',
        'water_billing', 'parking_fee', 'bicycle_parking_fee', 'motorcycle_parking_fee',
        'other_monthly_fee', 'other_onetime_fee', 'move_in_conditions', 'move_out_date',
        'move_in_date', 'free_rent_detail', 'layout_detail', 'preview_start_date',
        'ad_fee', 'cleaning_fee', 'rights_fee', 'current_status',
        'owner_company', 'owner_phone', 'ad_keisai',
      ];
      for (const key of detailFields) {
        if (d[key] && !prop[key]) prop[key] = d[key];
      }
      // 詳細ページの値で上書き（築年月を含む方を優先）
      if (d.building_age) prop.building_age = d.building_age;

      // 構造名を正規化
      if (prop.structure && typeof ITANDI_STRUCTURE_NORMALIZE !== 'undefined') {
        prop.structure = ITANDI_STRUCTURE_NORMALIZE[prop.structure] || prop.structure;
      }
      // 所在階をパースして floor に設定
      if (prop.floor_text) {
        const fm = prop.floor_text.match(/(\d+)/);
        if (fm) prop.floor = parseInt(fm[1], 10);
      }
    }

    if (!prop.building_name) return { ok: false, error: '物件名なし' };
    return { ok: true, detail: prop };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  } finally {
    if (tabId) {
      try { await chrome.tabs.remove(tabId); } catch (_) {}
    }
  }
}

// ─────────────────────────────────────────────
// 手動「競合数・反響点数」用: collect prop を snake_case に正規化。
// REINS/いえらぶは camelCase(managementFee,buildingAge,stationInfo,area文字列)、
// itandi は snake_case。countSuumoCompetitors / getSuumoMarketMedian /
// buildInquiryScoreInput はいずれも snake_case 系を読むため揃える。
// ─────────────────────────────────────────────
function normalizePropForMetrics(prop) {
  prop = prop || {};
  const num = (v) => {
    if (typeof v === 'number') return v;
    const n = parseFloat(String(v == null ? '' : v).replace(/[^\d.]/g, ''));
    return isFinite(n) ? n : 0;
  };
  return {
    rent: Number(prop.rent) || 0,
    management_fee: Number(prop.management_fee || prop.managementFee) || 0,
    area: num(prop.area || prop.usageArea),
    address: prop.address || '',
    layout: prop.layout || '',
    building_age: prop.building_age || prop.buildingAge || '',
    station_info: prop.station_info || prop.stationInfo || '',
    structure: prop.structure || '',
    story_text: prop.story_text || prop.storyText || '',
    facilities: prop.facilities || '',
  };
}

// SUUMO候補キー生成（GAS normalizeSuumoPropertyKey_ と同一式・決定的）。
// 建物名(空白除去・小文字) + '|' + 部屋番号(数字のみ)。
function suumoPropertyKey(building, room) {
  const b = String(building || '').replace(/[\s　]/g, '').toLowerCase();
  const r = String(room || '').replace(/[^\d]/g, '');
  return b + '|' + r;
}

// 手動: source 別に詳細取得関数を振り分け（顧客送信・SUUMO掲載で共用）。
async function enrichOneForManual(source, p, senderTabId, fromDetailPage) {
  if (source === 'reins') {
    return await fetchReinsDetailForManual(senderTabId, {
      propertyNumber: p.reins_property_number || p.propertyNumber || '',
      index: (typeof p.reins_row_index === 'number') ? p.reins_row_index : -1
    }, { alreadyOnDetail: !!fromDetailPage });
  } else if (source === 'ielove') {
    return await fetchIeloveDetailForManual(p.url || '');
  } else if (source === 'itandi') {
    return await fetchItandiDetailForManual(p);
  }
  return { ok: false, error: '未対応ソース: ' + source };
}

// === room_id ハッシュ化（ソース・ID形式の匿名化） ===
// 顧客向けURLにはハッシュ化したroom_idを使用し、
// どのサイトから取得したか・IDの形式から推測されないようにする。
const ROOM_ID_SALT = 'rr_v1_k7x9q2mA8pL5nC3bZ';
async function hashRoomId(source, rawId) {
  const input = ROOM_ID_SALT + '|' + (source || '') + '|' + (rawId || '');
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
}
// === END room_id ハッシュ化 ===

// === lineNameMap + reinsCodeMap ===
let cachedLineNameMap = null;
async function loadLineNameMap() {
  if (cachedLineNameMap) return cachedLineNameMap;
  const response = await fetch(chrome.runtime.getURL("lineNameMap.json"));
  cachedLineNameMap = await response.json();
  return cachedLineNameMap;
}

// 顧客の検索条件を1行の文字列にまとめる
function formatCustomerCriteria(customer) {
  const parts = [];
  if (customer.rent_max) parts.push(`〜${customer.rent_max}万`);
  // 路線・駅をまとめて表示（buildStationStringと同じ形式）
  const stationStr = buildStationString(customer);
  if (stationStr) parts.push(stationStr);
  if (customer.walk) parts.push(`徒歩${customer.walk}分`);
  if (customer.layouts?.length) parts.push(`間取: ${customer.layouts.join('/')}`);
  if (customer.area_min) parts.push(`面積${customer.area_min}㎡〜`);
  if (customer.building_age) parts.push(`築${customer.building_age}年`);
  if (customer.structures?.length) parts.push(`構造: ${customer.structures.join('/')}`);
  const equip = customer.equipment;
  if (equip) {
    if (Array.isArray(equip)) {
      if (equip.length) parts.push(`設備: ${equip.join(', ')}`);
    } else if (typeof equip === 'string' && equip) {
      parts.push(`設備: ${equip}`);
    }
  }
  return parts.join(' / ') || '(条件なし)';
}

let cachedReinsCodeMap = null;
async function loadReinsCodeMap() {
  if (cachedReinsCodeMap) return cachedReinsCodeMap;
  const response = await fetch(chrome.runtime.getURL("reinsCodeMap.json"));
  cachedReinsCodeMap = await response.json();
  return cachedReinsCodeMap;
}

// 顧客条件からstation文字列を組み立て
function buildStationString(customer) {
  const rws = customer.routes_with_stations || [];
  if (rws.length > 0) {
    return rws.map(r => {
      if (r.stations && r.stations.length > 0) {
        return `${r.route}：${r.stations.join(', ')}`;
      }
      return r.route;
    }).join(' / ');
  }
  // フォールバック（旧フォーマット）
  const routes = customer.routes || [];
  const stations = customer.stations || [];
  if (routes.length === 0) return '';
  if (routes.length === 1) {
    const stationList = stations.join(', ');
    return stationList ? `${routes[0]}：${stationList}` : routes[0];
  }
  return routes.join(' / ');
}

// 顧客条件に基づく物件フィルタリング
function filterByCustomerCriteria(properties, customer) {
  return properties.filter(prop => !getFilterRejectReason(prop, customer));
}

// 町名表記を正規化（漢数字→算用数字、全角→半角）
function _normalizeTownText(s) {
  if (!s) return '';
  let r = s.replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));
  const kanjiMap = {'一':'1','二':'2','三':'3','四':'4','五':'5','六':'6','七':'7','八':'8','九':'9','十':'10'};
  r = r.replace(/[一二三四五六七八九十]/g, c => kanjiMap[c] || c);
  r = r.replace(/\s+/g, '');
  return r;
}

// 住所テキストが指定された町名を含むかチェック（表記ゆれ対応）
function _addressMatchesTown(address, town) {
  if (address.includes(town)) return true;
  return _normalizeTownText(address).includes(_normalizeTownText(town));
}

// フィルタ不合格の理由を返す（合格ならnull）
function getFilterRejectReason(prop, customer) {
  // 町名丁目フィルタ（selectedTownsが指定されている場合、住所テキストで照合）
  if (customer.selectedTowns && Object.keys(customer.selectedTowns).length > 0) {
    const addr = prop.address || '';
    if (addr) {
      let townMatch = false;
      for (const city of Object.keys(customer.selectedTowns)) {
        const towns = customer.selectedTowns[city];
        if (!towns || towns.length === 0) continue;
        if (!addr.includes(city)) continue;
        for (const town of towns) {
          if (_addressMatchesTown(addr, town)) {
            townMatch = true;
            break;
          }
        }
        if (townMatch) break;
      }
      if (!townMatch) {
        return `町名不一致: ${addr}`;
      }
    }
  }

  // 構造フィルタ（顧客条件は「鉄筋系」等のカテゴリ名、REINS詳細は日本語名に正規化済み）
  if (customer.structures && customer.structures.length > 0) {
    if (!prop.structure) return `構造不明（要求: ${customer.structures.join('/')})`;
    // カテゴリ→許可する日本語構造名の展開
    // 「鉄骨造」「鉄骨」のように「造」あり/なし表記が両方ありえるため両方含める
    // (ES-Square 詳細ページから「鉄骨」「軽量鉄骨」が取得されるケースの対応)
    const categoryMap = {
      '鉄筋系': ['鉄筋コンクリート', '鉄骨鉄筋コンクリート'],
      '鉄骨系': ['鉄骨造', '軽量鉄骨造', '鉄骨', '軽量鉄骨'],
      '木造': ['木造'],
      'ブロック・その他': ['コンクリートブロック', 'ALC造', 'プレキャストコンクリート', '鉄骨プレキャストコンクリート', 'その他']
    };
    // 許可する構造名のセットを構築
    const allowedNames = new Set();
    for (const s of customer.structures) {
      if (categoryMap[s]) {
        categoryMap[s].forEach(n => allowedNames.add(n));
      } else {
        allowedNames.add(s);
      }
    }
    if (!allowedNames.has(prop.structure)) {
      return `構造不一致: ${prop.structure}（要求: ${customer.structures.join('/')})`;
    }
  }

  // 他サイト(itandi/ES-Square/いえらぶ)で申込ありとして弾かれた物件は同一実行内でREINSでもスキップ
  // SUUMO巡回モード時はスキップせずDiscord通知(⚠️ 募集状況: 申込あり)へ流す
  try {
    if (!globalThis._suumoPatrolMode && globalThis.__hasMoshikomiKey && globalThis.__hasMoshikomiKey(prop.building_name, prop.room_number)) {
      return '他サイトで申込あり(前回実行)';
    }
  } catch(e) {}

  // SUUMO巡回モードのREINS物件: 広告転載区分「不可」ならスキップ
  // 「広告可」→通過 / 「広告可（但し要連絡）」→通過（Discord通知で⚠️警告表示）
  if (globalThis._suumoPatrolMode && prop.ad_keisai === '不可') {
    return '広告転載区分: 不可';
  }

  // 新築フィルタ（顧客が「新築」指定の場合、新築フラグが「新築」の物件のみ通過）
  if (customer.building_age && String(customer.building_age).includes('新築')) {
    if (!prop.shinchiku_flag || !prop.shinchiku_flag.includes('新築')) {
      return `新築でない: 新築フラグ=${prop.shinchiku_flag || 'なし'}`;
    }
  }

  // 賃料＋管理費フィルタ（顧客の rent_max は管理費込みの上限）
  if (customer.rent_max && prop.rent) {
    const rentMaxYen = parseFloat(customer.rent_max) * 10000;
    const totalRent = prop.rent + (prop.management_fee || 0);
    if (totalRent > rentMaxYen) {
      return `賃料+管理費超過: ${totalRent}円 > ${rentMaxYen}円（賃料${prop.rent}+管理費${prop.management_fee || 0}）`;
    }
  }

  // 駅名＋徒歩フィルタ
  let allStations = customer.stations || [];
  if (customer.routes_with_stations && customer.routes_with_stations.length > 0) {
    const rwsStations = customer.routes_with_stations.flatMap(r => r.stations || []);
    if (rwsStations.length > 0) allStations = rwsStations;
  }

  if (allStations.length > 0) {
    // メイン駅 + その他交通をすべて結合して判定
    const transports = [];
    if (prop.station_info) {
      transports.push(...prop.station_info.split('/').map(s => s.trim()));
    }
    if (prop.other_stations && prop.other_stations.length > 0) {
      transports.push(...prop.other_stations.map(s => s.trim()));
    }

    if (transports.length === 0) {
      return '交通情報なし';
    }

    const walkMax = customer.walk ? parseInt(String(customer.walk).replace(/[^\d]/g, '')) : 0;

    const normStn = (s) => String(s || '').replace(/駅$/, '').trim();
    const hasMatch = transports.some(transport => {
      const tNorm = normStn(transport);
      const stationMatch = allStations.some(s => {
        const sn = normStn(s);
        return sn && tNorm.includes(sn);
      });
      if (!stationMatch) return false;
      if (walkMax > 0) {
        const walkMatch = transport.match(/徒歩\s*(\d+)/);
        if (walkMatch) {
          const propWalk = parseInt(walkMatch[1]);
          if (propWalk > walkMax) return false;
        }
      }
      return true;
    });
    if (!hasMatch) {
      const allTransportStr = transports.join(' / ');
      if (walkMax > 0) {
        return `駅/徒歩不一致: ${allTransportStr}（徒歩${walkMax}分以内）`;
      }
      return `駅不一致: ${allTransportStr}`;
    }
  }

  // 間取りフィルタ（REINS検索はタイプ×部屋数のクロス積のため、詳細取得後に正確にフィルタ）
  if (customer.layouts && customer.layouts.length > 0 && prop.layout) {
    // REINS間取りタイプをお客さんのカテゴリに正規化
    // LK→LDK, SK→K, SDK→DK, SLK→LDK, SLDK→LDK
    const normalizeType = (t) => {
      const u = t.replace(/\s/g, '').toUpperCase()
        .replace(/Ｋ/g, 'K').replace(/Ｄ/g, 'D').replace(/Ｌ/g, 'L').replace(/Ｓ/g, 'S');
      if (u === 'LK') return 'LDK';
      if (u === 'SK') return 'K';
      if (u === 'SDK') return 'DK';
      if (u === 'SLK' || u === 'SLDK') return 'LDK';
      return u;
    };
    // 物件の間取りをパース（例: "2LDK" → rooms=2, type="LDK"）
    const propLayout = prop.layout.replace(/\s/g, '');
    const propMatch = propLayout.match(/^(\d+)\s*(.+)$/);
    let propRooms = 0;
    let propType = '';
    if (propMatch) {
      propRooms = parseInt(propMatch[1]);
      propType = normalizeType(propMatch[2]);
    } else if (propLayout.includes('ワンルーム') || propLayout.toUpperCase() === 'R') {
      propRooms = 1;
      propType = 'R';
    }

    if (propRooms > 0 && propType) {
      const propNormalized = propType === 'R' ? 'ワンルーム' : propRooms + propType;
      // 顧客の指定間取りリストと照合
      const allowed = customer.layouts.some(layout => {
        if (layout.includes('以上')) {
          // "4K以上" → 4部屋以上かつK/DK/LDK
          const aboveMatch = layout.replace(/以上/g, '').trim().match(/^(\d+)\s*(.+)$/);
          if (aboveMatch) {
            const minRooms = parseInt(aboveMatch[1]);
            const baseType = normalizeType(aboveMatch[2]);
            // 「4K以上」= 4部屋以上で、K/DK/LDKいずれか
            if (propRooms >= minRooms) {
              if (baseType === 'K') return ['K', 'DK', 'LDK'].includes(propType);
              if (baseType === 'DK') return ['DK', 'LDK'].includes(propType);
              return propType === baseType;
            }
          }
          return false;
        }
        // 通常の間取り（完全一致）
        const custMatch = layout.match(/^(\d+)\s*(.+)$/);
        if (custMatch) {
          const custRooms = parseInt(custMatch[1]);
          const custType = normalizeType(custMatch[2]);
          return propRooms === custRooms && propType === custType;
        }
        if (layout.includes('ワンルーム')) return propType === 'R';
        return false;
      });
      if (!allowed) {
        return `間取り不一致: ${prop.layout}（要求: ${customer.layouts.join(', ')}）`;
      }
    }
  }

  // 南向きフィルタ（バルコニー方向に「南」を含むか判定。情報なしは通過）
  const toHankaku = (s) => s.replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));
  const equip = toHankaku(customer.equipment || '').toLowerCase();
  if (equip.includes('南向き')) {
    if (prop.sunlight && !prop.sunlight.includes('南')) {
      return `南向きでない: バルコニー方向=${prop.sunlight}`;
    }
  }

  // 最上階フィルタ
  if (equip.includes('最上階')) {
    const floorNum = parseInt(toHankaku(prop.floor_text || '').match(/(\d+)/)?.[1] || '0');
    const storyNum = parseInt(toHankaku(prop.story_text || '').match(/(\d+)/)?.[1] || '0');
    if (floorNum > 0 && storyNum > 0 && floorNum < storyNum) {
      return `最上階でない: ${prop.floor_text}/${prop.story_text}`;
    }
  }

  // 階数フィルタ（2階以上、1階のみ）
  {
    const floorNum = parseInt(toHankaku(prop.floor_text || '').match(/(\d+)/)?.[1] || '0');
    if (equip.includes('2階以上') && floorNum > 0 && floorNum < 2) {
      return `2階以上条件: ${floorNum}階`;
    }
    if (equip.includes('1階') && !equip.includes('1階以上') && !equip.includes('2階以上') && floorNum > 0 && floorNum !== 1) {
      return `1階限定条件: ${floorNum}階`;
    }
  }

  // 角部屋 → アラート（buildDiscordMessageで処理）

  // ロフトNGフィルタ（ロフトがある場合は除外。情報なしは通過→アラートで対応）
  if (equip.includes('ロフトng') || equip.includes('ロフト不可')) {
    const fac = prop.facilities || '';
    if (fac && fac.includes('ロフト')) {
      return `ロフト付き物件（ロフトNG）`;
    }
  }

  // ガス種別フィルタ（都市ガス希望→プロパンならスキップ、逆も同様。情報なしは通過）
  {
    const fac = prop.facilities || '';
    if (equip.includes('都市ガス') && fac && !fac.includes('都市ガス') && fac.includes('プロパンガス')) {
      return `プロパンガス物件（都市ガス希望）`;
    }
    if ((equip.includes('プロパン') || equip.includes('lpガス')) && fac && !fac.includes('プロパンガス') && fac.includes('都市ガス')) {
      return `都市ガス物件（プロパンガス希望）`;
    }
  }

  // バス・トイレ別スキップモード（顧客ごとの btMode、またはグローバル設定で 'skip' の場合、設備欄に無ければ除外）
  {
    const _customerBtMode = (customer.btMode || __btMode || 'alert').toLowerCase();
    if (_customerBtMode === 'skip' && (equip.includes('バストイレ別') || equip.includes('バス・トイレ別') || equip.includes('bt別'))) {
      const fac = prop.facilities || '';
      if (!fac.includes('バス・トイレ別') && !fac.includes('バストイレ別')) {
        return `バス・トイレ別の記載なし`;
      }
    }
  }

  // ペット可フィルタ（REINS表記: ペット可/ペット相談。記載なし・設備なしは除外）
  if (equip.includes('ペット')) {
    const fac = prop.facilities || '';
    if (!fac.includes('ペット可') && !fac.includes('ペット相談')) {
      return `ペット可の記載なし`;
    }
  }

  // 事務所利用可フィルタ（REINS表記: 事務所使用可。記載なし・設備なしは除外）
  if (equip.includes('事務所')) {
    const fac = prop.facilities || '';
    if (!fac.includes('事務所使用可')) {
      return `事務所利用可の記載なし`;
    }
  }

  // フリーレントフィルタ（free_rentフィールドまたはfacilitiesにフリーレント記載がなければ除外）
  if (equip.includes('フリーレント')) {
    const fac = prop.facilities || '';
    const freeRent = prop.free_rent || '';
    const hasFreeRent = fac.includes('フリーレント') || (freeRent && freeRent !== 'なし' && freeRent !== '-');
    if (!hasFreeRent) {
      return `フリーレントなし`;
    }
  }

  // 定期借家を含まないフィルタ（設備に定期借家借地権、またはlease_typeに定期借家）
  if (equip.includes('定期借家を含まない') || equip.includes('定期借家除く')) {
    const fac = prop.facilities || '';
    if (fac.includes('定期借家') || (prop.lease_type && prop.lease_type.includes('定期借家'))) {
      return `定期借家物件`;
    }
  }

  return null; // 合格
}

// 築年月文字列から築年（西暦）を抽出
// "2015年03月" → 2015, "平成27年3月" → 2015, "令和2年" → 2020
function parseBuildingAge(str) {
  if (!str) return null;

  // 西暦パターン
  const westernMatch = str.match(/(\d{4})\s*年/);
  if (westernMatch) return parseInt(westernMatch[1]);

  // 和暦パターン
  const eraMatch = str.match(/(令和|平成|昭和)\s*(\d+)\s*年/);
  if (eraMatch) {
    const era = eraMatch[1];
    const year = parseInt(eraMatch[2]);
    if (era === '令和') return 2018 + year;
    if (era === '平成') return 1988 + year;
    if (era === '昭和') return 1925 + year;
  }

  return null;
}

// --- 自動検索トグルに応じてスリープ抑制を制御 ---
function __applyKeepAwakeForAutoSearch() {
  try {
    chrome.storage.local.get(['autoSearchEnabled'], (d) => {
      if (!chrome.power) return;
      if (d.autoSearchEnabled !== false) {
        try { chrome.power.requestKeepAwake('system'); } catch(e) {}
        // SWが停止してもalarmで定期的に起こしてkeepAwakeを再設定
        chrome.alarms.create('keep-awake', { periodInMinutes: 1 });
      } else {
        try { chrome.power.releaseKeepAwake(); } catch(e) {}
        chrome.alarms.clear('keep-awake');
      }
    });
  } catch(e) {}
}
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && 'autoSearchEnabled' in changes) __applyKeepAwakeForAutoSearch();
});
// SW起動時(ブラウザ起動/SW再起動)にも状態を反映
__applyKeepAwakeForAutoSearch();
if (chrome.runtime.onStartup) chrome.runtime.onStartup.addListener(__applyKeepAwakeForAutoSearch);

// --- スリープ復帰時に自動検索を再開 ---
chrome.idle.setDetectionInterval(60); // 60秒操作なしでidle判定
chrome.idle.onStateChanged.addListener((state) => {
  if (state === 'active') {
    // locked/idle → active に戻った = スリープ復帰
    // 既存アラームが残っていればそのまま、失効していれば再セット
    chrome.storage.local.get(['autoSearchEnabled', 'searchIntervalMinutes'], (data) => {
      if (data.autoSearchEnabled === false) return;
      chrome.alarms.get('reins-search', (alarm) => {
        if (alarm) {
          const remainMin = ((alarm.scheduledTime - Date.now()) / 60000).toFixed(1);
          console.log(`[system] スリープ復帰検知 → 既存アラームあり（残り${remainMin}分）、再セットスキップ`);
          setStorageData({ debugLog: `[system] スリープ復帰検知 → 既存アラームあり（残り${remainMin}分）、再セットスキップ` });
        } else {
          console.log('[system] スリープ復帰検知 → アラーム失効、再セット');
          setStorageData({ debugLog: '[system] スリープ復帰検知 → アラーム失効、再セット' });
          setupAlarm(data.searchIntervalMinutes || 30);
        }
      });
    });
  }
});

// --- 初期化 ---
chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.get(['searchIntervalMinutes'], (data) => {
    setupAlarm(data.searchIntervalMinutes || 30);
  });
  chrome.storage.local.set({ isSearching: false });
  __applyKeepAwakeForAutoSearch();
  chrome.storage.local.get(['stats'], (data) => {
    if (!data.stats) {
      chrome.storage.local.set({
        stats: { totalFound: 0, totalSubmitted: 0, errors: [], lastError: null }
      });
    }
  });
  // SUUMO入稿: backup poll（スマホ承認など拡張トリガーを受け取れなかった分の取りこぼし対策）
  // 基本は承認ページからの即時トリガー(SUUMO_APPROVED_NOW)で起動するので、60分に1回で十分
  chrome.alarms.create('suumo-queue-poll', { delayInMinutes: 60 });
  // 優先空室確認ポーリング: 1分毎にGASから優先キューを取得
  chrome.alarms.create('priority-availability-poll', { periodInMinutes: 1 });
  // キャンセル通知希望物件の定期巡回: 30分毎にチェック
  chrome.alarms.create('cancellation-watch-poll', { periodInMinutes: 30 });
  // 定期空室確認(3時間毎の全物件巡回)は廃止。
  // 規約違反(機械的アクセス)による各サイトのBANリスクを避けるため停止。
  // 空室確認は「再送付時にその顧客の物件だけ」「LINEの個別依頼(優先キュー)」のオンデマンドのみ。
  chrome.alarms.clear('periodic-availability-check');
});

// Chrome起動時: 前回起動中に承認された取りこぼしを1回だけ処理
chrome.runtime.onStartup.addListener(() => {
  console.log('[SUUMO入稿] Chrome起動 → backup poll実行');
  setTimeout(() => {
    pollAndStartFillIfNeeded({ source: 'startup' }).catch(err => {
      console.log(`[SUUMO入稿] onStartup poll失敗: ${err.message}`);
    });
  }, 5000); // ネットワーク初期化待ち
  // backup pollアラーム再セット
  chrome.alarms.create('suumo-queue-poll', { delayInMinutes: 60 });
  // 優先空室確認ポーリングも再セット
  chrome.alarms.create('priority-availability-poll', { periodInMinutes: 1 });
  // 定期空室確認(3時間毎の全物件巡回)は廃止 — BANリスク回避のため停止（オンデマンドのみ）
  chrome.alarms.clear('periodic-availability-check');
});

// 入稿専用タブのクローズ検知 → suumoFillTabIdをクリア
chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.storage.local.get(['suumoFillTabId'], (data) => {
    if (data.suumoFillTabId === tabId) {
      console.log(`[SUUMO入稿] 入稿タブ(${tabId})がクローズされた → suumoFillTabIdクリア`);
      chrome.storage.local.remove(['suumoFillTabId', 'suumoFillQueue']);
    }
  });
});

// 入稿タブがforrent.jp外に遷移したら入稿タブ扱いを解除
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (!changeInfo.url) return;
  chrome.storage.local.get(['suumoFillTabId'], (data) => {
    if (data.suumoFillTabId !== tabId) return;
    if (!changeInfo.url.includes('fn.forrent.jp')) {
      console.log(`[SUUMO入稿] 入稿タブ(${tabId})がforrent外に遷移 → suumoFillTabIdクリア`);
      chrome.storage.local.remove(['suumoFillTabId', 'suumoFillQueue']);
    }
  });
});

chrome.storage.local.set({ isSearching: false });

// 検索サイクルID（中止判定用）
//   顧客検索 (runSearchCycle) と SUUMO巡回 (runSuumoPatrolCycle) で別カウンタを
//   持つ。以前は currentSearchId を共有していたため、SUUMO巡回が ++currentSearchId
//   した瞬間に顧客検索が isSearchCancelled で誤キャンセルされる問題があった。
let currentSearchId = 0;       // 顧客検索 (runSearchCycle) の世代
let currentPatrolSearchId = 0; // SUUMO巡回 (runSuumoPatrolCycle) の世代

// isSearchCancelled は両方のカウンタを見て、「自分のカウンタが進められた場合のみ
// キャンセル」と判定する。OR 判定なので、もう一方の cycle が進んでも自分はそのまま
// 走り続けられる。
function isSearchCancelled(searchId) {
  return searchId !== currentSearchId && searchId !== currentPatrolSearchId;
}

// --- アラーム（営業時間 + ジッター対応） ---
// 次回実行時刻を計算（営業時間外なら翌営業開始時刻、内ならランダムジッター付き間隔）
function computeNextRunDelayMs(intervalMinutes, jitterPercent, startHour, endHour) {
  const now = new Date();
  const hour = now.getHours();
  // 営業時間外 → 次の営業開始時刻まで
  if (hour < startHour || hour >= endHour) {
    const next = new Date(now);
    if (hour >= endHour) next.setDate(next.getDate() + 1);
    next.setHours(startHour, 0, 0, 0);
    // 営業開始直後のスパイク回避のため 0〜10分のランダムオフセット
    return next.getTime() - now.getTime() + Math.floor(Math.random() * 10 * 60 * 1000);
  }
  // 営業時間内 → 間隔 ± ジッター%
  const base = Math.max(10, intervalMinutes) * 60 * 1000;
  const j = (jitterPercent || 0) / 100;
  const delta = base * j;
  const delay = base + (Math.random() * 2 - 1) * delta; // base ± delta
  // 次回実行が営業時間を超える場合は翌営業開始時刻に
  const nextTime = new Date(now.getTime() + delay);
  if (nextTime.getHours() >= endHour || nextTime.getDate() !== now.getDate()) {
    const next = new Date(now);
    next.setDate(next.getDate() + 1);
    next.setHours(startHour, 0, 0, 0);
    return next.getTime() - now.getTime() + Math.floor(Math.random() * 10 * 60 * 1000);
  }
  return delay;
}

function setupAlarm(intervalMinutes) {
  chrome.storage.local.get(['jitterPercent', 'businessStartHour', 'businessEndHour'], (data) => {
    const jitter = data.jitterPercent !== undefined ? data.jitterPercent : 20;
    const startH = data.businessStartHour !== undefined ? data.businessStartHour : 10;
    const endH = data.businessEndHour !== undefined ? data.businessEndHour : 20;
    const delayMs = computeNextRunDelayMs(intervalMinutes, jitter, startH, endH);
    chrome.alarms.clear('reins-search', () => {
      chrome.alarms.create('reins-search', { when: Date.now() + delayMs });
      const mins = (delayMs / 60000).toFixed(1);
      console.log(`REINS検索アラーム設定: 次回 ${mins}分後 (営業${startH}-${endH}時, ジッター±${jitter}%)`);
    });
  });
}

// SUUMO巡回アラームの設定 (顧客検索の setupAlarm と同じ営業時間/ジッター方式)
function setupSuumoPatrolAlarm(intervalMinutes) {
  chrome.storage.local.get(['jitterPercent', 'businessStartHour', 'businessEndHour'], (data) => {
    const jitter = data.jitterPercent !== undefined ? data.jitterPercent : 20;
    const startH = data.businessStartHour !== undefined ? data.businessStartHour : 10;
    const endH = data.businessEndHour !== undefined ? data.businessEndHour : 20;
    const delayMs = computeNextRunDelayMs(intervalMinutes, jitter, startH, endH);
    chrome.alarms.clear('suumo-patrol', () => {
      chrome.alarms.create('suumo-patrol', { when: Date.now() + delayMs });
      const mins = (delayMs / 60000).toFixed(1);
      console.log(`SUUMO巡回アラーム設定: 次回 ${mins}分後 (営業${startH}-${endH}時, ジッター±${jitter}%)`);
    });
  });
}

chrome.alarms.onAlarm.addListener((alarm) => {
  // 1分ごとにkeepAwakeを再設定（SW停止による解除を防ぐ）
  if (alarm.name === 'keep-awake') {
    try { if (chrome.power) chrome.power.requestKeepAwake('system'); } catch(e) {}
    return;
  }
  if (alarm.name === 'reins-search') {
    chrome.storage.local.get(['autoSearchEnabled', 'searchIntervalMinutes', 'businessStartHour', 'businessEndHour', 'suumoPatrolRunning'], (data) => {
      const startH = data.businessStartHour !== undefined ? data.businessStartHour : 10;
      const endH = data.businessEndHour !== undefined ? data.businessEndHour : 20;
      const hour = new Date().getHours();
      const inBusiness = hour >= startH && hour < endH;

      if (data.autoSearchEnabled === false) {
        console.log('[system] 自動検索が無効のためスキップ');
        // 通常のインターバルで次回をセット
        setupAlarm(data.searchIntervalMinutes || 60);
      } else if (!inBusiness) {
        console.log(`[system] 営業時間外 (${hour}時) のためスキップ`);
        setupAlarm(data.searchIntervalMinutes || 60);
      } else if (data.suumoPatrolRunning) {
        // SUUMO巡回が走ってる間は顧客検索を見送る。
        // pending を立てて巡回完了時のチェインに任せつつ、5分後アラームも保険で
        // セット (チェインが何らかの理由で発火しなかった時のセーフティ)。
        console.log('[system] SUUMO巡回中のため顧客検索を pending (5分後にも再試行)');
        setStorageData({
          customerSearchPending: true,
          debugLog: '[system] SUUMO巡回中のため顧客検索を pending → 巡回完了時に自動起動 (5分後にも再試行)'
        });
        chrome.alarms.create('reins-search', { delayInMinutes: 5 });
      } else {
        runSearchCycle();
        setupAlarm(data.searchIntervalMinutes || 60);
      }
    });
  }

  // ── SUUMO巡回アラーム ──
  // 仕様:
  //  - 通常は suumoPatrolIntervalMinutes (デフォルト180分=3時間) ごとに自動実行
  //  - 顧客検索が走っている時は suumoPatrolPending フラグを立てて待機
  //    → 顧客検索の finally で chain起動される
  //  - 次回アラームは設定値ベースで再セット (デフォルト180分)
  if (alarm.name === 'suumo-patrol') {
    chrome.storage.local.get(['suumoPatrolEnabled', 'businessStartHour', 'businessEndHour', 'suumoPatrolIntervalMinutes', 'isSearching'], (data) => {
      const startH = data.businessStartHour !== undefined ? data.businessStartHour : 10;
      const endH = data.businessEndHour !== undefined ? data.businessEndHour : 20;
      const hour = new Date().getHours();
      const inBusiness = hour >= startH && hour < endH;
      const interval = Math.max(15, Math.min(1440,
        Number(data.suumoPatrolIntervalMinutes) || 180
      ));

      if (data.suumoPatrolEnabled !== true) {
        console.log('[SUUMO巡回] 無効のためスキップ');
      } else if (!inBusiness) {
        console.log(`[SUUMO巡回] 営業時間外 (${hour}時) のためスキップ`);
      } else if (data.isSearching) {
        // 顧客検索中: pending フラグだけ立てて、検索完了時に chain起動される
        console.log('[SUUMO巡回] 顧客検索中 → pending フラグを立てて待機');
        setStorageData({
          suumoPatrolPending: true,
          debugLog: '[SUUMO巡回] 顧客検索中のため待機(完了後に自動起動)'
        });
      } else {
        runSuumoPatrolCycle();
      }
      // 次回SUUMO巡回アラームを設定値で再セット (営業時間外なら次の営業開始時刻に自動スナップ)
      setupSuumoPatrolAlarm(interval);
    });
  }

  // ── SUUMO入稿キュー backup poll（60分に1回・取りこぼし対策） ──
  // 通常は承認ページからの即時トリガー(SUUMO_APPROVED_NOW)で起動する
  // スマホ承認時などPCに即時通知が届かなかった分をここで拾う
  if (alarm.name === 'suumo-queue-poll') {
    // 顧客検索中は並列実行で詰まることがあるためスキップ。10分後に再試行する。
    chrome.storage.local.get(['isSearching'], (data) => {
      if (data.isSearching) {
        console.log('[SUUMO入稿] backup poll: 顧客検索中のためスキップ → 10分後にリトライ');
        setStorageData({ debugLog: '[SUUMO入稿] backup poll: 顧客検索中のためスキップ → 10分後にリトライ' });
        chrome.alarms.create('suumo-queue-poll', { delayInMinutes: 10 });
        return;
      }
      pollAndStartFillIfNeeded({ source: 'backup' }).catch(err => {
        console.log(`[SUUMO入稿] backup poll失敗: ${err.message}`);
      });
      chrome.alarms.create('suumo-queue-poll', { delayInMinutes: 60 });
    });
  }

  // ── ForRent時間外に承認された物件の遅延入稿 ──
  if (alarm.name === 'suumo-fill-scheduled') {
    console.log('[SUUMO入稿] スケジュール起動: ForRent利用時間到来');
    setStorageData({ debugLog: '[SUUMO入稿] ForRent利用時間到来 → 入稿開始' });
    pollAndStartFillIfNeeded({ source: 'scheduled' }).catch(err => {
      console.log(`[SUUMO入稿] スケジュール起動失敗: ${err.message}`);
    });
  }

  // ── 優先空室確認ポーリング (お客さんからのリアルタイム依頼) ──
  // 1分毎に GAS から優先キューを取得、依頼があれば即座にチェック実行
  if (alarm.name === 'priority-availability-poll') {
    if (typeof runPriorityAvailabilityPoll === 'function') {
      runPriorityAvailabilityPoll().catch(err => {
        console.log(`[優先空室確認] poll失敗: ${err.message}`);
      });
    }
  }

  // ── キャンセル通知希望物件の定期巡回 ──
  // 30分毎にGASから watch中物件を取得、ステータスをチェック
  // キャンセル発生 (申込可能化) を検知 → GAS が自動で LINE 通知
  if (alarm.name === 'cancellation-watch-poll') {
    if (typeof runCancellationWatchPoll === 'function') {
      runCancellationWatchPoll().catch(err => {
        console.log(`[キャンセル監視] poll失敗: ${err.message}`);
      });
    }
  }

  // ── 定期空室確認 (全通知済み物件の巡回) ── 【廃止】
  // 規約違反(機械的アクセス)による各サイトのBANリスク回避のため、3時間毎の全物件巡回は停止。
  // 空室確認は「再送付時にその顧客の物件だけ」「LINEの個別依頼(優先キュー)」のオンデマンドのみ。
  // 万一古いアラームが残って発火しても巡回しないよう、ここで早期returnして無効化する。
  if (alarm.name === 'periodic-availability-check') {
    chrome.alarms.clear('periodic-availability-check');
    return;
  }
  if (false && alarm.name === 'periodic-availability-check') {
    chrome.storage.local.get(['businessStartHour', 'businessEndHour'], (data) => {
      const startH = data.businessStartHour !== undefined ? data.businessStartHour : 10;
      const endH = data.businessEndHour !== undefined ? data.businessEndHour : 20;
      const hour = new Date().getHours();
      if (hour < startH || hour >= endH) {
        console.log(`[定期空室確認] 営業時間外 (${hour}時) のためスキップ`);
        setStorageData({ debugLog: `[定期空室確認] 営業時間外 (${hour}時) のためスキップ` });
        return;
      }
      if (typeof runPeriodicAvailabilityCheck === 'function') {
        runPeriodicAvailabilityCheck().catch(err => {
          console.log(`[定期空室確認] 失敗: ${err.message}`);
        });
      }
    });
  }
});

// --- メッセージ受信 ---
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // 汎用デバッグログ転送 (content script からの診断用)
  // content script は debugLog を直接書けないので、background 経由で setStorageData する
  if (msg.type === 'DEBUG_LOG' && msg.message) {
    setStorageData({ debugLog: String(msg.message) });
    sendResponse({ ok: true });
    return;
  }

  if (msg.type === 'SEARCH_NOW') {
    runSearchCycle();
    sendResponse({ ok: true });
    return;
  }
  if (msg.type === 'STOP_SEARCH') {
    currentSearchId++; // 古いサイクルを無効化
    chrome.storage.local.set({ isSearching: false });
    setStorageData({ debugLog: '検索を中止しました' });
    sendResponse({ ok: true });
    return;
  }

  if (msg.type === 'UPDATE_ALARM') {
    chrome.storage.local.get(['searchIntervalMinutes', 'suumoPatrolEnabled', 'suumoPatrolIntervalMinutes'], (data) => {
      setupAlarm(data.searchIntervalMinutes || 30);
      // SUUMO巡回も options 保存時に間隔が変わるので再セット (有効時のみ)
      if (data.suumoPatrolEnabled) {
        const interval = Math.max(15, Math.min(1440, Number(data.suumoPatrolIntervalMinutes) || 180));
        setupSuumoPatrolAlarm(interval);
      }
      sendResponse({ ok: true });
    });
    return true;
  }
  if (msg.type === 'LOGIN_STATUS') {
    chrome.storage.local.set({ loginDetected: msg.loggedIn });
    return;
  }

  // ── SUUMO巡回関連メッセージ ──
  // SUUMO_PATROL_NOW: 単発実行のみ (定期巡回チェックには触れない)
  if (msg.type === 'SUUMO_PATROL_NOW') {
    runSuumoPatrolCycle();
    sendResponse({ ok: true });
    return;
  }
  // SUUMO_PATROL_TOGGLE: 定期巡回アラーム の ON/OFF だけを切り替える。
  // 実行中サイクルには干渉しない (止めるには SUUMO_PATROL_STOP を使う)。
  // 間隔は suumoPatrolIntervalMinutes (options で設定可、デフォルト180分)。
  if (msg.type === 'SUUMO_PATROL_TOGGLE') {
    chrome.storage.local.set({ suumoPatrolEnabled: msg.enabled }, () => {
      if (msg.enabled) {
        chrome.storage.local.get(['suumoPatrolIntervalMinutes'], (d) => {
          const interval = Math.max(15, Math.min(1440, Number(d.suumoPatrolIntervalMinutes) || 180));
          // 営業時間考慮 + ジッター付きで次回アラームをセット (顧客検索と同じ仕組み)
          setupSuumoPatrolAlarm(interval);
          setStorageData({ debugLog: `[SUUMO巡回] 定期巡回を有効化 (${interval}分ごと、営業時間内のみ)` });
          sendResponse({ ok: true });
        });
      } else {
        chrome.alarms.clear('suumo-patrol');
        // pending もクリア (無効化されたら chain も走らせない)
        chrome.storage.local.set({ suumoPatrolPending: false });
        setStorageData({ debugLog: '[SUUMO巡回] 定期巡回を無効化' });
        sendResponse({ ok: true });
      }
    });
    return true;
  }
  // SUUMO_PATROL_STOP: 実行中サイクルだけを中断する。
  // 定期巡回チェック(suumoPatrolEnabled)/アラームには触れないので、次回アラーム
  // (60分後) では引き続き自動実行される。
  // currentPatrolSearchId のみインクリメントするので、顧客検索が並行で走っていて
  // も巻き込まない。
  if (msg.type === 'SUUMO_PATROL_STOP') {
    currentPatrolSearchId++;
    if (typeof _suumoPatrolRunning !== 'undefined') _suumoPatrolRunning = false;
    chrome.storage.local.set({ suumoPatrolRunning: false }, () => {
      setStorageData({ debugLog: '[SUUMO巡回] 実行中サイクルを中断' });
      sendResponse({ ok: true });
    });
    return true;
  }
  if (msg.type === 'HOMES_IMAGE_SEARCH') {
    // 承認ページからのホームズ画像候補検索リクエスト
    (async () => {
      try {
        if (typeof searchHomesImagesForProperty !== 'function') {
          sendResponse({ ok: false, errors: ['searchHomesImagesForProperty が未ロード'], candidates: [] });
          return;
        }
        const result = await searchHomesImagesForProperty(msg.input || {});
        sendResponse(result);
      } catch (err) {
        sendResponse({ ok: false, errors: ['例外: ' + err.message], candidates: [] });
      }
    })();
    return true; // async sendResponse
  }
  if (msg.type === 'SUUMO_QUEUE_POLL_NOW') {
    // content scriptからのキュー再取得依頼
    // 送信元タブは既に入稿タブなので、新タブは作らずGASからキュー取得→追記のみ行う
    (async () => {
      try {
        // 送信元タブを入稿タブとして登録（タブID不一致によるタブ二重作成を防止）
        if (sender.tab?.id) {
          await setStorageData({ suumoFillTabId: sender.tab.id });
        }
        const { available } = checkForrentAvailability();
        if (!available) {
          sendResponse({ ok: false, reason: '時間外' });
          return;
        }
        // Phase 4: 承認→ForRentボタン経由ルートでも必ず前処理(データ更新+停止)を実行。
        // 複数のSUUMO_QUEUE_POLL_NOWが並列で来た場合、同時に複数preHookが走ったり、
        // 片方がskipして先にキュー取得に進んで入稿開始してしまうレースを防ぐため、
        // ミューテックスで直列化する(前処理完了まで全呼び出しが待つ)。
        const preHookResult = await getOrRunSuumoPreHook_();
        if (!preHookResult.ok) {
          await setStorageData({ debugLog: `[SUUMO入稿] QUEUE_POLL経路の前処理失敗: ${preHookResult.error}` });
          sendResponse({ ok: false, error: '前処理失敗: ' + preHookResult.error });
          return;
        }
        const queueData = await pollSuumoApprovalQueue({ lock: true });
        if (queueData && queueData.queue && queueData.queue.length > 0) {
          const added = await appendFillQueue(queueData.queue);
          await setStorageData({
            suumoActiveListingCount: queueData.activeListingCount,
            suumoStopCandidate: queueData.stopCandidate
          });
          console.log(`[SUUMO入稿] QUEUE_POLL_NOW: ${added}件をキューに追加`);
          sendResponse({ ok: true, added });
        } else {
          console.log('[SUUMO入稿] QUEUE_POLL_NOW: GASからの取得結果は0件');
          sendResponse({ ok: true, added: 0 });
        }
      } catch (err) {
        console.error('[SUUMO入稿] QUEUE_POLL_NOW失敗:', err);
        sendResponse({ ok: false, error: err.message });
      }
    })();
    return true;
  }
  // GAS承認ページの承認ボタン押下時、suumo-approval-trigger.jsが送信
  // → 新規タブで入稿プロセスを即時起動、または稼働中タブのキューに追記
  if (msg.type === 'SUUMO_APPROVED_NOW') {
    console.log(`[SUUMO入稿] 承認トリガー受信: key=${msg.propertyKey}, ${msg.building} ${msg.room}`);
    setStorageData({ debugLog: `[SUUMO入稿] 承認検知(${msg.building || msg.propertyKey}) → 入稿開始` });
    pollAndStartFillIfNeeded({ source: 'approval' }).then(() => {
      sendResponse({ ok: true, started: true });
    }).catch(err => {
      console.error('[SUUMO入稿] 承認トリガー処理失敗:', err);
      sendResponse({ ok: false, error: err.message });
    });
    return true;
  }
  // content script (suumo-fill-auto.js) からの「このタブは入稿用？」問い合わせ
  // タブIDが suumoFillTabId と一致する場合のみ true を返す
  // これにより、手動で開いたForRentタブでは絶対にキュー監視が走らない
  if (msg.type === 'AM_I_FILL_TAB') {
    const tabId = sender.tab?.id;
    chrome.storage.local.get(['suumoFillTabId'], (data) => {
      const isFillTab = (typeof tabId === 'number') && data.suumoFillTabId === tabId;
      sendResponse({ isFillTab: !!isFillTab, tabId: tabId, fillTabId: data.suumoFillTabId });
    });
    return true;
  }
  // 入稿タブからの「次の物件ちょうだい」要求（race condition防止のため atomic に pop）
  // content scriptが storage.local を直接書き換えないことで、background側からの追記と競合しない
  if (msg.type === 'POP_FILL_QUEUE_HEAD') {
    const tabId = sender.tab?.id;
    chrome.storage.local.get(['suumoFillTabId'], async (data) => {
      if (typeof tabId !== 'number' || data.suumoFillTabId !== tabId) {
        sendResponse({ ok: false, error: 'not fill tab' });
        return;
      }
      try {
        const head = await popFillQueueHead();
        sendResponse({ ok: true, item: head });
      } catch (e) {
        sendResponse({ ok: false, error: e.message });
      }
    });
    return true;
  }
  if (msg.type === 'SUUMO_FILL_RELAY') {
    // トップフレームからiframe内のcontent scriptへメッセージをリレー
    // 送信元タブの全フレームに SUUMO_FILL_START を送信
    const tabId = sender.tab?.id;
    if (tabId) {
      chrome.tabs.sendMessage(tabId, {
        type: 'SUUMO_FILL_START',
        data: msg.data,
        imageGenres: msg.imageGenres
      }, { frameId: 0 }).catch(() => {});
      // iframe（frameId > 0）にも送信
      chrome.webNavigation.getAllFrames({ tabId }, (frames) => {
        if (!frames) return;
        for (const frame of frames) {
          if (frame.frameId === 0) continue;
          chrome.tabs.sendMessage(tabId, {
            type: 'SUUMO_FILL_START',
            data: msg.data,
            imageGenres: msg.imageGenres
          }, { frameId: frame.frameId }).catch(() => {});
        }
      });
      sendResponse({ ok: true, relayed: true });
    } else {
      sendResponse({ ok: false, error: 'タブIDが取得できません' });
    }
    return true;
  }
  if (msg.type === 'FETCH_IMAGE_AS_BASE64') {
    // content script（ForRentページ）から画像URLを受け取り、base64で返す
    // background service workerはhost_permissionsの全ドメインにfetchできる
    (async () => {
      try {
        const response = await fetch(msg.url);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const blob = await response.blob();
        const reader = new FileReader();
        const dataUrl = await new Promise((resolve, reject) => {
          reader.onloadend = () => resolve(reader.result);
          reader.onerror = reject;
          reader.readAsDataURL(blob);
        });
        sendResponse({ ok: true, dataUrl });
      } catch (err) {
        console.error('[FETCH_IMAGE_AS_BASE64] 失敗:', msg.url, err.message);
        // ログ画面にも記録(入稿タブのconsoleに出るwarnは普段見えないため)
        try {
          await setStorageData({ debugLog: `[画像fetch失敗] ${String(msg.url).substring(0, 100)} - ${err.message}` });
        } catch (_) {}
        sendResponse({ ok: false, error: err.message });
      }
    })();
    return true;
  }
  if (msg.type === 'ROTATE_IMAGE_REQUEST') {
    // 承認ページからの画像90度回転要求。
    // GAS の sandbox iframe からは外部fetch が CSPで阻止されるため、
    // 拡張のbackground (host_permissions有効) で fetch → OffscreenCanvas
    // で回転 → 既存のアップロードヘルパー (catbox→0x0→...のチェーン) で再保存。
    // 入力: { url, degrees: 90 | -90 }
    // 返却: { ok: true, url: <新URL> } または { ok: false, error }
    (async () => {
      try {
        const srcUrl = msg.url;
        const degrees = Number(msg.degrees) || 0;
        if (!srcUrl) throw new Error('url が空');
        if (degrees === 0 || (degrees % 90) !== 0) throw new Error('degrees は90の倍数のみ');

        // 1. 元画像を fetch (host_permissions あり、CORS 制限なし)
        const resp = await fetch(srcUrl);
        if (!resp.ok) throw new Error(`fetch HTTP ${resp.status}`);
        const blob = await resp.blob();
        if (!blob || blob.size < 100) throw new Error('blob が小さすぎ');

        // 2. ImageBitmap 経由で OffscreenCanvas へ描画
        const bitmap = await createImageBitmap(blob);
        const w = bitmap.width, h = bitmap.height;
        const swap = (Math.abs(degrees) === 90 || Math.abs(degrees) === 270);
        const canvas = new OffscreenCanvas(swap ? h : w, swap ? w : h);
        const ctx = canvas.getContext('2d');
        ctx.translate(canvas.width / 2, canvas.height / 2);
        ctx.rotate(degrees * Math.PI / 180);
        ctx.drawImage(bitmap, -w / 2, -h / 2);
        bitmap.close();

        // 3. blob 化 (元の MIME を尊重、PNG 以外は JPEG に統一)
        const outType = (blob.type === 'image/png') ? 'image/png' : 'image/jpeg';
        const outBlob = await canvas.convertToBlob({ type: outType, quality: 0.92 });

        // 4. base64 化 (data URL) → 既存アップロードヘルパー
        const dataUrl = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onloadend = () => resolve(reader.result);
          reader.onerror = reject;
          reader.readAsDataURL(outBlob);
        });
        const newUrl = await uploadBase64ToCatbox(dataUrl);
        if (!newUrl) throw new Error('全アップロード失敗(null)');
        sendResponse({ ok: true, url: newUrl });
      } catch (err) {
        console.error('[ROTATE_IMAGE_REQUEST] 失敗:', err && err.message);
        sendResponse({ ok: false, error: (err && err.message) || String(err) });
      }
    })();
    return true;
  }
  if (msg.type === 'UPLOAD_IMAGE_FROM_GAS') {
    // SUUMO承認ページ(GAS HtmlService)からのローカル画像アップロード要求。
    // GAS sandbox iframe からは外部fetchがCSPでブロックされるため、
    // 拡張のbackground経由(host_permissions有効)でアップロードする。
    // 受信: { base64, mimeType, filename } (base64は純粋なbase64文字列、data:プレフィックス無し)
    // 返却: { ok: true, url } または { ok: false, error }
    (async () => {
      try {
        const base64 = msg.base64 || '';
        const mime = msg.mimeType || 'image/jpeg';
        if (!base64) throw new Error('base64 が空');
        // uploadBase64ToCatbox は data:URL 形式を期待
        const dataUrl = `data:${mime};base64,${base64}`;
        const url = await uploadBase64ToCatbox(dataUrl);
        if (!url) throw new Error('全アップロード失敗(null)');
        sendResponse({ ok: true, url });
      } catch (err) {
        console.error('[UPLOAD_IMAGE_FROM_GAS] 失敗:', err && err.message);
        sendResponse({ ok: false, error: (err && err.message) || String(err) });
      }
    })();
    return true;
  }
  if (msg.type === 'SUUMO_FILL_COMPLETE') {
    // suumo-fill-auto.jsからの入稿完了報告
    reportSuumoPostComplete(msg.data).then(result => {
      // 入稿完了したら suumoFillMode フラグをクリア(以降の誤起動防止)
      try { chrome.storage.local.remove(['suumoFillMode', 'suumoFillModeSetAt']); } catch (_) {}
      sendResponse(result);
    }).catch(err => {
      sendResponse({ success: false, message: err.message });
    });
    return true;
  }
  // ── 駅補完: MAIN world で「らくらく交通入力」 ボタンを click ──
  // ForRent ページの CSP で <script> inline 注入が拒否されるため、
  // chrome.scripting.executeScript({ world: 'MAIN' }) で MAIN world に
  // 関数を注入する (拡張権限なので CSP の影響を受けない)。
  // MAIN world で click → onclick="openRakurakuKotsu(...)" が走り、
  // ZenrinCommon.js の関数経由で popup が開く (= サーバーセッションに座標登録)。
  // window.open フックも MAIN world 内で行うため確実に捉えられる。
  if (msg.type === 'TRIGGER_RAKURAKU_CLICK') {
    (async () => {
      try {
        const tabId = sender.tab?.id;
        if (!tabId) {
          sendResponse({ ok: false, error: 'tabId 不明' });
          return;
        }
        // sender.frameId が指定されていればそのフレームのみ、
        // なければ allFrames で main フレームを含めて全フレーム実行
        const target = { tabId };
        if (typeof sender.frameId === 'number') {
          target.frameIds = [sender.frameId];
        } else {
          target.allFrames = true;
        }
        const results = await chrome.scripting.executeScript({
          target,
          world: 'MAIN',
          func: () => {
            try {
              const btn = document.getElementById('rakurakuKotsu');
              if (!btn) return { hadBtn: false };
              const origOpen = window.open;
              let openCount = 0;
              let openedOk = false;
              let lastUrl = '';
              window.open = function(url, name, features) {
                openCount++;
                lastUrl = String(url || '').substring(0, 80);
                // ZenrinCommon.js のデフォルト features (width=530,height=700,left=10,top=30)
                // だとユーザーに見えてしまう。 Chrome は features の left/top を
                // 画面内に強制する場合があるため、 開いた直後に moveTo + resizeTo で
                // 画面外 1x1 に飛ばす (一瞬見える可能性はあるが連続して隠す)。
                const stealthFeatures = 'left=-10000,top=-10000,width=1,height=1,menubar=no,toolbar=no,location=no,status=no,scrollbars=no,resizable=no';
                const w = origOpen.call(this, url, name || '_blank', stealthFeatures);
                if (w) {
                  openedOk = true;
                  // 開いた直後に画面外に移動 + サイズ最小化
                  try { w.moveTo(-10000, -10000); } catch (_) {}
                  try { w.resizeTo(1, 1); } catch (_) {}
                  // ★ フォーカスを親 window に戻す (popup がアクティブになるのを防ぐ)
                  try { w.blur(); } catch (_) {}
                  try { window.focus(); } catch (_) {}
                  // ロード完了タイミングでも再度位置調整 + フォーカス戻し
                  try {
                    w.addEventListener('load', () => {
                      try { w.moveTo(-10000, -10000); } catch (_) {}
                      try { w.resizeTo(1, 1); } catch (_) {}
                      try { w.blur(); } catch (_) {}
                      try { window.focus(); } catch (_) {}
                    });
                  } catch (_) {}
                  // ⚠️ すぐ close すると popup 内の Zenrin SDK が住所→座標
                  //    変換 + サーバーセッション登録を完了する前にウィンドウが
                  //    閉じてしまい、 セッション未確立になる。
                  //    3 秒待ってから close する (実測 1〜2 秒で完了)。
                  setTimeout(() => { try { w.close(); } catch(_){} }, 3000);
                }
                return w;
              };
              btn.click();
              window.open = origOpen;
              return { hadBtn: true, openCount, openedOk, lastUrl };
            } catch (e) {
              return { error: String(e && e.message || e) };
            }
          },
        });
        // 複数フレームから結果が返るので #rakurakuKotsu が見つかったフレームを優先
        const valid = (results || [])
          .map(r => r && r.result)
          .filter(r => r && (r.hadBtn || r.error));
        // popup が新タブ / 新 window として開かれてフォーカスを奪うケースに対応:
        // 元タブを active にし直して、 さらに元 window を focused に戻す。
        try {
          await chrome.tabs.update(tabId, { active: true });
          const tabInfo = await chrome.tabs.get(tabId);
          if (tabInfo && tabInfo.windowId) {
            await chrome.windows.update(tabInfo.windowId, { focused: true });
          }
        } catch (_) {}
        sendResponse({ ok: true, result: valid[0] || results[0]?.result || { hadBtn: false } });
      } catch (err) {
        sendResponse({ ok: false, error: err.message });
      }
    })();
    return true;
  }
  // ── 旧: chrome.windows.create で popup を開く経路 (現在は未使用、 future-proof) ──
  if (msg.type === 'OPEN_RAKURAKU_POPUP') {
    (async () => {
      try {
        const popupUrl = msg.url || 'https://www.fn.forrent.jp/fn/COM1R02167.action';
        const waitMs = Math.max(1000, Math.min(8000, msg.waitMs || 3000));
        const win = await chrome.windows.create({
          url: popupUrl,
          type: 'popup',
          width: 1,
          height: 1,
          left: 99999,    // 画面外配置 (UX 影響回避)
          top: 99999,
          focused: false, // 親タブのフォーカス維持
        });
        // popup 内で Zenrin SDK が走るのを待つ
        await new Promise(r => setTimeout(r, waitMs));
        // close
        try { await chrome.windows.remove(win.id); } catch (_) {}
        sendResponse({ ok: true, waitMs });
      } catch (err) {
        sendResponse({ ok: false, error: err.message });
      }
    })();
    return true;
  }
  // ── Phase 5: 確認画面到達通知 → 事前チェック+登録ボタン自動クリック ──
  if (msg.type === 'SUUMO_CONFIRM_REACHED') {
    (async () => {
      try {
        const tabId = sender.tab && sender.tab.id;
        if (!tabId) {
          sendResponse({ ok: false, error: 'tabId不明' });
          return;
        }
        const result = await tryForrentFinalSubmit({
          tabId,
          imageGenresCount: msg.imageGenresCount || 0,
          imageUploadStats: msg.imageUploadStats || {},
          // Phase5 登録完了後に GAS の suumo_post_complete を送るための物件識別情報
          propertyKey: msg.propertyKey || '',
          building: msg.building || '',
          room: msg.room || '',
          rent: msg.rent || '',
        });
        sendResponse(result);
      } catch (err) {
        sendResponse({ ok: false, error: err.message });
      }
    })();
    return true;
  }
  // ── SUUMOビジネス Daily Search 手動取得(Phase 1) ──
  // options.html の「SUUMOビジネス データ取得」ボタンから送信される
  if (msg.type === 'SUUMO_BUSINESS_FETCH_NOW') {
    (async () => {
      try {
        const result = await runSuumoBusinessFetch();
        sendResponse(result);
      } catch (err) {
        sendResponse({ ok: false, error: err.message });
      }
    })();
    return true;
  }
  // ── ForRent状態同期(PUB1R2801直読み) ──
  if (msg.type === 'SUUMO_FORRENT_STATUS_SYNC') {
    (async () => {
      try {
        const result = await syncForrentListingStatus();
        sendResponse(result);
      } catch (err) {
        sendResponse({ ok: false, error: err.message });
      }
    })();
    return true;
  }
  // ── ForRent停止テスト実行(Phase 3) ──
  // options.html の「ForRent停止テスト実行」ボタンから送信される
  if (msg.type === 'FORRENT_STOP_TEST') {
    (async () => {
      try {
        const result = await stopForrentListing({
          suumoPropertyCode: msg.suumoPropertyCode,
          dryRun: msg.dryRun, // 未指定ならストレージから判定
        });
        sendResponse(result);
      } catch (err) {
        sendResponse({ ok: false, error: err.message });
      }
    })();
    return true;
  }

  // ── 検索ページを開く（AdminPage → content script → ここ） ──
  // ── 手動送信パネル: 顧客一覧＋このタブで検索中の顧客を返す ──
  if (msg.type === 'GET_MANUAL_SEND_CONTEXT') {
    (async () => {
      let customers = [];
      let contextCustomer = '';
      try {
        // まずキャッシュ（customerCriteria）、なければ GAS から取得
        const cached = await new Promise(r => chrome.storage.local.get(['customerCriteria'], d => r(d.customerCriteria)));
        let crit = cached;
        if (!Array.isArray(crit) || crit.length === 0) {
          const res = await fetchCriteria();
          crit = (res && res.criteria) || [];
        }
        customers = Array.from(new Set(crit.map(c => c && c.name).filter(Boolean)));
      } catch (e) {
        await setStorageData({ debugLog: '手動送信: 顧客一覧取得失敗 ' + e.message });
      }
      try {
        contextCustomer = await getManualSearchCustomer(sender.tab && sender.tab.id);
      } catch (e) {}
      sendResponse({ ok: true, customers, contextCustomer });
    })();
    return true;
  }

  // ── 手動送信パネル: 選択した物件を顧客LINEへ送信 ──
  if (msg.type === 'SEND_MANUAL_PROPERTIES') {
    (async () => {
      try {
        const props = msg.properties || [];
        const fetchDetails = !!msg.fetchDetails;
        const source = msg.source || (props[0] && props[0].source) || '';
        const senderTabId = sender && sender.tab && sender.tab.id;

        // REINS かつ詳細取得モード: 各物件の詳細ページを開いて全情報を取得し、
        // 自動検索と同じ承認パイプライン(add_reins_property)に登録→承認ページを開く
        if (fetchDetails && source === 'reins' && senderTabId) {
          // 自動巡回タブとの衝突防止（同じタブを両者が操作すると壊れる）
          const autoTabId = await __getAutomationTabId();
          if (autoTabId && autoTabId === senderTabId) {
            sendResponse({ ok: false, error: '自動巡回中のタブでは手動取得できません。別のタブでREINSを開いてください。' });
            return;
          }
          // 承認ページURL構築に必要な GAS webapp URL を先に確認
          const { gasWebappUrl } = await getConfig();
          if (!gasWebappUrl) {
            sendResponse({ ok: false, error: 'GAS URLが設定されていません' });
            return;
          }
          // 警告(warnings_text)計算用の顧客オブジェクトを取得（無くても続行可）
          let customerObj = null;
          try {
            const cached = await new Promise(r => chrome.storage.local.get(['customerCriteria'], d => r(d.customerCriteria)));
            if (Array.isArray(cached)) customerObj = cached.find(c => c && c.name === msg.customerName) || null;
          } catch (e) {}

          const fromDetailPage = !!msg.fromDetailPage;
          const total = props.length;
          const enriched = [];
          let skipped = 0;
          for (let i = 0; i < props.length; i++) {
            const p = props[i] || {};
            // 進捗通知（パネル/詳細ボタン側で表示）
            try {
              await chrome.tabs.sendMessage(senderTabId, { type: 'MANUAL_SEND_PROGRESS', done: i, total, skipped });
            } catch (e) {}
            let res;
            try {
              res = await fetchReinsDetailForManual(senderTabId, {
                propertyNumber: p.reins_property_number || p.propertyNumber || '',
                index: (typeof p.reins_row_index === 'number') ? p.reins_row_index : -1
              }, { alreadyOnDetail: fromDetailPage });
            } catch (e) {
              res = { ok: false, error: e.message };
            }
            // 詳細で取れなかったフィールドを一覧(p)でフォールバック（物件名・賃料含む）。
            // building_name 判定より前に行う（物件名が取れない物件がスキップされないように）。
            // REINS詳細はタイミング等で物件名/賃料が取れないことがあるため一覧の値を引き継ぐ。
            if (res && res.ok && res.detail) {
              const _d = res.detail;
              if (!_d.building_name && p.buildingName) _d.building_name = p.buildingName;
              if (!_d.room_number && p.roomNumber) _d.room_number = p.roomNumber;
              if (!_d.rent && p.rent) _d.rent = Number(p.rent) || 0;
              if (!_d.management_fee && p.managementFee) _d.management_fee = Number(p.managementFee) || 0;
              if (!_d.deposit && p.deposit) _d.deposit = p.deposit;
              if (!_d.key_money && p.keyMoney) _d.key_money = p.keyMoney;
              if (!_d.layout && p.layout) _d.layout = p.layout;
              if (!_d.area && p.area) _d.area = p.area;
              if (!_d.building_age && p.buildingAge) _d.building_age = p.buildingAge;
              if (!_d.station_info && p.stationInfo) _d.station_info = p.stationInfo;
              if (!_d.address && p.address) _d.address = p.address;
            }
            if (res && res.ok && res.detail && res.detail.building_name) {
              // 警告計算（承認ページで表示、自動検索と同一ロジック）
              try {
                if (customerObj && typeof globalThis.__computePropertyWarnings === 'function') {
                  res.detail.warnings_text = (globalThis.__computePropertyWarnings(res.detail, customerObj) || []).join('\n');
                }
              } catch (e) {}
              enriched.push(res.detail);
            } else {
              skipped++;
              await setStorageData({ debugLog: `[手動送信] 詳細取得失敗→スキップ: ${(p.reins_property_number || p.propertyNumber || '')} ${(res && res.error) || ''}` });
            }
          }
          // 完了進捗
          try {
            await chrome.tabs.sendMessage(senderTabId, { type: 'MANUAL_SEND_PROGRESS', done: total, total, skipped });
          } catch (e) {}

          if (enriched.length === 0) {
            sendResponse({ ok: false, registered: 0, skipped, error: `全${total}件の詳細取得に失敗しました` });
            return;
          }

          // 承認待ちキューに登録（自動検索と同じ add_reins_property、status='pending'）。
          // Discord通知は出さない（deliverProperty を呼ばない）。
          try {
            await submitProperties(msg.customerName, enriched);
          } catch (e) {
            await setStorageData({ debugLog: '[手動送信] 承認待ち登録失敗: ' + e.message });
            sendResponse({ ok: false, registered: 0, skipped, error: '承認待ち登録に失敗: ' + e.message });
            return;
          }

          // 承認ページを物件ごとに新規タブで開く（room_id は content-detail.js 生成の hash）
          let opened = 0;
          for (const det of enriched) {
            if (!det.room_id) continue;
            try {
              const approveUrl = gasWebappUrl
                + '?action=approve&customer=' + encodeURIComponent(msg.customerName)
                + '&room_id=' + encodeURIComponent(det.room_id);
              await chrome.tabs.create({ url: approveUrl, active: true });
              opened++;
            } catch (e) {}
          }

          const message = skipped > 0
            ? `${enriched.length}件を承認待ちに登録し承認ページを開きました / ${skipped}件は取得失敗`
            : `${enriched.length}件を承認待ちに登録し承認ページを開きました`;
          await setStorageData({ debugLog: `手動送信(承認待ち): ${msg.customerName} へ ${enriched.length}件登録 (失敗${skipped}) 承認タブ${opened}` });
          sendResponse({ ok: true, registered: enriched.length, skipped, opened, message });
          return;
        }

        // いえらぶ 詳細取得モード: 新タブで詳細ページを開いて全情報を取得→承認パイプライン
        if (fetchDetails && source === 'ielove' && senderTabId) {
          const { gasWebappUrl } = await getConfig();
          if (!gasWebappUrl) {
            sendResponse({ ok: false, error: 'GAS URLが設定されていません' });
            return;
          }
          let customerObj = null;
          try {
            const cached = await new Promise(r => chrome.storage.local.get(['customerCriteria'], d => r(d.customerCriteria)));
            if (Array.isArray(cached)) customerObj = cached.find(c => c && c.name === msg.customerName) || null;
          } catch (e) {}

          const total = props.length;
          const enriched = [];
          let skipped = 0;
          for (let i = 0; i < props.length; i++) {
            const p = props[i] || {};
            try {
              await chrome.tabs.sendMessage(senderTabId, { type: 'MANUAL_SEND_PROGRESS', done: i, total, skipped });
            } catch (e) {}
            const detailUrl = p.url || '';
            if (!detailUrl) { skipped++; continue; }
            let res;
            try {
              res = await fetchIeloveDetailForManual(p);  // 一覧の賃料等をフォールバックに使うため prop全体を渡す
            } catch (e) {
              res = { ok: false, error: e.message };
            }
            if (res && res.ok && res.detail && res.detail.building_name) {
              try {
                if (customerObj && typeof globalThis.__computePropertyWarnings === 'function') {
                  res.detail.warnings_text = (globalThis.__computePropertyWarnings(res.detail, customerObj) || []).join('\n');
                }
              } catch (e) {}
              // property_data_json を構築（承認ページ用）
              if (typeof buildPropertyDataJson === 'function') {
                res.detail.property_data_json = JSON.stringify(buildPropertyDataJson(res.detail));
              }
              enriched.push(res.detail);
            } else {
              skipped++;
              await setStorageData({ debugLog: `[手動送信] いえらぶ詳細取得失敗→スキップ: ${p.buildingName || ''} ${(res && res.error) || ''}` });
            }
          }
          try {
            await chrome.tabs.sendMessage(senderTabId, { type: 'MANUAL_SEND_PROGRESS', done: total, total, skipped });
          } catch (e) {}

          if (enriched.length === 0) {
            sendResponse({ ok: false, registered: 0, skipped, error: `全${total}件の詳細取得に失敗しました` });
            return;
          }

          try {
            await submitProperties(msg.customerName, enriched);
          } catch (e) {
            await setStorageData({ debugLog: '[手動送信] いえらぶ承認待ち登録失敗: ' + e.message });
            sendResponse({ ok: false, registered: 0, skipped, error: '承認待ち登録に失敗: ' + e.message });
            return;
          }

          let opened = 0;
          for (const det of enriched) {
            if (!det.room_id) continue;
            try {
              const approveUrl = gasWebappUrl
                + '?action=approve&customer=' + encodeURIComponent(msg.customerName)
                + '&room_id=' + encodeURIComponent(det.room_id);
              await chrome.tabs.create({ url: approveUrl, active: true });
              opened++;
            } catch (e) {}
          }

          const message = skipped > 0
            ? `${enriched.length}件を承認待ちに登録し承認ページを開きました / ${skipped}件は取得失敗`
            : `${enriched.length}件を承認待ちに登録し承認ページを開きました`;
          await setStorageData({ debugLog: `手動送信(いえらぶ→承認): ${msg.customerName} へ ${enriched.length}件登録 (失敗${skipped}) 承認タブ${opened}` });
          sendResponse({ ok: true, registered: enriched.length, skipped, opened, message });
          return;
        }

        // itandi 詳細取得モード: 一覧物件ごとに詳細ページを新タブで開いて全情報を取得→承認パイプライン
        if (fetchDetails && source === 'itandi' && senderTabId) {
          const { gasWebappUrl } = await getConfig();
          if (!gasWebappUrl) {
            sendResponse({ ok: false, error: 'GAS URLが設定されていません' });
            return;
          }
          let customerObj = null;
          try {
            const cached = await new Promise(r => chrome.storage.local.get(['customerCriteria'], d => r(d.customerCriteria)));
            if (Array.isArray(cached)) customerObj = cached.find(c => c && c.name === msg.customerName) || null;
          } catch (e) {}

          const total = props.length;
          const enriched = [];
          let skipped = 0;
          for (let i = 0; i < props.length; i++) {
            const p = props[i] || {};
            try {
              await chrome.tabs.sendMessage(senderTabId, { type: 'MANUAL_SEND_PROGRESS', done: i, total, skipped });
            } catch (e) {}
            let res;
            try {
              res = await fetchItandiDetailForManual(p);
            } catch (e) {
              res = { ok: false, error: e.message };
            }
            if (res && res.ok && res.detail && res.detail.building_name) {
              try {
                if (customerObj && typeof globalThis.__computePropertyWarnings === 'function') {
                  res.detail.warnings_text = (globalThis.__computePropertyWarnings(res.detail, customerObj) || []).join('\n');
                }
              } catch (e) {}
              // property_data_json を構築（承認ページ用、自動検索と同一）
              if (typeof buildItandiPropertyDataJson === 'function') {
                res.detail.property_data_json = JSON.stringify(buildItandiPropertyDataJson(res.detail));
              }
              enriched.push(res.detail);
            } else {
              skipped++;
              await setStorageData({ debugLog: `[手動送信] itandi詳細取得失敗→スキップ: ${p.building_name || ''} ${(res && res.error) || ''}` });
            }
          }
          try {
            await chrome.tabs.sendMessage(senderTabId, { type: 'MANUAL_SEND_PROGRESS', done: total, total, skipped });
          } catch (e) {}

          if (enriched.length === 0) {
            sendResponse({ ok: false, registered: 0, skipped, error: `全${total}件の詳細取得に失敗しました` });
            return;
          }

          try {
            await submitProperties(msg.customerName, enriched);
          } catch (e) {
            await setStorageData({ debugLog: '[手動送信] itandi承認待ち登録失敗: ' + e.message });
            sendResponse({ ok: false, registered: 0, skipped, error: '承認待ち登録に失敗: ' + e.message });
            return;
          }

          let opened = 0;
          for (const det of enriched) {
            if (!det.room_id) continue;
            try {
              const approveUrl = gasWebappUrl
                + '?action=approve&customer=' + encodeURIComponent(msg.customerName)
                + '&room_id=' + encodeURIComponent(det.room_id);
              await chrome.tabs.create({ url: approveUrl, active: true });
              opened++;
            } catch (e) {}
          }

          const message = skipped > 0
            ? `${enriched.length}件を承認待ちに登録し承認ページを開きました / ${skipped}件は取得失敗`
            : `${enriched.length}件を承認待ちに登録し承認ページを開きました`;
          await setStorageData({ debugLog: `手動送信(itandi→承認): ${msg.customerName} へ ${enriched.length}件登録 (失敗${skipped}) 承認タブ${opened}` });
          sendResponse({ ok: true, registered: enriched.length, skipped, opened, message });
          return;
        }

        // 従来動作（詳細取得なし）: そのまま転送（後方互換）
        const resp = await gasPost({
          action: 'send_manual_properties',
          customer_name: msg.customerName,
          properties: props
        });
        await setStorageData({ debugLog: `手動送信: ${msg.customerName} へ ${(resp && resp.sent) || 0}件 (${(resp && resp.message) || ''})` });
        sendResponse(resp);
      } catch (e) {
        await setStorageData({ debugLog: '手動送信失敗: ' + e.message });
        sendResponse({ ok: false, error: e.message });
      }
    })();
    return true;
  }

  // 手動: REINS物件を「選択した瞬間」に詳細取得してパネルのカートに保存する。
  // REINSは詳細取得に結果一覧の行クリックが必要なため、表示中に取得しておけば
  // ページ送り・別検索・別サイトへ移動してもカートから一括送信できる。
  if (msg.type === 'CAPTURE_REINS_DETAIL') {
    (async () => {
      try {
        const p = msg.property || {};
        const senderTabId = sender && sender.tab && sender.tab.id;
        if (!senderTabId) { sendResponse({ ok: false, error: 'タブが特定できません' }); return; }
        const autoTabId = await __getAutomationTabId();
        if (autoTabId && autoTabId === senderTabId) {
          sendResponse({ ok: false, error: '自動巡回中のタブでは取得できません。別タブでREINSを開いてください。' });
          return;
        }
        let res;
        try {
          res = await fetchReinsDetailForManual(senderTabId, {
            propertyNumber: p.reins_property_number || p.propertyNumber || '',
            index: (typeof p.reins_row_index === 'number') ? p.reins_row_index : -1
          }, { alreadyOnDetail: false });
        } catch (e) {
          res = { ok: false, error: e.message };
        }
        // 詳細で取れなかったフィールドを一覧値でフォールバック（物件名・賃料含む）
        if (res && res.ok && res.detail) {
          const _d = res.detail;
          if (!_d.building_name && p.buildingName) _d.building_name = p.buildingName;
          if (!_d.room_number && p.roomNumber) _d.room_number = p.roomNumber;
          if (!_d.rent && p.rent) _d.rent = Number(p.rent) || 0;
          if (!_d.management_fee && p.managementFee) _d.management_fee = Number(p.managementFee) || 0;
          if (!_d.deposit && p.deposit) _d.deposit = p.deposit;
          if (!_d.key_money && p.keyMoney) _d.key_money = p.keyMoney;
          if (!_d.layout && p.layout) _d.layout = p.layout;
          if (!_d.area && p.area) _d.area = p.area;
          if (!_d.building_age && p.buildingAge) _d.building_age = p.buildingAge;
          if (!_d.station_info && p.stationInfo) _d.station_info = p.stationInfo;
          if (!_d.address && p.address) _d.address = p.address;
        }
        if (res && res.ok && res.detail && res.detail.building_name) {
          sendResponse({ ok: true, detail: res.detail });
        } else {
          sendResponse({ ok: false, error: (res && res.error) || '詳細取得に失敗しました' });
        }
      } catch (e) {
        sendResponse({ ok: false, error: e.message });
      }
    })();
    return true;
  }

  // 手動: 送信カート（全サイト横断）を一括送信。各itemは {source, enriched, prop}。
  //  ・REINS: enriched（選択時に取得済みの詳細）をそのまま使う
  //  ・いえらぶ/itandi: 送信時に詳細ページを新タブで取得
  //  まとめて承認待ちに登録→承認ページを開く（既存の単一ソース送信と同じ後段）。
  if (msg.type === 'SEND_MANUAL_CART') {
    (async () => {
      try {
        const customerName = msg.customerName;
        const items = msg.items || [];
        const senderTabId = sender && sender.tab && sender.tab.id;
        if (!customerName) { sendResponse({ ok: false, error: '送信先のお客さんを選んでください' }); return; }
        if (!items.length) { sendResponse({ ok: false, error: '物件が選択されていません' }); return; }
        const { gasWebappUrl } = await getConfig();
        if (!gasWebappUrl) { sendResponse({ ok: false, error: 'GAS URLが設定されていません' }); return; }

        let customerObj = null;
        try {
          const cached = await new Promise(r => chrome.storage.local.get(['customerCriteria'], d => r(d.customerCriteria)));
          if (Array.isArray(cached)) customerObj = cached.find(c => c && c.name === customerName) || null;
        } catch (e) {}

        const total = items.length;
        let done = 0, skipped = 0;
        const allEnriched = [];
        const progress = async () => {
          try { await chrome.tabs.sendMessage(senderTabId, { type: 'MANUAL_SEND_PROGRESS', done, total, skipped }); } catch (e) {}
        };

        for (const it of items) {
          const src = it && it.source;
          const p = (it && it.prop) || {};
          await progress();
          if (src === 'reins') {
            // 選択時に取得済みの詳細をそのまま使う
            if (it.enriched && it.enriched.building_name) {
              try {
                if (customerObj && typeof globalThis.__computePropertyWarnings === 'function') {
                  it.enriched.warnings_text = (globalThis.__computePropertyWarnings(it.enriched, customerObj) || []).join('\n');
                }
              } catch (e) {}
              allEnriched.push(it.enriched);
            } else { skipped++; }
            done++;
            continue;
          }
          // いえらぶ / itandi は送信時に詳細取得
          let res;
          try {
            if (src === 'ielove') res = await fetchIeloveDetailForManual(p);
            else if (src === 'itandi') res = await fetchItandiDetailForManual(p);
            else res = { ok: false, error: '未対応ソース: ' + src };
          } catch (e) {
            res = { ok: false, error: e.message };
          }
          if (res && res.ok && res.detail && res.detail.building_name) {
            try {
              if (customerObj && typeof globalThis.__computePropertyWarnings === 'function') {
                res.detail.warnings_text = (globalThis.__computePropertyWarnings(res.detail, customerObj) || []).join('\n');
              }
            } catch (e) {}
            if (src === 'ielove' && typeof buildPropertyDataJson === 'function') {
              res.detail.property_data_json = JSON.stringify(buildPropertyDataJson(res.detail));
            }
            if (src === 'itandi' && typeof buildItandiPropertyDataJson === 'function') {
              res.detail.property_data_json = JSON.stringify(buildItandiPropertyDataJson(res.detail));
            }
            allEnriched.push(res.detail);
          } else {
            skipped++;
            await setStorageData({ debugLog: `[カート送信] 詳細取得失敗→スキップ: ${src} ${(p.buildingName || p.building_name || '')} ${(res && res.error) || ''}` });
          }
          done++;
        }
        done = total;
        await progress();

        if (allEnriched.length === 0) {
          sendResponse({ ok: false, registered: 0, skipped, error: `全${total}件の詳細取得に失敗しました` });
          return;
        }

        try {
          await submitProperties(customerName, allEnriched);
        } catch (e) {
          await setStorageData({ debugLog: '[カート送信] 承認待ち登録失敗: ' + e.message });
          sendResponse({ ok: false, registered: 0, skipped, error: '承認待ち登録に失敗: ' + e.message });
          return;
        }

        // 承認ページを開く。
        //  ・1件 → 普通の承認ページ(action=approve)＝フル機能・1バブル送信
        //  ・複数件 → 一括承認コンテナ(action=approve_all&room_ids)＝各物件のフル承認ページを縦に並べ、確定→1カルーセル送信
        const roomIds = allEnriched.map(d => d.room_id).filter(Boolean);
        let opened = 0;
        if (roomIds.length === 1) {
          try {
            const approveUrl = gasWebappUrl
              + '?action=approve&customer=' + encodeURIComponent(customerName)
              + '&room_id=' + encodeURIComponent(roomIds[0]);
            await chrome.tabs.create({ url: approveUrl, active: true });
            opened = 1;
          } catch (e) {}
        } else if (roomIds.length > 1) {
          try {
            const approveUrl = gasWebappUrl
              + '?action=approve_all&customer=' + encodeURIComponent(customerName)
              + '&room_ids=' + encodeURIComponent(roomIds.join(','));
            await chrome.tabs.create({ url: approveUrl, active: true });
            opened = 1;
          } catch (e) {}
        }

        const message = skipped > 0
          ? `${allEnriched.length}件を承認待ちに登録し承認ページを開きました / ${skipped}件は取得失敗`
          : `${allEnriched.length}件を承認待ちに登録し承認ページを開きました`;
        await setStorageData({ debugLog: `手動カート送信: ${customerName} へ ${allEnriched.length}件登録 (失敗${skipped}) 承認タブ${opened}` });
        sendResponse({ ok: true, registered: allEnriched.length, skipped, opened, message });
      } catch (e) {
        await setStorageData({ debugLog: '手動カート送信失敗: ' + e.message });
        sendResponse({ ok: false, error: e.message });
      }
    })();
    return true;
  }

  // 手動: 選択物件の競合数・反響予測点数を調べて1件ずつパネルへ返す（送信はしない）
  if (msg.type === 'CHECK_SUUMO_METRICS') {
    (async () => {
      try {
        const props = msg.properties || [];
        const senderTabId = sender && sender.tab && sender.tab.id;
        const total = props.length;
        for (let i = 0; i < props.length; i++) {
          const np = normalizePropForMetrics(props[i]);
          let competitor = null, score = null, scoreLabel = '', hasMarket = false, error = '';
          try {
            // 競合数
            if (typeof countSuumoCompetitors === 'function') {
              competitor = await countSuumoCompetitors(np);
            }
            // 相場中央値（取れれば反響点数の平米単価要素＝60%に使う。取れなくても点数は出す）
            let marketMedian = 0;
            if (typeof getSuumoMarketMedian === 'function' && np.address && np.layout && np.area) {
              const propertyType = (np.structure && /木造/.test(np.structure)) ? 'アパート' : 'マンション';
              const median = await getSuumoMarketMedian({
                address: np.address,
                layout: np.layout,
                area: np.area,
                buildingAge: (typeof extractBuildingAge === 'function') ? extractBuildingAge(np) : null,
                walkMinutes: (typeof extractWalkMinutes === 'function') ? extractWalkMinutes(np) : null,
                propertyType: propertyType,
              });
              if (median && median.ok) { marketMedian = median.median; hasMarket = true; }
            }
            // 反響予測点数: 相場が取れなくても駅徒歩・築年で部分点数を出す（_finalizeScoreが再正規化）
            if (typeof calculateInquiryScore === 'function') {
              const sc = calculateInquiryScore(buildInquiryScoreInput(np, marketMedian));
              if (sc && typeof sc.score === 'number') { score = sc.score; scoreLabel = sc.label || ''; }
            }
          } catch (e) {
            error = (e && e.message) || String(e);
          }
          if (senderTabId) {
            try {
              await chrome.tabs.sendMessage(senderTabId, {
                type: 'MANUAL_METRICS_PROGRESS',
                index: i, total, competitor, score, scoreLabel, hasMarket, error
              });
            } catch (e) {}
          }
        }
        sendResponse({ ok: true, done: total });
      } catch (e) {
        await setStorageData({ debugLog: '競合数・点数調査失敗: ' + e.message });
        sendResponse({ ok: false, error: e.message });
      }
    })();
    return true;
  }

  // 手動: 選択物件の詳細を取得→SUUMO候補に登録→SUUMO承認ページを開く（全サイト対応）
  if (msg.type === 'PUBLISH_TO_SUUMO') {
    (async () => {
      try {
        const props = msg.properties || [];
        const source = msg.source || (props[0] && props[0].source) || '';
        const senderTabId = sender && sender.tab && sender.tab.id;
        const fromDetailPage = !!msg.fromDetailPage;

        const { gasWebappUrl } = await getConfig();
        if (!gasWebappUrl) { sendResponse({ ok: false, error: 'GAS URLが設定されていません' }); return; }

        // REINS: 自動巡回タブとの衝突を防止（同一タブを両者が操作すると壊れる）
        if (source === 'reins' && senderTabId) {
          const autoTabId = await __getAutomationTabId();
          if (autoTabId && autoTabId === senderTabId) {
            sendResponse({ ok: false, error: '自動巡回中のタブでは手動取得できません。別のタブでREINSを開いてください。' });
            return;
          }
        }

        const total = props.length;
        const enriched = [];
        let skipped = 0;
        for (let i = 0; i < props.length; i++) {
          const p = props[i] || {};
          try {
            await chrome.tabs.sendMessage(senderTabId, { type: 'MANUAL_SEND_PROGRESS', done: i, total, skipped });
          } catch (e) {}
          let res;
          try {
            res = await enrichOneForManual(source, p, senderTabId, fromDetailPage);
          } catch (e) {
            res = { ok: false, error: e.message };
          }
          if (res && res.ok && res.detail && res.detail.building_name) {
            enriched.push(res.detail);
          } else {
            skipped++;
            await setStorageData({ debugLog: `[SUUMO掲載] 詳細取得失敗→スキップ: ${p.building_name || p.buildingName || ''} ${(res && res.error) || ''}` });
          }
        }
        try {
          await chrome.tabs.sendMessage(senderTabId, { type: 'MANUAL_SEND_PROGRESS', done: total, total, skipped });
        } catch (e) {}

        if (enriched.length === 0) {
          sendResponse({ ok: false, registered: 0, skipped, error: `全${total}件の詳細取得に失敗しました` });
          return;
        }

        // SUUMO候補シートに登録（add_suumo_candidate）。
        // 注: sendSuumoCandidatesToGas は Discord 通知の副作用があるため使わず POST をインライン化。
        try {
          const resp = await fetch(gasWebappUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'add_suumo_candidate', properties: enriched, patrolCriteriaId: null })
          });
          if (!resp.ok) throw new Error('HTTP ' + resp.status);
        } catch (e) {
          await setStorageData({ debugLog: '[SUUMO掲載] 候補登録失敗: ' + e.message });
          sendResponse({ ok: false, registered: 0, skipped, error: 'SUUMO候補登録に失敗: ' + e.message });
          return;
        }

        // 承認ページを物件ごとに開く（key は GAS と同一式で自前生成＝新規/既存問わず効く）
        let opened = 0;
        const seenKey = {};
        for (const det of enriched) {
          const key = suumoPropertyKey(det.building_name, det.room_number);
          if (!key || key === '|' || seenKey[key]) continue;
          seenKey[key] = true;
          try {
            const approveUrl = gasWebappUrl + '?action=suumo_approve&key=' + encodeURIComponent(key);
            await chrome.tabs.create({ url: approveUrl, active: true });
            opened++;
          } catch (e) {}
        }

        const message = skipped > 0
          ? `${enriched.length}件をSUUMO候補に登録し承認ページを開きました / ${skipped}件は取得失敗`
          : `${enriched.length}件をSUUMO候補に登録し承認ページを開きました`;
        await setStorageData({ debugLog: `[SUUMO掲載] ${source}: ${enriched.length}件登録 (失敗${skipped}) 承認タブ${opened}` });
        sendResponse({ ok: true, registered: enriched.length, skipped, opened, message });
      } catch (e) {
        await setStorageData({ debugLog: 'SUUMO掲載失敗: ' + e.message });
        sendResponse({ ok: false, error: e.message });
      }
    })();
    return true;
  }

  if (msg.type === 'OPEN_SEARCH_PAGE') {
    (async () => {
      try {
        const customer = msg.customer;
        const service = msg.service;
        await setStorageData({ debugLog: `[検索ページ] ${customer.name}: ${service} を開きます` });

        if (service === 'ielove') {
          // いえらぶ: 駅コードJSON読み込み + 町名コード50件超でチャンク分割
          await loadIeloveStationCodes();
          const oazaCodes = resolveIeloveOazaCodes(customer);
          const OAZA_CHUNK = 50;
          const oazaChunks = oazaCodes.length > 0
            ? Array.from({ length: Math.ceil(oazaCodes.length / OAZA_CHUNK) }, (_, i) => oazaCodes.slice(i * OAZA_CHUNK, i * OAZA_CHUNK + OAZA_CHUNK))
            : [[]];
          for (let ci = 0; ci < oazaChunks.length; ci++) {
            const url = buildIeloveSearchUrl(customer, 1, oazaChunks[ci]);
            const ieloveTab = await chrome.tabs.create({ url, active: ci === oazaChunks.length - 1 });
            await recordManualSearchCustomer(ieloveTab.id, customer.name);
          }
          await setStorageData({ debugLog: `[検索ページ] ${customer.name}: いえらぶ ${oazaChunks.length}タブ` });
          sendResponse({ ok: true, batches: oazaChunks.length });

        } else if (service === 'essquare') {
          // 2026-06-03: いい生活Square 恒久停止(規約違反でアカウントBAN)。
          // 検索ページも開かない。再開はBAN逃れになるため不可。
          await setStorageData({ debugLog: `[検索ページ] いい生活Squareは停止中のため開きません` });
          sendResponse({ ok: false, disabled: true, error: 'ES-Square は停止中です' });
          return;
          // eslint-disable-next-line no-unreachable
          // ↓ 旧ロジック（無効化済み・参考保持）
          const allStationCodes = _resolveEssquareStationCodes(customer);
          const allJusho = _resolveEssquareJushoList(customer);
          const STA_CHUNK = 49, JUSHO_CHUNK = 50;
          const stationChunks = allStationCodes.length > STA_CHUNK
            ? Array.from({ length: Math.ceil(allStationCodes.length / STA_CHUNK) }, (_, i) => allStationCodes.slice(i * STA_CHUNK, i * STA_CHUNK + STA_CHUNK))
            : [allStationCodes.length > 0 ? allStationCodes : null];
          const jushoChunks = allJusho.length > 0
            ? Array.from({ length: Math.ceil(allJusho.length / JUSHO_CHUNK) }, (_, i) => allJusho.slice(i * JUSHO_CHUNK, i * JUSHO_CHUNK + JUSHO_CHUNK))
            : [null];
          let tabCount = 0;
          const totalChunks = stationChunks.length * jushoChunks.length;
          for (const staChunk of stationChunks) {
            for (const jushoChunk of jushoChunks) {
              tabCount++;
              const url = buildEssquareSearchUrl(customer, 1, jushoChunk, staChunk);
              const essTab = await chrome.tabs.create({ url, active: tabCount === totalChunks });
              await recordManualSearchCustomer(essTab.id, customer.name);
            }
          }
          await setStorageData({ debugLog: `[検索ページ] ${customer.name}: いい生活 ${tabCount}タブ` });
          sendResponse({ ok: true, batches: tabCount });

        } else if (service === 'reins') {
          // REINS: バッチ分割対応（沿線3本・市区町村3つまで/1タブ）
          const CIRCULAR_LINE_KEYWORDS = ['山手線', '大江戸線'];
          const rwsRaw = customer.routes_with_stations || [];
          const rws = [];
          for (const r of rwsRaw) {
            const isCircular = CIRCULAR_LINE_KEYWORDS.some(kw => (r.route || '').includes(kw));
            if (isCircular && r.stations && r.stations.length > 1) {
              for (const st of r.stations) rws.push({ route: r.route, stations: [st] });
            } else {
              rws.push(r);
            }
          }
          const cities = customer.cities || [];
          const rwsChunks = rws.length > 0
            ? Array.from({ length: Math.ceil(rws.length / 3) }, (_, i) => rws.slice(i * 3, i * 3 + 3))
            : [[]];
          const cityChunks = cities.length > 0
            ? Array.from({ length: Math.ceil(cities.length / 3) }, (_, i) => cities.slice(i * 3, i * 3 + 3))
            : [[]];
          const totalBatches = rwsChunks.length * cityChunks.length;

          const lineNameMap = await loadLineNameMap();
          const reinsCodeMap = await loadReinsCodeMap();
          const btModeFresh = await new Promise(r => chrome.storage.local.get(['btMode'], d => r(d.btMode || 'alert')));
          let batchIdx = 0;
          let lastError = null;

          for (const rwsChunk of rwsChunks) {
            for (const cityChunk of cityChunks) {
              batchIdx++;
              const batchCustomer = {
                ...customer,
                routes_with_stations: rwsChunk,
                stations: rwsChunk.flatMap(r => r.stations || []),
                cities: cityChunk,
              };
              const batchLabel = totalBatches > 1 ? ` (${batchIdx}/${totalBatches})` : '';

              const reinsTab = await chrome.tabs.create({ url: 'https://system.reins.jp/main/BK/GBK001310', active: true });
              await recordManualSearchCustomer(reinsTab.id, customer.name);
              await waitForTabLoad(reinsTab.id);

              await chrome.scripting.executeScript({
                target: { tabId: reinsTab.id }, world: 'MAIN',
                func: () => {
                  const nuxt = window.$nuxt;
                  if (!nuxt) return;
                  if (nuxt.$route?.path !== '/main/BK/GBK001310') nuxt.$router.push('/main/BK/GBK001310');
                  nuxt.refresh();
                }
              });

              const formReady = await waitForDomReady(reinsTab.id, '.p-textbox-input', { timeout: 30000 });
              if (!formReady.found) {
                lastError = 'REINS検索フォームが見つかりません（ログインしていますか？）';
                await setStorageData({ debugLog: `[検索ページ] ${customer.name}: ${lastError}` });
                break;
              }

              const stationStr = buildStationString(batchCustomer);
              const criteriaArgs = [stationStr, {
                rent_max: batchCustomer.rent_max, layouts: batchCustomer.layouts || [],
                area_min: batchCustomer.area_min || '', building_age: batchCustomer.building_age || '',
                equipment: batchCustomer.equipment || '', stations: batchCustomer.stations || [],
                routes_with_stations: batchCustomer.routes_with_stations || [],
                walk: batchCustomer.walk || '', cities: batchCustomer.cities || [],
                prefecture: batchCustomer.prefecture || '東京都',
                selectedTowns: batchCustomer.selectedTowns || {}
              }, lineNameMap, reinsCodeMap, (batchCustomer.btMode || btModeFresh)];

              await waitForDomReady(reinsTab.id, '.p-textbox-input', { timeout: 15000 });
              const setResult = await chrome.scripting.executeScript({
                target: { tabId: reinsTab.id }, world: 'MAIN',
                func: __reinsCriteriaFunc, args: criteriaArgs
              });

              const setStatus = setResult?.[0]?.result;
              if (setStatus?.success) {
                await setStorageData({ debugLog: `[検索ページ] ${customer.name}: REINS フォーム入力完了${batchLabel}` });
              } else {
                lastError = 'REINS条件セット失敗: ' + JSON.stringify(setStatus);
                await setStorageData({ debugLog: `[検索ページ] ${customer.name}: ${lastError}` });
              }
            }
            if (lastError) break;
          }

          if (lastError) {
            sendResponse({ ok: false, error: lastError });
          } else {
            await setStorageData({ debugLog: `[検索ページ] ${customer.name}: REINS 全${totalBatches}バッチ完了` });
            sendResponse({ ok: true, batches: totalBatches });
          }
        } else if (service === 'itandi') {
          // itandi BB: 検索フォームを開いて条件を入力（REINSと同様のフォーム入力方式）
          const itandiTab = await chrome.tabs.create({
            url: 'https://itandibb.com/rent_rooms/list',
            active: true
          });
          await waitForTabLoad(itandiTab.id);

          // フォームの読み込みを待つ（React SPAなので少し待つ）
          const formReady = await waitForDomReady(itandiTab.id, 'input[name="rent:lteq"]', { timeout: 30000 });
          if (!formReady.found) {
            const errMsg = 'itandi検索フォームが見つかりません（ログインしていますか？）';
            await setStorageData({ debugLog: `[検索ページ] ${customer.name}: ${errMsg}` });
            sendResponse({ ok: false, error: errMsg });
            return;
          }

          // 少し待ってからフォーム入力（Reactコンポーネントの完全マウントを待つ）
          await sleep(1000);

          // ── Step 1: 基本条件を入力 ──
          const setResult = await chrome.scripting.executeScript({
            target: { tabId: itandiTab.id }, world: 'MAIN',
            func: __itandiCriteriaFunc,
            args: [{
              rent_max: customer.rent_max || '',
              layouts: customer.layouts || [],
              walk: customer.walk || '',
              area_min: customer.area_min || '',
              building_age: customer.building_age || '',
              structures: customer.structures || [],
              equipment: 'バストイレ別',  // itandiはBT別のみハードフィルタ（他の設備はソフトフィルタ）
            }]
          });

          const setStatus = setResult?.[0]?.result;
          if (setStatus?.success) {
            await setStorageData({ debugLog: `[検索ページ] ${customer.name}: itandi 基本条件入力完了 (${setStatus.filled.join(', ')})` });
          } else {
            const errMsg = 'itandi条件セット失敗: ' + JSON.stringify(setStatus);
            await setStorageData({ debugLog: `[検索ページ] ${customer.name}: ${errMsg}` });
            sendResponse({ ok: false, error: errMsg });
            return;
          }

          // ── Step 2: 駅選択（モーダル経由） ──
          const allStations = (customer.routes_with_stations || []).flatMap(r => r.stations || []);
          const uniqueStations = [...new Set(allStations.map(s => s.replace(/駅$/, '').trim()))].filter(s => s);

          if (uniqueStations.length > 0) {
            // モーダルを開く
            const openResult = await chrome.scripting.executeScript({
              target: { tabId: itandiTab.id }, world: 'MAIN',
              func: __itandiOpenStationModal, args: []
            });
            const openStatus = openResult?.[0]?.result;
            if (!openStatus?.ok) {
              await setStorageData({ debugLog: `[検索ページ] ${customer.name}: 駅モーダルを開けませんでした` });
              sendResponse({ ok: true, batches: 1, filled: setStatus.filled, stationError: 'モーダルが開けない' });
              return;
            }

            // モーダルの描画を待つ
            await waitForDomReady(itandiTab.id, '[role="dialog"]', { timeout: 5000 });
            await sleep(500);

            // 1駅ずつ検索→チェック（1回のexecuteScriptで検索+描画待ち+クリックを実行）
            // 各駅はチェック状態を検証してから次へ進む。未チェックの駅は背景側でも数回リトライ。
            let stationsChecked = 0;
            const stationErrors = [];
            for (const stName of uniqueStations) {
              let checked = false;
              for (let attempt = 0; attempt < 2 && !checked; attempt++) {
                const checkResult = await chrome.scripting.executeScript({
                  target: { tabId: itandiTab.id }, world: 'MAIN',
                  func: __itandiSelectAndCheckStation, args: [stName]
                });
                const checkStatus = checkResult?.[0]?.result;
                console.log(`[OPEN_SEARCH_PAGE] itandi駅: ${stName} (試行${attempt + 1}) →`, JSON.stringify(checkStatus));
                if (checkStatus?.checked) {
                  checked = true;
                } else if (attempt === 0) {
                  await sleep(600); // 再試行前に少し待つ
                }
              }
              if (checked) stationsChecked++;
              else stationErrors.push(stName);
            }

            // ★ 駅が1件もチェックできなかった場合は確定・検索しない。
            //   駅フィルタなしで検索すると全件ヒットして無関係な物件が大量に出るため中止。
            if (stationsChecked === 0) {
              await setStorageData({ debugLog: `[検索ページ] ${customer.name}: itandi 駅を1件も選択できず検索中止 (対象: ${uniqueStations.join(', ')})` });
              sendResponse({ ok: false, error: '駅を選択できませんでした: ' + uniqueStations.join(', '), stationErrors });
              return;
            }

            // 確定ボタンをクリック
            await chrome.scripting.executeScript({
              target: { tabId: itandiTab.id }, world: 'MAIN',
              func: __itandiConfirmStations, args: []
            });
            await sleep(500);

            // ★ 確定後にモーダルが閉じたことを確認（閉じていなければ確定が効いていない）
            const modalClosed = await chrome.scripting.executeScript({
              target: { tabId: itandiTab.id }, world: 'MAIN',
              func: () => !document.querySelector('[role="dialog"]')
            });
            if (!modalClosed?.[0]?.result) {
              // 再度確定を試みる
              await chrome.scripting.executeScript({
                target: { tabId: itandiTab.id }, world: 'MAIN',
                func: __itandiConfirmStations, args: []
              });
              await sleep(500);
            }

            const stationMsg = `駅: ${stationsChecked}/${uniqueStations.length}件選択`;
            const filledAll = [...(setStatus.filled || []), stationMsg];
            if (stationErrors.length > 0) {
              await setStorageData({ debugLog: `[検索ページ] ${customer.name}: itandi完了 (未検出駅: ${stationErrors.join(', ')})` });
            } else {
              await setStorageData({ debugLog: `[検索ページ] ${customer.name}: itandi フォーム入力完了 (${filledAll.join(', ')})` });
            }

            // 検索ボタンをクリック
            await sleep(300);
            await chrome.scripting.executeScript({
              target: { tabId: itandiTab.id }, world: 'MAIN',
              func: () => {
                var btns = document.querySelectorAll('button');
                for (var i = 0; i < btns.length; i++) {
                  if (btns[i].textContent.trim() === '検索' && btns[i].classList.contains('MuiButton-containedPrimary')) {
                    btns[i].click();
                    console.log('[itandi] 検索ボタンクリック');
                    break;
                  }
                }
              }
            });

            sendResponse({ ok: true, batches: 1, filled: filledAll, stationErrors });
          }

          // ── Step 3: 所在地選択（駅がない場合、市区町村・町名で検索） ──
          const cities = customer.cities || [];
          const selectedTowns = customer.selectedTowns || {};
          if (uniqueStations.length === 0 && cities.length > 0) {
            // モーダルを開く
            const addrOpenResult = await chrome.scripting.executeScript({
              target: { tabId: itandiTab.id }, world: 'MAIN',
              func: __itandiOpenAddressModal, args: []
            });
            const addrOpenStatus = addrOpenResult?.[0]?.result;
            if (!addrOpenStatus?.ok) {
              await setStorageData({ debugLog: `[検索ページ] ${customer.name}: 所在地モーダルを開けませんでした` });
            } else {
              // モーダルの描画を待つ
              await waitForDomReady(itandiTab.id, '.itandi-bb-ui__ModalBody', { timeout: 5000 });
              await sleep(500);

              // Step 3a: 都道府県選択（同期関数）
              const prefResult = await chrome.scripting.executeScript({
                target: { tabId: itandiTab.id }, world: 'MAIN',
                func: __itandiSelectPrefecture,
                args: [customer.prefecture || '東京都']
              });
              const prefStatus = prefResult?.[0]?.result;
              console.log(`[OPEN_SEARCH_PAGE] itandi都道府県:`, JSON.stringify(prefStatus));

              if (prefStatus?.ok) {
                await sleep(500);

                // Step 3b: 市区町村ごとに選択
                let citiesSelected = 0;
                let townsChecked = 0;
                const cityErrors = [];
                for (const city of cities) {
                  // 市区町村を選択（単一Promise）
                  const cityResult = await chrome.scripting.executeScript({
                    target: { tabId: itandiTab.id }, world: 'MAIN',
                    func: __itandiSelectCity,
                    args: [city]
                  });
                  const cityStatus = cityResult?.[0]?.result;
                  console.log(`[OPEN_SEARCH_PAGE] itandi市区町村: ${city} →`, JSON.stringify(cityStatus));

                  if (cityStatus?.citySelected) {
                    citiesSelected++;

                    // Step 3c: 町域チェック（単一Promise + ステートマシン）
                    const townList = selectedTowns[city] || [];
                    if (townList.length > 0) {
                      await sleep(500); // 市区町村クリック後のAPI読み込み開始を待つ
                      const townResult = await chrome.scripting.executeScript({
                        target: { tabId: itandiTab.id }, world: 'MAIN',
                        func: __itandiSelectTowns,
                        args: [townList]
                      });
                      const townStatus = townResult?.[0]?.result;
                      console.log(`[OPEN_SEARCH_PAGE] itandi町域: ${city} →`, JSON.stringify(townStatus));
                      townsChecked += townStatus?.townsChecked || 0;
                    }
                  } else {
                    cityErrors.push(city + ': ' + (cityStatus?.error || '不明'));
                  }
                  await sleep(300); // 次の市区町村選択前に少し待つ
                }

                // 確定ボタンをクリック
                await chrome.scripting.executeScript({
                  target: { tabId: itandiTab.id }, world: 'MAIN',
                  func: __itandiConfirmAddress, args: []
                });
                await sleep(500);

                const addrMsg = `所在地: ${citiesSelected}/${cities.length}区` + (townsChecked > 0 ? ` (町域${townsChecked}件)` : '');
                setStatus.filled.push(addrMsg);
                if (cityErrors.length > 0) {
                  await setStorageData({ debugLog: `[検索ページ] ${customer.name}: itandi所在地 (未検出: ${cityErrors.join(', ')})` });
                }
              } else {
                await setStorageData({ debugLog: `[検索ページ] ${customer.name}: 都道府県選択失敗: ${prefStatus?.error || '不明'}` });
              }
            }
          }

          // 検索ボタンをクリック
          if (uniqueStations.length === 0) {
            await setStorageData({ debugLog: `[検索ページ] ${customer.name}: itandi フォーム入力完了 (${setStatus.filled.join(', ')})` });
            await sleep(300);
            await chrome.scripting.executeScript({
              target: { tabId: itandiTab.id }, world: 'MAIN',
              func: () => {
                var btns = document.querySelectorAll('button');
                for (var i = 0; i < btns.length; i++) {
                  if (btns[i].textContent.trim() === '検索' && btns[i].classList.contains('MuiButton-containedPrimary')) {
                    btns[i].click();
                    console.log('[itandi] 検索ボタンクリック');
                    break;
                  }
                }
              }
            });
            sendResponse({ ok: true, batches: 1, filled: setStatus.filled });
          }

        } else {
          sendResponse({ ok: false, error: '未対応サービス: ' + service });
        }
      } catch (err) {
        console.error('[OPEN_SEARCH_PAGE] error:', err);
        await setStorageData({ debugLog: `[検索ページ] エラー: ${err.message}` });
        sendResponse({ ok: false, error: err.message });
      }
    })();
    return true; // async sendResponse
  }
});

// --- 検索条件取得 ---
async function refreshCriteria() {
  try {
    const result = await fetchCriteria();
    if (result?.error) {
      await setStorageData({ debugLog: `GAS criteria error: ${result.error}` });
    }
    if (result && result.criteria) {
      // デバッグ: 全顧客のequipment値を出力
      const equipDebug = result.criteria.map(c => `${c.name}:[${c.equipment||''}]`).join(' | ');
      await setStorageData({ debugLog: `DEBUG equips: ${equipDebug}` });
      chrome.storage.local.set({
        customerCriteria: result.criteria,
        lastCriteriaFetch: Date.now()
      });
      console.log(`検索条件取得: ${result.criteria.length}件`);
    }
  } catch (err) {
    logError('検索条件取得失敗: ' + err.message);
    throw err;
  }
}

// _unresolvedStations にエントリを追加するヘルパー
function addUnresolvedStation(customerName, service, stationName) {
  if (!_unresolvedStations[customerName]) _unresolvedStations[customerName] = {};
  if (!_unresolvedStations[customerName][service]) _unresolvedStations[customerName][service] = [];
  const list = _unresolvedStations[customerName][service];
  if (!list.includes(stationName)) list.push(stationName);
}

// 未解決駅サマリーをログ出力 + GAS報告
async function reportUnresolvedStations() {
  // 実際に未解決駅があるエントリだけ抽出
  const entries = [];
  for (const [customer, services] of Object.entries(_unresolvedStations)) {
    const svcParts = [];
    for (const [svc, names] of Object.entries(services)) {
      if (names.length > 0) svcParts.push(`${svc}: ${names.join(', ')}`);
    }
    if (svcParts.length > 0) entries.push({ customer, detail: svcParts.join(' / '), services });
  }

  if (entries.length === 0) return; // 全駅解決済み → 何もしない

  // コンソール警告
  const summary = entries.map(e => `  ${e.customer}: ${e.detail}`).join('\n');
  console.warn(`[駅名解決失敗まとめ]\n${summary}`);

  // デバッグログにも表示
  await setStorageData({ debugLog: `⚠️ 駅名解決失敗: ${entries.map(e => e.detail).join(' | ')}` });

  // GASに報告（失敗してもサイクルは止めない）
  // Discord通知は各顧客スレッド内で送信済み（sendDiscordNotification内）
  try {
    await gasPost({
      action: 'log_unresolved_stations',
      data: _unresolvedStations,
    });
  } catch (err) {
    console.warn('[未解決駅] GAS報告失敗:', err.message);
  }
}

// --- メイン検索サイクル ---
globalThis.runSearchCycle = async function runSearchCycle() {
  const { isSearching, suumoPatrolRunning, gasWebappUrl, enabledServices } =
    await getStorageData(['isSearching', 'suumoPatrolRunning', 'gasWebappUrl', 'enabledServices']);
  if (isSearching) { console.log('検索中のためスキップ'); return; }
  // SUUMO巡回中は顧客検索を起動しない (currentSearchIdを共有していた頃の
  // 相互キャンセル事故を防ぐ。手動 SEARCH_NOW・アラーム両方で適用)。
  // ペンディングフラグを立てておくと、巡回完了の finally でチェイン起動される。
  if (suumoPatrolRunning) {
    console.log('SUUMO巡回中のため顧客検索をスキップ (巡回完了時にチェイン起動)');
    await setStorageData({
      customerSearchPending: true,
      debugLog: '[system] SUUMO巡回中のため顧客検索を pending → 巡回完了時に自動起動'
    });
    return;
  }
  if (!gasWebappUrl) { console.log('GAS URL未設定のためスキップ'); return; }
  // 自分が走り始めたら pending はクリア (二重起動防止)
  try { await setStorageData({ customerSearchPending: false }); } catch (_) {}

  const services = enabledServices || { reins: true, ielove: true, itandi: true, essquare: true };
  // 2026-06-03: いい生活Square は規約違反(機械的取得=スクレイピング)でアカウントBAN。
  // 自動化を恒久停止する。再開はBAN逃れ(さらなる違反)になるため不可。
  // どんな設定でも essquare は走らせない（ラベル表示・早期return判定にも波及）。
  services.essquare = false;

  if (!services.reins && !services.ielove && !services.itandi && !services.essquare) {
    console.log('有効なサービスがありません');
    return;
  }

  const searchId = ++currentSearchId;
  // 未解決駅の蓄積をリセット
  _unresolvedStations = {};
  // DiscordスレッドIDは永続化のためクリアしない（同じスレッドを再利用）
  // 物件通し番号はサイクルごとにリセット
  Object.keys(discordPropertyCounters).forEach(k => delete discordPropertyCounters[k]);
  // 一括通知バッファをクリア
  Object.keys(_batchBuffer).forEach(k => delete _batchBuffer[k]);
  const serviceNames = [services.reins && 'REINS', services.ielove && 'いえらぶ', services.itandi && 'itandi', services.essquare && 'ES-Square'].filter(Boolean).join('・');
  await setStorageData({ isSearching: true, debugLog: `━━━ 検索開始 (${serviceNames}) ━━━` });

  // ワンショット強制再取得リストを読み込み(検索終了時にクリア)
  // 各サイトの seen/skipped チェックがこのSetを参照してバイパスする
  // プレフィックス対応: "reins_100138898060" のような形式も自動的に剥がして登録
  try {
    const { oneShotForceRefetch } = await getStorageData(['oneShotForceRefetch']);
    const rawList = Array.isArray(oneShotForceRefetch) ? oneShotForceRefetch.map(s => String(s).trim()).filter(Boolean) : [];
    const expanded = new Set();
    for (const raw of rawList) {
      expanded.add(raw); // 生形式
      // reins_ / itandi_ / ielove_ / essquare_ プレフィックスを剥がす
      const stripped = raw.replace(/^(reins_|itandi_|ielove_|essquare_)/, '');
      if (stripped !== raw) expanded.add(stripped);
    }
    globalThis._oneShotForceRefetchSet = expanded;
    if (rawList.length > 0) {
      await setStorageData({ debugLog: `[強制再取得] ${rawList.length}件の物件番号を再取得対象として登録(プレフィックス展開後${expanded.size}件): ${rawList.slice(0, 5).join(', ')}${rawList.length > 5 ? '...' : ''}` });
    }
  } catch (_) {
    globalThis._oneShotForceRefetchSet = new Set();
  }

  // ログタブを自動オープン（既に開いていればフォーカス）
  await openLogTab();

  // 検索全体を通してService Workerを生存させるグローバルkeepalive
  const globalKeepAlive = setInterval(() => {
    chrome.runtime.getPlatformInfo(() => {});
  }, 20000);

  // 検索中はスリープを抑制(画面はオフ可・システムスリープのみ防止)
  try { chrome.power && chrome.power.requestKeepAwake && chrome.power.requestKeepAwake('system'); } catch(e) {}

  try {
    // 検索条件を取得（毎回GASから最新を取得）
    await setStorageData({ debugLog: '検索条件を取得中...' });
    try {
      await refreshCriteria();
    } catch (err) {
      await setStorageData({ debugLog: `検索条件取得失敗: ${err.message}` });
      return;
    }
    const { customerCriteria: allCriteria, excludedCustomers } = await getStorageData(['customerCriteria', 'excludedCustomers']);
    if (!allCriteria || allCriteria.length === 0) {
      await setStorageData({ debugLog: '検索条件がありません（GASに条件が登録されていない可能性）' });
      return;
    }
    // 除外リストに入っている顧客をスキップ（新規顧客は自動で検索対象）
    const excluded = excludedCustomers || [];
    // エントリ固有キーで除外判定（本人=名前 / おすすめ条件=rec::ID）。
    // これで本人の条件とおすすめ条件を独立してON/OFFできる。
    const _critKey = (c) => (c && c.recommend ? ('rec::' + (c.recommendId || c.name)) : (c ? c.name : ''));
    const criteria = excluded.length > 0
      ? allCriteria.filter(c => !excluded.includes(_critKey(c)))
      : allCriteria;
    if (criteria.length === 0) {
      await setStorageData({ debugLog: '選択された顧客がありません' });
      return;
    }
    const skipped = allCriteria.length - criteria.length;
    const skippedMsg = skipped > 0 ? `（${skipped}件スキップ）` : '';
    await setStorageData({ debugLog: `検索条件 ${criteria.length}件取得完了${skippedMsg}` });

    let seenIds = {};
    await setStorageData({ debugLog: '既知物件IDを取得中...' });
    try {
      const seenResult = await fetchSeenIds();
      if (seenResult && seenResult.seen_ids) seenIds = seenResult.seen_ids;

      // 通知済み物件の dedupキー一覧 → notifiedDedupMap に反映
      //   GAS の承認待ちシート (sent行) から address+room_number+area+layout で
      //   生成された dedup キー一覧を受け取り、Chrome拡張側のマップを補完。
      //   これで itandi の property_id が変動 (再掲載で別ID) しても、 同じ物件は
      //   重複検知でスキップできる。
      const dedupKeysFromGas = (seenResult && seenResult.seen_dedup_keys) || {};
      let dedupKeysAdded = 0;
      const nowMs = Date.now();
      for (const cust in dedupKeysFromGas) {
        const keys = dedupKeysFromGas[cust] || [];
        if (!Array.isArray(keys) || keys.length === 0) continue;
        if (!globalThis.__notifiedDedupMap[cust]) globalThis.__notifiedDedupMap[cust] = {};
        const inner = globalThis.__notifiedDedupMap[cust];
        for (const k of keys) {
          if (!k) continue;
          if (!inner[k]) {
            inner[k] = { ts: nowMs, source: 'gas_sync', url: '' };
            dedupKeysAdded++;
          }
        }
      }
      if (dedupKeysAdded > 0) {
        await chrome.storage.local.set({ notifiedDedupMap: globalThis.__notifiedDedupMap });
        await setStorageData({ debugLog: `[GAS同期] 通知済み物件の dedup キー ${dedupKeysAdded} 件を notifiedDedupMap に追加` });
      }

      // AdminPage で履歴リセットされた顧客×ソース の dedup マップを処理
      // GAS の pending_dedup_resets を受け取り、notifiedDedupMap から該当エントリを削除
      const resets = (seenResult && Array.isArray(seenResult.pending_dedup_resets)) ? seenResult.pending_dedup_resets : [];
      if (resets.length > 0) {
        let totalCleared = 0;
        for (const r of resets) {
          const cust = String(r.customer || '');
          const src = String(r.source || '*');
          if (!cust) continue;
          const inner = globalThis.__notifiedDedupMap[cust];
          if (!inner) continue;
          const beforeCount = Object.keys(inner).length;
          if (src === '*') {
            // 顧客の全エントリを削除
            delete globalThis.__notifiedDedupMap[cust];
            totalCleared += beforeCount;
          } else {
            // ソース一致エントリのみ削除 (source未設定エントリは 'reins' とみなす)
            for (const k of Object.keys(inner)) {
              const entrySrc = (inner[k] && inner[k].source) ? String(inner[k].source) : 'reins';
              if (entrySrc === src) {
                delete inner[k];
                totalCleared++;
              }
            }
            if (Object.keys(inner).length === 0) delete globalThis.__notifiedDedupMap[cust];
          }
        }
        if (totalCleared > 0) {
          await chrome.storage.local.set({ notifiedDedupMap: globalThis.__notifiedDedupMap });
          await setStorageData({ debugLog: `[リセット連携] notifiedDedupMap から ${totalCleared} エントリを削除 (GASからの ${resets.length} リセット要求を処理)` });
        }
      }

      // GASのシートに存在しないdedupキーをnotifiedDedupMapから除去
      // (リセット後にpending_dedup_resetsのTTL切れ等でリセットが漏れた場合の安全策)
      const gasKeys = (seenResult && seenResult.seen_dedup_keys) || {};
      let orphanCleared = 0;
      for (const cust of Object.keys(globalThis.__notifiedDedupMap)) {
        const gasKeysForCust = new Set(gasKeys[cust] || []);
        if (gasKeysForCust.size === 0) continue; // GAS側にキーがない顧客はスキップ（全件消しすぎ防止）
        const inner = globalThis.__notifiedDedupMap[cust];
        for (const k of Object.keys(inner)) {
          // gas_syncソースのキーだけでなく、全ソースのキーを対象にGAS側と突合
          if (!gasKeysForCust.has(k)) {
            delete inner[k];
            orphanCleared++;
          }
        }
        if (Object.keys(inner).length === 0) delete globalThis.__notifiedDedupMap[cust];
      }
      if (orphanCleared > 0) {
        await chrome.storage.local.set({ notifiedDedupMap: globalThis.__notifiedDedupMap });
        await setStorageData({ debugLog: `[dedup整合] GASに存在しない ${orphanCleared} キーをnotifiedDedupMapから除去` });
      }

      await setStorageData({ debugLog: `既知物件ID取得完了` });
    } catch (err) {
      await setStorageData({ debugLog: `既知物件ID取得失敗（続行）: ${err.message}` });
    }

    const { notifyMode } = await getStorageData(['notifyMode']);

    // === 顧客ループを外側、サービスを内側に（両モード共通） ===
    let reinsTab = null;
    let reinsDelay = 2000;
    if (services.reins) {
      reinsTab = await findReinsTab();
      if (!reinsTab) {
        await setStorageData({ loginDetected: false, debugLog: 'REINSタブが見つかりません（REINS検索スキップ）' });
      } else {
        await setStorageData({ debugLog: `REINSタブ発見: tabId=${reinsTab.id}`, reinsAutomationTabId: reinsTab.id });
        const { pageDelaySeconds } = await getStorageData(['pageDelaySeconds']);
        reinsDelay = (pageDelaySeconds || 2) * 1000;
      }
    }
    let reinsFatalExit = false;

    for (let ci = 0; ci < criteria.length; ci++) {
      if (isSearchCancelled(searchId)) return;
      const customer = criteria[ci];
      await setStorageData({ debugLog: `━━ 顧客 ${ci+1}/${criteria.length}: ${customer.name} ━━` });

      // --- itandi ---
      if (services.itandi) {
        if (isSearchCancelled(searchId)) return;
        try { await runItandiSearch([customer], seenIds, searchId); }
        catch (err) { if (err.message === 'SEARCH_CANCELLED') return; logError('[itandi] 検索エラー: ' + err.message); }
      }

      // --- ES-Square (恒久停止: 2026-06-03 規約違反BANのため。services.essquare は上流で常にfalse) ---
      if (services.essquare) {
        if (isSearchCancelled(searchId)) return;
        try { await runEssquareSearch([customer], seenIds, searchId); }
        catch (err) { if (err.message === 'SEARCH_CANCELLED') return; logError('[ES-Square] 検索エラー: ' + err.message); }
      }

      // --- いえらぶ ---
      if (services.ielove) {
        if (isSearchCancelled(searchId)) return;
        try { await runIeloveSearch([customer], seenIds, searchId); }
        catch (err) { if (err.message === 'SEARCH_CANCELLED') return; logError('[いえらぶ] 検索エラー: ' + err.message); }
      }

      // --- REINS（他サイトで申込あり検出後に判定するため最後に実行） ---
      if (services.reins && reinsTab && !reinsFatalExit) {
        const cond = formatCustomerCriteria(customer);
        await setStorageData({ debugLog: `[REINS] ${customer.name} 条件: ${cond}` });
        try {
          const rwsRaw = customer.routes_with_stations || [];
          // 環状線（山手線・大江戸線）は1駅ずつ分割（From/To指定で逆回り駅が含まれるのを防止）
          const CIRCULAR_LINE_KEYWORDS = ['山手線', '大江戸線'];
          const rws = [];
          for (const r of rwsRaw) {
            const isCircular = CIRCULAR_LINE_KEYWORDS.some(kw => (r.route || '').includes(kw));
            if (isCircular && r.stations && r.stations.length > 1) {
              for (const st of r.stations) {
                rws.push({ route: r.route, stations: [st] });
              }
            } else {
              rws.push(r);
            }
          }
          const cities = customer.cities || [];
          const _rwsChunks = rws.length > 0
            ? Array.from({length: Math.ceil(rws.length/3)}, (_,i) => rws.slice(i*3, i*3+3))
            : [[]];
          const _cityChunks = cities.length > 0
            ? Array.from({length: Math.ceil(cities.length/3)}, (_,i) => cities.slice(i*3, i*3+3))
            : [[]];
          const _totalBatches = _rwsChunks.length * _cityChunks.length;
          if (_totalBatches === 1 && rws.length <= 3 && cities.length <= 3) {
            // 単一バッチで完結
            await searchForCustomer(reinsTab.id, customer, seenIds, reinsDelay, searchId);
          } else {
            let _batchIdx = 0;
            for (const rwsChunk of _rwsChunks) {
              for (const cityChunk of _cityChunks) {
                if (isSearchCancelled(searchId)) return;
                _batchIdx++;
                const batchCustomer = {
                  ...customer,
                  routes: rwsChunk.map(r => r.route),
                  routes_with_stations: rwsChunk,
                  cities: cityChunk,
                  _originalCustomer: customer,
                };
                await setStorageData({ debugLog: `[REINS] ${customer.name}: バッチ ${_batchIdx}/${_totalBatches} (路線${rwsChunk.length}件/市区町村${cityChunk.length}件)` });
                await searchForCustomer(reinsTab.id, batchCustomer, seenIds, reinsDelay, searchId);
                if (_batchIdx < _totalBatches) await sleep(3000);
              }
            }
          }
          // REINS検索成功 → 本日の日付をGASに記録（次回検索の登録年月日フィルタ起点になる）
          try {
            const _today = new Date();
            const _pad = n => String(n).padStart(2, '0');
            const _todayStr = _today.getFullYear() + '-' + _pad(_today.getMonth() + 1) + '-' + _pad(_today.getDate());
            // おすすめ条件(裏検索)の場合は recommend_id を付けて、本人条件と独立して日付記録する
            await gasPost({ action: 'update_reins_search_date', customer_name: customer.name, search_date: _todayStr, recommend_id: customer.recommendId || '' });
            const _recLabel = customer.recommend ? `（おすすめ:${customer.recommendLabel || ''}）` : '';
            await setStorageData({ debugLog: `[REINS] ${customer.name}${_recLabel}: 最終検索日を更新 → ${_todayStr}` });
          } catch (_e) {
            logError(`[REINS] ${customer.name}: 最終検索日更新失敗: ${_e.message}`);
          }
        } catch (err) {
          if (err.message === 'SEARCH_CANCELLED') return;
          if (err.message === 'SLEEP_DETECTED' || err.message === 'REINS_ERROR_PAGE') {
            await setStorageData({ debugLog: `[REINS] ${err.message}→REINS中止（他サービスは継続）` });
            reinsFatalExit = true;
          } else {
            logError(`[REINS] ${customer.name}の検索失敗: ${err.message}`);
          }
        }
      }

      // --- 一括モード: この顧客分だけ重複排除＆通知 ---
      if (notifyMode === 'batch') {
        try { await flushBatchBufferForCustomer(customer.name); }
        catch (err) { logError(`[system] ${customer.name}: 一括通知エラー: ${err.message}`); }
      }

      // 物件が見つからなかった顧客は _noResultCustomers に貯めて、
      // 巡回サイクル全体の終了時に1通のまとめ通知として送る（顧客ごと個別通知が煩わしいため）
      if (!discordPropertyCounters[customer.name] || discordPropertyCounters[customer.name] === 0) {
        try {
          if (!globalThis._noResultCustomers) globalThis._noResultCustomers = [];
          globalThis._noResultCustomers.push({ name: customer.name });
        } catch (err) {
          logError(`[system] ${customer.name}: 新着なし蓄積エラー: ${err.message}`);
        }
      }

      if (ci < criteria.length - 1) await sleep(3000);
    }

    if (services.reins && reinsTab) {
      await closeDedicatedWindow();
      await setStorageData({ debugLog: '[REINS] 検索完了', reinsAutomationTabId: null });
    }

    // === 未解決駅サマリー ===
    await reportUnresolvedStations();

    // === 新着なし顧客のまとめ通知（1通にまとめてメインチャンネルに投稿） ===
    try {
      await sendDiscordNoResultSummary();
    } catch (err) {
      logError('新着なしまとめ通知エラー: ' + err.message);
    }

    await setStorageData({ lastSearchTime: Date.now() });
  } catch (err) {
    logError('検索サイクルエラー: ' + err.message);
  } finally {
    clearInterval(globalKeepAlive);
    try { chrome.power && chrome.power.releaseKeepAwake && chrome.power.releaseKeepAwake(); } catch(e) {}
    // 中止時はタブを閉じない（テスト確認用にタブを残す）
    if (!isSearchCancelled(searchId)) {
      await closeDedicatedWindow();
      await closeDedicatedIeloveWindow();
      await closeDedicatedItandiWindow();
      await closeDedicatedEssquareWindow();
    }
    // ワンショット強制再取得リストを使い切ったのでクリア(中止でもクリア)
    globalThis._oneShotForceRefetchSet = new Set();
    try { await setStorageData({ oneShotForceRefetch: [] }); } catch (_) {}
    await setStorageData({ isSearching: false });

    // ── チェイン起動: 検索中に SUUMO巡回アラームが pending を立てていた場合、
    //    顧客検索完了直後にここで自動起動する ──
    try {
      const { suumoPatrolPending, suumoPatrolEnabled, businessStartHour, businessEndHour } =
        await getStorageData(['suumoPatrolPending', 'suumoPatrolEnabled', 'businessStartHour', 'businessEndHour']);
      if (suumoPatrolPending && suumoPatrolEnabled) {
        const startH = businessStartHour !== undefined ? businessStartHour : 10;
        const endH = businessEndHour !== undefined ? businessEndHour : 20;
        const hour = new Date().getHours();
        const inBusiness = hour >= startH && hour < endH;
        if (inBusiness) {
          // ペンディングをクリア (runSuumoPatrolCycle 内でもクリアされるが、二重起動防止のためここでも先にクリア)
          await setStorageData({
            suumoPatrolPending: false,
            debugLog: '[SUUMO巡回] 顧客検索完了 → ペンディングを検出、チェイン起動'
          });
          if (typeof runSuumoPatrolCycle === 'function') {
            runSuumoPatrolCycle();
          }
        } else {
          // 営業時間外: ペンディングはそのまま残し、次回アラームで処理させる
          await setStorageData({ debugLog: '[SUUMO巡回] チェイン候補だが営業時間外のため次回アラーム待ち' });
        }
      }
    } catch (chainErr) {
      console.warn('[SUUMO巡回] チェイン起動チェックでエラー:', chainErr.message);
    }
  }
}

// === 顧客ごとの検索 ===
async function searchForCustomer(tabId, customer, seenIds, delay, searchId) {
  // 中止チェック＋スリープ検知付きsleep
  const csleep = async (ms) => {
    const before = Date.now();
    await sleep(ms);
    const elapsed = Date.now() - before;
    // 要求時間の3倍以上かかった場合、PCスリープから復帰したと判断
    if (elapsed > Math.max(ms * 3, ms + 30000)) {
      await setStorageData({ debugLog: `${customer.name}: PCスリープ検知（${Math.round(elapsed/1000)}秒経過、要求${Math.round(ms/1000)}秒）→検索中断` });
      throw new Error('SLEEP_DETECTED');
    }
    if (isSearchCancelled(searchId)) throw new Error('SEARCH_CANCELLED');
  };

  await setStorageData({ debugLog: `検索開始: ${customer.name}` });
  const customerSeenIds = seenIds[customer.name] || [];

  // スキップ済み物件IDをロード（詳細ページ遷移を省略して高速化）
  const skipStorageKey = `reinsSkipped_${customer.name}`;
  const skipHashKey = `reinsSkipHash_${customer.name}`;
  const skipData = await getStorageData([skipStorageKey, skipHashKey]);
  const skippedMap = skipData[skipStorageKey] || {}; // { propertyNumber: { reason, ts } }

  // 条件別ハッシュで、変わった条件に関連するスキップのみリセット
  // ※ バッチ分割時は routes_with_stations/cities がサブセットになるため、
  //   元の全条件（_originalCustomer）をハッシュ対象にする
  const simpleHash = (s) => s.split('').reduce((h, c) => ((h << 5) - h + c.charCodeAt(0)) | 0, 0).toString(36);
  const prevHashes = skipData[skipHashKey] || {};
  const origCustomer = customer._originalCustomer || customer;
  const currentHashes = {
    structures: simpleHash(JSON.stringify(origCustomer.structures || [])),
    stations: simpleHash(JSON.stringify({ s: origCustomer.stations, r: origCustomer.routes_with_stations, w: origCustomer.walk })),
    layouts: simpleHash(JSON.stringify(origCustomer.layouts || [])),
    equipment: simpleHash(JSON.stringify(origCustomer.equipment || '')),
    building_age: simpleHash(JSON.stringify(origCustomer.building_age || '')),
  };
  const conditionToReasonPattern = {
    structures: /構造不一致|構造不明/,
    stations: /駅不一致|駅\/徒歩不一致|交通情報なし/,
    layouts: /間取り不一致/,
    equipment: /敷金|礼金|定期借家|ロフト/,
    building_age: /新築でない/,
  };
  for (const [category, hash] of Object.entries(currentHashes)) {
    if (prevHashes[category] && prevHashes[category] !== hash) {
      const pattern = conditionToReasonPattern[category];
      if (pattern) {
        for (const key of Object.keys(skippedMap)) {
          if (pattern.test(skippedMap[key].reason)) delete skippedMap[key];
        }
      }
    }
  }
  await setStorageData({ [skipHashKey]: currentHashes });
  let skippedMapDirty = false;

  // --- Step 1: 検索フォームの準備 ---
  // まずVueハイドレーション確保 + 検索フォームへルーティング
  // ※ refresh()はPromiseを返すがexecuteScriptでawaitするとハングするため、fire-and-forget
  await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: () => {
      const nuxt = window.$nuxt;
      if (!nuxt) return;
      if (nuxt.$route?.path !== '/main/BK/GBK001310') {
        nuxt.$router.push('/main/BK/GBK001310');
      }
      nuxt.refresh();
    }
  });
  // MutationObserverでフォーム描画完了を即座に検知（最大30秒）
  const formReady = await waitForDomReady(tabId, '.p-textbox-input', { timeout: 30000 });
  if (isSearchCancelled(searchId)) return;
  if (!formReady.found) {
    await setStorageData({ debugLog: `${customer.name}: 検索フォームが見つかりません` });
    return;
  }

  // --- Step 2: 条件セット（executeScript world:'MAIN'で直接実行） ---
  // ※ scriptタグ注入はCSPでブロックされるため、world:'MAIN'を使う
  const lineNameMap = await loadLineNameMap();
  const reinsCodeMap = await loadReinsCodeMap();
  const stationStr = buildStationString(customer);

  await setStorageData({ debugLog: `${customer.name}: stationStr="${stationStr}", rent_max=${customer.rent_max}` });

  // .p-textbox-input が描画されるまで待つ（最大15秒）
  let setResult;
  await waitForDomReady(tabId, '.p-textbox-input', { timeout: 15000 });

  // SW再起動直後でもbtModeを確実に拾うためストレージから直読み
  const __btModeFresh = await new Promise(res => chrome.storage.local.get(['btMode'], d => res(d.btMode || 'alert')));
  __btMode = __btModeFresh;
  const __criteriaArgs = [stationStr, { rent_max: customer.rent_max, layouts: customer.layouts || [], area_min: customer.area_min || '', building_age: customer.building_age || '', equipment: customer.equipment || '', stations: customer.stations || [], routes_with_stations: customer.routes_with_stations || [], walk: customer.walk || '', cities: customer.cities || [], prefecture: customer.prefecture || '東京都', _isSuumoPatrol: !!customer._isSuumoPatrol, daysWithin: (typeof customer.daysWithin === 'number' ? customer.daysWithin : null), selectedTowns: customer.selectedTowns || {}, lastReinsSearch: customer.lastReinsSearch || '' }, lineNameMap, reinsCodeMap, (customer.btMode || __btModeFresh)];
  // __reinsCriteriaFunc は reins-criteria-func.js で定義（グローバル）
  // ↓ 以前は以下にローカル関数定義があったが、reins-criteria-func.js に移動済み
  setResult = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: __reinsCriteriaFunc,
    args: __criteriaArgs
  });

  const setStatus = setResult?.[0]?.result;
  if (!setStatus?.success) {
    await setStorageData({ debugLog: `${customer.name}: 条件セットエラー: ${JSON.stringify(setStatus)}` });
    return;
  }
  // REINS未解決駅を蓄積
  if (setStatus.reinsUnresolved && setStatus.reinsUnresolved.length > 0) {
    for (const name of setStatus.reinsUnresolved) {
      addUnresolvedStation(customer.name, 'REINS', name);
    }
  }
  await setStorageData({ debugLog: `${customer.name}: 条件セット完了 ensn=[${setStatus.ensnDebug || '-'}] cities=[${(setStatus.reinsCitiesSet||[]).join(' ') || '-'}] rent=${setStatus.kkkuCnryuTo} mdrTyp=[${setStatus.mdrTyp}] rooms=${setStatus.mdrHysuFrom}-${setStatus.mdrHysuTo} area=${setStatus.snyuMnskFrom || '-'}~ age=${setStatus.buildingAge || '-'} walk=${customer.walk || '-'} shziki=${setStatus.shzikiFrom || '-'}~${setStatus.shzikiTo || '-'} equip=${setStatus.debugEquip}` });

  // Vueリアクティブ更新を待つ
  await csleep(500);

  // --- Step 3: 検索ボタンをDOMクリック（MAIN world） ---
  // Chromeのバックグラウンドタブスロットリング対策:
  // HTMLAudioElementで silent WAV をループ再生 → タブが「音声再生中」扱いになり throttle されない
  await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: () => {
      if (window.__reinsKeepAlive) return;
      try {
        // 1秒の無音wav (44.1kHz, mono, 16bit)
        const sampleRate = 44100;
        const numSamples = sampleRate;
        const buffer = new ArrayBuffer(44 + numSamples * 2);
        const view = new DataView(buffer);
        const writeString = (offset, str) => { for (let i=0;i<str.length;i++) view.setUint8(offset+i, str.charCodeAt(i)); };
        writeString(0, 'RIFF');
        view.setUint32(4, 36 + numSamples*2, true);
        writeString(8, 'WAVE');
        writeString(12, 'fmt ');
        view.setUint32(16, 16, true);
        view.setUint16(20, 1, true);
        view.setUint16(22, 1, true);
        view.setUint32(24, sampleRate, true);
        view.setUint32(28, sampleRate*2, true);
        view.setUint16(32, 2, true);
        view.setUint16(34, 16, true);
        writeString(36, 'data');
        view.setUint32(40, numSamples*2, true);
        // data は全て0（無音）
        const blob = new Blob([buffer], { type: 'audio/wav' });
        const url = URL.createObjectURL(blob);
        const audio = new Audio(url);
        audio.loop = true;
        audio.volume = 0.01;
        const playPromise = audio.play();
        if (playPromise) playPromise.catch(e => console.log('audio play failed:', e));
        window.__reinsKeepAlive = audio;
      } catch (e) { console.log('keepAlive err:', e); }
    }
  });
  await csleep(500);
  await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: () => {
      const btns = [...document.querySelectorAll('button')];
      const searchBtn = btns.find(b => b.textContent.trim() === '\u691c\u7d22'); // 検索
      if (searchBtn) searchBtn.click();
    }
  });
  await setStorageData({ debugLog: `${customer.name}: 検索ボタンクリック` });

  // --- Step 4: ダイアログ処理 + ページ遷移待ち ---
  // REINSはSPAのためURLではなくDOM内容で結果ページへの遷移を検出する
  // まずMutationObserverで結果ページまたはダイアログの出現を待つ
  let step4Done = false;
  for (let d = 0; d < 60; d++) {
    if (isSearchCancelled(searchId)) return;
    await csleep(1000);
    try {
      // DOM内容で結果ページ/ダイアログを検出
      const pageCheck = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => {
          const bodyText = document.body.textContent;
          const isResultPage = bodyText.includes('検索結果一覧');

          // ダイアログ検出
          const dialogs = document.querySelectorAll('[role="dialog"], .modal.show');
          for (const dialog of dialogs) {
            const text = dialog.textContent;
            if (text.includes('入力に誤り') || text.includes('権限')) return { type: 'error' };
            if (text.includes('該当') && (text.includes('ありません') || text.includes('０件') || text.includes('0件'))) {
              const okBtn = [...dialog.querySelectorAll('button')].find(b => b.textContent.trim() === 'OK');
              if (okBtn) { okBtn.click(); return { type: 'no_results' }; }
            }
            if (text.includes('500件') || text.includes('超えています')) {
              const okBtn = [...dialog.querySelectorAll('button')].find(b => b.textContent.trim() === 'OK');
              if (okBtn) { okBtn.click(); return { type: 'ok_clicked' }; }
            }
          }

          if (isResultPage) return { type: 'result_page' };
          return { type: 'waiting' };
        }
      });

      const status = pageCheck?.[0]?.result;
      if (!status) continue;

      if (status.type === 'result_page') {
        await setStorageData({ debugLog: `${customer.name}: 結果ページに遷移` });
        step4Done = true;
        break;
      }
      if (status.type === 'error') {
        const stationInfo = (setStatus.reinsSearchStations || []).map(s => `${s.line}: ${s.from}〜${s.to}`).join(', ');
        const msg = `${customer.name}: ⚠️ 検索エラー（バリデーション）駅名不一致の可能性あり [${stationInfo}]`;
        console.warn(`[REINS] ${msg}`);
        await setStorageData({ debugLog: msg });
        return;
      }
      if (status.type === 'no_results') {
        await setStorageData({ debugLog: `${customer.name}: 該当物件なし（0件）` });
        return;
      }
      if (status.type === 'ok_clicked') {
        await setStorageData({ debugLog: `${customer.name}: 500件超ダイアログOK` });
        // MutationObserverで結果ページ表示を待つ
        const okReady = await waitForDomReady(tabId, null, { textIncludes: '検索結果一覧', timeout: 40000 });
        step4Done = true;
        break;
      }
    } catch (err) {
      await setStorageData({ debugLog: `${customer.name}: ダイアログ${d+1}エラー: ${err.message}` });
    }
  }

  // --- Step 5: 検索結果のDOM描画待ち ---
  await setStorageData({ debugLog: `${customer.name}: 検索結果待ち...` });

  // DOM内容で結果ページか確認（URLはSPAのため信頼しない）
  if (!step4Done) {
    const resultCheck = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => document.body.textContent.includes('検索結果一覧')
    });
    if (!resultCheck?.[0]?.result) {
      await setStorageData({ debugLog: `${customer.name}: 結果ページに遷移していません` });
      return;
    }
  }

  // MutationObserverで検索結果の描画完了を待つ（行の出現 or 0件表示、最大30秒）
  let resultsReady = false;
  try {
    const rowsResult = await chrome.scripting.executeScript({
      target: { tabId },
      args: [30000],
      func: (timeoutMs) => {
        return new Promise((resolve) => {
          const check = () => {
            // 検索結果行が存在する → データあり
            if (document.querySelectorAll('.p-table-body-row').length > 0) return { type: 'rows' };
            // 結果ページだが行もチェックボックスもない → 0件
            const bodyText = document.body?.textContent || '';
            if (bodyText.includes('検索結果') && bodyText.length > 200
                && document.querySelectorAll('input[type="checkbox"]').length === 0
                && document.querySelectorAll('.p-table-body-row').length === 0) {
              // ページネーションリンクもない場合のみ0件と判定（描画途中を誤検知しない）
              if (document.querySelectorAll('.page-link').length === 0) return { type: 'zero' };
            }
            return null;
          };
          const result = check();
          if (result) { resolve(result); return; }
          const timer = setTimeout(() => { observer.disconnect(); resolve({ type: 'timeout' }); }, timeoutMs);
          const observer = new MutationObserver(() => {
            const result = check();
            if (result) {
              observer.disconnect();
              clearTimeout(timer);
              resolve(result);
            }
          });
          observer.observe(document.body || document.documentElement, { childList: true, subtree: true, characterData: true });
        });
      }
    });
    const r = rowsResult?.[0]?.result || { type: 'timeout' };
    if (r.type === 'rows') {
      resultsReady = true;
    } else if (r.type === 'zero') {
      await setStorageData({ debugLog: `${customer.name}: 検索結果0件` });
      return;
    }
  } catch (_) {}
  if (isSearchCancelled(searchId)) return;

  if (!resultsReady) {
    await setStorageData({ debugLog: `${customer.name}: 検索結果が表示されませんでした` });
    return;
  }

  globalThis.__incrementReinsUsage('search');
  await csleep(delay);
  await setStorageData({ debugLog: `${customer.name}: 検索結果ページ到達` });

  const { stats } = await getStorageData(['stats']);
  const currentStats = stats || { totalFound: 0, totalSubmitted: 0, errors: [], lastError: null };
  const newProperties = [];

  // --- Step 6〜7: ページネーションしながら検索結果を詳細取得（最大200件） ---
  const maxDetails = 70;
  let totalDetailCount = 0;
  let currentPage = 1;
  let consecutiveRecoveryFails = 0;
  let totalPages = 1;

  pageLoop: while (currentPage <= totalPages) {
    // 検索結果データ抽出（現在のページ）
    let searchResults = [];
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => {
          // ページ情報を取得
          const pageInfo = { totalPages: 1, currentPage: 1, totalItems: 0 };
          const pageLinks = document.querySelectorAll('.page-link');
          pageLinks.forEach(link => {
            const num = parseInt(link.textContent.trim(), 10);
            if (!isNaN(num)) {
              if (num > pageInfo.totalPages) pageInfo.totalPages = num;
              const li = link.closest('li');
              if (li && li.classList.contains('active')) pageInfo.currentPage = num;
            }
          });
          const pageText = document.body.textContent.match(/(\d+)～(\d+)件\s*／\s*(\d+)件/);
          if (pageText) {
            pageInfo.totalItems = parseInt(pageText[3], 10);
            // perPage は1ページ目の時のみ信頼可能（最終ページは表示件数が少ないため不正確）
            const from = parseInt(pageText[1], 10);
            const to = parseInt(pageText[2], 10);
            if (from === 1) {
              const perPage = to - from + 1;
              if (perPage > 0) {
                const calc = Math.ceil(pageInfo.totalItems / perPage);
                // page-link側の値と食い違う場合は小さい方を採用
                pageInfo.totalPages = Math.min(
                  pageInfo.totalPages > 1 ? pageInfo.totalPages : calc,
                  calc
                );
              }
            }
          }

          // 各行から物件情報を抽出
          const rows = document.querySelectorAll('.p-table-body-row');
          const data = [];
          rows.forEach((row, index) => {
            const items = row.querySelectorAll(':scope > .p-table-body-item');
            if (items.length < 23) return;
            const propertyNumber = (items[3]?.textContent.trim() || '').match(/\b(100\d{8,})\b/)?.[1] || '';
            data.push({
              index,
              propertyNumber,
              buildingName: items[11]?.textContent.trim() || '',      // 物件名
              floor: items[12]?.textContent.trim() || '',             // 階数
              rentText: items[8]?.textContent.trim() || '',           // 賃料（row2 col5）
              managementFeeText: items[15]?.textContent.trim() || '', // 管理費（row3 col5）
              commonFeeText: items[21]?.textContent.trim() || '',     // 共益費（row4 col5）
              depositGuarantee: items[16]?.textContent.trim() || '',  // 敷金／保証金
              keyMoneyRights: items[22]?.textContent.trim() || '',    // 礼金／権利金
              text: row.textContent.substring(0, 200)
            });
          });
          return { data, pageInfo };
        }
      });
      const extracted = results && results[0] && results[0].result;
      if (extracted) {
        searchResults = extracted.data || [];
        totalPages = extracted.pageInfo.totalPages;
        currentPage = extracted.pageInfo.currentPage;
      }
    } catch (err) {
      await setStorageData({ debugLog: `${customer.name}: 検索結果抽出失敗(p${currentPage}): ${err.message}` });
      break;
    }

    if (searchResults.length === 0) {
      if (currentPage === 1) {
        await setStorageData({ debugLog: `${customer.name}: 検索結果0件` });
      }
      break;
    }
    await setStorageData({ debugLog: `${customer.name}: ページ${currentPage}/${totalPages} ${searchResults.length}件の検索結果` });

    // 現在のページの全物件について詳細取得
    for (let i = 0; i < searchResults.length; i++) {
    if (totalDetailCount >= maxDetails) {
      await setStorageData({ debugLog: `${customer.name}: 詳細取得上限${maxDetails}件に到達` });
      break pageLoop;
    }
    const result = searchResults[i];
    if (!result.propertyNumber) continue;
    const isTest = customer.name.includes('テスト');
    // 強制再取得リストに含まれる物件番号は seen/skipped チェックをバイパス
    const isForced = !!(globalThis._oneShotForceRefetchSet && globalThis._oneShotForceRefetchSet.has(String(result.propertyNumber)));
    // room_idはハッシュ化済みなのでpropertyNumber単位で完全一致チェック
    const reinsRoomHash = await hashRoomId('reins', 'reins_' + result.propertyNumber);
    if (!isForced && !isTest && (
      customerSeenIds.includes(reinsRoomHash) ||
      customerSeenIds.some(id => id.includes(result.propertyNumber)) // 旧形式（生ID）互換
    )) {
      continue; // 既知物件はログなし（大量になるため）
    }
    if (isForced) {
      await setStorageData({ debugLog: `[強制再取得] ${customer.name}: ${result.propertyNumber} を強制再取得対象として処理` });
    }

    // スキップ済み物件チェック（前回フィルタで除外された物件は詳細ページに行かない）
    if (!isForced && !isTest && skippedMap[result.propertyNumber]) {
      continue; // スキップ済みはログなし（大量になるため）
    }

    // 一覧ページで敷金/礼金フィルタ（equipment条件に基づく）
    const toHankaku_ = (s) => s.replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));
    const equip = toHankaku_(customer.equipment || '').toLowerCase();
    const isNone = (s) => !s || s === '-' || s === 'なし' || s === 'なし/-' || s === '-/-' || s === 'なし/なし';
    const hasNoneInSlash = (s) => {
      const parts = (s || '').split('/').map(p => p.trim());
      return parts.every(p => !p || p === '-' || p === 'なし');
    };
    if (equip.includes('敷金なし')) {
      if (!hasNoneInSlash(result.depositGuarantee)) {
        await setStorageData({ debugLog: `${customer.name}: ✗ 一覧スキップ: ${result.buildingName} ${result.floor} - 敷金あり(${result.depositGuarantee})` });
        continue;
      }
    }
    if (equip.includes('礼金なし')) {
      const reikinPart = (result.keyMoneyRights || '').split('/')[0].trim();
      if (reikinPart && reikinPart !== '-' && reikinPart !== 'なし') {
        await setStorageData({ debugLog: `${customer.name}: ✗ 一覧スキップ: ${result.buildingName} ${result.floor} - 礼金あり(${result.keyMoneyRights})` });
        continue;
      }
    }

    // 一覧ページで賃料+管理費+共益費フィルタ（詳細を開く前にスキップ→高速化）
    if (customer.rent_max && result.rentText) {
      const parseYen_ = (s) => {
        if (!s) return 0;
        const n = s.replace(/[０-９．]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
                   .replace(/,/g, '');
        const m = n.match(/([\d.]+)/);
        if (!m) return 0;
        const v = parseFloat(m[1]);
        if (isNaN(v)) return 0;
        return n.includes('万') ? Math.round(v * 10000) : Math.round(v);
      };
      const rentYen_ = parseYen_(result.rentText);
      const mgmtYen_ = parseYen_(result.managementFeeText);
      const commonYen_ = parseYen_(result.commonFeeText);
      if (rentYen_ > 0) {
        const rentMaxYen_ = parseFloat(customer.rent_max) * 10000;
        const totalYen_ = rentYen_ + mgmtYen_ + commonYen_;
        if (totalYen_ > rentMaxYen_) {
          await setStorageData({ debugLog: `${customer.name}: ✗ 一覧スキップ: ${result.buildingName} ${result.floor} - 賃料+管理+共益超過 ${totalYen_}円(${result.rentText}+${result.managementFeeText||'0'}+${result.commonFeeText||'0'}) > ${rentMaxYen_}円` });
          continue;
        }
      }
    }

    totalDetailCount++;
    await setStorageData({ debugLog: `${customer.name}: p${currentPage}/${totalPages} 物件${totalDetailCount}/${maxDetails} 詳細取得中 (${result.buildingName} ${result.floor})` });

    try {
      // 詳細ボタンをクリック（物件番号で行を特定）— 行が描画されるまで最大15秒待つ
      // ダイアログ（連続閲覧警告等）が出ていればOKで閉じる
      let clickStatus = 'not_found';
      let triedRecovery = false;
      for (let waitTry = 0; waitTry < 30; waitTry++) {
        const cr = await chrome.scripting.executeScript({
          target: { tabId },
          func: (propNum, rowIndex) => {
            const dialogs = document.querySelectorAll('[role="dialog"], .modal.show');
            for (const dialog of dialogs) {
              const okBtn = [...dialog.querySelectorAll('button')].find(b => /OK|閉じる|はい/.test(b.textContent.trim()));
              if (okBtn) { okBtn.click(); return 'dialog_closed'; }
            }
            const rows = document.querySelectorAll('.p-table-body-row');
            if (rows.length === 0) return 'no_rows';
            // index で直接特定（同じ建物の連続物件でも確実）
            const row = rows[rowIndex];
            if (row && row.textContent.includes(propNum)) {
              const detailBtn = [...row.querySelectorAll('button')].find(b => b.textContent.trim() === '詳細');
              if (detailBtn) { detailBtn.click(); return 'clicked'; }
            }
            // index がズレた場合は物件番号で「最初に一致した未訪問行」をフォールバック検索
            // ただし末尾完全一致のみ許可（部分文字列誤マッチ防止）
            for (const r of rows) {
              const items = r.querySelectorAll(':scope > .p-table-body-item');
              const cellText = (items[3]?.textContent || '').trim();
              const m = cellText.match(/\b(100\d{8,})\b/);
              if (m && m[1] === propNum) {
                const detailBtn = [...r.querySelectorAll('button')].find(b => b.textContent.trim() === '詳細');
                if (detailBtn) { detailBtn.click(); return 'clicked_fallback'; }
              }
            }
            return 'not_found_in_' + rows.length + '_rows';
          },
          args: [result.propertyNumber, result.index]
        });
        clickStatus = cr?.[0]?.result || 'error';
        if (clickStatus === 'clicked') break;
        if (clickStatus === 'dialog_closed') { await csleep(500); continue; }
        // no_rows の最初の検出で詳細な状態をダンプ
        if (clickStatus === 'no_rows' && waitTry === 1) {
          try {
            const diag = await chrome.scripting.executeScript({
              target: { tabId },
              func: () => {
                const url = location.href;
                const title = document.title;
                const h = [...document.querySelectorAll('h1,h2,h3,[class*="header"]')].slice(0,5).map(e=>e.textContent.trim().slice(0,40)).filter(Boolean);
                const dialogs = [...document.querySelectorAll('[role="dialog"],.modal,.modal.show,.toast')].map(d=>d.textContent.trim().slice(0,80)).filter(Boolean);
                const selectors = {
                  'p-table-body-row': document.querySelectorAll('.p-table-body-row').length,
                  'body-row*': document.querySelectorAll('[class*="body-row"]').length,
                  'tbody tr': document.querySelectorAll('tbody tr').length,
                  '詳細btn': [...document.querySelectorAll('button')].filter(b=>b.textContent.trim()==='詳細').length,
                  'page-link': document.querySelectorAll('.page-link').length,
                  'spinner': document.querySelectorAll('[class*="spinner"],[class*="loading"]').length,
                };
                const bodyLen = document.body.textContent.length;
                const hasResultText = document.body.textContent.includes('検索結果一覧');
                const has0kenText = /該当.*0|０件|該当なし/.test(document.body.textContent);
                return { url, title, h, dialogs, selectors, bodyLen, hasResultText, has0kenText };
              }
            });
            const d = diag?.[0]?.result || {};
            await setStorageData({ debugLog: `${customer.name}: 🔍診断 url=${(d.url||'').slice(-50)} title=${(d.title||'').slice(0,30)} h=${JSON.stringify(d.h||[])} dialogs=${JSON.stringify(d.dialogs||[])} sel=${JSON.stringify(d.selectors||{})} bodyLen=${d.bodyLen} 結果一覧text=${d.hasResultText} 0件text=${d.has0kenText}` });
          } catch(e) {
            await setStorageData({ debugLog: `${customer.name}: 🔍診断失敗 ${e.message}` });
          }
        }
        // no_rowsが続く場合、検索フォームから再検索して復帰
        if (clickStatus === 'no_rows' && waitTry >= 6 && !triedRecovery) {
          triedRecovery = true;
          await setStorageData({ debugLog: `${customer.name}: 結果一覧が空→検索条件を再投入して復帰` });
          // 1) 検索フォームへ
          await chrome.scripting.executeScript({
            target: { tabId }, world: 'MAIN',
            func: () => {
              const nuxt = window.$nuxt;
              if (nuxt?.$router) { nuxt.$router.push('/main/BK/GBK001310'); return; }
              location.href = 'https://system.reins.jp/main/BK/GBK001310';
            }
          });
          // 2) 入力欄が描画されるまで待つ（MutationObserver）
          await waitForDomReady(tabId, '.p-textbox-input', { timeout: 30000 });
          // 3) 同じ条件設定関数を再実行
          await chrome.scripting.executeScript({
            target: { tabId }, world: 'MAIN',
            func: __reinsCriteriaFunc, args: __criteriaArgs
          });
          await csleep(500);
          // 4) 検索ボタンクリック
          await chrome.scripting.executeScript({
            target: { tabId }, world: 'MAIN',
            func: () => { const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim() === '検索'); if (b) b.click(); }
          });
          globalThis.__incrementReinsUsage('search');
          // 5) ダイアログ処理＆結果ページ待ち
          for (let rs = 0; rs < 50; rs++) {
            await csleep(1000);
            const rsCheck = await chrome.scripting.executeScript({
              target: { tabId },
              func: () => {
                const dialogs = document.querySelectorAll('[role="dialog"], .modal.show');
                for (const d of dialogs) {
                  if (d.textContent.includes('500件') || d.textContent.includes('超えて')) {
                    const ok = [...d.querySelectorAll('button')].find(b => b.textContent.trim() === 'OK');
                    if (ok) { ok.click(); return 'ok'; }
                  }
                }
                if (document.querySelectorAll('.p-table-body-row, [class*="body-row"]').length > 0) return 'rows';
                return 'wait';
              }
            });
            const s = rsCheck?.[0]?.result;
            if (s === 'rows') break;
            if (s === 'ok') {
              // 結果行の出現をMutationObserverで待つ
              await waitForDomReady(tabId, '.p-table-body-row', { timeout: 30000 });
              break;
            }
          }
          // 6) 現在ページまで進める
          if (currentPage > 1) {
            for (let np = 2; np <= currentPage; np++) {
              await chrome.scripting.executeScript({
                target: { tabId },
                func: (page) => {
                  const links = document.querySelectorAll('.page-link');
                  for (const l of links) if (l.textContent.trim() === String(page)) { l.click(); return; }
                },
                args: [np]
              });
              await waitForDomReady(tabId, '.p-table-body-row', { timeout: 15000 });
            }
          }
          continue;
        }
        await csleep(500);
      }
      if (clickStatus !== 'clicked') {
        await setStorageData({ debugLog: `${customer.name}: ✗ ${result.buildingName} ${result.floor} 詳細ボタンが見つからない(${clickStatus})→スキップ` });
        continue;
      }
      globalThis.__incrementReinsUsage('detail');
      // SPA遷移: 詳細ページのラベル要素出現で描画完了を検知
      await waitForDomReady(tabId, '.p-label-title', { timeout: 15000, minCount: 5 });

      // REINSエラーページ検知（E2171「不適切な画面操作」等）
      const tabInfo = await chrome.tabs.get(tabId);
      if (tabInfo.url && !tabInfo.url.includes('GBK00')) {
        // REINS内だがエラーページの可能性
        const [errCheck] = await chrome.scripting.executeScript({
          target: { tabId },
          func: () => document.body?.innerText?.includes('不適切な画面操作') || document.body?.innerText?.includes('エラー番号')
        });
        if (errCheck?.result) {
          await setStorageData({ debugLog: `${customer.name}: REINSエラーページ検知→検索中断` });
          throw new Error('REINS_ERROR_PAGE');
        }
      }

      // 詳細ページのVueコンポーネントがマウントされるまで待つ（MutationObserver、最大15秒）
      // 会員情報・広告転載区分など遅延描画セクションを含めるため minCount を増やす
      await waitForDomReady(tabId, '.p-label-title', { timeout: 15000, minCount: 20 });

      // 詳細データ抽出
      const detailResults = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => {
          const getVal = (label) => {
            const el = [...document.querySelectorAll('.p-label-title')].find(e => e.textContent.trim() === label);
            if (!el) return '';
            const container = el.closest('.p-label')?.parentElement;
            if (!container) return '';
            if (label === '部屋番号') return container.querySelector('.col-sm-4')?.textContent.trim() || '';
            // レスポンシブ重複(d-sm-none + d-none d-sm-inline 併存)を除外するテキスト取得
            const extractText = (el) => {
              if (!el) return '';
              const clone = el.cloneNode(true);
              clone.querySelectorAll('.d-sm-none').forEach(n => n.remove());
              const text = clone.textContent.trim();
              return text || el.textContent.trim();
            };
            // 値は内側の .row 直下の div（class="col" のことも "col-2" のこともある）
            const innerRow = container.querySelector(':scope > .row');
            if (innerRow) {
              const valEl = innerRow.querySelector(':scope > [class^="col"], :scope > [class*=" col"]');
              if (valEl) return extractText(valEl);
            }
            return extractText(container.querySelector('.row .col'));
          };

          const propertyNumber = getVal('物件番号');
          if (!propertyNumber) return null;

          const pref = getVal('都道府県名');
          const addr1 = getVal('所在地名１');
          const addr2 = getVal('所在地名２');
          const addr3 = getVal('所在地名３');
          const building = getVal('建物名');
          const roomNumber = getVal('部屋番号');
          // 部屋番号行の2つ目のcol-sm-4（角部屋等の属性テキスト）
          const roomAttr = (() => {
            const el = [...document.querySelectorAll('.p-label-title')].find(e => e.textContent.trim() === '部屋番号');
            const cols = el?.closest('.p-label')?.parentElement?.querySelectorAll('.col-sm-4');
            return cols && cols.length > 1 ? cols[1].textContent.trim() : '';
          })();
          const rentRaw = getVal('賃料');
          const parseFee = (s) => s ? parseFloat(s.replace(/[^\d.]/g, '')) || 0 : 0;
          const mgmtFeeVal = parseFee(getVal('管理費'));
          const kyoekiFeeVal = parseFee(getVal('共益費'));
          const totalMgmtFee = mgmtFeeVal + kyoekiFeeVal;
          const area = getVal('使用部分面積');
          const floorLoc = getVal('所在階');
          const floorAbove = getVal('地上階層');
          const structure = getVal('建物構造');
          const builtDate = getVal('築年月');

          // 交通情報（交通1〜3）を抽出
          const __transports = (() => {
            const list = [];
            const allLabels = [...document.querySelectorAll('.p-label-title')];
            const lineLabels = allLabels.filter(e => e.textContent.trim() === '沿線名');
            const stationLabels = allLabels.filter(e => e.textContent.trim() === '駅名');
            const walkLabels = allLabels.filter(e => {
              const t = e.textContent.trim();
              return t === '駅より徒歩' || t === '駅から徒歩' || t === '徒歩';
            });
            const getValFromLabel = (el) => {
              if (!el) return '';
              const container = el.closest('.p-label')?.parentElement;
              if (!container) return '';
              const innerRow = container.querySelector(':scope > .row');
              if (innerRow) {
                const valEl = innerRow.querySelector(':scope > [class^="col"], :scope > [class*=" col"]');
                if (valEl) return valEl.textContent.trim();
              }
              return container.querySelector('.row .col')?.textContent.trim() || '';
            };
            const normalizeWalk = (raw) => {
              if (!raw) return '';
              const s = String(raw).replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));
              const m = s.match(/(\d+)/);
              if (!m) return '';
              return `徒歩${m[1]}分`;
            };
            const count = Math.max(lineLabels.length, stationLabels.length, walkLabels.length);
            for (let t = 0; t < count; t++) {
              const line = getValFromLabel(lineLabels[t]);
              const station = getValFromLabel(stationLabels[t]);
              const walk = normalizeWalk(getValFromLabel(walkLabels[t]));
              if (line || station) {
                let info = [line, station].filter(Boolean).join(' ');
                if (walk) info += ' ' + walk;
                list.push(info);
              }
            }
            if (list.length === 0) {
              const fallbackWalk = normalizeWalk(getVal('駅から徒歩') || getVal('駅より徒歩') || getVal('徒歩'));
              const base = [getVal('沿線名'), getVal('駅名')].filter(Boolean).join(' ');
              const single = base + (fallbackWalk ? ' ' + fallbackWalk : '');
              if (single.trim()) list.push(single);
            }
            return list;
          })();

          return {
            building_id: 'reins_' + propertyNumber,
            room_id: 'reins_' + propertyNumber + '_' + (roomNumber || 'no_room'),
            building_name: building || '',
            address: [pref, addr1, addr2, addr3].filter(Boolean).join(''),
            rent: rentRaw ? parseFloat(rentRaw.replace(/[^\d.]/g, '')) * (rentRaw.includes('万') ? 10000 : 1) : 0,
            management_fee: totalMgmtFee,
            layout: (() => {
              const t = (getVal('間取タイプ') || '').trim();
              const r = (getVal('間取部屋数') || '').replace(/[^\d]/g, '');
              if (t === 'ワンルーム' || t === '1R') return 'ワンルーム';
              if (r && t) return `${r}${t}`;
              return t;
            })(),
            area: parseFloat((area || '').replace(/[^\d.]/g, '')) || 0,
            floor: parseInt((floorLoc || '').match(/\d+/)?.[0] || '0'),
            floor_text: floorLoc || '',
            story_text: (() => {
              const fb = (getVal('地下階層') || '').replace(/[^\d]/g, '');
              const fa = (floorAbove || '').replace(/[^\d]/g, '');
              let s = '';
              if (fa) s += '地上' + fa + '階';
              if (fb && fb !== '0') s += '地下' + fb + '階';
              return s ? s + '建' : '';
            })(),
            structure: (() => {
              if (!structure) return '';
              // REINS詳細ページの構造値を正規化（全角→半角、日本語名→標準名）
              const hankaku = structure.replace(/[Ａ-Ｚａ-ｚ]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0)).trim();
              // まずコード→日本語名（英字コードの場合）
              const codeMap = {
                'RC': '鉄筋コンクリート', 'SRC': '鉄骨鉄筋コンクリート',
                'S': '鉄骨造', 'W': '木造', 'LS': '軽量鉄骨造',
                'ALC': 'ALC造', 'PC': 'プレキャストコンクリート',
                'HPC': '鉄骨プレキャストコンクリート', 'CB': 'コンクリートブロック'
              };
              const alphaKey = hankaku.replace(/[造\s]/g, '').toUpperCase();
              if (codeMap[alphaKey]) return codeMap[alphaKey];
              // 日本語名の場合もマッピング（REINSドロップダウン: 鉄骨造, 木造, 軽量鉄骨, ブロック 等）
              const jpMap = {
                '鉄骨造': '鉄骨造', '鉄骨': '鉄骨造',
                '木造': '木造', '木': '木造',
                '軽量鉄骨造': '軽量鉄骨造', '軽量鉄骨': '軽量鉄骨造',
                'ブロック': 'コンクリートブロック',
                'その他': 'その他'
              };
              return jpMap[hankaku] || jpMap[hankaku.replace(/造/g, '')] || structure;
            })(),
            building_age: (() => {
              if (!builtDate) return '';
              // 西暦を抽出
              let builtYear = null;
              const wm = builtDate.match(/(\d{4})\s*年/);
              if (wm) builtYear = parseInt(wm[1]);
              else {
                const em = builtDate.match(/(令和|平成|昭和)\s*(\d+)\s*年/);
                if (em) {
                  const y = parseInt(em[2]);
                  if (em[1] === '令和') builtYear = 2018 + y;
                  else if (em[1] === '平成') builtYear = 1988 + y;
                  else if (em[1] === '昭和') builtYear = 1925 + y;
                }
              }
              if (!builtYear) return builtDate;
              const age = new Date().getFullYear() - builtYear;
              return `築${age}年`;
            })(),
            station_info: __transports[0] || '',
            other_stations: __transports.slice(1),
            room_number: roomNumber || '',
            room_attr: roomAttr || '',
            deposit: getVal('敷金') || '',
            key_money: getVal('礼金') || '',
            facilities: getVal('設備・条件・住宅性能等') || '',
            sunlight: getVal('バルコニー方向') || '',
            lease_type: getVal('建物賃貸借区分') || '',
            // 契約期間: 「契約期間」ラベル優先。無ければ「建物賃貸借期間」(定期借家の場合こちら)
            contract_period: getVal('契約期間') || getVal('建物賃貸借期間') || '',
            // 広告転載区分: 「広告可」→'可'、「不可」→'不可'、「広告可（但し要連絡）」→'要連絡'
            ad_keisai: (() => {
              const adReprint = getVal('広告転載区分') || '';
              if (!adReprint) return '';
              if (adReprint === '広告可') return '可';
              if (adReprint === '不可') return '不可';
              if (adReprint.includes('要連絡')) return '要連絡';
              return adReprint;
            })(),
            ad_reprint_raw: getVal('広告転載区分') || '',
            move_in_date: (() => {
              // 「入居年月」は col-4 と col-8 に分かれている（例: "令和 8年 4月" + "中旬"）
              const allLabels = [...document.querySelectorAll('.p-label-title')];
              const nengetsuLabel = allLabels.find(e => e.textContent.trim() === '入居年月');
              if (nengetsuLabel) {
                const container = nengetsuLabel.closest('.p-label')?.parentElement;
                if (container) {
                  const row = container.querySelector('.row');
                  if (row) {
                    const cols = [...row.querySelectorAll('[class*="col"]')];
                    const fullText = cols.map(c => c.textContent.trim()).filter(Boolean).join(' ');
                    if (fullText) {
                      // 和暦→西暦変換
                      const wm = fullText.match(/(?:令和|平成|昭和)\s*(\d{1,2})\s*年\s*(\d{1,2})\s*月\s*(上旬|中旬|下旬)?/);
                      if (wm) {
                        const eraYear = parseInt(wm[1]);
                        let seireki;
                        if (fullText.includes('令和')) seireki = 2018 + eraYear;
                        else if (fullText.includes('平成')) seireki = 1988 + eraYear;
                        else if (fullText.includes('昭和')) seireki = 1925 + eraYear;
                        if (seireki) return `${seireki}年${parseInt(wm[2])}月${wm[3] || ''}`;
                      }
                      return fullText;
                    }
                  }
                }
              }
              // フォールバック: 入居時期（「即時」「相談」等）
              const jikiVal = getVal('入居時期');
              if (jikiVal && jikiVal !== '予定') {
                if (jikiVal === '即時' || jikiVal === '即入居') return '即入居可';
                return jikiVal;
              }
              return getVal('入居可能時期') || getVal('引渡可能時期') || '';
            })(),
            total_units: getVal('[賃貸]棟総戸数') || getVal('総戸数') || '',
            shinchiku_flag: getVal('新築フラグ') || '',
            reins_property_number: propertyNumber,
            reins_shougo: getVal('商号') || '',
            // 代表電話番号(会員情報セクション)優先、無ければ旧「電話番号」ラベル
            reins_tel: getVal('代表電話番号') || getVal('電話番号') || '',
            // SUUMO承認画面/Discord通知で使う元付フィールド（reins_shougo/telのエイリアス）
            owner_company: getVal('商号') || '',
            owner_phone: getVal('代表電話番号') || getVal('電話番号') || '',
            // === 第1弾追加フィールド ===
            // 単価
            sqm_price: getVal('㎡単価') || '',
            tsubo_price: getVal('坪単価') || '',
            // 賃貸借契約詳細
            lease_period: getVal('建物賃貸借期間') || '',
            lease_renewal: getVal('建物賃貸借更新') || '',
            // 保証金・権利金・償却
            guarantee_money: getVal('保証金') || '',
            key_premium: getVal('権利金') || '',
            shoukyaku_code: getVal('償却コード') || '',
            shoukyaku_months: getVal('償却月数') || '',
            shoukyaku_rate: getVal('償却率') || '',
            // 更新
            renewal_type: getVal('更新区分') || '',
            renewal_fee: getVal('更新料') || '',
            // その他一時金・月額費
            other_onetime_fee: (() => {
              const parts = [];
              const n1 = getVal('その他一時金名称１'); const a1 = getVal('金額１');
              const n2 = getVal('その他一時金名称２'); const a2 = getVal('金額２');
              if (n1 && a1) parts.push(n1 + ': ' + a1);
              if (n2 && a2) parts.push(n2 + ': ' + a2);
              return parts.join(', ');
            })(),
            other_monthly_fee: (() => {
              const n = getVal('その他月額費名称'); const a = getVal('その他月額費金額');
              return (n && a) ? (n + ': ' + a) : '';
            })(),
            // 鍵交換
            key_exchange_type: getVal('鍵交換区分') || '',
            key_exchange_fee: getVal('鍵交換代金') || '',
            // 報酬
            commission_type: getVal('報酬形態') || '',
            commission: getVal('報酬') || '',
            ad_fee: (() => {
              // 「報酬」ラベル完全一致を最優先、ダメなら 報酬額/報酬(税抜) 等を探す
              let v = getVal('報酬');
              if (v) return v;
              const labels = [...document.querySelectorAll('.p-label-title')];
              const target = labels.find(e => {
                const t = e.textContent.trim();
                return /^報酬/.test(t) && !/形態|割合/.test(t);
              });
              if (!target) return '';
              const container = target.closest('.p-label')?.parentElement;
              if (!container) return '';
              // 直近の .row .col を取得（col-sm-6 配下の最初の .row > .col）
              const col = container.querySelector(':scope > .row .col, .row .col');
              return col?.textContent.trim() || '';
            })(),
            commission_landlord: getVal('負担割合貸主') || '',
            commission_tenant: getVal('負担割合借主') || '',
            commission_motozuke: getVal('配分割合元付') || '',
            commission_kyakuzuke: getVal('配分割合客付') || '',
            // 現況
            current_status: getVal('現況') || '',
            // バルコニー面積
            balcony_area: getVal('バルコニー(テラス)面積') || '',
            // 室1〜5
            rooms_detail: (() => {
              const rooms = [];
              for (let i = 1; i <= 5; i++) {
                const fl = getVal(`室${i}:所在階`);
                const tp = getVal(`室${i}:室タイプ`);
                const sz = getVal(`室${i}:室広さ`);
                if (fl || tp || sz) rooms.push([fl, tp, sz].filter(Boolean).join(' '));
              }
              return rooms.join(' / ');
            })(),
            // 駐車場
            parking_available: getVal('駐車場在否') || '',
            parking_fee: getVal('駐車場月額') || '',
            parking_fee_min: getVal('駐車場月額(最低値)') || '',
            parking_fee_max: getVal('駐車場月額(最高値)') || '',
            // 火災保険
            insurance_required: getVal('保険加入義務') || '',
            insurance_name: getVal('保険名称') || '',
            insurance_fee: getVal('保険料') || '',
            insurance_period: getVal('保険期間') || '',
            // 備考
            remarks: (() => {
              const parts = [];
              for (let i = 1; i <= 4; i++) {
                const v = getVal('備考' + i);
                if (v) parts.push(v);
              }
              return parts.join('\n');
            })(),
            source: 'reins'
          };
        }
      });

      const detail = detailResults && detailResults[0] && detailResults[0].result;
      if (detail) {
        // room_idをハッシュ化（propertyNumberベース・顧客向けURLでソース非表示）
        detail._raw_room_id = detail.room_id;
        detail.room_id = await hashRoomId('reins', 'reins_' + (detail.reins_property_number || ''));
      }
      // フィルタ先行判定: スキップする物件では画像取得を行わない
      let __rejectReason = null;
      if (detail) {
        __rejectReason = getFilterRejectReason(detail, customer);
      }

      // 通知済み重複(30日)の先行チェック - 顧客向け検索のみ
      // notifiedDedupMap で過去30日以内に通知済みの物件は、ここで弾いて画像取得を省略する。
      // (REINSの画像取得は fetch + base64変換で重いため効果大)
      if (detail && !__rejectReason && !globalThis._suumoPatrolMode &&
          typeof globalThis.__hasNotifiedDedupKey === 'function' &&
          globalThis.__hasNotifiedDedupKey(customer.name, detail)) {
        const info = (typeof globalThis.__getNotifiedDedupInfo === 'function')
          ? (globalThis.__getNotifiedDedupInfo(customer.name, detail) || {})
          : {};
        const sourceTag = info.source ? ` (元: ${info.source})` : '';
        __rejectReason = `30日以内に同物件通知済${sourceTag}(画像取得前に判定)`;
      }

      // 元付会社名キーワードによる早期スキップ(SUUMO巡回モードのみ)
      // 競合数取得や画像base64取得より前に判定して無駄な処理を省略
      if (detail && !__rejectReason &&
          globalThis._suumoPatrolMode &&
          typeof globalThis.checkSuumoOwnerKeywordSkip === 'function') {
        try {
          const ownerSkip = await globalThis.checkSuumoOwnerKeywordSkip(detail);
          if (ownerSkip.skip) {
            // __rejectReason を立てるのみ(下流の最終判定でログ集約)
            __rejectReason = ownerSkip.reason;
          }
        } catch (e) {
          console.warn('[REINS] 元付キーワード判定エラー:', e && e.message);
        }
      }

      // SUUMO巡回モード: 画像base64取得前にSUUMO競合数をチェック
      // (REINSの画像取得は fetch + blob→base64 変換で重いため効果大)
      if (detail && !__rejectReason &&
          globalThis._suumoPatrolMode &&
          typeof globalThis.checkSuumoCompetitorPreSkip === 'function') {
        try {
          const preResult = await globalThis.checkSuumoCompetitorPreSkip(detail);
          if (preResult.competitor) {
            detail.suumo_competitor = preResult.competitor;
          }
          if (preResult.skip) {
            // __rejectReason を立てるのみ。スキップログは下流の最終判定箇所(line ~3001)で
            // 一括出力されるため、ここでログを出すと重複してしまう。
            __rejectReason = `${preResult.reason}(画像取得前に判定)`;
          }
        } catch (e) {
          console.warn('[REINS] 競合先行判定エラー:', e && e.message);
        }
      }

      // === 画像をbase64で抽出（$nuxt walk → bkknGzuList 直読み方式） ===
      // フィルタでスキップされる物件は画像取得スキップ
      let imageBase64s = [];
      if (detail && !__rejectReason) {
        const imageResults = await Promise.race([
          chrome.scripting.executeScript({
          target: { tabId },
          world: 'MAIN',
          func: async () => {
            async function fetchAsBase64(url) {
              try {
                const r = await fetch(url, { credentials: 'include' });
                if (!r.ok) return null;
                const blob = await r.blob();
                if (!blob || blob.size < 1000) return null;
                return await new Promise((resolve, reject) => {
                  const reader = new FileReader();
                  reader.onloadend = () => resolve(reader.result);
                  reader.onerror = reject;
                  reader.readAsDataURL(blob);
                });
              } catch (e) { return null; }
            }
            const sleep = (ms) => new Promise(r => setTimeout(r, ms));
            const images = [];
            // Vueツリーから bkknGzuList を探索
            const findList = () => {
              const walk = (c, d = 0) => {
                if (d > 10 || !c) return null;
                if (c.$data && Array.isArray(c.$data.bkknGzuList) && c.$data.bkknGzuList.length > 0) {
                  return c.$data.bkknGzuList;
                }
                const children = c.$children || [];
                for (const ch of children) {
                  const r = walk(ch, d + 1);
                  if (r) return r;
                }
                return null;
              };
              return walk(window.$nuxt);
            };
            // Vue マウント待ち（最大5秒）
            let list = null;
            for (let i = 0; i < 25; i++) {
              list = findList();
              if (list && list.length > 0) break;
              await sleep(200);
            }
            if (!list || list.length === 0) return images;
            // gzuBngu 昇順でソート
            const sorted = [...list].sort((a, b) => {
              const an = parseInt(a.gzuBngu, 10) || 0;
              const bn = parseInt(b.gzuBngu, 10) || 0;
              return an - bn;
            });
            for (const item of sorted) {
              let url = item.bkknGzuSrc;
              if (!url) continue;
              if (url.startsWith('/')) url = location.origin + url;
              try {
                const base64 = await fetchAsBase64(url);
                if (base64) images.push(base64);
              } catch (e) {}
            }
            return images;
          }
        }),
          new Promise((resolve) => setTimeout(() => resolve(null), 120000))
        ]);
        const imgResult = (imageResults && imageResults[0] && imageResults[0].result) || {};
        imageBase64s = Array.isArray(imgResult) ? imgResult : (imgResult.images || []);
        await setStorageData({ debugLog: `${customer.name}: REINS画像 base64取得=${imageBase64s.length}件` });
      }
      if (!detail) {
        try {
          const t = await chrome.tabs.get(tabId);
          const dump = await chrome.scripting.executeScript({
            target: { tabId },
            func: () => ({
              h: [...document.querySelectorAll('h1,h2,h3')].map(e=>e.textContent.trim()).slice(0,4),
              labels: [...document.querySelectorAll('.p-label-title')].length,
              modals: document.querySelectorAll('.modal.show, .image-view').length,
              thumbs: document.querySelectorAll('div.mx-auto').length
            })
          });
          await setStorageData({ debugLog: `${customer.name}: detail=null url=${t.url?.substring(0,80)} ${JSON.stringify(dump?.[0]?.result || {})}` });
        } catch(e) {}
      }

      // === 画像base64をcatboxへアップロード（並列6 + 429指数バックオフ + 3回リトライ） ===
      if (detail && imageBase64s.length > 0) {
        try {
          const uploadedUrls = [];
          let uploadFailed = 0;
          const uploadErrors = [];
          // 成功ホストの統計 (どのホストで救われたかをログに残す)
          const viaStats = {};
          async function uploadOne(b64) {
            const MAX_ATTEMPTS = 3;
            let lastErr = null;
            for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
              try {
                // 保険として 60秒の絶対タイムアウトを設ける
                // (uploadBase64ToCatbox 内の各ホストはそれぞれ 20秒だが、想定外のハングに備える)
                const publicUrl = await Promise.race([
                  uploadBase64ToCatbox(b64),
                  new Promise((_, reject) => setTimeout(
                    () => reject(new Error('upload_overall_timeout_60s')), 60000
                  ))
                ]);
                if (publicUrl) {
                  // 成功 - どのホストで救われたか集計
                  const via = globalThis.__lastImageUploadVia || '?';
                  viaStats[via] = (viaStats[via] || 0) + 1;
                  return publicUrl;
                }
                lastErr = 'null_response';
                if (attempt < MAX_ATTEMPTS - 1) await csleep(1000);
              } catch (e) {
                lastErr = (e && e.message) || String(e);
                if (attempt >= MAX_ATTEMPTS - 1) {
                  uploadErrors.push(`b64size=${b64?.length || 0} err=${lastErr}`);
                  return null;
                }
                if (e && e.rateLimited) {
                  const wait = 2000 * Math.pow(2, attempt) + Math.floor(Math.random() * 500);
                  await csleep(wait);
                } else {
                  await csleep(1000);
                }
              }
            }
            if (lastErr) uploadErrors.push(`b64size=${b64?.length || 0} err=${lastErr}`);
            return null;
          }
          const BATCH = 6;
          for (let i = 0; i < imageBase64s.length; i += BATCH) {
            const chunk = imageBase64s.slice(i, i + BATCH);
            const results = await Promise.all(chunk.map(uploadOne));
            for (const r of results) {
              if (r) uploadedUrls.push(r);
              else uploadFailed++;
            }
          }
          if (uploadedUrls.length > 0) {
            detail.image_urls = uploadedUrls;
            detail.image_url = uploadedUrls[0];
          }
          const errSample = uploadErrors.length > 0 ? ` [${uploadErrors.slice(0,2).join(' | ')}]` : '';
          // どのホストで成功したかの内訳 (例: via=imgbb:8,0x0:2)
          const viaSummary = Object.keys(viaStats).length > 0
            ? ' via=' + Object.entries(viaStats).map(([k, v]) => `${k}:${v}`).join(',')
            : '';
          await setStorageData({ debugLog: `${customer.name}: REINS画像アップロード完了 ${uploadedUrls.length}/${imageBase64s.length}件${uploadFailed > 0 ? ` (失敗:${uploadFailed})` : ''}${viaSummary}${errSample}` });
        } catch (upErr) {
          logError(`${customer.name}: REINS画像アップロード失敗: ${upErr.message}`);
        }
      }

      if (detail) {
        const rejectReason = __rejectReason;
        if (!rejectReason) {
          // 入居時期厳守チェック（送信対象ログの前に判定）
          const strictSkipReason = shouldMoveInStrictSkip(detail, customer);
          if (customer && customer.move_in_strict) {
            await setStorageData({ debugLog: `[入居DIAG][REINS] ${customer.name}${customer.recommend?'(おすすめ:'+(customer.recommendLabel||'')+')':''} 希望=${customer.move_in_date||'(空)'} 物件=${detail.move_in_date||'(空)'} → ${strictSkipReason?'スキップ':'通過'}` });
          }
          if (strictSkipReason) {
            await setStorageData({ debugLog: `${customer.name}: [入居時期厳守] スキップ: ${detail.building_name || ''} ${detail.room_number || ''} - ${strictSkipReason}` });
          } else {
          newProperties.push(detail);
          currentStats.totalFound++;
          await setStorageData({ debugLog: `${customer.name}: ✓ 送信対象（${detail.building_name} ${detail.room_number || ''} ${detail.floor_text} ${detail.rent ? (detail.rent/10000)+'万' : ''}）${globalThis.__formatPropSkipUrl(detail)}` });
          // 警告アラート計算 (承認プレビューでも表示するため、GAS送信前に計算)
          // [DIAG] 診断ログ: 警告計算の入力と出力を debugLog に出す
          try {
            const _equipType = Array.isArray(customer?.equipment) ? 'array' : typeof customer?.equipment;
            const _equipSample = Array.isArray(customer?.equipment)
              ? customer.equipment.slice(0, 3).join(',')
              : String(customer?.equipment || '').substring(0, 60);
            const _w = (typeof globalThis.__computePropertyWarnings === 'function')
              ? globalThis.__computePropertyWarnings(detail, customer) : [];
            detail.warnings_text = (_w || []).join('\n');
            await setStorageData({ debugLog: `[WARN-DIAG] REINS ${customer.name}: equipType=${_equipType} equip=${_equipSample} warnings=${_w.length}件 text="${(detail.warnings_text||'').substring(0,80)}"` });
          } catch (eW) {
            detail.warnings_text = '';
            await setStorageData({ debugLog: `[WARN-DIAG] REINS ${customer.name}: ERROR ${eW.message}` });
          }
          // リアルタイムでGAS送信＋Discord通知
          let __reinsSubmitAdded = 0;
          try {
            const submitResult = await submitProperties(customer.name, [detail]);
            if (submitResult?.success) {
              __reinsSubmitAdded = submitResult.added || 0;
              currentStats.totalSubmitted += __reinsSubmitAdded;
            }
          } catch (err) {
            logError(`${customer.name}: ${detail.building_name} ${detail.room_number || ''} GAS送信失敗: ${err.message}`);
          }
          // GAS側で既存sent行を更新しただけ(added=0)の場合は通知をスキップ
          // (履歴リセット後にseenIds/notifiedDedupMapの隙間を通過した重複を防止)
          if (__reinsSubmitAdded > 0) {
            try {
              await deliverProperty(customer.name, detail, customer, 'reins');
            } catch (err) {
              logError(`${customer.name}: ${detail.building_name} ${detail.room_number || ''} Discord通知失敗: ${err.message}`);
            }
          } else {
            await setStorageData({ debugLog: `${customer.name}: ⚡ GAS既存物件のため通知スキップ: ${detail.building_name} ${detail.room_number || ''}` });
          }
          await setStorageData({ stats: currentStats });
          } // end strictSkip else
        } else {
          await setStorageData({ debugLog: `${customer.name}: ✗ スキップ: ${detail.building_name} ${detail.room_number || ''} - ${rejectReason}${globalThis.__formatPropSkipUrlWithReason(detail, rejectReason)}` });
          // スキップ済みとして記録（次回以降、詳細ページ遷移を省略）
          if (detail.reins_property_number) {
            skippedMap[detail.reins_property_number] = { reason: rejectReason, ts: Date.now() };
            skippedMapDirty = true;
          }
        }
      }

      await setStorageData({ debugLog: `${customer.name}: 一覧に戻り中...` });
      // 残留モーダルを閉じる
      await chrome.scripting.executeScript({
        target: { tabId }, world: 'MAIN',
        func: () => {
          for (let i = 0; i < 3; i++) {
            const m = document.querySelector('.modal.show, .image-view');
            if (!m) break;
            const cb = document.querySelector('.modal.show .btn.btn-outline, .modal.show .close, .modal .btn.btn-outline');
            if (cb) cb.click();
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true }));
          }
        }
      });
      await csleep(500);
      // 検索結果に戻る
      await chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        func: () => {
          // ① UI上の戻るボタン優先
          const backBtn = document.querySelector('.p-btn-back')
            || [...document.querySelectorAll('button')].find(el => /^(←|戻る|検索結果に戻る)/.test(el.textContent.trim()));
          if (backBtn) { backBtn.click(); return 'backBtn'; }
          // ② Vue Router
          const nuxt = window.$nuxt;
          if (nuxt?.$router) { nuxt.$router.back(); return 'router'; }
          history.back();
          return 'history';
        }
      });
      // 検索結果一覧(GBK002200)に戻るまで待つ
      let backSuccess = false;
      for (let bw = 0; bw < 20; bw++) {
        await csleep(500);
        const bt = await chrome.tabs.get(tabId);
        await setStorageData({ debugLog: `${customer.name}: 戻り待機 ${bw+1}/10 url=${(bt.url||'').slice(-40)}` });
        // 3秒（6回）以降でまだ詳細ページなら強制的に戻る操作を再度打つ
        if (bw >= 6 && bt.url?.includes('GBK003200')) {
          await chrome.scripting.executeScript({
            target: { tabId }, world: 'MAIN',
            func: () => {
              const backBtn = document.querySelector('.p-btn-back')
                || [...document.querySelectorAll('button')].find(el => /^(←|戻る|検索結果に戻る)/.test(el.textContent.trim()));
              if (backBtn) { backBtn.click(); return; }
              const nuxt = window.$nuxt;
              if (nuxt?.$router) nuxt.$router.back();
            }
          });
        }
        if (bt.url?.includes('GBK002200')) {
          // URLだけでなく、結果一覧の行が実際に描画されているか確認
          const rowsCheck = await chrome.scripting.executeScript({
            target: { tabId },
            func: () => document.querySelectorAll('.p-table-body-row').length
          });
          const rowCount = rowsCheck?.[0]?.result || 0;
          if (rowCount > 0) { backSuccess = true; break; }
          // rows=0 が12回（6秒）続いたら検索フォームに戻して再検索で強制リフレッシュ
          if (bw >= 12) {
            await setStorageData({ debugLog: `${customer.name}: 結果0件→検索フォームへ強制遷移` });
            await chrome.tabs.update(tabId, { url: 'https://system.reins.jp/main/BK/GBK001310' });
            await csleep(3000);
          }
          continue;
        }
        // 検索フォーム(GBK001310)に戻ってしまった場合 → 再検索して結果ページに復帰
        if (bt.url?.includes('GBK001310')) {
          await setStorageData({ debugLog: `${customer.name}: 検索フォームに戻った→再検索で復帰試行` });
          // 検索ボタンをクリック（条件はまだセットされている）
          await chrome.scripting.executeScript({
            target: { tabId },
            world: 'MAIN',
            func: () => {
              const btns = [...document.querySelectorAll('button')];
              const searchBtn = btns.find(b => b.textContent.trim() === '検索');
              if (searchBtn) searchBtn.click();
            }
          });
          globalThis.__incrementReinsUsage('search');
          // 結果ページに遷移するまで待つ
          let reSearchOk = false;
          for (let rs = 0; rs < 60; rs++) {
            await csleep(1000);
            const rsCheck = await chrome.scripting.executeScript({
              target: { tabId },
              func: () => {
                // ダイアログ処理
                const dialogs = document.querySelectorAll('[role="dialog"], .modal.show');
                for (const dialog of dialogs) {
                  const text = dialog.textContent;
                  if (text.includes('500件') || text.includes('超えています')) {
                    const okBtn = [...dialog.querySelectorAll('button')].find(b => b.textContent.trim() === 'OK');
                    if (okBtn) { okBtn.click(); return 'ok_clicked'; }
                  }
                }
                if (document.body.textContent.includes('検索結果一覧')) return 'result_page';
                return 'waiting';
              }
            });
            const rsStatus = rsCheck?.[0]?.result;
            if (rsStatus === 'result_page' || rsStatus === 'ok_clicked') {
              reSearchOk = true;
              if (rsStatus === 'ok_clicked') {
                await waitForDomReady(tabId, '.p-table-body-row', { timeout: 30000 });
              }
              break;
            }
          }
          if (reSearchOk) {
            await setStorageData({ debugLog: `${customer.name}: 再検索で結果ページ復帰成功` });
            // 現在のページに戻る必要がある場合はページネーション
            if (currentPage > 1) {
              for (let navP = 2; navP <= currentPage; navP++) {
                await chrome.scripting.executeScript({
                  target: { tabId },
                  func: (page) => {
                    const pageLinks = document.querySelectorAll('.page-link');
                    for (const link of pageLinks) {
                      if (link.textContent.trim() === String(page)) { link.click(); return; }
                    }
                  },
                  args: [navP]
                });
                await waitForDomReady(tabId, '.p-table-body-row', { timeout: 15000 });
              }
            }
            backSuccess = true;
          } else {
            await setStorageData({ debugLog: `${customer.name}: 再検索復帰失敗→残り物件スキップ` });
            return newProperties;
          }
          break;
        }
        if (!bt.url?.includes('system.reins.jp')) {
          // REINS外に遷移した → history.back()でREINSに戻る試行
          await setStorageData({ debugLog: `${customer.name}: REINS外に遷移(${bt.url?.substring(0,50)})→戻り試行` });
          await chrome.scripting.executeScript({
            target: { tabId },
            func: () => { history.back(); }
          });
          await csleep(1500);
          const bt2 = await chrome.tabs.get(tabId);
          if (bt2.url?.includes('GBK002200')) { backSuccess = true; break; }
          if (bt2.url?.includes('GBK001310')) {
            // 検索フォームに戻れた → 再検索で復帰
            await setStorageData({ debugLog: `${customer.name}: REINS復帰→検索フォームから再検索` });
            await chrome.scripting.executeScript({
              target: { tabId }, world: 'MAIN',
              func: () => {
                const btn = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === '検索');
                if (btn) btn.click();
              }
            });
            globalThis.__incrementReinsUsage('search');
            let reOk = false;
            for (let rs = 0; rs < 60; rs++) {
              await csleep(1000);
              const rsCheck = await chrome.scripting.executeScript({
                target: { tabId },
                func: () => {
                  const dialogs = document.querySelectorAll('[role="dialog"], .modal.show');
                  for (const dialog of dialogs) {
                    if (dialog.textContent.includes('500件') || dialog.textContent.includes('超えています')) {
                      const okBtn = [...dialog.querySelectorAll('button')].find(b => b.textContent.trim() === 'OK');
                      if (okBtn) { okBtn.click(); return 'ok_clicked'; }
                    }
                  }
                  if (document.body.textContent.includes('検索結果一覧')) return 'result_page';
                  return 'waiting';
                }
              });
              const s = rsCheck?.[0]?.result;
              if (s === 'result_page' || s === 'ok_clicked') {
                reOk = true;
                if (s === 'ok_clicked') await waitForDomReady(tabId, '.p-table-body-row', { timeout: 30000 });
                break;
              }
            }
            if (reOk) {
              if (currentPage > 1) {
                for (let navP = 2; navP <= currentPage; navP++) {
                  await chrome.scripting.executeScript({ target: { tabId }, func: (page) => { const links = document.querySelectorAll('.page-link'); for (const l of links) { if (l.textContent.trim() === String(page)) { l.click(); return; } } }, args: [navP] });
                  await waitForDomReady(tabId, '.p-table-body-row', { timeout: 15000 });
                }
              }
              backSuccess = true;
              break;
            }
          }
          if (!backSuccess) {
            await setStorageData({ debugLog: `${customer.name}: REINS復帰失敗→残り物件スキップ` });
            return newProperties;
          }
        }
      }
      if (!backSuccess) {
        await setStorageData({ debugLog: `${customer.name}: 戻りタイムアウト→残り物件スキップ` });
        return newProperties;
      }
      await csleep(delay);

    } catch (err) {
      if (err.message === 'SEARCH_CANCELLED' || err.message === 'SLEEP_DETECTED' || err.message === 'REINS_ERROR_PAGE') throw err;
      await setStorageData({ debugLog: `${customer.name}: 詳細取得失敗(${result.buildingName || result.propertyNumber}): ${err.message}` });
      try {
        await chrome.scripting.executeScript({
          target: { tabId },
          world: 'MAIN',
          func: () => {
            const nuxt = window.$nuxt;
            if (nuxt?.$router) { nuxt.$router.back(); return; }
            const backBtn = document.querySelector('.p-btn-back')
              || [...document.querySelectorAll('button')].find(el => el.textContent.trim() === '←');
            if (backBtn) backBtn.click(); else history.back();
          }
        });
        let recovered = false;
        for (let bw = 0; bw < 20; bw++) {
          await csleep(500);
          const bt = await chrome.tabs.get(tabId);
          if (bt.url?.includes('GBK002200')) { recovered = true; break; }
          if (bt.url?.includes('GBK001310')) {
            // 検索フォームに戻った→再検索で復帰
            await setStorageData({ debugLog: `${customer.name}: エラー回復→検索フォームから再検索` });
            await chrome.scripting.executeScript({
              target: { tabId }, world: 'MAIN',
              func: () => {
                const btn = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === '検索');
                if (btn) btn.click();
              }
            });
            globalThis.__incrementReinsUsage('search');
            for (let rs = 0; rs < 60; rs++) {
              await csleep(1000);
              const rsCheck = await chrome.scripting.executeScript({
                target: { tabId },
                func: () => {
                  const dialogs = document.querySelectorAll('[role="dialog"], .modal.show');
                  for (const dialog of dialogs) {
                    if (dialog.textContent.includes('500件') || dialog.textContent.includes('超えています')) {
                      const okBtn = [...dialog.querySelectorAll('button')].find(b => b.textContent.trim() === 'OK');
                      if (okBtn) { okBtn.click(); return 'ok_clicked'; }
                    }
                  }
                  if (document.body.textContent.includes('検索結果一覧')) return 'result_page';
                  return 'waiting';
                }
              });
              const s = rsCheck?.[0]?.result;
              if (s === 'result_page' || s === 'ok_clicked') {
                recovered = true;
                if (s === 'ok_clicked') await waitForDomReady(tabId, '.p-table-body-row', { timeout: 30000 });
                break;
              }
            }
            if (recovered && currentPage > 1) {
              for (let navP = 2; navP <= currentPage; navP++) {
                await chrome.scripting.executeScript({
                  target: { tabId },
                  func: (page) => {
                    const pageLinks = document.querySelectorAll('.page-link');
                    for (const link of pageLinks) {
                      if (link.textContent.trim() === String(page)) { link.click(); return; }
                    }
                  },
                  args: [navP]
                });
                await waitForDomReady(tabId, '.p-table-body-row', { timeout: 15000 });
              }
            }
            if (!recovered) {
              await setStorageData({ debugLog: `${customer.name}: エラー回復失敗→残り物件スキップ` });
              return newProperties;
            }
            break;
          }
          if (!bt.url?.includes('system.reins.jp')) {
            await setStorageData({ debugLog: `${customer.name}: エラー回復失敗(REINS外)→残り物件スキップ` });
            return newProperties;
          }
        }
        if (!recovered) {
          await setStorageData({ debugLog: `${customer.name}: エラー回復タイムアウト→残り物件スキップ` });
          return newProperties;
        }
        await csleep(delay);
      } catch(e) { if (e.message === 'SEARCH_CANCELLED' || e.message === 'SLEEP_DETECTED' || e.message === 'REINS_ERROR_PAGE') throw e; }
    }
  } // end detail loop for current page

    // --- ページネーション: 次のページへ ---
    if (currentPage < totalPages) {
      const nextPage = currentPage + 1;
      await setStorageData({ debugLog: `${customer.name}: ページ${nextPage}/${totalPages}へ移動中...` });
      try {
        await chrome.scripting.executeScript({
          target: { tabId },
          func: (page) => {
            const pageLinks = document.querySelectorAll('.page-link');
            for (const link of pageLinks) {
              if (link.textContent.trim() === String(page)) {
                link.click();
                return true;
              }
            }
            // 「次へ」ボタンのフォールバック
            for (const link of pageLinks) {
              if (link.textContent.includes('次') || link.textContent.includes('›')) {
                link.click();
                return true;
              }
            }
            return false;
          },
          args: [nextPage]
        });
        // SPA遷移: MutationObserverで行の再描画を待つ
        await waitForDomReady(tabId, '.p-table-body-row', { timeout: 30000 });
        await csleep(delay);
        currentPage = nextPage;
      } catch (err) {
        if (err.message === 'SEARCH_CANCELLED') throw err;
        await setStorageData({ debugLog: `${customer.name}: ページ${nextPage}への移動失敗: ${err.message}` });
        break pageLoop;
      }
    } else {
      break; // 最終ページ処理完了
    }
  } // end pageLoop

  // スキップ済み物件マップを保存（変更があった場合のみ）
  if (skippedMapDirty) {
    await setStorageData({ [skipStorageKey]: skippedMap });
  }

  if (newProperties.length === 0) {
    await setStorageData({ debugLog: `${customer.name}: 新規物件なし` });
  } else {
    await setStorageData({ debugLog: `${customer.name}: ${newProperties.length}件送信完了（全${totalPages}ページ）` });
  }
}

// --- ユーティリティ ---

// 拡張専用のREINSタブID（検索中のみ有効）
let dedicatedReinsTabId = null;
let dedicatedReinsWindowId = null; // 後方互換用(使わない)

async function findOrCreateDedicatedReinsTab() {
  // 既存の専用タブが生きているか確認
  if (dedicatedReinsTabId) {
    try {
      const tab = await chrome.tabs.get(dedicatedReinsTabId);
      if (tab && tab.url?.includes('system.reins.jp')) {
        return tab;
      }
    } catch (e) {
      // タブが閉じられている
    }
    dedicatedReinsTabId = null;
    dedicatedReinsWindowId = null;
  }

  // 既存ウィンドウ内に非アクティブタブとして作成
  // active:false なのでフォーカスを一切奪わない
  // クッキー共有でログイン済みセッションを引き継ぐ
  await setStorageData({ debugLog: '専用REINSタブを作成中...' });
  const newTab = await chrome.tabs.create({
    url: 'https://system.reins.jp/main/BK/GBK001310',
    active: false
  });
  dedicatedReinsTabId = newTab.id;
  dedicatedReinsWindowId = newTab.windowId;

  // ページ読み込み完了を待つ
  await waitForTabLoad(dedicatedReinsTabId);
  await sleep(3000);

  // ログイン状態を確認
  let tab = await chrome.tabs.get(dedicatedReinsTabId);
  const needsLogin = isReinsLoginState_(tab.url) || await isReinsSessionTimeoutPage_(dedicatedReinsTabId);
  if (needsLogin) {
    // 自動ログインを試行(ID/PW設定があり、Block中でなければ)
    const autoLogin = await attemptReinsAutoLogin_(dedicatedReinsTabId);
    if (autoLogin.ok) {
      tab = await chrome.tabs.get(dedicatedReinsTabId);
      // ログイン成功後、業務画面へ遷移が必要な場合は /main/BK/GBK001310 を開き直す
      if (!/\/main\//.test(tab.url)) {
        await chrome.tabs.update(dedicatedReinsTabId, { url: 'https://system.reins.jp/main/BK/GBK001310' });
        await waitForTabLoad(dedicatedReinsTabId);
        await sleep(2000);
        tab = await chrome.tabs.get(dedicatedReinsTabId);
      }
    } else if (autoLogin.skipped) {
      // ID/PW 未設定 or Block中 → 従来通りユーザーに手動ログインを促して終了
      await setStorageData({ debugLog: `専用タブでREINSログインが必要です (${autoLogin.reason})` });
      await closeDedicatedWindow();
      return null;
    } else {
      // 自動ログイン失敗 → Block立てて終了
      await setStorageData({
        reinsLoginBlocked: true,
        reinsLoginBlockedReason: autoLogin.error || 'login failed',
        debugLog: `[REINS] ⚠️ 自動ログイン失敗のためブロック: ${autoLogin.error}。手動ログイン後にオプション画面でブロック解除してください`
      });
      await closeDedicatedWindow();
      return null;
    }
  }

  await setStorageData({ debugLog: `専用REINSタブ作成: tabId=${dedicatedReinsTabId}` });
  return tab;
}

// REINSログイン系URL判定
function isReinsLoginState_(url) {
  if (!url) return false;
  return /\/login\//.test(url) || /GKG001/.test(url);
}

// REINS「セッションタイムアウト」ページ判定(業務系URLのまま本文にタイムアウト文言が出るパターン)
async function isReinsSessionTimeoutPage_(tabId) {
  try {
    const r = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [0] },
      func: () => {
        const body = (document.body && document.body.innerText) || '';
        return /セッションがタイムアウト/.test(body);
      }
    });
    return !!(r && r[0] && r[0].result);
  } catch (_) { return false; }
}

/**
 * REINS 自動ログイン試行(1回のみ、失敗でBlock)
 * 戻り値: { ok, skipped, reason?, error? }
 */
async function attemptReinsAutoLogin_(tabId) {
  const { reinsLoginId, reinsPassword, reinsLoginBlocked } = await getStorageData([
    'reinsLoginId', 'reinsPassword', 'reinsLoginBlocked'
  ]);
  if (reinsLoginBlocked) return { ok: false, skipped: true, reason: '前回ログイン失敗でブロック中' };
  if (!reinsLoginId || !reinsPassword) return { ok: false, skipped: true, reason: 'ID/PW未設定' };

  await setStorageData({ debugLog: '[REINS] ログインページ検知 → 自動ログイン試行(1回のみ)' });

  // ステップ1: セッションタイムアウト画面なら「再ログインへ」をクリック
  //           トップページ(REINS IP)なら「ログイン」リンクをクリック
  try {
    const navResult = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [0] },
      func: () => {
        const body = (document.body && document.body.innerText) || '';
        const url = location.href;
        // セッションタイムアウト → 再ログインへ
        if (/セッションがタイムアウト/.test(body)) {
          const btns = Array.from(document.querySelectorAll('a, button, input[type="button"], input[type="submit"]'));
          const target = btns.find(el => /再ログイン/.test((el.textContent || el.value || '').trim()));
          if (target) { target.click(); return { clicked: 'timeout-relogin' }; }
        }
        // トップページ(REINS IP) → ログインボタン
        if (!/\/login\//.test(url)) {
          const loginLink = document.querySelector('#login-button, a#login-button');
          if (loginLink) { loginLink.click(); return { clicked: 'top-login' }; }
        }
        return { clicked: null };
      }
    });
    const clicked = navResult && navResult[0] && navResult[0].result && navResult[0].result.clicked;
    if (clicked) {
      await waitForTabLoad(tabId, 30000);
      await sleep(2000);
    }
  } catch (err) {
    return { ok: false, error: 'navigation step failed: ' + err.message };
  }

  // ステップ2: ログインフォームに値を入れて同意チェック+送信
  let submitResult;
  try {
    const execResult = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [0] },
      func: (loginId, password) => {
        // ログインフォーム要素を特定(Vue SPA、p-textbox親経由)
        const idWrap = document.querySelector('.p-textbox.p-textbox-type-ascii');
        const pwWrap = document.querySelector('.p-textbox.p-textbox-type-password');
        if (!idWrap || !pwWrap) return { submitted: false, error: 'ID/PW input wrapper not found' };
        const idInput = idWrap.querySelector('input.p-textbox-input');
        const pwInput = pwWrap.querySelector('input.p-textbox-input');
        if (!idInput || !pwInput) return { submitted: false, error: 'input element not found' };

        // native setter で値をセット(Vueリアクティブ対応)
        const setNativeValue = (el, value) => {
          const proto = Object.getPrototypeOf(el);
          const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
          setter.call(el, value);
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        };
        setNativeValue(idInput, loginId);
        setNativeValue(pwInput, password);

        // 同意チェックボックスを ON (2つ目の .p-checkbox が「所属機構の規程...」)
        const checkboxes = document.querySelectorAll('.p-checkbox input[type="checkbox"]');
        let agreementChecked = false;
        for (const cb of checkboxes) {
          // 同意関連のラベルを探す
          const label = cb.closest('.p-checkbox')?.textContent || '';
          if (/遵守|規程|ガイドライン/.test(label)) {
            if (!cb.checked) {
              cb.click(); // Vueのv-model反応のためclick経由
            }
            agreementChecked = cb.checked;
            break;
          }
        }

        // フォールバック: 2つあれば2つ目が同意
        if (!agreementChecked && checkboxes.length >= 2) {
          const cb = checkboxes[1];
          if (!cb.checked) cb.click();
          agreementChecked = cb.checked;
        }
        if (!agreementChecked) {
          return { submitted: false, error: 'agreement checkbox not found or not checked' };
        }

        // 送信ボタンを見つけてクリック(disabled解除を少し待つ)
        const findLoginBtn = () => {
          const btns = Array.from(document.querySelectorAll('button.btn.p-button.btn-primary'));
          return btns.find(b => /ログイン/.test((b.textContent || '').trim()));
        };
        const loginBtn = findLoginBtn();
        if (!loginBtn) return { submitted: false, error: 'login button not found' };

        // disabled が外れるまで少し待つ(Vueが同意チェックを反映する猶予)
        return new Promise((resolve) => {
          let tries = 0;
          const tick = () => {
            if (!loginBtn.disabled) {
              loginBtn.click();
              resolve({ submitted: true });
              return;
            }
            tries++;
            if (tries > 20) { // 2秒で諦める
              resolve({ submitted: false, error: 'login button remained disabled' });
              return;
            }
            setTimeout(tick, 100);
          };
          tick();
        });
      },
      args: [reinsLoginId, reinsPassword],
    });
    submitResult = execResult && execResult[0] && execResult[0].result;
  } catch (err) {
    return { ok: false, error: 'submit inject failed: ' + err.message };
  }

  if (!submitResult) return { ok: false, error: 'no result from submit script' };
  if (!submitResult.submitted) return { ok: false, error: submitResult.error || 'submit skipped' };

  // 送信後のページ遷移を待つ
  try {
    await waitForTabLoad(tabId, 30000);
  } catch (_) {}
  await sleep(2500);

  // 遷移後の状態チェック
  const postCheck = await chrome.tabs.get(tabId);
  if (isReinsLoginState_(postCheck.url)) {
    return { ok: false, error: 'submit後もログインページのまま(ID/PW不一致の可能性)' };
  }
  if (await isReinsSessionTimeoutPage_(tabId)) {
    return { ok: false, error: 'submit後もセッションタイムアウト画面' };
  }
  await setStorageData({ debugLog: '[REINS] 自動ログイン成功' });
  return { ok: true };
}

async function closeDedicatedWindow() {
  if (dedicatedReinsTabId) {
    try {
      await chrome.tabs.remove(dedicatedReinsTabId);
    } catch (e) {
      // 既に閉じられている
    }
    dedicatedReinsWindowId = null;
    dedicatedReinsTabId = null;
  }
}

// 後方互換: 既存コードから呼ばれる場合のエイリアス
async function findReinsTab() {
  return findOrCreateDedicatedReinsTab();
}

// MutationObserver で指定セレクタ/条件の要素出現を即座に検知するヘルパー
// selector: CSSセレクタ文字列、またはDOM判定関数の文字列表現
// opts.textIncludes: body.textContent にこの文字列が含まれたら成功とみなす
// opts.timeout: タイムアウト(ms) デフォルト30000
// 戻り値: { found: true/false }
async function waitForDomReady(tabId, selector, opts = {}) {
  const timeout = opts.timeout || 30000;
  const textIncludes = opts.textIncludes || null;
  const minCount = opts.minCount || 1;
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      args: [selector, timeout, textIncludes, minCount],
      func: (sel, timeoutMs, textInc, minCnt) => {
        return new Promise((resolve) => {
          // 既に条件を満たしているか即チェック
          const check = () => {
            if (sel && document.querySelectorAll(sel).length >= minCnt) return true;
            if (textInc && document.body?.textContent?.includes(textInc)) return true;
            return false;
          };
          if (check()) { resolve({ found: true }); return; }
          const timer = setTimeout(() => { observer.disconnect(); resolve({ found: false }); }, timeoutMs);
          const observer = new MutationObserver(() => {
            if (check()) {
              observer.disconnect();
              clearTimeout(timer);
              resolve({ found: true });
            }
          });
          observer.observe(document.body || document.documentElement, { childList: true, subtree: true, characterData: true });
        });
      }
    });
    return results?.[0]?.result || { found: false };
  } catch (e) {
    return { found: false, error: e.message };
  }
}

function waitForTabLoad(tabId) {
  return new Promise((resolve) => {
    const keepAlive = setInterval(() => { chrome.runtime.getPlatformInfo(() => {}); }, 25000);
    const listener = (updatedTabId, changeInfo) => {
      if (updatedTabId === tabId && changeInfo.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(listener);
        clearInterval(keepAlive);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
    setTimeout(() => { chrome.tabs.onUpdated.removeListener(listener); clearInterval(keepAlive); resolve(); }, 30000);
  });
}

// ログタブを開く（既に開いていればフォーカス）
async function openLogTab() {
  const logUrl = chrome.runtime.getURL('log.html');
  const tabs = await chrome.tabs.query({ url: logUrl });
  if (tabs.length > 0) {
    await chrome.tabs.update(tabs[0].id, { active: true });
    await chrome.windows.update(tabs[0].windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url: logUrl, active: false });
  }
}

// Service Worker keepalive付きsleep（MV3ではsetTimeoutだけだとWorkerが停止する）
function sleep(ms) {
  return new Promise(resolve => {
    // 25秒ごとにChrome APIを呼んでService Workerを生存させる
    const keepAlive = setInterval(() => {
      chrome.runtime.getPlatformInfo(() => {});
    }, 25000);
    setTimeout(() => {
      clearInterval(keepAlive);
      resolve();
    }, ms);
  });
}

function getStorageData(keys) {
  return new Promise(resolve => chrome.storage.local.get(keys, resolve));
}

function setStorageData(data) {
  if (data.debugLog) {
    return new Promise(resolve => {
      chrome.storage.local.get(['debugLog'], (prev) => {
        const prevLog = prev.debugLog || '';
        const timestamp = new Date().toLocaleTimeString('ja-JP');
        data.debugLog = prevLog + `\n[${timestamp}] ${data.debugLog}`;
        if (data.debugLog.length > 500000) data.debugLog = data.debugLog.slice(-500000);
        chrome.storage.local.set(data, resolve);
      });
    });
  }
  return new Promise(resolve => chrome.storage.local.set(data, resolve));
}

function showNotification(title, message) {
  chrome.notifications.create({
    type: 'basic',
    iconUrl: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><text y="20" font-size="20">🏠</text></svg>',
    title,
    message
  });
}

// === Discord Webhook 送信 ===

// 顧客ごとのDiscordスレッドID（chrome.storage.localに永続化）
let discordThreadIds = {};
// 起動時にストレージから復元
(async () => {
  try {
    const data = await getStorageData(['discordThreadIds']);
    if (data.discordThreadIds) discordThreadIds = data.discordThreadIds;
  } catch (e) { console.warn('discordThreadIds復元失敗:', e); }
})();
// 顧客ごとのDiscord物件通し番号（検索サイクル中に保持・リセットされる）
const discordPropertyCounters = {};

function buildSearchInfo(customer) {
  const lines = ['**検索条件**', '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'];

  // 路線・駅
  const rws = customer.routes_with_stations || [];
  if (rws.length > 0) {
    const routeParts = rws.map(r => {
      return r.stations && r.stations.length > 0
        ? `${r.route}（${r.stations.join(', ')}）`
        : r.route;
    });
    lines.push(`路線: ${routeParts.join(' / ')}`);
  } else if (customer.stations && customer.stations.length > 0) {
    lines.push(`駅: ${customer.stations.join(', ')}`);
  }

  // エリア（市区町村・町名丁目）
  if (customer.selectedTowns && Object.keys(customer.selectedTowns).length > 0) {
    const parts = Object.entries(customer.selectedTowns).map(([city, towns]) =>
      towns && towns.length > 0 ? `${city}（${towns.join(', ')}）` : city
    );
    lines.push(`エリア: ${parts.join(' / ')}`);
  } else if (customer.cities && customer.cities.length > 0) {
    lines.push(`エリア: ${customer.cities.join(', ')}`);
  }

  // 賃料
  if (customer.rent_max) {
    lines.push(`賃料: 〜${customer.rent_max}万円`);
  }

  // 間取り
  if (customer.layouts && customer.layouts.length > 0) {
    lines.push(`間取り: ${customer.layouts.join(' / ')}`);
  }

  // 面積
  if (customer.area_min) {
    lines.push(`面積: ${customer.area_min}㎡〜`);
  }

  // 築年数
  if (customer.building_age) {
    lines.push(`築年: 築${String(customer.building_age).replace(/[^\d]/g, '')}年以内`);
  }

  // 構造
  if (customer.structures && customer.structures.length > 0) {
    lines.push(`構造: ${customer.structures.join(' / ')}`);
  }

  // 駅徒歩
  if (customer.walk) {
    const walkMin = String(customer.walk).replace(/[^\d]/g, '');
    if (walkMin) lines.push(`駅徒歩: ${walkMin}分以内`);
  }

  // 設備・条件
  if (customer.equipment) {
    const equipStr = typeof customer.equipment === 'string' ? customer.equipment : (customer.equipment || []).join(', ');
    if (equipStr) lines.push(`設備: ${equipStr}`);
  }

  // 検索URL（いえらぶ等）
  if (customer.search_url) {
    lines.push(`[検索結果を開く](${customer.search_url})`);
  }

  return lines.join('\n');
}

// === 通知モード制御 ===
// _batchBuffer[customerName] = [{ prop, customer, service }, ...]
const _batchBuffer = {};
const _serviceRank = { itandi: 4, essquare: 3, ielove: 2, reins: 1 };

function normalizeBuildingName(name) {
  if (!name) return '';
  return String(name)
    .normalize('NFKC')              // 全角→半角、互換正規化
    .replace(/[\s\u3000]+/g, '')     // 空白削除
    .replace(/[()（）\-－ｰ・,、.。]/g, '') // 記号削除
    .toUpperCase();
}

function buildDedupKey(prop) {
  const name = normalizeBuildingName(prop.building_name || prop.buildingName || '');
  if (!name) return null; // 建物名ないと判定不能→重複排除しない
  const room = prop.room_number || prop.roomNumber || '';
  if (room) return `${name}|${String(room).trim()}`;
  const floor = prop.floor || prop.floorText || '';
  const area = prop.area || '';
  return `${name}|${floor}|${area}`;
}

/**
 * 入居時期厳守モードで物件をスキップすべきか判定する。
 * 物件の最も早い入居可能日が顧客の期限を過ぎている場合のみスキップ。
 * 期間が重なる場合（例: 顧客7/11希望 + 物件7月中旬）はスキップしない（アラート付きで届ける）。
 * @returns {string|null} スキップ理由メッセージ、スキップしない場合はnull
 */
function shouldMoveInStrictSkip(prop, customer) {
  if (!customer?.move_in_strict || !customer?.move_in_date) return null;
  const warning = _checkMoveInWarning(prop, customer.move_in_date);
  if (!warning || !warning.includes('入居可能') || !warning.includes('のため要確認')) return null;
  const propMoveIn = (prop.move_in_date || '').trim();
  const customerDeadline = _parseMoveInDate(customer.move_in_date, true);
  const propEarliest = _parseMoveInDate(propMoveIn, false, true);
  if (propEarliest && customerDeadline && propEarliest > customerDeadline) {
    return warning;
  }
  return null;
}

async function deliverProperty(customerName, prop, customer, service) {
  // SUUMO巡回モードではDiscord通知をスキップ
  if (globalThis._suumoPatrolMode) return;

  const { notifyMode } = await getStorageData(['notifyMode']);
  if (notifyMode === 'batch') {
    if (!_batchBuffer[customerName]) _batchBuffer[customerName] = [];
    _batchBuffer[customerName].push({ prop, customer, service });
    return;
  }
  // 即時モード（デフォルト）
  await sendDiscordNotification(customerName, [prop], customer);
}

// 物件の画像枚数を取得 (image_urls が標準フォーマット。複数のフィールド名にフォールバック)
function _countImages(prop) {
  if (!prop) return 0;
  if (Array.isArray(prop.image_urls)) return prop.image_urls.length;
  if (Array.isArray(prop.imageUrls)) return prop.imageUrls.length;
  if (Array.isArray(prop.images)) return prop.images.length;
  if (Array.isArray(prop.image_base64s)) return prop.image_base64s.length;
  return 0;
}

// バッファ内の2エントリの「勝ち」を判定:
//   1. 画像枚数の多い方が勝ち
//   2. 同数ならサービス優先度 (itandi > essquare > ielove > reins) で決める
// 戻り値: a が勝てば >0, b が勝てば <0, タイなら 0
function _compareDedupCandidates(a, b) {
  const ai = _countImages(a.prop);
  const bi = _countImages(b.prop);
  if (ai !== bi) return ai - bi;
  return (_serviceRank[a.service] || 0) - (_serviceRank[b.service] || 0);
}

// 特定顧客のバッファをフラッシュ（重複排除→通知）
// 同じ物件が複数サービスから来た場合、画像枚数が多い方を優先 (枚数同じならサービス優先度)。
async function flushBatchBufferForCustomer(customerName) {
  const entries = _batchBuffer[customerName];
  if (!entries || entries.length === 0) return;
  const byKey = new Map();
  const noKey = [];
  const dropped = []; // 重複として除外されたもの（ログ用）
  for (const e of entries) {
    const key = buildDedupKey(e.prop);
    if (!key) { noKey.push(e); continue; }
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, e);
    } else if (_compareDedupCandidates(e, existing) > 0) {
      // 新エントリの方が画像多い (or 画像同数で優先度高い) → 入れ替え
      dropped.push({ ...existing, _winnerService: e.service, _winnerImages: _countImages(e.prop) });
      byKey.set(key, e);
    } else {
      // 既存の方が勝ち → こちらを dropped へ
      dropped.push({ ...e, _winnerService: existing.service, _winnerImages: _countImages(existing.prop) });
    }
  }
  const winners = [...byKey.values(), ...noKey];
  const props = winners.map(e => e.prop);
  const customer = winners[0].customer;
  await setStorageData({ debugLog: `[system] ${customerName}: ${entries.length}件→重複${dropped.length}件排除→${winners.length}件通知` });
  // 排除された物件を1件ずつログ
  for (const d of dropped) {
    const name = d.prop.building_name || d.prop.buildingName || '(建物名なし)';
    const room = d.prop.room_number || d.prop.roomNumber || '';
    const lostImages = _countImages(d.prop);
    const winImages = (typeof d._winnerImages === 'number') ? d._winnerImages : '?';
    await setStorageData({ debugLog: `[system] ${customerName}: ✗ 重複スキップ: ${name} ${room} (${d.service} 画像${lostImages}枚 → ${d._winnerService} 画像${winImages}枚 が勝ち)` });
  }
  try {
    await sendDiscordNotification(customerName, props, customer);
  } catch (err) {
    logError(`${customerName}: 一括通知失敗: ${err.message}`);
  }
  delete _batchBuffer[customerName];
}

async function sendDiscordNotification(customerName, properties, customer) {
  const { discordWebhookUrl, gasWebappUrl } = await getConfig();
  if (!discordWebhookUrl || properties.length === 0) return;

  // SUUMO巡回モードは別経路 (createSuumoPatrolThread_) で通知するため、ここに来るのは
  // お客様向け検索のみ。重複検知 (住所+部屋番号+面積+間取り、30日以内) を適用する。
  // 同物件が別管理会社・別サイト・別タイミングで複数登録されるケースで重複通知を防ぐ。
  if (!globalThis._suumoPatrolMode && globalThis.__hasNotifiedDedupKey) {
    const filtered = [];
    let dupSkipped = 0;       // 重複として弾いた数
    let keyableCount = 0;     // dedup キー生成できた物件数
    let unkeyableCount = 0;   // キー生成不可 (4要素欠落) 物件数
    for (const prop of properties) {
      try {
        // キー生成可否を集計 (デバッグ用)
        const k = globalThis.__buildPropertyDedupKey(prop);
        if (k) keyableCount++; else unkeyableCount++;

        if (globalThis.__hasNotifiedDedupKey(customerName, prop)) {
          const info = globalThis.__getNotifiedDedupInfo(customerName, prop) || {};
          const sourceTag = info.source ? ` (元: ${info.source})` : '';
          const prevUrl = info.url ? ` ${info.url}` : '';
          await setStorageData({ debugLog: `${customerName}: ✗ 重複通知スキップ: ${prop.building_name || ''} ${prop.room_number || ''} - 30日以内に同物件通知済${sourceTag}${prevUrl}` });
          dupSkipped++;
          continue;
        }
      } catch (e) {}
      filtered.push(prop);
    }
    // サマリログ (重複検知の動作確認用)
    if (properties.length > 0) {
      await setStorageData({
        debugLog: `${customerName}: 重複検知サマリ - 入力${properties.length}件 (キー化可${keyableCount} / 不可${unkeyableCount}) → 重複スキップ${dupSkipped}件 / 通知対象${filtered.length}件`
      });
    }
    if (filtered.length === 0) return; // 全部重複なら何もしない
    properties = filtered;
  }

  try {
    let threadId = discordThreadIds[customerName];
    // この検索実行で顧客の1物件目に検索条件を prepend するか
    // (新規スレッド時は最初の投稿に統合、既存スレッド時は1物件目に統合)
    let pendingSearchInfo = (customer && (!discordPropertyCounters[customerName] || discordPropertyCounters[customerName] === 0))
      ? buildSearchInfo(customer)
      : '';

    // スレッドがまだなければ作成。ヘッダーはシンプルな顧客名のみ。
    // 検索条件は新規/既存どちらの場合も 1物件目メッセージの先頭に prepend して統合送信。
    if (!threadId) {
      const headerPayload = {
        content: `**${customerName}** 様の新着物件`,
        thread_name: `🏠 ${customerName}`,
        flags: 4096
      };
      const resp = await fetch(`${discordWebhookUrl}?wait=true`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(headerPayload)
      });

      if (!resp.ok) {
        console.error(`Discord スレッド作成失敗: status=${resp.status}`);
        return;
      }

      const respData = await resp.json();
      threadId = respData.channel_id;
      if (!threadId) {
        console.error('Discord レスポンスに channel_id なし');
        return;
      }
      discordThreadIds[customerName] = threadId;
      // ストレージに永続化
      try { await setStorageData({ discordThreadIds }); } catch (e) {}

      await sleep(500);

      // 未解決駅があればスレッド内に警告を送信
      const custUnresolved = _unresolvedStations[customerName];
      if (custUnresolved) {
        const svcParts = [];
        for (const [svc, names] of Object.entries(custUnresolved)) {
          if (names.length > 0) svcParts.push(`${svc}: ${names.join(', ')}`);
        }
        if (svcParts.length > 0) {
          const warnMsg = `⚠️ **駅名解決失敗**\n${svcParts.join('\n')}\n該当駅の検索がスキップされています。`;
          await discordPostWithRetry(`${discordWebhookUrl}?thread_id=${threadId}`, { content: warnMsg, flags: 4096 });
          await sleep(500);
        }
      }
    }

    // スレッドが生きているか確認（既存スレッドの場合、最初の投稿で404なら再作成）
    if (!discordPropertyCounters[customerName]) discordPropertyCounters[customerName] = 0;

    for (let i = 0; i < properties.length; i++) {
      discordPropertyCounters[customerName]++;
      const propMsg = buildDiscordMessage(properties[i], discordPropertyCounters[customerName], gasWebappUrl, customerName, customer);
      let msg = '<@1459814543600390341>\n' + propMsg;

      // 既存スレッドの1物件目: 検索条件を物件メッセージに prepend して通知数を1つに統合。
      // 文字数(2000上限)に余裕がない場合は別送信に fallback。
      if (i === 0 && pendingSearchInfo) {
        const combined = `<@1459814543600390341>\n${pendingSearchInfo}\n\n${propMsg}`;
        if (combined.length <= 1900) {
          msg = combined;
        } else {
          // 文字数超過 → 検索条件を別メッセージで先に送信
          await discordPostWithRetry(`${discordWebhookUrl}?thread_id=${threadId}`, { content: pendingSearchInfo, flags: 4096 });
          await sleep(500);
        }
        pendingSearchInfo = '';
      }

      const postResp = await discordPostWithRetry(`${discordWebhookUrl}?thread_id=${threadId}`, { content: msg, allowed_mentions: { parse: [] }, flags: 4096 });
      // スレッドが期限切れ/削除された場合は再作成
      if (postResp && (postResp.status === 404 || postResp.status === 400)) {
        console.warn(`Discord スレッド無効 (${postResp.status})。${customerName}のスレッドを再作成...`);
        delete discordThreadIds[customerName];
        try { await setStorageData({ discordThreadIds }); } catch (e) {}
        // 再帰的に呼び直し（新スレッド作成される）
        const remaining = properties.slice(i);
        discordPropertyCounters[customerName] -= 1; // カウンタ戻す
        await sendDiscordNotification(customerName, remaining, customer);
        return;
      }
      // 通知成功 → 30日以内の重複通知防止のため、識別キーを記録
      if (!globalThis._suumoPatrolMode && globalThis.__addNotifiedDedupKey) {
        try { globalThis.__addNotifiedDedupKey(customerName, properties[i], properties[i].source); } catch (e) {}
      }
      if (i < properties.length - 1) await sleep(1000);
    }

    console.log(`Discord通知完了: ${customerName} ${properties.length}件`);

  } catch (err) {
    console.error(`Discord通知失敗: ${err.message}`);
  }
}

/**
 * 検索サイクル終了時、新着なしだった顧客を1通のメッセージにまとめて
 * メインチャンネル(スレッド外)に投稿する。顧客ごとの個別通知による通知ラッシュを
 * 避けるための関数。未解決駅があった顧客についてはその情報も併記する。
 */
async function sendDiscordNoResultSummary() {
  const list = (globalThis._noResultCustomers || []).slice();
  globalThis._noResultCustomers = []; // 次回サイクル用にクリア

  const { discordWebhookUrl } = await getConfig();
  if (!discordWebhookUrl) return;

  // 次回巡回予定時刻を取得（自動検索ON + アラームが立っている時のみ）
  let nextRunLine = '';
  try {
    const storage = await new Promise(r => chrome.storage.local.get(['autoSearchEnabled'], r));
    const autoEnabled = storage.autoSearchEnabled !== false; // デフォルトtrue
    if (autoEnabled) {
      const alarm = await new Promise(r => chrome.alarms.get('reins-search', r));
      if (alarm && alarm.scheduledTime) {
        const d = new Date(alarm.scheduledTime);
        const pad = n => String(n).padStart(2, '0');
        const nowDate = new Date();
        const sameDay = d.getFullYear() === nowDate.getFullYear()
          && d.getMonth() === nowDate.getMonth()
          && d.getDate() === nowDate.getDate();
        const prefix = sameDay ? '本日' : `${d.getMonth() + 1}/${d.getDate()}`;
        const diffMinTotal = Math.max(0, Math.round((alarm.scheduledTime - Date.now()) / 60000));
        const diffHour = Math.floor(diffMinTotal / 60);
        const diffMin = diffMinTotal % 60;
        let diffText;
        if (diffHour > 0 && diffMin > 0) diffText = `${diffHour}時間${diffMin}分後`;
        else if (diffHour > 0) diffText = `${diffHour}時間後`;
        else diffText = `${diffMin}分後`;
        nextRunLine = `🕐 次回巡回予定: ${prefix} ${pad(d.getHours())}:${pad(d.getMinutes())} (約${diffText})`;
      }
    }
  } catch (e) {
    console.warn('次回巡回時刻取得失敗:', e && e.message);
  }

  // === 新着あり顧客の物件数サマリーを収集 ===
  const foundLines = [];
  let totalFound = 0;
  for (const [name, count] of Object.entries(discordPropertyCounters)) {
    if (count > 0) {
      foundLines.push(`・${name}: ${count}件`);
      totalFound += count;
    }
  }

  // 通知する要素が何もなければスキップ
  if (list.length === 0 && foundLines.length === 0 && !nextRunLine) return;

  const lines = [];

  // メンション（通知音を鳴らすため）
  lines.push('<@1459814543600390341>');
  lines.push('');

  // 新着あり顧客のサマリー
  if (foundLines.length > 0) {
    lines.push(`🏠 **新着あり: ${foundLines.length}名 (計${totalFound}件)**`);
    lines.push(foundLines.join('\n'));
  }

  // 新着なし顧客のサマリー
  if (list.length > 0) {
    if (foundLines.length > 0) lines.push('');
    lines.push(`📭 **新着なし: ${list.length}名**`);
    const names = list.map(item => `・${item.name}`);
    lines.push(names.join('\n'));

    // 未解決駅があった顧客だけ追記
    const unresolvedLines = [];
    for (const item of list) {
      const cu = _unresolvedStations[item.name];
      if (!cu) continue;
      const svcParts = [];
      for (const [svc, stations] of Object.entries(cu)) {
        if (stations.length > 0) svcParts.push(`${svc}: ${stations.join(', ')}`);
      }
      if (svcParts.length > 0) {
        unresolvedLines.push(`⚠️ **${item.name}**: 駅名解決失敗 ${svcParts.join(' / ')}`);
      }
    }
    if (unresolvedLines.length > 0) {
      lines.push('');
      lines.push(unresolvedLines.join('\n'));
    }
  }

  if (nextRunLine) {
    if (lines.length > 0) lines.push('');
    lines.push(nextRunLine);
  }

  // Discord Webhook メッセージは 2000 文字が上限。超える場合は行単位で分割送信。
  const MAX_LEN = 1900; // 余裕を持って1900
  const full = lines.join('\n');
  const chunks = [];
  if (full.length <= MAX_LEN) {
    chunks.push(full);
  } else {
    let buf = '';
    for (const line of lines) {
      if (buf.length + line.length + 1 > MAX_LEN) {
        if (buf) chunks.push(buf);
        buf = line;
      } else {
        buf = buf ? (buf + '\n' + line) : line;
      }
    }
    if (buf) chunks.push(buf);
  }
  // フォーラムチャンネルのWebhookは thread_name(新スレッド作成) or thread_id(既存スレッド投稿)が必須。
  // 1日1スレッド方式: 日付キー(YYYY-MM-DD)で threadId を chrome.storage.local に保存。
  // 同日は thread_id で追記、日をまたいだら新スレッド作成。
  const nowD = new Date();
  const pad = n => String(n).padStart(2, '0');
  const dateKey = `${nowD.getFullYear()}-${pad(nowD.getMonth() + 1)}-${pad(nowD.getDate())}`;
  const threadName = `📋 巡回サマリー ${nowD.getMonth() + 1}/${nowD.getDate()}`;
  const THREAD_STORAGE_KEY = 'patrolSummaryThread'; // { dateKey, threadId }
  try {
    const cache = await new Promise(r => chrome.storage.local.get([THREAD_STORAGE_KEY], r));
    let savedThread = cache[THREAD_STORAGE_KEY];
    let threadId = (savedThread && savedThread.dateKey === dateKey) ? savedThread.threadId : null;

    for (let i = 0; i < chunks.length; i++) {
      let url = discordWebhookUrl;
      // メンション通知を有効化（巡回サマリーのみ通知音を鳴らす）
      const payload = { content: chunks[i] };
      if (!threadId) {
        // 同日スレッド未作成 → thread_name で新規作成
        url = `${discordWebhookUrl}?wait=true`;
        payload.thread_name = threadName;
      } else {
        // 既存スレッドに追記
        url = `${discordWebhookUrl}?thread_id=${threadId}`;
      }
      const resp = await discordPostWithRetry(url, payload);
      if (!threadId && resp && resp.ok) {
        try {
          const respData = await resp.json();
          threadId = respData.channel_id || respData.id;
          if (threadId) {
            await new Promise(r => chrome.storage.local.set({ [THREAD_STORAGE_KEY]: { dateKey, threadId } }, r));
          }
        } catch (e) {}
      }
      if (i < chunks.length - 1) await sleep(500);
    }
    console.log(`Discord 新着なしまとめ通知完了: 新着なし${list.length}名 chunks=${chunks.length} nextRun=${nextRunLine ? 'あり' : 'なし'} threadReused=${!!(savedThread && savedThread.dateKey === dateKey)}`);
  } catch (err) {
    console.error(`Discord 新着なしまとめ通知失敗: ${err.message}`);
  }
}

async function sendDiscordNoResultNotification(customerName, customer) {
  const { discordWebhookUrl } = await getConfig();
  if (!discordWebhookUrl) return;

  try {
    let threadId = discordThreadIds[customerName];

    // スレッドがまだなければ作成
    if (!threadId) {
      const headerPayload = {
        content: `**${customerName}** 様の検索結果`,
        thread_name: `🏠 ${customerName}`
      };
      const resp = await fetch(`${discordWebhookUrl}?wait=true`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(headerPayload)
      });

      if (!resp.ok) {
        console.error(`Discord スレッド作成失敗 (no-result): status=${resp.status}`);
        return;
      }

      const respData = await resp.json();
      threadId = respData.channel_id;
      if (!threadId) {
        console.error('Discord レスポンスに channel_id なし (no-result)');
        return;
      }
      discordThreadIds[customerName] = threadId;
      try { await setStorageData({ discordThreadIds }); } catch (e) {}
    }

    // 検索条件を送信
    if (customer) {
      const searchInfo = buildSearchInfo(customer);
      await discordPostWithRetry(`${discordWebhookUrl}?thread_id=${threadId}`, { content: searchInfo });
      await sleep(500);
    }

    // 未解決駅があれば警告を送信
    const custUnresolved = _unresolvedStations[customerName];
    if (custUnresolved) {
      const svcParts = [];
      for (const [svc, names] of Object.entries(custUnresolved)) {
        if (names.length > 0) svcParts.push(`${svc}: ${names.join(', ')}`);
      }
      if (svcParts.length > 0) {
        const warnMsg = `⚠️ **駅名解決失敗**\n${svcParts.join('\n')}\n該当駅の検索がスキップされています。`;
        await discordPostWithRetry(`${discordWebhookUrl}?thread_id=${threadId}`, { content: warnMsg });
        await sleep(500);
      }
    }

    // 新着なしメッセージを送信
    await discordPostWithRetry(`${discordWebhookUrl}?thread_id=${threadId}`, {
      content: `📭 **${customerName}** 様: 新着物件なし`
    });

    console.log(`Discord新着なし通知完了: ${customerName}`);

  } catch (err) {
    console.error(`Discord新着なし通知失敗: ${err.message}`);
  }
}

async function discordPostWithRetry(url, payload) {
  // @here/@everyone メンションを有効にする
  if (payload && payload.content && !payload.allowed_mentions) {
    payload.allowed_mentions = { users: ['1459814543600390341'] };
  }
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15000);
  try {
    let resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
    clearTimeout(timeoutId);

    if (resp.status === 429) {
      const data = await resp.json();
      const retryAfter = Math.min((data.retry_after || 5) * 1000, 30000);
      console.warn(`Discord レート制限。${retryAfter}ms待機...`);
      await sleep(retryAfter);
      const ctrl2 = new AbortController();
      const tid2 = setTimeout(() => ctrl2.abort(), 15000);
      resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: ctrl2.signal
      });
      clearTimeout(tid2);
    }

    if (!resp.ok && resp.status !== 204) {
      let errBody = '';
      try { errBody = (await resp.text()).substring(0, 500); } catch (e) {}
      console.error(`Discord送信エラー: status=${resp.status} body=${errBody}`);
    }
    return resp;
  } catch (err) {
    clearTimeout(timeoutId);
    if (err.name === 'AbortError') {
      console.error('Discord送信タイムアウト');
    } else {
      throw err;
    }
    return null;
  }
}

/**
 * 入居時期テキストを Date オブジェクトに変換する。
 * Python の _parse_move_in_date と同等のロジック。
 *
 * @param {string} text - 入居時期テキスト（例: "5月中旬", "2026年4月下旬", "即入居可"）
 * @param {boolean} asDeadline - true: 旬の末日（顧客の希望期限）、false: 旬の初日（物件の入居可能開始日）
 * @returns {Date|null}
 */
function _parseMoveInDate(text, asDeadline = false, earliest = false) {
  if (!text) return null;
  text = text.trim();

  // 制約なし・即時入居可能 → 比較不要
  const skipKeywords = ['いい物件見つかり次第', '即入居可', '即入居', '即時', '即日', '未定'];
  if (skipKeywords.some(kw => text.includes(kw))) return null;

  // ハイフン形式(ISO: type=date の値)を日本語形式に変換（"2026-07-15" → "2026年7月15日", "2026-07" → "2026年7月"）
  const hyphenFull = text.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (hyphenFull) {
    text = text.replace(hyphenFull[0], `${hyphenFull[1]}年${parseInt(hyphenFull[2], 10)}月${parseInt(hyphenFull[3], 10)}日`);
  } else {
    const hyphenYM = text.match(/(\d{4})-(\d{1,2})(?!\d)/);
    if (hyphenYM) {
      text = text.replace(hyphenYM[0], `${hyphenYM[1]}年${parseInt(hyphenYM[2], 10)}月`);
    }
  }

  // スラッシュ形式を日本語形式に変換（ES-Square API: "2026/7/15" → "2026年7月15日", "2026/07 中旬予定" → "2026年7月 中旬予定"）
  const slashFull = text.match(/(\d{4})\/(\d{1,2})\/(\d{1,2})/);
  if (slashFull) {
    text = text.replace(slashFull[0], `${slashFull[1]}年${slashFull[2]}月${slashFull[3]}日`);
  } else {
    const slashYM = text.match(/(\d{4})\/(\d{1,2})/);
    if (slashYM) {
      text = text.replace(slashYM[0], `${slashYM[1]}年${slashYM[2]}月`);
    }
  }

  // 和暦→西暦変換（"令和 8年 4月" → "2026年4月"）
  const warekiMatch = text.match(/(?:令和|平成|昭和)\s*(\d{1,2})\s*年/);
  if (warekiMatch) {
    const eraYear = parseInt(warekiMatch[1]);
    let seirekiYear;
    if (text.includes('令和')) seirekiYear = 2018 + eraYear;
    else if (text.includes('平成')) seirekiYear = 1988 + eraYear;
    else if (text.includes('昭和')) seirekiYear = 1925 + eraYear;
    if (seirekiYear) {
      text = text.replace(/(?:令和|平成|昭和)\s*\d{1,2}\s*年/, `${seirekiYear}年`);
    }
  }

  const now = new Date();
  const refYear = now.getFullYear();
  const refMonth = now.getMonth() + 1; // 1-based

  // 年・月・日・旬 を抽出
  const yearMatch = text.match(/(\d{4})\s*年/);
  const monthMatch = text.match(/(\d{1,2})\s*月/);
  const dayMatch = text.match(/(\d{1,2})\s*日/);

  let year = yearMatch ? parseInt(yearMatch[1]) : null;
  const month = monthMatch ? parseInt(monthMatch[1]) : null;

  if (month === null) return null; // 月がないと判定不能

  let period = null;
  if (text.includes('上旬')) period = 'early';
  else if (text.includes('中旬')) period = 'mid';
  else if (text.includes('下旬')) period = 'late';

  // 年が未指定の場合: 今年 or 来年で最も近い未来を推定
  if (year === null) {
    year = month >= refMonth ? refYear : refYear + 1;
  }

  // 日の決定
  // earliest=true: 期間の最初の日（厳守スキップ判定用: 最も早い入居可能日）
  // earliest=false: 期間の最終日（警告判定用: 最も遅い入居可能日）
  let day;
  if (dayMatch) {
    day = parseInt(dayMatch[1]);
  } else if (period !== null) {
    if (earliest) {
      if (period === 'early') day = 1;
      else if (period === 'mid') day = 11;
      else day = 21;
    } else {
      if (period === 'early') day = 10;
      else if (period === 'mid') day = 20;
      else day = new Date(year, month, 0).getDate(); // 月末
    }
  } else {
    // 月のみ指定
    day = earliest ? 1 : new Date(year, month, 0).getDate();
  }

  try {
    const d = new Date(year, month - 1, day);
    if (isNaN(d.getTime())) return null;
    return d;
  } catch {
    return null;
  }
}

/**
 * 物件の入居可能時期が顧客の希望入居時期を過ぎていないかチェックする。
 * @param {Object} prop - 物件オブジェクト
 * @param {string} customerMoveIn - 顧客の希望入居時期
 * @returns {string|null} - 警告メッセージ or null
 */
function _checkMoveInWarning(prop, customerMoveIn) {
  if (!customerMoveIn || customerMoveIn === 'いい物件見つかり次第') return null;

  const customerDeadline = _parseMoveInDate(customerMoveIn, true);
  if (!customerDeadline) return null;

  const propMoveIn = (prop.move_in_date || '').trim();

  // 即入居可等はスキップ
  if (['即入居可', '即入居', '即時', '即日'].some(kw => propMoveIn.includes(kw))) return null;

  // 入居可能時期が空（記載なし）
  if (!propMoveIn) {
    return `⚠️ ${customerMoveIn}入居希望: 入居可能時期の記載がありません`;
  }

  // 「相談」は日付比較できないが、入居時期が不確定なのでアラート
  if (propMoveIn.includes('相談')) {
    return `⚠️ ${customerMoveIn}入居希望: 入居時期「相談」のため要確認`;
  }

  const propertyAvailable = _parseMoveInDate(propMoveIn, false);
  if (!propertyAvailable) return null;

  if (propertyAvailable > customerDeadline) {
    return `⚠️ ${customerMoveIn}入居希望: 入居可能${propMoveIn}のため要確認`;
  }

  return null;
}

// 警告アラート計算: 顧客の希望条件と物件情報を比較し、要確認事項のリストを返す。
// buildDiscordMessage と 承認プレビュー両方で使えるよう globalThis に公開。
globalThis.__computePropertyWarnings = function(prop, customer) {
  // 警告アラート（ANSI黄色コードブロックで表示 — rent-researcher準拠）
  const toHankaku = (s) => s.replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));
  const equip = toHankaku(customer?.equipment || '').toLowerCase();
  const floorNum = parseInt(toHankaku(prop.floor_text || '').match(/(\d+)/)?.[1] || '0');
  const storyNum = parseInt(toHankaku(prop.story_text || '').match(/(\d+)/)?.[1] || '0');
  const warnings = [];
  if (equip.includes('最上階') && (floorNum === 0 || storyNum === 0)) {
    warnings.push('⚠️ 最上階かどうか確認してください');
  }
  if (equip.includes('2階以上') && floorNum === 0) {
    warnings.push('⚠️ 2階以上かどうか確認してください');
  }
  if (equip.includes('1階') && !equip.includes('2階以上') && floorNum === 0) {
    warnings.push('⚠️ 1階かどうか確認してください');
  }
  if (equip.includes('南向き') && !prop.sunlight) {
    warnings.push('⚠️ 南向きかどうか確認してください');
  }
  if (equip.includes('角部屋') && !(prop.facilities || '').includes('角部屋') && !(prop.facilities || '').includes('角住戸') && !(prop.room_attr || '').includes('角部屋')) {
    warnings.push('⚠️ 角部屋かどうか確認してください');
  }
  // 設備系アラート（REINSの実際の設備名で判定。設備情報なし/ありどちらでもチェック）
  const fac = prop.facilities || '';
  // 追い焚き（REINS: 追焚機能, itandi: 追焚き機能）
  if ((equip.includes('追い焚き') || equip.includes('追いだき') || equip.includes('追い炊き')) && !fac.includes('追焚') && !fac.includes('追い焚') && !fac.includes('追いだき')) {
    warnings.push('⚠️ 追い焚き機能かどうか確認してください');
  }
  // エレベーター（REINS: エレベータ ※長音なし, itandi: エレベーター）
  if ((equip.includes('エレベーター') || equip.includes('ev')) && !fac.includes('エレベータ') && !fac.includes('エレベーター')) {
    warnings.push('⚠️ エレベーターかどうか確認してください');
  }
  // バス・トイレ別（REINS: バス・トイレ別, itandi: バス・トイレ別, いえらぶ: バストイレ別）
  // btMode='skip' の場合はフィルタ側で除外済みなのでアラート不要
  {
    const _cBtMode = (customer?.btMode || __btMode || 'alert').toLowerCase();
    if (_cBtMode !== 'skip' && (equip.includes('バストイレ別') || equip.includes('バス・トイレ別') || equip.includes('bt別')) && !fac.includes('バス・トイレ別') && !fac.includes('バストイレ別')) {
      warnings.push('⚠️ バス・トイレ別かどうか確認してください');
    }
  }
  // 温水洗浄便座
  if ((equip.includes('温水洗浄便座') || equip.includes('ウォシュレット')) && !fac.includes('温水洗浄便座')) {
    warnings.push('⚠️ 温水洗浄便座かどうか確認してください');
  }
  // 浴室乾燥機（REINS: 浴室乾燥機, itandi: 浴室乾燥/浴室乾燥機）
  if (equip.includes('浴室乾燥') && !fac.includes('浴室乾燥')) {
    warnings.push('⚠️ 浴室乾燥機かどうか確認してください');
  }
  // 室内洗濯機置場（REINS: 室内洗濯機置場, itandi: 室内洗濯機置き場）
  if ((equip.includes('室内洗濯機置場') || equip.includes('室内洗濯')) && !fac.includes('室内洗濯機')) {
    warnings.push('⚠️ 室内洗濯機置場かどうか確認してください');
  }
  // エアコン
  if (equip.includes('エアコン') && !fac.includes('エアコン')) {
    warnings.push('⚠️ エアコン付きかどうか確認してください');
  }
  // 床暖房
  if (equip.includes('床暖房') && !fac.includes('床暖房')) {
    warnings.push('⚠️ 床暖房かどうか確認してください');
  }
  // 独立洗面台（REINS: シャンプードレッサー/洗面台, itandi: 独立洗面台, いえらぶ: 洗面所独立）
  // シャンプードレッサー・独立洗面・洗面所独立 → 確定。洗面台のみ → ユニットバスの可能性ありアラート
  if (equip.includes('独立洗面')) {
    if (fac.includes('シャンプードレッサー') || fac.includes('独立洗面') || fac.includes('洗面所独立') || fac.includes('洗面化粧台') || fac.includes('シャワー付洗面')) {
      // 独立洗面台確定 → アラート不要
    } else if (fac.includes('洗面台')) {
      warnings.push('⚠️ 独立洗面台があるかどうか確認してください（洗面台の記載あり、ユニットバスの可能性）');
    } else {
      warnings.push('⚠️ 独立洗面台があるかどうか確認してください');
    }
  }
  // ガスコンロ（REINS表記: ガスコンロ設置可/ガスキッチン）
  if (equip.includes('ガスコンロ') && !fac.includes('ガスコンロ') && !fac.includes('ガスキッチン')) {
    warnings.push('⚠️ ガスコンロ対応かどうか確認してください');
  }
  // IH（REINS表記: ＩＨクッキングヒーター ※全角）
  if (equip.includes('ih') && !fac.includes('ＩＨ') && !fac.includes('IH')) {
    warnings.push('⚠️ IHコンロかどうか確認してください');
  }
  // コンロ2口以上
  if (equip.includes('コンロ2口以上') || equip.includes('2口以上') || equip.includes('コンロ２口以上')) {
    if (!fac.includes('2口') && !fac.includes('２口') && !fac.includes('3口') && !fac.includes('３口')) {
      warnings.push('⚠️ コンロ2口以上かどうか確認してください');
    }
  }
  // システムキッチン
  if (equip.includes('システムキッチン') && !fac.includes('システムキッチン')) {
    warnings.push('⚠️ システムキッチンかどうか確認してください');
  }
  // カウンターキッチン（itandi: 対面キッチン, いえらぶ: オープンキッチン/アイランドキッチン, REINS: アイランドキッチン）
  if (equip.includes('カウンターキッチン') && !fac.includes('カウンターキッチン') && !fac.includes('対面キッチン') && !fac.includes('オープンキッチン') && !fac.includes('アイランドキッチン')) {
    warnings.push('⚠️ カウンターキッチンかどうか確認してください');
  }
  // 駐輪場
  if (equip.includes('駐輪場') && !fac.includes('駐輪場')) {
    warnings.push('⚠️ 駐輪場ありかどうか確認してください');
  }
  // 宅配ボックス（itandi: 宅配BOXも含む）
  if ((equip.includes('宅配ボックス') || equip.includes('宅配box')) && !fac.includes('宅配ボックス') && !fac.includes('宅配BOX')) {
    warnings.push('⚠️ 宅配ボックスかどうか確認してください');
  }
  // ゴミ置場（REINS: ２４時間ゴミ出し可, itandi: 敷地内ゴミ置き場, いえらぶ: 敷地内ごみ置き場/ゴミ出し24時間OK）
  if ((equip.includes('ゴミ置') || equip.includes('ごみ置') || equip.includes('ゴミ捨') || equip.includes('ごみ捨')) && !fac.includes('ゴミ出し') && !fac.includes('ゴミ置') && !fac.includes('ごみ置') && !fac.includes('ごみ出し')) {
    warnings.push('⚠️ 敷地内ゴミ置場かどうか確認してください');
  }
  // ロフト / ロフトNG
  if (equip.includes('ロフト')) {
    if (equip.includes('ロフトng') || equip.includes('ロフト不可')) {
      // ロフトNG: ロフトありはフィルタで除外済み。ロフト記載なしはアラート
      if (!fac.includes('ロフト')) warnings.push('⚠️ ロフトがないか確認してください（ロフトNG）');
    } else if (!fac.includes('ロフト')) {
      warnings.push('⚠️ ロフト付きかどうか確認してください');
    }
  }
  // 家具家電付き（REINSにチェックボックスなし→常にアラート）
  if (equip.includes('家具') || equip.includes('家電')) {
    warnings.push('⚠️ 家具家電付きかどうか確認してください');
  }
  // バルコニー（REINS表記: ルーフバルコニー/２面バルコニー/両面バルコニー/３面バルコニー）
  if (equip.includes('バルコニー') && !equip.includes('ルーフバルコニー')) {
    if (!fac.includes('バルコニー')) {
      warnings.push('⚠️ バルコニー付きかどうか確認してください');
    }
  }
  // ルーフバルコニー
  if (equip.includes('ルーフバルコニー') && !fac.includes('ルーフバルコニー')) {
    warnings.push('⚠️ ルーフバルコニー付きかどうか確認してください');
  }
  // 専用庭
  if (equip.includes('専用庭') && !fac.includes('専用庭')) {
    warnings.push('⚠️ 専用庭かどうか確認してください');
  }
  // 都市ガス/プロパンガス（一方がある場合はスキップで除外済み。ガス情報なしの場合はアラート）
  if (equip.includes('都市ガス') && !fac.includes('都市ガス') && !fac.includes('プロパン') && !fac.includes('LPガス') && !fac.includes('ＬＰガス')) {
    warnings.push('⚠️ 都市ガスかどうか確認してください');
  }
  if ((equip.includes('プロパン') || equip.includes('lpガス')) && !fac.includes('プロパン') && !fac.includes('LPガス') && !fac.includes('ＬＰガス') && !fac.includes('都市ガス')) {
    warnings.push('⚠️ プロパンガスかどうか確認してください');
  }
  // オートロック
  if (equip.includes('オートロック') && !fac.includes('オートロック')) {
    warnings.push('⚠️ オートロックかどうか確認してください');
  }
  // TVモニタ付きインターホン（REINS: モニター付きインターホン, itandi: モニター付インターホン, いえらぶ: TVインターホン）
  if ((equip.includes('tvモニタ') || equip.includes('モニター付') || equip.includes('モニタ付') || equip.includes('tvインターホン') || equip.includes('tvインターフォン')) && !fac.includes('モニター付') && !fac.includes('TVインターホン') && !fac.includes('ＴＶインターホン') && !fac.includes('TVモニタ')) {
    warnings.push('⚠️ TVモニタ付きインターホンかどうか確認してください');
  }
  // 防犯カメラ（REINSは常にアラート、itandi/いえらぶは防犯カメラで判定）
  if (equip.includes('防犯カメラ') && !fac.includes('防犯カメラ')) {
    warnings.push('⚠️ 防犯カメラかどうか確認してください');
  }
  // ペット可はフィルタで除外済み（アラート不要）
  // 楽器（REINS表記: 楽器使用可/楽器相談）
  if (equip.includes('楽器') && !fac.includes('楽器使用可') && !fac.includes('楽器相談')) {
    warnings.push('⚠️ 楽器可かどうか確認してください');
  }
  // 事務所利用可はフィルタで除外済み（アラート不要）
  // ルームシェア（REINSにチェックボックスなし→常にアラート）
  if ((equip.includes('ルームシェア') || equip.includes('シェアハウス')) && !fac.includes('ルームシェア') && !fac.includes('シェアハウス')) {
    warnings.push('⚠️ ルームシェア可かどうか確認してください');
  }
  // 高齢者（REINS: 高齢者向け, itandi: 高齢者向き/高齢者相談/高齢者世帯向け, いえらぶ: 高齢者限定/高齢者歓迎/高齢者相談）
  if (equip.includes('高齢者') && !fac.includes('高齢者向') && !fac.includes('高齢者相談') && !fac.includes('高齢者歓迎') && !fac.includes('高齢者限定') && !fac.includes('高齢者世帯')) {
    warnings.push('⚠️ 高齢者歓迎かどうか確認してください');
  }
  // フリーレントはフィルタで除外済み（アラート不要）
  // インターネット無料（REINS: 常にアラート, itandi: インターネット無料, いえらぶ: ネット使用料不要）
  if ((equip.includes('インターネット無料') || equip.includes('ネット無料')) && !fac.includes('インターネット無料') && !fac.includes('ネット無料') && !fac.includes('ネット使用料不要')) {
    warnings.push('⚠️ インターネット無料かどうか確認してください');
  }
  // 収納（REINS表記: 収納スペース/ウォークインクローゼット等）
  if (equip.includes('収納') && !equip.includes('ウォークイン') && !equip.includes('シューズ')) {
    if (!fac.includes('収納') && !fac.includes('クロゼット') && !fac.includes('クローゼット') && !fac.includes('物置') && !fac.includes('グルニエ')) {
      warnings.push('⚠️ 収納があるか確認してください');
    }
  }
  // シューズボックス（REINS表記: シューズインクローゼット）
  if (equip.includes('シューズ')) {
    if (!fac.includes('シューズインクローゼット') && !fac.includes('シューズボックス') && !fac.includes('シューズBOX') && !fac.includes('シューズクロゼット') && !fac.includes('シューズクローク') && !fac.includes('シューズWIC')) {
      warnings.push('⚠️ シューズボックスがあるか確認してください');
    }
  }
  // ウォークインクローゼット
  if (equip.includes('ウォークイン')) {
    if (!fac.includes('ウォークインクローゼット') && !fac.includes('ウォークインクロゼット') && !fac.includes('ウォークスルークロゼット') && !fac.includes('WIC')) {
      warnings.push('⚠️ ウォークインクローゼットがあるか確認してください');
    }
  }
  // 要物確アラート（itandi）
  if (prop.needs_confirmation) {
    warnings.push('⚠️ 要物確の物件です');
  }
  // 広告掲載可否（itandi）— SUUMO巡回モードの時のみ「可」以外でアラート
  if (globalThis._suumoPatrolMode && prop.source === 'itandi' && prop.ad_keisai) {
    const adKeisaiStr = String(prop.ad_keisai).trim();
    if (adKeisaiStr && adKeisaiStr !== '可') {
      warnings.push(`⚠️ 広告掲載: ${adKeisaiStr}（SUUMO広告掲載の確認が必要です）`);
    }
  }
  // 入居時期アラート
  const moveInWarning = _checkMoveInWarning(prop, customer?.move_in_date);
  if (moveInWarning) {
    warnings.push(moveInWarning);
  }
  // その他ご希望（顧客の自由入力）
  if (customer?.notes && String(customer.notes).trim()) {
    warnings.push(`⚠️ その他ご希望: ${String(customer.notes).trim()}`);
  }
  return warnings;
};

function buildDiscordMessage(prop, index, gasWebappUrl, customerName, customer) {
  const fmtMan = (yen) => {
    if (!yen) return '0';
    const v = yen / 10000;
    return String(parseFloat(v.toFixed(4)));
  };

  let title = prop.building_name || '物件情報';
  if (prop.room_number) title += `  ${prop.room_number}`;

  const sourceTag = prop.source === 'ielove' ? 'いえらぶ' : prop.source === 'itandi' ? 'itandi' : prop.source === 'essquare' ? 'いい生活スクエア' : 'REINS';
  // 物件ごとの区切り線（1件目にも入れる。上は検索条件）
  const lines = [];
  lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  lines.push(`**${index}. ${title}** \`[${sourceTag}]\``);

  // 賃料
  let rentStr = `賃料: **${fmtMan(prop.rent)}万円**`;
  if (prop.management_fee) {
    rentStr += ` (管理費: ${fmtMan(prop.management_fee)}万円)`;
  }
  lines.push(rentStr);

  // 間取り
  if (prop.layout) lines.push(`間取り: ${prop.layout}`);
  // 面積
  if (prop.area) lines.push(`面積: ${prop.area}m²`);
  // 築年
  if (prop.building_age) lines.push(`築年: ${prop.building_age}`);

  if (prop.address) lines.push(`住所: ${prop.address}`);
  if (prop.station_info) lines.push(`交通: ${prop.station_info}`);

  // 階数
  if (prop.floor_text || prop.story_text) {
    lines.push(`階数: ${prop.floor_text || '?'}/${prop.story_text || '?'}`);
  }

  if (prop.deposit || prop.key_money) {
    lines.push(`敷金: ${prop.deposit || 'なし'} / 礼金: ${prop.key_money || 'なし'}`);
  }

  // 入居時期
  if (prop.move_in_date) {
    lines.push(`入居: ${prop.move_in_date}`);
  }

  // REINS物件番号（REINSソースの場合のみ）
  if (prop.source !== 'ielove' && prop.source !== 'itandi' && prop.source !== 'essquare' && prop.reins_property_number) {
    lines.push(`物件番号: ${prop.reins_property_number}`);
  }

  // 警告アラート (globalThis.__computePropertyWarnings に抽出済み)
  const warnings = (typeof globalThis.__computePropertyWarnings === 'function')
    ? globalThis.__computePropertyWarnings(prop, customer) : [];
  if (warnings.length > 0) {
    const ansiText = warnings.join('\n');
    lines.push(`\`\`\`ansi\n\u001b[0;33m${ansiText}\u001b[0m\n\`\`\``);
  }

  // 管理会社（元付会社）
  if (prop.owner_company) lines.push(`管理会社: ${prop.owner_company}`);

  // 広告料・現況・客付会社メッセージ
  lines.push(`広告料: ${prop.ad_fee || '-'}`);
  if (prop.current_status) lines.push(`現況: ${prop.current_status}`);
  else if (prop.listing_status) lines.push(`現況: ${prop.listing_status}`);
  if (prop.agent_message) lines.push(`メッセージ: ${prop.agent_message}`);

  // 詳細ページURL
  if (prop.url) {
    lines.push(`[詳細ページ](${prop.url})`);
  } else if (prop.source !== 'ielove' && prop.source !== 'itandi' && prop.source !== 'essquare' && prop.reins_property_number) {
    // REINS: 物件番号検索を自動実行するURL（拡張のcontent-search.jsがhashを検出して検索）
    const cleanNum = String(prop.reins_property_number).replace(/\D/g, '');
    lines.push(`[REINSで開く](https://system.reins.jp/main/BK/GBK004100#bukken=${cleanNum})`);
  }

  // 承認リンク
  if (gasWebappUrl && customerName) {
    const approveUrl = `${gasWebappUrl}?action=approve&customer=${encodeURIComponent(customerName)}&room_id=${prop.room_id}`;
    lines.push(`[承認してLINE送信](${approveUrl})`);
  }

  return lines.join('\n');
}

// === END Discord ===

async function logError(message) {
  console.error(message);
  const { stats } = await getStorageData(['stats']);
  const currentStats = stats || { totalFound: 0, totalSubmitted: 0, errors: [], lastError: null };
  currentStats.lastError = message;
  currentStats.errors.push({ time: Date.now(), message });
  if (currentStats.errors.length > 10) currentStats.errors = currentStats.errors.slice(-10);
  await setStorageData({ stats: currentStats });
  // Discord へエラー通知（同一メッセージは5分間クールダウン）
  notifyDiscordError(message).catch(() => {});
}

// エラー通知のクールダウン管理（メモリ上）
const _errorNotifyCache = new Map();
async function notifyDiscordError(message) {
  try {
    const { discordWebhookUrl, errorWebhookUrl } = await getStorageData(['discordWebhookUrl', 'errorWebhookUrl']);
    const webhook = errorWebhookUrl || discordWebhookUrl;
    if (!webhook) return;
    // クールダウン: 同一メッセージ先頭80文字で5分以内はスキップ
    const key = String(message).slice(0, 80);
    const now = Date.now();
    const last = _errorNotifyCache.get(key) || 0;
    if (now - last < 5 * 60 * 1000) return;
    _errorNotifyCache.set(key, now);
    // 古いエントリ削除
    if (_errorNotifyCache.size > 50) {
      for (const [k, t] of _errorNotifyCache) {
        if (now - t > 30 * 60 * 1000) _errorNotifyCache.delete(k);
      }
    }
    const ts = new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
    const body = { content: `⚠️ **REINS拡張エラー** (${ts})\n\`\`\`\n${String(message).slice(0, 1800)}\n\`\`\`` };
    await fetch(webhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
  } catch (e) {
    console.error('Discord エラー通知失敗:', e);
  }
}

// ══════════════════════════════════════════════════════════════
//  SUUMO入稿: ForRentタブ管理・入稿プロセス
// ══════════════════════════════════════════════════════════════

/** ForRentのベースURL（suumo_fill=trueでcontent scriptがキュー処理を開始） */
const FORRENT_BASE_URL = 'https://www.fn.forrent.jp/fn/';
const FORRENT_FILL_URL = 'https://www.fn.forrent.jp/fn/?suumo_fill=true';

/**
 * ForRentの利用可能時間チェック
 *
 * ご利用可能時間:
 *   月曜日: 9:00〜24:00
 *   日曜日: 8:00〜23:00
 *   その他: 8:00〜24:00
 *
 * @returns {{ available: boolean, nextAvailableTime: number|null }}
 */
function checkForrentAvailability() {
  const now = new Date();
  const day = now.getDay(); // 0=日, 1=月, ...
  const hour = now.getHours();
  const minute = now.getMinutes();
  const currentMinutes = hour * 60 + minute;

  let startMinutes, endMinutes;
  if (day === 1) {
    // 月曜: 9:00〜24:00
    startMinutes = 9 * 60;
    endMinutes = 24 * 60;
  } else if (day === 0) {
    // 日曜: 8:00〜23:00
    startMinutes = 8 * 60;
    endMinutes = 23 * 60;
  } else {
    // その他: 8:00〜24:00
    startMinutes = 8 * 60;
    endMinutes = 24 * 60;
  }

  if (currentMinutes >= startMinutes && currentMinutes < endMinutes) {
    return { available: true, nextAvailableTime: null };
  }

  // 次の利用可能時刻を計算
  const next = new Date(now);
  if (currentMinutes >= endMinutes) {
    // 今日の利用時間は終了 → 翌日の開始時刻
    next.setDate(next.getDate() + 1);
  }
  // 翌日の曜日に応じた開始時刻
  const nextDay = next.getDay();
  let nextStart;
  if (nextDay === 1) {
    nextStart = 9 * 60; // 月曜
  } else {
    nextStart = 8 * 60; // 日曜・その他
  }
  next.setHours(Math.floor(nextStart / 60), nextStart % 60, 0, 0);

  return { available: false, nextAvailableTime: next.getTime() };
}

// ── 入稿キュー操作の mutex（race condition防止） ──────────────
// content scriptからの POP と background からの APPEND が同時に走ると
// 処理済み物件の再出現・重複入稿が起きるため、キュー書込は必ずここ経由で直列化する
let _fillQueueMutex = Promise.resolve();
function withFillQueueLock(fn) {
  const prev = _fillQueueMutex;
  let release;
  _fillQueueMutex = new Promise(r => { release = r; });
  return prev.then(() => fn()).finally(() => release());
}

async function popFillQueueHead() {
  return await withFillQueueLock(async () => {
    const { suumoFillQueue = [] } = await getStorageData(['suumoFillQueue']);
    if (suumoFillQueue.length === 0) return null;
    const head = suumoFillQueue[0];
    await setStorageData({ suumoFillQueue: suumoFillQueue.slice(1) });
    return head;
  });
}

async function appendFillQueue(items) {
  if (!items || items.length === 0) return 0;
  return await withFillQueueLock(async () => {
    const { suumoFillQueue = [] } = await getStorageData(['suumoFillQueue']);
    // 重複排除（物件キー単位）
    const existingKeys = new Set(
      suumoFillQueue.map(it => it.key || it.propertyKey).filter(Boolean)
    );
    const newItems = items.filter(it => {
      const k = it.key || it.propertyKey;
      return !k || !existingKeys.has(k);
    });
    if (newItems.length === 0) return 0;
    await setStorageData({ suumoFillQueue: suumoFillQueue.concat(newItems) });
    return newItems.length;
  });
}

/**
 * GASからキューをポーリングし、物件があれば入稿プロセスを開始
 *
 * @param {Object} options
 * @param {'approval'|'backup'|'startup'|'scheduled'|'manual'} options.source
 *   - approval: GAS承認ページからのSUUMO_APPROVED_NOW（即時処理）
 *   - backup:   60分おきのbackup poll（取りこぼし対策）
 *   - startup:  Chrome起動時の onStartup
 *   - scheduled: 営業時間外→営業開始時の suumo-fill-scheduled
 *   - manual:   ポップアップ等からの手動起動
 *
 * 稼働中タブがあるときの振る舞い（source別）:
 *   - approval / manual: GASから追加分を取得してキューに追記（連続入稿）
 *   - backup / startup: 重複処理を避けるためスキップ
 *   - scheduled: 基本的に稼働中タブは無いはず。あれば何もしない
 */
/**
 * 承認時の自動前処理(Phase 4)
 *
 * 順序:
 *   1. SUUMOビジネス Daily Search からデータ取得 → GAS反映 (best effort, 失敗は続行)
 *   2. GASから現在の掲載数と停止候補リストを peek (lockなし)
 *   3. 掲載数 >= 50 なら候補先頭の物件をForRentで停止
 *      - 停止成功: GASに stop_suumo_listing 反映 → OK返却
 *      - 停止ドライラン: GAS反映はしない + 警告ログ残して OK返却(入稿続行)
 *      - 停止失敗: NG返却(呼び出し元で入稿中止)
 *
 * @returns {Promise<{ok:boolean, error?:string, stopped?:Object}>}
 */
/**
 * Phase 4 前処理のミューテックス付き実行
 *
 * - 実行中の preHook Promise を _preHookInFlight に保持、並列呼び出しは同じPromiseを待つ
 * - 失敗時は60秒 cooldown (同じエラーでForRentを叩き続けるのを防止)
 *
 * 注: 以前は「直近5分以内に成功済みなら即OK返却」のキャッシュがあったが、
 *     1物件目で 49→50件になったのに 2物件目の preHook がキャッシュ返却して
 *     停止判定がスキップされ、 50件超過になるバグの原因になっていたため廃止
 *     (2026-05-05)。 連続入稿でも毎回 preHook で件数判定する。
 */
let _preHookInFlight = null;
let _preHookFailedAt = 0;
let _preHookFailedError = '';

async function getOrRunSuumoPreHook_() {
  const nowMs = Date.now();
  // 直近60秒以内に失敗していれば再実行しない(無限ループ防止)
  // 同じエラーで何度もForRentを叩き続けるのを回避
  if (_preHookFailedAt && (nowMs - _preHookFailedAt) < 60 * 1000) {
    return { ok: false, cached: true, error: '直近失敗中(cooldown): ' + _preHookFailedError };
  }
  // 実行中のpreHookがあれば同じ結果を待つ (並列呼び出しの直列化)
  if (_preHookInFlight) {
    return await _preHookInFlight;
  }
  // 新規実行
  _preHookInFlight = (async () => {
    try {
      const result = await runSuumoApprovalPreHook_();
      if (result && result.ok) {
        _preHookFailedAt = 0;
        _preHookFailedError = '';
      } else {
        _preHookFailedAt = Date.now();
        _preHookFailedError = (result && result.error) || 'no result';
      }
      return result || { ok: false, error: 'no result' };
    } catch (err) {
      _preHookFailedAt = Date.now();
      _preHookFailedError = err.message;
      return { ok: false, error: err.message };
    } finally {
      _preHookInFlight = null;
    }
  })();
  return await _preHookInFlight;
}

async function runSuumoApprovalPreHook_() {
  // ── 0. SUUMO入稿システムのトップページ TOP1R0000 を毎回fetchして
  //       「ネット掲載 N 指示」をリアルタイム取得する ──
  // Service Worker から直接 fetch (host_permissions あり、 cookie 自動送信)。
  // 入稿タブのコンテキストで実行しないので、 入稿タブの状態に依存しない。
  // 失敗時のリトライ: 短時間で 2 回まで (一時的なネットワーク・セッション揺れ対策)。
  let liveActiveCountFromForrent = null;
  let lastFetchError = '';
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      // ⚠️ ?id= は ForRent がセッション ID として解釈する (URL に伝播 → 入稿タブで
      //   「ブラウザを複数開いている」 画面遷移エラーになる) ため、 キャッシュバスト
      //   には _t= を使う (ForRent が予約していないパラメータ名)。
      const r = await fetch('https://www.fn.forrent.jp/fn/TOP1R0000.action?_t=' + Date.now(), {
        credentials: 'include',
        cache: 'no-store'
      });
      if (!r.ok) {
        lastFetchError = 'HTTP' + r.status;
      } else {
        const buf = await r.arrayBuffer();
        const html = new TextDecoder('shift-jis').decode(buf);
        const stripped = html
          .replace(/<script[\s\S]*?<\/script>/g, '')
          .replace(/<[^>]+>/g, ' ')
          .replace(/&nbsp;/g, ' ')
          .replace(/\s+/g, ' ');
        const m = stripped.match(/ネット掲載\s+(\d+)\s*指示\s*\/\s*(\d+)\s*枠/);
        if (m) {
          liveActiveCountFromForrent = parseInt(m[1], 10);
          await setStorageData({ debugLog: `[承認前処理] TOP1R0000直読み(SW fetch): ネット掲載=${liveActiveCountFromForrent}/${parseInt(m[2], 10)}枠` });
          break;
        }
        lastFetchError = /ログイン|login|ID.{0,5}パスワード/i.test(stripped) ? 'ログイン切れ' : 'パターン不一致';
      }
    } catch (e) {
      lastFetchError = e.message || String(e);
    }
    if (attempt < 2) {
      await sleep(800); // 短いリトライバッファ
    }
  }
  if (liveActiveCountFromForrent === null) {
    await setStorageData({ debugLog: `[承認前処理] TOP1R0000リアルタイム取得失敗(2回): ${lastFetchError}` });
  }

  // ── 0b. TOP1R0000リアルタイム取得が失敗していたら preHook を中止して入稿スキップ ──
  // 旧実装はここで syncForrentListingStatus (PUB1R2801) フォールバックを実行していたが、
  // それが入稿タブの URL を書き換えて入稿フローを破壊するバグの原因だったため廃止。
  // 失敗時は素直に入稿スキップして次サイクルで再試行 (2026-05-05)。
  if (liveActiveCountFromForrent === null) {
    await setStorageData({ debugLog: '[承認前処理] TOP1R0000取得失敗のため入稿スキップ(次回リトライ)' });
    return { ok: false, error: 'TOP1R0000取得失敗' };
  }

  // ── 1. SUUMOビジネスデータ取得 (JST日次キャッシュ) ──
  // SUUMOビジネスは1日1回しかデータ更新されないので、当日(JST)に一度取得済みなら
  // 日付が変わるまで再取得しない
  try {
    const { suumoBusinessLastFetchAt } = await getStorageData(['suumoBusinessLastFetchAt']);
    const toJstDate = (ms) => {
      // JST(UTC+9)の日付を YYYY-MM-DD 形式で取得
      const d = new Date(Number(ms) + 9 * 60 * 60 * 1000);
      const y = d.getUTCFullYear();
      const m = String(d.getUTCMonth() + 1).padStart(2, '0');
      const day = String(d.getUTCDate()).padStart(2, '0');
      return `${y}-${m}-${day}`;
    };
    const todayJst = toJstDate(Date.now());
    const lastJst = suumoBusinessLastFetchAt ? toJstDate(suumoBusinessLastFetchAt) : null;
    if (lastJst && lastJst === todayJst) {
      await setStorageData({ debugLog: `[承認前処理] SUUMOビジネスデータは本日(${todayJst})取得済み → スキップ` });
    } else {
      await setStorageData({ debugLog: '[承認前処理] SUUMOビジネスデータ更新開始(本日初取得)' });
      const fetchResult = await runSuumoBusinessFetch();
      if (!fetchResult || !fetchResult.ok) {
        await setStorageData({ debugLog: `[承認前処理] データ更新失敗(スキップして続行): ${fetchResult && fetchResult.error}` });
      }
      // runSuumoBusinessFetch内で成功時にsuumoBusinessLastFetchAtを更新している
    }
  } catch (err) {
    await setStorageData({ debugLog: `[承認前処理] データ更新例外(スキップ): ${err.message}` });
  }

  // ── 2. 現在の掲載数と停止候補を peek ──
  let peek;
  try {
    peek = await pollSuumoApprovalQueue({ lock: false });
  } catch (err) {
    return { ok: false, error: `停止候補取得失敗: ${err.message}` };
  }
  if (!peek) {
    return { ok: false, error: '停止候補取得失敗(GAS応答なし)' };
  }

  // ForRent直読みの生件数 (liveActiveCountFromForrent) があればそれを優先採用。
  // シート側のステータス更新は安全ガードでスキップされる場合があり (例: ForRent取得が
  // 半数超stopped判定になる/取得件数<10など)、過剰stopped反映を防ぐために
  // シート上 active 数が ForRent 実態より多くなることがあるため、その場合のシート由来
  // 件数を信用すると 50件未満なのに停止が走るバグを生む。
  const sheetActiveCount = Number(peek.activeListingCount) || 0;
  const activeCount = (typeof liveActiveCountFromForrent === 'number' && liveActiveCountFromForrent >= 0)
    ? liveActiveCountFromForrent
    : sheetActiveCount;
  if (activeCount < 50) {
    await setStorageData({ debugLog: `[承認前処理] 現掲載${activeCount}件 (ForRent直読み=${liveActiveCountFromForrent}件 / シート=${sheetActiveCount}件) → 停止不要、入稿へ進む` });
    return { ok: true };
  }

  // 候補リスト取得: 新API(stopCandidates) → 旧API(stopCandidate単数) の順でフォールバック
  const candidates = Array.isArray(peek.stopCandidates) && peek.stopCandidates.length > 0
    ? peek.stopCandidates
    : (peek.stopCandidate ? [peek.stopCandidate] : []);

  // GAS が段階的保護緩和をどのレベルで採用したかを取得 (0=標準/1=緩い/2=最小/3=保護無視)
  // GAS が古い (relaxLevel 未対応) なら undefined → 0 扱い
  const relaxLevel = typeof peek.stopCandidateRelaxLevel === 'number' ? peek.stopCandidateRelaxLevel : 0;
  const relaxLabel = ['標準', '緩和1(3日/問合30日)', '緩和2(1日のみ)', '保護無視(最終手段)'][relaxLevel] || '不明';

  if (candidates.length === 0) {
    // GAS レスポンスの中身をすべてログに出して原因特定
    let peekDump = '(空)';
    try {
      peekDump = JSON.stringify({
        activeListingCount: peek.activeListingCount,
        stopCandidate: peek.stopCandidate,
        stopCandidatesLength: Array.isArray(peek.stopCandidates) ? peek.stopCandidates.length : 'not-array',
        stopCandidateRelaxLevel: peek.stopCandidateRelaxLevel,
        keys: Object.keys(peek || {}),
        firstCandidate: Array.isArray(peek.stopCandidates) && peek.stopCandidates[0] ? {
          building: peek.stopCandidates[0].building,
          score: peek.stopCandidates[0].score,
          rowIndex: peek.stopCandidates[0].rowIndex,
        } : null,
      });
    } catch (_) { peekDump = '(JSON dump 失敗)'; }
    await setStorageData({ debugLog: '[承認前処理] ⚠️ 50件達しているが停止候補なし → 入稿中止 (peek=' + peekDump + ')' });
    return { ok: false, error: '50件達しているが停止候補が空' };
  }

  // ── 3. 先頭候補を停止 ──
  const target = candidates[0];
  const suumoCode = String(target.suumoPropertyCode || '').replace(/[^0-9]/g, '');
  if (!suumoCode || suumoCode.length !== 12) {
    await setStorageData({ debugLog: `[承認前処理] ⚠️ 候補のsuumo_property_codeが不正: "${target.suumoPropertyCode}" → 入稿中止` });
    return { ok: false, error: `候補のsuumo_property_code不正: ${target.suumoPropertyCode}` };
  }

  if (relaxLevel > 0) {
    // 標準ルールでは候補ゼロだったが、 緩和ルールで救済したケース
    await setStorageData({
      debugLog: `[承認前処理] ⚠️ 標準ルールで候補ゼロ → 保護緩和[${relaxLabel}]で停止候補を確保`
    });
  }
  await setStorageData({
    debugLog: `[承認前処理] 停止実行: ${target.building} ${target.room} (${suumoCode}) score=${target.score} 保護=${relaxLabel}`
  });

  const stopResult = await stopForrentListing({ suumoPropertyCode: suumoCode });

  if (!stopResult || !stopResult.ok) {
    return { ok: false, error: `ForRent停止失敗: ${(stopResult && stopResult.error) || '不明'}` };
  }

  // ── 3b. ドライランの場合: GAS反映せず、ログだけ残して続行 ──
  if (stopResult.dryRun) {
    await setStorageData({ debugLog: `[承認前処理] ⚠️ 停止処理はドライラン中のため実際には停止されていない。入稿は続行するが SUUMO側で上限エラーになる可能性あり` });
    return { ok: true, stopped: target, dryRun: true };
  }

  // ── 3c. GASに停止を反映 (stop_suumo_listing) ──
  try {
    const { gasWebappUrl } = await getStorageData(['gasWebappUrl']);
    if (gasWebappUrl && target.key) {
      const res = await fetch(gasWebappUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'stop_suumo_listing', key: target.key })
      });
      if (!res.ok) {
        await setStorageData({ debugLog: `[承認前処理] ⚠️ GAS停止反映HTTP${res.status}(ForRent側は停止済、シート更新のみ失敗)` });
      }
    }
  } catch (err) {
    await setStorageData({ debugLog: `[承認前処理] ⚠️ GAS停止反映失敗: ${err.message}(ForRent側は停止済)` });
  }

  await setStorageData({
    debugLog: `[承認前処理] 停止完了: ${target.building} ${target.room} → 入稿へ進む`,
    suumoForrentLastAutoStopAt: Date.now(),
    suumoForrentLastAutoStopTarget: { key: target.key, building: target.building, room: target.room, suumoCode: suumoCode },
  });
  return { ok: true, stopped: target };
}

async function pollAndStartFillIfNeeded(options = {}) {
  const source = options.source || 'approval';
  await setStorageData({ debugLog: `[SUUMO入稿] pollAndStartFillIfNeeded 開始 source=${source}` });

  // 稼働中入稿タブの有無を確認
  const { suumoFillTabId } = await getStorageData(['suumoFillTabId']);
  let tabAlive = false;
  if (suumoFillTabId) {
    try {
      const existingTab = await chrome.tabs.get(suumoFillTabId);
      if (existingTab && existingTab.url && existingTab.url.includes('fn.forrent.jp')) {
        tabAlive = true;
      }
    } catch (e) {
      // タブが存在しない → suumoFillTabIdは古いので続行（後でnew tab作成）
      await chrome.storage.local.remove(['suumoFillTabId', 'suumoFillQueue']);
    }
  }
  await setStorageData({ debugLog: `[SUUMO入稿] tabAlive=${tabAlive} suumoFillTabId=${suumoFillTabId}` });

  // ── 稼働中タブあり ──
  if (tabAlive) {
    // 重複処理を避けるため backup/startup は完全スキップ
    if (source === 'backup' || source === 'startup' || source === 'scheduled') {
      console.log(`[SUUMO入稿] 入稿タブ(${suumoFillTabId})稼働中 → ${source}をスキップ`);
      return;
    }
    // approval/manual: GASから追加分を取得して稼働中タブのキューに追記
    const { available } = checkForrentAvailability();
    if (!available) {
      // タブ稼働中で時間外はレアケース（処理中に時間を跨いだ等）。追加取得はせず静観
      console.log('[SUUMO入稿] タブ稼働中・時間外 → 追加取得スキップ');
      return;
    }

    // ── Phase 4: 稼働中タブでも approval/manual なら前処理(データ更新+必要なら停止)を実行 ──
    // 以前は tabAlive=true の時に前処理をスキップしていたため、
    // 50件超過時に停止されずに追加キュー投入され、SUUMO側で「掲載数オーバー」エラーになっていた
    if (source === 'approval' || source === 'manual') {
      const preHook = await getOrRunSuumoPreHook_();
      if (!preHook.ok) {
        await setStorageData({ debugLog: `[SUUMO入稿] 前処理失敗のため稼働中タブへの追加も中止: ${preHook.error}` });
        return;
      }
    }

    const queueData = await pollSuumoApprovalQueue({ lock: true });
    if (queueData && queueData.queue && queueData.queue.length > 0) {
      const added = await appendFillQueue(queueData.queue);
      console.log(`[SUUMO入稿] 稼働中タブのキューに ${added}件追加（連続入稿）`);
      await setStorageData({
        suumoActiveListingCount: queueData.activeListingCount,
        suumoStopCandidate: queueData.stopCandidate,
        debugLog: `[SUUMO入稿] 稼働中タブに${added}件追加`
      });
    }
    return;
  }

  // ── 稼働中タブなし ──
  const { available, nextAvailableTime } = checkForrentAvailability();
  if (!available) {
    const nextDate = new Date(nextAvailableTime);
    const timeStr = `${nextDate.getMonth()+1}/${nextDate.getDate()} ${String(nextDate.getHours()).padStart(2,'0')}:${String(nextDate.getMinutes()).padStart(2,'0')}`;
    // キューを事前に確認（空なら予約しない）
    const peek = await pollSuumoApprovalQueue({ lock: false });
    if (!peek || !peek.queue || peek.queue.length === 0) return;
    console.log(`[SUUMO入稿] ForRent時間外 → ${timeStr} にスケジュール`);
    await setStorageData({ debugLog: `[SUUMO入稿] ForRent利用時間外のため ${timeStr} に入稿予定` });
    chrome.alarms.create('suumo-fill-scheduled', { when: nextAvailableTime });
    return;
  }

  // ── Phase 4: 承認/手動起動時のみ、入稿前に SUUMOビジネス更新 → 50件超なら自動停止 ──
  //   - データ取得失敗はスキップ(入稿は続行)
  //   - 停止失敗は入稿中止(50件超過の入稿は SUUMO側でエラーになるため安全優先)
  //   - 停止ドライラン中はGAS反映せず、ログ警告だけ残して入稿は続行
  if (source === 'approval' || source === 'manual') {
    const preHook = await getOrRunSuumoPreHook_();
    if (!preHook.ok) {
      await setStorageData({ debugLog: `[SUUMO入稿] 前処理失敗のため入稿中止: ${preHook.error}` });
      return;
    }
  }

  // 実入稿フェーズ: ロック付きでキュー取得（取得した瞬間にGAS側でsubmittingに変わり二重取得防止）
  const queueData = await pollSuumoApprovalQueue({ lock: true });
  if (!queueData) {
    await setStorageData({ debugLog: '[SUUMO入稿] GASキュー取得失敗 (null返却) → 入稿スキップ' });
    return;
  }
  if (!queueData.queue || queueData.queue.length === 0) {
    await setStorageData({ debugLog: `[SUUMO入稿] 承認済みキュー空 → 入稿スキップ (active=${queueData.activeListingCount})` });
    return;
  }

  console.log(`[SUUMO入稿] ${queueData.queue.length}件の承認済み物件あり（submittingへロック済み）`);
  await setStorageData({
    suumoFillQueue: queueData.queue,
    suumoActiveListingCount: queueData.activeListingCount,
    suumoStopCandidate: queueData.stopCandidate,
    debugLog: `[SUUMO入稿] ${queueData.queue.length}件の承認済み物件あり → 入稿タブ作成へ`
  });

  await startSuumoFillProcess();
}

/**
 * ForRentの入稿プロセスを開始
 *
 * ForRentは動的セッションID管理のため固定URLでは新規登録ページに直接アクセスできない。
 * 既存ForRentタブがあればそれを使い、なければ ?suumo_fill=true 付きで開く。
 * content script (suumo-fill-auto.js) が ?suumo_fill=true を検知してキュー処理を開始。
 */
async function startSuumoFillProcess() {
  try {
    // ── race condition対策: 空タブを先に作ってタブIDを storage に書き込んでから URL設定 ──
    // 旧: tabs.create(url=FORRENT_FILL_URL) → await setStorageData(tabId)
    //     の順だとログインページが即document_idleになった場合に content script が
    //     AM_I_FILL_TAB を送った時点で storage にタブIDがまだ書かれておらず
    //     「入稿タブではない」と判定→自動ログインがスキップされる事象が起きる。
    // 新: 空タブ(about:blank)作成 → storage書込 → tabs.update(url) の順で、
    //     content script が走る前に必ずtabIdが確定している状態にする。
    const forrentTab = await chrome.tabs.create({ url: 'about:blank', active: false });
    await setStorageData({ suumoFillTabId: forrentTab.id });
    await chrome.tabs.update(forrentTab.id, { url: FORRENT_FILL_URL });
    console.log(`[SUUMO入稿] 入稿用タブを新規作成 (tab ${forrentTab.id})`);
    await setStorageData({ debugLog: `[SUUMO入稿] ForRent入稿タブ作成(tab=${forrentTab.id})` });
  } catch (err) {
    console.error('[SUUMO入稿] ForRentタブオープン失敗:', err);
    await setStorageData({ debugLog: `[SUUMO入稿] ForRentタブオープン失敗: ${err.message}` });
  }
}
