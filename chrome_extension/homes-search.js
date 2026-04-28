/**
 * homes-search.js
 * LIFULL HOME'S (https://www.homes.co.jp/) から、入力された物件情報に
 * マッチする「同じ建物・同タイプ部屋」と「建物全体(archive含む)」の
 * 画像候補を取得する。
 *
 * メインAPI:
 *   globalThis.searchHomesImagesForProperty(input) → Promise<output>
 *
 * input:
 *   {
 *     prefecture:     "東京都",        // 必須
 *     city:           "新宿区",        // 必須
 *     address:        "大久保1丁目7-11", // 必須
 *     buildingName:   "ガルナ大久保",    // 任意 (表記揺れあり)
 *     builtYearMonth: "2016-01",        // 任意 ("YYYY-MM")
 *     totalFloors:    10,               // 任意
 *     layout:         "1K",             // 任意
 *     area:           25.5,             // 任意 (㎡)
 *     structure:      "RC"              // 任意
 *   }
 *
 * output:
 *   {
 *     ok: true,
 *     matched: {
 *       confidence: 'high' | 'medium' | 'low' | 'none',
 *       buildingDetailUrls: [],
 *       archiveBuildingIds: []
 *     },
 *     candidates: [
 *       {
 *         genre:        "外観",
 *         url:          "https://image1.homes.jp/smallimg/...",
 *         urlHires:     "https://image1.homes.jp/...&width=1200&height=900",
 *         source:       "rental" | "archive",
 *         matchType:    "same-room" | "same-building" | "archive",
 *         sourceLabel:  "賃貸物件 b-XXX 5階" 等
 *       }, ...
 *     ],
 *     errors: []
 *   }
 *
 * 制約:
 * - service worker では DOMParser が使えないため、HTMLは正規表現でパース
 * - homes.co.jp への fetch は host_permissions で許可される必要あり
 * - 連続アクセスは 1〜2秒/req に抑制
 */

const _HOMES_BASE = 'https://www.homes.co.jp';
const _HOMES_FETCH_DELAY_MS = 1500;
const _HOMES_MAX_BUILDING_CANDIDATES = 20;
const _HOMES_USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

/**
 * メインAPI: 物件情報からホームズの画像候補リストを取得
 */
