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

        // ──────────────────────────────────────────────
        // 判定:
        //   申込ありシグナル (テキスト「申込あり」) が **ある** 場合のみ、
        //   WEB申込ボタン (.CommonButton.isDetail) の状態で applied/closed を切り分け。
        //
        //   ・hasApplyLink (a[href*="bukkakun.com"][href*="select_apply"]) + 非 disabled
        //       → applied (キャンセル待ち可)
        //   ・button[disabled] / button.Mui-disabled / badge "?"
        //       → closed (キャンセル待ち不可)
        //
        //   申込ありシグナル **なし** の場合、ボタンの disabled は判定に使わない。
        //   (Web申込非対応店舗でも disabled になるため、available に倒す)
        // ──────────────────────────────────────────────
        const commonButtons = [...document.querySelectorAll('.CommonButton.isDetail')];
        const webCommonBtn = commonButtons.find(el => /^WEB/i.test((el.textContent || '').trim()));
        const hasOfferedText = /申込\s*あり|status[_-]?type\s*[:=]\s*offered/i.test(bodyText);

        if (webCommonBtn) {
          const hasApplyLink = !!webCommonBtn.querySelector('a[href*="bukkakun.com"][href*="select_apply"]');
          const webBtnDisabled = !!webCommonBtn.querySelector('button[disabled], button.Mui-disabled');
          const badgeText = (webCommonBtn.querySelector('.MuiBadge-badge')?.textContent || '').trim();

          if (hasOfferedText) {
            // 申込ありシグナルがある時のみキャンセル待ち可/不可で細分判定
            if (hasApplyLink && !webBtnDisabled) return 'applied';   // キャンセル待ち可
            if (webBtnDisabled || badgeText === '?') return 'closed'; // キャンセル待ち不可
            return 'applied';  // ambiguous: 申込ありだが詳細不明
          }
          // 申込ありシグナルなし → ボタンの disabled は判定材料にしない
          // (Web申込非対応店舗で disabled になるため誤判定の元)
          // 明示的な募集終了テキストだけ closed として拾う
          if (/取り下げ|募集停止|募集終了|申込受付終了/.test(bodyText)) return 'closed';
          return 'available';
        }

        // CommonButton が見つからない場合のフォールバック
        // 募集中
        const blocks = document.querySelectorAll('div[class*="Block"][class*="Left"], .BlockLeft, div.block.left');
        for (const el of blocks) {
          if ((el.textContent || '').includes('募集中')) return 'available';
        }
        if (/募集中/.test(bodyText)) return 'available';
        // 申込あり (キャンセル待ち判定不能なら applied 扱い)
        if (/申込\s*あり/.test(bodyText)) return 'applied';
        // 取り下げ / 募集終了 → closed
        if (/取り下げ|募集停止|募集終了|申込受付終了/.test(bodyText)) return 'closed';
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
//   判定の主軸は「募集状況」を表す3つのspan。
//   申込書出力ボタンの disabled は判定材料に使わない
//   (Web申込非対応の管理会社でも disabled になるため誤判定の元)
//
//   優先順位:
//     1. span.no-confirm 「物確不要」あり → closed (募集終了の強いシグナル)
//     2. span.exists_application_for_confirm のテキスト
//        - 「申込N件」(件数つき) → closed
//        - 「申込あり」          → applied (キャンセル待ち可)
//        - その他                → applied
//     3. span.for-rent 「募集中」あり → available
//        (Web申込ボタンの disabled は無視)
//     4. どれも該当なし → unknown
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
        // 掲載終了 / 削除済 (closed)
        if (/既に掲載が終了|掲載が終了|物件は存在しません|該当する物件はありません|ページが見つかりません/.test(bodyText)) {
          return 'closed';
        }

        // ── 募集状況の主要シグナル ──
        const forRentEl = document.querySelector('span.for-rent');
        const existsAppEl = document.querySelector('span.exists_application_for_confirm');
        const noConfirmEl = document.querySelector('span.no-confirm');

        const forRentText = forRentEl ? (forRentEl.textContent || '').trim() : '';
        const existsAppText = existsAppEl ? (existsAppEl.textContent || '').trim() : '';
        const noConfirmText = noConfirmEl ? (noConfirmEl.textContent || '').trim() : '';

        // 1. 「物確不要」 → closed (募集終了)
        if (/物確不要/.test(noConfirmText)) return 'closed';

        // 2. 申込状況テキスト
        if (existsAppText) {
          // 「申込N件」(件数表示) → closed
          if (/^申込\s*\d+\s*件$/.test(existsAppText)) return 'closed';
          // 「申込あり」 → applied (キャンセル待ち可)
          if (/申込\s*あり/.test(existsAppText)) return 'applied';
          // その他のテキスト (申込済 等) → applied
          return 'applied';
        }

        // 3. 「募集中」 → available
        //    (申込書出力ボタンが disabled でも Web申込非対応の管理会社なので無視)
        if (/募集中/.test(forRentText)) return 'available';

        // 4. フォールバック (3spanが取れなかった場合のテキスト判定)
        if (/募集\s*中止|募集停止|募集終了|成約|契約済/.test(bodyText)) return 'closed';
        if (/申込\s*\d+\s*件/.test(bodyText)) return 'closed';
        if (/申込\s*あり|入居予定者あり|申込済/.test(bodyText)) return 'applied';
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
// いい生活 (es-square):
//   404モーダル / ページ削除 → closed
//
//   申込ボタン (MuiButton-outlinedPrimary, テキスト「申込」) の状態 +
//   「申込あり」を示す2種類のタグ で判定:
//
//     ・eds-tag 「申込あり」(赤系ソフトタグ) = キャンセル待ち可ケース固有
//     ・MuiChip 「申込あり」 = 申込中なら付くチップ (URL1/URL2両方)
//     ・申込ボタン disabled = キャンセル待ち不可 OR Web申込非対応店舗
//
//   判定ロジック:
//     1. eds-tag 「申込あり」あり + ボタン活性  → applied (キャンセル待ち可)
//     2. eds-tag 「申込あり」あり + ボタン無効  → closed  (異常ケース)
//     3. MuiChip 「申込あり」あり + ボタン無効 → closed  (URL1: キャンセル待ち不可)
//     4. MuiChip 「申込あり」あり + ボタン活性 → applied (キャンセル待ち可と推定)
//     5. ボタン無効のみ (申込タグなし)         → available (Web申込非対応店舗の可能性大)
//     6. それ以外 (ボタン活性 + タグなし)       → available (募集中)
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
    await new Promise(r => setTimeout(r, 2500));
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

        // ──────────────────────────────────────────────
        // 「申込」ボタン (MuiButton-outlinedPrimary) を探す
        //   - テキストが正確に「申込」のラベル要素を内包する <button>
        //   - 複数あれば最も上部 (top が小さい) のものを優先
        // ──────────────────────────────────────────────
        const applyBtnCandidates = [...document.querySelectorAll('button')].filter(btn => {
          if (!/MuiButton-outlinedPrimary/.test(btn.className || '')) return false;
          const labelEl = [...btn.querySelectorAll('div, span')]
            .find(el => el.children.length === 0 && (el.textContent || '').trim() === '申込');
          return !!labelEl;
        });
        // 上部に近いものを優先
        applyBtnCandidates.sort((a, b) => {
          const ra = a.getBoundingClientRect();
          const rb = b.getBoundingClientRect();
          return ra.top - rb.top;
        });
        const applyBtn = applyBtnCandidates[0];

        // 「申込あり」を示すタグを2系統チェック
        //   - eds-tag (赤系ソフトタグ): キャンセル待ち可ケースに固有
        //   - MuiChip: 申込中なら付く (キャンセル待ち可/不可 両方)
        const edsApplyTag = [...document.querySelectorAll('span.eds-tag, span[class*="eds-tag"]')]
          .find(el => (el.textContent || '').trim() === '申込あり');
        const muiApplyChip = [...document.querySelectorAll('.MuiChip-root, span[class*="MuiChip"]')]
          .find(el => /申込あり/.test((el.textContent || '').trim()));

        if (applyBtn) {
          const isDisabled =
            applyBtn.disabled ||
            applyBtn.getAttribute('aria-disabled') === 'true' ||
            /Mui-disabled/.test(applyBtn.className || '');

          // 1. eds-tag 「申込あり」あり = キャンセル待ち可ケース
          if (edsApplyTag) {
            return isDisabled ? 'closed' : 'applied';
          }
          // 2. MuiChip 「申込あり」あり + ボタン無効 = キャンセル待ち不可 (URL1パターン)
          // 3. MuiChip 「申込あり」あり + ボタン活性 = applied (キャンセル待ち可と推定)
          if (muiApplyChip) {
            return isDisabled ? 'closed' : 'applied';
          }
          // 4. 申込タグなし + ボタン無効
          //    → キャンセル待ち不可 OR Web申込非対応店舗
          //    → 申込シグナルが無い以上、available 寄りで判定 (誤って closed にしない)
          if (isDisabled) {
            // 念のため募集終了テキストもチェック
            if (/申込受付終了|募集終了|募集停止|成約|契約済/.test(allText)) return 'closed';
            return 'available';
          }
          // 5. ボタン活性 + 申込タグなし → 募集中
          return 'available';
        }

        // 申込ボタンが見つからない場合のフォールバック
        if (edsApplyTag || muiApplyChip) return 'applied';
        if (/申込受付終了|募集終了|募集停止|成約|契約済/.test(allText)) return 'closed';
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
//   options.singleBatch=true なら1サイクルで終了 (旧挙動)
//   それ以外はキューが空になるまでループ (全件モード)
//   chrome.storage.local.__availabilityCheckStop=true で途中中断
// ──────────────────────────────────────────────────────────────────
async function runAvailabilityCheckBatch(options) {
  options = options || {};
  const batchSize = options.batchSize || options.limit || 30;
  const maxAgeDays = options.maxAgeDays || 60;
  const maxIntervalHours = options.maxIntervalHours || 24;
  const singleBatch = options.singleBatch === true;
  const maxCycles = options.maxCycles || 200; // 安全上限 (batchSize=30 で最大 6000 件)

  // 開始時に中断フラグをクリア & 実行フラグON
  await new Promise(r => chrome.storage.local.set({
    __availabilityCheckStop: false,
    __availabilityCheckRunning: true
  }, r));

  await setStorageData({
    debugLog: singleBatch
      ? `[空室確認] バッチ開始 (limit=${batchSize})`
      : `[空室確認] 全件モード開始 (batchSize=${batchSize})`
  });

  let totalProcessed = 0;
  let totalErrors = 0;
  let cycle = 0;
  let lastDiag = null;
  const seenKeys = new Set();  // 二度目に同じ key が出てきたら無限ループ判定で中断

  try {
    while (cycle < maxCycles) {
      cycle++;

      // 中断フラグ確認
      const stopFlag = await new Promise(r =>
        chrome.storage.local.get(['__availabilityCheckStop'], d => r(!!d.__availabilityCheckStop))
      );
      if (stopFlag) {
        await setStorageData({ debugLog: `[空室確認] 中断要求を検知。停止します (累計 ${totalProcessed} 件)` });
        return { processed: totalProcessed, cycles: cycle - 1, stopped: true };
      }

      // 1. キュー取得
      let queue;
      try {
        queue = await gasGet('get_availability_queue', {
          limit: batchSize,
          max_age_days: maxAgeDays,
          max_interval_hours: maxIntervalHours
        });
      } catch (e) {
        await setStorageData({ debugLog: `[空室確認] キュー取得失敗: ${e.message}` });
        return { processed: totalProcessed, error: e.message };
      }
      const items = (queue && Array.isArray(queue.items)) ? queue.items : [];
      lastDiag = queue && queue.diag;

      if (items.length === 0) {
        // 1サイクル目で 0 件 → 対象なし
        if (cycle === 1) {
          let reason = '確認対象なし';
          if (lastDiag) {
            reason += ` (総行数:${lastDiag.total} / URLマップ:${lastDiag.urlMapSize}件`;
            if (lastDiag.tooOld) reason += ` / 60日超過:${lastDiag.tooOld}`;
            if (lastDiag.isClosed) reason += ` / closed:${lastDiag.isClosed}`;
            if (lastDiag.recentlyChecked) reason += ` / 24h以内チェック済:${lastDiag.recentlyChecked}`;
            if (lastDiag.noUrl) reason += ` / URL無し:${lastDiag.noUrl}`;
            if (lastDiag.noSentAt) reason += ` / 通知日時無し:${lastDiag.noSentAt}`;
            reason += ')';
          }
          await setStorageData({ debugLog: `[空室確認] ${reason}` });
          return { processed: 0, diag: lastDiag };
        }
        // ループ完了
        await setStorageData({ debugLog: `[空室確認] 全件完了 (累計 ${totalProcessed} 件 / ${cycle - 1} サイクル / エラー ${totalErrors})` });
        return { processed: totalProcessed, cycles: cycle - 1, errors: totalErrors };
      }

      // 無限ループ防止: このサイクルの全アイテムが既出ならばエラーで停止
      const allSeen = items.every(it => seenKeys.has(it.customer + '|' + it.roomId));
      if (allSeen && !singleBatch) {
        await setStorageData({
          debugLog: `[空室確認] 同じ ${items.length} 件を再受信。チェック結果がGAS側で反映されていない可能性。中断します (累計 ${totalProcessed})`
        });
        return { processed: totalProcessed, cycles: cycle, error: 'duplicate_batch' };
      }
      items.forEach(it => seenKeys.add(it.customer + '|' + it.roomId));

      const cyclePrefix = singleBatch ? '' : `[サイクル${cycle}] `;
      await setStorageData({ debugLog: `[空室確認] ${cyclePrefix}${items.length}件を確認します (累計 ${totalProcessed})` });

      // 2. 各物件をチェック
      const results = [];
      for (let i = 0; i < items.length; i++) {
        // 物件毎に中断フラグ確認
        const stopMid = await new Promise(r =>
          chrome.storage.local.get(['__availabilityCheckStop'], d => r(!!d.__availabilityCheckStop))
        );
        if (stopMid) {
          await setStorageData({ debugLog: `[空室確認] 中断要求を検知。サイクル中で停止 (このサイクルの ${results.length} 件のみ更新)` });
          break;
        }
        const it = items[i];
        try {
          const status = await checkOneAvailability(it);
          results.push({ customer: it.customer, room_id: it.roomId, status: status });
          await setStorageData({
            debugLog: `[空室確認] ${totalProcessed + i + 1}: ${it.customer} ${it.source} → ${status}`
          });
        } catch (e) {
          totalErrors++;
          // 例外時も 'unknown' を返して checkedAt を更新 (次サイクルでスキップ)
          results.push({ customer: it.customer, room_id: it.roomId, status: 'unknown' });
          await setStorageData({
            debugLog: `[空室確認] ${totalProcessed + i + 1}: ${it.customer} エラー ${e.message} (unknown扱い)`
          });
        }
      }

      // 3. 一括 POST (このサイクル分)
      if (results.length > 0) {
        try {
          await gasPost({ action: 'update_availability', items: results });
        } catch (e) {
          await setStorageData({ debugLog: `[空室確認] 更新POST失敗: ${e.message} (中断)` });
          return { processed: totalProcessed + results.length, error: e.message };
        }
      }
      totalProcessed += results.length;

      // 中断確認 (POST後の最終チェック)
      const stopAfter = await new Promise(r =>
        chrome.storage.local.get(['__availabilityCheckStop'], d => r(!!d.__availabilityCheckStop))
      );
      if (stopAfter) {
        await setStorageData({ debugLog: `[空室確認] 中断完了 (累計 ${totalProcessed} 件)` });
        return { processed: totalProcessed, cycles: cycle, stopped: true };
      }

      if (singleBatch) break;
    }

    if (cycle >= maxCycles) {
      await setStorageData({ debugLog: `[空室確認] 安全上限 ${maxCycles} サイクル到達。停止します (累計 ${totalProcessed} 件)` });
    }
    return { processed: totalProcessed, cycles: cycle, errors: totalErrors };
  } finally {
    await new Promise(r => chrome.storage.local.set({ __availabilityCheckRunning: false }, r));
  }
}

