/**
 * forrent-status-sync.js — ForRent(PUB1R2801) から全物件の成約状態を直読みして
 *                          シートと同期する
 *
 * 背景:
 *   SUUMOビジネスDaily Searchは pv_date_to = 今日-2 なので、直近数日の
 *   手動停止/再開が反映されず、シート上の active/stopped 状態と実態に
 *   ずれが出る。これを埋めるため、ForRentの情報更新一覧(PUB1R2801)を
 *   読みに行って seiyakuFlg=1(成約)の物件を直接 stopped 化する。
 *
 * 処理:
 *   1. PUB1R2801.action を新規タブで開く
 *   2. 全物件の行(bukkenCd_<N> + seiyakuFlg_<N>)をスクレイピング
 *      - 検索結果が空なら「検索」ボタンを無条件実行して全件表示を試みる
 *   3. GASに action=sync_forrent_listing_status で送信
 *   4. GASがsuumo_property_codeで突合してシート更新
 *      - seiyakuFlg=1 (成約) かつ sheet=active → stopped に更新
 *      - seiyakuFlg=0 (空室) かつ sheet=stopped → active に復活
 *
 * background.js から importScripts して使う。
 */

let _forrentStatusSyncRunning = false;

/**
 * ForRent PUB1R2801 の全物件状態をシートに反映
 * @returns {Promise<Object>} { ok, count?, result?, error? }
 */