async function searchHomesImagesForProperty(input) {
  const result = {
    ok: false,
    matched: { confidence: 'none', buildingDetailUrls: [], archiveBuildingIds: [], searchUrls: [] },
    candidates: [],
    errors: []
  };

  try {
    if (!input || !input.address) {
      result.errors.push('address が必須 (住所が取得できませんでした)');
      return result;
    }

    // 1. 賃貸検索: 市区+建物名 or 番地キーワードで候補一覧
    const search = await _findHomesRentalCandidates(input);
    result.matched.searchUrls = search.searchUrls || [];
    const candidates = search.urls || [];
    if (candidates.length === 0) {
      result.errors.push('賃貸検索の候補が見つからない');
    }

    // 2. 各候補の詳細を取得 → 住所+築年月+階建で同一建物判定
    const matchedBuildings = [];
    for (const candUrl of candidates.slice(0, _HOMES_MAX_BUILDING_CANDIDATES)) {
      await _sleep(_HOMES_FETCH_DELAY_MS);
      const detail = await _fetchHomesDetail(candUrl);
      if (!detail.ok) continue;
      const score = _matchBuildingScore(input, detail.meta);
      if (score >= 2) {
        matchedBuildings.push({ url: candUrl, detail, score });
      }
    }

    if (matchedBuildings.length === 0 && candidates.length > 0) {
      // フォールバック: 最初の候補を「low confidence」として扱う
      const first = candidates[0];
      const detail = await _fetchHomesDetail(first);
      if (detail.ok) {
        matchedBuildings.push({ url: first, detail, score: 1 });
      }
    }

    // 3. 同建物の各部屋から画像を集約
    const visitedRoomUrls = new Set();
    for (const mb of matchedBuildings) {
      result.matched.buildingDetailUrls.push(mb.url);

      // 確定物件本体の画像
      _appendImagesAsCandidates(result.candidates, mb.detail.images,
        _isSameType(input, mb.detail.meta) ? 'same-room' : 'same-building',
        'rental', `${mb.detail.meta.layout || ''} ${mb.detail.meta.floor || ''}階`,
        mb.url);

      // 同建物の他の部屋リンク
      for (const roomUrl of mb.detail.sameBuildingRoomUrls.slice(0, 10)) {
        if (visitedRoomUrls.has(roomUrl)) continue;
        visitedRoomUrls.add(roomUrl);
        await _sleep(_HOMES_FETCH_DELAY_MS);
        const roomDetail = await _fetchHomesDetail(roomUrl);
        if (!roomDetail.ok) continue;
        _appendImagesAsCandidates(result.candidates, roomDetail.images,
          _isSameType(input, roomDetail.meta) ? 'same-room' : 'same-building',
          'rental', `${roomDetail.meta.layout || ''} ${roomDetail.meta.floor || ''}階`,
          roomUrl);
      }
    }

    // 4. archive 側 (過去物件含む共用部・全体ギャラリー) を取得
    const archiveIds = await _findHomesArchiveBuildingIds(input);
    for (const aid of archiveIds.slice(0, 3)) {
      result.matched.archiveBuildingIds.push(aid);
      await _sleep(_HOMES_FETCH_DELAY_MS);
      const archiveImages = await _fetchHomesArchiveGalleryImages(aid);
      _appendImagesAsCandidates(result.candidates, archiveImages,
        'archive', 'archive', `archive b-${aid}`,
        `${_HOMES_BASE}/archive/b-${aid}/gallery/`);
    }

    // 5. 重複排除 (URLベース)
    const seen = new Set();
    result.candidates = result.candidates.filter(c => {
      const key = c.url.replace(/[?&]width=\d+|[?&]height=\d+/g, '');
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    // 6. confidence判定
    if (matchedBuildings.length > 0 && matchedBuildings[0].score >= 3) {
      result.matched.confidence = 'high';
    } else if (matchedBuildings.length > 0 && matchedBuildings[0].score >= 2) {
      result.matched.confidence = 'medium';
    } else if (result.candidates.length > 0) {
      result.matched.confidence = 'low';
    }

    result.ok = true;
    return result;
  } catch (err) {
    result.errors.push(`例外: ${err.message}`);
    return result;
  }
}

// ============================================================
// 賃貸検索: 候補URL一覧
// ============================================================

async function _findHomesRentalCandidates(input) {
  // 検索URLは form action="/chintai/list/" の cond[freeword] パラメータ式 (GET互換)
  // 推奨クエリ: 都道府県+市区+町名+番地 を1つの freeword に渡す
  const queries = [];

  // メイン: 住所まるごと (最も精度が高い)
  const fullAddr = `${input.prefecture || ''}${input.city || ''}${input.address || ''}`.trim();
  if (fullAddr) queries.push(fullAddr);

  // フォールバック1: 建物名のみ (市区を併記して精度補強)
  if (input.buildingName) {
    queries.push(`${input.city || ''} ${input.buildingName}`.trim());
  }

  const candidates = new Set();
  const searchUrls = [];
  for (let i = 0; i < queries.length; i++) {
    const q = queries[i];
    if (i > 0) await _sleep(_HOMES_FETCH_DELAY_MS);
    const url = `${_HOMES_BASE}/chintai/list/?cond%5Bfreeword%5D=${encodeURIComponent(q)}&cond%5Bfwtype%5D=1`;
    searchUrls.push({ query: q, url });
    console.log('[homes-search] searching:', q);
    const html = await _fetchText(url);
    if (!html) {
      console.warn('[homes-search] empty html for query:', q);
      continue;
    }
    const re = /\/chintai\/(b-\d{13}|room\/[a-f0-9]{32,})\//g;
    const before = candidates.size;
    let m;
    while ((m = re.exec(html)) !== null) {
      candidates.add(`${_HOMES_BASE}/chintai/${m[1]}/`);
      if (candidates.size >= 20) break;
    }
    console.log('[homes-search] query:', q, 'newly found:', candidates.size - before, 'html length:', html.length);
    if (candidates.size >= _HOMES_MAX_BUILDING_CANDIDATES) break;
  }
  return { urls: Array.from(candidates), searchUrls };
}

// ============================================================
// 物件詳細ページ取得・パース
// ============================================================

async function _fetchHomesDetail(detailUrl) {
  const html = await _fetchText(detailUrl);
  if (!html) return { ok: false, error: 'fetch failed' };

  const meta = _extractMetaFromHtml(html);
  const images = _extractImagesFromHtml(html);
  const sameBuildingRoomUrls = _extractSameBuildingRoomUrls(html);

  return { ok: true, meta, images, sameBuildingRoomUrls };
}

function _extractMetaFromHtml(html) {
  const meta = {};
  // tr > th + td パターン
  const trRe = /<tr[^>]*>[\s\S]*?<th[^>]*>([\s\S]*?)<\/th>[\s\S]*?<td[^>]*>([\s\S]*?)<\/td>[\s\S]*?<\/tr>/g;
  let m;
  while ((m = trRe.exec(html)) !== null) {
    const key = _stripTags(m[1]).trim();
    const val = _stripTags(m[2]).trim();
    if (key && val && !meta[key]) meta[key] = val;
  }
  // dt + dd パターン
  const dtRe = /<dt[^>]*>([\s\S]*?)<\/dt>\s*<dd[^>]*>([\s\S]*?)<\/dd>/g;
  while ((m = dtRe.exec(html)) !== null) {
    const key = _stripTags(m[1]).trim();
    const val = _stripTags(m[2]).trim();
    if (key && val && !meta[key]) meta[key] = val;
  }

  // 構造化値の抽出
  const out = {
    address: meta['所在地'] || '',
    builtYearMonth: _parseBuiltYearMonth(meta['築年月'] || ''),
    layout: _parseLayout(meta['間取り'] || ''),
    area: _parseArea(meta['専有面積'] || ''),
    structure: meta['建物構造'] || '',
    totalUnits: meta['総戸数'] || ''
  };
  const fl = _parseFloorInfo(meta['所在階/階数'] || meta['所在階'] || '');
  out.floor = fl.floor;
  out.totalFloors = fl.totalFloors;
  out._raw = meta;
  return out;
}

function _extractImagesFromHtml(html) {
  // HOME'Sは lazy load のため `data-src` / `data-original` / `src` のいずれかに
  // 画像URLが入る。region 限定だと正規表現の早期終了で漏れるため、HTML全体から
  // image[1-4].homes.jp / archive-image.homes.co.jp を含む <img> タグを抽出する。
  // ただし「同建物の他の部屋一覧」のサムネ (width<=200) は本物件の画像ではない
  // ノイズなので除外する (本体画像は通常 width=640 以上)。
  const imgs = [];
  const imgTagRe = /<img\b[^>]*>/g;
  let m;
  while ((m = imgTagRe.exec(html)) !== null) {
    const tag = m[0];
    let srcMatch = tag.match(/\bdata-src="([^"]+)"/)
      || tag.match(/\bdata-original="([^"]+)"/)
      || tag.match(/\bsrc="([^"]+)"/);
    if (!srcMatch) continue;
    const src = _decodeHtml(srcMatch[1]);
    if (!/^https:\/\/image\d?\.homes\.jp\//.test(src)
      && !/^https:\/\/archive-image\.homes\.co\.jp\//.test(src)) continue;

    // サムネサイズ (他の部屋一覧用) を除外: width=100 / 200 など小サイズ
    const wm = src.match(/[?&]width=(\d+)/);
    if (wm) {
      const w = parseInt(wm[1], 10);
      if (w > 0 && w <= 300) continue;
    }

    const altMatch = tag.match(/\balt="([^"]*)"/);
    const alt = altMatch ? _decodeHtml(altMatch[1]) : '';

    imgs.push({ genre: alt || 'その他', url: src });
  }
  const seen = new Set();
  return imgs.filter(i => {
    if (seen.has(i.url)) return false;
    seen.add(i.url);
    return true;
  });
}

