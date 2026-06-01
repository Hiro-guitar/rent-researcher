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
 * 物件1件の空室状況を確認。
 * @param {{source: string, url: string, reinsPropNo: string}} item
 * @return {Promise<{status:string, badgeCount?:number, canApply?:boolean, listingStatus?:string}>}
 */
async function checkOneAvailability(item) {
  const source = String(item.source || '').toLowerCase();
  const url = String(item.url || '');
  try {
    let res;
    if (source === 'itandi')   res = await _checkItandiAvailability(url);
    else if (source === 'ielove')   res = await _checkIeloveAvailability(url);
    else if (source === 'essquare') res = await _checkEssquareAvailability(url);
    else if (source === 'reins')    res = await _checkReinsAvailability(item.reinsPropNo || '');
    else return { status: 'unknown' };
    // 後方互換: 文字列が返ってきた場合は status のみとして包む
    if (typeof res === 'string') return { status: res };
    return res || { status: 'unknown' };
  } catch (e) {
    console.warn(`[availability] ${source} check failed: ${e.message}`);
  }
  return { status: 'unknown' };
}

// ──────────────────────────────────────────────────────────────────
// itandi:
//   判定優先順位 (ユーザールールに準拠):
//
//   1. 404 / 掲載削除                              → closed
//   2. listing_status = 成約 / 契約済 / 公開停止   → closed
//   3. listing_status = 申込あり                   → applied
//      (要物確であっても、ボタン disabled でも申込あり優先)
//      理由: 申込済みでも、キャンセル発生時に通知できる価値がある
//   4. (申込ありでない) + 要物確 / 要確認          → needs_confirmation
//      (募集中だが元付業者への物確が必要、Discord通知)
//   5. WEBバッジ ≥ 1                              → applied
//      (バッジに数字が入っている = 申込予約あり)
//   6. listing_status = 募集中                     → available
//   7. それ以外                                    → unknown
//
//   ※ ボタンの disabled / apply link 判定は使わない
//     (申込ありの細分判定は不要、Web申込非対応店舗誤検出も回避)
// ──────────────────────────────────────────────────────────────────
async function _checkItandiAvailability(url) {
  if (!url || url.indexOf('itandibb.com') < 0) return { status: 'unknown' };
  const tab = await (typeof findOrCreateDedicatedItandiTab === 'function'
    ? findOrCreateDedicatedItandiTab()
    : null);
  if (!tab) return { status: 'unknown' };
  try {
    await chrome.tabs.update(tab.id, { url: url });
    await _waitForTabLoad(tab.id, 15000);
    await new Promise(r => setTimeout(r, 2000));
    const [{ result } = {}] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        const bodyText = document.body.innerText || '';

        // ── 共通: WEBバッジ数取得 ──
        let webBadgeCount = -1;
        const badges = document.querySelectorAll('[class*="Badge-badge"], [class*="badge"]');
        for (const badge of badges) {
          const parent = badge.closest('[class*="Badge-root"]') || badge.parentElement;
          if (parent && parent.textContent.includes('WEB')) {
            const num = parseInt((badge.textContent || '').trim(), 10);
            webBadgeCount = isNaN(num) ? 0 : num;
            break;
          }
        }
        if (webBadgeCount === -1) {
          const allEls = document.querySelectorAll('button, span, a');
          for (const el of allEls) {
            const txt = (el.textContent || '').trim();
            if (txt === 'WEB' || txt.startsWith('WEB')) {
              const badgeEl = el.querySelector('[class*="badge"], [class*="Badge"]')
                           || (el.parentElement && el.parentElement.querySelector('[class*="badge"], [class*="Badge"]'));
              if (badgeEl) {
                const num = parseInt((badgeEl.textContent || '').trim(), 10);
                webBadgeCount = isNaN(num) ? 0 : num;
                break;
              }
            }
          }
        }
        if (webBadgeCount === -1) {
          const webMatch = bodyText.match(/WEB[\s\n]+(\d+)/);
          if (webMatch) webBadgeCount = parseInt(webMatch[1], 10);
        }

        // ── 共通: WEB申込ボタンの可否 ──
        const commonButtons = [...document.querySelectorAll('.CommonButton.isDetail')];
        const webCommonBtn = commonButtons.find(el => /^WEB/i.test((el.textContent || '').trim()));
        let canApply = null;  // 不明
        if (webCommonBtn) {
          const webBtnDisabled = !!webCommonBtn.querySelector('button[disabled], button.Mui-disabled');
          canApply = !webBtnDisabled;
        }

        const badgeOut = (webBadgeCount >= 0) ? webBadgeCount : null;

        // 1. 404 / 掲載削除
        if (/このページは存在しません|お探しのページ|404\s*Not\s*Found|ページが見つかりません/i.test(bodyText)) {
          return { status: 'closed' };
        }

        // 2. listing_status (テキスト検出)
        const knownStatuses = ['申込あり', '成約', '公開停止', '契約済み', '募集中'];
        let listingStatus = '';
        for (const s of knownStatuses) {
          if (bodyText.includes(s)) { listingStatus = s; break; }
        }
        if (listingStatus === '成約' || listingStatus === '契約済み' || listingStatus === '公開停止') {
          return { status: 'closed', listingStatus: listingStatus };
        }

        // 3. 「申込あり」 (要物確より優先)
        const hasOfferedText = listingStatus === '申込あり' || /status[_-]?type\s*[:=]\s*offered/i.test(bodyText);
        if (hasOfferedText) {
          return { status: 'applied', badgeCount: badgeOut, canApply: canApply, listingStatus: '申込あり' };
        }

        // 4. (申込ありでない) + 要物確 → スタッフ確認必要
        if (/要物確|要確認/.test(bodyText)) {
          return { status: 'needs_confirmation', listingStatus: listingStatus || '募集中' };
        }

        // 5. WEBバッジ ≥ 1 → 申込予約あり
        if (badgeOut !== null && badgeOut >= 1) {
          return { status: 'applied', badgeCount: badgeOut, canApply: canApply, listingStatus: listingStatus || '募集中' };
        }

        // 6. 募集中
        if (listingStatus === '募集中') {
          return { status: 'available', badgeCount: badgeOut, canApply: canApply, listingStatus: '募集中' };
        }
        // 7. フォールバック
        if (/募集中/.test(bodyText)) return { status: 'available', badgeCount: badgeOut, canApply: canApply };
        if (/取り下げ|募集停止|募集終了|申込受付終了/.test(bodyText)) return { status: 'closed' };
        return { status: 'unknown' };
      }
    });
    return result || { status: 'unknown' };
  } catch (e) {
    console.warn('[availability/itandi] ' + e.message);
    return { status: 'unknown' };
  }
}