async function syncForrentListingStatus() {
  if (_forrentStatusSyncRunning) {
    return { ok: false, error: '既に実行中' };
  }
  _forrentStatusSyncRunning = true;
  let tabId = null;

  try {
    await setStorageData({ debugLog: '[ForRent状態同期] 開始' });

    const url = 'https://www.fn.forrent.jp/fn/PUB1R2801.action';
    const tab = await chrome.tabs.create({ url, active: false });
    tabId = tab.id;
    await waitForTabLoad(tabId, 60000);
    await sleep(2000);

    // ログイン/エラーページ検知 + 必要なら自動ログイン + PUB1R2801再表示
    const ensured = await ensureForrentReady_(tabId);
    if (!ensured.ok) {
      try { await chrome.tabs.update(tabId, { active: true }); } catch (_) {}
      await setStorageData({ debugLog: `[ForRent状態同期] 準備失敗: ${ensured.error}` });
      return { ok: false, error: ensured.error };
    }

    // 検索フォームの読み込みを短めタイムアウトで待つ
    const formReady = await waitForMainFrameCondition_(tabId, () => {
      if (!document.querySelector('input.bukkenCdInput')) return null;
      return { ok: true, url: location.href };
    }, 20000);

    // 「掲載物件のみ」フィルタを適用(掲載中の物件だけを対象にする)
    // 画面上部の絞込みリンクで切り替える。a[name="kensakuLinkNo"]のうち
    // innerText="掲載物件のみ"のリンクをクリック。既にアクティブなら何もしない。
    const filterResult = await runInMainFrame_(tabId, () => {
      if (!document.querySelector('input.bukkenCdInput')) return null;
      const active = document.querySelector('td.searchConditionDisp');
      const activeText = active ? (active.innerText || '').trim() : '';
      if (activeText === '掲載物件のみ') {
        return { ok: true, alreadyActive: true };
      }
      const link = Array.from(document.querySelectorAll('a[name="kensakuLinkNo"]'))
        .find(a => (a.innerText || '').trim() === '掲載物件のみ');
      if (!link) {
        return { ok: false, error: '「掲載物件のみ」リンクが見つからない', activeText };
      }
      link.click();
      return { ok: true, clicked: true, previousActive: activeText };
    });
    if (filterResult && filterResult.clicked) {
      await setStorageData({ debugLog: `[ForRent状態同期] フィルタ切替: ${filterResult.previousActive}→掲載物件のみ` });
      // フォーム再送信で再レンダリングされるのを待つ
      await sleep(3000);
      // 絞り込み反映待ち: searchConditionDisp = 掲載物件のみ になるまで
      await waitForMainFrameCondition_(tabId, () => {
        const e = document.querySelector('td.searchConditionDisp');
        if (!e) return null;
        return (e.innerText || '').trim() === '掲載物件のみ' ? { ok: true } : null;
      }, 15000);
    } else if (filterResult && filterResult.alreadyActive) {
      await setStorageData({ debugLog: '[ForRent状態同期] 既に「掲載物件のみ」フィルタ有効' });
    } else {
      await setStorageData({ debugLog: `[ForRent状態同期] ⚠️ フィルタ切替できず(${filterResult && filterResult.error})、デフォルト表示のまま続行` });
    }
    if (!formReady) {
      // 20秒経っても検索フォームが現れない → 診断情報を収集
      const recheckUrl = await getTabUrl_(tabId);
      if (isForrentLoginUrl_(recheckUrl)) {
        try { await chrome.tabs.update(tabId, { active: true }); } catch (_) {}
        return { ok: false, error: 'ForRentログインが必要です (URL=' + recheckUrl + ')' };
      }
      // 各フレームの状態を診断ログに出す
      const diag = await diagnosePageState_(tabId);
      await setStorageData({ debugLog: `[ForRent状態同期] 診断: topUrl=${recheckUrl} / ${diag}` });
      try { await chrome.tabs.update(tabId, { active: true }); } catch (_) {}
      throw new Error('PUB1R2801の検索フォームが20秒以内に表示されない(診断ログ参照、タブを残しました)');
    }

    // 既に結果行があるか確認。なければ「検索」ボタンを押して全件表示
    let scrape = await scrapeForrentStatusRows_(tabId);
    if (!scrape || scrape.length === 0) {
      await setStorageData({ debugLog: '[ForRent状態同期] 初期表示は0件 → 検索ボタン押下で全件表示試行' });
      await runInMainFrame_(tabId, () => {
        const btn = Array.from(document.querySelectorAll('input[type="submit"]'))
          .find(b => (b.value || '').trim() === '検索');
        if (btn) btn.click();
        return { ok: !!btn };
      });
      await sleep(2500);
      scrape = await scrapeForrentStatusRows_(tabId);
    }

    if (!scrape || scrape.length === 0) {
      try { await chrome.tabs.remove(tabId); } catch (_) {}
      await setStorageData({ debugLog: '[ForRent状態同期] 結果0件のため中止(掲載物件が無い or ページ構造変化)' });
      return { ok: false, error: '結果0件' };
    }

    await setStorageData({ debugLog: `[ForRent状態同期] ${scrape.length}件取得、GASへ送信` });

    // GASに送信して突合
    const { gasWebappUrl } = await getStorageData(['gasWebappUrl']);
    if (!gasWebappUrl) {
      try { await chrome.tabs.remove(tabId); } catch (_) {}
      return { ok: false, error: 'GAS URL未設定' };
    }
    const resp = await fetch(gasWebappUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'sync_forrent_listing_status',
        fetchedAt: new Date().toISOString(),
        rows: scrape,
      }),
    });
    const raw = await resp.text();
    let gasResult = {};
    try { gasResult = JSON.parse(raw); } catch (_) { gasResult = { raw: raw.substring(0, 300) }; }

    try { await chrome.tabs.remove(tabId); } catch (_) {}

    await setStorageData({
      debugLog: `[ForRent状態同期] 完了: 取得${scrape.length}件 / GAS処理 stopped化=${gasResult.stopped || 0} 復活=${gasResult.reactivated || 0} 新規追加=${gasResult.inserted || 0} 未マッチ=${gasResult.unmatched || 0}`
    });

    return { ok: true, count: scrape.length, result: gasResult };
  } catch (err) {
    console.error('[ForRent状態同期] エラー:', err);
    await setStorageData({ debugLog: `[ForRent状態同期] エラー: ${err.message}` });
    if (tabId) {
      try { await chrome.tabs.update(tabId, { active: true }); } catch (_) {}
    }
    return { ok: false, error: err.message };
  } finally {
    _forrentStatusSyncRunning = false;
  }
}