function _extractSameBuildingRoomUrls(html) {
  const urls = new Set();
  const re = /\/chintai\/room\/([a-f0-9]{32,})\//g;
  let m;
  while ((m = re.exec(html)) !== null) {
    urls.add(`${_HOMES_BASE}/chintai/room/${m[1]}/`);
  }
  return Array.from(urls);
}

// ============================================================
// archive 側
// ============================================================

async function _findHomesArchiveBuildingIds(input) {
  // archive側はフリーワード検索が存在せず、ドリルダウンのみ。
  // 確実に動作させるには /archive/address/{pref-slug}/{city-slug}/ の
  // 英語スラグマップが必要。当面は確定済みの賃貸物件詳細ページから
  // 建物名リンクで archive ID を発見できるケースのみ対応する。
  // この関数のフォールバック実装として、賃貸詳細HTML中の archive リンクを
  // 利用する処理を _fetchHomesDetail 側で行うのが望ましい。
  return [];
}

async function _fetchHomesArchiveGalleryImages(archiveBuildingId) {
  const url = `${_HOMES_BASE}/archive/b-${archiveBuildingId}/gallery/`;
  const html = await _fetchText(url);
  if (!html) return [];

  const imgs = [];
  // archive画像URLパターン: archive-image.homes.co.jp/v2/resize/{gid}/{hash}.jpg?width=...
  const re = /<img[^>]*\bsrc="(https:\/\/archive-image\.homes\.co\.jp\/v2\/resize\/[^"]+)"[^>]*(?:\balt="([^"]*)")?/g;
  const re2 = /<img[^>]*\balt="([^"]*)"[^>]*\bsrc="(https:\/\/archive-image\.homes\.co\.jp\/v2\/resize\/[^"]+)"/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    imgs.push({ genre: m[2] || 'その他', url: _decodeHtml(m[1]) });
  }
  while ((m = re2.exec(html)) !== null) {
    imgs.push({ genre: m[1] || 'その他', url: _decodeHtml(m[2]) });
  }
  // h2/h3 直前のジャンル見出し対応 (簡易: alt が空の場合は前後のh2/h3テキストでジャンル推定)
  // → MVPでは alt が無いものは「その他」扱い
  const seen = new Set();
  return imgs.filter(i => {
    if (seen.has(i.url)) return false;
    seen.add(i.url);
    return true;
  });
}

