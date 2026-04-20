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
    const townOnly = addrCandidates[addrCandidates.length - 1];

    // 検索URLは全て「建物名なし」版。
    // 理由: 建物名で絞るとマンション名非公開の競合物件が漏れる。
    //       URLを開いた時に関係ない物件が多くても、「賃料+面積完全一致」の物件が
    //       一目でわかるよう集計はDiscord通知メッセージに出しているので実害は小さい。
    const urls = [];
    for (const addr of addrCandidates) {
      urls.push(SUUMO_COMP_BASE + _buildFw([addr, btype, area, rent]) + '&pc=100');
    }
    // 最終保険: 町名のみ × 建物種別なし
    urls.push(SUUMO_COMP_BASE + _buildFw([townOnly, area, rent]) + '&pc=100');

    return {
      candidateUrls: urls,
      _expectedRent: rent,
      _expectedArea: area,
    };
  }

  // ── HTMLパース ──────────────────────────────────────────────

  function parseSuumoCompetitorCount(htmlText, expectedRent, expectedArea) {
    const result = { withName: 0, withoutName: 0, withNameHighlighted: 0, withoutNameHighlighted: 0, total: 0, _rawCards: 0, _rentMiss: 0, _areaMiss: 0, _parseMode: '' };
    if (!htmlText || !expectedRent || !expectedArea) return result;

    // 診断: HTML文字列中の 'js-property' 出現回数（DOMParser通さずマーカー検出）
    result._jsPropertyStringCount = (htmlText.match(/js-property/g) || []).length;

    // Service Worker の DOMParser は大容量HTMLで unreliable のため、
    // 最初から正規表現ベースで物件カード区間を切り出してパースする。
    // HTMLの各物件カードは <div class="property[...]js-property[...]js-cassetLink"> で始まり、
    // 次の同パターン or </div>の深さ調整で終わる。ここでは lookahead で次カード開始or末尾まで切る。
    const cardRegex = /<div\s+class="(property[^"]*js-property[^"]*js-cassetLink[^"]*|property[^"]*js-cassetLink[^"]*js-property[^"]*)"[^>]*>([\s\S]*?)(?=<div\s+class="property[^"]*js-property|<\/div>\s*<\/div>\s*<script|<!--\s*\/\/ \/property_group|<div class="paginate_wrapper">|$)/g;
    const cardMatches = htmlText.match(cardRegex) || [];
    result._rawCards = cardMatches.length;
    result._parseMode = 'regex';

    for (const cardHtml of cardMatches) {
      try {
        // rent: <div class="detailbox-property-point">22.9万円</div> 的な
        const rentMatch = cardHtml.match(/class="[^"]*detailbox-property-point[^"]*"[^>]*>([^<]+)</);
        const rentText = rentMatch ? rentMatch[1].trim().replace(/\s/g, '') : '';
        if (!rentText.startsWith(expectedRent)) { result._rentMiss++; continue; }

        // area: td.detailbox-property--col3 の中の div の2つ目が面積
        //   <td class="detailbox-property--col3">
        //     <div>2LDK</div>
        //     <div>46.32m<sup>2</sup></div>  ← 面積は sup タグで "2" を上付き表示
        //     <div>-</div>                    ← 向き
        //   </td>
        // 旧正規表現 /<div[^>]*>([^<]*)<\/div>/g は [^<]* が <sup> で止まるため、
        // sup を含む div がマッチせず面積行が取れない。非貪欲 [\s\S]*? で内部タグ毎取り、
        // 後から <...> タグを文字列除去して純テキストを得る。
        const col3Match = cardHtml.match(/class="[^"]*detailbox-property--col3[^"]*"[^>]*>([\s\S]*?)<\/td>/);
        let areaText = '';
        if (col3Match) {
          const divContents = [];
          const divRe = /<div[^>]*>([\s\S]*?)<\/div>/g;
          let dm;
          while ((dm = divRe.exec(col3Match[1])) !== null) {
            divContents.push(dm[1].replace(/<[^>]+>/g, '').trim());
          }
          if (divContents.length >= 2) areaText = divContents[1];
        }
        if (!areaText.startsWith(expectedArea)) { result._areaMiss++; continue; }

        // title: h2.property_inner-title 内のaタグ / a.js-cassetLinkHref
        let titleMatch = cardHtml.match(/class="[^"]*property_inner-title[^"]*"[^>]*>[\s\S]*?<a[^>]*>([^<]+)</);
        if (!titleMatch) titleMatch = cardHtml.match(/class="[^"]*js-cassetLinkHref[^"]*"[^>]*>([^<]+)</);
        const title = titleMatch ? titleMatch[1].trim() : '';

        // highlight判定: カード開始タグに property--highlight が含まれるか
        const highlightMatch = cardHtml.match(/^<div\s+class="([^"]+)"/);
        const isHighlighted = highlightMatch ? highlightMatch[1].indexOf('property--highlight') >= 0 : false;

        if (SUUMO_COMP_LAYOUT_RE.test(title)) {
          result.withoutName++;
          if (isHighlighted) result.withoutNameHighlighted++;
        } else {
          result.withName++;
          if (isHighlighted) result.withNameHighlighted++;
        }
      } catch (e) { /* 1枚のパース失敗は無視 */ }
    }
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
          return {
            withName: counts.withName,
            withoutName: counts.withoutName,
            withNameHighlighted: counts.withNameHighlighted,
            withoutNameHighlighted: counts.withoutNameHighlighted,
            total: counts.total,
            url: url,
          };
        }
        if (counts) {
          lastCounts = counts;
          lastUrl = url;
        }
      }
      if (lastCounts) {
        return {
          withName: 0, withoutName: 0,
          withNameHighlighted: 0, withoutNameHighlighted: 0,
          total: 0, url: lastUrl,
        };
      }
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