// ──────────────────────────────────────────────────────────────────
// いえらぶ (ielove BB):
//   判定の主軸は「募集状況」を表す4つのspan + Web申込みボタン状態。
//
//   DOM構造 (詳細ページ):
//     - table.leasing-detail-info 内の span で募集状況を判定
//     - .right-side-menu の子要素 BUTTON+SPAN ペアで Web申込み活性を検出
//       (Web申込み BUTTON: disabled属性 or disabled_btn/disable-btn クラス)
//       (Web申込み SPAN: disable-text クラス)
//
//   canApply の注意点:
//     Web申込み disabled ≠ 募集終了。Web申込非対応の管理会社でも disabled に
//     なるため、canApply は主判定には使わない。情報としてのみ返す。
//
//   判定優先順位:
//     1. 掲載終了テキスト                            → closed
//     2. span.confirm-required「要物確」             → needs_confirmation
//        (スタッフが元付業者に物件確認が必要、Discord通知)
//        ※ 募集中でも要物確の場合があるため最優先で判定
//     3. span.no-confirm「物確不要」                 → closed (確実に募集終了)
//     4. span.exists_application_for_confirm
//        「申込N件」/「申込あり」                     → applied
//        (2番手申込可能 or キャンセル時通知)
//     5. span.for-rent「募集中」                     → available
//     6. どれも該当なし                               → unknown
// ──────────────────────────────────────────────────────────────────
async function _checkIeloveAvailability(url) {
  if (!url || (url.indexOf('ielove') < 0 && url.indexOf('homes.co.jp') < 0)) return { status: 'unknown' };
  const tab = await (typeof findOrCreateDedicatedIeloveTab === 'function'
    ? findOrCreateDedicatedIeloveTab()
    : null);
  if (!tab) return { status: 'unknown' };
  try {
    await chrome.tabs.update(tab.id, { url: url });
    await _waitForTabLoad(tab.id, 15000);
    await new Promise(r => setTimeout(r, 2000));
    const [{ result } = {}] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        const bodyText = document.body.innerText || '';

        // 1. 掲載終了 / 削除済 (closed)
        if (/既に掲載が終了|掲載が終了|物件は存在しません|該当する物件はありません|ページが見つかりません/.test(bodyText)) {
          return { status: 'closed', listingStatus: '掲載終了' };
        }

        // ── 募集状況の主要シグナル (4つのspan) ──
        const forRentEl = document.querySelector('span.for-rent');
        const existsAppEl = document.querySelector('span.exists_application_for_confirm');
        const noConfirmEl = document.querySelector('span.no-confirm');
        const confirmRequiredEl = document.querySelector('span.confirm-required');

        const forRentText = forRentEl ? (forRentEl.textContent || '').trim() : '';
        const existsAppText = existsAppEl ? (existsAppEl.textContent || '').trim() : '';
        const noConfirmText = noConfirmEl ? (noConfirmEl.textContent || '').trim() : '';

        // ── Web申込みボタンの活性/無効 (canApply) ──
        // .right-side-menu の子要素で BUTTON + SPAN "Web申込み" ペアを探す
        // ※ 主判定には使わない (Web申込非対応店舗で disabled になるため)
        // ※ キャンセル監視で canApply の変化を検知するために情報として返す
        let canApply = null;
        const sideMenu = document.querySelector('.right-side-menu');
        if (sideMenu) {
          const children = [...sideMenu.children];
          for (let i = 0; i < children.length; i++) {
            const child = children[i];
            if (child.tagName === 'SPAN' && /Web申込/.test(child.textContent)) {
              // この SPAN の直前の BUTTON が Web申込みボタン
              const btn = (i > 0 && children[i - 1].tagName === 'BUTTON') ? children[i - 1] : null;
              if (btn) {
                const isDisabled = btn.disabled
                  || /disabled_btn|disable-btn/.test(btn.className || '');
                canApply = !isDisabled;
              } else {
                // BUTTON が見つからない場合は SPAN のクラスで判定
                canApply = !/disable-text/.test(child.className || '');
              }
              break;
            }
          }
        }

        // 2. span.confirm-required (「要物確」) → needs_confirmation
        //    要物確がある時点で Discord 通知
        //    申込情報がある場合は applicationStatus に含めて返す
        if (confirmRequiredEl) {
          return {
            status: 'needs_confirmation',
            listingStatus: '要物確',
            applicationStatus: existsAppText || null,
            canApply
          };
        }

        // 3. 「物確不要」 → closed (確実に募集終了)
        if (/物確不要/.test(noConfirmText)) {
          return { status: 'closed', listingStatus: '物確不要' };
        }

        // 4. 申込状況テキスト → applied
        //    「申込N件」「申込あり」いずれも applied
        //    canApply=true なら 2番手でキャンセル待ち申込可能
        if (existsAppText) {
          return { status: 'applied', listingStatus: existsAppText, canApply };
        }

        // 5. 「募集中」 → available
        if (/募集中/.test(forRentText)) {
          return { status: 'available', listingStatus: '募集中', canApply };
        }

        // 6. フォールバック (テキストベース判定)
        if (/募集\s*中止|募集停止|募集終了|成約|契約済/.test(bodyText)) {
          return { status: 'closed', listingStatus: '募集終了' };
        }
        if (/申込\s*\d+\s*件/.test(bodyText)) {
          const m = bodyText.match(/申込\s*\d+\s*件/);
          return { status: 'applied', listingStatus: m ? m[0] : '申込あり', canApply };
        }
        if (/申込\s*あり|入居予定者あり|申込済/.test(bodyText)) {
          return { status: 'applied', listingStatus: '申込あり', canApply };
        }
        if (/募集中|入居可能/.test(bodyText)) {
          return { status: 'available', listingStatus: '募集中', canApply };
        }

        return { status: 'unknown' };
      }
    });
    return result || { status: 'unknown' };
  } catch (e) {
    console.warn('[availability/ielove] ' + e.message);
    return { status: 'unknown' };
  }
}

