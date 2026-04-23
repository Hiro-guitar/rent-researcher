/**
 * forrent-final-submit.js — ForRent確認画面の「登録」ボタン自動クリック(Phase 5)
 *
 * suumo-fill-auto.js がフォーム入力 → 「確認画面へ」遷移まで完了した後、
 * 確認画面 (REG1R12001.action) に到達したらこのモジュールが:
 *   1. 確認画面であることを複数条件で検証
 *   2. 画像アップロード結果をチェック(承認時に指定したジャンル数 == 成功数)
 *   3. ドライランモードなら直前で停止してタブ保持
 *   4. 全チェック通過したら #jikko (登録ボタン img) をクリック
 *   5. 結果を検証してログに出す
 *
 * エラー時は絶対に登録しない・タブを残す・ログに明記する。
 */

// 状態管理
let _forrentFinalSubmitRunning = false;

/**
 * ForRent確認画面で登録を実行する
 *
 * @param {Object} opts
 *   - tabId {number} 対象タブID (suumoFillTabId)
 *   - imageGenresCount {number} 承認時に設定された画像ジャンル数(期待値)
 *   - imageUploadStats {Object} { tried, success, failed } 実際のアップロード結果
 * @returns {Promise<{ok, dryRun?, error?, skipped?, abortReason?}>}
 */
async function tryForrentFinalSubmit(opts) {
  if (_forrentFinalSubmitRunning) {
    return { ok: false, error: '既に最終登録処理実行中' };
  }
  _forrentFinalSubmitRunning = true;

  const tabId = opts && opts.tabId;
  if (!tabId) {
    _forrentFinalSubmitRunning = false;
    return { ok: false, error: 'tabId 未指定' };
  }

  try {
    await setStorageData({ debugLog: '[Phase5] 最終登録処理開始' });

    // ドライラン判定(既定true。明示でfalseにするまで本番実行しない)
    const { suumoFinalSubmitDryRun } = await getStorageData(['suumoFinalSubmitDryRun']);
    const dryRun = suumoFinalSubmitDryRun === false ? false : true; // 未設定/trueなら dryRun

    // 1. 確認画面であることの検証
    const pageCheck = await checkConfirmScreen_(tabId);
    if (!pageCheck.ok) {
      await setStorageData({ debugLog: `[Phase5] 確認画面検証NG: ${pageCheck.error}` });
      return { ok: false, error: 'not on confirm screen: ' + pageCheck.error };
    }
    await setStorageData({ debugLog: `[Phase5] 確認画面検証OK (URL=${pageCheck.url})` });

    // 2. 画像アップロード結果の整合性チェック
    //    「承認時のジャンル設定数」と「実際のアップロード成功数」を比較
    //    - 両方0: 意図的に画像なし → OK
    //    - expected > 0 かつ success < expected: 画像欠損 → abort
    const expected = Number(opts.imageGenresCount) || 0;
    const stats = opts.imageUploadStats || { tried: 0, success: 0, failed: 0 };
    const actualSuccess = Number(stats.success) || 0;
    if (expected > 0 && actualSuccess < expected) {
      await setStorageData({
        debugLog: `[Phase5] ⚠️ 画像アップロード不完全 (期待${expected}枚/成功${actualSuccess}枚) → 登録中止`
      });
      try { await chrome.tabs.update(tabId, { active: true }); } catch (_) {}
      return {
        ok: false,
        abortReason: 'image_mismatch',
        error: `画像${expected}枚指定のうち${actualSuccess}枚しか成功していない`,
        imageCheck: { expected, success: actualSuccess, failed: stats.failed }
      };
    }
    if (expected === 0) {
      await setStorageData({ debugLog: '[Phase5] 画像ジャンル未設定(意図的に画像なし)と判定' });
    } else {
      await setStorageData({ debugLog: `[Phase5] 画像整合性OK (${actualSuccess}枚/${expected}枚)` });
    }

    // 3. 登録ボタンが有効であることの確認
    const buttonCheck = await checkRegisterButtonEnabled_(tabId);
    if (!buttonCheck.ok) {
      await setStorageData({ debugLog: `[Phase5] 登録ボタン状態NG: ${buttonCheck.error}` });
      try { await chrome.tabs.update(tabId, { active: true }); } catch (_) {}
      return { ok: false, abortReason: 'button_disabled', error: buttonCheck.error };
    }

    // 4. ドライランならここで停止
    if (dryRun) {
      try { await chrome.tabs.update(tabId, { active: true }); } catch (_) {}
      await setStorageData({
        debugLog: '[Phase5] DRY RUN: 全チェック通過、登録ボタン直前で停止。タブを残したので手動で「登録」を押してください'
      });
      return { ok: true, dryRun: true };
    }

    // 5. 本番: 登録ボタン (#jikko) をクリック
    const clickResult = await clickRegisterButton_(tabId);
    if (!clickResult.ok) {
      await setStorageData({ debugLog: `[Phase5] 登録クリック失敗: ${clickResult.error}` });
      try { await chrome.tabs.update(tabId, { active: true }); } catch (_) {}
      return { ok: false, error: clickResult.error };
    }
    await setStorageData({ debugLog: '[Phase5] 登録ボタンクリック実行' });

    // 6. 登録後の遷移確認
    await sleep(3000);
    const postCheck = await checkPostSubmit_(tabId);
    if (postCheck.stayed) {
      // 確認画面に留まっている = 何かエラーで戻された or まだ処理中
      await sleep(3000);
      const recheck = await checkPostSubmit_(tabId);
      if (recheck.stayed) {
        try { await chrome.tabs.update(tabId, { active: true }); } catch (_) {}
        await setStorageData({
          debugLog: `[Phase5] ⚠️ 登録後も確認画面のまま。手動確認してください。エラー検出: ${JSON.stringify(recheck.errors || []).substring(0, 200)}`
        });
        return {
          ok: false,
          error: '登録クリック後も確認画面のまま',
          postErrors: recheck.errors
        };
      }
    }

    await setStorageData({ debugLog: `[Phase5] 登録完了 (遷移先URL: ${postCheck.url})` });
    return { ok: true, finalUrl: postCheck.url };

  } catch (err) {
    console.error('[Phase5] エラー:', err);
    await setStorageData({ debugLog: `[Phase5] エラー: ${err.message}` });
    if (tabId) {
      try { await chrome.tabs.update(tabId, { active: true }); } catch (_) {}
    }
    return { ok: false, error: err.message };
  } finally {
    _forrentFinalSubmitRunning = false;
  }
}

