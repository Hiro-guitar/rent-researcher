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
   * 住所から SUUMO 検索用の住所候補を優先順に返す。
   * 「町名+先頭数字」が SUUMO 上の丁目に一致する物件が多いが、
   * 町名に丁目がない場合（例: 片町1-4）は「町名+1」では 0件 になり、
   * 「町名のみ」でヒットするケースがある。逆に「上目黒3-4-10」は
   * 「上目黒3」で検索したい（「上目黒」だと広すぎる）。
   * → 複数候補を返して countSuumoCompetitors で順次試行する。
   *
   * 戻り値: ["町名+数字", "町名のみ"] のような配列（最大2件）
   */
  function _extractSearchAddrCandidates(prop) {
    if (!prop) return [];
    const raw = prop.address || ((prop.pref || '') + (prop.addr1 || '') + (prop.addr2 || '') + (prop.addr3 || ''));
    if (!raw) return [];
    let s = String(raw).trim();
    if (!s) return [];

    const prefMatch = s.match(/^(東京都|北海道|(?:京都|大阪)府|.{2,3}県)/);
    if (!prefMatch) return [s];
    const pref = prefMatch[1];
    s = s.slice(pref.length);

    const cityMatch = s.match(/^(.+?[市区郡])(.+?区)?/);
    if (!cityMatch) return [pref + s];
    const city = cityMatch[1] + (cityMatch[2] || '');
    s = s.slice(city.length);

    s = s.replace(/[０-９]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0));
    const townMatch = s.match(/^([^\d]+?)([\d])/);
    if (!townMatch) {
      return [pref + city + s];
    }
    const town = townMatch[1];
    const rest = s.slice(town.length);

    const townOnly = pref + city + town;

    // 「N丁目」明示 → 数字付きのみ採用（町名のみフォールバックは念のため付ける）
    const chomeKanjiMatch = rest.match(/^(\d+)丁目/);
    if (chomeKanjiMatch) {
      return [pref + city + town + chomeKanjiMatch[1], townOnly];
    }

    // 「N-N」「N-N-N」「N」など番地形式 → 「町名+先頭数字」と「町名のみ」の両方試す
    const numMatch = rest.match(/^(\d+)/);
    if (numMatch) {
      return [pref + city + town + numMatch[1], townOnly];
    }

    // 数字無し → 町名のみ
    return [townOnly];
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
    const addrCandidates = _extractSearchAddrCandidates(prop);
    if (!rent || !area || !addrCandidates.length) return null;
    const btype = _inferPropertyType(prop);
    // 各住所候補について primary(4部 building_type 込み)と fallback(3部) を作る
    const urls = [];
    for (const addr of addrCandidates) {
      urls.push(SUUMO_COMP_BASE + _buildFw([addr, btype, area, rent]) + '&pc=100');
    }
    // 最後に「町名のみ × 建物種別なし」も入れて広めに保険
    if (addrCandidates.length > 0) {
      urls.push(SUUMO_COMP_BASE + _buildFw([addrCandidates[addrCandidates.length - 1], area, rent]) + '&pc=100');
    }
    return {
      candidateUrls: urls,
      _expectedRent: rent,
      _expectedArea: area,
    };
  }

  // ── HTMLパース ──────────────────────────────────────────────

  function parseSuumoCompetitorCount(htmlText, expectedRent, expectedArea) {
    const result = { withName: 0, withoutName: 0, withNameHighlighted: 0, withoutNameHighlighted: 0, total: 0, _rawCards: 0, _rentMiss: 0, _areaMiss: 0 };
    if (!htmlText || !expectedRent || !expectedArea) return result;
    let doc;
    try {
      doc = new DOMParser().parseFromString(htmlText, 'text/html');
    } catch (e) {
      return result;
    }
    // Service Worker の DOMParser では複合クラスセレクタが効かないケースがあるため、
    // より単純な「js-property」単一クラスで取得する（他サイトで誤マッチするリスクは低い）
    let cards = doc.querySelectorAll('.js-property.js-cassetLink');
    if (cards.length === 0) cards = doc.querySelectorAll('.js-property');
    if (cards.length === 0) cards = doc.querySelectorAll('[class~="js-property"]');
    // 最終手段: 属性セレクタでクラスを直接指定
    if (cards.length === 0) {
      const all = doc.querySelectorAll('div');
      const filtered = [];
      for (const el of all) {
        const cn = el.className || '';
        if (typeof cn === 'string' && cn.indexOf('js-property') >= 0 && cn.indexOf('property') >= 0) {
          filtered.push(el);
        }
      }
      cards = filtered;
    }
    result._rawCards = cards.length;
    cards.forEach(card => {
      try {
        const rentEl = card.querySelector('.detailbox-property-point');
        const rentText = (rentEl && rentEl.textContent || '').trim().replace(/\s/g, '');
        // SUUMO表示は「12.5万円」、期待値は「12.5万」 → startsWith で対応
        if (!rentText.startsWith(expectedRent)) { result._rentMiss++; return; }

        const cols = card.querySelectorAll('td.detailbox-property--col3 > div');
        const areaText = (cols && cols[1] ? cols[1].textContent : '').trim();
        // SUUMO表示は「25.18m²」、期待値は「25.18m」 → startsWith で対応
        if (!areaText.startsWith(expectedArea)) { result._areaMiss++; return; }

        const titleEl = card.querySelector('h2.property_inner-title a, a.js-cassetLinkHref');
        const title = (titleEl && titleEl.textContent || '').trim();
        const cardCls = (card.className && typeof card.className === 'string') ? card.className : '';
        const isHighlighted = cardCls.indexOf('property--highlight') >= 0;

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
      console.warn('[SUUMO競合] fetch例外:', e && e.message, url.slice(0, 120));
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
    if (!res.ok) {
      console.warn('[SUUMO競合] fetch non-ok:', res.status, url.slice(0, 120));
      return null;
    }
    const html = await res.text();
    const counts = parseSuumoCompetitorCount(html, expectedRent, expectedArea);
    // 診断: HTMLサイズ、カード数が少ない場合はHTML冒頭も出す
    console.log('[SUUMO競合] fetch結果:', {
      url: url.slice(0, 150),
      status: res.status,
      htmlLen: html.length,
      rawCards: counts._rawCards,
      rentMiss: counts._rentMiss,
      areaMiss: counts._areaMiss,
      hit: counts.total,
      htmlHead: counts._rawCards === 0 ? html.slice(0, 500) : '(cards found, skipping html dump)',
    });
    return counts;
  }

  // ── 統合関数 ───────────────────────────────────────────────

  async function countSuumoCompetitors(prop) {
    try {
      const built = buildSuumoCompetitorSearchUrl(prop);
      if (!built) {
        console.warn('[SUUMO競合] URL構築失敗: addr/rent/area のいずれかが欠損', {
          address: prop && prop.address,
          rent: prop && prop.rent,
          area: prop && (prop.area || prop.usageArea),
        });
        return null;
      }
      const expectedRent = built._expectedRent;
      const expectedArea = built._expectedArea;
      const urls = built.candidateUrls;
      console.log('[SUUMO競合] 試行URLs:', { expectedRent, expectedArea, urls });

      let lastCounts = null;
      let lastUrl = urls[urls.length - 1] || null;
      for (const url of urls) {
        const counts = await _fetchAndCount(url, expectedRent, expectedArea);
        console.log('[SUUMO競合] ', url.slice(0, 200), '→', counts);
        if (counts && counts.total > 0) {
          // ヒットしたら採用
          return {
            withName: counts.withName,
            withoutName: counts.withoutName,
            withNameHighlighted: counts.withNameHighlighted,
            withoutNameHighlighted: counts.withoutNameHighlighted,
            total: counts.total,
            url: url,
          };
        }
        if (counts) { // 0件だが取得自体は成功
          lastCounts = counts;
          lastUrl = url;
        }
      }
      // 全候補で0件 → 最後の0件結果 + URLを返す（取得失敗のnullとは区別）
      if (lastCounts) {
        return {
          withName: 0, withoutName: 0,
          withNameHighlighted: 0, withoutNameHighlighted: 0,
          total: 0, url: lastUrl,
        };
      }
      // 全候補fetch失敗 → null
      return null;
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
    _toSuumoRent, _toSuumoArea, _inferPropertyType, _extractSearchAddrCandidates, _buildFw,
  };
})();
