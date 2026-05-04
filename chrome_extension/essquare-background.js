/**
 * essquare-background.js
 * いい生活Square 検索オーケストレーション（Service Worker用）
 * importScripts() で background.js から読み込まれる
 *
 * 依存: essquare-config.js（先にimportScripts）、background.jsの共通関数
 *  - sleep(), getStorageData(), setStorageData(), gasPost(), submitProperties()
 *  - sendDiscordNotification(), getFilterRejectReason(), waitForTabLoad()
 *  - isSearchCancelled(), logError()
 *
 * Python essquare_search/ からの移植:
 *  - 検索: URLクエリパラメータで検索URL構築 → タブで遷移 → DOMパース
 *  - 詳細: 専用タブで詳細ページに遷移 → content script でスクレイピング
 *  - フィルタ: 共通フィルタ + ES-Square固有フィルタ
 */

// ES-Square専用ウィンドウ管理
let dedicatedEssquareTabId = null;
let dedicatedEssquareWindowId = null;

// === 価格テキストパーサー ===

function _parseEssquarePriceText(text) {
  if (!text || text === '-' || text === 'なし' || text === 'ー' || text === '—') return 0;
  text = text.replace(/,/g, '').replace(/円/g, '').trim();
  const m = text.match(/([\d.]+)\s*万/);
  if (m) return Math.floor(parseFloat(m[1]) * 10000);
  const m2 = text.match(/[\d.]+/);
  if (m2) return Math.floor(parseFloat(m2[0]));
  return 0;
}

function _parseEssquareAreaText(text) {
  if (!text) return 0;
  const m = text.match(/([\d.]+)/);
  return m ? parseFloat(m[1]) : 0;
}

// === 検索URL構築 ===

/**
 * 町名から丁目部分を除去してベース町名を取得
 * 例: "西新宿一丁目" → "西新宿", "代々木" → "代々木"
 */
function _extractBaseTownName(town) {
  return town.replace(/[一二三四五六七八九十百０-９0-9]+丁目$/, '');
}

/**
 * 顧客の selectedTowns + cities から ES-Square 用 jusho リストを構築する。
 * 駅検索時も町名が指定されていればjushoを追加。
 * @returns {string[]} jusho値の配列（例: ['13+103+港南', '13+104+西新宿']）
 */
function _resolveEssquareJushoList(customer) {
  const selectedTowns = customer.selectedTowns || {};
  const hasTowns = Object.keys(selectedTowns).length > 0;
  if (!hasTowns) return [];

  const addedJusho = new Set();
  const result = [];

  // 全selectedTownsからjushoリストを構築
  for (const city of Object.keys(selectedTowns)) {
    const cityTrimmed = city.trim();
    const cityCode = ESSQUARE_CITY_CODES[cityTrimmed];
    if (!cityCode) continue;
    const towns = selectedTowns[cityTrimmed];
    if (!towns || towns.length === 0) continue;
    const baseTowns = [...new Set(towns.map(t => _extractBaseTownName(t)))];
    for (const baseTown of baseTowns) {
      const jusho = `${cityCode}+${baseTown}`;
      if (!addedJusho.has(jusho)) {
        result.push(jusho);
        addedJusho.add(jusho);
      }
    }
  }

  return result;
}

function buildEssquareSearchUrl(customer, page, jushoList) {
  const params = new URLSearchParams();

  // 駅コード
  const stationCodes = _resolveEssquareStationCodes(customer);
  if (stationCodes.length > 0) {
    for (const code of stationCodes) {
      params.append('station', code);
    }
  }

  // 市区町村・町名（jushoリストは外部から渡される場合はそちらを使用）
  const cities = customer.cities || [];
  const selectedTowns = customer.selectedTowns || {};
  const hasTowns = Object.keys(selectedTowns).length > 0;

  if (jushoList && jushoList.length > 0) {
    // チャンク分割されたjushoリストを使用
    for (const jusho of jushoList) {
      params.append('jusho', jusho);
    }
  } else if (!hasTowns) {
    // 町名指定なし → 市区町村レベル（駅コード不足時のフォールバック）
    if (stationCodes.length === 0 || stationCodes.length < (customer.stations || []).length) {
      for (const city of cities) {
        const cityTrimmed = city.trim();
        const cityCode = ESSQUARE_CITY_CODES[cityTrimmed];
        if (cityCode) params.append('jusho', cityCode);
      }
    }
  }

  // 賃料（管理費込み・万円→円）
  if (customer.rent_max) {
    params.append('komi_chinryo.to', String(parseFloat(customer.rent_max) * 10000));
    // 下限は上限の70%
    const minYen = Math.floor(parseFloat(customer.rent_max) * 10000 * 0.7);
    params.append('komi_chinryo.from', String(minYen));
  }

  // 間取り
  const layouts = customer.layouts || [];
  for (const layout of layouts) {
    const trimmed = layout.trim();
    if (trimmed === '4K以上') {
      // 4K以上 = 4K, 4DK, 4LDK, 5K以上 すべて含める
      for (const code of ['11', '12', '13', '14']) {
        params.append('search_madori_code2', code);
      }
    } else if (ESSQUARE_LAYOUT_MAP[trimmed]) {
      params.append('search_madori_code2', ESSQUARE_LAYOUT_MAP[trimmed]);
    }
  }

  // 専有面積
  if (customer.area_min && !String(customer.area_min).includes('指定しない')) {
    const n = parseInt(String(customer.area_min).replace(/[^\d]/g, ''));
    if (!isNaN(n) && n > 0) params.append('search_menseki.from', String(n));
  }

  // 築年数
  if (customer.building_age) {
    const ageStr = String(customer.building_age).replace(/[^\d]/g, '');
    if (ageStr) params.append('chiku_nensu', ageStr);
  }

  // 駅徒歩
  const walkMin = customer.walk ? parseInt(String(customer.walk).replace(/[^\d]/g, '')) : 0;
  if (walkMin > 0) {
    params.append('kotsu_ekitoho', String(walkMin));
  }

  // 構造
  if (customer.structures && customer.structures.length > 0) {
    const addedKozo = new Set();
    for (const s of customer.structures) {
      const kozo = ESSQUARE_STRUCTURE_MAP[s];
      if (kozo && !addedKozo.has(kozo)) {
        params.append('kozo', kozo);
        addedKozo.add(kozo);
      }
    }
  }

  // 建物種別
  if (customer.building_types && customer.building_types.length > 0) {
    for (const bt of customer.building_types) {
      const code = ESSQUARE_BUILDING_TYPE_MAP[bt];
      if (code) params.append('search_boshu_shubetsu_code', code);
    }
  }

  // 設備（ハード設備のみURLパラメータで指定）
  const toHankaku = (s) => s.replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));
  const equip = toHankaku(customer.equipment || '');
  const equipItems = equip.split(/[,、，\/／]/).map(s => s.trim()).filter(Boolean);
  const btSkip_ = typeof __btMode !== 'undefined' && __btMode === 'skip';
  const btAliases_ = new Set(['バス・トイレ別', 'バストイレ別', 'BT別']);
  for (const item of equipItems) {
    // バス・トイレ別: btMode='skip'の時だけkodawariに追加してAPIで絞り込む
    if (btSkip_ && btAliases_.has(item)) {
      params.append('kodawari', 'separatedBathAndToilet');
      continue;
    }
    if (ESSQUARE_HARD_KODAWARI_NAMES.has(item) && ESSQUARE_KODAWARI_MAP[item]) {
      params.append('kodawari', ESSQUARE_KODAWARI_MAP[item]);
      // 家具家電付き → 家具付き(kagu_flag) + 家電付き(kaden_flag) の両方を送る
      if (item === '家具家電付き') {
        params.append('kodawari', 'kaden_flag');
      }
    }
  }

  // 敷金なし
  if (equip.includes('敷金なし')) {
    params.append('shikikin_nashi_flag', 'true');
  }
  // 礼金なし
  if (equip.includes('礼金なし')) {
    params.append('reikin_nashi_flag', 'true');
  }

  // 申込あり物件もクライアント側で検出するためURLフィルタは使わない
  // （他サイトとのクロス重複排除のため）

  // SUUMO巡回時の「情報公開日 N日以内」フィルタ。
  // ES-Square には「最終更新日」(saishu_koshin_time) と「情報公開日」
  // (kokai_date) の2系統あるが、SUUMO巡回では新着発見が目的なので
  // 「情報公開日」を使用 (= 物件が ES-Square に初掲載された日)。
  //
  // 実機 URL 例 (ユーザーが手動操作で確定):
  //   ?kokai_radio_state=select
  //    &kokai_date.from=2026-05-01T00:00:00+09:00
  //
  // 最終更新日とパラメータ命名規則が違う点に注意:
  //   - 最終更新日: koshin_radio_state=customRange + saishu_koshin_time:gteq=YYYY-MM-DD
  //   - 情報公開日: kokai_radio_state=select + kokai_date.from=YYYY-MM-DDT00:00:00+09:00 (ISO+JST)
  if (customer && customer._isSuumoPatrol && typeof customer.daysWithin === 'number' && customer.daysWithin >= 0) {
    const pad = (n) => String(n).padStart(2, '0');
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const from = new Date(today);
    from.setDate(from.getDate() - customer.daysWithin);
    const fromIso = `${from.getFullYear()}-${pad(from.getMonth() + 1)}-${pad(from.getDate())}T00:00:00+09:00`;
    params.append('kokai_radio_state', 'select');
    params.append('kokai_date.from', fromIso);
  }

  // ソート: 最終更新日順
  params.append('order', 'saishu_koshin_time.desc');
  params.append('items_per_page', '30');
  params.append('p', String(page));

  return `${ESSQUARE_SEARCH_URL}?${params.toString()}`;
}

// === 駅名→駅コード解決 ===

function _resolveEssquareStationCodes(customer) {
  const rws = customer.routes_with_stations || [];
  let stationNames = rws.length > 0
    ? rws.flatMap(r => r.stations || [])
    : (customer.stations || []);

  if (stationNames.length === 0) return [];

  const codes = [];
  const unmapped = [];
  for (const name of stationNames) {
    const clean = name.replace(/駅$/, '').trim();
    // ケ/ヶ、ツ/ッ の表記揺れを吸収
    const variants = [
      clean,
      clean.replace(/ケ/g, 'ヶ'),
      clean.replace(/ヶ/g, 'ケ'),
      clean.replace(/ツ/g, 'ッ'),
      clean.replace(/ッ/g, 'ツ'),
    ];
    const code = variants.reduce((found, v) => found || ESSQUARE_STATION_CODES[v], null);
    if (code) {
      codes.push(code);
    } else {
      unmapped.push(clean);
    }
  }

  if (unmapped.length > 0) {
    console.warn(`[ES-Square] 駅コード未定義: ${unmapped.join(', ')}`);
    if (typeof addUnresolvedStation === 'function') {
      for (const name of unmapped) {
        addUnresolvedStation(customer.name || '不明', 'ES-Square', name);
      }
    }
  }

  return codes;
}

