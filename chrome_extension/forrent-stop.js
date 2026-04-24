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

    // 1. 常に ForRent のトップ(main_r.action)経由で開く
    //    → 直接 PUB1R2801.action にアクセスすると「既に完了」系エラーや
    //      セッション状態不整合が起きることがあるため、フロー的には
    //      必ず main_r.action → 掲載指示メニュー経由で PUB1R2801 に到達させる
    const entryUrl = 'https://www.fn.forrent.jp/fn/main_r.action';
    const tab = await chrome.tabs.create({ url: entryUrl, active: false });
    tabId = tab.id;

    await waitForTabLoad(tabId, 60000);
    await sleep(2000);

    // 2. ログイン/エラーページ検知 + 必要なら自動ログイン
    //    (forrent-status-sync.js の ensureForrentReady_ を再利用)
    //    ensureForrentReady_ は検索フォーム(bukkenCdInput)が見えるまで
    //    ログイン+ナビ遷移を行う
    if (typeof ensureForrentReady_ === 'function') {
      const ensured = await ensureForrentReady_(tabId);
      if (!ensured.ok) {
        try { await chrome.tabs.update(tabId, { active: true }); } catch (_) {}
        throw new Error('ForRent準備失敗: ' + ensured.error);
      }
    }

    // 3. 検索フォーム表示を待つ
    const formReady = await waitForMainFrameCondition_(tabId, () => {
      const input = document.querySelector('input.bukkenCdInput');
      if (!input) return null;
      const searchBtn = Array.from(document.querySelectorAll('input[type="submit"]'))
        .find(b => (b.value || '').trim() === '検索');
      if (!searchBtn) return null;
      return { ok: true, url: location.href };
    }, 30000);

    if (!formReady) {
      throw new Error('検索フォームが表示されない(ForRent画面構造変化の可能性)');
    }

    // 3. 物件コードを入力して検索実行
    //    - searchForm を特定してそのフォーム内で操作
    //    - native input value setter でフレームワークが期待する形にvalue設定
    //    - form.submit() で確実に送信(click経由の間接発火を避ける)
    const searchExec = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      world: 'MAIN',
      func: (code) => {
        try {
          // bukkenCdInput を含む form を特定 (searchForm)
          const input = document.querySelector('input.bukkenCdInput');
          if (!input) return null; // このフレームは対象外
          const form = input.closest('form');
          if (!form) return { ok: false, error: 'input の closest form が見つからない' };

          // native setter で value を設定(フレームワーク互換)
          const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
          nativeSetter.call(input, code);
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));

          // 同一フォーム内の「検索」ボタンを探す
          const searchBtn = Array.from(form.querySelectorAll('input[type="submit"], input[type="image"], button'))
            .find(b => {
              const v = (b.value || b.alt || b.innerText || '').trim();
              return v === '検索';
            });

          const formInfo = { action: form.action, name: form.name, id: form.id, inputValueAfter: input.value };
          if (searchBtn) {
            searchBtn.click();
            return { ok: true, via: 'button.click', formInfo };
          }
          // フォールバック: form.submit() を呼ぶ
          form.submit();
          return { ok: true, via: 'form.submit', formInfo };
        } catch (e) {
          return { ok: false, error: 'search exception: ' + e.message };
        }
      },
      args: [suumoCode],
    });
    // 結果集約
    let searchOk = false;
    let searchVia = '';
    let searchErr = '';
    let searchFormInfo = null;
    for (const r of searchExec || []) {
      if (r && r.result) {
        if (r.result.ok) { searchOk = true; searchVia = r.result.via || ''; searchFormInfo = r.result.formInfo; break; }
        if (r.result.error) { searchErr = r.result.error; }
      }
    }
    if (!searchOk) {
      throw new Error((searchErr || '検索実行失敗: bukkenCdInput が見つからない'));
    }
    await setStorageData({ debugLog: `[ForRent停止] 検索送信 via=${searchVia} formAction=${(searchFormInfo && searchFormInfo.action) || ''}` });

    if (!searchExec || !searchExec.ok) {
      throw new Error((searchExec && searchExec.error) || '検索実行失敗');
    }

    // 4. フォーム再描画(CSRFトークン更新)を待つ
    //    search click は form submit で page reload を引き起こすが、
    //    我々のinjectが旧DOMに当たるとstale authenticityToken で submit して
    //    「既に完了」エラーになる。再描画を確実に待つため、
    //    フォーム再描画サイン(再検索結果として bukkenCd_N の value を見る)を
    //    一定時間持って観察する。
    await sleep(3000); // 再描画の余裕

    // 4b. 検索結果の行を待つ: bukkenCd_<N> の value が検索コードと一致する行
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

    // 8. 本番送信: MAIN世界で動作する formToUpdate() を直接呼ぶ
    //    btn.click() だと isolated world から onclick 経由で呼ばれるが
    //    confirm() 等がブロッキングになる可能性があるため、直接関数呼びに。
    //    confirm を自動OKするモンキーパッチも入れる(念のため)。
    const submitResult = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      world: 'MAIN',
      func: () => {
        try {
          // confirm をスタブ化(削除選択が残っていても強制進行)
          const origConfirm = window.confirm;
          window.confirm = function() { return true; };
          try {
            const btn = document.getElementById('shijiButton');
            if (!btn) return { ok: false, error: 'shijiButton 不在' };
            if (btn.disabled || btn.hasAttribute('disabled')) return { ok: false, error: 'shijiButton が無効' };
            // 優先: formToUpdate() 直接呼び
            if (typeof window.formToUpdate === 'function') {
              window.formToUpdate();
              return { ok: true, via: 'formToUpdate' };
            }
            // フォールバック: ボタンクリック
            btn.click();
            return { ok: true, via: 'click' };
          } finally {
            window.confirm = origConfirm;
          }
        } catch (e) {
          return { ok: false, error: 'submit inject exception: ' + e.message };
        }
      }
    });
    // 結果集約
    let subOk = false;
    let subVia = '';
    let subErr = '';
    for (const r of submitResult || []) {
      if (r && r.result) {
        if (r.result.ok) { subOk = true; subVia = r.result.via || ''; break; }
        if (r.result.error) { subErr = r.result.error; }
      }
    }
    if (!subOk) {
      throw new Error((subErr || '一括更新実行の送信失敗'));
    }
    await setStorageData({ debugLog: `[ForRent停止] 送信実行 via=${subVia}` });

    // 9. 完了確認: 送信後のページで「実際に成約フラグが1になっているか」を検証
    //    URLや本文テキストで判定するのは誤判定が多いため、
    //    再度 bukkenCd で検索して seiyakuFlg の値を直接確認する方式。
    //    「画面遷移エラー」「既に完了」等の応答も、実際には更新されていない
    //    (false 失敗も false 成功も起こるため、値で真偽判定する)。
    await sleep(3000); // 送信反映の余裕

    const verifyResult = await waitForMainFrameCondition_(tabId, (code) => {
      const url = location.href;
      // 画面遷移エラー表示のままなら即座に失敗判定(そこから復帰しないため)
      const bodyText = (document.body && document.body.innerText) || '';
      if (/ご指定の処理は既に完了/.test(bodyText)) {
        return { ok: false, error: '画面遷移エラー(既に完了応答→未更新)', url };
      }
      // PUB1R2801 の検索フォームが使える状態になるまで待つ
      const input = document.querySelector('input.bukkenCdInput');
      if (!input) return null;
      const matches = Array.from(document.querySelectorAll('[id^="bukkenCd_"]'))
        .filter(inp => inp.value === code);
      // 掲載物件のみのリストに表示される場合は再検索不要 / 一覧更新済み
      if (matches.length > 0) {
        const suffix = matches[0].id.split('_')[1];
        const seiyaku = document.getElementById('seiyakuFlg_' + suffix);
        if (seiyaku) {
          return { ok: seiyaku.value === '1', seiyaku: seiyaku.value, url };
        }
      }
      // まだ描画中 → 少し待つ
      return null;
    }, 30000, [suumoCode]);

    if (!verifyResult) {
      throw new Error('送信後の成約状態確認タイムアウト(30秒)');
    }
    if (!verifyResult.ok) {
      throw new Error((verifyResult.error || '成約フラグが1になっていない(seiyaku=' + verifyResult.seiyaku + ')'));
    }

    const succeeded = true;
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
