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

    // ログインページにリダイレクトされていたら即中止(60秒ポーリング待たない)
    const currentUrl = await getTabUrl_(tabId);
    if (isForrentLoginUrl_(currentUrl)) {
      try { await chrome.tabs.update(tabId, { active: true }); } catch (_) {}
      await setStorageData({ debugLog: `[ForRent状態同期] ログインページ検知(${currentUrl}) → 中止。手動でログインしてから再実行してください` });
      return { ok: false, error: 'ForRentログインが必要です' };
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
