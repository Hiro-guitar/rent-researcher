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
const _HOMES_MAX_BUILDING_CANDIDATES = 50;
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

    // 3. 各 matched 物件から画像を集約
    // (検索結果ページに同建物の物件が並んでいる前提なので、sameBuildingRoomUrls
    //  をたどる処理は撤廃 — 重複処理を避け、処理時間を短縮)
    for (const mb of matchedBuildings) {
      result.matched.buildingDetailUrls.push(mb.url);
      _appendImagesAsCandidates(result.candidates, mb.detail.images,
        _isSameType(input, mb.detail.meta) ? 'same-room' : 'same-building',
        'rental', `${mb.detail.meta.layout || ''} ${mb.detail.meta.floor || ''}階`,
        mb.url);
    }

    // 4. archive 側 (過去物件) から「同タイプの部屋」のみ画像を取得
    //
    //    archive にも /archive/b-{建物}/u-{部屋}/ で部屋詳細ページが存在し、
    //    建物ページに各部屋カード (階/面積/間取り/部屋URL) がリスト化されている。
    //    つまり間取り+面積で同タイプ判定が可能 = 賃貸検索 same-room と同様の精度。
    //
    //    archive 建物 ID の取得経路:
    //    (a) 賃貸詳細HTML中の /archive/b-{id}/ 直リンク
    //        (= 一番確実。建物名検索なし、追加リクエストなし)
    //    (b) なければ /archive/list/search/?keyword=... でキーワード検索
    //        (= 賃貸検索でヒットしない or 詳細に archive リンクが無い場合)
    const archiveIdSet = new Set();
    for (const mb of matchedBuildings) {
      if (mb.detail && mb.detail.archiveBuildingId) {
        archiveIdSet.add(mb.detail.archiveBuildingId);
      }
    }
    if (archiveIdSet.size === 0) {
      const fromSearch = await _findHomesArchiveBuildingIds(input);
      for (const id of fromSearch.ids) archiveIdSet.add(id);
      // archive 検索URL は内部追跡のみ。表示は archive 建物URL に集約 (下記)
    }
    const archiveIds = Array.from(archiveIdSet);
    for (const aid of archiveIds.slice(0, 3)) {
      result.matched.archiveBuildingIds.push(aid);
      // archive 建物URL を表示候補リンクに追加
      result.matched.searchUrls.push({
        query: `b-${aid}`,
        url: `${_HOMES_BASE}/archive/b-${aid}/`,
        label: 'archive建物'
      });
      await _sleep(_HOMES_FETCH_DELAY_MS);
      // (1) 建物ページから部屋一覧取得
      const rooms = await _fetchHomesArchiveBuildingRooms(aid);
      // (2) 同タイプ (間取り完全一致 + 面積完全一致小数2桁) の部屋のみ
      const sameTypeRooms = rooms.filter(r => _isSameType(input, { layout: r.layout, area: r.area }));
      console.log('[homes-search] archive same-type rooms:', aid, 'all=', rooms.length, 'same=', sameTypeRooms.length);
      // (3) 各部屋詳細ページから画像取得 (最大3部屋まで)
      //     room.url は /archive/b-{B}/u-{U}/ で各画像の取得元URLとして candidates の
      //     sourceUrl に入る。お客様承認ページで画像ごとに「🔗 取得元」リンクとして表示。
      for (const room of sameTypeRooms.slice(0, 3)) {
        await _sleep(_HOMES_FETCH_DELAY_MS);
        const imgs = await _fetchHomesArchiveRoomImages(room.url);
        _appendImagesAsCandidates(result.candidates, imgs,
          'archive', 'archive', `archive ${room.layout || ''} ${room.area || ''}m²`,
          room.url);
      }
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
    // 検索1で1件以上取れたら検索2 (建物名フォールバック) はスキップ
    if (i > 0) {
      if (candidates.size > 0) break;
      await _sleep(_HOMES_FETCH_DELAY_MS);
    }
    const url = `${_HOMES_BASE}/chintai/list/?cond%5Bfreeword%5D=${encodeURIComponent(q)}&cond%5Bfwtype%5D=1`;
    searchUrls.push({ query: q, url, label: '賃貸検索' });
    console.log('[homes-search] searching:', q);
    const html = await _fetchText(url);
    if (!html) {
      console.warn('[homes-search] empty html for query:', q);
      continue;
    }

    // Step 1: 初期HTMLから物件URLを抽出
    const re = /\/chintai\/(b-\d{13}|room\/[a-f0-9]{32,64})\//g;
    const before = candidates.size;
    let m;
    while ((m = re.exec(html)) !== null) {
      candidates.add(`${_HOMES_BASE}/chintai/${m[1]}/`);
      if (candidates.size >= 50) break;
    }
    console.log('[homes-search] query:', q, 'newly found:', candidates.size - before, 'html length:', html.length);

    // Step 2: 棟内に「もっと見る」(prg-roomDisplay) ボタンがあれば AJAX で残りを取得
    // HOME'Sは初期HTMLでは棟内最大15件にトリミングしているため
    try {
      const extras = await _fetchHomesBuildingMoreRooms(html, q);
      let added = 0;
      for (const u of extras) {
        if (!candidates.has(u)) {
          candidates.add(u);
          added++;
        }
        if (candidates.size >= 50) break;
      }
      if (added > 0) console.log('[homes-search] AJAX more rooms added:', added);
    } catch (e) {
      console.warn('[homes-search] AJAX more rooms 失敗:', e.message);
    }

    if (candidates.size >= _HOMES_MAX_BUILDING_CANDIDATES) break;
  }
  return { urls: Array.from(candidates), searchUrls };
}

