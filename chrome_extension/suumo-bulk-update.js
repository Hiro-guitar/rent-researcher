/**
 * suumo-bulk-update.js
 * SUUMOビジネス(fn.forrent.jp)の物件広告一括更新を1日1回実行する
 *
 * フロー:
 *   1. SUUMO巡回終了後フックから呼ばれる
 *   2. JST日付チェック (lastSuumoBulkUpdateDate) で当日未実施を確認
 *   3. fn.forrent.jp タブを別途作成 → 自動ログイン
 *   4. パスワード期限切れバナー検知時はスキップ + 警告通知
 *   5. 「更新・掲載指示」→「元付確認」タブへ遷移
 *   6. ページ単位で [全選択 → 一括更新実行] を bukkenCdList=0 まで繰り返し
 *   7. 完了/失敗を Discord (SUUMO巡回スレッド) に通知
 *   8. 失敗時は翌日リトライ
 */

const _SUUMO_BULK_UPDATE_LOCK = '_suumoBulkUpdateRunning';
const _SUUMO_BULK_UPDATE_MAX_PAGES = 30;

/**
 * SUUMO巡回終了後フック: 当日未実施なら広告一括更新を実行
 */
async function maybeRunSuumoBulkAdUpdate() {
  if (globalThis[_SUUMO_BULK_UPDATE_LOCK]) {
    await setStorageData({ debugLog: '[SUUMO広告一括更新] 既に実行中のためスキップ' });
    return;
  }
  globalThis[_SUUMO_BULK_UPDATE_LOCK] = true;
  try {
    const todayJst = _jstDateString();
    const { lastSuumoBulkUpdateDate } = await getStorageData(['lastSuumoBulkUpdateDate']);
    if (lastSuumoBulkUpdateDate === todayJst) {
      await setStorageData({ debugLog: `[SUUMO広告一括更新] 本日(${todayJst})は実施済みのためスキップ` });
      return;
    }

    await setStorageData({ debugLog: `[SUUMO広告一括更新] 開始 (${todayJst})` });
    const result = await _runSuumoBulkAdUpdate();

    if (result.ok) {
      await setStorageData({
        lastSuumoBulkUpdateDate: todayJst,
        lastSuumoBulkUpdateError: '',
        debugLog: `[SUUMO広告一括更新] 完了: ${result.totalUpdated}件 (${result.pagesProcessed}ページ)`
      });
    } else {
      await setStorageData({
        lastSuumoBulkUpdateError: result.error || 'unknown',
        debugLog: `[SUUMO広告一括更新] 失敗: ${result.error} → 翌日リトライ`
      });
    }
    try { await _notifyBulkUpdateResult(result); } catch (_) {}
  } catch (err) {
    await setStorageData({ debugLog: `[SUUMO広告一括更新] 例外: ${err.message}` });
    try { await _notifyBulkUpdateResult({ ok: false, error: err.message }); } catch (_) {}
  } finally {
    globalThis[_SUUMO_BULK_UPDATE_LOCK] = false;
  }
}

function _jstDateString() {
  const jst = new Date(Date.now() + 9 * 60 * 60 * 1000);
  return jst.getUTCFullYear() + '-'
    + String(jst.getUTCMonth() + 1).padStart(2, '0') + '-'
    + String(jst.getUTCDate()).padStart(2, '0');
}

/**
 * メインの一括更新処理
 */
