/**
 * suumo-business-fetch.js — SUUMOビジネス Daily Search ページからの掲載実績取得
 *
 * SUUMOビジネス(business1.suumo.jp) の Daily Search ページを新規タブで開き、
 * 最大50件の自社掲載物件について以下を一括取得して GAS へ送信する。
 *   - 物件名・部屋番号
 *   - SUUMO物件コード(12桁)
 *   - 合計一覧PV / 合計詳細PV / 問い合わせ数
 *   - 掲載日数(最大45)
 *   - 競合基準値別件数(第1/第2/第3)
 *
 * background.js から importScripts('suumo-business-fetch.js') で読み込まれる想定。
 *
 * 既存の SUUMO巡回(suumo-patrol.js) や SUUMO入稿(suumo-fill-auto.js) には
 * 一切干渉しない。手動トリガー or 承認時フックからの呼び出し専用。
 */

// ── 状態管理 ──
let _suumoBusinessFetchRunning = false;

/**
 * SUUMOビジネスからデータ取得 → GAS送信の一連を実行
 * @returns {Promise<Object>} { ok: true, count: N, updated: N } または { ok: false, error: string }
 */
async function runSuumoBusinessFetch() {
  if (_suumoBusinessFetchRunning) {
    console.log('[SUUMOビジネス] 既に実行中のためスキップ');
    return { ok: false, error: '既に実行中' };
  }
  _suumoBusinessFetchRunning = true;

  try {
    await setStorageData({ debugLog: '[SUUMOビジネス] データ取得開始' });

    // 1. Daily Search ページを新規タブで開く
    //    45日集計にするため pv_date_from/pv_date_to はページの既定を使用
    const dailyUrl = buildSuumoBusinessDailyUrl();
    const tab = await chrome.tabs.create({ url: dailyUrl, active: false });
    const tabId = tab.id;

    // 2. ページ読み込み完了を待つ
    await waitForTabLoad(tabId, 60000);
    await sleep(3000); // テーブル描画完了の余裕

    // 3. テーブル行をスクレイピング
    const scrapeResult = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [0] },
      func: scrapeSuumoBusinessTable,
    });
    const rows = scrapeResult && scrapeResult[0] && scrapeResult[0].result;

    // 4. 完了したらタブを閉じる
    try { await chrome.tabs.remove(tabId); } catch (_) {}

    if (!Array.isArray(rows)) {
      await setStorageData({ debugLog: '[SUUMOビジネス] スクレイピング失敗: 戻り値が配列でない' });
      return { ok: false, error: 'scrape failed' };
    }
    if (rows.length === 0) {
      await setStorageData({ debugLog: '[SUUMOビジネス] 取得0件(ログイン切れの可能性)' });
      return { ok: false, error: 'no rows (possibly logged out)' };
    }

    await setStorageData({ debugLog: `[SUUMOビジネス] ${rows.length}件取得、GASへ送信` });

    // 5. GAS送信
    const { gasWebappUrl } = await getStorageData(['gasWebappUrl']);
    if (!gasWebappUrl) {
      await setStorageData({ debugLog: '[SUUMOビジネス] GAS URL未設定' });
      return { ok: false, error: 'no gas url' };
    }

    const response = await fetch(gasWebappUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'update_suumo_listing_stats',
        fetchedAt: new Date().toISOString(),
        rows: rows,
      }),
    });
    const rawText = await response.text();
    let result = {};
    try { result = JSON.parse(rawText); } catch (_) { result = { ok: false, raw: rawText.substring(0, 300) }; }

    if (!response.ok) {
      await setStorageData({ debugLog: `[SUUMOビジネス] GAS応答エラー: HTTP ${response.status}` });
      return { ok: false, error: `HTTP ${response.status}` };
    }

    await setStorageData({
      debugLog: `[SUUMOビジネス] 完了: 送信${rows.length}件、GAS側更新${result.updated || '?'}件、新規${result.inserted || '?'}件`,
      suumoBusinessLastFetchAt: Date.now(),
      suumoBusinessLastCount: rows.length,
    });

    return { ok: true, count: rows.length, result };
  } catch (err) {
    console.error('[SUUMOビジネス] エラー:', err);
    await setStorageData({ debugLog: `[SUUMOビジネス] エラー: ${err.message}` });
    return { ok: false, error: err.message };
  } finally {
    _suumoBusinessFetchRunning = false;
  }
}

