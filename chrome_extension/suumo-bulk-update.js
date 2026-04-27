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
        debugLog: `[SUUMO広告一括更新] 失敗: ${result.error} → 次回巡回でリトライ`
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

    let passwordExpiredWarn = false;

    // パスワード期限切れバナーは警告のみ (機能自体は使える想定で続行)
    const initialState = await _inspectBulkPage(tabId);
    if (initialState.passwordExpired) passwordExpiredWarn = true;

    // ログインフォームが見えていればログイン実行
    if (initialState.hasLoginForm) {
      if (typeof doForrentLogin_ !== 'function') {
        return { ok: false, error: 'doForrentLogin_ 関数が見つからない (forrent-status-sync.js のロード順を確認)', passwordExpiredWarn };
      }
      const loginResult = await doForrentLogin_(tabId);
      if (!loginResult.ok) {
        return { ok: false, error: 'ForRentログイン失敗: ' + loginResult.error, passwordExpiredWarn };
      }
      await sleep(1500);
      const after = await _inspectBulkPage(tabId);
      if (after.passwordExpired) passwordExpiredWarn = true;
    }
    if (passwordExpiredWarn) {
      await setStorageData({ debugLog: '[SUUMO広告一括更新] 警告: パスワード期限切れバナーあり (続行)' });
    }

    // 「更新・掲載指示」メニュー → 「元付確認」タブへ
    const navResult = await _navigateToMototsukeTab(tabId);
    if (!navResult.ok) {
      return { ok: false, error: '元付確認タブへの遷移失敗: ' + navResult.error, passwordExpiredWarn };
    }

    // ページ単位で繰り返し
    let totalUpdated = 0;
    let pagesProcessed = 0;
    for (let i = 0; i < _SUUMO_BULK_UPDATE_MAX_PAGES; i++) {
      await sleep(2000);
      const pageInfo = await _getMototsukePageInfo(tabId);
      if (!pageInfo.ok) {
        return { ok: false, error: '元付確認ページ情報取得失敗: ' + pageInfo.error, totalUpdated, pagesProcessed, passwordExpiredWarn };
      }
      if (pageInfo.bukkenCount === 0) {
        return { ok: true, totalUpdated, pagesProcessed, passwordExpiredWarn };
      }

      const execResult = await _executePageBulkUpdate(tabId);
      if (!execResult.ok) {
        return { ok: false, error: '一括更新実行失敗: ' + execResult.error, totalUpdated, pagesProcessed, passwordExpiredWarn };
      }
      totalUpdated += execResult.count || pageInfo.bukkenCount;
      pagesProcessed++;

      // submit後のナビゲーション完了を待つ (確認画面に遷移)
      try { await waitForTabLoad(tabId, 30000); } catch (_) {}
      await sleep(2500);

      // 確認画面で再度「一括更新実行」をクリック (2段階submit)
      const confirmResult = await _confirmAndExecuteIfNeeded(tabId);
      if (confirmResult.clicked) {
        try { await waitForTabLoad(tabId, 30000); } catch (_) {}
        await sleep(2500);
      }

      // 結果画面から元付確認タブに戻る
      const back = await _navigateToMototsukeTab(tabId);
      if (!back.ok) {
        // 戻れなければ完了画面のまま終了 (1ページしか処理していなかったケース等)
        return { ok: true, totalUpdated, pagesProcessed, passwordExpiredWarn, note: '元付確認タブへの再遷移失敗だが処理は実行済み' };
      }
    }
    return { ok: false, error: `ページ処理上限(${_SUUMO_BULK_UPDATE_MAX_PAGES})に到達。一括更新が無限ループしている可能性`, totalUpdated, pagesProcessed, passwordExpiredWarn };
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
    // 掲載指示メニュー (menu_3) を含むフレームでクリック
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: () => {
        const menu3 = document.getElementById('menu_3');
        if (menu3) {
          menu3.click();
          return { clicked: 'menu_3', frame: window.name || '(top)' };
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
      world: 'MAIN',
      func: () => {
        try {
          if (typeof bukkenCdList === 'undefined') return null;
          const list = bukkenCdList || [];
          return { bukkenCount: list.length, url: location.href };
        } catch (_) { return null; }
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
      world: 'MAIN',
      func: () => {
        try {
          if (typeof bukkenCdList === 'undefined') return null;
        } catch (_) { return null; }
        const list = bukkenCdList || [];
        if (list.length === 0) return { skipped: true };

        const chk0 = document.querySelector('#chk0');
        const exec = document.querySelector('#exec0');
        if (!chk0 || !exec) {
          return { error: 'chk0 または exec0 が見つからない' };
        }

        chk0.checked = true;
        try {
          if (typeof ikCheckKakuninOnOff === 'function') {
            ikCheckKakuninOnOff(list, true);
          }
        } catch (e) { return { error: 'ikCheckKakuninOnOff: ' + e.message }; }
        try {
          if (typeof toggleExecBtnDisable === 'function') {
            toggleExecBtnDisable(list, ['confirm', 'seiyaku']);
          }
        } catch (e) { return { error: 'toggleExecBtnDisable: ' + e.message }; }

        if (exec.disabled) {
          return { error: '実行ボタンが有効化されない' };
        }

        const form = document.mainForm || document.forms['mainForm'];
        if (!form) return { error: 'mainForm が見つからない' };

        try {
          if (typeof ImageButton !== 'undefined' && ImageButton && typeof ImageButton.onceSubmit === 'function') {
            ImageButton.onceSubmit(form, null, exec);
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
 * 確認画面で「一括更新実行」を再クリック (2段階submit)
 *
 * 確認画面 (UPD1R3210.action) の構造:
 *   - URL pathname: /fn/UPD1R3210.action
 *   - 実行ボタン: #update1 (or #update2) - id="update1", name="button/UPD1R3910"
 *   - 「訂正」ボタン: #back1 / #back2 (戻る、誤押下しないこと)
 *   - フォーム: form1 (mainForm ではない)
 *   - ImageButton.onceSubmit は利用可だが update1.click() の方が安全
 *     (onclick内でImageButton.onceSubmit(form1, this.name, ...) が呼ばれる)
 *   - 押下後は自動で UPD1R2800 (一覧) にリダイレクトで戻る
 *   - chk0 / bukkenCdList / exec0 は確認画面には存在しない
 */
async function _confirmAndExecuteIfNeeded(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      world: 'MAIN',
      func: () => {
        // 確認画面の判定: #update1 が存在し、かつ chk0 が存在しない
        const update1 = document.getElementById('update1');
        if (!update1) return { type: 'no-update1' };
        if (document.getElementById('chk0')) return { type: 'list-page' };

        // 「訂正」ボタンを誤って押さないよう update1 を直接クリック
        try {
          update1.click();
          return { type: 'confirm-clicked' };
        } catch (e) {
          return { type: 'confirm-error', error: e.message };
        }
      }
    });
    for (const r of results || []) {
      if (r && r.result && r.result.type === 'confirm-clicked') {
        return { clicked: true };
      }
      if (r && r.result && r.result.type === 'confirm-error') {
        return { clicked: false, error: r.result.error };
      }
    }
    return { clicked: false };
  } catch (err) {
    return { clicked: false, error: err.message };
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
      + `(次回のSUUMO巡回でリトライします)`;
    if (typeof result.totalUpdated === 'number' && result.totalUpdated > 0) {
      content += `\n途中まで: ${result.totalUpdated}件 (${result.pagesProcessed || 0}ページ)`;
    }
  }
  if (result.passwordExpiredWarn) {
    content += `\n⚠️ パスワード有効期限が切れています(画面バナー表示あり)。早めに変更推奨`;
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