async function _runSuumoBulkAdUpdate() {
  let tabId = null;
  try {
    const tab = await chrome.tabs.create({
      url: 'https://www.fn.forrent.jp/fn/',
      active: false
    });
    tabId = tab.id;

    try { await waitForTabLoad(tabId); } catch (_) {}
    await sleep(2500);

    // パスワード期限切れバナー検知
    const initialState = await _inspectBulkPage(tabId);
    if (initialState.passwordExpired) {
      return { ok: false, error: 'forrent パスワード期限切れ(画面にバナー表示あり)。手動でパスワード変更が必要' };
    }

    // ログインフォームが見えていればログイン実行
    if (initialState.hasLoginForm) {
      if (typeof doForrentLogin_ !== 'function') {
        return { ok: false, error: 'doForrentLogin_ 関数が見つからない (forrent-status-sync.js のロード順を確認)' };
      }
      const loginResult = await doForrentLogin_(tabId);
      if (!loginResult.ok) {
        return { ok: false, error: 'ForRentログイン失敗: ' + loginResult.error };
      }
      // ログイン後の状態確認
      await sleep(1500);
      const after = await _inspectBulkPage(tabId);
      if (after.passwordExpired) {
        return { ok: false, error: 'forrent パスワード期限切れ(ログイン後)' };
      }
    }

    // 「更新・掲載指示」メニュー → 「元付確認」タブへ
    const navResult = await _navigateToMototsukeTab(tabId);
    if (!navResult.ok) {
      return { ok: false, error: '元付確認タブへの遷移失敗: ' + navResult.error };
    }

    // ページ単位で繰り返し
    let totalUpdated = 0;
    let pagesProcessed = 0;
    for (let i = 0; i < _SUUMO_BULK_UPDATE_MAX_PAGES; i++) {
      await sleep(2000);
      const pageInfo = await _getMototsukePageInfo(tabId);
      if (!pageInfo.ok) {
        return { ok: false, error: '元付確認ページ情報取得失敗: ' + pageInfo.error, totalUpdated, pagesProcessed };
      }
      if (pageInfo.bukkenCount === 0) {
        return { ok: true, totalUpdated, pagesProcessed };
      }

      const execResult = await _executePageBulkUpdate(tabId);
      if (!execResult.ok) {
        return { ok: false, error: '一括更新実行失敗: ' + execResult.error, totalUpdated, pagesProcessed };
      }
      totalUpdated += execResult.count || pageInfo.bukkenCount;
      pagesProcessed++;

      // submit後のナビゲーション完了を待つ
      try { await waitForTabLoad(tabId, 30000); } catch (_) {}
      await sleep(2500);

      // 結果画面から元付確認タブに戻る
      const back = await _navigateToMototsukeTab(tabId);
      if (!back.ok) {
        // 戻れなければ完了画面のまま終了 (1ページしか処理していなかったケース等)
        return { ok: true, totalUpdated, pagesProcessed, note: '元付確認タブへの再遷移失敗だが処理は実行済み' };
      }
    }
    // ループ上限に達した
    return { ok: false, error: `ページ処理上限(${_SUUMO_BULK_UPDATE_MAX_PAGES})に到達。一括更新が無限ループしている可能性`, totalUpdated, pagesProcessed };
  } finally {
    if (tabId !== null) {
      try { await chrome.tabs.remove(tabId); } catch (_) {}
    }
  }
}

/**
 * 現在のタブのフレーム状態を調査
 *  - hasLoginForm: ログインフォーム有無
 *  - passwordExpired: パスワード期限切れバナー検知
 */
async function _inspectBulkPage(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: () => {
        const text = (document.body && document.body.innerText) || '';
        const expired = /パスワード(の有効期限|有効期限)が切れ/.test(text);
        const hasLoginForm = !!document.querySelector('form[action*="login.action"]');
        return { expired, hasLoginForm, url: location.href };
      }
    });
    let passwordExpired = false, hasLoginForm = false;
    for (const r of results || []) {
      if (r && r.result) {
        if (r.result.expired) passwordExpired = true;
        if (r.result.hasLoginForm) hasLoginForm = true;
      }
    }
    return { passwordExpired, hasLoginForm };
  } catch (err) {
    return { passwordExpired: false, hasLoginForm: false, error: err.message };
  }
}

/**
 * 「更新・掲載指示」→「元付確認」タブへ遷移
 */
async function _navigateToMototsukeTab(tabId) {
  try {
    // navi フレームの menu_3 (掲載指示メニュー) をクリック
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: () => {
        const menu3 = document.getElementById('menu_3');
        if (menu3 && (window.name === 'navi' || /掲載指示/.test(menu3.title || menu3.alt || ''))) {
          menu3.click();
          return { clicked: 'menu_3' };
        }
        return null;
      }
    });
    await sleep(2000);
    try { await waitForTabLoad(tabId, 15000); } catch (_) {}

    // 元付確認タブをクリック
    const tabClickResults = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: () => {
        const link = document.querySelector('a[name="mototsuke"]');
        if (link) {
          link.click();
          return { clicked: true };
        }
        return null;
      }
    });
    let tabClicked = false;
    for (const r of tabClickResults || []) {
      if (r && r.result && r.result.clicked) tabClicked = true;
    }
    if (!tabClicked) {
      return { ok: false, error: '元付確認タブのリンクが見つからない' };
    }
    await sleep(2000);
    try { await waitForTabLoad(tabId, 15000); } catch (_) {}
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * 元付確認ページの bukkenCdList 件数を取得
 */
