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
      debugLog: `[ForRent状態同期] 完了: 取得${scrape.length}件 / GAS処理 stopped化=${gasResult.stopped || 0} 復活=${gasResult.reactivated || 0} 未マッチ=${gasResult.unmatched || 0}`
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
    // ログイン後は main_r.action に自動遷移し、その main フレームが PUB1R2801 を
    // 読み込むのが ForRent の自然なフロー。
    // 強制 URL 遷移すると frameset 経由の初期化が走らず「画面遷移エラー」が再発するため、
    // ここでは遷移せず、全フレーム横断で bukkenCdInput が現れるまで待つ。
    await sleep(1500);
    state = await pollInspectForrentPage_(tabId, 20000);
    if (!state) return { ok: false, error: 'ログイン後ページ取得失敗(タイムアウト)' };
    if (state.hasBukkenInput) return { ok: true };

    // 自然遷移で PUB1R2801 が開かなかった場合、ナビフレーム内のリンクを探す
    await setStorageData({ debugLog: '[ForRent状態同期] 自然遷移で検索フォーム未検出 → ナビメニューを探索' });

    // 全フレームから「更新・掲載指示」「情報更新一覧」等のメニュー/リンクを探す。
    // ForRentのナビ構造では 更新・掲載指示 → 情報更新一覧(PUB1R2801) に遷移する。
    // ナビフレームの<a target="main">リンクはメインフレームを書き換える。
    const navResults = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: () => {
        const frameInfo = { url: location.href, frameName: window.name || '(top)' };
        const candidates = Array.from(document.querySelectorAll('a, input[type="submit"], input[type="button"], input[type="image"], li, span, div'));
        // 優先度順: 「更新・掲載指示」が最優先(ForRentのトップメニュー)
        const patterns = [
          /^更新・掲載指示$/,
          /^情報更新一覧$/,
          /^情報更新$/,
          /更新・掲載指示/,
          /情報更新/,
        ];
        for (const pat of patterns) {
          const target = candidates.find(el => {
            const t = (el.innerText || el.value || el.alt || el.title || '').trim();
            return pat.test(t);
          });
          if (target) {
            const text = (target.innerText || target.value || target.alt || target.title || '').trim().substring(0, 40);
            const href = target.href || target.getAttribute('onclick') || '';
            target.click();
            return { ok: true, clickedText: text, matchedPattern: pat.toString(), href: href.substring(0, 100), frameInfo };
          }
        }
        return { ok: false, error: 'menu not found in this frame', frameInfo };
      }
    });

    let clicked = false;
    const navDiag = [];
    for (const r of navResults || []) {
      if (!r || !r.result) continue;
      navDiag.push(`${r.result.frameInfo.frameName}: ${r.result.ok ? 'CLICKED "' + r.result.clickedText + '"' : r.result.error}`);
      if (r.result.ok) clicked = true;
    }
    await setStorageData({ debugLog: `[ForRent状態同期] ナビ探索結果: ${navDiag.join(' | ')}` });

    if (clicked) {
      await sleep(2500);
      state = await pollInspectForrentPage_(tabId, 15000);
      if (state && state.hasBukkenInput) return { ok: true };
      await setStorageData({ debugLog: `[ForRent状態同期] メニュークリック後もフォーム未出現 (url=${state && state.url})` });
    }

    // 全然ダメなら最後に直接URLへリダイレクト(従来方式)を試す
    await setStorageData({ debugLog: '[ForRent状態同期] 最終手段: PUB1R2801.action へ直接遷移' });
    await chrome.tabs.update(tabId, { url: 'https://www.fn.forrent.jp/fn/PUB1R2801.action' });
    try { await waitForTabLoad(tabId, 30000); } catch (_) {}
    await sleep(2500);
    state = await pollInspectForrentPage_(tabId, 20000);
    if (state && state.hasBukkenInput) return { ok: true };
    if (state && state.hasTransitionError) {
      return { ok: false, error: 'PUB1R2801直接遷移で画面遷移エラー(セッションの問題)' };
    }

    return { ok: false, error: 'ログイン後も検索フォームが表示されない(' + ((state && state.url) || '') + ')' };
  }

  // 検索フォームもログインフォームもエラーも無い → 不明
  return { ok: false, error: '不明なページ状態(' + JSON.stringify(state).substring(0, 200) + ')' };
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
          // 物件名・部屋番号も見つかれば添える(デバッグ用)
          let buildingName = '';
          let roomNo = '';
          try {
            const row = inp.closest('tr');
            if (row) {
              // 一般的にbukkenCdの近くに物件名セルがある
              const cells = row.querySelectorAll('td');
              // テキストセルから物件名と推定されるものを拾う(ベストエフォート)
              for (const c of cells) {
                const t = (c.innerText || '').trim();
                if (t.length > 0 && t.length < 60 && !/^\d+$/.test(t)) {
                  if (!buildingName) buildingName = t;
                  else if (!roomNo && /\d/.test(t) && t.length < 15) roomNo = t;
                }
                if (buildingName && roomNo) break;
              }
            }
          } catch (_) {}
          rows.push({ suumoCode, seiyakuFlg, buildingName, roomNo, rowSuffix: suffix });
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
