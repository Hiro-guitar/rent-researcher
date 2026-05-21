/**
 * availability-checker.js
 * 通知済み物件の空室状況を各サイト別に確認する。
 *
 * - itandi: 物件ページ内の「Block Left」div に「募集中」テキストがあるか
 * - いえらぶ (ielove): 物件ページの 募集状況 を確認
 * - いい生活 (essquare): 「申込あり」タグ or 404 → closed、それ以外 → available
 * - REINS: 物件番号で REINS 内検索 → 結果に存在するか
 *
 * vacancy-checker (Python+Selenium) のロジックを Chrome 拡張に移植。
 */

// 各サイトの dedicated tab を再利用するため、専用タブヘルパーを使う。
// なければ新規タブを作成する。

// ──────────────────────────────────────────────────────────────────
// 単一物件の空室確認: source に応じて適切なハンドラを呼ぶ
// ──────────────────────────────────────────────────────────────────

/**
 * @param {{source: string, url: string, reinsPropNo: string}} item
 * @return {Promise<'available'|'closed'|'reins_listed'|'unknown'>}
 */
async function checkOneAvailability(item) {
  const source = String(item.source || '').toLowerCase();
  const url = String(item.url || '');
  try {
    if (source === 'itandi') return await _checkItandiAvailability(url);
    if (source === 'ielove') return await _checkIeloveAvailability(url);
    if (source === 'essquare') return await _checkEssquareAvailability(url);
    if (source === 'reins') return await _checkReinsAvailability(item.reinsPropNo || '');
  } catch (e) {
    console.warn(`[availability] ${source} check failed: ${e.message}`);
  }
  return 'unknown';
}

// ──────────────────────────────────────────────────────────────────
// itandi: 物件ページの「Block Left」div に「募集中」が含まれるか
// vacancy-checker (Python) と同じロジック
// ──────────────────────────────────────────────────────────────────
async function _checkItandiAvailability(url) {
  if (!url || url.indexOf('itandibb.com') < 0) return 'unknown';
  const tab = await (typeof findOrCreateDedicatedItandiTab === 'function'
    ? findOrCreateDedicatedItandiTab()
    : null);
  if (!tab) return 'unknown';
  try {
    await chrome.tabs.update(tab.id, { url: url });
    await _waitForTabLoad(tab.id, 15000);
    await new Promise(r => setTimeout(r, 2000)); // SPAレンダ待ち
    const [{ result } = {}] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        // 「Block Left」div 内に「募集中」テキストがあれば募集中
        const blocks = document.querySelectorAll('div[class*="Block"][class*="Left"], .BlockLeft, div.block.left');
        for (const el of blocks) {
          if ((el.textContent || '').includes('募集中')) return 'available';
        }
        // フォールバック: bodyテキスト全体で判定
        const bodyText = document.body.innerText || '';
        if (/募集中/.test(bodyText)) return 'available';
        // 404 / ページ削除
        if (/このページは存在しません|お探しのページ|404|ページが見つかりません/.test(bodyText)) return 'closed';
        // 申込あり / 取り下げ表記
        if (/申込\s*あり|取り下げ|募集停止|募集終了/.test(bodyText)) return 'closed';
        return 'unknown';
      }
    });
    return result || 'unknown';
  } catch (e) {
    console.warn('[availability/itandi] ' + e.message);
    return 'unknown';
  }
}

// ──────────────────────────────────────────────────────────────────
// いえらぶ (ielove BB): 専用セレクタ exists_application_for_confirm / for-rent
// vacancy-checker (Python) と同じロジック
// ──────────────────────────────────────────────────────────────────
async function _checkIeloveAvailability(url) {
  if (!url || (url.indexOf('ielove') < 0 && url.indexOf('homes.co.jp') < 0)) return 'unknown';
  const tab = await (typeof findOrCreateDedicatedIeloveTab === 'function'
    ? findOrCreateDedicatedIeloveTab()
    : null);
  if (!tab) return 'unknown';
  try {
    await chrome.tabs.update(tab.id, { url: url });
    await _waitForTabLoad(tab.id, 15000);
    await new Promise(r => setTimeout(r, 2000));
    const [{ result } = {}] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        // 専用セレクタで判定
        const app = document.querySelector('span.exists_application_for_confirm');
        if (app) return 'closed';
        const forRent = document.querySelector('span.for-rent');
        if (forRent) return 'available';
        // 掲載終了
        const bodyText = document.body.innerText || '';
        if (/既に掲載が終了した物件|掲載が終了|物件は存在しません|該当する物件はありません/.test(bodyText)) return 'closed';
        // フォールバック: テキストパターン
        if (/申込\s*あり|入居予定者あり|申込済|募集停止|募集終了/.test(bodyText)) return 'closed';
        if (/募集中|入居可能/.test(bodyText)) return 'available';
        return 'unknown';
      }
    });
    return result || 'unknown';
  } catch (e) {
    console.warn('[availability/ielove] ' + e.message);
    return 'unknown';
  }
}