async function _getMototsukePageInfo(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: () => {
        if (typeof window.bukkenCdList === 'undefined') return null;
        const list = window.bukkenCdList || [];
        return { bukkenCount: list.length, url: location.href };
      }
    });
    for (const r of results || []) {
      if (r && r.result && typeof r.result.bukkenCount === 'number') {
        return { ok: true, bukkenCount: r.result.bukkenCount };
      }
    }
    return { ok: false, error: 'bukkenCdList を持つフレームが見つからない' };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * 1ページ分の一括更新を実行 (全選択 → submit)
 */
async function _executePageBulkUpdate(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: () => {
        if (typeof window.bukkenCdList === 'undefined') return null;
        const list = window.bukkenCdList || [];
        if (list.length === 0) return { skipped: true };

        const chk0 = document.querySelector('#chk0');
        const exec = document.querySelector('#exec0');
        if (!chk0 || !exec) {
          return { error: 'chk0 または exec0 が見つからない' };
        }

        chk0.checked = true;
        try {
          if (typeof window.ikCheckKakuninOnOff === 'function') {
            window.ikCheckKakuninOnOff(list, true);
          }
        } catch (e) { return { error: 'ikCheckKakuninOnOff: ' + e.message }; }
        try {
          if (typeof window.toggleExecBtnDisable === 'function') {
            window.toggleExecBtnDisable(list, ['confirm', 'seiyaku']);
          }
        } catch (e) { return { error: 'toggleExecBtnDisable: ' + e.message }; }

        if (exec.disabled) {
          return { error: '実行ボタンが有効化されない' };
        }

        const form = document.mainForm || document.forms['mainForm'];
        if (!form) return { error: 'mainForm が見つからない' };

        try {
          if (typeof window.ImageButton !== 'undefined'
            && window.ImageButton
            && typeof window.ImageButton.onceSubmit === 'function') {
            window.ImageButton.onceSubmit(form, null, exec);
          } else {
            form.submit();
          }
        } catch (e) {
          return { error: 'submit実行例外: ' + e.message };
        }
        return { submitted: true, count: list.length };
      }
    });
    for (const r of results || []) {
      if (r && r.result) {
        if (r.result.error) return { ok: false, error: r.result.error };
        if (r.result.submitted) return { ok: true, count: r.result.count };
        if (r.result.skipped) return { ok: true, count: 0 };
      }
    }
    return { ok: false, error: '実行スクリプトが応答しない' };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Discord通知 (SUUMO巡回スレッドに混ぜる)
 */
async function _notifyBulkUpdateResult(result) {
  const { suumoDiscordWebhookUrl } = await getStorageData(['suumoDiscordWebhookUrl']);
  if (!suumoDiscordWebhookUrl) return;
  if (typeof getOrCreateSuumoDailyThread_ !== 'function') return;
  const threadId = await getOrCreateSuumoDailyThread_(suumoDiscordWebhookUrl);

  let content;
  if (result.ok) {
    content = `🔄 **SUUMO広告一括更新 完了**\n`
      + `更新件数: ${result.totalUpdated || 0}件 (${result.pagesProcessed || 0}ページ)`;
    if (result.note) content += `\n${result.note}`;
  } else {
    content = `⚠️ **SUUMO広告一括更新 失敗**\n`
      + `理由: ${result.error || 'unknown'}\n`
      + `(明日のSUUMO巡回でリトライします)`;
    if (typeof result.totalUpdated === 'number' && result.totalUpdated > 0) {
      content += `\n途中まで: ${result.totalUpdated}件 (${result.pagesProcessed || 0}ページ)`;
    }
  }
  let postUrl = suumoDiscordWebhookUrl;
  if (threadId) {
    postUrl = suumoDiscordWebhookUrl
      + (suumoDiscordWebhookUrl.indexOf('?') >= 0 ? '&' : '?')
      + 'thread_id=' + encodeURIComponent(threadId);
  }
  try {
    await fetch(postUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content })
    });
  } catch (_) {}
}

globalThis.maybeRunSuumoBulkAdUpdate = maybeRunSuumoBulkAdUpdate;