// ──────────────────────────────────────────────────────────────────
// いい生活 (es-square):
//   DOM構造 (詳細パネル):
//     - ヘッダーに「申込」ボタン (MuiButton-outlinedPrimary, テキスト「申込」)
//     - ボタン内SVGの data-testid でアイコン種別を判別:
//       FeatherIcon = Web申込対応 (ペンアイコン)
//       PhoneIcon   = Web申込非対応 (電話マーク、元付に電話確認が必要)
//     - eds-tag__label 「申込あり」= 申込が入っている物件
//     - 404はモーダルダイアログで表示
//
//   判定優先順位:
//     1. 404モーダル / ページ削除                    → closed
//     2. 申込ボタンが PhoneIcon (電話マーク)         → needs_confirmation
//        (Web申込非対応、スタッフが元付に電話確認が必要、Discord通知)
//     3. eds-tag「申込あり」あり                      → applied
//        canApply = ボタン活性 (FeatherIcon) かどうか
//     4. ボタン活性 (FeatherIcon) + 申込タグなし      → available
//     5. ボタン無効 (Mui-disabled) + 申込タグなし     → available
//        (Web申込非対応店舗でもボタン無効になるため closed にしない)
//     6. どれも該当なし                               → unknown
// ──────────────────────────────────────────────────────────────────
async function _checkEssquareAvailability(url) {
  if (!url || (url.indexOf('es-square') < 0 && url.indexOf('iisesq') < 0)) return { status: 'unknown' };
  const tab = await (typeof findOrCreateDedicatedEssquareTab === 'function'
    ? findOrCreateDedicatedEssquareTab()
    : null);
  if (!tab) return { status: 'unknown' };
  try {
    await chrome.tabs.update(tab.id, { url: url });
    await _waitForTabLoad(tab.id, 15000);
    await new Promise(r => setTimeout(r, 2500));
    const [{ result } = {}] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        const allText = (document.documentElement && document.documentElement.innerText) || document.body.innerText || '';

        // 1. 404モーダル / 削除済み → closed
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
          if (re.test(allText)) return { status: 'closed', listingStatus: '掲載終了' };
        }
        const title = (document.title || '').toLowerCase();
        if (title.includes('not found') || title.includes('404') || (document.title || '').includes('見つかりません')) {
          return { status: 'closed', listingStatus: '掲載終了' };
        }

        // ──────────────────────────────────────────────
        // 「申込」ボタンを探す (ヘッダー内、最も上部のものを優先)
        // ──────────────────────────────────────────────
        const applyBtnCandidates = [...document.querySelectorAll('button')].filter(btn => {
          const labelEl = [...btn.querySelectorAll('div, span')]
            .find(el => el.children.length === 0 && (el.textContent || '').trim() === '申込');
          return !!labelEl;
        });
        applyBtnCandidates.sort((a, b) => {
          const ra = a.getBoundingClientRect();
          const rb = b.getBoundingClientRect();
          return ra.top - rb.top;
        });
        const applyBtn = applyBtnCandidates[0];

        // ── ボタン内SVGのアイコン種別を検出 ──
        let iconType = '';  // 'feather' | 'phone' | ''
        if (applyBtn) {
          const svg = applyBtn.querySelector('svg');
          if (svg) {
            const testId = (svg.getAttribute('data-testid') || '').toLowerCase();
            if (testId.includes('feather')) iconType = 'feather';
            else if (testId.includes('phone') || testId.includes('call')) iconType = 'phone';
          }
        }

        // ── ボタンの活性/無効 ──
        let isDisabled = false;
        let canApply = null;
        if (applyBtn) {
          isDisabled = applyBtn.disabled
            || applyBtn.getAttribute('aria-disabled') === 'true'
            || /Mui-disabled/.test(applyBtn.className || '');
          canApply = !isDisabled && iconType !== 'phone';
        }

        // ── 「申込あり」タグ ──
        const edsApplyTag = [...document.querySelectorAll('.eds-tag__label, span.eds-tag, span[class*="eds-tag"]')]
          .find(el => (el.textContent || '').trim() === '申込あり');

        // 2. 電話マーク (PhoneIcon) → needs_confirmation (Discord通知)
        //    Web申込非対応の管理会社 → スタッフが電話確認する必要あり
        if (iconType === 'phone') {
          const applicationStatus = edsApplyTag ? '申込あり' : null;
          return { status: 'needs_confirmation', listingStatus: '電話確認', applicationStatus, canApply: false };
        }

        // 3. eds-tag「申込あり」→ applied
        if (edsApplyTag) {
          return { status: 'applied', listingStatus: '申込あり', canApply };
        }

        // 4. ボタン活性 (FeatherIcon) + 申込タグなし → available (募集中)
        if (applyBtn && !isDisabled) {
          return { status: 'available', listingStatus: '募集中', canApply: true };
        }

        // 5. ボタン無効 + 申込タグなし → available
        //    (Web申込非対応店舗でも disabled になるため closed にしない)
        if (applyBtn && isDisabled) {
          if (/申込受付終了|募集終了|募集停止|成約|契約済/.test(allText)) {
            return { status: 'closed', listingStatus: '募集終了' };
          }
          return { status: 'available', listingStatus: '募集中', canApply: false };
        }

        // 6. 申込ボタンが見つからない場合のフォールバック
        if (/申込受付終了|募集終了|募集停止|成約|契約済/.test(allText)) {
          return { status: 'closed', listingStatus: '募集終了' };
        }
        if (/申込\s*あり/.test(allText)) {
          return { status: 'applied', listingStatus: '申込あり', canApply: null };
        }
        return { status: 'unknown' };
      }
    });
    return result || { status: 'unknown' };
  } catch (e) {
    console.warn('[availability/essquare] ' + e.message);
    return { status: 'unknown' };
  }
}