// === SPAナビゲーション (フルリロード回避) ===

/**
 * ES-Square 検索ページ間で URL を直接書き換え (chrome.tabs.update) すると
 * 毎回 HTML+JS+CSS+API が完全にフルリロードされる。本来 React SPA では
 * 「次ページ」click や検索ボタン click で history.pushState による
 * SPA ルーティングが起き、API 1本だけが走る。
 *
 * 連続フルリロードは SPA 検知ロジックが反応するため、history.pushState +
 * popstate を MAIN world で発火して SPA 内ルーティングを起こす。
 *
 * 同一ドメインかつ既にロード済みの場合のみ試行。それ以外 (login画面、
 * about:blank 等) では false を返し、呼び出し側で URL 直接遷移にフォールバック。
 *
 * @returns {boolean} SPA ナビゲーションが発火できたら true
 */
async function navigateEssquareSpa_(tabId, url) {
  let tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch (e) {
    return false;
  }
  const currentUrl = tab.url || '';
  if (!currentUrl.startsWith(ESSQUARE_BASE_URL)) return false;

  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: (newUrl) => {
        try {
          history.pushState(null, '', newUrl);
          window.dispatchEvent(new PopStateEvent('popstate', { state: null }));
          return { ok: true };
        } catch (e) {
          return { ok: false, error: String(e && e.message || e) };
        }
      },
      args: [url],
    });
    return !!(results && results[0] && results[0].result && results[0].result.ok);
  } catch (e) {
    return false;
  }
}

// === SPAレンダリング待ち ===

async function _waitForEssquareRender(tabId, timeoutMs) {
  const startTime = Date.now();
  let lastLen = 0;
  let staleStart = null;

  while (Date.now() - startTime < timeoutMs) {
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => {
          const body = document.body;
          if (!body) return { len: 0, yen: false, sqm: false, zero: false, search: false, items: 0 };
          const t = body.innerText;
          return {
            len: t.length,
            yen: t.includes('円'),
            sqm: t.includes('㎡') || t.includes('m²'),
            zero: /(^|\D)0\s*件/.test(t),
            search: t.includes('検索'),
            items: document.querySelectorAll('[data-testclass="bukkenListItem"]').length,
            noResult: t.includes('検索結果がありません') || t.includes('該当する物件がありません') || t.includes('条件に合う物件がありません') || t.includes('物件が見つかりません') || t.includes('見つかりませんでした'),
          };
        },
      });

      const ind = results?.[0]?.result;
      if (!ind) { await sleep(1000); continue; }

      // 検索結果が表示された（物件行selectorが最優先）
      if (ind.items > 0) return 'rendered';
      if (ind.len > 1000 && ind.yen && ind.sqm) return 'rendered';
      if (ind.len > 2000 && ind.yen) return 'rendered';

      // 0件（明示的な「該当なし」文言 or 0件テキスト + items===0）
      if (ind.noResult && ind.items === 0) return 'empty';
      if (ind.len > 800 && ind.search && ind.zero && ind.items === 0) return 'empty';

      // テキスト長変化の追跡
      if (ind.len !== lastLen) {
        lastLen = ind.len;
        staleStart = null;
      } else if (!staleStart) {
        staleStart = Date.now();
      } else if (Date.now() - staleStart > 8000) {
        console.warn(`[ES-Square] ページが${ind.len}charsで停止`);
        break;
      }
    } catch (e) {
      // タブが閉じられた等
    }
    await sleep(1000);
  }

  return 'timeout';
}

// === 検索結果ページ上の物件リンクをクリック ===

async function _clickEssquarePropertyLink(tabId, index) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: (idx) => {
      const rows = document.querySelectorAll('[data-testclass="bukkenListItem"]');
      if (idx >= rows.length) return false;
      const row = rows[idx];
      // 物件行内のリンクを探す
      const link = row.querySelector('a[href*="/detail/"]') || row.querySelector('a');
      if (link) {
        link.click();
        return true;
      }
      // リンクが見つからない場合、行自体をクリック
      row.click();
      return true;
    },
    args: [index],
  });
  return results?.[0]?.result === true;
}

// === fetchインターセプター設置（MAIN worldで実行、Python版 auth.py 準拠） ===

async function _installEssquareFetchInterceptor(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: () => {
      if (window.__esq_fetch_hooked) return;
      window.__esq_fetch_hooked = true;
      window.__esq_img_fetches = [];
      const _origFetch = window.fetch;
      const SKIP_IMG = /logo|icon|favicon|avatar|badge|chatbot|miibo|okbiz/i;
      window.fetch = function() {
        const args = arguments;
        const url = typeof args[0] === 'string'
          ? args[0]
          : (args[0] && args[0].url ? args[0].url : '');
        return _origFetch.apply(this, args).then(function(r) {
          try {
            const ct = r.headers.get('content-type') || '';
            if (ct.indexOf('image/') === 0
                && !SKIP_IMG.test(url)
                && url.indexOf('data:') !== 0) {
              window.__esq_img_fetches.push(url);
            }
          } catch(e) {}
          return r;
        });
      };
    },
  });
}

// === ギャラリー画像抽出（MAIN worldで実行） ===
// canvas base64キャプチャ（主）+ fetchインターセプターHTTP URL（補助）

async function _extractEssquareGalleryImages(tabId) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: async () => {
      const NO_IMAGE_BASE64_START = 'data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMTI4IiBoZWlnaHQ9Ijk2IiB2aWV3Qm94PSIwIDAgMTI4IDk2IiBmaWxsPSJub25lI';
      let log = '';

      // blob URL → base64変換（fetch方式）
      async function convertBlobToBase64(blobUrl) {
        try {
          const response = await fetch(blobUrl);
          const blob = await response.blob();
          if (!blob || blob.size === 0) return null;
          return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onloadend = () => resolve(reader.result);
            reader.onerror = reject;
            reader.readAsDataURL(blob);
          });
        } catch (e) {
          return null;
        }
      }

      // img要素 → canvas描画 → base64変換（blob fetch失敗時のフォールバック）
      function captureImgToBase64(imgEl) {
        try {
          if (!imgEl || !imgEl.naturalWidth || !imgEl.naturalHeight) return null;
          const canvas = document.createElement('canvas');
          canvas.width = imgEl.naturalWidth;
          canvas.height = imgEl.naturalHeight;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(imgEl, 0, 0);
          return canvas.toDataURL('image/jpeg', 0.92);
        } catch (e) {
          return null;
        }
      }

      // 条件待ち（リファレンスコードと完全一致）
      function waitFor(conditionFn, timeout = 5000, interval = 100) {
        return new Promise((resolve, reject) => {
          const start = Date.now();
          const check = () => {
            if (conditionFn()) return resolve();
            if (Date.now() - start > timeout) return reject('Timeout');
            setTimeout(check, interval);
          };
          check();
        });
      }

      // 画像src変化待ち（リファレンスコードと完全一致: complete + naturalWidth もチェック）
      async function waitForImageChange(prevSrc, timeout = 5000) {
        const start = Date.now();
        while (Date.now() - start < timeout) {
          const img = document.querySelector('.swiper-slide-active .css-oq6icw img');
          if (img && img.src !== prevSrc && img.complete && img.naturalWidth > 0) return;
          await new Promise(res => setTimeout(res, 100));
        }
      }

      // サムネイルクリックでギャラリーモーダルを開く
      const thumbnail = document.querySelector('.css-tx2s10 img');
      if (!thumbnail) return { base64s: [], urls: [], log: 'no_thumbnail' };
      thumbnail.click();

      // ギャラリー画像の表示待ち
      try {
        await waitFor(() => {
          const img = document.querySelector('.swiper-slide-active .css-oq6icw img');
          return img && img.complete && img.naturalWidth > 0;
        }, 5000);
      } catch (e) {
        return { base64s: [], urls: [], log: 'no_modal' };
      }

      const images = [];
      const seenSrcs = new Set(); // 全履歴を追跡（prevSrc単一変数では取りこぼしが起こる）
      let lastActiveSrc = '';
      let stopCounter = 0;

      // 単一imgをキャプチャして images に追加するヘルパー
      async function captureAndPush(img) {
        if (!img) return;
        const src = img.src;
        if (!src || seenSrcs.has(src)) return;
        seenSrcs.add(src);

        await waitFor(() => img.complete && img.naturalWidth > 0, 3000).catch(() => {});

        // canvas描画を優先（blob fetchは破損データを返すことがある）
        let base64 = captureImgToBase64(img);
        if (!base64 || base64.length <= 5000) {
          base64 = await convertBlobToBase64(src);
        }
        if (base64
            && !base64.startsWith(NO_IMAGE_BASE64_START)
            && base64.length > 5000
            && !images.includes(base64)) {
          images.push(base64);
        }
      }

      while (true) {
        // active + prev スライドの画像を取得
        const imgs = Array.from(document.querySelectorAll(
          '.swiper-slide-active .css-oq6icw img, .swiper-slide-prev .css-oq6icw img'
        ));

        for (const img of imgs) {
          await captureAndPush(img);
        }

        // 現在のアクティブsrc記録（waitForImageChange用）
        const activeImg = document.querySelector('.swiper-slide-active .css-oq6icw img');
        if (activeImg && activeImg.src) lastActiveSrc = activeImg.src;

        if (imgs.length === 0) {
          stopCounter++;
          if (stopCounter >= 2) break;
        } else {
          stopCounter = 0;
        }

        // 次へボタン判定
        const nextBtnIcon = document.querySelector('svg[data-testid="keyboardArrowRight"]');
        const nextBtnContainer = nextBtnIcon ? nextBtnIcon.closest('.css-1nuul26') : null;

        const hasNextBtn = !!nextBtnContainer;
        const hasNextIconOnly = !!nextBtnIcon && !nextBtnContainer;
        const isLastImage = hasNextIconOnly || !hasNextBtn;

        if (isLastImage) {
          // 最後の画像を確実に保存してからループ抜ける
          // activeスライドを再取得（遅延ロードされた場合に備える）
          await new Promise(r => setTimeout(r, 200));
          const finalImgs = Array.from(document.querySelectorAll(
            '.swiper-slide-active .css-oq6icw img, .swiper-slide-prev .css-oq6icw img, .swiper-slide-next .css-oq6icw img'
          ));
          for (const img of finalImgs) {
            await captureAndPush(img);
          }
          log += ' lastImg';
          break;
        }

        // クリック可能か確認
        const style = window.getComputedStyle(nextBtnContainer);
        const isClickable = style.pointerEvents !== 'none' && !nextBtnContainer.hasAttribute('disabled');
        if (!isClickable) {
          log += ' notClickable';
          break;
        }

        nextBtnContainer.click();
        await waitForImageChange(lastActiveSrc);
        await new Promise(r => setTimeout(r, 100));
      }

      log += ` captured:${images.length}`;

      // モーダルを閉じる
      const closeBtn = document.querySelector('.MuiBox-root.css-11p4x25');
      if (closeBtn) {
        closeBtn.click();
        await new Promise(r => setTimeout(r, 300));
      }

      return { base64s: images, urls: [], log };
    },
  });

  const result = results?.[0]?.result;
  return result || { base64s: [], urls: [], log: 'executeScript_failed' };
}

