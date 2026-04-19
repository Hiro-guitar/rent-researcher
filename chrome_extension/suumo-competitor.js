/**
 * suumo-competitor.js
 * SUUMO巡回モード時、各送信対象物件のSUUMO競合掲載数を取得する。
 *
 * フロー:
 *   1. buildSuumoCompetitorSearchUrl(prop)
 *      → fw=住所+建物種別+面積+賃料 形式の検索URLを構築（4部 + フォールバック3部）
 *   2. _fetchWithTimeout で SUUMO検索結果ページを取得（host_permissions: suumo.jp）
 *   3. parseSuumoCompetitorCount で DOMParser→カード走査
 *      → rent/area が期待値と先頭一致するカードのみを物件名あり/なし × ハイライト有無で集計
 *   4. countSuumoCompetitors が統合関数として {withName, withoutName, withNameHighlighted, withoutNameHighlighted, total, url} を返す
 *
 * 失敗時は null を返却し、呼び元(suumo-patrol.js sendCollector.push)は competitor 情報なしで GAS 送信を続行する。
 */

(() => {
  'use strict';

  const SUUMO_COMP_BASE = 'https://suumo.jp/jj/chintai/ichiran/FR301FC011/?ar=030&bs=040&fw=';
  const SUUMO_COMP_FETCH_TIMEOUT_MS = 8000;
  // タイトルが「1K」「2LDK」「ワンルーム」のような間取り文字列だけのケース → 物件名なし扱い
  const SUUMO_COMP_LAYOUT_RE = /(\d{1,2}[dksl]+|ワンルーム)/i;

  // ── 値変換ヘルパー ─────────────────────────────────────────

  function _toSuumoRent(yenLike) {
    if (yenLike === undefined || yenLike === null || yenLike === '') return null;
    let n;
    if (typeof yenLike === 'number') {
      n = yenLike;
    } else {
      const s = String(yenLike).replace(/[,\s円]/g, '');
      // 「12.5万」のような表記が来た場合
      const manMatch = s.match(/^(\d+(?:\.\d+)?)万$/);
      if (manMatch) {
        n = parseFloat(manMatch[1]) * 10000;
      } else {
        n = parseFloat(s);
      }
    }
    if (!isFinite(n) || n <= 0) return null;
    const man = n / 10000;
    // 「12」「12.5」「12.25」 → 末尾0は parseFloat で自動除去
    return String(parseFloat(man.toFixed(2))) + '万';
  }

  function _toSuumoArea(areaLike) {
    if (areaLike === undefined || areaLike === null || areaLike === '') return null;
    const s = String(areaLike).replace(/[^\d.]/g, '');
    if (!s) return null;
    const n = parseFloat(s);
    if (!isFinite(n) || n <= 0) return null;
    return String(parseFloat(n.toFixed(2))) + 'm';
  }

  function _inferPropertyType(prop) {
    const s = prop && prop.structure ? String(prop.structure) : '';
    if (!s) return 'マンション';
    return /木造/.test(s) ? 'アパート' : 'マンション';
  }

  /**
   * 住所から SUUMO 検索用に「pref+city+town+chome」を切り出す。
   * 取れなければ prop.address をそのまま返す。
   */
  function _extractSearchAddr(prop) {
    if (!prop) return null;
    const raw = prop.address || ((prop.pref || '') + (prop.addr1 || '') + (prop.addr2 || '') + (prop.addr3 || ''));
    if (!raw) return null;
    let s = String(raw).trim();
    if (!s) return null;

    // 都道府県
    const prefMatch = s.match(/^(東京都|北海道|(?:京都|大阪)府|.{2,3}県)/);
    if (!prefMatch) return s; // 都道府県がない時はそのまま返す
    const pref = prefMatch[1];
    s = s.slice(pref.length);

    // 市区郡（政令市の区も拾う）
    const cityMatch = s.match(/^(.+?[市区郡])(.+?区)?/);
    if (!cityMatch) return pref + s;
    const city = cityMatch[1] + (cityMatch[2] || '');
    s = s.slice(city.length);

    // 残りから町名・丁目を分離（番地は捨てる）
    s = s.replace(/[０-９]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0));
    const townMatch = s.match(/^([^\d]+?)([\d])/);
    if (!townMatch) {
      // 数字が無い場合は残り全部を町名扱い
      return pref + city + s;
    }
    const town = townMatch[1];
    const rest = s.slice(town.length);

    // 丁目を抽出（"3丁目..." or "3-28-14"）
    // ※SUUMO検索では「4丁目」を付けると0件化する（実測確認済）。数字のみで連結する。
    //   例: 「東京都新宿区下落合4」←OK / 「東京都新宿区下落合4丁目」←NG
    let chome = '';
    const chomeKanjiMatch = rest.match(/^(\d+)丁目/);
    if (chomeKanjiMatch) {
      chome = chomeKanjiMatch[1];
    } else {
      const numMatch = rest.match(/^(\d+)/);
      if (numMatch) chome = numMatch[1];
    }

    return pref + city + town + chome;
  }

  // ── URL構築 ──────────────────────────────────────────────

  // SUUMO の fw は「+」連結形式が確実にヒット（実測: %20連結だと不安定なケースあり）。
  // 各コンポーネントを個別に encodeURIComponent → "+" でつなぐ。
  function _buildFw(parts) {
    return parts.filter(Boolean).map(encodeURIComponent).join('+');
  }

  function buildSuumoCompetitorSearchUrl(prop) {
    const rent = _toSuumoRent(prop && prop.rent);
    const area = _toSuumoArea(prop && (prop.area || prop.usageArea));
    const addr = _extractSearchAddr(prop);
    if (!rent || !area || !addr) return null;
    const btype = _inferPropertyType(prop);
    return {
      primaryUrl: SUUMO_COMP_BASE + _buildFw([addr, btype, area, rent]) + '&pc=100',
      fallbackUrl: SUUMO_COMP_BASE + _buildFw([addr, area, rent]) + '&pc=100',
      _expectedRent: rent,
      _expectedArea: area,
    };
  }

  // ── HTMLパース ──────────────────────────────────────────────

  function parseSuumoCompetitorCount(htmlText, expectedRent, expectedArea) {
    const result = { withName: 0, withoutName: 0, withNameHighlighted: 0, withoutNameHighlighted: 0, total: 0 };
    if (!htmlText || !expectedRent || !expectedArea) return result;
    let doc;
    try {
      doc = new DOMParser().parseFromString(htmlText, 'text/html');
    } catch (e) {
      return result;
    }
    const cards = doc.querySelectorAll('div.property.js-property.js-cassetLink');
    cards.forEach(card => {
      try {
        const rentEl = card.querySelector('.detailbox-property-point');
        const rentText = (rentEl && rentEl.textContent || '').trim().replace(/\s/g, '');
        // SUUMO表示は「12.5万円」、期待値は「12.5万」 → startsWith で対応
        if (!rentText.startsWith(expectedRent)) return;

        const cols = card.querySelectorAll('td.detailbox-property--col3 > div');
        const areaText = (cols && cols[1] ? cols[1].textContent : '').trim();
        // SUUMO表示は「25.18m²」、期待値は「25.18m」 → startsWith で対応
        if (!areaText.startsWith(expectedArea)) return;

        const titleEl = card.querySelector('h2.property_inner-title a, a.js-cassetLinkHref');
        const title = (titleEl && titleEl.textContent || '').trim();
        const isHighlighted = card.classList.contains('property--highlight');

        if (SUUMO_COMP_LAYOUT_RE.test(title)) {
          // タイトルが間取り文字 → 物件名なし扱い
          result.withoutName++;
          if (isHighlighted) result.withoutNameHighlighted++;
        } else {
          result.withName++;
          if (isHighlighted) result.withNameHighlighted++;
        }
      } catch (e) { /* カード単位のパース失敗は無視 */ }
    });
    result.total = result.withName + result.withoutName;
    return result;
  }

  // ── fetch ───────────────────────────────────────────────────

  async function _fetchWithTimeout(url, timeoutMs) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { signal: ctrl.signal, credentials: 'omit', redirect: 'follow' });
      return res;
    } finally {
      clearTimeout(t);
    }
  }

  async function _fetchAndCount(url, expectedRent, expectedArea) {
    let res;
    try {
      res = await _fetchWithTimeout(url, SUUMO_COMP_FETCH_TIMEOUT_MS);
    } catch (e) {
      return null;
    }
    if (res.status === 429 || res.status === 503) {
      await new Promise(r => setTimeout(r, 1500));
      try {
        res = await _fetchWithTimeout(url, SUUMO_COMP_FETCH_TIMEOUT_MS);
      } catch (e) {
        return null;
      }
    }
    if (!res.ok) return null;
    const html = await res.text();
    return parseSuumoCompetitorCount(html, expectedRent, expectedArea);
  }

  // ── 統合関数 ───────────────────────────────────────────────

  async function countSuumoCompetitors(prop) {
    try {
      const urls = buildSuumoCompetitorSearchUrl(prop);
      if (!urls) return null;
      const expectedRent = urls._expectedRent;
      const expectedArea = urls._expectedArea;

      let counts = await _fetchAndCount(urls.primaryUrl, expectedRent, expectedArea);
      let usedUrl = urls.primaryUrl;

      // 4部fwで0件 or null なら、3部fw（建物種別なし）にフォールバック
      if (!counts || counts.total === 0) {
        const fbCounts = await _fetchAndCount(urls.fallbackUrl, expectedRent, expectedArea);
        if (fbCounts && fbCounts.total > 0) {
          counts = fbCounts;
          usedUrl = urls.fallbackUrl;
        } else if (!counts && fbCounts) {
          // primaryがnull(失敗)、fallbackは0件 → 0件として扱う
          counts = fbCounts;
          usedUrl = urls.fallbackUrl;
        }
      }
      if (!counts) return null;

      return {
        withName: counts.withName,
        withoutName: counts.withoutName,
        withNameHighlighted: counts.withNameHighlighted,
        withoutNameHighlighted: counts.withoutNameHighlighted,
        total: counts.total,
        url: usedUrl,
      };
    } catch (e) {
      console.warn('[SUUMO競合] 取得失敗:', e && e.message);
      return null;
    }
  }

  // ── グローバルエクスポート（service worker / background scope） ──
  globalThis.buildSuumoCompetitorSearchUrl = buildSuumoCompetitorSearchUrl;
  globalThis.parseSuumoCompetitorCount = parseSuumoCompetitorCount;
  globalThis.countSuumoCompetitors = countSuumoCompetitors;
  // テスト/デバッグ用に内部ヘルパーも露出
  globalThis._suumoCompetitorInternals = {
    _toSuumoRent, _toSuumoArea, _inferPropertyType, _extractSearchAddr,
  };
})();
