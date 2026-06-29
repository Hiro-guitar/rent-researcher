/**
 * bulk-competitor-panel.js
 * REINS / itandi / いえらぶ の検索結果ページに「SUUMO競合チェック」ボタンを表示。
 * ボタン押下で、ページ上の全物件の SUUMO 競合数を一括取得し、
 * 各物件の行に直接バッジを注入する。
 */
(() => {
  'use strict';

  if (document.getElementById('bulk-comp-btn')) return;

  const href = location.href;
  let site = '';
  if (href.includes('system.reins.jp')) site = 'reins';
  else if (href.includes('itandibb.com/rent_rooms/list')) site = 'itandi';
  else if (href.includes('bb.ielove.jp/ielovebb/rent/index')) site = 'ielove';
  if (!site) return;

  // ── フローティングボタン ──
  const btn = document.createElement('button');
  btn.id = 'bulk-comp-btn';
  btn.textContent = 'SUUMO競合チェック';
  Object.assign(btn.style, {
    position: 'fixed', bottom: '80px', right: '20px', zIndex: '99999',
    padding: '10px 18px', fontSize: '13px', fontWeight: 'bold',
    color: '#fff', backgroundColor: '#e67e22', border: 'none', borderRadius: '8px',
    cursor: 'pointer', boxShadow: '0 2px 8px rgba(0,0,0,0.3)',
  });
  document.body.appendChild(btn);

  // ── バッジ注入 ──
  function createBadge(text, bgColor) {
    const s = document.createElement('span');
    s.textContent = text;
    s.style.cssText = 'display:inline-block;padding:1px 5px;border-radius:3px;font-weight:bold;color:#fff;font-size:10px;margin-right:2px;background:' + bgColor + ';';
    return s;
  }

  function badgeColor(n) {
    return n === 0 ? '#27ae60' : n <= 2 ? '#f39c12' : '#e74c3c';
  }

  function injectBadge(el, comp) {
    // 既存バッジ削除
    const old = el.querySelector('.bc-badge-box');
    if (old) old.remove();

    const box = document.createElement('div');
    box.className = 'bc-badge-box';
    box.style.cssText = 'display:inline-flex;align-items:center;gap:3px;margin:4px 0;padding:3px 6px;background:#f8f8f8;border-radius:5px;border:1px solid #ddd;font-size:11px;';

    if (!comp) {
      box.textContent = 'SUUMO: 取得不可';
      box.style.color = '#999';
    } else {
      const hlName = comp.withNameHighlighted || 0;
      const hlNoName = comp.withoutNameHighlighted || 0;
      const label = document.createElement('span');
      label.textContent = 'SUUMO HL:';
      label.style.cssText = 'font-size:10px;color:#666;font-weight:bold;';
      box.appendChild(label);
      box.appendChild(createBadge(hlName + '名有', badgeColor(hlName)));
      box.appendChild(createBadge(hlNoName + '名無', badgeColor(hlNoName)));

      const allSpan = document.createElement('span');
      allSpan.textContent = '(全' + (comp.total || 0) + ')';
      allSpan.style.cssText = 'font-size:9px;color:#aaa;';
      box.appendChild(allSpan);

      if (comp.url) {
        const link = document.createElement('a');
        link.href = comp.url;
        link.target = '_blank';
        link.textContent = '🔍';
        link.title = 'SUUMOで確認';
        link.style.cssText = 'text-decoration:none;font-size:11px;margin-left:2px;';
        box.appendChild(link);
      }
    }

    // 挿入位置: 要素の先頭 or 末尾
    if (el.firstChild) {
      el.insertBefore(box, el.firstChild);
    } else {
      el.appendChild(box);
    }
  }

  function injectLoading(el) {
    const old = el.querySelector('.bc-badge-box');
    if (old) old.remove();
    const box = document.createElement('div');
    box.className = 'bc-badge-box';
    box.style.cssText = 'display:inline-flex;align-items:center;gap:4px;margin:4px 0;padding:3px 6px;background:#f8f8f8;border-radius:5px;border:1px solid #ddd;font-size:11px;color:#999;';
    box.textContent = 'SUUMO: ⏳ 取得中...';
    if (el.firstChild) el.insertBefore(box, el.firstChild);
    else el.appendChild(box);
  }

  function injectError(el) {
    const old = el.querySelector('.bc-badge-box');
    if (old) old.remove();
    const box = document.createElement('div');
    box.className = 'bc-badge-box';
    box.style.cssText = 'display:inline-flex;align-items:center;margin:4px 0;padding:3px 6px;background:#fdf0f0;border-radius:5px;border:1px solid #e0c0c0;font-size:11px;color:#c0392b;';
    box.textContent = 'SUUMO: エラー';
    if (el.firstChild) el.insertBefore(box, el.firstChild);
    else el.appendChild(box);
  }

  // ── REINS 物件抽出（DOM要素参照付き） ──
  function extractReins() {
    const rows = document.querySelectorAll('.p-table-body-row');
    const entries = [];
    rows.forEach((row) => {
      const items = row.querySelectorAll(':scope > .p-table-body-item');
      if (items.length < 20) return;
      const buildingName = (items[11] && items[11].textContent || '').trim();
      const address = (items[6] && items[6].textContent || '').trim();
      const rentText = (items[8] && items[8].textContent || '').trim();
      const layout = (items[13] && items[13].textContent || '').trim();
      const areaText = (items[5] && items[5].textContent || '').trim();
      const floor = (items[12] && items[12].textContent || '').trim();
      const roomNumber = floor.replace(/[^\d]/g, '') || '';
      const mgmtFee = (items[15] && items[15].textContent || '').trim();

      const rentYen = parseRentText(rentText);
      const areaNum = parseFloat(areaText.replace(/[^\d.]/g, '')) || 0;
      const mgmtYen = parseRentText(mgmtFee);

      if (!address || !rentYen) return;
      entries.push({
        el: row,
        prop: {
          building_name: buildingName, room_number: roomNumber,
          address, rent: rentYen, management_fee: mgmtYen,
          layout: normalizeLayout(layout), area: areaNum,
          source: 'reins',
        }
      });
    });
    return entries;
  }

  // ── itandi 物件抽出 ──
  function extractItandi() {
    const ADDR_RE = /(東京都|北海道|(?:京都|大阪)府|.{2,3}県)[^\n]{1,40}?[区市町村]/;
    const links = document.querySelectorAll('.CommonButton.isDetail a[href*="/rent_rooms/"]');
    const entries = [];
    const seen = new Set();
    const cardCache = new Map();

    links.forEach((link) => {
      const btn2 = link.closest('.CommonButton');
      if (!btn2) return;
      let roomBox = null;
      let el = btn2;
      for (let i = 0; i < 6 && el; i++) {
        el = el.parentElement;
        if (!el) break;
        if ((el.textContent || '').indexOf('部屋番号') !== -1 && el.querySelector('.CommonButton.isDetail')) {
          roomBox = el; break;
        }
      }
      if (!roomBox) return;

      let buildingCard = null;
      el = roomBox;
      for (let i = 0; i < 15 && el; i++) {
        el = el.parentElement;
        if (!el || el === document.body) break;
        if (ADDR_RE.test(el.textContent || '')) { buildingCard = el; break; }
      }

      let bld = cardCache.get(buildingCard);
      if (!bld) {
        bld = { buildingName: '', address: '', storyText: '' };
        if (buildingCard) {
          const leaves = leafTexts(buildingCard);
          let addrIdx = -1;
          for (let i = 0; i < leaves.length; i++) {
            if (ADDR_RE.test(leaves[i])) { addrIdx = i; break; }
          }
          if (addrIdx >= 0) {
            bld.address = leaves[addrIdx].replace(/\s+/g, ' ').trim();
            for (let j = addrIdx - 1; j >= 0; j--) {
              if (/^\d+枚$/.test(leaves[j])) continue;
              if (leaves[j]) { bld.buildingName = leaves[j]; break; }
            }
            for (let s = addrIdx + 1; s < leaves.length; s++) {
              const sm = leaves[s].match(/(\d+階建)/);
              if (sm) { bld.storyText = sm[1]; break; }
            }
          }
        }
        cardCache.set(buildingCard, bld);
      }

      const text = (roomBox.textContent || '').replace(/ /g, ' ');
      const roomNumber = extractBetween(text, '部屋番号', ['賃管共', '賃料', '賃']).replace(/\s+/g, '').trim();
      const chinkan = extractBetween(text, '賃管共', ['敷礼保', '敷', '間取り', '内見']);
      const parts = chinkan.split('/');
      const rent = parseMoney(parts[0] || '');
      const mgmt = parseMoney(parts[1] || '') + parseMoney(parts[2] || '');
      const madoriText = extractBetween(text, '間取り', ['内見・申込', '内見', '入居']);
      const lm = madoriText.match(/(\d+[SLDKR]+)/i);
      const layout = lm ? lm[1] : (/ワンルーム/.test(madoriText) ? '1R' : '');
      const am = madoriText.match(/([\d.]+)\s*[㎡m]/);
      const area = am ? parseFloat(am[1]) : 0;

      const key = bld.buildingName + '|' + roomNumber;
      if (seen.has(key)) return;
      seen.add(key);

      if (!bld.address || !rent) return;
      entries.push({
        el: roomBox,
        prop: {
          building_name: bld.buildingName, room_number: roomNumber,
          address: bld.address, rent, management_fee: mgmt,
          layout: normalizeLayout(layout), area,
          story_text: bld.storyText, source: 'itandi',
        }
      });
    });
    return entries;
  }

  // ── いえらぶ物件抽出 ──
  function extractIelove() {
    const entries = [];
    const cards = document.querySelectorAll('table.estate_list');
    cards.forEach((card) => {
      const nameEl = card.querySelector('.estate_name a, .estate_name');
      const buildingName = nameEl ? nameEl.textContent.trim() : '';
      const rows = card.querySelectorAll('tr');
      let address = '', rent = 0, mgmt = 0, layout = '', area = 0, roomNumber = '';
      rows.forEach((tr) => {
        const th = (tr.querySelector('th') || {}).textContent || '';
        const td = (tr.querySelector('td') || {}).textContent || '';
        if (th.includes('所在地')) address = td.trim();
        if (th.includes('賃料')) rent = parseMoney(td);
        if (th.includes('管理費') || th.includes('共益費')) mgmt = parseMoney(td);
        if (th.includes('間取')) layout = normalizeLayout(td.trim());
        if (th.includes('面積') || th.includes('専有')) area = parseFloat(td.replace(/[^\d.]/g, '')) || 0;
        if (th.includes('号室') || th.includes('部屋')) roomNumber = td.replace(/[^\d]/g, '');
      });
      if (!address || !rent) return;
      entries.push({
        el: card,
        prop: {
          building_name: buildingName, room_number: roomNumber,
          address, rent, management_fee: mgmt,
          layout, area, source: 'ielove',
        }
      });
    });
    return entries;
  }

  // ── ユーティリティ ──
  function parseRentText(s) {
    if (!s) return 0;
    s = String(s).replace(/[,\s]/g, '');
    const man = s.match(/([\d.]+)\s*万/);
    if (man) return Math.round(parseFloat(man[1]) * 10000);
    const yen = s.match(/([\d]+)/);
    if (yen) { const v = parseInt(yen[1], 10); return v > 1000 ? v : 0; }
    return 0;
  }
  function parseMoney(s) {
    if (!s) return 0;
    s = String(s).replace(/[,\s]/g, '');
    const man = s.match(/([\d.]+)万円/);
    if (man) return Math.round(parseFloat(man[1]) * 10000);
    const en = s.match(/([\d.]+)円/);
    if (en) return Math.round(parseFloat(en[1]));
    return 0;
  }
  function normalizeLayout(s) {
    if (!s) return '';
    s = String(s).replace(/\s+/g, '');
    const m = s.match(/(\d+[SLDKR]+)/i);
    if (m) return m[1].toUpperCase();
    if (/ワンルーム/.test(s)) return '1R';
    return s;
  }
  function extractBetween(text, label, nextLabels) {
    const i = text.indexOf(label);
    if (i < 0) return '';
    const start = i + label.length;
    let end = text.length;
    for (const nl of nextLabels) {
      const j = text.indexOf(nl, start);
      if (j >= 0 && j < end) end = j;
    }
    return text.substring(start, end).trim();
  }
  function leafTexts(root) {
    const out = [];
    if (!root) return out;
    for (const el of root.querySelectorAll('*')) {
      if (el.children.length === 0) {
        const t = (el.textContent || '').trim();
        if (t) out.push(t);
      }
    }
    return out;
  }

  // ── 進捗リスナー ──
  let entries = [];
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'BULK_COMPETITOR_PROGRESS' && entries[msg.index]) {
      const e = entries[msg.index];
      if (msg.error) {
        injectError(e.el);
      } else {
        injectBadge(e.el, msg.competitor);
      }
      doneCount++;
      updateProgress();
    }
  });

  let doneCount = 0;
  let totalCount = 0;
  function updateProgress() {
    btn.textContent = '取得中... ' + doneCount + '/' + totalCount;
    if (doneCount >= totalCount) {
      btn.textContent = 'SUUMO競合チェック ✓';
      btn.style.backgroundColor = '#27ae60';
      setTimeout(() => {
        btn.textContent = 'SUUMO競合チェック';
        btn.style.backgroundColor = '#e67e22';
        running = false;
      }, 3000);
    }
  }

  // ── ボタンクリック ──
  let running = false;
  btn.addEventListener('click', () => {
    if (running) return;
    running = true;
    doneCount = 0;

    entries = [];
    if (site === 'reins') entries = extractReins();
    else if (site === 'itandi') entries = extractItandi();
    else if (site === 'ielove') entries = extractIelove();

    totalCount = entries.length;

    if (entries.length === 0) {
      btn.textContent = '物件が見つかりません';
      btn.style.backgroundColor = '#e74c3c';
      setTimeout(() => {
        btn.textContent = 'SUUMO競合チェック';
        btn.style.backgroundColor = '#e67e22';
        running = false;
      }, 2000);
      return;
    }

    // 各行にローディング表示
    entries.forEach((e) => injectLoading(e.el));
    btn.textContent = '取得中... 0/' + totalCount;
    btn.style.backgroundColor = '#95a5a6';

    // background にリクエスト
    chrome.runtime.sendMessage({
      type: 'BULK_COMPETITOR_CHECK',
      properties: entries.map((e) => e.prop),
    });
  });
})();