/**
 * ForRentで PUB1R2801 の検索フォームが使える状態にする
 *
 * 処理:
 *   1. 現ページの状態を調べる
 *      - 検索フォーム表示済み → そのままOK
 *      - ログインページ → 自動ログイン試行
 *      - 画面遷移エラー → ルート(/fn/)へ遷移 → ログインページ扱いで再試行
 *   2. ログイン成功後 PUB1R2801.action に遷移
 *   3. 最終的に input.bukkenCdInput が見えたらOK
 *
 * 自動ログインは保存済み forrentLoginId / forrentPassword を使う。
 * 1回だけ試行し、失敗したら即中止。
 */
async function ensureForrentReady_(tabId) {
  // 1. 現在の状態をチェック(ポーリングで初回injectを安定化)
  let state = await pollInspectForrentPage_(tabId, 10000);
  if (!state) return { ok: false, error: 'ページ状態取得失敗(初期)' };

  // 検索フォーム表示済み → OK
  if (state.hasBukkenInput) return { ok: true };

  // 画面遷移エラー → ルートへリダイレクト
  if (state.hasTransitionError) {
    await setStorageData({ debugLog: '[ForRent状態同期] 画面遷移エラー検知 → ルートへ遷移' });
    await chrome.tabs.update(tabId, { url: 'https://www.fn.forrent.jp/fn/' });
    try { await waitForTabLoad(tabId, 30000); } catch (_) {}
    await sleep(2500);
    // リダイレクト直後はinjectできない場合があるのでポーリングでリトライ
    state = await pollInspectForrentPage_(tabId, 15000);
    if (!state) return { ok: false, error: 'リダイレクト後ページ取得失敗(タイムアウト)' };
  }

  // ログインページ → 自動ログイン
  if (state.hasLoginForm) {
    const loginResult = await doForrentLogin_(tabId);
    if (!loginResult.ok) {
      return { ok: false, error: 'ForRent自動ログイン失敗: ' + loginResult.error };
    }
    await setStorageData({ debugLog: '[ForRent状態同期] 自動ログイン成功' });
    // ログイン後は main_r.action に自動遷移。ForRentのログイン後デフォルトページは
    // トップ画面(TOP1R0000)なので、bukkenCdInputは出現しない。
    // frameset の main frame が TOP1R0000 か PUB1R2801 かを判定し、
    //   - PUB1R2801 ならそのまま待機
    //   - TOP1R0000 なら即メニュー探索に進む(25秒ポーリングを無駄にしない)
    await sleep(3000); // frameset 初期化の余裕を取る
    const postLoginState = await pollInspectForrentPage_(tabId, 10000);
    if (postLoginState && postLoginState.hasBukkenInput) return { ok: true };
    // mainフレームが TOP1R0000 or その他ならすぐナビ探索へ。
    // main frame のURLを念のため確認するため、短めの bukkenCdInput 待ちを挟む(希望的観測)
    state = await pollForBukkenInput_(tabId, 5000);
    if (state && state.hasBukkenInput) return { ok: true };

    // 25秒待っても PUB1R2801 が開かない = ログイン後のデフォルトは別画面。
    // ナビフレームの「更新・掲載指示」メニューを探してクリック。
    // frameset 内のフレーム初期化が遅い場合に備えて複数回リトライ。
    await setStorageData({ debugLog: '[ForRent状態同期] 自然遷移で検索フォーム未検出 → ナビメニューを探索' });
    const clickedDiag = await clickForrentNavMenuWithRetry_(tabId, 15000);
    await setStorageData({ debugLog: `[ForRent状態同期] ナビ探索結果: ${clickedDiag.summary}` });

    if (clickedDiag.clicked) {
      await sleep(3000);
      state = await pollForBukkenInput_(tabId, 20000);
      if (state && state.hasBukkenInput) return { ok: true };
      await setStorageData({ debugLog: `[ForRent状態同期] メニュークリック後もフォーム未出現 (url=${state && state.url})` });
    }

    // メニュー探索失敗時の診断: ナビフレームに何があるかダンプ
    try {
      const dumpResults = await chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        func: () => {
          const frameName = window.name || '(top)';
          const url = location.href;
          const bodyText = (document.body && document.body.innerText) || '';
          const links = Array.from(document.querySelectorAll('a, img, input[type="image"], input[type="submit"], button')).map(el => {
            const t = (el.innerText || el.value || el.alt || el.title || '').trim().substring(0, 30);
            return t;
          }).filter(t => t.length > 0).slice(0, 30);
          return { frameName, url, bodyTextHead: bodyText.substring(0, 200).replace(/\s+/g, ' '), linkTexts: links };
        }
      });
      const dumpLines = [];
      for (const r of dumpResults || []) {
        if (r && r.result) {
          dumpLines.push(`[${r.result.frameName}] url=${r.result.url.substring(0, 60)} / links=${JSON.stringify(r.result.linkTexts).substring(0, 300)}`);
        }
      }
      await setStorageData({ debugLog: `[ForRent状態同期] 診断ダンプ: ${dumpLines.join(' || ')}` });
    } catch (_) {}

    return { ok: false, error: 'ログイン後も検索フォームが表示されない(' + ((state && state.url) || '') + ')。診断ログを確認してください' };
  }

  // ── ① 既ログイン状態で main_r.action / TOP1R0000 等のメイン画面に着地 ──
  // hasBukkenInput=false / hasLoginForm=false / hasTransitionError=false で、
  // URL がトップ系ページ(main_r.action / TOP1R0000 / index / /fn/ ルート)の場合は
  // 「ログイン済みでメイン画面に居る」状態。
  // post-login と同じ「更新・掲載指示」メニュー経由で PUB1R2801 へ誘導する。
  // (旧実装ではこの分岐が無く「不明なページ状態」で即 abort し、
  //  掲載停止フローや承認前処理が連鎖的に失敗していた)
  // 注意: PUB1R2801.action 等の本来 bukkenInput を持つべきページで誤発火しないよう
  //       URL を限定する。
  const stateUrl = (state && state.url) || '';
  const isLandingPage =
    /\/fn\/(main_r\.action|TOP1R0000(?:\.action)?|index(?:\.action)?)(?:[?#]|$)/i.test(stateUrl)
    || /\/fn\/?(?:[?#]|$)/.test(stateUrl);
  if (isLandingPage) {
    await setStorageData({ debugLog: `[ForRent状態同期] 既ログインのメイン画面検知 (url=${stateUrl}) → ナビメニュー探索` });
    await sleep(2000); // frameset 内の navi/main フレーム初期化待ち
    const clickedDiag = await clickForrentNavMenuWithRetry_(tabId, 15000);
    await setStorageData({ debugLog: `[ForRent状態同期] ナビ探索結果(既ログイン): ${clickedDiag.summary}` });
    if (clickedDiag.clicked) {
      await sleep(3000);
      const after = await pollForBukkenInput_(tabId, 20000);
      if (after && after.hasBukkenInput) return { ok: true };
      await setStorageData({ debugLog: `[ForRent状態同期] (既ログイン)メニュークリック後もフォーム未出現 url=${after && after.url}` });
    }
    // メニュー見つからず ⇒ サイレント session expired の可能性大。
    // /fn/ ルートに移動して login.action にリダイレクトさせ、下のリカバリパスに流す。
    await setStorageData({ debugLog: '[ForRent状態同期] ナビ探索失敗 → セッション切れ疑いで /fn/ ルートへリダイレクト' });
    await chrome.tabs.update(tabId, { url: 'https://www.fn.forrent.jp/fn/' });
    try { await waitForTabLoad(tabId, 30000); } catch (_) {}
    await sleep(2500);
    const afterRedirect = await pollInspectForrentPage_(tabId, 15000);
    if (afterRedirect && afterRedirect.hasBukkenInput) return { ok: true };
    if (afterRedirect && afterRedirect.hasLoginForm) {
      await setStorageData({ debugLog: '[ForRent状態同期] /fn/ 着地でログインフォーム検出 → 自動ログインへ合流' });
      const loginResult = await doForrentLogin_(tabId);
      if (!loginResult.ok) {
        return { ok: false, error: 'サイレントsession切れ→再ログイン失敗: ' + loginResult.error };
      }
      // 再ログイン後に再度フォームを待つ
      await sleep(3000);
      const postRelogin = await pollForBukkenInput_(tabId, 20000);
      if (postRelogin && postRelogin.hasBukkenInput) return { ok: true };
      // 再ログイン後もフォームが出ない場合はナビ探索を再試行
      const reClicked = await clickForrentNavMenuWithRetry_(tabId, 15000);
      if (reClicked.clicked) {
        await sleep(3000);
        const finalState = await pollForBukkenInput_(tabId, 20000);
        if (finalState && finalState.hasBukkenInput) return { ok: true };
      }
      return { ok: false, error: '再ログイン後も検索フォーム未到達' };
    }
    return { ok: false, error: 'ログイン済みだが検索フォーム未到達 (' + stateUrl + ' / 再ナビ後も login form 未出現)' };
  }

  // ── ② サイレント session expired のフォールバック ──
  // ForRent 配下だがランディングページでもない & 3フラグ全 false の状態。
  // PUB1R2801 等で session が切れていて、サーバーが空白/エラーページを返している可能性。
  // /fn/ ルートに飛ばして login redirect → 自動ログインに合流。
  if (/https?:\/\/www\.fn\.forrent\.jp\/fn\//.test(stateUrl)) {
    await setStorageData({ debugLog: `[ForRent状態同期] /fn/配下だが3フラグ全false (url=${stateUrl}) → セッション切れ疑い、/fn/へ` });
    await chrome.tabs.update(tabId, { url: 'https://www.fn.forrent.jp/fn/' });
    try { await waitForTabLoad(tabId, 30000); } catch (_) {}
    await sleep(2500);
    const recovered = await pollInspectForrentPage_(tabId, 15000);
    if (recovered && recovered.hasBukkenInput) return { ok: true };
    if (recovered && recovered.hasLoginForm) {
      const loginResult = await doForrentLogin_(tabId);
      if (!loginResult.ok) {
        return { ok: false, error: 'サイレントsession切れ→再ログイン失敗: ' + loginResult.error };
      }
      await sleep(3000);
      const post = await pollForBukkenInput_(tabId, 20000);
      if (post && post.hasBukkenInput) return { ok: true };
      const navAfter = await clickForrentNavMenuWithRetry_(tabId, 15000);
      if (navAfter.clicked) {
        await sleep(3000);
        const final = await pollForBukkenInput_(tabId, 20000);
        if (final && final.hasBukkenInput) return { ok: true };
      }
      return { ok: false, error: 'サイレントsession切れ→再ログイン後もフォーム未到達' };
    }
    return { ok: false, error: 'session 切れ疑いで /fn/ へリダイレクト後も状態不明 (' + ((recovered && recovered.url) || '') + ')' };
  }

  // それでもどれにも該当しない真の不明
  return { ok: false, error: '不明なページ状態(' + JSON.stringify(state).substring(0, 200) + ')' };
}

/**
 * bukkenCdInput が出現するまで長めにポーリング。
 * ログイン直後の frameset 初期化待ち + 内部フレームの非同期ロードを許容する。
 */
async function pollForBukkenInput_(tabId, timeoutMs) {
  const deadline = Date.now() + (timeoutMs || 30000);
  let last = null;
  while (Date.now() < deadline) {
    const state = await inspectForrentPage_(tabId);
    if (state) {
      last = state;
      if (state.hasBukkenInput) return state;
    }
    await sleep(1000);
  }
  return last;
}

/**
 * 「更新・掲載指示」などのナビメニューをリトライ付きで探索・クリック。
 * frameset 内の navi/main フレーム初期化が遅いケースに対応。
 */
async function clickForrentNavMenuWithRetry_(tabId, timeoutMs) {
  const deadline = Date.now() + (timeoutMs || 15000);
  const allDiag = [];
  while (Date.now() < deadline) {
    try {
      const navResults = await chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        func: () => {
          const frameInfo = { url: location.href, frameName: window.name || '(top)' };
          // frameset の top は body 無しのことが多いので skip
          if (!document.body || document.body.children.length === 0) {
            return { ok: false, error: 'empty body', frameInfo };
          }
          // ナビメニューは <a> 要素で実装されている。
          // li/span/div を対象に substring 検索すると、
          // mainフレームの長文テキスト("入居・取引態様・掲載指示...") に誤マッチする。
          // → <a>タグのみに絞り、テキスト完全一致で探す。
          const candidates = Array.from(document.querySelectorAll('a'));
          // テキストを正規化(全角/半角中黒点、空白の差異を吸収)
          const norm = (s) => (s || '')
            .replace(/[\s\u3000]/g, '')
            .replace(/[・･·\u2022\u30FB\uFF65]/g, '');
          const patterns = [
            '掲載指示',
            '更新掲載指示',
            '情報更新一覧',
            '情報更新',
          ];
          for (const pat of patterns) {
            const target = candidates.find(el => {
              const t = norm(el.innerText || el.title || '');
              // 完全一致のみ
              return t === pat;
            });
            if (target) {
              const text = (target.innerText || target.title || '').trim().substring(0, 40);
              target.click();
              return { ok: true, clickedText: text, matchedPattern: pat, frameInfo };
            }
          }
          return { ok: false, error: 'menu not found', frameInfo };
        }
      });
      const diag = [];
      let clicked = null;
      for (const r of navResults || []) {
        if (!r || !r.result) continue;
        const name = r.result.frameInfo ? r.result.frameInfo.frameName : '?';
        if (r.result.ok) {
          diag.push(`${name}: CLICKED "${r.result.clickedText}"`);
          clicked = r.result;
        } else {
          diag.push(`${name}: ${r.result.error}`);
        }
      }
      allDiag.push(diag.join(' | '));
      if (clicked) {
        return { clicked: true, clickedText: clicked.clickedText, summary: diag.join(' | ') };
      }
    } catch (err) {
      allDiag.push('err: ' + err.message);
    }
    await sleep(1000);
  }
  return { clicked: false, summary: allDiag.slice(-3).join(' || ') || 'no frames inspected' };
}

/**
 * inspectForrentPage_ をポーリングして「何か意味ある状態」が返るまで待つ
 * (ページ遷移直後で inject できないケースに備える)
 */
async function pollInspectForrentPage_(tabId, timeoutMs) {
  const deadline = Date.now() + (timeoutMs || 15000);
  while (Date.now() < deadline) {
    const state = await inspectForrentPage_(tabId);
    if (state && (state.hasBukkenInput || state.hasLoginForm || state.hasTransitionError || state.url)) {
      return state;
    }
    await sleep(800);
  }
  return null;
}

/**
 * 現在のページ状態を調査(全フレーム横断)
 */
async function inspectForrentPage_(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: () => {
        const bodyText = document.body ? (document.body.innerText || '') : '';
        return {
          url: location.href,
          frameName: window.name || '(top)',
          title: document.title,
          hasBukkenInput: !!document.querySelector('input.bukkenCdInput'),
          hasLoginForm: !!document.querySelector('form[action*="login.action"]'),
          hasTransitionError: /画面遷移エラー|ご指定の処理は既に完了/.test(bodyText),
        };
      }
    });
    // 各フレームの結果を集約: どれか1つでも true ならそれを採用
    const combined = {
      url: '',
      hasBukkenInput: false,
      hasLoginForm: false,
      hasTransitionError: false,
    };
    for (const r of results || []) {
      if (!r || !r.result) continue;
      if (!combined.url) combined.url = r.result.url;
      if (r.result.hasBukkenInput) combined.hasBukkenInput = true;
      if (r.result.hasLoginForm) combined.hasLoginForm = true;
      if (r.result.hasTransitionError) combined.hasTransitionError = true;
    }
    return combined;
  } catch (err) {
    console.warn('[ForRent状態同期] inspect失敗:', err.message);
    return null;
  }
}

