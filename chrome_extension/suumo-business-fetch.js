/**
 * suumo-business-fetch.js — SUUMOビジネス Daily Search ページからの掲載実績取得
 *
 * SUUMOビジネス(business1.suumo.jp) の Daily Search ページを新規タブで開き、
 * 最大50件の自社掲載物件について以下を一括取得して GAS へ送信する。
 *   - 物件名・部屋番号
 *   - SUUMO物件コード(12桁)
 *   - 合計一覧PV / 合計詳細PV / 問い合わせ数
 *   - 掲載日数(最大45)
 *   - 競合基準値別件数(第1/第2/第3)
 *
 * background.js から importScripts('suumo-business-fetch.js') で読み込まれる想定。
 *
 * 既存の SUUMO巡回(suumo-patrol.js) や SUUMO入稿(suumo-fill-auto.js) には
 * 一切干渉しない。手動トリガー or 承認時フックからの呼び出し専用。
 */

// ── 状態管理 ──
let _suumoBusinessFetchRunning = false;

/**
 * SUUMOビジネスからデータ取得 → GAS送信の一連を実行
 * @returns {Promise<Object>} { ok: true, count: N, updated: N } または { ok: false, error: string }
 */
async function runSuumoBusinessFetch() {
  if (_suumoBusinessFetchRunning) {
    console.log('[SUUMOビジネス] 既に実行中のためスキップ');
    return { ok: false, error: '既に実行中' };
  }
  _suumoBusinessFetchRunning = true;

  try {
    await setStorageData({ debugLog: '[SUUMOビジネス] データ取得開始' });

    // ── 前チェック: ログインブロック中ならいかなる操作も行わない ──
    // 前回の自動ログイン試行が失敗した場合、連続試行によるアカウントロックを防ぐため
    // suumoBusinessLoginBlocked=true が立っている間は何もしない。
    // ユーザーがオプション画面の「ログインブロック解除」ボタンで明示的に解除するまで続く。
    const { suumoBusinessLoginBlocked, suumoBusinessLoginBlockedReason } = await getStorageData([
      'suumoBusinessLoginBlocked', 'suumoBusinessLoginBlockedReason'
    ]);
    if (suumoBusinessLoginBlocked) {
      const reason = suumoBusinessLoginBlockedReason || '前回ログインに失敗';
      await setStorageData({ debugLog: `[SUUMOビジネス] ログインブロック中(${reason})。オプション画面で解除してください` });
      return { ok: false, error: 'login blocked: ' + reason, blocked: true };
    }

    // 1. Daily Search ページを新規タブで開く
    //    kiss_code が未設定だと /reportDaily にリダイレクトされるため必須
    const dailyUrl = await buildSuumoBusinessDailyUrl();
    if (!dailyUrl) {
      await setStorageData({ debugLog: '[SUUMOビジネス] kiss_code 未設定のため中止。オプション画面で設定してください' });
      return { ok: false, error: 'kiss_code 未設定' };
    }
    const tab = await chrome.tabs.create({ url: dailyUrl, active: false });
    const tabId = tab.id;

    // 2. ページ読み込み完了を待つ
    await waitForTabLoad(tabId, 60000);
    await sleep(2000);

    // 2a. ログインページに飛ばされていないか確認
    let currentUrl = await getTabUrl(tabId);
    if (isSuumoLoginUrl(currentUrl)) {
      // 自動ログインを試みる(1回のみ)
      const loginResult = await attemptSuumoBusinessLogin_(tabId);
      if (!loginResult.ok) {
        try { await chrome.tabs.remove(tabId); } catch (_) {}
        await setStorageData({
          suumoBusinessLoginBlocked: true,
          suumoBusinessLoginBlockedReason: loginResult.error || 'login failed',
          debugLog: `[SUUMOビジネス] ⚠️ 自動ログイン失敗のためブロック: ${loginResult.error}。これ以上の試行はアカウントロックの原因になるため中止。オプション画面で手動ログイン→解除してください`,
        });
        return { ok: false, error: 'login failed: ' + loginResult.error, blocked: true };
      }
      // ログイン後、改めて Daily Search に遷移
      await chrome.tabs.update(tabId, { url: dailyUrl });
      await waitForTabLoad(tabId, 60000);
      await sleep(2000);

      // もう一度URLチェック: ログイン後なのにまだsigninなら明らかに失敗
      currentUrl = await getTabUrl(tabId);
      if (isSuumoLoginUrl(currentUrl)) {
        try { await chrome.tabs.remove(tabId); } catch (_) {}
        await setStorageData({
          suumoBusinessLoginBlocked: true,
          suumoBusinessLoginBlockedReason: 'login appears failed (still on signin)',
          debugLog: '[SUUMOビジネス] ⚠️ ログイン試行後もsigninページのままのためブロック',
        });
        return { ok: false, error: 'still on signin after login attempt', blocked: true };
      }
    }

    await sleep(1500); // テーブル描画完了の余裕

    // 3. テーブル行をスクレイピング
    const scrapeResult = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [0] },
      func: scrapeSuumoBusinessTable,
    });
    const rows = scrapeResult && scrapeResult[0] && scrapeResult[0].result;

    // 4. 完了したらタブを閉じる
    try { await chrome.tabs.remove(tabId); } catch (_) {}

    if (!Array.isArray(rows)) {
      await setStorageData({ debugLog: '[SUUMOビジネス] スクレイピング失敗: 戻り値が配列でない' });
      return { ok: false, error: 'scrape failed' };
    }
    if (rows.length === 0) {
      await setStorageData({ debugLog: '[SUUMOビジネス] 取得0件(ログイン切れの可能性)' });
      return { ok: false, error: 'no rows (possibly logged out)' };
    }

    await setStorageData({ debugLog: `[SUUMOビジネス] ${rows.length}件取得、GASへ送信` });

    // 5. GAS送信
    const { gasWebappUrl } = await getStorageData(['gasWebappUrl']);
    if (!gasWebappUrl) {
      await setStorageData({ debugLog: '[SUUMOビジネス] GAS URL未設定' });
      return { ok: false, error: 'no gas url' };
    }

    const response = await fetch(gasWebappUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'update_suumo_listing_stats',
        fetchedAt: new Date().toISOString(),
        rows: rows,
      }),
    });
    const rawText = await response.text();
    let result = {};
    try { result = JSON.parse(rawText); } catch (_) { result = { ok: false, raw: rawText.substring(0, 300) }; }

    if (!response.ok) {
      await setStorageData({ debugLog: `[SUUMOビジネス] GAS応答エラー: HTTP ${response.status}` });
      return { ok: false, error: `HTTP ${response.status}` };
    }

    await setStorageData({
      debugLog: `[SUUMOビジネス] 完了: 送信${rows.length}件、GAS側更新${result.updated || '?'}件、新規${result.inserted || '?'}件`,
      suumoBusinessLastFetchAt: Date.now(),
      suumoBusinessLastCount: rows.length,
    });

    return { ok: true, count: rows.length, result };
  } catch (err) {
    console.error('[SUUMOビジネス] エラー:', err);
    await setStorageData({ debugLog: `[SUUMOビジネス] エラー: ${err.message}` });
    return { ok: false, error: err.message };
  } finally {
    _suumoBusinessFetchRunning = false;
  }
}

