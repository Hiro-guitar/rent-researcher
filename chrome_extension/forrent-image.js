/**
 * forrent-image.js — ForRent 代表画像を「内観(r)」に変更する自動化(遷移率改善用)
 *
 * 調査で確定したフロー:
 *   main_r → PUB1R2801(検索) → 物件コード検索 → 行の「詳細」(UPD1R3100)で編集画面
 *   → suumoYusenGazoCd セレクトを r(内観) → 「確認画面へ」(div#regButton2)
 *   → 確認画面(UPD1R32001, form#confirmForm) の登録ボタン(img#jikko, onclick ImageButton.onceSubmit)
 *   → 完了画面「物件情報更新完了 / 登録完了しました。」
 *
 * 安全: dryRun(デフォルトtrue)では確認画面まで進むが最終「登録」は押さない。
 *   セレクト変更は登録するまで保存されないため、ドライランは無害。
 *
 * 共通ヘルパーは forrent-stop.js / forrent-status-sync.js と同じものを再利用:
 *   waitForTabLoad / sleep / ensureForrentReady_ / waitForMainFrameCondition_ /
 *   getStorageData / setStorageData
 */

let _forrentImageRunning = false;

async function changeForrentRepImageToNaikan(opts) {
  if (_forrentImageRunning) return { ok: false, error: '既に画像変更処理実行中' };
  const suumoCode = String((opts && opts.suumoPropertyCode) || '').replace(/[^0-9]/g, '');
  if (suumoCode.length !== 12) return { ok: false, error: `物件コードは12桁必須(受信: ${suumoCode})` };

  // dryRun: 明示指定 > ストレージ > デフォルトtrue(安全側)
  let dryRun;
  if (typeof opts.dryRun === 'boolean') dryRun = opts.dryRun;
  else {
    const { suumoImageChangeDryRun } = await getStorageData(['suumoImageChangeDryRun']);
    dryRun = (suumoImageChangeDryRun === undefined || suumoImageChangeDryRun === null) ? true : !!suumoImageChangeDryRun;
  }
  const targetVal = 'r'; // 内観

  _forrentImageRunning = true;
  let tabId = null;
  try {
    await setStorageData({ debugLog: `[ForRent画像] 開始 ${suumoCode} →内観(r) dryRun=${dryRun}` });

    // 1. main_r 経由で開く(直アクセスはセッション不整合の恐れ)
    const tab = await chrome.tabs.create({ url: 'https://www.fn.forrent.jp/fn/main_r.action', active: false });
    tabId = tab.id;
    await waitForTabLoad(tabId, 60000);
    await sleep(2000);

    if (typeof ensureForrentReady_ === 'function') {
      const ensured = await ensureForrentReady_(tabId);
      if (!ensured.ok) throw new Error('ForRent準備失敗: ' + ensured.error);
    }

    // 2. 検索フォーム表示待ち
    const formReady = await waitForMainFrameCondition_(tabId, () => {
      const input = document.querySelector('input.bukkenCdInput');
      if (!input) return null;
      const btn = Array.from(document.querySelectorAll('input[type="submit"]')).find(b => (b.value || '').trim() === '検索');
      return btn ? { ok: true } : null;
    }, 30000);
    if (!formReady) throw new Error('検索フォーム未表示(画面構造変化の可能性)');

    // 3. 物件コードで検索(stopForrentListing と同じ手順)
    const searchExec = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true }, world: 'MAIN',
      func: (code) => {
        try {
          const input = document.querySelector('input.bukkenCdInput');
          if (!input) return null;
          const form = input.closest('form');
          if (!form) return { ok: false, error: 'form無し' };
          const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
          setter.call(input, code);
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
          const btn = Array.from(form.querySelectorAll('input[type="submit"],input[type="image"],button'))
            .find(b => ((b.value || b.alt || b.innerText || '').trim()) === '検索');
          if (btn) { btn.click(); return { ok: true, via: 'click' }; }
          form.submit(); return { ok: true, via: 'submit' };
        } catch (e) { return { ok: false, error: e.message }; }
      },
      args: [suumoCode],
    });
    if (!(searchExec || []).some(r => r && r.result && r.result.ok)) throw new Error('検索実行失敗(bukkenCdInput無し)');
    await sleep(3000); // 再描画待ち

    // 4. 結果行を待つ(1件一致のみ進める)
    const rowReady = await waitForMainFrameCondition_(tabId, (code) => {
      const matches = Array.from(document.querySelectorAll('[id^="bukkenCd_"]')).filter(i => i.value === code);
      if (!matches.length) return null;
      return { ok: true, matchCount: matches.length, suffix: matches[0].id.split('_')[1] };
    }, 60000, [suumoCode]);
    if (!rowReady) throw new Error('検索結果行が見つからない(0件 or 描画待ち)');
    if (rowReady.matchCount > 1) throw new Error(`複数件一致(${rowReady.matchCount})のため安全のため中止`);

    // 5. 該当行の「詳細」(UPD1R3100)をクリックして編集画面へ
    const detailClick = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true }, world: 'MAIN',
      func: (code) => {
        try {
          const m = Array.from(document.querySelectorAll('[id^="bukkenCd_"]')).find(i => i.value === code);
          if (!m) return null;
          const row = m.closest('tr') || m.parentElement;
          if (!row) return { ok: false, error: '行要素無し' };
          const cands = Array.from(row.querySelectorAll('a,[onclick],input[type="button"],img'));
          const detail = cands.find(el => {
            const s = (el.textContent || '') + '|' + (el.getAttribute('onclick') || '') + '|' + (el.getAttribute('href') || '') + '|' + (el.alt || '') + '|' + (el.value || '');
            return /UPD1R3100|詳細/.test(s);
          });
          if (!detail) return { ok: false, error: '詳細リンクが見つからない' };
          detail.click();
          return { ok: true };
        } catch (e) { return { ok: false, error: e.message }; }
      },
      args: [suumoCode],
    });
    if (!(detailClick || []).some(r => r && r.result && r.result.ok)) {
      const err = (detailClick || []).map(r => r && r.result && r.result.error).filter(Boolean)[0];
      throw new Error('詳細リンククリック失敗: ' + (err || '不明'));
    }
    await sleep(3000);

    // 6. 編集画面: suumoYusenGazoCd セレクトを r(内観) に設定
    const selReady = await waitForMainFrameCondition_(tabId, () => {
      const sel = Array.from(document.querySelectorAll('select')).find(s => /suumoYusenGazoCd/.test(s.name || ''));
      return sel ? { ok: true, before: sel.value } : null;
    }, 40000);
    if (!selReady) throw new Error('編集画面の代表画像セレクト(suumoYusenGazoCd)が見つからない');

    const setExec = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true }, world: 'MAIN',
      func: (val) => {
        try {
          const sel = Array.from(document.querySelectorAll('select')).find(s => /suumoYusenGazoCd/.test(s.name || ''));
          if (!sel) return null;
          if (!Array.from(sel.options).some(o => o.value === val)) return { ok: false, error: 'r(内観)オプション無し' };
          const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
          setter.call(sel, val);
          sel.dispatchEvent(new Event('change', { bubbles: true }));
          return { ok: true, after: sel.value };
        } catch (e) { return { ok: false, error: e.message }; }
      },
      args: [targetVal],
    });
    if (!(setExec || []).some(r => r && r.result && r.result.ok)) {
      const err = (setExec || []).map(r => r && r.result && r.result.error).filter(Boolean)[0];
      throw new Error('代表画像セレクト設定失敗: ' + (err || '不明'));
    }
    await setStorageData({ debugLog: `[ForRent画像] ${suumoCode} 代表画像を内観(r)に設定` });
    await sleep(2500); // サムネ表示完了待ち(注意書き準拠)

    // 7. 「確認画面へ」(div#regButton2) をクリック
    const confClick = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true }, world: 'MAIN',
      func: () => {
        try { const b = document.getElementById('regButton2'); if (!b) return null; b.click(); return { ok: true }; }
        catch (e) { return { ok: false, error: e.message }; }
      },
    });
    if (!(confClick || []).some(r => r && r.result && r.result.ok)) throw new Error('「確認画面へ」(regButton2)が押せない');
    await sleep(3000);

    // 8. 確認画面到達を待つ(img#jikko or ヘッダ「物件情報更新確認」)。差し戻しは失敗。
    const confReady = await waitForMainFrameCondition_(tabId, () => {
      const t = (document.body && document.body.innerText) || '';
      if (/問題が発生したため|画面を表示することができません|エラーが発生/.test(t)) return { ok: false, error: 'サーバエラー画面' };
      const jikko = document.getElementById('jikko');
      if (jikko || /物件情報更新確認|よろしければ.*登録/.test(t)) return { ok: true, hasJikko: !!jikko };
      if (/元付業者|取引様態.*先物|入力エラー/.test(t)) return { ok: false, error: 'バリデーションエラーで確認画面に進めず' };
      return null;
    }, 30000);
    if (!confReady) throw new Error('確認画面に到達できない(タイムアウト)');
    if (confReady.ok === false) throw new Error('確認画面に進めない: ' + confReady.error);

    // 9. ドライラン: 確認画面まで到達でOKとし、登録は押さない
    if (dryRun) {
      try { await chrome.tabs.remove(tabId); } catch (_) {}
      await setStorageData({ debugLog: `[ForRent画像] ${suumoCode} ドライラン成功: 確認画面まで到達(登録は未実行)` });
      return { ok: true, dryRun: true, reached: 'confirm' };
    }

    // 10. 登録ボタン(img#jikko)を押す
    const regClick = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true }, world: 'MAIN',
      func: () => {
        try { const j = document.getElementById('jikko'); if (!j) return null; j.click(); return { ok: true }; }
        catch (e) { return { ok: false, error: e.message }; }
      },
    });
    if (!(regClick || []).some(r => r && r.result && r.result.ok)) throw new Error('登録ボタン(jikko)が押せない');
    await sleep(3000);

    // 11. 完了判定(「登録完了しました。」/「物件情報更新完了」)
    const done = await waitForMainFrameCondition_(tabId, () => {
      const t = (document.body && document.body.innerText) || '';
      const title = document.title || '';
      if (/登録完了しました|物件情報更新完了/.test(t) || /物件情報更新完了/.test(title)) return { ok: true };
      if (/問題が発生|エラーが発生|画面を表示することができません/.test(t)) return { ok: false, error: '完了画面でエラー' };
      return null;
    }, 30000);
    if (!done) throw new Error('完了確認タイムアウト');
    if (done.ok === false) throw new Error(done.error);

    try { await chrome.tabs.remove(tabId); } catch (_) {}
    await setStorageData({ debugLog: `[ForRent画像] ${suumoCode} 内観に変更・保存完了` });
    return { ok: true, saved: true };

  } catch (e) {
    try { if (tabId) await chrome.tabs.update(tabId, { active: true }); } catch (_) {}
    await setStorageData({ debugLog: `[ForRent画像] ${suumoCode} 失敗: ${e && e.message}` });
    return { ok: false, error: e && e.message };
  } finally {
    _forrentImageRunning = false;
  }
}

