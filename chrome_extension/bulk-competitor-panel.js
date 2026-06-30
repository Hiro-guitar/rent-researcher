/**
 * bulk-competitor-panel.js
 * REINS / itandi / いえらぶ の検索結果ページに「SUUMO競合チェック」ボタンを表示。
 * ボタン押下で、ページ上の全物件の SUUMO 競合数を一括取得し、
 * 各物件の行に直接バッジを注入する。広告不可の物件はスキップ。
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
  btn.textContent = '競合チェック';
  Object.assign(btn.style, {
    position: 'fixed', bottom: '80px', right: '20px', zIndex: '99999',
    padding: '8px 16px', fontSize: '12px', fontWeight: 'bold',
    color: '#fff', backgroundColor: '#e67e22', border: 'none', borderRadius: '6px',
    cursor: 'pointer', boxShadow: '0 2px 6px rgba(0,0,0,0.25)',
  });
  document.body.appendChild(btn);

  // ── コンパクトバッジ ──
  const BC = 'bc-badge';

  function clearBadge(el) {
    // 自身の子要素と、直後の兄弟要素の両方を探す（後方互換）
    const old = el.querySelector('.' + BC);
    if (old) { old.remove(); return; }
    const sib = el.nextElementSibling;
    if (sib && sib.classList.contains(BC)) sib.remove();
  }

  function mkBox() {
    const d = document.createElement('span');
    d.className = BC;
    d.style.cssText = 'display:inline-flex;align-items:center;gap:4px;padding:2px 6px;border-radius:4px;font-size:11px;font-family:sans-serif;vertical-align:middle;margin-left:6px;';
    return d;
  }

  function mkNum(n, label) {
    const s = document.createElement('span');
    const color = n === 0 ? '#27ae60' : n <= 2 ? '#e67e22' : '#e74c3c';
    s.textContent = n;
    s.style.cssText = 'font-weight:bold;color:' + color + ';font-size:12px;';
    const l = document.createElement('span');
    l.textContent = label;
    l.style.cssText = 'font-size:9px;color:#888;margin-right:6px;';
    const w = document.createElement('span');
    w.style.cssText = 'display:inline-flex;align-items:baseline;gap:1px;';
    w.appendChild(s);
    w.appendChild(l);
    return w;
  }

  function injectResult(el, comp, insertTarget) {
    clearBadge(insertTarget || el);
    const box = mkBox();
    box.style.background = '#f5f5f5';
    box.style.border = '1px solid #e0e0e0';

    if (!comp) {
      box.textContent = '—';
      box.style.color = '#bbb';
    } else {
      const hlName = comp.withNameHighlighted || 0;
      const hlNoName = comp.withoutNameHighlighted || 0;
      box.appendChild(mkNum(hlName, '名有'));
      box.appendChild(mkNum(hlNoName, '名無'));
      if (comp.url) {
        const a = document.createElement('a');
        a.href = comp.url;
        a.target = '_blank';
        a.textContent = '↗';
        a.style.cssText = 'text-decoration:none;color:#2980b9;font-size:11px;font-weight:bold;';
        a.title = 'SUUMOで確認';
        box.appendChild(a);
      }
    }
    (insertTarget || el).after(box);
  }

  function injectAdBlock(el, insertTarget) {
    clearBadge(insertTarget || el);
    const box = mkBox();
    box.style.background = '#f5eef5';
    box.style.border = '1px solid #d5c5d5';
    box.textContent = '広告不可';
    box.style.color = '#999';
    box.style.fontSize = '10px';
    (insertTarget || el).after(box);
  }

  function injectLoading(el, insertTarget) {
    clearBadge(insertTarget || el);
    const box = mkBox();
    box.style.background = '#f8f8f8';
    box.style.border = '1px solid #e8e8e8';
    box.style.color = '#bbb';
    box.textContent = '⏳';
    (insertTarget || el).after(box);
  }

  function injectError(el, insertTarget) {
    clearBadge(insertTarget || el);
    const box = mkBox();
    box.style.background = '#fef0f0';
    box.style.border = '1px solid #e8c8c8';
    box.style.color = '#c0392b';
    box.textContent = '✗';
    (insertTarget || el).after(box);
  }

  // ── REINS 物件抽出 ──
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
      // バッジ挿入先: 建物名セル
      entries.push({
        el: row,
        insertTarget: items[11] || row,
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

      // 広告掲載の取得: roomBox内のリーフテキストから「不可」を探す
      // 「不可」は広告掲載カラム固有のリーフテキスト
      let adKeisai = '';
      const roomLeaves = leafTexts(roomBox);
      for (let li = 0; li < roomLeaves.length; li++) {
        if (roomLeaves[li] === '不可') { adKeisai = '不可'; break; }
      }

      const key = bld.buildingName + '|' + roomNumber;
      if (seen.has(key)) return;
      seen.add(key);

      if (!bld.address || !rent) return;

      // 部屋番号を表示している要素を探す（バッジ挿入先）
      let roomLabel = null;
      const spans = roomBox.querySelectorAll('span, div, td');
      for (const sp of spans) {
        if (sp.children.length === 0 && sp.textContent.trim() === roomNumber) {
          roomLabel = sp; break;
        }
      }

      entries.push({
        el: roomBox,
        insertTarget: roomLabel || roomBox,
        adBlocked: adKeisai && adKeisai !== '可' && adKeisai !== '',
        prop: {
          building_name: bld.buildingName, room_number: roomNumber,
          address: bld.address, rent, management_fee: mgmt,
          layout: normalizeLayout(layout), area,
          story_text: bld.storyText, source: 'itandi',
          ad_keisai: adKeisai,
        }
      });
    });
    return entries;
  }

  // ── いえらぶ物件抽出（ielove-content-search.js の parseEstateCard 準拠） ──
  function extractIelove() {
    const entries = [];
    const cards = document.querySelectorAll('table.estate_list');
    cards.forEach((card) => {
      // 物件名・部屋番号: table.estate-name > span.large-font
      let buildingName = '', roomNumber = '';
      const nameTable = card.querySelector('table.estate-name');
      const nameSpan = nameTable && nameTable.querySelector('span.large-font');
      if (nameSpan) {
        const textParts = [];
        for (const child of nameSpan.childNodes) {
          if (child.nodeType === 3) { const t = child.textContent.trim(); if (t) textParts.push(t); }
          else break;
        }
        const raw = textParts.join(' ').trim();
        const parts = raw.split(/\s{2,}/);
        if (parts.length >= 2) {
          buildingName = parts.slice(0, -1).join(' ');
          roomNumber = parts[parts.length - 1];
        } else if (parts.length > 0) {
          buildingName = parts[0];
        }
      }

      // 賃料・管理費・住所: 「管理費」と「円」を含むtd
      let rent = 0, mgmt = 0, address = '';
      for (const td of card.querySelectorAll('td')) {
        const text = td.textContent.trim();
        if (text.includes('管理費') && text.includes('円')) {
          const rentM = text.match(/([\d,]+)\s*円/);
          if (rentM) rent = parseInt(rentM[1].replace(/,/g, ''), 10);
          const mgmtM = text.match(/管理費[^\d]*([\d,]+)\s*円/);
          if (mgmtM) mgmt = parseInt(mgmtM[1].replace(/,/g, ''), 10);
          const addrM = text.match(/((?:東京都|北海道|(?:京都|大阪)府|.{2,3}県)[^\n]+?)(?:\s|$)/);
          if (addrM) address = addrM[1].trim();
          break;
        }
      }

      // 間取り・面積: table.detail-info のヘッダーなしtd行
      let layout = '', area = 0;
      const detailInfo = card.querySelector('table.detail-info');
      if (detailInfo) {
        for (const row of detailInfo.querySelectorAll('tr')) {
          const tds = row.querySelectorAll('td');
          const ths = row.querySelectorAll('th');
          if (tds.length >= 2 && ths.length === 0) {
            const v1 = tds[1].textContent.trim();
            const lm = v1.match(/(\d+[SLDKR]+)/i);
            layout = lm ? lm[1].toUpperCase() : (/ワンルーム/.test(v1) ? '1R' : '');
            const am = v1.match(/([\d.]+)\s*[㎡m]/);
            area = am ? parseFloat(am[1]) : 0;
            break;
          }
        }
      }

      if (!address || !rent) return;
      entries.push({
        el: card,
        insertTarget: nameSpan || card,
        adBlocked: false,
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

  // ── 進捗管理 ──
  // checkableEntries: 広告不可を除いた、実際にSUUMOチェックする物件
  let allEntries = [];
  let checkableEntries = [];
  let doneCount = 0;

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'BULK_COMPETITOR_PROGRESS') {
      const e = checkableEntries[msg.index];
      if (!e) return;
      if (msg.error) {
        injectError(e.el, e.insertTarget);
      } else {
        injectResult(e.el, msg.competitor, e.insertTarget);
      }
      doneCount++;
      updateProgress();
    }
  });

  function updateProgress() {
    const checkTotal = checkableEntries.length;
    btn.textContent = '取得中 ' + doneCount + '/' + checkTotal;
    if (doneCount >= checkTotal) {
      btn.textContent = '競合チェック ✓';
      btn.style.backgroundColor = '#27ae60';
      setTimeout(() => {
        btn.textContent = '競合チェック';
        btn.style.backgroundColor = '#e67e22';
        running = false;
      }, 3000);
    }
  }

  // ── いえらぶURL広告フィルタ ──
  function ensureIeloveAdFilter() {
    const url = location.href;
    if (url.includes('papt/1') && url.includes('papc/03')) return true;
    let newUrl = url.replace(/\/$/, '');
    if (!url.includes('papt/')) newUrl += '/papt/1';
    if (!url.includes('papc/')) newUrl += '/papc/03';
    sessionStorage.setItem('bc-auto-start', '1');
    location.href = newUrl;
    return false;
  }

  // ── 自動開始（いえらぶフィルタ付与後リロード） ──
  if (site === 'ielove' && sessionStorage.getItem('bc-auto-start')) {
    sessionStorage.removeItem('bc-auto-start');
    setTimeout(() => btn.click(), 1500);
  }

  // ── ボタンクリック ──
  let running = false;
  btn.addEventListener('click', () => {
    if (running) return;

    // いえらぶ: 広告可フィルタがなければURLに追加してリロード
    if (site === 'ielove' && !ensureIeloveAdFilter()) return;

    running = true;
    doneCount = 0;

    allEntries = [];
    if (site === 'reins') allEntries = extractReins();
    else if (site === 'itandi') allEntries = extractItandi();
    else if (site === 'ielove') allEntries = extractIelove();

    if (allEntries.length === 0) {
      btn.textContent = '物件なし';
      btn.style.backgroundColor = '#e74c3c';
      setTimeout(() => {
        btn.textContent = '競合チェック';
        btn.style.backgroundColor = '#e67e22';
        running = false;
      }, 2000);
      return;
    }

    // 広告不可を先にバッジ表示、チェック対象から除外
    checkableEntries = [];
    allEntries.forEach((e) => {
      if (e.adBlocked) {
        injectAdBlock(e.el, e.insertTarget);
      } else {
        injectLoading(e.el, e.insertTarget);
        checkableEntries.push(e);
      }
    });

    if (checkableEntries.length === 0) {
      btn.textContent = '競合チェック ✓';
      btn.style.backgroundColor = '#27ae60';
      setTimeout(() => {
        btn.textContent = '競合チェック';
        btn.style.backgroundColor = '#e67e22';
        running = false;
      }, 2000);
      return;
    }

    btn.textContent = '取得中 0/' + checkableEntries.length;
    btn.style.backgroundColor = '#95a5a6';

    chrome.runtime.sendMessage({
      type: 'BULK_COMPETITOR_CHECK',
      properties: checkableEntries.map((e) => e.prop),
    });
  });
})();