/**
 * Daily Search ページURLを構築
 *
 * filters_i / filters_d パラメータが必須。未指定だと /reportDaily へリダイレクトされる。
 * 以下2つのストレージキーから取得:
 *   - suumoBusinessFetchUrl: 完全URLが設定されていればそのまま使用(日付は差し替えない)
 *   - suumoBusinessKissCode: kiss_code のみ設定されていれば、日付は動的に計算
 *
 * 日付範囲はSUUMO仕様最大45日。直近のデータは反映遅延があるため
 *   pv_date_to   = 今日の2日前
 *   pv_date_from = pv_date_to の44日前 (45日inclusive)
 * を既定とする。
 *
 * @returns {Promise<string|null>} URL文字列、kiss_code未設定なら null
 */
async function buildSuumoBusinessDailyUrl() {
  const { suumoBusinessFetchUrl, suumoBusinessKissCode } = await getStorageData([
    'suumoBusinessFetchUrl', 'suumoBusinessKissCode'
  ]);

  // 完全URLが指定されていればそのまま使う(上級者向け: 自前で期間指定したい場合など)
  if (suumoBusinessFetchUrl && typeof suumoBusinessFetchUrl === 'string' && suumoBusinessFetchUrl.startsWith('https://business1.suumo.jp/')) {
    return suumoBusinessFetchUrl;
  }

  const kissCode = (suumoBusinessKissCode || '').toString().replace(/[^0-9]/g, '');
  if (!kissCode) return null;

  // pv_date_to = 今日-2日、pv_date_from = pv_date_to-44日 の45日ウィンドウ
  const fmt = (d) => {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}/${m}/${day}`;
  };
  const to = new Date();
  to.setDate(to.getDate() - 2);
  const from = new Date(to);
  from.setDate(from.getDate() - 44);

  // filters_i / filters_d は「キー=値__キー=値」形式を urlencode して送る
  const filtersI = `kiss_code=${kissCode}__passive_flag=1__empty_flag=1__conflict_flag=0`;
  const filtersD = `pv_date_from=${fmt(from)}__pv_date_to=${fmt(to)}`;

  return 'https://business1.suumo.jp/concierge/reportDailySearch'
    + `?filters_i=${encodeURIComponent(filtersI)}`
    + `&filters_d=${encodeURIComponent(filtersD)}`;
}

/**
 * Daily Search ページでテーブルをスクレイピング(コンテンツ側で実行)
 *
 * 戻り値: 物件ごとのオブジェクト配列。
 * 失敗時は空配列を返す。
 */
function scrapeSuumoBusinessTable() {
  try {
    const subRows = document.querySelectorAll('#sub tbody tr');
    const detRows = document.querySelectorAll('#detail tbody tr');
    if (!subRows.length || !detRows.length) return [];

    const toInt = (v) => {
      if (v === null || v === undefined) return 0;
      const s = String(v).replace(/,/g, '').trim();
      const n = parseInt(s, 10);
      return isNaN(n) ? 0 : n;
    };
    const cellText = (cell) => (cell ? (cell.innerText || '').trim() : '');

    const result = [];
    for (let i = 0; i < subRows.length; i++) {
      const s = subRows[i].cells;
      const detRow = detRows[i];
      if (!detRow) continue;
      const d = Array.from(detRow.cells).map((c) => cellText(c));

      const name = cellText(s[1]);
      const room = cellText(s[2]);
      if (!name && !room) continue; // 空行スキップ

      result.push({
        no: cellText(s[0]),
        name: name,
        room: room,
        line: d[2] || '',
        station: d[3] || '',
        walk: d[4] || '',
        layout: d[5] || '',
        area: d[6] || '',
        rent: d[7] || '',
        mgmt_fee: d[8] || '',
        total_fee: d[9] || '',
        address: d[10] || '',
        built_ym: d[11] || '',
        move_in: d[12] || '',
        trade_type: d[13] || '',
        suumo_code: d[15] || '',
        own_code: d[16] || '',
        listed_mark: d[17] || '',
        vacant_mark: d[18] || '',
        listed_days: toInt(d[19]),
        rep_list_pv: toInt(d[20]),
        rep_detail_pv: toInt(d[22]),
        transition_rate: d[24] || '',
        room_list_pv: toInt(d[27]),
        room_detail_pv: toInt(d[29]),
        total_list_pv: toInt(d[31]),
        total_detail_pv: toInt(d[33]),
        inquiries: toInt(d[35]),
        // 競合基準値別件数の列インデックス(実測で確定):
        //   i=40 → 第3基準値競合物件数
        //   i=41 → 第2基準値競合物件数
        //   i=42 → 第1基準値競合物件数
        // (画面上では第3→第2→第1の並び)
        comp_lv1_raw: d[42] || '',
        comp_lv2_raw: d[41] || '',
        comp_lv3_raw: d[40] || '',
        // 参考: 全セル生データ(デバッグ用途、初回調整時に確認するため保持)
        _all: d,
      });
    }
    return result;
  } catch (err) {
    console.error('[SUUMOビジネス] scrape error:', err);
    return [];
  }
}

/**
 * URLがSUUMOビジネスのログインページかどうか判定
 */
function isSuumoLoginUrl(url) {
  if (!url) return false;
  // login/signin 系のパスが含まれていればログインページ扱い
  return /business1\.suumo\.jp\/concierge(\/?$|\/signin|\/login|\/$)/i.test(url);
}

/**
 * タブの現在URLを取得
 */
async function getTabUrl(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    return (tab && tab.url) || '';
  } catch (_) {
    return '';
  }
}

/**
 * SUUMOビジネスへの自動ログインを1回だけ試みる
 *
 * 仕様:
 *   - オプション画面で設定されたID/PWを使用(未設定ならエラー)
 *   - フォームフィールドはサーバー側でオートフィルされている場合があるが、
 *     我々の保存値で上書きしてからsubmitする
 *   - 1回submitしたら待機して結果を検証する(エラー文言検知)
 *   - 失敗したら絶対にリトライしない(アカウントロック防止)
 *
 * @returns {Promise<{ok:boolean, error?:string}>}
 */
async function attemptSuumoBusinessLogin_(tabId) {
  const { suumoBusinessLoginId, suumoBusinessPassword } = await getStorageData([
    'suumoBusinessLoginId', 'suumoBusinessPassword'
  ]);
  if (!suumoBusinessLoginId || !suumoBusinessPassword) {
    return { ok: false, error: 'ID/パスワード未設定' };
  }

  await setStorageData({ debugLog: '[SUUMOビジネス] ログイン画面検知、自動ログイン試行(1回のみ)' });

  // フォームに値を入れて submit する。失敗検知のためエラー文言もついでに確認。
  let submitResult;
  try {
    const execResult = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [0] },
      func: (loginId, password) => {
        // 事前エラー文言チェック: 既に「利用することができません」が出ているなら即中止
        const bodyText = document.body ? document.body.innerText : '';
        const preError = /利用することができません|一定時間経過後/;
        if (preError.test(bodyText)) {
          return { submitted: false, preError: true, message: 'サービス利用不可メッセージあり(アカウントロック中の可能性)' };
        }

        // フォーム特定
        const form = document.querySelector('form[action*="/concierge/signin"]')
          || document.querySelector('form');
        if (!form) return { submitted: false, error: 'form not found' };

        const idInput = form.querySelector('input[name="loginId"]');
        const pwInput = form.querySelector('input[name="password"]');
        const submitBtn = form.querySelector('input[type="submit"], button[type="submit"]');
        if (!idInput || !pwInput) return { submitted: false, error: 'id/password input not found' };
        if (!submitBtn) return { submitted: false, error: 'submit button not found' };

        // 既存値を上書き(オートフィル値を信用しない)
        idInput.value = loginId;
        pwInput.value = password;
        // inputイベントを発火(フレームワークが監視している場合向け)
        idInput.dispatchEvent(new Event('input', { bubbles: true }));
        pwInput.dispatchEvent(new Event('input', { bubbles: true }));

        // 念のため form.action を確認(signin以外なら誤作動防止で中止)
        const action = (form.action || '').toString();
        if (!/\/concierge\/signin/i.test(action)) {
          return { submitted: false, error: 'form action unexpected: ' + action };
        }

        submitBtn.click();
        return { submitted: true };
      },
      args: [suumoBusinessLoginId, suumoBusinessPassword],
    });
    submitResult = execResult && execResult[0] && execResult[0].result;
  } catch (err) {
    return { ok: false, error: 'script inject failed: ' + err.message };
  }

  if (!submitResult) return { ok: false, error: 'no result from injected script' };
  if (submitResult.preError) return { ok: false, error: submitResult.message };
  if (!submitResult.submitted) return { ok: false, error: submitResult.error || 'submit skipped' };

  // submitによるページ遷移を待つ
  try {
    await waitForTabLoad(tabId, 30000);
  } catch (err) {
    return { ok: false, error: 'navigation timeout after submit' };
  }
  await sleep(1500);

  // 遷移後のDOMからエラー文言を検出(ログイン失敗/ロックメッセージ)
  let postCheck;
  try {
    const execResult = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [0] },
      func: () => {
        const url = location.href;
        const bodyText = document.body ? document.body.innerText : '';
        const hasLockMsg = /利用することができません|一定時間経過後/.test(bodyText);
        const hasAuthErr = /(ID|パスワード).*(誤|間違|不正|一致しません)/.test(bodyText)
                        || /認証に失敗/.test(bodyText);
        return { url, hasLockMsg, hasAuthErr };
      },
    });
    postCheck = execResult && execResult[0] && execResult[0].result;
  } catch (err) {
    return { ok: false, error: 'post-check inject failed: ' + err.message };
  }

  if (!postCheck) return { ok: false, error: 'no post-check result' };
  if (postCheck.hasLockMsg) return { ok: false, error: 'アカウントロックメッセージ検知' };
  if (postCheck.hasAuthErr) return { ok: false, error: 'ID/PW不一致メッセージ検知' };
  // まだログインページのままなら失敗扱い
  if (isSuumoLoginUrl(postCheck.url)) return { ok: false, error: 'submit後もログインページのまま' };

  await setStorageData({ debugLog: '[SUUMOビジネス] 自動ログイン成功' });
  return { ok: true };
}

/**
 * タブの読み込み完了を待つ
 */
function waitForTabLoad(tabId, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error('タブ読み込みタイムアウト'));
    }, timeoutMs || 60000);

    const listener = (updatedTabId, changeInfo) => {
      if (updatedTabId === tabId && changeInfo.status === 'complete') {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(listener);

    // 既に完了している可能性もあるのでチェック
    chrome.tabs.get(tabId, (tab) => {
      if (chrome.runtime.lastError) {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (tab && tab.status === 'complete') {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    });
  });
}