// === 検索結果ページに戻る ===

async function _goBackToEssquareSearchResults(tabId) {
  // 方法1: ページコンテキストで history.back() を実行
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: () => { window.history.back(); },
    });
  } catch (e) {
    console.warn('[ES-Square] history.back() 実行失敗:', e.message);
  }

  // URLが検索結果ページに戻るのを待つ
  const startTime = Date.now();
  const timeoutMs = 10000;
  while (Date.now() - startTime < timeoutMs) {
    await sleep(500);
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab.url && tab.url.includes('/search') && !tab.url.includes('/detail/')) {
        // 検索結果ページのレンダリングを待つ
        const renderStatus = await _waitForEssquareRender(tabId, 10000);
        if (renderStatus === 'rendered' || renderStatus === 'empty') return;
        break;
      }
    } catch (e) {}
  }

  // 方法1で戻れなかった場合、モーダルの閉じるボタンを試す
  const tab = await chrome.tabs.get(tabId);
  if (tab.url && tab.url.includes('/detail/')) {
    console.log('[ES-Square] history.back()で戻れず、モーダル閉じるボタンを試行');
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        func: () => {
          // ESCキー
          document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true }));
          // 閉じるボタン
          const closeBtn = document.querySelector(
            'button[aria-label="close"], button[aria-label="閉じる"],'
            + '[class*="close"], .MuiIconButton-root[aria-label]'
          );
          if (closeBtn) closeBtn.click();
          // ブラウザバック（リトライ）
          setTimeout(() => window.history.back(), 300);
        },
      });
    } catch (e) {}

    // 再度待機
    for (let i = 0; i < 10; i++) {
      await sleep(500);
      try {
        const t = await chrome.tabs.get(tabId);
        if (t.url && t.url.includes('/search') && !t.url.includes('/detail/')) {
          await _waitForEssquareRender(tabId, 10000);
          return;
        }
      } catch (e) {}
    }
  }
}

// === 検索結果パース（React Fiber経由） ===

async function _parseEssquareSearchResults(tabId) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',  // React Fiber にアクセスするためメインワールドで実行
    func: async () => {
      const properties = [];

      // data-testclass="bukkenListItem" で物件行を特定
      const rows = document.querySelectorAll('[data-testclass="bukkenListItem"]');

      for (const row of rows) {
        try {
          // React Fiber から specBukkenView props を取得
          const fiberKey = Object.keys(row).find(k => k.startsWith('__reactFiber'));
          if (!fiberKey) continue;

          let fiber = row[fiberKey];
          let specView = null;
          for (let i = 0; i < 30; i++) {
            if (!fiber) break;
            if (fiber.memoizedProps && fiber.memoizedProps.specBukkenView) {
              specView = fiber.memoizedProps.specBukkenView;
              break;
            }
            fiber = fiber.return;
          }
          if (!specView) continue;

          const bv = specView.chinshaku_bukken_view || {};
          const jv = specView.chinshaku_boshu_joken_view || {};
          const uuid = bv.chinshaku_bukken_guid;
          if (!uuid) continue;

          // 築年数を計算 (shunko_datejun: 202303103 → 2023年)
          let buildingAge = '';
          const shunko = specView.shunko_datejun;
          if (shunko) {
            // shunko_datejun: 202303103 → 上位4桁=年, 次2桁=月
            const shunkoYear = Math.floor(shunko / 100000);
            const shunkoMonth = Math.floor((shunko % 100000) / 1000);
            if (shunkoYear > 0) {
              const age = new Date().getFullYear() - shunkoYear;
              const ageStr = age <= 0 ? '新築' : `築${age}年`;
              if (shunkoMonth > 0) {
                buildingAge = `${shunkoYear}年${shunkoMonth}月(${ageStr})`;
              } else {
                buildingAge = `${shunkoYear}年(${ageStr})`;
              }
            }
          }

          // 入居可能日（datejun形式: YYYY*100000 + MM*1000 + DD*10 + precision）
          let moveInDate = '';
          const nyukyo = jv.nyukyo_kano_datejun;
          if (nyukyo) {
            const y = Math.floor(nyukyo / 100000);
            const md = nyukyo % 100000;
            const m = Math.floor(md / 1000);
            const d = Math.floor((md % 1000) / 10);
            if (y && m) moveInDate = d ? `${y}/${m}/${d}` : `${y}/${m}`;
          }

          // 契約種別
          let leaseType = '';
          if (jv.chintai_keiyaku_code === 2) leaseType = '定期借家';

          // 更新料（月数を優先）
          let renewalFee = '';
          if (jv.koshinryo_kagetsu) {
            renewalFee = `${jv.koshinryo_kagetsu}ヶ月`;
          } else if (jv.koshinryo_en) {
            renewalFee = `${jv.koshinryo_en}円`;
          }

          // 敷金（月数を優先）
          let deposit = '';
          if (jv.shikikin_kagetsu) {
            deposit = `${jv.shikikin_kagetsu}ヶ月`;
          } else if (jv.shikikin_en) {
            deposit = `${jv.shikikin_en}円`;
          }

          // 礼金（月数を優先）
          let keyMoney = '';
          if (jv.reikin_kagetsu) {
            keyMoney = `${jv.reikin_kagetsu}ヶ月`;
          } else if (jv.reikin_en) {
            keyMoney = `${jv.reikin_en}円`;
          }

          // 管理費（kanrihi + kyoekihi + zatsuyaku）
          const mgmtFee = (jv.kanrihi || 0) + (jv.kyoekihi || 0) + (jv.zatsuyaku || 0);

          // 募集状況（申込あり検出）— DOMタグから判定
          let listingStatus = '';
          let adStatus = ''; // 広告可 / 広告可※ / '' (なし)
          let adBadgeElement = null; // ホバー対象のbadge要素
          const tagLabels = row.querySelectorAll('.eds-tag__label');
          for (const tag of tagLabels) {
            const txt = tag.textContent.trim();
            if (txt === '申込あり') listingStatus = '申込あり';
            if (txt === '広告可') adStatus = '広告可';
            else if (txt === '広告可※') {
              adStatus = '広告可※';
              adBadgeElement = tag; // 後でホバーする
            }
          }

          // 広告可※の場合、ホバーでツールチップを表示してSUUMO掲載可否を判定
          let suumoAllowed = null;
          let allowedMediaRaw = null;
          if (adStatus === '広告可※' && adBadgeElement) {
            const target = adBadgeElement.closest('.eds-tag') || adBadgeElement;
            const fire = (el, type) =>
              el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));

            // 既存tooltip解除
            ['mouseleave', 'mouseout', 'pointerleave', 'pointerout', 'blur'].forEach(t => fire(target, t));
            await new Promise(r => setTimeout(r, 150));

            // ホバー発火
            ['pointerover', 'pointerenter', 'mouseover', 'mouseenter', 'focus'].forEach(t => fire(target, t));
            await new Promise(r => setTimeout(r, 400));

            // tooltip走査
            const tooltips = document.querySelectorAll('[role="tooltip"]');
            for (const tp of tooltips) {
              const txt = tp.innerText.trim();
              if (txt && (txt.includes('媒体') || txt.includes('・'))) {
                allowedMediaRaw = txt;
                suumoAllowed = /SUUMO/.test(txt);
                break;
              }
            }

            // ホバー解除
            ['mouseleave', 'mouseout', 'pointerleave', 'pointerout', 'blur'].forEach(t => fire(target, t));
            await new Promise(r => setTimeout(r, 150));
          } else if (adStatus === '広告可') {
            // 無条件で広告可 → SUUMO可
            suumoAllowed = true;
          }
          // フォールバック: MuiChip-label
          if (!listingStatus) {
            const chips = row.querySelectorAll('.MuiChip-label');
            for (const chip of chips) {
              if (chip.textContent.trim() === '申込あり') {
                listingStatus = '申込あり';
                break;
              }
            }
          }

          properties.push({
            uuid,
            building_name: specView.tatemono_name || '',
            room_number: (specView.heya_kukaku_number || '').replace(/^0+(?=\d)/, ''),
            address: specView.jusho_full_text || '',
            rent: jv.chinryo || 0,
            management_fee: mgmtFee,
            deposit,
            key_money: keyMoney,
            layout: specView.madori_name || '',
            area: specView.senyu_menseki || 0,
            building_age: buildingAge,
            station_info: specView.kotsu_text_1 || '',
            other_stations: [specView.kotsu_text_2, specView.kotsu_text_3].filter(Boolean),
            structure: specView.kozo || '',
            floor_text: specView.shozaikai ? (String(specView.shozaikai).includes('階') ? String(specView.shozaikai) : `${specView.shozaikai}階`) : '',
            floor: parseInt(specView.shozaikai) || 0,
            total_floors: specView.chijo_kaisu || 0,
            move_in_date: moveInDate,
            lease_type: leaseType,
            renewal_fee: renewalFee,
            komi_chinryo: jv.komi_chinryo || 0,
            contract_period: jv.keiyaku_kikan ? `${jv.keiyaku_kikan}年` : '',
            motozuke: jv.motozuke_gyosha_name || '',
            sales_point: bv.sales_point || '',
            listing_status: listingStatus,
            ad_status: adStatus, // '広告可' / '広告可※' / ''
            suumo_allowed: suumoAllowed, // true / false / null
            allowed_media_raw: allowedMediaRaw,
          });
        } catch (e) {
          // パースエラーは個別にスキップ
        }
      }

      return properties;
    },
  });

  return results?.[0]?.result || [];
}

// === 専用ウィンドウ管理 ===