// 外部から中断要求を受け取る
async function stopAvailabilityCheck() {
  await new Promise(r => chrome.storage.local.set({ __availabilityCheckStop: true }, r));
}

// ──────────────────────────────────────────────────────────────────
// 優先キューのポーリング (お客さんがボタンを押した物件をリアルタイム処理)
// 1分毎の alarm で呼ばれる。priority_only=1 で優先依頼のみ取得。
// ──────────────────────────────────────────────────────────────────
async function runPriorityAvailabilityPoll() {
  // 全件モード実行中ならスキップ (衝突防止)
  const running = await new Promise(r =>
    chrome.storage.local.get(['__availabilityCheckRunning'], d => r(!!d.__availabilityCheckRunning))
  );
  if (running) {
    console.log('[priority-poll] 通常モード実行中のためスキップ');
    return { skipped: 'running' };
  }

  let queue;
  try {
    queue = await gasGet('get_availability_queue', {
      limit: 5,
      priority_only: 1,
      max_priority_age_minutes: 60
    });
  } catch (e) {
    console.warn('[priority-poll] キュー取得失敗: ' + e.message);
    return { error: e.message };
  }
  const items = (queue && Array.isArray(queue.items)) ? queue.items : [];
  if (items.length === 0) return { processed: 0 };

  await setStorageData({ debugLog: `[優先空室確認] ${items.length}件の即時依頼を処理` });

  const results = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    try {
      const status = await checkOneAvailability(it);
      results.push({ customer: it.customer, room_id: it.roomId, status: status });
      await setStorageData({
        debugLog: `[優先空室確認] ${it.customer} ${it.source} → ${status}`
      });
    } catch (e) {
      results.push({ customer: it.customer, room_id: it.roomId, status: 'unknown' });
      await setStorageData({
        debugLog: `[優先空室確認] ${it.customer} エラー ${e.message}`
      });
    }
  }

  try {
    await gasPost({ action: 'update_availability', items: results });
  } catch (e) {
    await setStorageData({ debugLog: `[優先空室確認] 結果POST失敗: ${e.message}` });
    return { processed: results.length, error: e.message };
  }
  return { processed: results.length };
}

// ──────────────────────────────────────────────────────────────────
// メッセージリスナー: popup から手動トリガー
// ──────────────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.action === 'run_availability_check') {
    runAvailabilityCheckBatch(msg.options || {}).then(r => sendResponse(r)).catch(e => sendResponse({ error: e.message }));
    return true; // async response
  }
  if (msg && msg.action === 'stop_availability_check') {
    stopAvailabilityCheck().then(() => sendResponse({ ok: true })).catch(e => sendResponse({ error: e.message }));
    return true;
  }
});

globalThis.runAvailabilityCheckBatch = runAvailabilityCheckBatch;
globalThis.checkOneAvailability = checkOneAvailability;
globalThis.stopAvailabilityCheck = stopAvailabilityCheck;
globalThis.runPriorityAvailabilityPoll = runPriorityAvailabilityPoll;
