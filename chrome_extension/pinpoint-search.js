// pinpoint-search.js
// SUUMO / HOMES の物件詳細ページに「業者間3サイトで検索」ボタンを設置する。
// ボタン押下でページの物件情報をパースし、itandi・いえらぶ・REINS の検索結果を
// 同一物件がピンポイントで当たる条件（最寄駅＋間取り＋専有面積＋賃料狭帯）で新タブに開く。
// 検索実行は background.js の既存メッセージ OPEN_SEARCH_PAGE を再利用する。
(function () {
  'use strict';
  if (window.__pinpointSearchInjected) return;
  window.__pinpointSearchInjected = true;

  const HOST = location.hostname;
  const IS_SUUMO = /(^|\.)suumo\.jp$/.test(HOST);
  const IS_HOMES = /(^|\.)homes\.co\.jp$/.test(HOST);
  if (!IS_SUUMO && !IS_HOMES) return;

  // 賃料・面積の絞り込み幅（ピンポイントだが取りこぼさない程度）
  const RENT_MARGIN = 0.5; // 万円
  const AREA_MARGIN = 2;   // ㎡

  // ─────────── 汎用ユーティリティ ───────────
  function txt(el) {
    return el ? el.textContent.replace(/　/g, ' ').replace(/\s+/g, ' ').trim() : '';
  }
  function toHalfWidth(s) {
    return (s || '').replace(/[Ａ-Ｚａ-ｚ０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));
  }
  function parseRent(s) {
    // "14.8万円" / "14万円"
    const m = (s || '').match(/([\d.]+)\s*万円/);
    return m ? parseFloat(m[1]) : null;
  }
  function parseArea(s) {
    // "25.1m2" / "40.5㎡"
    const m = (s || '').match(/([\d.]+)\s*(?:m2|m²|㎡)/i);
    return m ? parseFloat(m[1]) : null;
  }
  function normalizeLayout(s) {
    let v = (s || '').split(/[\s(（]/)[0].trim();
    if (/ワンルーム|１ルーム|1ルーム/.test(s || '')) v = '1R';
    return v;
  }
  // 住所テキストを 都道府県 / 市区町村 に分解
  function parseAddress(addrRaw) {
    let addr = (addrRaw || '').replace(/\s+/g, '').replace(/地図を見る.*$/, '');
    const pm = addr.match(/^(北海道|東京都|(?:京都|大阪)府|.{2,3}?県)/);
    let prefecture = pm ? pm[1] : '';
    let rest = pm ? addr.slice(pm[0].length) : addr;
    // 政令市（○○市△△区）も1トークンとして拾えるよう、市の直後に区が続く場合は両方含める
    let city = '';
    const cm = rest.match(/^(.+?市.+?区|.+?[市区町村])/);
    if (cm) city = cm[1];
    return { prefecture: prefecture || '東京都', city };
  }

  // ─────────── SUUMO パーサー ───────────
  function suumoCell(table, label) {
    if (!table) return null;
    for (const tr of table.querySelectorAll('tr')) {
      const cells = tr.children;
      for (let i = 0; i < cells.length; i++) {
        if (cells[i].tagName === 'TH' && txt(cells[i]) === label) {
          let n = cells[i].nextElementSibling;
          while (n && n.tagName !== 'TD') n = n.nextElementSibling;
          return n;
        }
      }
    }
    return null;
  }
  function parseSuumo() {
    const rentEl = document.querySelector('.property_view_note .property_view_note-emphasis');
    const pvTable = document.querySelector('table.property_view_table');
    if (!rentEl || !pvTable) return null; // 詳細ページでなければ抜ける

    const gaiyou = document.querySelector('table.data_table.table_gaiyou') ||
                   document.querySelector('table.table_gaiyou');

    const name = txt(document.querySelector('h1.section_h1-header-title'));
    const address = txt(suumoCell(pvTable, '所在地'));
    const layout = normalizeLayout(txt(suumoCell(pvTable, '間取り')));
    const area = parseArea(txt(suumoCell(pvTable, '専有面積')));
    const rent = parseRent(txt(rentEl));

    // 交通: td 内の div.property_view_table-read が駅ごと
    const transit = [];
    const transitCell = suumoCell(pvTable, '駅徒歩');
    if (transitCell) {
      const reads = transitCell.querySelectorAll('.property_view_table-read');
      const lines = reads.length ? [...reads].map(txt) : [txt(transitCell)];
      for (const line of lines) {
        // "東京メトロ半蔵門線/神保町駅 歩4分"
        const m = toHalfWidth(line).match(/^(.+?)[/／]\s*(\S+?駅)\s*歩\s*(\d+)\s*分/);
        if (m) transit.push({ route: m[1].trim(), station: m[2].replace(/駅$/, ''), walk: parseInt(m[3], 10) });
      }
    }

    const structure = txt(suumoCell(gaiyou, '構造'));
    const builtYM = txt(suumoCell(gaiyou, '築年月'));
    const floors = txt(suumoCell(gaiyou, '階建'));
    return { site: 'SUUMO', name, address, layout, area, rent, transit, structure, builtYM, floors };
  }

  // ─────────── HOMES パーサー ───────────
  function homesDd(label) {
    for (const dt of document.querySelectorAll('dt')) {
      if (txt(dt) === label) {
        let dd = dt.nextElementSibling;
        if (!(dd && dd.tagName === 'DD')) dd = dt.parentElement && dt.parentElement.querySelector('dd');
        return dd || null;
      }
    }
    return null;
  }
  function parseHomes() {
    const rent = parseRent(txt(homesDd('賃料')));
    const layoutRaw = txt(homesDd('間取り'));
    if (rent == null || !layoutRaw) return null; // 詳細ページでなければ抜ける

    const h1 = [...document.querySelectorAll('h1')].find(h => !h.closest('header'));
    const name = txt(h1);

    // 所在地: 「地図を見る」等のリンクを除去
    let address = '';
    const addrDd = homesDd('所在地');
    if (addrDd) {
      const clone = addrDd.cloneNode(true);
      clone.querySelectorAll('a').forEach(a => a.remove());
      address = txt(clone);
    }

    const layout = normalizeLayout(layoutRaw);
    const area = parseArea(txt(homesDd('専有面積')));

    // 交通: dd 内の各 p が駅ごと（リンクは除外）
    const transit = [];
    const transitDd = homesDd('交通');
    if (transitDd) {
      const ps = transitDd.querySelectorAll('p');
      const lines = ps.length ? [...ps].map(txt) : [txt(transitDd)];
      for (const line of lines) {
        // "東京メトロ丸ノ内線 方南町駅 徒歩11分"
        const m = toHalfWidth(line).match(/^(.*?)\s*(\S+?駅)\s*徒歩\s*(\d+)\s*分/);
        if (m) transit.push({ route: m[1].trim(), station: m[2].replace(/駅$/, ''), walk: parseInt(m[3], 10) });
      }
    }

    const structure = txt(homesDd('建物構造'));
    const builtYM = txt(homesDd('築年月'));
    const floors = txt(homesDd('所在階/階数'));
    return { site: 'HOMES', name, address, layout, area, rent, transit, structure, builtYM, floors };
  }

  // ─────────── 合成customer（ピンポイント検索条件） ───────────
  function buildCustomer(p) {
    const nearest = (p.transit || []).slice().sort((a, b) => (a.walk || 999) - (b.walk || 999))[0] || null;
    const { prefecture, city } = parseAddress(p.address);
    return {
      name: '📍URL物件',
      rent_min: p.rent != null ? Math.max(0, +(p.rent - RENT_MARGIN).toFixed(1)) : '',
      rent_max: p.rent != null ? +(p.rent + RENT_MARGIN).toFixed(1) : '',
      layouts: p.layout ? [p.layout] : [],
      area_min: p.area != null ? Math.max(1, Math.floor(p.area - AREA_MARGIN)) : '',
      walk: nearest ? nearest.walk : '',
      routes_with_stations: nearest ? [{ route: nearest.route, stations: [nearest.station] }] : [],
      stations: nearest ? [nearest.station] : [],
      cities: city ? [city] : [],
      prefecture: prefecture || '東京都',
      selectedTowns: {},
      building_age: '',
      structures: [],
      equipment: '',
      btMode: 'none',
      daysWithin: null,
      _pinpoint: true,
    };
  }

  // ─────────── UI ───────────
  const SITES = [
    { key: 'ielove', label: 'いえらぶ' },
    { key: 'itandi', label: 'itandi' },
    { key: 'reins', label: 'REINS' },
  ];

  function fmtSummary(p, c) {
    const n = c.stations[0] ? `${c.stations[0]}駅 徒歩${c.walk}分` : '駅情報なし';
    const rentRange = c.rent_min !== '' ? `${c.rent_min}〜${c.rent_max}万円` : '賃料不明';
    return `${p.address || ''}\n${n} / ${p.layout || '間取?'} / ${p.area != null ? p.area + '㎡' : '面積?'} / ${rentRange}`;
  }

  function openService(service, customer) {
    return new Promise(resolve => {
      chrome.runtime.sendMessage({ type: 'OPEN_SEARCH_PAGE', service, customer }, resp => {
        const err = chrome.runtime.lastError ? chrome.runtime.lastError.message : null;
        resolve({ service, resp, err });
      });
    });
  }

  function injectUI(p) {
    const customer = buildCustomer(p);

    const wrap = document.createElement('div');
    wrap.id = '__pinpoint_wrap';
    wrap.style.cssText =
      'position:fixed;right:16px;bottom:16px;z-index:2147483647;font-family:-apple-system,"Hiragino Kaku Gothic ProN",sans-serif;' +
      'width:300px;background:#fff;border:1px solid #ddd;border-radius:10px;box-shadow:0 4px 20px rgba(0,0,0,.18);overflow:hidden;';

    const head = document.createElement('div');
    head.style.cssText = 'background:#2c3e50;color:#fff;padding:10px 12px;font-size:13px;font-weight:bold;display:flex;justify-content:space-between;align-items:center;';
    head.innerHTML = '<span>📍 業者間サイトで検索</span>';
    const closeBtn = document.createElement('span');
    closeBtn.textContent = '×';
    closeBtn.style.cssText = 'cursor:pointer;font-size:18px;line-height:1;';
    closeBtn.onclick = () => wrap.remove();
    head.appendChild(closeBtn);

    const summary = document.createElement('div');
    summary.style.cssText = 'padding:9px 12px;font-size:11.5px;color:#333;white-space:pre-wrap;line-height:1.5;border-bottom:1px solid #eee;background:#f8f9fa;';
    summary.textContent = fmtSummary(p, customer);

    const status = document.createElement('div');
    status.style.cssText = 'padding:6px 12px;font-size:11px;color:#555;min-height:14px;';

    const btn = document.createElement('button');
    btn.textContent = '3サイトで検索を開く';
    btn.style.cssText =
      'display:block;width:calc(100% - 24px);margin:8px 12px 12px;padding:10px;border:0;border-radius:8px;' +
      'background:#1abc9c;color:#fff;font-size:13px;font-weight:bold;cursor:pointer;';

    btn.onclick = async () => {
      btn.disabled = true;
      btn.style.background = '#95a5a6';
      btn.textContent = '検索中…';
      for (const s of SITES) {
        status.textContent = `${s.label} を開いています…`;
        const r = await openService(s.key, customer);
        if (r.err) {
          status.textContent = `${s.label}: エラー (${r.err})`;
        } else if (r.resp && r.resp.ok) {
          status.textContent = `${s.label}: OK`;
        } else if (r.resp && r.resp.disabled) {
          status.textContent = `${s.label}: 停止中`;
        } else {
          status.textContent = `${s.label}: ${(r.resp && r.resp.error) || '失敗'}`;
        }
      }
      status.textContent = '完了（各タブを確認してください）';
      btn.textContent = 'もう一度検索';
      btn.disabled = false;
      btn.style.background = '#1abc9c';
    };

    wrap.appendChild(head);
    wrap.appendChild(summary);
    wrap.appendChild(status);
    wrap.appendChild(btn);
    document.body.appendChild(wrap);
  }

  // ─────────── エントリ（DOMが揃うまでリトライ） ───────────
  function tryParse() {
    try {
      return IS_SUUMO ? parseSuumo() : parseHomes();
    } catch (e) {
      console.warn('[pinpoint] parse error', e);
      return null;
    }
  }
  let attempts = 0;
  function boot() {
    if (document.getElementById('__pinpoint_wrap')) return;
    const p = tryParse();
    if (p && p.rent != null) {
      injectUI(p);
      return;
    }
    if (++attempts < 12) setTimeout(boot, 500);
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