async function findOrCreateDedicatedEssquareTab() {
  // メモリ上のIDが生きていればそれを使用
  if (dedicatedEssquareTabId) {
    try {
      const tab = await chrome.tabs.get(dedicatedEssquareTabId);
      if (tab && tab.url?.includes('es-square.net')) {
        return tab;
      }
    } catch (e) {
      // タブが閉じられている
    }
    dedicatedEssquareTabId = null;
    dedicatedEssquareWindowId = null;
  }

  // Service Worker再起動等でメモリがリセットされた場合は新規作成するだけでOK
  // (タブ方式では永続化不要)
  try {
    await setStorageData({ dedicatedEssquareWindowId: null });
  } catch (e) {}

  // 既存ウィンドウ内に非アクティブタブとして作成
  // active:false でフォーカスを一切奪わない
  await setStorageData({ debugLog: '[ES-Square] 専用タブを作成中...' });
  const newTab = await chrome.tabs.create({
    url: `${ESSQUARE_BASE_URL}/bukken/chintai/search`,
    active: false
  });
  dedicatedEssquareTabId = newTab.id;
  dedicatedEssquareWindowId = newTab.windowId;

  await waitForTabLoad(dedicatedEssquareTabId);
  await sleep(3000); // React SPA 考慮

  // ログイン状態を確認
  let tab = await chrome.tabs.get(dedicatedEssquareTabId);
  // Auth0 (auth.es-account.com) にリダイレクトされている or /login を含む
  if (tab.url?.includes('auth.es-account.com') || tab.url?.includes('/login')) {
    const autoLogin = await attemptEssquareAutoLogin_(dedicatedEssquareTabId);
    if (autoLogin.ok) {
      tab = await chrome.tabs.get(dedicatedEssquareTabId);
      if (!tab.url?.includes('rent.es-square.net')) {
        await chrome.tabs.update(dedicatedEssquareTabId, { url: `${ESSQUARE_BASE_URL}/bukken/chintai/search` });
        await waitForTabLoad(dedicatedEssquareTabId);
        await sleep(3000);
        tab = await chrome.tabs.get(dedicatedEssquareTabId);
      }
    } else if (autoLogin.skipped) {
      await setStorageData({ debugLog: `[ES-Square] ログインが必要です (${autoLogin.reason})` });
      await closeDedicatedEssquareWindow();
      return null;
    } else {
      await setStorageData({
        essquareLoginBlocked: true,
        essquareLoginBlockedReason: autoLogin.error || 'login failed',
        debugLog: `[ES-Square] ⚠️ 自動ログイン失敗のためブロック: ${autoLogin.error}。手動ログイン後にオプション画面でブロック解除してください`
      });
      await closeDedicatedEssquareWindow();
      return null;
    }
  }

  await setStorageData({ debugLog: `[ES-Square] 専用タブ作成: tabId=${dedicatedEssquareTabId}` });
  return tab;
}

/**
 * ES-Square 自動ログイン(1回のみ、失敗でBlock)
 * フォーム: auth.es-account.com/u/login (Auth0 Universal Login)
 * - input#username / input#password / button[type=submit][name=action][value=default]
 * - hidden input[name="state"] が自動同梱される
 */
async function attemptEssquareAutoLogin_(tabId) {
  const { essquareLoginId, essquarePassword, essquareLoginBlocked } = await getStorageData([
    'essquareLoginId', 'essquarePassword', 'essquareLoginBlocked'
  ]);
  if (essquareLoginBlocked) return { ok: false, skipped: true, reason: '前回ログイン失敗でブロック中' };
  if (!essquareLoginId || !essquarePassword) return { ok: false, skipped: true, reason: 'ID/PW未設定' };

  await setStorageData({ debugLog: '[ES-Square] Auth0ログインページ検知 → 自動ログイン試行(1回のみ)' });

  let submitResult;
  try {
    const execResult = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [0] },
      func: (loginId, password) => {
        const form = document.querySelector('form');
        if (!form) return { submitted: false, error: 'form not found' };
        const userInput = form.querySelector('input#username, input[name="username"]');
        const pwInput = form.querySelector('input#password, input[name="password"]');
        const submitBtn = form.querySelector('button[type="submit"][name="action"][value="default"]')
          || form.querySelector('button[type="submit"]');
        if (!userInput || !pwInput) return { submitted: false, error: 'username/password input not found' };
        if (!submitBtn) return { submitted: false, error: 'submit button not found' };

        const setNativeValue = (el, value) => {
          const proto = Object.getPrototypeOf(el);
          const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
          setter.call(el, value);
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        };
        setNativeValue(userInput, loginId);
        setNativeValue(pwInput, password);

        submitBtn.click();
        return { submitted: true };
      },
      args: [essquareLoginId, essquarePassword],
    });
    submitResult = execResult && execResult[0] && execResult[0].result;
  } catch (err) {
    return { ok: false, error: 'submit inject failed: ' + err.message };
  }

  if (!submitResult) return { ok: false, error: 'no result from submit script' };
  if (!submitResult.submitted) return { ok: false, error: submitResult.error || 'submit skipped' };

  try { await waitForTabLoad(tabId, 30000); } catch (_) {}
  await sleep(2500);

  const postTab = await chrome.tabs.get(tabId);
  if (postTab.url?.includes('auth.es-account.com')) {
    return { ok: false, error: 'submit後もauth.es-account.comに残ったまま(ID/PW不一致の可能性)' };
  }
  await setStorageData({ debugLog: '[ES-Square] 自動ログイン成功' });
  return { ok: true };
}

async function closeDedicatedEssquareWindow() {
  if (dedicatedEssquareTabId) {
    try {
      await chrome.tabs.remove(dedicatedEssquareTabId);
    } catch (e) {
      // 既に閉じられている
    }
    dedicatedEssquareWindowId = null;
    dedicatedEssquareTabId = null;
  }
  // 永続化IDもクリア
  try { await setStorageData({ dedicatedEssquareWindowId: null }); } catch (e) {}
}

// === ES-Square固有フィルタ ===

function getEssquareFilterRejectReason(prop, customer) {
  // SUUMO巡回モードのみ: 広告可フィルタ
  // - 広告可なし（バッジなし） → スキップ
  // - 広告可※ でSUUMOが掲載許可媒体に含まれない → スキップ
  if (globalThis._suumoPatrolMode) {
    const ad = prop.ad_status || '';
    if (ad !== '広告可' && ad !== '広告可※') {
      return '広告可バッジなし';
    }
    if (ad === '広告可※' && prop.suumo_allowed === false) {
      return '広告可※だがSUUMO掲載不可';
    }
  }

  // 町名丁目フィルタ（selectedTownsが指定されている場合、住所テキストで照合）
  if (customer.selectedTowns && Object.keys(customer.selectedTowns).length > 0) {
    const addr = prop.address || '';
    if (addr) {
      let townMatch = false;
      for (const city of Object.keys(customer.selectedTowns)) {
        const towns = customer.selectedTowns[city];
        if (!towns || towns.length === 0) continue;
        if (!addr.includes(city)) continue;
        for (const town of towns) {
          if (_addressMatchesTown(addr, town)) {
            townMatch = true;
            break;
          }
        }
        if (townMatch) break;
      }
      if (!townMatch) {
        return `町名不一致: ${addr}`;
      }
    }
  }

  // 賃料フィルタ（rent + management_fee vs rent_max万円）
  if (customer.rent_max) {
    const totalRent = (prop.rent || 0) + (prop.management_fee || 0);
    const rentMaxYen = parseFloat(customer.rent_max) * 10000;
    if (totalRent > rentMaxYen) {
      return `賃料超過: ${totalRent}円 > ${rentMaxYen}円`;
    }
  }

  // ステータスフィルタ
  //  - テストユーザー: すべてスキップしない（動作検証用）
  //  - SUUMO巡回モード: 申込ありでスキップしない（Discord通知へ流して警告表示する）
  const isTestUser = customer.name?.includes('テスト');
  const isSuumoPatrol = !!globalThis._suumoPatrolMode;
  if (!isTestUser && !isSuumoPatrol) {
    if (prop.listing_status === '申込あり') {
      try { globalThis.__addMoshikomiKey && globalThis.__addMoshikomiKey(prop.building_name, prop.room_number); } catch(e) {}
      return '申込あり';
    }
    if (prop.listing_status && prop.listing_status !== '申込あり') {
      try { globalThis.__removeMoshikomiKey && globalThis.__removeMoshikomiKey(prop.building_name, prop.room_number); } catch(e) {}
    }
  }

  const toHankaku = (s) => s.replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));
  const equip = toHankaku(customer.equipment || '').toLowerCase();

  const isNoneValue = (s) => !s || s === '-' || s === 'なし' || s === '0' || s === '0円' || s === '無' || s.trim() === '';

  // 敷金なし
  if (equip.includes('敷金なし') && !isNoneValue(prop.deposit)) {
    return `敷金あり: ${prop.deposit}`;
  }

  // 礼金なし
  if (equip.includes('礼金なし') && !isNoneValue(prop.key_money)) {
    return `礼金あり: ${prop.key_money}`;
  }

  // 定期借家除外
  if (equip.includes('定期借家除く') || equip.includes('定期借家ng')) {
    if (prop.lease_type && prop.lease_type.includes('定期')) {
      return `定期借家: ${prop.lease_type}`;
    }
  }

  // ロフトNG
  if (equip.includes('ロフトng') || equip.includes('ロフト不可')) {
    if (prop.facilities && prop.facilities.includes('ロフト')) {
      return 'ロフトNG: ロフト付き物件';
    }
  }

  // 設備フィルタ（設備情報がある場合のみチェック）
  const fac = prop.facilities || '';
  if (fac) {
    // ガス種別
    if (equip.includes('都市ガス') && !fac.includes('都市ガス') && (fac.includes('プロパン') || fac.includes('LPガス'))) return 'プロパンガス物件（都市ガス希望）';
    if ((equip.includes('プロパン') || equip.includes('lpガス')) && !fac.includes('プロパン') && !fac.includes('LPガス') && fac.includes('都市ガス')) return '都市ガス物件（プロパンガス希望）';
    // ペット可
    if (equip.includes('ペット')) {
      if (fac.includes('ペット不可')) return 'ペット不可';
      if (!fac.includes('ペット相談') && !fac.includes('ペット可') && !fac.includes('小型犬') && !fac.includes('大型犬') && !fac.includes('猫可')) return 'ペット可の記載なし';
    }
    // 楽器
    if (equip.includes('楽器') && fac.includes('楽器不可')) return '楽器不可';
    // 事務所
    if (equip.includes('事務所')) {
      if (fac.includes('事務所不可')) return '事務所利用不可';
      if (!fac.includes('事務所可') && !fac.includes('事務所使用相談')) return '事務所利用可の記載なし';
    }
    // ルームシェア
    if ((equip.includes('ルームシェア') || equip.includes('シェアハウス')) && fac.includes('ルームシェア不可')) return 'ルームシェア不可';
    // 高齢者
    if (equip.includes('高齢者') && fac.includes('高齢者不可')) return '高齢者不可';
  }

  // 階数フィルタ
  const floorNum = prop.floor || 0;
  if (equip.includes('2階以上') && floorNum > 0 && floorNum < 2) return `2階以上条件: ${floorNum}階`;
  if (equip.includes('1階') && !equip.includes('1階以上') && !equip.includes('2階以上') && floorNum > 0 && floorNum !== 1) return `1階限定条件: ${floorNum}階`;

  // 共通フィルタ（構造・最上階・南向き・間取り等）
  const commonReason = getFilterRejectReason(prop, customer);
  if (commonReason) return commonReason;

  return null;
}

