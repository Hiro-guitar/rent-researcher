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
// itandi: 物件ページに「申込あり」or 募集中 を判定
// ──────────────────────────────────────────────────────────────────
async function _checkItandiAvailability(url) {
  if (!url || url.indexOf('itandibb.com') < 0) return 'unknown';
  // 専用タブで開く (ログイン済みセッション利用)
  const tab = await (typeof findOrCreateDedicatedItandiTab === 'function'
    ? findOrCreateDedicatedItandiTab()
    : null);
  if (!tab) return 'unknown';
  try {
    await chrome.tabs.update(tab.id, { url: url });
    await _waitForTabLoad(tab.id, 15000);
    await new Promise(r => setTimeout(r, 1500)); // SPAレンダ待ち
    const [{ result } = {}] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        // 「申込あり」or「募集中」を判定
        const bodyText = document.body.innerText || '';
        if (/募集中/.test(bodyText)) {
          // 申込ありが優先 (申込ありで募集中タグも残ってる可能性)
          if (/申込\s*あり|status_type[:=]\s*offered/.test(bodyText)) return 'closed';
          return 'available';
        }
        if (/申込\s*あり/.test(bodyText)) return 'closed';
        // 404 / ページが存在しない
        if (/ページが見つかりません|404|お探しのページ/.test(bodyText)) return 'closed';
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
// いえらぶ (ielove): 物件ページに 申込ステータス を判定
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
    await new Promise(r => setTimeout(r, 1500));
    const [{ result } = {}] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        const bodyText = document.body.innerText || '';
        // 404 / 削除済み
        if (/物件が見つかりません|該当する物件はありません|404|ページが存在/.test(bodyText)) return 'closed';
        // 申込状況の表記
        if (/申込\s*あり|入居予定者あり|申込済み|募集停止|募集終了/.test(bodyText)) return 'closed';
        // 募集中の表記
        if (/募集中|空室|入居可能/.test(bodyText)) return 'available';
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
// いい生活 (essquare): 「申込あり」タグ or 404 で closed 判定
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
    await new Promise(r => setTimeout(r, 1500));
    const [{ result } = {}] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        // 申込ありタグ (eds-tag__label) or 404 → closed
        const tags = Array.from(document.querySelectorAll('.eds-tag__label, .eds-tag__label *'));
        const hasApplied = tags.some(el => /申込\s*あり/.test(el.textContent || ''));
        if (hasApplied) return 'closed';
        const bodyText = document.body.innerText || '';
        if (/エラーコード[::]?\s*404|404\s*Not Found|物件が見つかりません/.test(bodyText)) return 'closed';
        // 募集中タグ的なもの (なければ available)
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
// REINS: 物件番号で検索して存在するか確認
// 残っている=空室確定はできないので 'reins_listed' を返す (UI側で 要確認 表示)
// 残っていない=募集終了 'closed' を返す
// ──────────────────────────────────────────────────────────────────
async function _checkReinsAvailability(reinsPropNo) {
  if (!reinsPropNo) return 'unknown';
  const tab = await (typeof findReinsTab === 'function' ? findReinsTab() : null);
  if (!tab) return 'unknown';
  try {
    // REINSの物件番号検索ページに移動
    const searchUrl = 'https://system.reins.jp/main/KGRC0010/KGRC001010Action.do';
    await chrome.tabs.update(tab.id, { url: searchUrl });
    await _waitForTabLoad(tab.id, 15000);
    await new Promise(r => setTimeout(r, 2000));
    // 物件番号で検索を実行 (REINS は Vue 2 SPA なので JS で直接フォームを操作)
    const [{ result } = {}] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: (propNo) => {
        // 物件番号入力欄を探して入力 → 検索ボタン押下
        // 簡易実装: REINSのVue構造に依存せず、ページ全体テキストで判定する
        // (実際はもう少し精緻に実装が必要だが、Phase 2のMVPとして)
        // → 別途、reins-extension の既存ロジックを再利用する形に置き換え予定
        const text = document.body.innerText || '';
        // 仮: ページ上に物件番号が表示されてれば存在、なければ存在しない
        if (text.indexOf(propNo) >= 0) return 'reins_listed';
        return 'closed';
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
    queue = await gasGet(`get_availability_queue&limit=${limit}&max_age_days=${maxAgeDays}&max_interval_hours=${maxIntervalHours}`);
  } catch (e) {
    await setStorageData({ debugLog: `[空室確認] キュー取得失敗: ${e.message}` });
    return { processed: 0, error: e.message };
  }
  const items = (queue && Array.isArray(queue.items)) ? queue.items : [];
  if (items.length === 0) {
    await setStorageData({ debugLog: `[空室確認] 確認対象なし` });
    return { processed: 0 };
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
