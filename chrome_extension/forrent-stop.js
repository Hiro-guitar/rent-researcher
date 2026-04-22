/**
 * forrent-stop.js — ForRent(SUUMO入稿システム)からの物件掲載停止(保留化)自動操作
 *
 * SUUMO物件コード(12桁)を指定すると以下を自動実行:
 *   1. PUB1R2801.action (情報更新一覧)を開く
 *   2. 物件コードで検索
 *   3. 検索結果1件を確認後、「掲載指示」リンクをクリック
 *   4. PUB1R2814.action(掲載指示一覧)でネット掲載を保留にトグル
 *   5. shijiUpdateSubmit(1) で一括更新実行POST
 *   6. 完了画面で成功判定
 *
 * 安全策:
 *   - 既定ではドライラン(手順5直前で停止、タブは残す)
 *   - オプション画面の suumoForrentStopDryRun=false で本番実行可能
 *   - 検索結果0件/2件以上なら中止
 *   - ForRentは frameset で main フレーム操作が必要なため、chrome.scripting に
 *     allFrames:true を指定してフレーム横断で実行する
 *
 * background.js から importScripts('forrent-stop.js') で読み込む前提。
 */

let _forrentStopRunning = false;

/**
 * ForRentで物件を停止(保留化)する
 *
 * @param {Object} opts
 *   - suumoPropertyCode {string} 12桁のSUUMO物件コード(必須)
 *   - dryRun {boolean}            送信直前で止めるか(未指定ならストレージから取得、既定true)
 * @returns {Promise<{ok:boolean, error?:string, dryRun?:boolean, stoppedAt?:string}>}
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

    // 1. 情報更新一覧(検索画面)を開く
    const searchUrl = 'https://www.fn.forrent.jp/fn/PUB1R2801.action';
    const tab = await chrome.tabs.create({ url: searchUrl, active: false });
    tabId = tab.id;

    await waitForTabLoad(tabId, 60000);
    // frameset内のmainフレームが完了するまで待つ
    await sleep(3000);

    // 2. 検索フォーム入力 → 検索実行 (mainフレーム内)
    const searchResult = await runInMainFrame_(tabId, (code) => {
      const input = document.querySelector('input.bukkenCdInput');
      if (!input) return { ok: false, error: '物件コード入力欄が見つかりません' };
      input.value = code;
      input.dispatchEvent(new Event('input', { bubbles: true }));

      // 検索ボタン
      const searchBtn = Array.from(document.querySelectorAll('input[type="submit"]'))
        .find(b => (b.value || '').trim() === '検索');
      if (!searchBtn) return { ok: false, error: '検索ボタンが見つかりません' };
      searchBtn.click();
      return { ok: true };
    }, [suumoCode]);

    if (!searchResult || !searchResult.ok) {
      throw new Error((searchResult && searchResult.error) || '検索実行失敗');
    }

    // 検索結果を待つ: mainフレーム内に「掲載指示」リンクが現れるまでポーリング
    const searchWait = await waitForMainFrameCondition_(tabId, () => {
      if (!/PUB1R2801/.test(location.href)) return null;
      const links = Array.from(document.querySelectorAll('a'))
        .filter(a => (a.innerText || '').trim() === '掲載指示');
      if (links.length === 0) return null; // まだ結果描画中の可能性
      return { ok: true, count: links.length, url: location.href };
    }, 60000);

    if (!searchWait) {
      throw new Error('検索結果の表示がタイムアウト(mainフレームに「掲載指示」リンクが現れない)');
    }
    if (searchWait.count === 0) {
      throw new Error('検索結果0件(物件が見つかりません)');
    }
    if (searchWait.count > 1) {
      throw new Error(`検索結果が複数件(${searchWait.count}件)あるため安全のため中止`);
    }
    await setStorageData({ debugLog: `[ForRent停止] 検索1件ヒット、掲載指示リンクをクリック` });

    // 3. 「掲載指示」リンクをクリック
    const clickResult = await runInMainFrame_(tabId, () => {
      if (!/PUB1R2801/.test(location.href)) return null;
      const links = Array.from(document.querySelectorAll('a'))
        .filter(a => (a.innerText || '').trim() === '掲載指示');
      if (links.length !== 1) return { ok: false, error: `掲載指示リンクの再取得失敗(count=${links.length})` };
      links[0].click();
      return { ok: true };
    });

    if (!clickResult || !clickResult.ok) {
      throw new Error((clickResult && clickResult.error) || '掲載指示リンククリック失敗');
    }

    // 4. PUB1R2814.action の読み込み完了 + 保留化対象行を特定
    //    keisaiLocate() は frame内ナビゲーションのため chrome.tabs.onUpdated で検知できない。
    //    mainフレーム内のURL + 要素存在をポーリングで判定する。
    //    行番号suffixは物件件数に応じて 0 or 1 始まり(環境依存)のため自動検出する。
    const pageReady = await waitForMainFrameCondition_(tabId, () => {
      if (!/PUB1R2814/.test(location.href)) return null;
      // suffix を 0..20 で走査して最初に見つかった行を採用
      let suffix = null;
      for (let i = 0; i <= 20; i++) {
        if (document.getElementById('shijiFlg1_' + i) && document.getElementById('btn_shijiFlg1_' + i)) {
          suffix = i;
          break;
        }
      }
      if (suffix === null) return null;
      const submitImg = document.getElementById('shijiButton');
      if (!submitImg) return null;
      return { ok: true, url: location.href, rowSuffix: suffix };
    }, 60000);

    if (!pageReady) {
      throw new Error('PUB1R2814(掲載指示一覧) の要素がタイムアウトまでに見つからない');
    }
    const rowSuffix = pageReady.rowSuffix;
    await setStorageData({ debugLog: `[ForRent停止] PUB1R2814読み込み完了 rowSuffix=${rowSuffix}` });

    // 5. 保留化トグル + 状態確認
    const toggleResult = await runInMainFrame_(tabId, (suffix) => {
      if (!/PUB1R2814/.test(location.href)) return null;
      const flagId = 'shijiFlg1_' + suffix;
      const btnId = 'btn_shijiFlg1_' + suffix;
      const hiddenFlag = document.getElementById(flagId);
      const toggleBtn = document.getElementById(btnId);
      const submitImg = document.getElementById('shijiButton');
      if (!hiddenFlag || !toggleBtn || !submitImg) {
        return { ok: false, error: `要素未検出(再確認時): ${flagId}/${btnId}/shijiButton` };
      }
      const beforeFlag = hiddenFlag.value;
      const beforeBtnLabel = toggleBtn.value;

      // 既に保留状態(0)なら停止済みとみなして中止
      if (beforeFlag === '0') {
        return { ok: false, alreadyStopped: true, error: '既に保留状態です' };
      }

      if (typeof window.changeKeisaiFlg !== 'function') {
        return { ok: false, error: 'window.changeKeisaiFlg が存在しません' };
      }
      window.changeKeisaiFlg('shijiFlg1', String(suffix), true);

      const afterFlag = document.getElementById(flagId).value;
      const afterBtnLabel = document.getElementById(btnId).value;
      const submitEnabled = !document.getElementById('shijiButton').disabled;

      return {
        ok: afterFlag === '0' && submitEnabled,
        before: { flag: beforeFlag, label: beforeBtnLabel },
        after: { flag: afterFlag, label: afterBtnLabel, submitEnabled: submitEnabled }
      };
    }, [rowSuffix]);

    if (!toggleResult || !toggleResult.ok) {
      if (toggleResult && toggleResult.alreadyStopped) {
        // 既停止は成功扱い
        try { await chrome.tabs.remove(tabId); } catch (_) {}
        await setStorageData({ debugLog: `[ForRent停止] 既に保留状態(suumoCode=${suumoCode})` });
        return { ok: true, alreadyStopped: true };
      }
      throw new Error((toggleResult && toggleResult.error) || '保留化トグル失敗');
    }

    await setStorageData({ debugLog: `[ForRent停止] 保留化OK: ${toggleResult.before.flag}→${toggleResult.after.flag}` });

    // 6. ドライランチェック
    if (dryRun) {
      // タブを残して終了(ユーザーが目視確認&手動送信できるようにactive化)
      try { await chrome.tabs.update(tabId, { active: true }); } catch (_) {}
      await setStorageData({
        debugLog: `[ForRent停止] DRY RUN: 保留化直後で停止。手動で「一括更新実行」を押せば完了(送信しなかった)`,
      });
      return { ok: true, dryRun: true };
    }

    // 7. 本番送信: shijiUpdateSubmit(1)
    const submitResult = await runInMainFrame_(tabId, () => {
      if (typeof window.shijiUpdateSubmit !== 'function') {
        return { ok: false, error: 'window.shijiUpdateSubmit が存在しません' };
      }
      const submitImg = document.getElementById('shijiButton');
      if (!submitImg || submitImg.disabled) {
        return { ok: false, error: '一括更新実行ボタンが無効/不在' };
      }
      window.shijiUpdateSubmit(1);
      return { ok: true };
    });

    if (!submitResult || !submitResult.ok) {
      throw new Error((submitResult && submitResult.error) || 'submit呼び出し失敗');
    }

    // 8. 完了画面へ遷移待機(mainフレームのURL変化をポーリング)
    const completeCheck = await waitForMainFrameCondition_(tabId, () => {
      const url = location.href;
      const bodyText = (document.body && document.body.innerText) || '';
      const isCompletePage = /PUB1R3910/.test(url);
      const hasSuccessText = /完了|成功|更新しました/.test(bodyText);
      const hasErrorText = /エラー|失敗|できませんでした/.test(bodyText);
      // PUB1R2814 からまだ遷移していない場合は待機継続
      if (/PUB1R2814/.test(url) && !isCompletePage) return null;
      if (!isCompletePage && !hasSuccessText && !hasErrorText) return null;
      return { url, isCompletePage, hasSuccessText, hasErrorText, bodyHead: bodyText.substring(0, 300) };
    }, 60000);

    if (completeCheck && completeCheck.hasErrorText) {
      throw new Error('完了画面にエラー文言: ' + completeCheck.bodyHead);
    }

    const succeeded = completeCheck && (completeCheck.isCompletePage || completeCheck.hasSuccessText);
    try { await chrome.tabs.remove(tabId); } catch (_) {}

    const stoppedAt = new Date().toISOString();
    await setStorageData({
      debugLog: `[ForRent停止] 完了 suumoCode=${suumoCode} 判定=${succeeded ? 'OK' : '不明(手動確認推奨)'}`,
      suumoForrentLastStopAt: Date.now(),
    });

    return {
      ok: !!succeeded,
      stoppedAt,
      url: completeCheck && completeCheck.url,
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
 * タブの main フレームでスクリプトを実行するヘルパー
 *
 * ForRent は frameset で main フレーム内に UI があるため、allFrames:true で
 * 全フレームに注入し、main フレームの結果を拾う。
 * func が null を返したフレームは「対象外(別frame)」とみなして飛ばし、
 * { ok:true } や { ok:false, error:... } を返したフレームの結果を採用する。
 */