// === content script 通信 ===

function sendEssquareContentMessage(tabId, message, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('ES-Square content script応答タイムアウト'));
    }, timeoutMs);

    chrome.tabs.sendMessage(tabId, message, (response) => {
      clearTimeout(timer);
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(response);
      }
    });
  });
}

// === 画像アップロード（catbox → 0x0.st → telegraph → imgbb → freeimage → tmpfiles → pixeldrain → imgur フォールバック） ===

const IMGBB_API_KEY = '48cdc51fdcc4a2828c3379b59663db7f';
// freeimage.host の公開コミュニティキー(広く知られた無料キー)
const FREEIMAGE_API_KEY = '6d207e02198a847aa98d0a2a901485a5';
// imgur Client-ID（未設定時は自動でスキップ）
const IMGUR_CLIENT_ID = '';

// ─── 共通ヘルパー: base64 → Blob ───
function _base64ToBlob(base64, mime) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mime || 'image/jpeg' });
}

// ─── catbox.moe (APIキー不要、最も安定) ───
async function _uploadCatbox(base64, mime) {
  const blob = _base64ToBlob(base64, mime);
  const formData = new FormData();
  formData.append('reqtype', 'fileupload');
  formData.append('fileToUpload', blob, 'upload.jpg');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  try {
    const resp = await fetch('https://catbox.moe/user/api.php', {
      method: 'POST', body: formData, signal: controller.signal
    });
    if (!resp.ok) {
      const body = (await resp.text().catch(() => '')).slice(0, 200);
      const isRate = resp.status === 429 || resp.status === 503;
      const err = new Error(`catbox_${resp.status}:${body.replace(/\s+/g, ' ')}`);
      if (isRate) err.rateLimited = true;
      throw err;
    }
    const text = (await resp.text()).trim();
    if (!/^https?:\/\/.+catbox\.moe\//i.test(text)) {
      throw new Error('catbox_unexpected_response:' + text.slice(0, 80));
    }
    return text;
  } finally {
    clearTimeout(timeout);
  }
}

// ─── 0x0.st (APIキー不要、シンプル) ───
async function _upload0x0(base64, mime) {
  const blob = _base64ToBlob(base64, mime);
  const formData = new FormData();
  formData.append('file', blob, 'upload.jpg');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  try {
    const resp = await fetch('https://0x0.st/', {
      method: 'POST', body: formData, signal: controller.signal
    });
    if (!resp.ok) {
      const body = (await resp.text().catch(() => '')).slice(0, 200);
      const isRate = resp.status === 429 || resp.status === 503;
      const err = new Error(`0x0_${resp.status}:${body.replace(/\s+/g, ' ')}`);
      if (isRate) err.rateLimited = true;
      throw err;
    }
    const text = (await resp.text()).trim();
    if (!/^https?:\/\/0x0\.st\//i.test(text)) {
      throw new Error('0x0_unexpected_response:' + text.slice(0, 80));
    }
    return text;
  } finally {
    clearTimeout(timeout);
  }
}

// ─── tmpfiles.org (APIキー不要) ───
async function _uploadTmpfiles(base64, mime) {
  const blob = _base64ToBlob(base64, mime);
  const formData = new FormData();
  formData.append('file', blob, 'upload.jpg');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  try {
    const resp = await fetch('https://tmpfiles.org/api/v1/upload', {
      method: 'POST', body: formData, signal: controller.signal
    });
    if (!resp.ok) {
      const body = (await resp.text().catch(() => '')).slice(0, 200);
      const isRate = resp.status === 429 || resp.status === 503;
      const err = new Error(`tmpfiles_${resp.status}:${body.replace(/\s+/g, ' ')}`);
      if (isRate) err.rateLimited = true;
      throw err;
    }
    const json = await resp.json();
    if (!json || !json.data || !json.data.url) throw new Error('tmpfiles_unexpected_response');
    // tmpfiles の url は /downloads/ ではなく /dl/ に書き換えると直接画像取得できる
    return json.data.url.replace('://tmpfiles.org/', '://tmpfiles.org/dl/').replace(/^http:\/\//, 'https://');
  } finally {
    clearTimeout(timeout);
  }
}

// ─── pixeldrain (APIキー不要、PUT送信) ───
async function _uploadPixeldrain(base64, mime) {
  const blob = _base64ToBlob(base64, mime);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  try {
    const resp = await fetch('https://pixeldrain.com/api/file', {
      method: 'POST',
      body: (() => { const fd = new FormData(); fd.append('file', blob, 'upload.jpg'); return fd; })(),
      signal: controller.signal
    });
    if (!resp.ok) {
      const body = (await resp.text().catch(() => '')).slice(0, 200);
      const isRate = resp.status === 429 || resp.status === 503;
      const err = new Error(`pixeldrain_${resp.status}:${body.replace(/\s+/g, ' ')}`);
      if (isRate) err.rateLimited = true;
      throw err;
    }
    const json = await resp.json();
    if (!json || !json.id) throw new Error('pixeldrain_unexpected_response');
    return `https://pixeldrain.com/api/file/${json.id}`;
  } finally {
    clearTimeout(timeout);
  }
}

// imgbb にアップロード
async function _uploadImgbb(base64) {
  const formData = new FormData();
  formData.append('image', base64);
  const resp = await fetch(`https://api.imgbb.com/1/upload?key=${IMGBB_API_KEY}`, { method: 'POST', body: formData });
  if (!resp.ok) {
    let body = ''; try { body = (await resp.text()).slice(0, 200); } catch(e){}
    const isRate = resp.status === 429 || resp.status === 503 || /rate limit/i.test(body);
    const err = new Error(`imgbb_${resp.status}:${body.replace(/\s+/g,' ')}`);
    if (isRate) err.rateLimited = true;
    throw err;
  }
  const json = await resp.json();
  if (!json || !json.success || !json.data || !json.data.url) throw new Error('imgbb_unexpected_response');
  return json.data.url;
}

// freeimage.host にアップロード(Cheveretoベース、imgbb互換フォーマット)
async function _uploadFreeimage(base64) {
  const formData = new FormData();
  formData.append('key', FREEIMAGE_API_KEY);
  formData.append('action', 'upload');
  formData.append('source', base64);
  formData.append('format', 'json');
  const resp = await fetch('https://freeimage.host/api/1/upload', { method: 'POST', body: formData });
  if (!resp.ok) {
    let body = ''; try { body = (await resp.text()).slice(0, 200); } catch(e){}
    const isRate = resp.status === 429 || resp.status === 503 || /rate limit/i.test(body);
    const err = new Error(`freeimage_${resp.status}:${body.replace(/\s+/g,' ')}`);
    if (isRate) err.rateLimited = true;
    throw err;
  }
  const json = await resp.json();
  if (!json || !json.image || !json.image.url) throw new Error('freeimage_unexpected_response');
  return json.image.url;
}

// imgur にアップロード(Client-ID必須)
async function _uploadImgur(base64) {
  if (!IMGUR_CLIENT_ID) throw new Error('imgur_no_client_id');
  const formData = new FormData();
  formData.append('image', base64);
  formData.append('type', 'base64');
  const resp = await fetch('https://api.imgur.com/3/image', {
    method: 'POST',
    headers: { 'Authorization': `Client-ID ${IMGUR_CLIENT_ID}` },
    body: formData,
  });
  if (!resp.ok) {
    let body = ''; try { body = (await resp.text()).slice(0, 200); } catch(e){}
    const isRate = resp.status === 429 || resp.status === 503 || /rate limit|quota/i.test(body);
    const err = new Error(`imgur_${resp.status}:${body.replace(/\s+/g,' ')}`);
    if (isRate) err.rateLimited = true;
    throw err;
  }
  const json = await resp.json();
  if (!json || !json.success || !json.data || !json.data.link) throw new Error('imgur_unexpected_response');
  return json.data.link;
}

// Telegra.ph にアップロード（APIキー不要、安定）
async function _uploadTelegraph(base64, mime) {
  // base64 → Blob に変換
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const blob = new Blob([bytes], { type: mime || 'image/jpeg' });

  const formData = new FormData();
  formData.append('file', blob, 'upload.jpg');

  // 20秒タイムアウト
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  try {
    const resp = await fetch('https://telegra.ph/upload', { method: 'POST', body: formData, signal: controller.signal });
    clearTimeout(timeout);
    if (!resp.ok) {
      const body = (await resp.text().catch(() => '')).slice(0, 200);
      const isRate = resp.status === 429 || resp.status === 503;
      const err = new Error(`telegraph_${resp.status}:${body.replace(/\s+/g, ' ')}`);
      if (isRate) err.rateLimited = true;
      throw err;
    }
    const json = await resp.json();
    if (Array.isArray(json) && json[0] && json[0].src) {
      return 'https://telegra.ph' + json[0].src;
    }
    throw new Error('telegraph_unexpected_response');
  } finally {
    clearTimeout(timeout);
  }
}

// ホスト別の最終失敗時刻を記録し、しばらくスキップする(レート制限食らったら60秒避ける)
const __hostCooldown = {
  catbox: 0, '0x0': 0, telegraph: 0, imgbb: 0,
  freeimage: 0, tmpfiles: 0, pixeldrain: 0, imgur: 0
};
const COOLDOWN_MS = 60 * 1000;

// アップロード成功 URL の死活確認。
// catbox 等が API には 200 で URL を返すが実体は保存されていない「偽成功」を弾くため。
// 実体サイズが期待値の半分未満なら破損とみなす（base64 → binary は約 0.75 倍）。
async function _verifyImageUrl(url, expectedB64Length) {
  const minSize = Math.max(1024, Math.floor(expectedB64Length * 0.4));
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 10000);
  try {
    const r = await fetch(url, { signal: ctrl.signal, cache: 'no-store' });
    if (!r.ok) return { ok: false, reason: `http_${r.status}` };
    const blob = await r.blob();
    if (!blob || blob.size < minSize) {
      return { ok: false, reason: `size_${blob ? blob.size : 0}_lt_${minSize}` };
    }
    if (!/^image\//.test(blob.type || '')) {
      return { ok: false, reason: `mime_${blob.type || 'empty'}` };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: 'verify_err:' + ((e && e.message) || e).toString().slice(0, 60) };
  } finally {
    clearTimeout(t);
  }
}