globalThis.changeForrentRepImageToNaikan = changeForrentRepImageToNaikan;

/**
 * 【画像改善バッチ】低遷移率(<閾値)・掲載中・未マークの物件を、GASから物件コード付きで取得し、
 * 1日数件ずつ代表画像を内観に変更 → 成功した物件をGASに「起点待ち」マーク。
 *
 *   dryRun(既定: storage suumoImageChangeDryRun、無ければtrue)では確認画面まで到達するだけで
 *   保存しない＝マークもしない（実際には変えていないため）。
 *
 * @param {Object} [opts]
 * @param {number} [opts.threshold=10] 遷移率(%)閾値
 * @param {number} [opts.limit=3]      1回の処理上限(1日数件)
 * @param {boolean} [opts.dryRun]      明示指定で上書き(省略時はstorage→true)
 * @returns {Promise<{ok, processed, saved, marked, results}>}
 */
let _imageBatchRunning = false;
async function runRepImageChangeBatch(opts) {
  opts = opts || {};
  if (_imageBatchRunning) return { ok: false, error: '既に画像変更バッチ実行中' };
  const threshold = Number(opts.threshold) || 10;
  const limit = Number(opts.limit) || 3;

  // dryRun を一度だけ解決し、バッチ全体で統一(各物件で揺れないように)
  let dryRun;
  if (typeof opts.dryRun === 'boolean') dryRun = opts.dryRun;
  else {
    const { suumoImageChangeDryRun } = await getStorageData(['suumoImageChangeDryRun']);
    dryRun = (suumoImageChangeDryRun === undefined || suumoImageChangeDryRun === null) ? true : !!suumoImageChangeDryRun;
  }

  const { gasWebappUrl } = await getStorageData(['gasWebappUrl']);
  if (!gasWebappUrl) return { ok: false, error: 'gasWebappUrl未設定' };

  _imageBatchRunning = true;
  try {
    await setStorageData({ debugLog: `[画像バッチ] 開始 閾値<${threshold}% 上限${limit}件 dryRun=${dryRun}` });

    // 1. 候補取得
    const res = await _fetchWithTimeout_(gasWebappUrl, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'get_image_change_candidates', threshold, limit })
    }, 30000);
    const raw = await res.text();
    let data;
    try { data = JSON.parse(raw); }
    catch (pe) {
      await setStorageData({ debugLog: '[画像バッチ] GAS応答がJSONでない(未デプロイ?): ' + String(raw).slice(0, 140) });
      return { ok: false, error: 'GAS応答不正(未デプロイ?)' };
    }
    const candidates = (data && data.candidates) || [];
    if (!candidates.length) {
      await setStorageData({ debugLog: `[画像バッチ] 候補なし(遷移率<${threshold}%・未マーク・コードあり = 0件)` });
      return { ok: true, processed: 0, saved: 0, marked: 0, results: [] };
    }

    // 2. 各候補を内観に変更(逐次)
    const results = [];
    const savedKeys = [];
    for (let i = 0; i < candidates.length; i++) {
      const c = candidates[i];
      await setStorageData({ debugLog: `[画像バッチ] ${i + 1}/${candidates.length} ${c.building || ''}${c.room || ''} (遷移率${c.遷移率}%) 処理中` });
      let r;
      try { r = await changeForrentRepImageToNaikan({ suumoPropertyCode: c.suumoCode, dryRun }); }
      catch (e) { r = { ok: false, error: e && e.message }; }
      results.push({ key: c.key, building: c.building, room: c.room, suumoCode: c.suumoCode, result: r });
      if (r && r.ok && r.saved) savedKeys.push(c.key); // 本番保存できた物件のみマーク対象
      await sleep(2000); // ForRent負荷・レート緩和
    }

    // 3. 実際に保存できた物件をGASにマーク(起点待ち)。dryRunのみのバッチではsavedKeys=空。
    let marked = 0;
    if (savedKeys.length) {
      try {
        const mres = await _fetchWithTimeout_(gasWebappUrl, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'mark_image_changed', keys: savedKeys })
        }, 30000);
        const mjson = JSON.parse(await mres.text());
        marked = (mjson && mjson.marked) || 0;
      } catch (e) {
        await setStorageData({ debugLog: `[画像バッチ] マーク送信失敗: ${e && e.message}（変更は済・次回手動マーク要）` });
      }
    }

    const savedCount = results.filter(x => x.result && x.result.ok && x.result.saved).length;
    await setStorageData({ debugLog: `[画像バッチ] 完了 処理${results.length}件 / 保存${savedCount}件 / マーク${marked}件 (dryRun=${dryRun})` });
    return { ok: true, processed: results.length, saved: savedCount, marked, dryRun, results };

  } catch (err) {
    await setStorageData({ debugLog: `[画像バッチ] 例外: ${err && err.message}` });
    return { ok: false, error: err && err.message };
  } finally {
    _imageBatchRunning = false;
  }
}

globalThis.runRepImageChangeBatch = runRepImageChangeBatch;