/**
 * ForRentログインフォームに認証情報を入力して送信
 */
async function doForrentLogin_(tabId) {
  const { forrentLoginId, forrentPassword } = await getStorageData(['forrentLoginId', 'forrentPassword']);
  if (!forrentLoginId || !forrentPassword) {
    return { ok: false, error: 'ForRent ID/PW未設定(オプション画面で設定してください)' };
  }
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: (id, pw) => {
        const loginForm = document.querySelector('form[action*="login.action"]');
        if (!loginForm) return null;
        // 注: Struts EL 未評価のリテラル name="${loginForm.loginId}" が入っている場合があるため
        //     複数のセレクタを試す
        const idInput = document.querySelector('input[name="${loginForm.loginId}"]')
          || loginForm.querySelector('input[type="text"]')
          || loginForm.querySelector('input[name*="login"]');
        const pwInput = document.querySelector('input[name="${loginForm.password}"]')
          || loginForm.querySelector('input[type="password"]');
        const submitBtn = document.getElementById('Image7')
          || loginForm.querySelector('input[type="image"]')
          || loginForm.querySelector('input[type="submit"]')
          || loginForm.querySelector('button[type="submit"]');
        if (!idInput || !pwInput) return { ok: false, error: 'ログインフォーム要素不在' };
        if (!submitBtn) return { ok: false, error: 'ログイン送信ボタン不在' };
        idInput.value = id;
        pwInput.value = pw;
        idInput.dispatchEvent(new Event('input', { bubbles: true }));
        pwInput.dispatchEvent(new Event('input', { bubbles: true }));
        submitBtn.click();
        return { ok: true };
      },
      args: [forrentLoginId, forrentPassword]
    });
    let submitted = false;
    for (const r of results || []) {
      if (r && r.result && r.result.ok) { submitted = true; break; }
      if (r && r.result && r.result.error) return { ok: false, error: r.result.error };
    }
    if (!submitted) return { ok: false, error: 'ログインフォームに辿り着けない' };
    // submit 後のページ遷移待ち
    try { await waitForTabLoad(tabId, 30000); } catch (_) {}
    await sleep(1500);
    // 遷移後にログインフォームが消えているか確認
    const after = await inspectForrentPage_(tabId);
    if (!after) return { ok: false, error: 'ログイン後ページ取得失敗' };
    if (after.hasLoginForm) {
      return { ok: false, error: 'ログインフォームが残存(ID/PW誤りの可能性)' };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: 'login inject失敗: ' + err.message };
  }
}