// ============================================================
// マッチング
// ============================================================

function _matchBuildingScore(input, detailMeta) {
  let score = 0;
  const inAddr = _normalizeAddress(input.address);
  const dtAddr = _normalizeAddress(detailMeta.address);
  if (inAddr && dtAddr) {
    if (inAddr === dtAddr) score += 2;
    else if (dtAddr.indexOf(inAddr) >= 0 || inAddr.indexOf(dtAddr) >= 0) score += 2;
    else if (_addressMatchPartial(input.address, detailMeta.address)) score += 1;
  }

  if (input.builtYearMonth && detailMeta.builtYearMonth
    && input.builtYearMonth === detailMeta.builtYearMonth) score += 1;

  if (input.totalFloors && detailMeta.totalFloors
    && Number(input.totalFloors) === Number(detailMeta.totalFloors)) score += 1;

  console.log('[homes-search] matchScore=', score,
    'input=', inAddr, 'detail=', dtAddr,
    'detailUrl=', (detailMeta._raw && detailMeta._raw['ID']) || '');
  return score;
}

function _isSameType(input, detailMeta) {
  // 同タイプ判定: 間取り一致 AND 面積完全一致(小数2桁単位)
  if (!input.layout || !detailMeta.layout) {
    console.log('[homes-search] sameType=false (layout欠損)',
      'input.layout=', input.layout, 'detail.layout=', detailMeta.layout);
    return false;
  }
  const inLay = _normalizeLayout(input.layout);
  const dtLay = _normalizeLayout(detailMeta.layout);
  if (inLay !== dtLay) {
    console.log('[homes-search] sameType=false (layout不一致)',
      'input=', inLay, 'detail=', dtLay);
    return false;
  }
  if (!input.area || !detailMeta.area) {
    console.log('[homes-search] sameType=false (area欠損)',
      'input.area=', input.area, 'detail.area=', detailMeta.area);
    return false;
  }
  const inArea = Number(input.area).toFixed(2);
  const dtArea = Number(detailMeta.area).toFixed(2);
  if (inArea !== dtArea) {
    console.log('[homes-search] sameType=false (area不一致)',
      'input=', inArea, 'detail=', dtArea);
    return false;
  }
  console.log('[homes-search] sameType=true', inLay, inArea + '㎡');
  return true;
}

// ============================================================
// 文字列正規化
// ============================================================

function _normalizeAddress(addr) {
  if (!addr) return '';
  return addr
    .replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .replace(/丁目/g, '-')
    .replace(/[‐－―ー−]/g, '-')
    // HOME'S のメタ表示由来のノイズを除去
    .replace(/地図を見る|地図表示|マップ|map/gi, '')
    .replace(/\([^)]*\)/g, '')   // 括弧書き
    .replace(/[\s 　]+/g, '')
    .replace(/番地$|番$|号$/g, '')
    .toLowerCase();
}