async function uploadBase64ToCatbox(dataUrl) {
  // 関数名は過去互換。実体は catbox→0x0→telegraph→imgbb→freeimage→tmpfiles→pixeldrain→imgur のフォールバック
  const match = dataUrl.match(/^data:(image\/\w+);base64,(.+)$/);
  if (!match) return null;
  const mime = match[1];
  const base64 = match[2];

  const now = Date.now();
  const allHosts = [
    // 安定度の高い順: catbox / 0x0.st (APIキー不要、長期運用) → telegraph (安定) → imgbb (たまに429)
    // → freeimage (たまにレート制限) → tmpfiles (一時保存) → pixeldrain → imgur (キー無しだとスキップ)
    { name: 'catbox', fn: () => _uploadCatbox(base64, mime) },
    { name: '0x0', fn: () => _upload0x0(base64, mime) },
    { name: 'telegraph', fn: () => _uploadTelegraph(base64, mime) },
    { name: 'imgbb', fn: () => _uploadImgbb(base64) },
    { name: 'freeimage', fn: () => _uploadFreeimage(base64) },
    { name: 'tmpfiles', fn: () => _uploadTmpfiles(base64, mime) },
    { name: 'pixeldrain', fn: () => _uploadPixeldrain(base64, mime) },
    { name: 'imgur', fn: () => _uploadImgur(base64) },
  ];
  let hosts = allHosts.filter(h => now - __hostCooldown[h.name] > COOLDOWN_MS);
  if (hosts.length === 0) hosts = allHosts;

  const errors = [];
  for (const h of hosts) {
    try {
      const url = await h.fn();
      if (!url) {
        errors.push(`${h.name}=null_url`);
        continue;
      }
      // 偽成功(API 200 だが実体壊れ)を弾く
      const verify = await _verifyImageUrl(url, base64.length);
      if (verify.ok) return url;
      __hostCooldown[h.name] = Date.now();
      errors.push(`${h.name}=verify_failed(${verify.reason})_url=${url.slice(0, 60)}`);
    } catch (e) {
      errors.push(`${h.name}=${(e && e.message) || e}`.slice(0, 120));
      if (e && e.rateLimited) __hostCooldown[h.name] = Date.now();
      // 次のホストへフォールバック
    }
  }
  // 全部失敗 → エラーチェーン全体を含めてthrow
  const aggregated = new Error(`all_hosts_failed: ${errors.join(' | ')}`);
  throw aggregated;
}

// === property_data_json構築 ===

function buildEssquarePropertyDataJson(prop) {
  // sanitization_feeをother_onetime_feeに統合
  if (prop.sanitization_fee && !prop.other_onetime_fee) {
    prop.other_onetime_fee = `室内抗菌: ${prop.sanitization_fee}`;
  } else if (prop.sanitization_fee && prop.other_onetime_fee) {
    prop.other_onetime_fee += ` / 室内抗菌: ${prop.sanitization_fee}`;
  }

  return {
    source: 'essquare',
    building_name: prop.building_name || '',
    room_number: prop.room_number || '',
    address: prop.address || '',
    rent: prop.rent || 0,
    management_fee: prop.management_fee || 0,
    deposit: prop.deposit || '',
    key_money: prop.key_money || '',
    layout: prop.layout || '',
    area: prop.area || 0,
    building_age: prop.building_age || '',
    station_info: prop.station_info || '',
    other_stations: prop.other_stations || [],
    floor_text: prop.floor_text || '',
    structure: prop.structure || '',
    facilities: prop.facilities || '',
    move_in_date: prop.move_in_date || '',
    lease_type: prop.lease_type || '',
    listing_status: prop.listing_status || '',
    url: prop.url || '',
    image_url: prop.image_url || '',
    image_urls: prop.image_urls || [],
    key_exchange_fee: prop.key_exchange_fee || '',
    fire_insurance: prop.fire_insurance || '',
    guarantee_info: prop.guarantee_info || '',
    renewal_fee: prop.renewal_fee || '',
    contract_period: prop.contract_period || '',
    parking_fee: prop.parking_fee || '',
    free_rent: prop.free_rent || '',
    sunlight: prop.sunlight || '',
    total_units: prop.total_units || '',
    other_monthly_fee: prop.other_monthly_fee || '',
    other_onetime_fee: prop.other_onetime_fee || '',
    shikibiki: prop.shikibiki || '',
    layout_detail: prop.layout_detail || '',
    story_text: prop.story_text || (prop.total_floors ? `${prop.total_floors}階建` : ''),
    guarantee_deposit: prop.guarantee_deposit || '',
    bicycle_parking_fee: prop.bicycle_parking_fee || '',
    motorcycle_parking_fee: prop.motorcycle_parking_fee || '',
    move_in_conditions: prop.move_in_conditions || '',
    pet_deposit: prop.pet_deposit || '',
    renewal_admin_fee: prop.renewal_admin_fee || '',
    renewal_info: prop.renewal_info || '',
    support_fee_24h: prop.support_fee_24h || '',
    additional_deposit: prop.additional_deposit || '',
    water_billing: prop.water_billing || '',
    cleaning_fee: prop.cleaning_fee || '',
    // sanitization_feeはother_onetime_feeに統合（GAS側未対応のため）
    rights_fee: prop.rights_fee || '',
    free_rent_detail: prop.free_rent_detail || '',
    cancellation_notice: prop.cancellation_notice || '',
    owner_company: prop.owner_company || '',
    owner_phone: prop.owner_phone || '',
  };
}

// === メイン検索関数 ===

/**
 * ES-Square 全顧客検索を実行する。
 * background.js の runSearchCycle() から呼ばれる。
 */
async function runEssquareSearch(criteria, seenIds, searchId) {
  await setStorageData({ debugLog: '[ES-Square] 検索開始...' });

  const essquareTab = await findOrCreateDedicatedEssquareTab();
  if (!essquareTab) return;

  // タブクリーンアップは上位の検索ループ終了時に一括で行う (background.js
  // の closeDedicatedEssquareWindow 呼び出し)。
  // ここで顧客ごとに try/finally で close すると、お客様1人ずつ
  // runEssquareSearch([customer]) で呼び出される構造のため、毎回:
  //   タブ作成→検索→close→次の顧客でまた新規タブ作成
  // が起こり、新規セッションからの連続アクセスとして ES-Square の WAF が
  // 反応してレート制限される (実測: 14-22人目で「検索中にエラーが発生しました」)。
  // 同じタブを使い回すことで人間の操作 (1タブで条件を切り替えながら検索) に
  // 近い形になる。
  for (let ci = 0; ci < criteria.length; ci++) {
    if (isSearchCancelled(searchId)) return;

    const customer = criteria[ci];
    await setStorageData({ debugLog: `[ES-Square] 顧客 ${ci+1}/${criteria.length}: ${customer.name}` });
    try {
      const cond = formatCustomerCriteria(customer);
      await setStorageData({ debugLog: `[ES-Square] 条件: ${cond}` });
    } catch (e) {
      await setStorageData({ debugLog: `[ES-Square] 条件表示エラー: ${e.message}` });
    }

    try {
      await searchEssquareForCustomer(dedicatedEssquareTabId, customer, seenIds, searchId);
    } catch (err) {
      if (err.message === 'SEARCH_CANCELLED') return;
      if (err.message === 'SLEEP_DETECTED') {
        await setStorageData({ debugLog: '[ES-Square] PCスリープ検知→検索中断' });
        return;
      }
      if (err.message === 'ESSQUARE_LOGIN_REQUIRED') {
        await setStorageData({ debugLog: '[ES-Square] ログインが必要です。rent.es-square.netでログインしてください。' });
        return;
      }
      logError(`[ES-Square] ${customer.name}の検索失敗: ${err.message}`);
    }

    if (ci < criteria.length - 1) await sleep(3000);
  }
}

/**
 * 1顧客分のES-Square検索を実行する。
 */