// ──────────────────────────────────────────────────────────────────
// いい生活 (es-square): eds-tag__label 「申込あり」 or 404 → closed
// vacancy-checker (Python) と同じロジック
// ──────────────────────────────────────────────────────────────────
async function _checkEssquareAvailability(url) {
  if (!url || (url.indexOf('es-square') < 0 && url.indexOf('iisesq') < 0)) return 'unknown';
  const tab = await (typeof findOrCreateDedicatedEssquareTab === 'function'
    ? findOrCreateDedicatedEssquareTab()
    : null);
  if (!tab) return 'unknown';
  try {
    await chrome.tabs.update(tab.id, { url: url });
    await _waitForTabLoad(tab.id, 15000);
    await new Promise(r => setTimeout(r, 2000));
    const [{ result } = {}] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        // 申込ありタグ
        const tags = document.querySelectorAll('span.eds-tag__label');
        for (const el of tags) {
          if ((el.textContent || '').trim() === '申込あり') return 'closed';
        }
        // 404
        const bodyText = document.body.innerText || '';
        if (/エラーコード[::]?\s*404|404\s*Not Found|物件が見つかりません/.test(bodyText)) return 'closed';
        // それ以外は available (vacancy-checker と同じ挙動)
        return 'available';
      }
    });
    return result || 'unknown';
  } catch (e) {
    console.warn('[availability/essquare] ' + e.message);
    return 'unknown';
  }
}

// ──────────────────────────────────────────────────────────────────
// REINS: 既存の reinsAutoSearchByNumber と同じ手順で物件番号検索
// 検索結果ページ (GBK004200) で行があれば reins_listed、なければ closed
// (空室確定はできないので available は返さない)
// ──────────────────────────────────────────────────────────────────
async function _checkReinsAvailability(reinsPropNo) {
  if (!reinsPropNo) return 'unknown';
  const tab = await (typeof findOrCreateDedicatedReinsTab === 'function'
    ? findOrCreateDedicatedReinsTab()
    : (typeof findReinsTab === 'function' ? findReinsTab() : null));
  if (!tab) return 'unknown';
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  try {
    // ログイン未完了ならスキップ
    const tab0 = await chrome.tabs.get(tab.id);
    if (/login|GKG001/i.test(tab0.url || '')) return 'unknown';

    // 1) 物件番号検索ページへ遷移 (Vueルーター経由)
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: 'MAIN',
      func: () => {
        try {
          const n = window.$nuxt;
          if (n && n.$router) { n.$router.push('/main/BK/GBK004100'); return 'router'; }
        } catch (e) {}
        location.assign('https://system.reins.jp/main/BK/GBK004100');
      }
    });

    // 2) GBK004100到達 & 物件番号入力欄出現を待つ
    let reachedSearch = false;
    for (let i = 0; i < 30; i++) {
      await sleep(500);
      const t = await chrome.tabs.get(tab.id);
      if (!t.url?.includes('GBK004100')) continue;
      const ready = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => {
          const inputs = [...document.querySelectorAll('input[type="text"], input:not([type])')];
          for (const el of inputs) {
            const ctx = el.closest('.p-label, .form-group, div')?.parentElement?.textContent || '';
            if (ctx.includes('物件番号')) return true;
          }
          return false;
        }
      });
      if (ready?.[0]?.result) { reachedSearch = true; break; }
    }
    if (!reachedSearch) return 'unknown';

    // 3) 物件番号入力 → 検索ボタンクリック
    const setRes = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
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
      args: [reinsPropNo]
    });
    if (setRes?.[0]?.result !== 'ok') return 'unknown';

    // 4) 検索結果ページ到達 (GBK004200) を待ち、結果行の有無を判定
    let resultPage = false;
    for (let i = 0; i < 30; i++) {
      await sleep(500);
      const t = await chrome.tabs.get(tab.id);
      if (t.url?.includes('GBK004200')) { resultPage = true; break; }
    }
    if (!resultPage) return 'unknown';

    // 結果行の有無を判定 (詳細ボタン or テーブル行 or 「該当なし」テキスト)
    await sleep(1500); // テーブル描画待ち
    const [{ result } = {}] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: (propNo) => {
        const bodyText = document.body.innerText || '';
        // 「該当なし」「0件」「検索結果なし」 → closed
        if (/該当(?:するデータが)?(?:あり|有り)?ません|検索結果が0件|0\s*件/.test(bodyText)) return 'closed';
        // 詳細ボタンがあれば結果行あり
        const hasDetail = [...document.querySelectorAll('button')].some(b => b.textContent.trim() === '詳細');
        if (hasDetail) return 'reins_listed';
        // 物件番号がページ上に表示されていれば存在
        if (bodyText.indexOf(propNo) >= 0) return 'reins_listed';
        // それ以外: 不明 (テーブル未描画など)
        return 'unknown';
      },
      args: [reinsPropNo]
    });
    return result || 'unknown';
  } catch (e) {
    console.warn('[availability/reins] ' + e.message);
    return 'unknown';
  }
}