async function runInMainFrame_(tabId, func, args) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func,
      args: args || [],
    });
    if (!Array.isArray(results)) return null;

    // 1. 成功(ok:true)を含む結果を最優先
    for (const r of results) {
      if (r && r.result && typeof r.result === 'object' && r.result.ok === true) {
        return r.result;
      }
    }
    // 2. 明示的にエラーを返したフレーム結果(ok:false + errorあり)
    for (const r of results) {
      if (r && r.result && typeof r.result === 'object' && r.result.ok === false && r.result.error) {
        return r.result;
      }
    }
    // 3. null以外の結果があればそれ
    for (const r of results) {
      if (r && r.result !== undefined && r.result !== null) return r.result;
    }
    return null;
  } catch (err) {
    return { ok: false, error: 'script execute failed: ' + err.message };
  }
}

/**
 * mainフレーム内で指定のpredicateを満たすまでポーリングする。
 *
 * frameset内ナビゲーション(keisaiLocate等)は chrome.tabs.onUpdated で検知できないため、
 * DOM側の条件でポーリングする。predicateはnull/undefinedを返している間は「まだ」扱い。
 * truthy(オブジェクト等)を返したらそれを返す。
 *
 * @param {number} tabId
 * @param {Function} predicate - フレーム内で実行される関数。targetに達したらtruthyを返す
 * @param {number} timeoutMs - タイムアウト(ミリ秒、既定30秒)
 * @returns {Promise<any|null>} predicateが返した値 or タイムアウト時null
 */
async function waitForMainFrameCondition_(tabId, predicate, timeoutMs) {
  const deadline = Date.now() + (timeoutMs || 30000);
  const intervalMs = 700;
  while (Date.now() < deadline) {
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        func: predicate,
      });
      if (Array.isArray(results)) {
        for (const r of results) {
          if (r && r.result !== undefined && r.result !== null) {
            return r.result;
          }
        }
      }
    } catch (_) {
      // タブが遷移中/まだinjectできない場合は継続
    }
    await sleep(intervalMs);
  }
  return null;
}