/**
 * 各フレームの診断情報を取得(どんなページが表示されているかを調べる)
 */
async function diagnosePageState_(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: () => {
        const hasBukkenInput = !!document.querySelector('input.bukkenCdInput');
        const hasSearchBtn = !!Array.from(document.querySelectorAll('input[type="submit"]')).find(b => (b.value || '').trim() === '検索');
        const bukkenRows = document.querySelectorAll('[id^="bukkenCd_"]').length;
        const forms = Array.from(document.querySelectorAll('form')).map(f => ({ action: f.action, name: f.name })).slice(0, 3);
        const bodyText = (document.body && document.body.innerText) || '';
        return {
          url: location.href,
          frameName: window.name || '(top)',
          title: document.title,
          hasBukkenInput,
          hasSearchBtn,
          bukkenRows,
          forms: JSON.stringify(forms).substring(0, 200),
          bodyHead: bodyText.substring(0, 150).replace(/\s+/g, ' ').trim(),
        };
      }
    });
    const diags = [];
    for (const r of results || []) {
      if (r && r.result) {
        diags.push(`[frame:${r.result.frameName}] url=${r.result.url.substring(0, 80)} title="${r.result.title}" rows=${r.result.bukkenRows} hasInput=${r.result.hasBukkenInput}`);
      }
    }
    return diags.join(' || ');
  } catch (err) {
    return 'diagnose failed: ' + err.message;
  }
}

