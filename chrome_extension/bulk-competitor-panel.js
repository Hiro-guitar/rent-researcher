/**
 * bulk-competitor-panel.js
 * REINS / itandi / いえらぶ の検索結果ページに「SUUMO競合チェック」ボタンを表示。
 * ボタン押下で、ページ上の全物件の SUUMO 競合数を一括取得して結果をオーバーレイ表示する。
 *
 * 対象URL:
 *   - https://system.reins.jp/*
 *   - https://itandibb.com/rent_rooms/list*
 *   - https://bb.ielove.jp/ielovebb/rent/index/*
 */
(() => {
  'use strict';

  if (document.getElementById('bulk-comp-btn')) return;

  // ── サイト判定 ──
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
    transition: 'opacity 0.2s',
  });
  btn.addEventListener('mouseenter', () => { btn.style.opacity = '0.85'; });
  btn.addEventListener('mouseleave', () => { btn.style.opacity = '1'; });
  document.body.appendChild(btn);

  // ── 結果パネル ──
  let panel = null;
  function ensurePanel() {
    if (panel) return panel;
    panel = document.createElement('div');
    panel.id = 'bulk-comp-panel';
    Object.assign(panel.style, {
      position: 'fixed', bottom: '130px', right: '20px', zIndex: '99998',
      width: '400px', maxHeight: '60vh', overflowY: 'auto',
      backgroundColor: '#fff', border: '1px solid #ccc', borderRadius: '10px',
      boxShadow: '0 4px 16px rgba(0,0,0,0.2)', padding: '12px', fontSize: '12px',
      fontFamily: 'sans-serif', display: 'none',
    });
    document.body.appendChild(panel);
    return panel;
  }

  // ── REINS 物件抽出 ──
  function extractReins() {
    const rows = document.querySelectorAll('.p-table-body-row');
    const props = [];
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
      props.push({
        building_name: buildingName, room_number: roomNumber,
        address, rent: rentYen, management_fee: mgmtYen,
        layout: normalizeLayout(layout), area: areaNum,
        source: 'reins',
      });
    });
    return props;
  }

  // ── itandi 物件抽出（itandi-content-search.js と同じ DOM 走査ロジック） ──
  function extractItandi() {
    const ADDR_RE = /(東京都|北海道|(?:京都|大阪)府|.{2,3}県)[^\n]{1,40}?[区市町村]/;
    // itandi は .CommonButton.isDetail の中に a[href*="/rent_rooms/"] がある構造
    const links = document.querySelectorAll('.CommonButton.isDetail a[href*="/rent_rooms/"]');
    const props = [];
    const seen = new Set();
    const cardCache = new Map();

    links.forEach((link) => {
      // roomBox: 「部屋番号」テキストと .CommonButton.isDetail の両方を含む最小の祖先
      const btn = link.closest('.CommonButton');
      if (!btn) return;
      let roomBox = null;
      let el = btn;
      for (let i = 0; i < 6 && el; i++) {
        el = el.parentElement;
        if (!el) break;
        if ((el.textContent || '').indexOf('部屋番号') !== -1 && el.querySelector('.CommonButton.isDetail')) {
          roomBox = el; break;
        }
      }
      if (!roomBox) return;

      // buildingCard: 住所を含む最小の祖先
      let buildingCard = null;
      el = roomBox;
      for (let i = 0; i < 15 && el; i++) {
        el = el.parentElement;
        if (!el || el === document.body) break;
        if (ADDR_RE.test(el.textContent || '')) { buildingCard = el; break; }
      }

      // 建物情報（キャッシュ）
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

      // 部屋情報
      const text = (roomBox.textContent || '').replace(/ /g, ' ');
      let roomNumber = extractBetween(text, '部屋番号', ['賃管共', '賃料', '賃']).replace(/\s+/g, '').trim();
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
      props.push({
        building_name: bld.buildingName, room_number: roomNumber,
        address: bld.address, rent, management_fee: mgmt,
        layout: normalizeLayout(layout), area,
        story_text: bld.storyText,
        source: 'itandi',
      });
    });
    return props;
  }

  // ── いえらぶ物件抽出 ──
  function extractIelove() {
    const props = [];
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
      props.push({
        building_name: buildingName, room_number: roomNumber,
        address, rent, management_fee: mgmt,
        layout, area, source: 'ielove',
      });
    });
    return props;
  }

  // ── 共通ユーティリティ ──
  function parseRentText(s) {
    if (!s) return 0;
    s = String(s).replace(/[,\s]/g, '');
    const man = s.match(/([\d.]+)\s*万/);
    if (man) return Math.round(parseFloat(man[1]) * 10000);
    const yen = s.match(/([\d]+)/);
    if (yen) {
      const v = parseInt(yen[1], 10);
      return v > 1000 ? v : 0;
    }
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
  function findAncestor(el, test, maxDepth) {
    for (let i = 0; i < maxDepth && el; i++) {
      el = el.parentElement;
      if (!el || el === document.body) break;
      if (test(el)) return el;
    }
    return null;
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
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'BULK_COMPETITOR_PROGRESS') {
      updateResult(msg.index, msg);
    }
  });

  let resultRows = [];

  function updateResult(idx, data) {
    if (!resultRows[idx]) return;
    const row = resultRows[idx];
    const statusEl = row.querySelector('.bc-status');
    if (data.error) {
      statusEl.textContent = 'エラー';
      statusEl.style.color = '#e74c3c';
      return;
    }
    const comp = data.competitor;
    if (!comp) {
      statusEl.textContent = '取得不可';
      statusEl.style.color = '#999';
      return;
    }
    const total = comp.total || 0;
    statusEl.innerHTML = '';
    const badge = document.createElement('span');
    badge.textContent = total + '件';
    badge.style.cssText = 'display:inline-block;padding:2px 8px;border-radius:4px;font-weight:bold;color:#fff;'
      + (total === 0 ? 'background:#27ae60;' : total <= 3 ? 'background:#2ecc71;' : total <= 10 ? 'background:#f39c12;' : 'background:#e74c3c;');
    statusEl.appendChild(badge);
    if (comp.url) {
      const link = document.createElement('a');
      link.href = comp.url;
      link.target = '_blank';
      link.textContent = ' 🔍';
      link.style.cssText = 'text-decoration:none;font-size:11px;';
      statusEl.appendChild(link);
    }
  }

  // ── ボタンクリック ──
  let running = false;
  btn.addEventListener('click', async () => {
    if (running) return;
    running = true;
    btn.textContent = '取得中...';
    btn.style.backgroundColor = '#95a5a6';

    let props = [];
    if (site === 'reins') props = extractReins();
    else if (site === 'itandi') props = extractItandi();
    else if (site === 'ielove') props = extractIelove();

    if (props.length === 0) {
      btn.textContent = '物件が見つかりません';
      btn.style.backgroundColor = '#e74c3c';
      setTimeout(() => {
        btn.textContent = 'SUUMO競合チェック';
        btn.style.backgroundColor = '#e67e22';
        running = false;
      }, 2000);
      return;
    }

    // パネル表示
    const p = ensurePanel();
    p.style.display = 'block';
    p.innerHTML = '<div style="font-weight:bold;margin-bottom:8px;font-size:13px;">SUUMO競合チェック (' + props.length + '件)</div>';
    const table = document.createElement('table');
    table.style.cssText = 'width:100%;border-collapse:collapse;font-size:11px;';
    table.innerHTML = '<tr style="background:#f5f5f5;"><th style="padding:4px;text-align:left;">物件</th><th style="padding:4px;text-align:left;">賃料</th><th style="padding:4px;text-align:center;">競合数</th></tr>';
    resultRows = [];
    props.forEach((prop, i) => {
      const tr = document.createElement('tr');
      tr.style.borderBottom = '1px solid #eee';
      const name = (prop.building_name || '?') + (prop.room_number ? ' ' + prop.room_number : '');
      const rentMan = prop.rent >= 10000 ? (prop.rent / 10000).toFixed(1) + '万' : prop.rent + '円';
      tr.innerHTML = '<td style="padding:4px;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="' + escHtml(name) + '">' + escHtml(name) + '</td>'
        + '<td style="padding:4px;">' + rentMan + '</td>'
        + '<td style="padding:4px;text-align:center;" class="bc-status"><span style="color:#999;">⏳</span></td>';
      table.appendChild(tr);
      resultRows.push(tr);
    });
    p.appendChild(table);

    // progress bar
    const progBar = document.createElement('div');
    progBar.style.cssText = 'margin-top:8px;height:4px;background:#eee;border-radius:2px;overflow:hidden;';
    const progFill = document.createElement('div');
    progFill.style.cssText = 'height:100%;width:0%;background:#e67e22;transition:width 0.3s;';
    progBar.appendChild(progFill);
    p.appendChild(progBar);

    const progText = document.createElement('div');
    progText.style.cssText = 'text-align:center;font-size:11px;color:#999;margin-top:4px;';
    progText.textContent = '0 / ' + props.length;
    p.appendChild(progText);

    // background にリクエスト送信
    try {
      chrome.runtime.sendMessage({
        type: 'BULK_COMPETITOR_CHECK',
        properties: props,
      }, (resp) => {
        btn.textContent = 'SUUMO競合チェック';
        btn.style.backgroundColor = '#e67e22';
        running = false;
        progFill.style.width = '100%';
        progText.textContent = props.length + ' / ' + props.length + ' 完了';
      });
    } catch (e) {
      btn.textContent = 'エラー';
      btn.style.backgroundColor = '#e74c3c';
      running = false;
    }

    // 進捗更新のリスナーで progBar も更新
    const origUpdate = updateResult;
    let doneCount = 0;
    updateResult = function(idx, data) {
      origUpdate(idx, data);
      doneCount++;
      progFill.style.width = (doneCount / props.length * 100) + '%';
      progText.textContent = doneCount + ' / ' + props.length;
    };
  });

  function escHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
})();