// ──────────────────────────────────────────────────────────────────
// REINS: 既存の reinsAutoSearchByNumber と同じ手順で物件番号検索
// 検索結果ページ (GBK004200) で行があれば reins_listed、なければ closed
// (空室確定はできないので available は返さない)
// ──────────────────────────────────────────────────────────────────
async function _checkReinsAvailability(reinsPropNo) {
  // REINSシステム稼働時間: 7:00〜23:00 (JST)
  const nowJST = new Date(Date.now() + 9 * 60 * 60 * 1000); // UTC → JST
  const hourJST = nowJST.getUTCHours();
  if (hourJST < 7 || hourJST >= 23) {
    console.log(`[availability/reins] システム稼働時間外 (現在JST ${hourJST}時)`);
    return { status: 'unknown', _reason: 'outside_operating_hours' };
  }
  if (!reinsPropNo) {
    console.warn('[availability/reins] 物件番号が空');
    return { status: 'unknown', _reason: 'no_prop_no' };
  }
  const tab = await (typeof findOrCreateDedicatedReinsTab === 'function'
    ? findOrCreateDedicatedReinsTab()
    : (typeof findReinsTab === 'function' ? findReinsTab() : null));
  if (!tab) {
    console.warn('[availability/reins] REINSタブが見つからない');
    return { status: 'unknown', _reason: 'no_tab' };
  }
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  try {
    // ログイン未完了ならスキップ
    const tab0 = await chrome.tabs.get(tab.id);
    if (/login|GKG001/i.test(tab0.url || '')) {
      console.warn('[availability/reins] ログイン未完了: ' + tab0.url);
      return { status: 'unknown', _reason: 'not_logged_in' };
    }

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
    if (!reachedSearch) {
      console.warn('[availability/reins] 検索ページ(GBK004100)に到達できず');
      return { status: 'unknown', _reason: 'search_page_timeout' };
    }

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
    if (setRes?.[0]?.result !== 'ok') {
      console.warn('[availability/reins] 物件番号入力失敗: ' + (setRes?.[0]?.result || 'no result'));
      return { status: 'unknown', _reason: 'input_failed_' + (setRes?.[0]?.result || '') };
    }

    // 4) 検索結果ページ到達 (GBK004200) を待ち、結果行の有無を判定
    let resultPage = false;
    for (let i = 0; i < 30; i++) {
      await sleep(500);
      const t = await chrome.tabs.get(tab.id);
      if (t.url?.includes('GBK004200')) { resultPage = true; break; }
    }
    if (!resultPage) {
      console.warn('[availability/reins] 検索結果ページ(GBK004200)に到達できず');
      return { status: 'unknown', _reason: 'result_page_timeout' };
    }

    // 結果行の有無を判定 (詳細ボタン or テーブル行 or 「該当なし」テキスト)
    await sleep(1500); // テーブル描画待ち
    const [{ result } = {}] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: (propNo) => {
        const bodyText = document.body.innerText || '';
        // 「該当なし」「0件」「検索結果なし」 → closed
        if (/該当(?:するデータが)?(?:あり|有り)?ません|検索結果が0件|0\s*件/.test(bodyText)) return { status: 'closed', listingStatus: 'REINS掲載なし' };
        // 詳細ボタンがあれば結果行あり
        const hasDetail = [...document.querySelectorAll('button')].some(b => b.textContent.trim() === '詳細');
        if (hasDetail) return { status: 'reins_listed', listingStatus: 'REINS掲載中' };
        // 物件番号がページ上に表示されていれば存在
        if (bodyText.indexOf(propNo) >= 0) return { status: 'reins_listed', listingStatus: 'REINS掲載中' };
        // それ以外: 不明 (テーブル未描画など)
        return { status: 'unknown', _reason: 'no_result_detected', bodySnippet: bodyText.substring(0, 200) };
      },
      args: [reinsPropNo]
    });
    if (result && result._reason) {
      console.warn('[availability/reins] 結果判定失敗: ' + result._reason + ' body=' + (result.bodySnippet || ''));
    }
    return result || { status: 'unknown', _reason: 'no_script_result' };
  } catch (e) {
    console.warn('[availability/reins] 例外: ' + e.message);
    return { status: 'unknown', _reason: 'exception: ' + e.message };
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
          const res = await checkOneAvailability(it);
          const status = (res && res.status) || 'unknown';
          results.push({
            customer: it.customer,
            room_id: it.roomId,
            status: status,
            badge_count: (res && typeof res.badgeCount === 'number') ? res.badgeCount : null,
            can_apply: (res && typeof res.canApply === 'boolean') ? res.canApply : null,
            listing_status: (res && res.listingStatus) || '',
            application_status: (res && res.applicationStatus) || ''
          });
          await setStorageData({
            debugLog: `[空室確認] ${totalProcessed + i + 1}: ${it.customer} ${it.source} → ${status}`
          });
        } catch (e) {
          totalErrors++;
          results.push({ customer: it.customer, room_id: it.roomId, status: 'unknown' });
          await setStorageData({
            debugLog: `[空室確認] ${totalProcessed + i + 1}: ${it.customer} エラー ${e.message} (unknown扱い)`
          });
        }
      }

      // 3. 一括 POST (このサイクル分)
      if (results.length > 0) {
        try {
          const postRes = await gasPost({ action: 'update_availability', items: results });
          // Discord 通知 (Cloudflare 1015 回避のため Chrome拡張側で送信)
          if (postRes && Array.isArray(postRes.discord_notify_items)) {
            await _sendDiscordNotificationsFromExtension(postRes.discord_notify_items);
          }
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
// Discord 通知を Chrome拡張のユーザーIPから送信する
// (GAS共用IPプールが Cloudflare 1015 にフラグされる問題を回避)
// gasPost(update_availability) のレスポンスに discord_notify_items が
// あれば呼ばれる。
// ──────────────────────────────────────────────────────────────────
async function _sendDiscordNotificationsFromExtension(items) {
  if (!Array.isArray(items) || items.length === 0) return;
  for (const item of items) {
    if (!item || !item.webhook_url || !item.content) continue;
    try {
      const resp = await fetch(item.webhook_url + (item.webhook_url.indexOf('?') >= 0 ? '&' : '?') + 'wait=true', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: item.content })
      });
      const code = resp.status;
      if (code >= 200 && code < 300) {
        await setStorageData({
          debugLog: `[Discord通知] ✓ 送信成功: ${item.customer} (${item.source}) HTTP=${code}`
        });
      } else {
        const body = await resp.text();
        await setStorageData({
          debugLog: `[Discord通知] ✗ 失敗: ${item.customer} HTTP=${code} body=${body.substring(0, 100)}`
        });
      }
    } catch (e) {
      await setStorageData({
        debugLog: `[Discord通知] ✗ 例外: ${item.customer || '?'} ${e.message}`
      });
    }
  }
}