/**
 * タブの現在URLを取得
 */
async function getTabUrl_(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    return (tab && tab.url) || '';
  } catch (_) {
    return '';
  }
}

/**
 * ForRentログインページ系URLか判定
 */
function isForrentLoginUrl_(url) {
  if (!url) return false;
  return /fn\.forrent\.jp\/fn\/(login|LOG|index|COM1R0214|IDPW)/i.test(url)
      || /fn\.forrent\.jp\/?$/.test(url);
}

/**
 * PUB1R2801の行をスクレイピングして [{suumoCode, seiyakuFlg, buildingName, roomNo}, ...] を返す
 */
async function scrapeForrentStatusRows_(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: () => {
        const bukkenInputs = Array.from(document.querySelectorAll('[id^="bukkenCd_"]'))
          .filter(i => i.id && /^bukkenCd_\d+$/.test(i.id));
        if (bukkenInputs.length === 0) return null;
        const rows = [];
        for (const inp of bukkenInputs) {
          const suffix = inp.id.split('_')[1];
          const suumoCode = String(inp.value || '').replace(/[^0-9]/g, '');
          if (!suumoCode || suumoCode.length !== 12) continue;
          const seiyakuEl = document.getElementById('seiyakuFlg_' + suffix);
          const seiyakuFlg = seiyakuEl ? String(seiyakuEl.value || '') : '';
          // PUB1R2801 の行レイアウト(全50件均一):
          //   1物件 = 1TR = 16TD
          //   td[3] に「建物名 部屋番号」同一セル格納(例: "ファインズコート北新宿 202号室")
          //   td[1] に路線駅+住所、 td[4] に賃料ブロック
          //   bukkenCd hidden input は td[14] に属する
          let buildingName = '';
          let roomNo = '';
          let rentText = '';
          try {
            const tr = inp.closest('tr');
            if (tr && tr.cells && tr.cells.length === 16) {
              // 建物名+部屋番号 パース
              const td3Text = (tr.cells[3] ? tr.cells[3].innerText : '').trim().replace(/\s+/g, ' ');
              if (td3Text) {
                // 末尾の「XXX号室」を部屋番号として分離
                // 対応パターン: "建物名 202号室" / "建物名\n202号室" / "建物名 B1-2号室" / "建物名 101"
                const m = td3Text.match(/^(.*?)[\s ]+([0-9A-Za-zB\-]+号?室?)\s*$/);
                if (m) {
                  buildingName = m[1].trim();
                  roomNo = m[2].trim();
                } else {
                  // フォールバック: 末尾スペース区切り
                  const lastSpace = td3Text.lastIndexOf(' ');
                  if (lastSpace > 0) {
                    buildingName = td3Text.substring(0, lastSpace).trim();
                    roomNo = td3Text.substring(lastSpace + 1).trim();
                  } else {
                    buildingName = td3Text;
                  }
                }
                // 部屋番号から末尾の「号室」「号」「室」を除去 (例: "202号室" → "202")
                roomNo = roomNo.replace(/号室$|号$|室$/, '').trim();
              }
              // 賃料(td[4]の1行目が総額「8.5万円」のような表示)
              const td4Text = (tr.cells[4] ? tr.cells[4].innerText : '').trim();
              if (td4Text) {
                const firstLine = td4Text.split(/\r?\n/)[0].trim();
                const rentMatch = firstLine.match(/([0-9]+(?:\.[0-9]+)?)万円?/);
                if (rentMatch) rentText = rentMatch[1];
              }
            }
          } catch (_) {}
          rows.push({ suumoCode, seiyakuFlg, buildingName, roomNo, rent: rentText, rowSuffix: suffix });
        }
        return rows;
      },
    });
    if (!Array.isArray(results)) return null;
    for (const r of results) {
      if (r && Array.isArray(r.result) && r.result.length > 0) return r.result;
    }
    // 1フレームも拾えなかった
    for (const r of results) {
      if (r && r.result === null) continue;
    }
    return [];
  } catch (err) {
    console.error('[ForRent状態同期] scrape error:', err);
    return [];
  }
}