/**
 * 検索結果HTMLから「もっと見る」が必要な棟を検出して AJAX で残り部屋URLを取得する
 *
 * 仕組み:
 * - 検索結果HTMLには棟ごとに button.prg-roomDisplay 「N件を表示する（全M件）」がある
 * - N < M の棟があれば、POST /_ajax/list/building/more/ で残りを取得
 * - ペイロードには cond[freeword]/cond[fwtype]/cond[tykey] と not_kykey[] (既表示分) が必要
 */
async function _fetchHomesBuildingMoreRooms(html, freeword) {
  const extras = [];

  // 棟ブロックを大まかに切り出す: `prg-roomDisplay` の存在で判定
  // 各棟内にある data-tykey と data-kykey を抽出するため、
  // 棟ブロック単位で HTML を分割するのは難しいので、まず全 tykey を取得し
  // 各 tykey 周辺の data-kykey と「全N件」を関連付ける。
  const tykeyRe = /\bdata-tykey="([^"]+)"/g;
  const tykeys = [];
  let tk;
  while ((tk = tykeyRe.exec(html)) !== null) {
    if (!tykeys.includes(tk[1])) tykeys.push(tk[1]);
  }
  if (tykeys.length === 0) return extras;

  // 「全N件」テキストを持つ棟があるか確認 (なければ全件初期HTMLに含まれている)
  // ボタンクラス: prg-roomDisplay
  const moreBtnRe = /class="[^"]*prg-roomDisplay[^"]*"[\s\S]{0,500}?全\s*(\d+)\s*件/g;
  const totalsByOrder = [];
  let mb;
  while ((mb = moreBtnRe.exec(html)) !== null) {
    totalsByOrder.push(parseInt(mb[1], 10));
  }
  // 棟順と totalsByOrder の対応は不確実なので、各棟ごとに POST を試みる
  // (既に取得済みのkykeyを除外するので、不要なら空応答)

  // 各棟の data-kykey 一覧を抽出 (棟ブロックを単純化: 全 data-kykey を取得)
  // HOME'Sの実装上、検索結果HTML全体に並ぶ data-kykey はその検索の表示部屋分
  const kykeyRe = /\bdata-kykey="([^"]+)"/g;
  const allKykeys = [];
  let kk;
  while ((kk = kykeyRe.exec(html)) !== null) {
    if (!allKykeys.includes(kk[1])) allKykeys.push(kk[1]);
  }

  for (let ti = 0; ti < tykeys.length; ti++) {
    const tykey = tykeys[ti];
    const total = totalsByOrder[ti];
    // 全件表示済みなら追加リクエスト不要
    if (total !== undefined && allKykeys.length >= total) continue;

    await _sleep(_HOMES_FETCH_DELAY_MS);
    const body = new URLSearchParams();
    body.set('cond[freeword]', freeword);
    body.set('cond[fwtype]', '1');
    body.set('cond[sortby]', 'recommend');
    body.set('cond[precond]', '3000');
    body.set('cond[mbg][3001]', '3001');
    body.set('cond[mbg][3002]', '3002');
    body.set('cond[mbg][3003]', '3003');
    body.set('cond[monthmoneyroom]', '0');
    body.set('cond[monthmoneyroomh]', '0');
    body.set('cond[housearea]', '0');
    body.set('cond[houseareah]', '0');
    body.set('cond[walkminutesh]', '0');
    body.set('cond[houseageh]', '0');
    body.set('cond[newdate]', '0');
    body.set('cond[exfreeword]', '');
    body.set('cond[tykey]', tykey);
    for (let i = 0; i < allKykeys.length; i++) {
      body.append('not_kykey[' + i + ']', allKykeys[i]);
    }

    try {
      const resp = await fetch(`${_HOMES_BASE}/_ajax/list/building/more/`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'X-Requested-With': 'XMLHttpRequest',
          'Accept-Language': 'ja-JP,ja;q=0.9'
        },
        body: body.toString(),
        redirect: 'follow'
      });
      if (!resp.ok) {
        console.warn('[homes-search] AJAX more rooms HTTP', resp.status);
        continue;
      }
      const json = await resp.json().catch(() => null);
      if (!json || !json.list) continue;
      const re2 = /\/chintai\/(room\/[a-f0-9]{32,64})\//g;
      let mm;
      while ((mm = re2.exec(json.list)) !== null) {
        extras.push(`${_HOMES_BASE}/chintai/${mm[1]}/`);
      }
    } catch (e) {
      console.warn('[homes-search] AJAX more rooms exception:', e.message);
    }
  }
  return extras;
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

  // 賃貸詳細HTML中に含まれる /archive/b-{id}/ への直リンクを抽出。
  // これがあれば住所/建物名で別途 archive 検索しなくても archive 画像を取れる。
  const archiveMatch = html.match(/\/archive\/b-(\d+)\//);
  const archiveBuildingId = archiveMatch ? archiveMatch[1] : null;

  return { ok: true, meta, images, sameBuildingRoomUrls, archiveBuildingId };
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
  // /archive/list/search/?keyword=<クエリ> に対するキーワード検索。
  // 「物件名・住所などを入力してください」と書かれた archive 専用の検索口。
  // 1. buildingName で検索 (最も精度高い、ほぼ1件で確定)
  // 2. 0件なら住所(prefecture+city+address) で検索
  const queries = [];
  if (input.buildingName) queries.push(input.buildingName);
  const fullAddr = `${input.prefecture || ''}${input.city || ''}${input.address || ''}`.trim();
  if (fullAddr) queries.push(fullAddr);
  if (queries.length === 0) return [];

  const ids = [];
  const seen = new Set();
  for (let i = 0; i < queries.length; i++) {
    const q = queries[i];
    if (i > 0) {
      // 前のクエリで取れていたら追加検索しない
      if (ids.length > 0) break;
      await _sleep(_HOMES_FETCH_DELAY_MS);
    }
    const url = `${_HOMES_BASE}/archive/list/search/?keyword=${encodeURIComponent(q)}`;
    // searchUrls は内部追跡のみ。お客様承認ページには archive 建物URLを表示する方針
    // (検索URLは複数候補リストになるため、建物確定済の場合は不要)。
    searchUrls.push({ query: q, url, label: 'archive検索' });
    console.log('[homes-search] archive search:', q);
    const html = await _fetchText(url);
    if (!html) {
      console.warn('[homes-search] archive empty html for query:', q);
      continue;
    }
    // /archive/b-{数字}/ を全件抽出
    const re = /\/archive\/b-(\d+)\//g;
    let m;
    while ((m = re.exec(html)) !== null) {
      const id = m[1];
      if (seen.has(id)) continue;
      seen.add(id);
      ids.push(id);
      if (ids.length >= 5) break;
    }
    console.log('[homes-search] archive search:', q, 'found:', ids.length);
  }
  return { ids, searchUrls };
}

