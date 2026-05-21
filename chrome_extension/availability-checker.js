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
// itandi: 募集中 / 申込あり / 募集終了 を判定。
//   - 申込ありは「キャンセル待ち可」「キャンセル待ち不可」の2種類あり、
//     不可は実質募集終了扱いとして closed を返す。
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
    await new Promise(r => setTimeout(r, 2000));
    const [{ result } = {}] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        const bodyText = document.body.innerText || '';
        // 404 / 掲載削除 (closed)
        if (/このページは存在しません|お探しのページ|404\s*Not\s*Found|ページが見つかりません/i.test(bodyText)) return 'closed';
        const hasOffered = /申込\s*あり|status[_-]?type\s*[:=]\s*offered/i.test(bodyText);
        if (hasOffered) {
          // 申込あり: キャンセル待ち可能性を判定
          //   - キャンセル待ち登録ボタン or 「キャンセル待ち」テキストあり → applied
          //   - 申込受付終了 / キャンセル待ち不可 / 内見/Web申込ボタンが disabled → closed
          // ボタンの disabled 判定: aria-disabled / disabled 属性 / class に disable を含む
          function isDisabled(el) {
            if (!el) return true;
            if (el.disabled) return true;
            if (el.getAttribute && el.getAttribute('aria-disabled') === 'true') return true;
            const cls = (el.className || '').toString();
            if (/disable|inactive|gray|gray-?out/i.test(cls)) return true;
            return false;
          }
          // 「キャンセル待ち」関連ボタン / リンク
          const cancelWaitEls = [...document.querySelectorAll('button, a, [role="button"]')]
            .filter(el => /キャンセル待ち|キャンセル待\s/.test(el.textContent || ''));
          if (cancelWaitEls.length > 0 && cancelWaitEls.some(el => !isDisabled(el))) {
            return 'applied'; // キャンセル待ち登録できる
          }
          // 「申込受付終了」「キャンセル待ち不可」テキスト → closed
          if (/申込受付終了|キャンセル待ち\s*不可|受付終了/i.test(bodyText)) return 'closed';
          // Web申込・内見予約ボタンの活性チェック
          const webApply = [...document.querySelectorAll('button, a')].find(el => /Web\s*申込|ウェブ申込/i.test(el.textContent || ''));
          const naiken   = [...document.querySelectorAll('button, a')].find(el => /内見/i.test(el.textContent || ''));
          const webOk    = webApply && !isDisabled(webApply);
          const naikenOk = naiken   && !isDisabled(naiken);
          if (!webOk && !naikenOk) return 'closed'; // 両方押せない=キャンセル待ち不可
          return 'applied';
        }
        // 募集中
        const blocks = document.querySelectorAll('div[class*="Block"][class*="Left"], .BlockLeft, div.block.left');
        for (const el of blocks) {
          if ((el.textContent || '').includes('募集中')) return 'available';
        }
        if (/募集中/.test(bodyText)) return 'available';
        // 取り下げ / 募集終了 → closed
        if (/取り下げ|募集停止|募集終了/.test(bodyText)) return 'closed';
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
// いえらぶ (ielove BB):
//   募集状況 「申込N件」 or span.exists_application_for_confirm → applied
//   span.for-rent / 募集中表記 → available
//   既に掲載が終了 → closed
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
        const bodyText = document.body.innerText || '';
        // 掲載終了 (closed)
        if (/既に掲載が終了|掲載が終了|物件は存在しません|該当する物件はありません/.test(bodyText)) return 'closed';
        // 申込あり (applied)
        //   - 「申込N件」 (募集状況バッジ) → applied
        //   - span.exists_application_for_confirm → applied
        //   - 「申込あり」「入居予定者あり」「申込済」 → applied
        if (/申込\s*\d+\s*件/.test(bodyText)) return 'applied';
        if (document.querySelector('span.exists_application_for_confirm')) return 'applied';
        if (/申込\s*あり|入居予定者あり|申込済/.test(bodyText)) return 'applied';
        // 募集中 (available)
        if (document.querySelector('span.for-rent')) return 'available';
        if (/募集中|入居可能/.test(bodyText)) return 'available';
        // 募集停止/終了 → closed
        if (/募集停止|募集終了/.test(bodyText)) return 'closed';
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
// いい生活 (es-square):
//   404モーダル / ページ削除 → closed
//   eds-tag__label 「申込あり」 → applied
//   それ以外 → available
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
        // 404モーダル / 削除済み を最優先で判定 (closed)
        const allText = (document.documentElement && document.documentElement.innerText) || document.body.innerText || '';
        const closedPatterns = [
          /お探しのページ.{0,10}見つかりません/,
          /エラーコード[::\s]*404/,
          /404\s*Not\s*Found/i,
          /物件が見つかりません/,
          /アクセスができないか/,
          /移動または削除された/,
          /該当する物件はありません/
        ];
        for (const re of closedPatterns) {
          if (re.test(allText)) return 'closed';
        }
        const title = (document.title || '').toLowerCase();
        if (title.includes('not found') || title.includes('404') || (document.title || '').includes('見つかりません')) return 'closed';
        // 申込あり (applied) — eds-tag__label
        const tags = document.querySelectorAll('span.eds-tag__label');
        for (const el of tags) {
          if ((el.textContent || '').trim() === '申込あり') return 'applied';
        }
        // それ以外は available
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