function _addressMatchPartial(a, b) {
  if (!a || !b) return false;
  const na = _normalizeAddress(a);
  const nb = _normalizeAddress(b);
  // 番地最後の数字を除いて一致するか
  return na.split('-').slice(0, -1).join('-') === nb.split('-').slice(0, -1).join('-')
    && na.split('-').slice(0, -1).length > 0;
}

function _normalizeLayout(layout) {
  if (!layout) return '';
  return layout.replace(/\s+/g, '').toUpperCase();
}

function _normalizeForSearch(s) {
  return (s || '').replace(/\s+/g, '').toLowerCase();
}

function _parseBuiltYearMonth(text) {
  if (!text) return null;
  const m = text.match(/(\d{4})\s*年\s*(\d{1,2})\s*月/);
  if (!m) return null;
  return `${m[1]}-${String(m[2]).padStart(2, '0')}`;
}

function _parseLayout(text) {
  if (!text) return '';
  // "3LDK ( リビング..." → "3LDK"
  const m = text.match(/^(\d?\s*[SLDKR]+)/i);
  return m ? m[1].replace(/\s+/g, '').toUpperCase() : text.trim();
}

function _parseArea(text) {
  if (!text) return null;
  const m = text.match(/([\d.]+)\s*(?:㎡|m2|平米)/);
  return m ? parseFloat(m[1]) : null;
}

function _parseFloorInfo(text) {
  if (!text) return { floor: null, totalFloors: null };
  // "5階/10階建" or "5階" or "10階建"
  const m = text.match(/(\d+)\s*階\s*\/\s*(\d+)\s*階建/);
  if (m) return { floor: parseInt(m[1], 10), totalFloors: parseInt(m[2], 10) };
  const m2 = text.match(/(\d+)\s*階建/);
  const m3 = text.match(/(\d+)\s*階/);
  return {
    floor: m3 ? parseInt(m3[1], 10) : null,
    totalFloors: m2 ? parseInt(m2[1], 10) : null
  };
}

function _stripTags(html) {
  return (html || '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
}

function _decodeHtml(s) {
  return (s || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)));
}

function _escapeRegExp(s) {
  return (s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ============================================================
// 共通ヘルパー
// ============================================================

async function _fetchText(url) {
  try {
    // User-Agent は Chrome 拡張の fetch では forbidden header で無視されるため設定しない
    const resp = await fetch(url, {
      headers: { 'Accept-Language': 'ja-JP,ja;q=0.9' },
      redirect: 'follow'
    });
    if (!resp.ok) {
      console.warn('[homes-search] fetch failed:', resp.status, resp.url || url);
      return null;
    }
    return await resp.text();
  } catch (err) {
    console.warn('[homes-search] fetch exception:', err.message, url);
    return null;
  }
}

function _sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// 物件画像として有用でないジャンル (不動産会社のスタッフ・店舗写真、周辺地図等)
const _EXCLUDED_GENRES = new Set([
  'スタッフ', 'スタッフ写真', 'スタッフ紹介',
  '店内の様子', '店舗の外観', '店舗', '店内',
  '会社', '会社外観', '会社案内',
  '周辺', '周辺環境', '周辺写真', '地図'
]);

function _appendImagesAsCandidates(candidates, images, matchType, source, sourceLabel, sourceUrl) {
  for (const img of images) {
    const genre = img.genre || 'その他';
    if (_EXCLUDED_GENRES.has(genre)) continue;
    if (genre === '間取り') {
      console.log('[homes-search] 間取り画像', { matchType, sourceUrl, imgUrl: img.url });
    }
    candidates.push({
      genre,
      url: img.url,
      urlHires: _toHiresUrl(img.url),
      source,
      matchType,
      sourceLabel,
      sourceUrl: sourceUrl || ''
    });
  }
}

function _toHiresUrl(url) {
  if (!url) return url;
  return url
    .replace(/([?&])width=\d+/, '$1width=1200')
    .replace(/([?&])height=\d+/, '$1height=900');
}

// グローバル登録
globalThis.searchHomesImagesForProperty = searchHomesImagesForProperty;
