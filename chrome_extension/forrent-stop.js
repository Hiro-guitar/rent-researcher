/**
 * forrent-stop.js — ForRent(SUUMO入稿システム)からの物件を「成約」に変更して停止
 *
 * SUUMO物件コード(12桁)を指定すると以下を自動実行:
 *   1. PUB1R2801.action (情報更新一覧)を開く
 *   2. 物件コードで検索
 *   3. 検索結果1件を確認後、対象行の「空室」ボタンをクリック
 *      → toggleSeiyaku() が発動 → seiyakuFlg=1(成約), shijiButton が有効化
 *   4. #shijiButton (一括更新実行) をクリック
 *      → formToUpdate() → POST PUB1R3900BD.action
 *   5. 完了画面で成功判定
 *
 * 安全策:
 *   - 既定ではドライラン(shijiButton直前で停止、タブは残す)
 *   - オプション画面の suumoForrentStopDryRun=false で本番実行可能
 *   - 検索結果0件/2件以上なら中止
 *   - 既に成約(seiyakuFlg=1)なら何もせず alreadyStopped: true で返す
 *   - 直接 PUB1R2801.action を開いて完結するため frameset 遷移不要
 *
 * background.js から importScripts('forrent-stop.js') で読み込む前提。
 */

let _forrentStopRunning = false;

/**
 * ForRentで物件を停止(成約化)する
 *
 * @param {Object} opts
 *   - suumoPropertyCode {string} 12桁のSUUMO物件コード(必須)
 *   - dryRun {boolean}            送信直前で止めるか(未指定ならストレージから取得、既定true)
 * @returns {Promise<{ok:boolean, error?:string, dryRun?:boolean, alreadyStopped?:boolean, stoppedAt?:string}>}
 */