/**
 * archive 建物ページから部屋カード一覧を抽出する。
 * 各部屋カードは <a class="block h-full" href="/archive/b-{B}/u-{U}/"> で
 * 1部屋分のリンク + サムネ + 階/面積/間取り の <ul><li>...</li></ul> を持つ。
 *
 * 戻り値: [{ url, layout, area, floor, thumbnail }]
 */
async function _fetchHomesArchiveBuildingRooms(archiveBuildingId) {
  const buildingUrl = `${_HOMES_BASE}/archive/b-${archiveBuildingId}/`;
  const html = await _fetchText(buildingUrl);
  if (!html) return [];

  const rooms = [];
  // <a ... href="/archive/b-{B}/u-{U}/" ...> ... <ul>...</ul> ... </a>
  const aRe = /<a[^>]+href="(\/archive\/b-\d+\/u-\d+\/)"[\s\S]*?<\/a>/g;
  let am;
  while ((am = aRe.exec(html)) !== null) {
    const block = am[0];
    const path = am[1];
    // <ul>...</ul> 内の <li> を抽出
    const ulMatch = block.match(/<ul[^>]*>([\s\S]*?)<\/ul>/);
    if (!ulMatch) continue;
    const liRe = /<li[^>]*>([\s\S]*?)<\/li>/g;
    const items = [];
    let lm;
    while ((lm = liRe.exec(ulMatch[1])) !== null) {
      // タグ除去 + trim
      const txt = lm[1].replace(/<[^>]+>/g, '').replace(/\s+/g, '').trim();
      if (txt) items.push(txt);
    }
    let floor = '', area = null, layout = '';
    for (const it of items) {
      // 階: "2階" "1階" など
      if (/^\d+階$/.test(it)) floor = it;
      // 面積: "41.77m²" "33m²" "33.36㎡" など
      else if (/\d+(?:\.\d+)?\s*(?:m²|㎡|m2)/i.test(it)) {
        const m = it.match(/(\d+(?:\.\d+)?)/);
        if (m) area = parseFloat(m[1]);
      }
      // 間取り: "1LDK" "1DK" "1K" "ワンルーム" など
      else if (/[A-Z]/.test(it) || /ワンルーム/.test(it)) layout = it;
    }
    // サムネ: a 内の最初の <img>
    const imgMatch = block.match(/<img[^>]*\bsrc="(https:\/\/archive-image\.homes\.co\.jp\/v2\/resize\/[^"]+)"/);
    const thumbnail = imgMatch ? _decodeHtml(imgMatch[1]) : null;
    rooms.push({
      url: `${_HOMES_BASE}${path}`,
      layout,
      area,
      floor,
      thumbnail
    });
  }
  console.log('[homes-search] archive building rooms:', archiveBuildingId, 'count=', rooms.length);
  return rooms;
}