/**
 * 確認画面にいるかを複数条件で検証
 *
 * 条件AND:
 *   - mainフレーム内の URL が REG1R12001.action
 *   - document.title = '物件新規登録確認'
 *   - h1#headerTitle のテキストに "新規物件登録確認"
 *   - #jikko と #teisei が両方存在
 *   - forms['confirmForm'] が存在
 */
async function checkConfirmScreen_(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: () => {
        const url = location.href;
        if (!/REG1R12001\.action/.test(url)) return null;

        const titleOk = /物件新規登録確認/.test(document.title || '');
        const h1 = document.getElementById('headerTitle');
        const h1Ok = h1 && /新規物件登録確認/.test((h1.innerText || '').trim());
        const jikko = document.getElementById('jikko');
        const teisei = document.getElementById('teisei');
        const buttonsOk = !!jikko && !!teisei;
        const formOk = !!document.forms['confirmForm'];

        return {
          ok: titleOk && h1Ok && buttonsOk && formOk,
          url,
          titleOk,
          h1Ok,
          buttonsOk,
          formOk,
          error: (!titleOk ? 'title NG; ' : '')
               + (!h1Ok ? 'h1 NG; ' : '')
               + (!buttonsOk ? 'buttons NG; ' : '')
               + (!formOk ? 'form NG; ' : '')
        };
      }
    });
    for (const r of results || []) {
      if (r && r.result) return r.result;
    }
    return { ok: false, error: 'mainフレームに確認画面が見つからない' };
  } catch (err) {
    return { ok: false, error: 'script inject failed: ' + err.message };
  }
}

/**
 * #jikko (登録ボタン) が有効(disabled属性がない)ことを確認
 */
async function checkRegisterButtonEnabled_(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: () => {
        const btn = document.getElementById('jikko');
        if (!btn) return null;
        const disabled = btn.disabled || btn.hasAttribute('disabled');
        return { ok: !disabled, disabled };
      }
    });
    for (const r of results || []) {
      if (r && r.result) {
        if (r.result.ok) return { ok: true };
        return { ok: false, error: '登録ボタンが無効化されている' };
      }
    }
    return { ok: false, error: '#jikko が見つからない' };
  } catch (err) {
    return { ok: false, error: 'script inject failed: ' + err.message };
  }
}

/**
 * 登録ボタンをクリック
 */
async function clickRegisterButton_(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: () => {
        const btn = document.getElementById('jikko');
        if (!btn) return null;
        if (btn.disabled || btn.hasAttribute('disabled')) {
          return { ok: false, error: 'ボタンが無効化' };
        }
        // onclick 属性のコードが ImageButton.onceSubmit(confirmForm, ...) を呼ぶ。
        // img.click() で onclick が発火する。
        btn.click();
        return { ok: true };
      }
    });
    for (const r of results || []) {
      if (r && r.result && r.result.ok !== undefined) return r.result;
    }
    return { ok: false, error: 'mainフレームで click 実行できず' };
  } catch (err) {
    return { ok: false, error: 'script inject failed: ' + err.message };
  }
}

/**
 * 登録クリック後の状態確認
 */
async function checkPostSubmit_(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: () => {
        const url = location.href;
        const stayedOnConfirm = /REG1R12001\.action/.test(url);
        let errors = [];
        if (stayedOnConfirm) {
          // エラー要素をスキャン
          const errEls = document.querySelectorAll(
            '[class*="error"], [class*="Error"], [class*="alert"], [id*="error"], [id*="Error"], .msg, .message'
          );
          errors = Array.from(errEls)
            .filter(e => e.offsetParent !== null && (e.innerText || '').trim().length > 0)
            .map(e => (e.innerText || '').trim().substring(0, 150))
            .slice(0, 5);
        }
        return { url, stayed: stayedOnConfirm, errors };
      }
    });
    for (const r of results || []) {
      if (r && r.result && r.result.url) return r.result;
    }
    return { url: '', stayed: false, errors: [] };
  } catch (_) {
    return { url: '', stayed: false, errors: [] };
  }
}