async function stopForrentListing(opts) {
  if (_forrentStopRunning) {
    return { ok: false, error: '既に停止処理実行中' };
  }

  const suumoCode = String((opts && opts.suumoPropertyCode) || '').replace(/[^0-9]/g, '');
  if (!suumoCode) return { ok: false, error: 'suumo_property_code 未指定' };
  if (suumoCode.length !== 12) return { ok: false, error: `物件コードは12桁である必要があります(受信: ${suumoCode})` };

  // ドライラン判定(明示指定 > ストレージ > デフォルトtrue)
  let dryRun;
  if (typeof opts.dryRun === 'boolean') {
    dryRun = opts.dryRun;
  } else {
    const { suumoForrentStopDryRun } = await getStorageData(['suumoForrentStopDryRun']);
    dryRun = (suumoForrentStopDryRun === undefined || suumoForrentStopDryRun === null) ? true : !!suumoForrentStopDryRun;
  }

  _forrentStopRunning = true;
  let tabId = null;

  try {
    await setStorageData({ debugLog: `[ForRent停止] 開始 suumoCode=${suumoCode} dryRun=${dryRun}` });

    // 1. 情報更新一覧を開く (直接アクセスで frameset 回避)
    const searchUrl = 'https://www.fn.forrent.jp/fn/PUB1R2801.action';
    const tab = await chrome.tabs.create({ url: searchUrl, active: false });
    tabId = tab.id;

    await waitForTabLoad(tabId, 60000);
    await sleep(1500);

    // 2. 検索フォーム表示を待つ
    const formReady = await waitForMainFrameCondition_(tabId, () => {
      const input = document.querySelector('input.bukkenCdInput');
      if (!input) return null;
      const searchBtn = Array.from(document.querySelectorAll('input[type="submit"]'))
        .find(b => (b.value || '').trim() === '検索');
      if (!searchBtn) return null;
      return { ok: true, url: location.href };
    }, 60000);

    if (!formReady) {
      throw new Error('検索フォームが表示されない(ForRentログイン切れの可能性)');
    }

    // 3. 物件コードを入力して検索実行
    const searchExec = await runInMainFrame_(tabId, (code) => {
      const input = document.querySelector('input.bukkenCdInput');
      if (!input) return null;
      input.value = code;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      const searchBtn = Array.from(document.querySelectorAll('input[type="submit"]'))
        .find(b => (b.value || '').trim() === '検索');
      if (!searchBtn) return { ok: false, error: '検索ボタン不在' };
      searchBtn.click();
      return { ok: true };
    }, [suumoCode]);

    if (!searchExec || !searchExec.ok) {
      throw new Error((searchExec && searchExec.error) || '検索実行失敗');
    }

    // 4. 検索結果の行を待つ: bukkenCd_<N> の value が検索コードと一致する行
    const rowReady = await waitForMainFrameCondition_(tabId, (code) => {
      const matches = Array.from(document.querySelectorAll('[id^="bukkenCd_"]'))
        .filter(inp => inp.value === code);
      if (matches.length === 0) return null; // まだ結果描画中 or 0件(タイムアウトで判定)
      const rowSuffix = matches[0].id.split('_')[1];
      const seiyakuHidden = document.getElementById('seiyakuFlg_' + rowSuffix);
      const toggleBtn = document.getElementById('btn_seiyakuFlg_' + rowSuffix);
      const submitImg = document.getElementById('shijiButton');
      if (!seiyakuHidden || !toggleBtn || !submitImg) return null;
      return {
        ok: true,
        matchCount: matches.length,
        rowSuffix: rowSuffix,
        seiyakuBefore: seiyakuHidden.value,
        buttonLabelBefore: toggleBtn.value,
      };
    }, 60000, [suumoCode]);

    if (!rowReady) {
      throw new Error('検索結果の表示タイムアウト(一致する物件コードの行が見つからない)');
    }
    if (rowReady.matchCount > 1) {
      throw new Error(`検索結果が複数件一致(${rowReady.matchCount}件)のため安全のため中止`);
    }

    const rowSuffix = rowReady.rowSuffix;
    await setStorageData({ debugLog: `[ForRent停止] 検索1件ヒット row=${rowSuffix} seiyakuBefore=${rowReady.seiyakuBefore}(${rowReady.buttonLabelBefore})` });

    // 5. 既に成約(seiyakuFlg=1)なら何もせず終了
    if (rowReady.seiyakuBefore === '1') {
      try { await chrome.tabs.remove(tabId); } catch (_) {}
      await setStorageData({ debugLog: `[ForRent停止] 既に成約状態(suumoCode=${suumoCode})` });
      return { ok: true, alreadyStopped: true };
    }

    // 6. 「空室」ボタンをクリック → toggleSeiyaku() 発動
    //    .click() は page main world の onclick="toggleSeiyaku(...)" を発火させる
    const toggleResult = await runInMainFrame_(tabId, (suffix) => {
      const btn = document.getElementById('btn_seiyakuFlg_' + suffix);
      if (!btn) return { ok: false, error: 'btn_seiyakuFlg_' + suffix + ' 不在' };
      btn.click();
      // トグル後の検証
      const seiyakuHidden = document.getElementById('seiyakuFlg_' + suffix);
      const updateFlg = document.getElementById('updateFlg_' + suffix);
      const submitImg = document.getElementById('shijiButton');
      return {
        ok: seiyakuHidden && seiyakuHidden.value === '1' && submitImg && !submitImg.hasAttribute('disabled'),
        seiyakuAfter: seiyakuHidden ? seiyakuHidden.value : '',
        updateFlgAfter: updateFlg ? updateFlg.value : '',
        buttonLabelAfter: btn.value,
        submitEnabled: submitImg ? !submitImg.hasAttribute('disabled') : false,
      };
    }, [rowSuffix]);

    if (!toggleResult || !toggleResult.ok) {
      throw new Error('空室→成約トグル失敗: ' + JSON.stringify(toggleResult));
    }

    await setStorageData({
      debugLog: `[ForRent停止] 成約化OK seiyakuFlg=${toggleResult.seiyakuAfter} ラベル=${toggleResult.buttonLabelAfter} 送信可=${toggleResult.submitEnabled}`
    });

    // 7. ドライランチェック
    if (dryRun) {
      try { await chrome.tabs.update(tabId, { active: true }); } catch (_) {}
      await setStorageData({
        debugLog: `[ForRent停止] DRY RUN: 「一括更新実行」ボタン直前で停止。タブを残したので目視確認してください(送信しなかった)`
      });
      return { ok: true, dryRun: true };
    }

    // 8. 本番送信: #shijiButton をクリック → formToUpdate() → POST PUB1R3900BD.action
    const submitResult = await runInMainFrame_(tabId, () => {
      const btn = document.getElementById('shijiButton');
      if (!btn) return { ok: false, error: 'shijiButton 不在' };
      if (btn.hasAttribute('disabled')) return { ok: false, error: 'shijiButton が無効状態' };
      btn.click();
      return { ok: true };
    });

    if (!submitResult || !submitResult.ok) {
      throw new Error((submitResult && submitResult.error) || '一括更新実行クリック失敗');
    }

    // 9. 完了画面への遷移を待つ(PUB1R3900 への遷移 or 成功文言)
    const completeCheck = await waitForMainFrameCondition_(tabId, () => {
      const url = location.href;
      const bodyText = (document.body && document.body.innerText) || '';
      // PUB1R2801 からまだ遷移していない間は待機
      if (/PUB1R2801/.test(url) && !/PUB1R3900|complete/i.test(url)) return null;
      const isCompletePage = /PUB1R3900/.test(url);
      const hasSuccessText = /完了|更新しました|更新完了|成功/.test(bodyText);
      const hasErrorText = /エラー|失敗|できませんでした/.test(bodyText);
      if (!isCompletePage && !hasSuccessText && !hasErrorText) return null;
      return { url, isCompletePage, hasSuccessText, hasErrorText, bodyHead: bodyText.substring(0, 300) };
    }, 60000);

    if (!completeCheck) {
      throw new Error('完了画面への遷移がタイムアウト');
    }
    if (completeCheck.hasErrorText) {
      throw new Error('完了画面にエラー文言: ' + completeCheck.bodyHead);
    }

    const succeeded = completeCheck.isCompletePage || completeCheck.hasSuccessText;
    try { await chrome.tabs.remove(tabId); } catch (_) {}

    const stoppedAt = new Date().toISOString();
    await setStorageData({
      debugLog: `[ForRent停止] 完了 suumoCode=${suumoCode} 判定=${succeeded ? 'OK' : '不明(手動確認推奨)'}`,
      suumoForrentLastStopAt: Date.now(),
    });

    return {
      ok: !!succeeded,
      stoppedAt,
      url: completeCheck.url,
      warning: succeeded ? null : '完了画面の判定が確証なし。ForRentで手動確認してください',
    };

  } catch (err) {
    console.error('[ForRent停止] エラー:', err);
    await setStorageData({ debugLog: `[ForRent停止] エラー: ${err.message}` });
    // エラー時はタブを残す(ユーザー確認のため)
    if (tabId !== null) {
      try { await chrome.tabs.update(tabId, { active: true }); } catch (_) {}
    }
    return { ok: false, error: err.message };
  } finally {
    _forrentStopRunning = false;
  }
}