/**
 * archive 部屋詳細ページから画像URL一覧を抽出する。
 * 1部屋あたり通常 10〜30枚 の画像 (間取り/リビング/キッチン/浴室/...) が取れる。
 *
 * archive 部屋詳細ページの構造:
 *   <li>
 *     <img src=".../resize/{id}/{hash}.jpg" alt="1 / 21">
 *     間取り |
 *   </li>
 * alt 属性は "1 / 21" のような連番なので使わず、親 <li> のテキストから
 * ジャンル名 (「間取り」「キッチン」「浴室」等) を抽出する。
 */
async function _fetchHomesArchiveRoomImages(roomUrl) {
  const html = await _fetchText(roomUrl);
  if (!html) return [];

  const imgs = [];
  const seen = new Set();
  // (1) <li> ... <img> ... ジャンル名 ... </li> パターン
  const liRe = /<li[^>]*>([\s\S]*?)<\/li>/g;
  let m;
  while ((m = liRe.exec(html)) !== null) {
    const liInner = m[1];
    const imgMatch = liInner.match(/<img[^>]*\bsrc="(https:\/\/archive-image\.homes\.co\.jp\/v2\/resize\/[^"]+)"/);
    if (!imgMatch) continue;
    const url = _decodeHtml(imgMatch[1]);
    if (seen.has(url)) continue;
    seen.add(url);
    // <img> 等のタグを除去した残りテキスト → ジャンル名候補
    const txt = liInner.replace(/<[^>]+>/g, ' ')
      .replace(/\|/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    const genre = txt || 'その他';
    imgs.push({ url, genre });
  }
  // (2) <li> 構造に該当しない画像も拾うフォールバック
  const fallbackRe = /<img[^>]*\bsrc="(https:\/\/archive-image\.homes\.co\.jp\/v2\/resize\/[^"]+)"[^>]*>/g;
  while ((m = fallbackRe.exec(html)) !== null) {
    const url = _decodeHtml(m[1]);
    if (seen.has(url)) continue;
    seen.add(url);
    imgs.push({ url, genre: 'その他' });
  }
  return imgs;
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