/**
 * Daily Search ページURLを構築
 *
 * 既定では今日から45日前までの集計を取得。
 * filters_i/filters_d パラメータは SUUMO業務管理の仕様依存のため、
 * 必要に応じて options で上書き可能にしておく。
 */
function buildSuumoBusinessDailyUrl() {
  // デフォルトはシンプルな Daily Search エンドポイント。
  // 期間指定が無ければページ側の既定(最大45日)が自動適用される。
  return 'https://business1.suumo.jp/concierge/reportDailySearch';
}

/**
 * Daily Search ページでテーブルをスクレイピング(コンテンツ側で実行)
 *
 * 戻り値: 物件ごとのオブジェクト配列。
 * 失敗時は空配列を返す。
 */
function scrapeSuumoBusinessTable() {
  try {
    const subRows = document.querySelectorAll('#sub tbody tr');
    const detRows = document.querySelectorAll('#detail tbody tr');
    if (!subRows.length || !detRows.length) return [];

    const toInt = (v) => {
      if (v === null || v === undefined) return 0;
      const s = String(v).replace(/,/g, '').trim();
      const n = parseInt(s, 10);
      return isNaN(n) ? 0 : n;
    };
    const cellText = (cell) => (cell ? (cell.innerText || '').trim() : '');

    const result = [];
    for (let i = 0; i < subRows.length; i++) {
      const s = subRows[i].cells;
      const detRow = detRows[i];
      if (!detRow) continue;
      const d = Array.from(detRow.cells).map((c) => cellText(c));

      const name = cellText(s[1]);
      const room = cellText(s[2]);
      if (!name && !room) continue; // 空行スキップ

      result.push({
        no: cellText(s[0]),
        name: name,
        room: room,
        line: d[2] || '',
        station: d[3] || '',
        walk: d[4] || '',
        layout: d[5] || '',
        area: d[6] || '',
        rent: d[7] || '',
        mgmt_fee: d[8] || '',
        total_fee: d[9] || '',
        address: d[10] || '',
        built_ym: d[11] || '',
        move_in: d[12] || '',
        trade_type: d[13] || '',
        suumo_code: d[15] || '',
        own_code: d[16] || '',
        listed_mark: d[17] || '',
        vacant_mark: d[18] || '',
        listed_days: toInt(d[19]),
        rep_list_pv: toInt(d[20]),
        rep_detail_pv: toInt(d[22]),
        transition_rate: d[24] || '',
        room_list_pv: toInt(d[27]),
        room_detail_pv: toInt(d[29]),
        total_list_pv: toInt(d[31]),
        total_detail_pv: toInt(d[33]),
        inquiries: toInt(d[35]),
        // 競合基準値別件数の列インデックスは実測で確定する必要あり。
        // 暫定で37/38/39を拾っておき、GAS側で数値として成り立っていれば使う。
        comp_lv1_raw: d[37] || '',
        comp_lv2_raw: d[38] || '',
        comp_lv3_raw: d[39] || '',
        // 参考: 全セル生データ(デバッグ用途、初回調整時に確認するため保持)
        _all: d,
      });
    }
    return result;
  } catch (err) {
    console.error('[SUUMOビジネス] scrape error:', err);
    return [];
  }
}

/**
 * タブの読み込み完了を待つ
 */
function waitForTabLoad(tabId, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error('タブ読み込みタイムアウト'));
    }, timeoutMs || 60000);

    const listener = (updatedTabId, changeInfo) => {
      if (updatedTabId === tabId && changeInfo.status === 'complete') {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(listener);

    // 既に完了している可能性もあるのでチェック
    chrome.tabs.get(tabId, (tab) => {
      if (chrome.runtime.lastError) {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (tab && tab.status === 'complete') {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    });
  });
}