// ──────────────────────────────────────────────────────────────────
// 優先キューのポーリング (お客さんがボタンを押した物件をリアルタイム処理)
// 1分毎の alarm で呼ばれる。priority_only=1 で優先依頼のみ取得。
// ──────────────────────────────────────────────────────────────────
async function runPriorityAvailabilityPoll() {
  // 全件モード or 定期チェック実行中ならスキップ (衝突防止)
  // ※ 定期チェック中は _handlePriorityDuringPeriodic が代わりに処理する
  const flags = await new Promise(r =>
    chrome.storage.local.get(['__availabilityCheckRunning', '__periodicCheckRunning'], d => r(d))
  );
  if (flags.__availabilityCheckRunning) {
    console.log('[priority-poll] 通常モード実行中のためスキップ');
    return { skipped: 'batch_running' };
  }
  if (flags.__periodicCheckRunning) {
    console.log('[priority-poll] 定期チェック実行中のためスキップ (割り込みで処理される)');
    return { skipped: 'periodic_running' };
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
      const res = await checkOneAvailability(it);
      const status = (res && res.status) || 'unknown';
      results.push({
        customer: it.customer,
        room_id: it.roomId,
        status: status,
        badge_count: (res && typeof res.badgeCount === 'number') ? res.badgeCount : null,
        can_apply: (res && typeof res.canApply === 'boolean') ? res.canApply : null,
        listing_status: (res && res.listingStatus) || '',
        application_status: (res && res.applicationStatus) || ''
      });
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
    const postRes = await gasPost({ action: 'update_availability', items: results });
    if (postRes && Array.isArray(postRes.discord_notify_items)) {
      await _sendDiscordNotificationsFromExtension(postRes.discord_notify_items);
    }
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

// ──────────────────────────────────────────────────────────────────
// キャンセル通知希望物件の定期巡回
// 30分毎の alarm で呼ばれる。watch_only=1 で watch中物件のみ取得し、
// キャンセル発生 (available 化 or canApply true 化) を検知 → GAS が
// お客さんに LINE 通知。
// ──────────────────────────────────────────────────────────────────
async function runCancellationWatchPoll() {
  // 全件モード or 定期チェック実行中ならスキップ
  const flags = await new Promise(r =>
    chrome.storage.local.get(['__availabilityCheckRunning', '__periodicCheckRunning'], d => r(d))
  );
  if (flags.__availabilityCheckRunning) {
    console.log('[キャンセル監視] 通常モード実行中のためスキップ');
    return { skipped: 'batch_running' };
  }
  if (flags.__periodicCheckRunning) {
    console.log('[キャンセル監視] 定期チェック実行中のためスキップ');
    return { skipped: 'periodic_running' };
  }

  let queue;
  try {
    queue = await gasGet('get_availability_queue', {
      limit: 20,
      watch_only: 1
    });
  } catch (e) {
    console.warn('[キャンセル監視] キュー取得失敗: ' + e.message);
    return { error: e.message };
  }
  const items = (queue && Array.isArray(queue.items)) ? queue.items : [];
  if (items.length === 0) return { processed: 0 };

  await setStorageData({ debugLog: `[キャンセル監視] ${items.length}件の watch中物件をチェック` });

  const results = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    try {
      const res = await checkOneAvailability(it);
      const status = (res && res.status) || 'unknown';
      results.push({
        customer: it.customer,
        room_id: it.roomId,
        status: status,
        badge_count: (res && typeof res.badgeCount === 'number') ? res.badgeCount : null,
        can_apply: (res && typeof res.canApply === 'boolean') ? res.canApply : null,
        listing_status: (res && res.listingStatus) || '',
        application_status: (res && res.applicationStatus) || ''
      });
      await setStorageData({
        debugLog: `[キャンセル監視] ${it.customer} ${it.source} → ${status}${(res && res.canApply !== undefined) ? ' canApply=' + res.canApply : ''}`
      });
    } catch (e) {
      results.push({ customer: it.customer, room_id: it.roomId, status: 'unknown' });
    }
  }

  try {
    const postRes = await gasPost({ action: 'update_availability', items: results });
    if (postRes && Array.isArray(postRes.discord_notify_items)) {
      await _sendDiscordNotificationsFromExtension(postRes.discord_notify_items);
    }
  } catch (e) {
    await setStorageData({ debugLog: `[キャンセル監視] 結果POST失敗: ${e.message}` });
    return { processed: results.length, error: e.message };
  }
  return { processed: results.length };
}

// ──────────────────────────────────────────────────────────────────
// 定期空室確認 (1時間毎の alarm で起動)
// 通知済み全物件を巡回してスプレッドシートの空室情報を最新に保つ。
// お客さんが物件情報を開いた時に直近の空室ステータスが表示される。
// 5件ごとに優先リクエストを割り込み処理し、お客さんを待たせない。
// ──────────────────────────────────────────────────────────────────

/**
 * 定期チェック中に優先リクエストがあれば割り込み処理する。
 * @return {Promise<number>} 処理した優先件数
 */
async function _handlePriorityDuringPeriodic() {
  try {
    const queue = await gasGet('get_availability_queue', {
      limit: 5,
      priority_only: 1,
      max_priority_age_minutes: 60
    });
    const items = (queue && Array.isArray(queue.items)) ? queue.items : [];
    if (items.length === 0) return 0;

    await setStorageData({ debugLog: `[定期→優先割込] ${items.length}件の優先依頼を処理` });

    const results = [];
    for (const it of items) {
      try {
        const res = await checkOneAvailability(it);
        const status = (res && res.status) || 'unknown';
        results.push({
          customer: it.customer,
          room_id: it.roomId,
          status: status,
          badge_count: (res && typeof res.badgeCount === 'number') ? res.badgeCount : null,
          can_apply: (res && typeof res.canApply === 'boolean') ? res.canApply : null,
          listing_status: (res && res.listingStatus) || '',
          application_status: (res && res.applicationStatus) || ''
        });
        await setStorageData({
          debugLog: `[定期→優先割込] ${it.customer} ${it.source} → ${status}`
        });
      } catch (e) {
        results.push({ customer: it.customer, room_id: it.roomId, status: 'unknown' });
      }
    }

    if (results.length > 0) {
      const postRes = await gasPost({ action: 'update_availability', items: results });
      if (postRes && Array.isArray(postRes.discord_notify_items)) {
        await _sendDiscordNotificationsFromExtension(postRes.discord_notify_items);
      }
    }
    return results.length;
  } catch (e) {
    console.warn('[定期→優先割込] 失敗:', e.message);
    return 0;
  }
}

async function runPeriodicAvailabilityCheck() {
  // 手動バッチ or 前回の定期チェックが実行中ならスキップ
  const flags = await new Promise(r =>
    chrome.storage.local.get(['__availabilityCheckRunning', '__periodicCheckRunning'], d => r(d))
  );
  if (flags.__availabilityCheckRunning) {
    console.log('[定期空室確認] 手動バッチ実行中のためスキップ');
    return { skipped: 'batch_running' };
  }
  if (flags.__periodicCheckRunning) {
    // フラグが立ったまま90分以上経っていたら、前回が異常終了したとみなしてリセット
    const staleCheck = await new Promise(r =>
      chrome.storage.local.get(['__periodicCheckStartedAt'], d => r(d))
    );
    const startedAt = staleCheck.__periodicCheckStartedAt || 0;
    const elapsedMin = (Date.now() - startedAt) / 60000;
    if (elapsedMin > 90) {
      console.log(`[定期空室確認] フラグが${Math.round(elapsedMin)}分前から残存 → 強制リセットして続行`);
      await new Promise(r => chrome.storage.local.set({ __periodicCheckRunning: false }, r));
    } else {
      console.log('[定期空室確認] 前回の定期チェックが実行中のためスキップ');
      return { skipped: 'already_running' };
    }
  }

  await new Promise(r => chrome.storage.local.set({ __periodicCheckRunning: true, __periodicCheckStartedAt: Date.now() }, r));

  const batchSize = 30;
  let totalProcessed = 0;
  let totalErrors = 0;
  let totalPriority = 0;
  let cycle = 0;
  const seenKeys = new Set();

  try {
    await setStorageData({ debugLog: '[定期空室確認] 開始' });

    // 上限なし: seenKeys による無限ループ検出 + キュー空で自然終了
    while (true) {
      cycle++;

      // キュー取得: 直近1時間以内にチェック済みの物件はスキップ
      let queue;
      try {
        queue = await gasGet('get_availability_queue', {
          limit: batchSize,
          max_age_days: 30,
          max_interval_hours: 1
        });
      } catch (e) {
        await setStorageData({ debugLog: `[定期空室確認] キュー取得失敗: ${e.message}` });
        break;
      }
      const items = (queue && Array.isArray(queue.items)) ? queue.items : [];

      if (items.length === 0) {
        if (cycle === 1) {
          let reason = '確認対象なし';
          const diag = queue && queue.diag;
          if (diag) {
            reason += ` (総行数:${diag.total}`;
            if (diag.recentlyChecked) reason += ` / 1h以内チェック済:${diag.recentlyChecked}`;
            if (diag.isClosed) reason += ` / closed:${diag.isClosed}`;
            if (diag.noUrl) reason += ` / URL無し:${diag.noUrl}`;
            reason += ')';
          }
          await setStorageData({ debugLog: `[定期空室確認] ${reason}` });
        } else {
          await setStorageData({
            debugLog: `[定期空室確認] 完了 (${totalProcessed}件 / ${cycle - 1}サイクル / エラー${totalErrors}${totalPriority ? ' / 優先割込' + totalPriority + '件' : ''})`
          });
        }
        break;
      }

      // 無限ループ防止
      const allSeen = items.every(it => seenKeys.has(it.customer + '|' + it.roomId));
      if (allSeen) {
        await setStorageData({
          debugLog: `[定期空室確認] 同一アイテム再受信 → 中断 (累計${totalProcessed}件)`
        });
        break;
      }
      items.forEach(it => seenKeys.add(it.customer + '|' + it.roomId));

      await setStorageData({
        debugLog: `[定期空室確認] サイクル${cycle}: ${items.length}件を確認 (累計${totalProcessed})`
      });

      // 各物件チェック
      const results = [];
      for (let i = 0; i < items.length; i++) {
        const it = items[i];

        // 5件ごとに優先リクエスト割り込み処理
        if (i > 0 && i % 5 === 0) {
          const pCount = await _handlePriorityDuringPeriodic();
          totalPriority += pCount;
        }

        try {
          const res = await checkOneAvailability(it);
          const status = (res && res.status) || 'unknown';
          results.push({
            customer: it.customer,
            room_id: it.roomId,
            status: status,
            badge_count: (res && typeof res.badgeCount === 'number') ? res.badgeCount : null,
            can_apply: (res && typeof res.canApply === 'boolean') ? res.canApply : null,
            listing_status: (res && res.listingStatus) || '',
            application_status: (res && res.applicationStatus) || ''
          });
          await setStorageData({
            debugLog: `[定期空室確認] ${totalProcessed + i + 1}: ${it.customer} ${it.source} → ${status}`
          });
        } catch (e) {
          totalErrors++;
          results.push({ customer: it.customer, room_id: it.roomId, status: 'unknown' });
          await setStorageData({
            debugLog: `[定期空室確認] ${totalProcessed + i + 1}: ${it.customer} エラー ${e.message}`
          });
        }
      }

      // 結果POST
      if (results.length > 0) {
        try {
          const postRes = await gasPost({ action: 'update_availability', items: results });
          if (postRes && Array.isArray(postRes.discord_notify_items)) {
            await _sendDiscordNotificationsFromExtension(postRes.discord_notify_items);
          }
        } catch (e) {
          await setStorageData({ debugLog: `[定期空室確認] POST失敗: ${e.message}` });
          break;
        }
      }
      totalProcessed += results.length;
    }

    return { processed: totalProcessed, cycles: cycle, errors: totalErrors, priority: totalPriority };
  } finally {
    await new Promise(r => chrome.storage.local.set({ __periodicCheckRunning: false }, r));
  }
}

globalThis.runAvailabilityCheckBatch = runAvailabilityCheckBatch;
globalThis.checkOneAvailability = checkOneAvailability;
globalThis.stopAvailabilityCheck = stopAvailabilityCheck;
globalThis.runPriorityAvailabilityPoll = runPriorityAvailabilityPoll;
globalThis.runCancellationWatchPoll = runCancellationWatchPoll;
globalThis.runPeriodicAvailabilityCheck = runPeriodicAvailabilityCheck;