/**
 * タブ内の全フレームでスクリプトを実行し、「意味のある結果」を拾うヘルパー
 *
 * ForRent は main_r.action 経由だと frameset だが、PUB1R2801.action を
 * 直接開けば frameset なし。allFrames:true でどちらでも動くようにする。
 * predicate が null を返したフレームは「対象外」として飛ばし、
 * ok:true / ok:false+error を返したフレームの結果を優先して採用する。
 */
async function runInMainFrame_(tabId, func, args) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func,
      args: args || [],
    });
    if (!Array.isArray(results)) return null;

    // 1. 成功(ok:true)
    for (const r of results) {
      if (r && r.result && typeof r.result === 'object' && r.result.ok === true) {
        return r.result;
      }
    }
    // 2. 明示的なエラー(ok:false + error)
    for (const r of results) {
      if (r && r.result && typeof r.result === 'object' && r.result.ok === false && r.result.error) {
        return r.result;
      }
    }
    // 3. null以外
    for (const r of results) {
      if (r && r.result !== undefined && r.result !== null) return r.result;
    }
    return null;
  } catch (err) {
    return { ok: false, error: 'script execute failed: ' + err.message };
  }
}

/**
 * フレーム内のpredicateが truthy を返すまでポーリングする。
 * frameset内ナビゲーションや非同期描画を待つのに使う。
 *
 * @param {number} tabId
 * @param {Function} predicate - フレーム内で実行。達成したらtruthyを返す
 * @param {number} timeoutMs - 既定30秒
 * @param {Array} args - predicateへの引数
 * @returns {Promise<any|null>}
 */
async function waitForMainFrameCondition_(tabId, predicate, timeoutMs, args) {
  const deadline = Date.now() + (timeoutMs || 30000);
  const intervalMs = 700;
  while (Date.now() < deadline) {
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        func: predicate,
        args: args || [],
      });
      if (Array.isArray(results)) {
        for (const r of results) {
          if (r && r.result !== undefined && r.result !== null) {
            return r.result;
          }
        }
      }
    } catch (_) {
      // タブ遷移中などで inject できないケースは継続
    }
    await sleep(intervalMs);
  }
  return null;
}