// ──────────────────────────────────────────────────────────────────
// タブのロード完了を待つヘルパ
// ──────────────────────────────────────────────────────────────────
function _waitForTabLoad(tabId, timeoutMs) {
  return new Promise((resolve) => {
    const start = Date.now();
    const check = () => {
      chrome.tabs.get(tabId).then(tab => {
        if (tab.status === 'complete') return resolve();
        if (Date.now() - start > timeoutMs) return resolve();
        setTimeout(check, 300);
      }).catch(() => resolve());
    };
    check();
  });
}

// ──────────────────────────────────────────────────────────────────
// バッチ実行: GASからキューを取得 → 各物件チェック → 結果を一括送信
// ──────────────────────────────────────────────────────────────────
async function runAvailabilityCheckBatch(options) {
  options = options || {};
  const limit = options.limit || 20;
  const maxAgeDays = options.maxAgeDays || 60;
  const maxIntervalHours = options.maxIntervalHours || 24;
  await setStorageData({ debugLog: `[空室確認] バッチ開始 (limit=${limit})` });

  // 1. キューを取得
  let queue;
  try {
    queue = await gasGet('get_availability_queue', {
      limit: limit,
      max_age_days: maxAgeDays,
      max_interval_hours: maxIntervalHours
    });
  } catch (e) {
    await setStorageData({ debugLog: `[空室確認] キュー取得失敗: ${e.message}` });
    return { processed: 0, error: e.message };
  }
  const items = (queue && Array.isArray(queue.items)) ? queue.items : [];
  if (items.length === 0) {
    // diag があれば理由を表示
    const d = queue && queue.diag;
    let reason = '確認対象なし';
    if (d) {
      reason += ` (総行数:${d.total} / URLマップ:${d.urlMapSize}件`;
      if (d.tooOld) reason += ` / 60日超過:${d.tooOld}`;
      if (d.isClosed) reason += ` / closed:${d.isClosed}`;
      if (d.recentlyChecked) reason += ` / 24h以内チェック済:${d.recentlyChecked}`;
      if (d.noUrl) reason += ` / URL無し:${d.noUrl}`;
      if (d.noSentAt) reason += ` / 通知日時無し:${d.noSentAt}`;
      reason += ')';
    }
    await setStorageData({ debugLog: `[空室確認] ${reason}` });
    return { processed: 0, diag: d };
  }
  await setStorageData({ debugLog: `[空室確認] ${items.length}件を確認します` });

  // 2. 各物件をチェック
  const results = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    try {
      const status = await checkOneAvailability(it);
      results.push({ customer: it.customer, room_id: it.roomId, status: status });
      await setStorageData({ debugLog: `[空室確認] ${i+1}/${items.length} ${it.customer}: ${it.source} → ${status}` });
    } catch (e) {
      await setStorageData({ debugLog: `[空室確認] ${i+1}/${items.length} ${it.customer}: エラー ${e.message}` });
    }
  }

  // 3. 一括 POST
  try {
    await gasPost({ action: 'update_availability', items: results });
    await setStorageData({ debugLog: `[空室確認] バッチ完了 (${results.length}件 更新)` });
  } catch (e) {
    await setStorageData({ debugLog: `[空室確認] 更新POST失敗: ${e.message}` });
  }

  return { processed: results.length, results: results };
}

// ──────────────────────────────────────────────────────────────────
// メッセージリスナー: popup から手動トリガー
// ──────────────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.action === 'run_availability_check') {
    runAvailabilityCheckBatch(msg.options || {}).then(r => sendResponse(r)).catch(e => sendResponse({ error: e.message }));
    return true; // async response
  }
});

globalThis.runAvailabilityCheckBatch = runAvailabilityCheckBatch;
globalThis.checkOneAvailability = checkOneAvailability;