async function searchEssquareForCustomer(tabId, customer, seenIds, searchId) {
  const csleep = async (ms) => {
    const before = Date.now();
    await sleep(ms);
    const elapsed = Date.now() - before;
    if (elapsed > Math.max(ms * 3, ms + 30000)) {
      throw new Error('SLEEP_DETECTED');
    }
    if (isSearchCancelled(searchId)) throw new Error('SEARCH_CANCELLED');
  };

  const customerSeenIds = seenIds[customer.name] || [];
  let submittedCount = 0;

  // エリア指定チェック
  const stationCodes = _resolveEssquareStationCodes(customer);
  const cities = (customer.cities || []).filter(c => ESSQUARE_CITY_CODES[c.trim()]);
  if (stationCodes.length === 0 && cities.length === 0) {
    await setStorageData({ debugLog: `[ES-Square] ${customer.name}: エリア指定なし → スキップ` });
    return;
  }

  // 検索条件ログ
  const filterParts = [];
  if (customer.rent_max) filterParts.push(`〜${customer.rent_max}万`);
  if (stationCodes.length > 0) filterParts.push(`駅: ${stationCodes.length}件`);
  if (cities.length > 0) filterParts.push(`市区町村: ${cities.join(',')}`);
  if (customer.selectedTowns && Object.keys(customer.selectedTowns).length > 0) {
    const townSummary = Object.entries(customer.selectedTowns).map(([c, t]) => `${c}:${t.join('/')}`).join(', ');
    filterParts.push(`町名: ${townSummary}`);
  }
  if (customer.layouts?.length) filterParts.push(`間取り: ${customer.layouts.join('/')}`);
  if (customer.area_min) filterParts.push(`面積${customer.area_min}㎡〜`);
  if (customer.building_age) filterParts.push(`築${customer.building_age}年`);
  await setStorageData({ debugLog: `[ES-Square] ${customer.name}: 検索条件 → ${filterParts.join(' / ') || '(条件なし)'}` });

  // jushoリスト解決 + チャンク分割（ES-Square上限: jusho 50件/リクエスト）
  const JUSHO_CHUNK_SIZE = 50;
  const allJusho = _resolveEssquareJushoList(customer);
  const jushoChunks = [];
  if (allJusho.length > 0) {
    for (let i = 0; i < allJusho.length; i += JUSHO_CHUNK_SIZE) {
      jushoChunks.push(allJusho.slice(i, i + JUSHO_CHUNK_SIZE));
    }
  } else {
    jushoChunks.push(null); // 町名指定なし → 通常検索1回
  }

  // ページネーション（最大5ページ × 30件 = 150件）
  // 人間的な動作: 検索結果ページに留まり、物件をクリック→詳細取得→戻る→次の物件
  const maxPages = 5;
  let totalProperties = 0;

  for (let chunkIdx = 0; chunkIdx < jushoChunks.length; chunkIdx++) {
    const jushoChunk = jushoChunks[chunkIdx];
    const chunkLabel = jushoChunks.length > 1 ? ` [分割${chunkIdx + 1}/${jushoChunks.length}]` : '';

  for (let page = 1; page <= maxPages; page++) {
    if (isSearchCancelled(searchId)) throw new Error('SEARCH_CANCELLED');

    const url = buildEssquareSearchUrl(customer, page, jushoChunk);
    if (page === 1) {
      await setStorageData({ debugLog: `[ES-Square] ${customer.name}: 検索URL${chunkLabel} → ${url}` });
    }

    // ページ遷移: SPAナビゲーションを優先 (フルリロード回避→bot検知回避)。
    // 同一ドメイン外 or pushState 失敗時は URL 直接遷移にフォールバック。
    const spaNavigated = await navigateEssquareSpa_(tabId, url);
    if (!spaNavigated) {
      await chrome.tabs.update(tabId, { url });
      await waitForTabLoad(tabId);
    } else {
      // SPA ルーティングは load イベント発火しないので短く待機
      await sleep(500);
    }

    // SPAレンダリング待ち
    const renderStatus = await _waitForEssquareRender(tabId, 20000);

    if (renderStatus === 'empty') {
      if (page === 1) {
        await setStorageData({ debugLog: `[ES-Square] ${customer.name}: 検索結果0件` });
      }
      break;
    }

    if (renderStatus === 'timeout') {
      if (page === 1) {
        // リトライ
        await setStorageData({ debugLog: `[ES-Square] ${customer.name}: レンダリング待ちタイムアウト、リトライ...` });
        await chrome.tabs.update(tabId, { url });
        await waitForTabLoad(tabId);
        const retryStatus = await _waitForEssquareRender(tabId, 15000);
        if (retryStatus !== 'rendered') {
          await setStorageData({ debugLog: `[ES-Square] ${customer.name}: リトライ後も失敗` });
          break;
        }
      } else {
        await setStorageData({ debugLog: `[ES-Square] ${customer.name}: page=${page} レンダリング失敗、終了` });
        break;
      }
    }

    // ログインチェック
    const currentTab = await chrome.tabs.get(tabId);
    if (currentTab.url?.includes('/login')) {
      throw new Error('ESSQUARE_LOGIN_REQUIRED');
    }

    // DOMから物件リスト抽出（基本情報 + UUID）
    const pageProps = await _parseEssquareSearchResults(tabId);
    await setStorageData({ debugLog: `[ES-Square] ${customer.name}: page=${page} → ${pageProps.length}件取得` });

    if (pageProps.length === 0) break;

    // 各物件にデフォルト値を付与
    for (const p of pageProps) {
      p.source = 'essquare';
      p.url = `${ESSQUARE_BASE_URL}/bukken/chintai/search/detail/${p.uuid}`;
      // room_idをハッシュ化（顧客向けURLでソース非表示）
      p._raw_room_id = p.uuid;
      p.room_id = await hashRoomId('essquare', p.uuid);
      p.building_id = p.uuid.split('-')[0] || p.uuid;
      p.image_urls = p.image_urls || [];
      p.facilities = p.facilities || '';
      p.move_in_date = p.move_in_date || '';
      p.lease_type = p.lease_type || '';
      p.listing_status = p.listing_status || '';
      p.floor = p.floor || 0;
      p.floor_text = p.floor_text || '';
      p.sunlight = p.sunlight || '';
      p.total_units = p.total_units || '';
      p.contract_period = p.contract_period || '';
      p.renewal_fee = p.renewal_fee || '';
      p.key_exchange_fee = p.key_exchange_fee || '';
      p.fire_insurance = p.fire_insurance || '';
      p.guarantee_info = p.guarantee_info || '';
      p.parking_fee = p.parking_fee || '';
      p.free_rent = p.free_rent || '';
      p.other_monthly_fee = p.other_monthly_fee || '';
      p.other_onetime_fee = p.other_onetime_fee || '';
      p.shikibiki = p.shikibiki || '';
      p.layout_detail = p.layout_detail || '';
      p.story_text = p.total_floors ? `${p.total_floors}階建` : '';
    }

    totalProperties += pageProps.length;
    await setStorageData({ debugLog: `[ES-Square] ${customer.name}: ${totalProperties}件取得、検索結果ページから詳細確認中...` });

    // 検索結果ページに留まったまま、各物件をクリックして詳細取得
    for (let propIdx = 0; propIdx < pageProps.length; propIdx++) {
      const prop = pageProps[propIdx];
      if (isSearchCancelled(searchId)) throw new Error('SEARCH_CANCELLED');

      // 重複チェック (強制再取得リストに含まれる場合はバイパス)
      const isTestUser = customer.name.includes('テスト');
      const forceSet = globalThis._oneShotForceRefetchSet;
      const isForced = !!(forceSet && (
        forceSet.has(String(prop._raw_room_id || '')) ||
        forceSet.has(String(prop.room_id || ''))
      ));
      if (!isForced && !isTestUser && customerSeenIds.includes(prop.room_id)) {
        continue;
      }
      if (isForced) {
        await setStorageData({ debugLog: `[強制再取得] [ES-Square] ${customer.name}: ${prop._raw_room_id || prop.room_id} を強制再取得対象として処理` });
      }

      // SUUMO巡回モードでは、一覧ページのバッジ+ツールチップ情報で
      // 詳細モーダルを開く前にスキップ判定
      if (globalThis._suumoPatrolMode) {
        if (!prop.ad_status) {
          await setStorageData({ debugLog: `[ES-Square] ${customer.name}: ✗ スキップ（詳細開かず）: ${prop.building_name} ${prop.room_number || ''} - 広告可バッジなし` });
          continue;
        }
        if (prop.ad_status === '広告可※' && prop.suumo_allowed === false) {
          await setStorageData({ debugLog: `[ES-Square] ${customer.name}: ✗ スキップ（詳細開かず）: ${prop.building_name} ${prop.room_number || ''} - 広告可※だがSUUMO不可` });
          continue;
        }
      }

      // 詳細取得: 検索結果ページ上の物件リンクをクリック
      try {
        // 検索結果ページで該当物件のリンクをクリック
        const clicked = await _clickEssquarePropertyLink(tabId, propIdx);
        if (!clicked) {
          console.warn(`[ES-Square] クリック失敗 (${prop.building_name}): index=${propIdx}`);
          continue;
        }

        // スライドモーダル（詳細ページ）の読み込み待ち
        // SPA遷移なのでwaitForTabLoadは不要（ページ自体はリロードされない）
        // 固定sleepではなく、詳細ページの主要要素出現を条件待ち（最大3秒、通常1秒以下）
        try {
          await chrome.scripting.executeScript({
            target: { tabId },
            world: 'MAIN',
            func: async () => {
              const start = Date.now();
              while (Date.now() - start < 3000) {
                // サムネイル画像 or MuiGridアイテムの出現で描画完了と判定
                const thumb = document.querySelector('.css-tx2s10 img');
                const grids = document.querySelectorAll('.MuiGrid-item');
                if (thumb && grids.length > 5) return;
                await new Promise(r => setTimeout(r, 100));
              }
            },
          });
        } catch (e) {}
        await csleep(200); // 念のため微小バッファ

        // ログインチェック
        const detailTab = await chrome.tabs.get(tabId);
        if (detailTab.url?.includes('/login')) {
          throw new Error('ESSQUARE_LOGIN_REQUIRED');
        }

        // fetchインターセプター設置（画像fetch URLトラッキング用、Python版auth.py準拠）
        await _installEssquareFetchInterceptor(tabId);

        // SPA遷移ではcontent scriptが自動注入されないため、手動で注入
        try {
          await chrome.scripting.executeScript({
            target: { tabId },
            files: ['essquare-content-detail.js'],
          });
          await sleep(500); // content script初期化待ち
        } catch (err) {
          console.warn(`[ES-Square] content script注入失敗 (${prop.building_name}):`, err.message);
        }

        let detailResult;
        try {
          detailResult = await sendEssquareContentMessage(tabId, { type: 'ESSQUARE_EXTRACT_DETAIL' }, 60000);
        } catch (err) {
          console.warn(`[ES-Square] 詳細取得失敗 (${prop.building_name}):`, err.message);
        }

        // 設備が空の場合は React/MUI の遅延レンダリングが原因の可能性あり
        // 2秒追加で待ってから再度取得を試みる(他フィールドは初回成功のものを保持)
        if (detailResult?.ok && detailResult.detail && !detailResult.detail.facilities) {
          try {
            await sleep(2000);
            const retry = await sendEssquareContentMessage(tabId, { type: 'ESSQUARE_EXTRACT_DETAIL' }, 60000);
            if (retry?.ok && retry.detail?.facilities) {
              console.log(`[ES-Square] 設備リトライで取得成功 (${prop.building_name})`);
              detailResult.detail.facilities = retry.detail.facilities;
            }
          } catch (err) {
            console.warn(`[ES-Square] 設備リトライ失敗 (${prop.building_name}):`, err.message);
          }
        }

        if (detailResult?.ok && detailResult.detail) {
          const d = detailResult.detail;
          // デバッグログ(冗長なので削除)
          // 旧: imgs/fac件数 + 設備プレビューを毎物件出力していたが、
          //     ログが大量に流れて見づらくなるため非表示化

          if (d.listing_status) prop.listing_status = d.listing_status;
          if (d.facilities) prop.facilities = d.facilities;

          if (d.other_stations?.length) {
            prop.other_stations = d.other_stations;
          }

          // 管理費: 詳細ページテキストからパース（検索結果が0の場合のフォールバック）
          if (d._mgmt_text && !prop.management_fee) {
            const mgmtMatch = d._mgmt_text.match(/([\d,]+)\s*円/);
            if (mgmtMatch) {
              prop.management_fee = parseInt(mgmtMatch[1].replace(/,/g, ''));
            }
          }

          // 住所: 一覧で specView.jusho_full_text が空のケースがあるため、
          // 詳細ページの「所在地」ラベル値で補完
          if (d.address && !prop.address) {
            prop.address = d.address;
          }

          // 面積: 一覧で specView.senyu_menseki が空(0)のケースがあるため、
          // 詳細ページの「専有面積」テキスト(_area_text, 例: "32.45m²")から数値を抽出
          if (d._area_text && (!prop.area || prop.area === 0)) {
            const areaMatch = String(d._area_text).match(/([\d.]+)/);
            if (areaMatch) {
              const areaNum = parseFloat(areaMatch[1]);
              if (isFinite(areaNum) && areaNum > 0) prop.area = areaNum;
            }
          }

          // 建物名: 詳細の '物件名' ラベルで補完
          if (d.building_name && !prop.building_name) {
            prop.building_name = d.building_name;
          }

          // 詳細ページの値で補完するフィールド
          const detailFields = [
            'floor_text', 'story_text', 'structure', 'total_units', 'lease_type', 'contract_period',
            'cancellation_notice', 'renewal_info', 'sunlight', 'free_rent', 'free_rent_detail',
            'fire_insurance', 'key_exchange_fee', 'guarantee_info', 'guarantee_deposit',
            'parking_fee', 'bicycle_parking_fee', 'motorcycle_parking_fee',
            'other_monthly_fee', 'other_onetime_fee', 'move_in_date', 'move_out_date',
            'preview_start_date', 'layout_detail', 'shikibiki', 'floor',
            'move_in_conditions', 'pet_deposit', 'renewal_admin_fee',
            'support_fee_24h', 'additional_deposit', 'water_billing',
            'cleaning_fee', 'sanitization_fee', 'rights_fee',
            'ad_fee', 'current_status',
            'owner_company', 'owner_phone',
            'ad_approval_text',
          ];
          // 一覧ページのツールチップで既に判定済みなら詳細ページ値で上書きしない
          if (typeof d.suumo_allowed === 'boolean' && prop.suumo_allowed === null) {
            prop.suumo_allowed = d.suumo_allowed;
          }
          for (const key of detailFields) {
            if (d[key] && !prop[key]) {
              prop[key] = d[key];
            }
          }

          // 詳細ページの値で上書きするフィールド
          const overrideFields = ['deposit', 'key_money', 'renewal_fee', 'move_in_date'];
          for (const key of overrideFields) {
            if (d[key]) {
              let val = d[key];
              if (key !== 'move_in_date') {
                val = val.replace(/\/[\-ー－なし]*$/, '').trim();
              }
              prop[key] = val;
            }
          }

          if (prop.structure) {
            prop.structure = ESSQUARE_STRUCTURE_NORMALIZE[prop.structure] || prop.structure;
          }

          if (prop.floor_text && !prop.floor) {
            const floorMatch = prop.floor_text.match(/(\d+)/);
            if (floorMatch) prop.floor = parseInt(floorMatch[1]);
          }

          // フィルタリング（画像取得前に判定し、スキップ物件の画像取得を省略）
          const earlyRejectReason = getEssquareFilterRejectReason(prop, customer);
          if (earlyRejectReason) {
            await setStorageData({ debugLog: `[ES-Square] ${customer.name}: ✗ スキップ: ${prop.building_name} ${prop.room_number || ''} - ${earlyRejectReason}` });
            // ブラウザバックで検索結果ページに戻る
            await _goBackToEssquareSearchResults(tabId);
            continue;
          }

          // 元付会社名キーワードによる早期スキップ(SUUMO巡回モードのみ)
          // 競合数取得や画像取得より前に判定して無駄な処理を省略
          if (globalThis._suumoPatrolMode && typeof globalThis.checkSuumoOwnerKeywordSkip === 'function') {
            try {
              const ownerSkip = await globalThis.checkSuumoOwnerKeywordSkip(prop);
              if (ownerSkip.skip) {
                await setStorageData({ debugLog: `[ES-Square] ${customer.name}: ✗ スキップ: ${prop.building_name} ${prop.room_number || ''} - ${ownerSkip.reason}` });
                await _goBackToEssquareSearchResults(tabId);
                continue;
              }
            } catch (e) {
              console.warn('[ES-Square] 元付キーワード判定エラー:', e && e.message);
            }
          }

          // SUUMO巡回モード: 画像取得前にSUUMO競合数をチェックし、閾値超過なら画像取得を省略
          // (ES-Squareの画像取得は canvas base64 + catboxアップロード で非常に重いため効果大)
          if (globalThis._suumoPatrolMode && typeof globalThis.checkSuumoCompetitorPreSkip === 'function') {
            try {
              const preResult = await globalThis.checkSuumoCompetitorPreSkip(prop);
              if (preResult.competitor) {
                prop.suumo_competitor = preResult.competitor;
              }
              if (preResult.skip) {
                await setStorageData({ debugLog: `[ES-Square] ${customer.name}: ✗ スキップ: ${prop.building_name} ${prop.room_number || ''} - ${preResult.reason}(画像取得前に判定)` });
                await _goBackToEssquareSearchResults(tabId);
                continue;
              }
            } catch (e) {
              console.warn('[ES-Square] 競合先行判定エラー:', e && e.message);
            }
          }

          // 画像: MAIN worldでギャラリーナビゲーション→canvas base64キャプチャ + fetch URL
          try {
            const galleryResult = await _extractEssquareGalleryImages(tabId);
            if (galleryResult.log) {
              await setStorageData({ debugLog: `[ES-Square] ギャラリー: ${galleryResult.log}` });
            }
            const base64s = galleryResult.base64s || [];
            const fetchUrls = galleryResult.urls || [];

            if (base64s.length > 0 || fetchUrls.length > 0) {
              await setStorageData({ debugLog: `[ES-Square] 画像: canvas=${base64s.length}件, fetchURL=${fetchUrls.length}件、アップロード中...` });
              const uploadedUrls = [];
              let uploadFailed = 0;

              // 1. canvas base64画像をアップロード（6並列バッチ、429指数バックオフ、3回リトライ）
              async function uploadOne(b64) {
                const MAX_ATTEMPTS = 3;
                for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
                  try {
                    const publicUrl = await uploadBase64ToCatbox(b64);
                    if (publicUrl) return publicUrl;
                    // null戻り（無効応答や0バイト）の場合は1秒後リトライ
                    if (attempt < MAX_ATTEMPTS - 1) await sleep(1000);
                  } catch (e) {
                    if (attempt >= MAX_ATTEMPTS - 1) return null;
                    if (e && e.rateLimited) {
                      // 429: 指数バックオフ + ジッター（2s → 4s → …）
                      const wait = 2000 * Math.pow(2, attempt) + Math.floor(Math.random() * 500);
                      await sleep(wait);
                    } else {
                      await sleep(1000);
                    }
                  }
                }
                return null;
              }
              const BATCH = 6;
              for (let i = 0; i < base64s.length; i += BATCH) {
                const chunk = base64s.slice(i, i + BATCH);
                const results = await Promise.all(chunk.map(uploadOne));
                for (const r of results) {
                  if (r) uploadedUrls.push(r);
                  else uploadFailed++;
                }
              }

              // 2. fetch URLで補完（canvasが少ない場合）
              if (uploadedUrls.length < 5 && fetchUrls.length > 0) {
                for (const imgUrl of fetchUrls) {
                  try {
                    const resp = await fetch(imgUrl, { credentials: 'include' });
                    if (!resp.ok) continue;
                    const blob = await resp.blob();
                    if (blob.size < 3000 || blob.size > 5000000) continue;
                    const base64 = await new Promise((resolve) => {
                      const reader = new FileReader();
                      reader.onloadend = () => resolve(reader.result);
                      reader.readAsDataURL(blob);
                    });
                    const publicUrl = await uploadBase64ToCatbox(base64);
                    if (publicUrl) uploadedUrls.push(publicUrl);
                  } catch (e) {}
                }
              }

              if (uploadedUrls.length > 0) {
                prop.image_urls = uploadedUrls;
                prop.image_url = uploadedUrls[0];
                await setStorageData({ debugLog: `[ES-Square] 画像アップロード完了: ${uploadedUrls.length}件${uploadFailed > 0 ? ` (失敗:${uploadFailed}件)` : ''}` });
              }
            }
          } catch (galleryErr) {
            console.warn(`[ES-Square] ギャラリー画像取得失敗:`, galleryErr.message);
            await setStorageData({ debugLog: `[ES-Square] ギャラリー画像取得失敗: ${galleryErr.message}` });
          }

          if (d.image_urls?.length && !prop.image_urls) {
            prop.image_urls = d.image_urls;
            if (!prop.image_url && d.image_urls[0]) prop.image_url = d.image_urls[0];
          }
        }

        // ブラウザバックで検索結果ページに戻る
        await _goBackToEssquareSearchResults(tabId);

      } catch (err) {
        if (err.message === 'ESSQUARE_LOGIN_REQUIRED' || err.message === 'SEARCH_CANCELLED' || err.message === 'SLEEP_DETECTED') {
          throw err;
        }
        console.warn(`[ES-Square] 詳細処理エラー (${prop.building_name}):`, err.message);
        // エラー時も検索結果ページに戻る試行
        try {
          await _goBackToEssquareSearchResults(tabId);
        } catch (backErr) {
          console.warn(`[ES-Square] 検索結果への復帰失敗:`, backErr.message);
        }
      }

      // フィルタリング（詳細取得失敗時など、早期フィルタを通過しなかった場合の最終チェック）
      const rejectReason = getEssquareFilterRejectReason(prop, customer);
      if (rejectReason) {
        await setStorageData({ debugLog: `[ES-Square] ${customer.name}: ✗ スキップ: ${prop.building_name} ${prop.room_number || ''} - ${rejectReason}` });
        continue;
      }

      // property_data_json構築
      prop.property_data_json = JSON.stringify(buildEssquarePropertyDataJson(prop));

      submittedCount++;
      await setStorageData({ debugLog: `[ES-Square] ${customer.name}: ✓ 送信対象（${prop.building_name} ${prop.room_number || ''} ${prop.rent ? (prop.rent/10000)+'万' : ''}）` });

      // GAS送信（1物件ずつ）
      try {
        const submitResult = await submitProperties(customer.name, [prop]);
        if (submitResult?.success) {
          const { stats } = await getStorageData(['stats']);
          const currentStats = stats || { totalFound: 0, totalSubmitted: 0, errors: [], lastError: null };
          currentStats.totalFound++;
          currentStats.totalSubmitted += submitResult.added || 1;
          await setStorageData({ stats: currentStats });
        }
      } catch (err) {
        logError(`[ES-Square] ${customer.name}: ${prop.building_name} GAS送信失敗: ${err.message}`);
      }

      // Discord通知（1物件ずつ）
      try {
        await deliverProperty(customer.name, prop, customer, 'essquare');
      } catch (err) {
        logError(`[ES-Square] ${customer.name}: ${prop.building_name} Discord通知失敗: ${err.message}`);
      }

      // seenIdsに追加
      if (!seenIds[customer.name]) seenIds[customer.name] = [];
      seenIds[customer.name].push(prop.room_id);

      // 物件間のランダム遅延（人間的な間隔）
      const delayMs = 2000 + Math.random() * 2000;
      await csleep(delayMs);
    }

    // 次ページ判定（30件未満なら最終ページ）
    if (pageProps.length < 30) break;

    await csleep(1500 + Math.random() * 1500);
  }

    // 分割検索間のwait
    if (chunkIdx < jushoChunks.length - 1) await csleep(1500);
  } // end jushoChunks loop

  if (submittedCount > 0) {
    await setStorageData({ debugLog: `[ES-Square] ${customer.name}: ${submittedCount}件送信完了` });
  } else {
    await setStorageData({ debugLog: `[ES-Square] ${customer.name}: 新着なし` });
  }
}
