/**
 * itandi-content-search.js
 * itandi BB 検索結果一覧ページ用 content script（手動送信パネル）
 *
 * 対象URL: https://itandibb.com/rent_rooms/list*
 *
 * itandi の検索結果は React SPA で描画される。自動検索は API 経由(itandi-background.js)で
 * 取得するため一覧の DOM パーサは存在しなかった。手動送信パネルのために、画面に並んでいる
 * 物件カードから物件名・賃料等を抽出し、ManualSendPanel に渡すアダプタを実装する。
 *
 * 各物件の詳細（画像・設備・契約条件等）は background.js の fetchItandiDetailForManual が
 * 詳細ページを新タブで開いて ITANDI_EXTRACT_DETAIL で取得する。一覧アダプタは
 * 「物件名・部屋番号・賃料・管理費・間取り・面積・住所・駅・築年・詳細URL・room_id」だけ渡せばよい。
 */
(() => {
  'use strict';

  const ITANDI_BASE = 'https://itandibb.com';
  // 住所判定（都道府県＋市区町村）。物件カードのヘッダー特定に使う。
  const ADDR_RE = /(東京都|北海道|(?:京都|大阪)府|.{2,3}県)[^\n]{1,40}?[区市町村]/;

  // ── 金額パース（「8.4万円」→84000 / 「5,000円」→5000 / 「入力なし」→0） ──
  function parseMoney(s) {
    if (!s) return 0;
    s = String(s).replace(/[,\s]/g, '');
    if (/入力なし|^なし$|^-+$|^—$|^―$/.test(s)) return 0;
    const man = s.match(/([\d.]+)万円/);
    if (man) return Math.round(parseFloat(man[1]) * 10000);
    const en = s.match(/([\d.]+)円/);
    if (en) return Math.round(parseFloat(en[1]));
    return 0;
  }

  // ── 文字値クリーン（敷金・礼金等の「入力なし」「-」を空に） ──
  function cleanVal(s) {
    if (!s) return '';
    s = String(s).trim();
    if (/^入力なし$|^なし$|^-+$|^—$|^―$/.test(s)) return '';
    return s;
  }

  // ── 物件行(roomBox)内のラベル区切り抽出 ──
  // 例: "…部屋番号301賃管共8.4万円/5,000円/ 入力なし 敷礼保1ヶ月/1ヶ月/ 入力なし 間取り1R23㎡内見…"
  function segmentBetween(text, label, nextLabels) {
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

  // ── 詳細ボタンの a から、その物件1行分のコンテナ(roomBox)を特定 ──
  // 行コンテナは「部屋番号」テキストと詳細ボタンの両方を含む最小の祖先。
  function getRoomBox(link) {
    const btn = link.closest('.CommonButton');
    if (!btn) return null;
    let el = btn;
    for (let i = 0; i < 6 && el; i++) {
      el = el.parentElement;
      if (!el) break;
      const t = el.textContent || '';
      if (t.indexOf('部屋番号') !== -1 && el.querySelector('.CommonButton.isDetail')) {
        return el;
      }
    }
    return null;
  }

  // ── roomBox から、その物件が属する建物カードを特定 ──
  // 建物カード = 住所(都道府県＋市区町村)テキストを含む最小の祖先。
  function getBuildingCard(roomBox) {
    let el = roomBox;
    for (let i = 0; i < 15 && el; i++) {
      el = el.parentElement;
      if (!el || el === document.body) break;
      if (ADDR_RE.test(el.textContent || '')) return el;
    }
    return null;
  }

  // ── 末端要素（子を持たない）のテキストを文書順に収集 ──
  function leafTexts(root) {
    const out = [];
    if (!root) return out;
    const els = root.querySelectorAll('*');
    for (const el of els) {
      if (el.children.length === 0) {
        const t = (el.textContent || '').trim();
        if (t) out.push(t);
      }
    }
    return out;
  }

  // ── 建物カードから 物件名・住所・駅・築年・階建て を抽出 ──
  // 自動検索(API)の parseItandiSearchResponse と同じ項目を一覧 DOM から揃える。
  function parseBuilding(card) {
    const res = { buildingName: '', address: '', stationInfo: '', otherStations: [], buildingAge: '', storyText: '' };
    if (!card) return res;
    const leaves = leafTexts(card);
    let addrIdx = -1;
    for (let i = 0; i < leaves.length; i++) {
      if (ADDR_RE.test(leaves[i])) { addrIdx = i; break; }
    }
    if (addrIdx < 0) return res;
    res.address = leaves[addrIdx].replace(/\s+/g, ' ').trim();

    // 物件名: 住所の直前の、メタ情報(「N枚」など)でない末端テキスト
    for (let j = addrIdx - 1; j >= 0; j--) {
      const cand = leaves[j];
      if (/^\d+枚$/.test(cand)) continue;
      if (!cand) continue;
      res.buildingName = cand;
      break;
    }

    // 駅: 住所より後で「徒歩◯分」を含む末端テキストを順に収集。
    //     1つ目を station_info、2つ目以降を other_stations（自動検索と同じ構成）。
    const stations = [];
    const seenStation = {};
    for (let k = addrIdx + 1; k < leaves.length; k++) {
      if (/徒歩\s*\d+\s*分/.test(leaves[k])) {
        const st = leaves[k].replace(/\s+/g, ' ').trim();
        if (st && !seenStation[st]) { seenStation[st] = true; stations.push(st); }
      }
    }
    if (stations.length) {
      res.stationInfo = stations[0];
      res.otherStations = stations.slice(1);
    }

    // 階建て: 「◯階建」（建物の総階数、自動検索の story_text 相当）
    for (let s = addrIdx + 1; s < leaves.length; s++) {
      const sm = leaves[s].match(/(\d+階建)/);
      if (sm) { res.storyText = sm[1]; break; }
    }

    // 築年: 「YYYY年M月」と「(築N年)/新築」を組み合わせる（自動検索の building_age 形式）
    let ym = '', age = '';
    for (let m = addrIdx + 1; m < leaves.length; m++) {
      const lt = leaves[m];
      if (!ym) {
        const ymM = lt.match(/(\d{4})年\s*(\d{1,2})月/);
        if (ymM) ym = ymM[1] + '年' + ymM[2] + '月';
      }
      if (!age) {
        const ageM = lt.match(/(築\d+年|新築)/);
        if (ageM) age = ageM[1];
      }
      if (ym && age) break;
    }
    if (ym && age) res.buildingAge = ym + '(' + age + ')';
    else res.buildingAge = age || ym || '';

    return res;
  }

  // ── roomBox から 部屋番号・賃料・管理費・敷金・礼金・間取り・面積 を抽出 ──
  function parseRoom(roomBox) {
    const res = { roomNumber: '', rent: 0, managementFee: 0, deposit: '', keyMoney: '', layout: '', area: 0 };
    const text = (roomBox.textContent || '').replace(/ /g, ' ');

    // 部屋番号
    let roomNumber = segmentBetween(text, '部屋番号', ['賃管共', '賃料', '賃']);
    roomNumber = roomNumber.replace(/\s+/g, ' ').trim();
    if (!roomNumber) {
      const ps = roomBox.querySelector('[class*="PrimaryText"]');
      if (ps) roomNumber = ps.textContent.trim();
    }
    res.roomNumber = roomNumber;

    // 賃料・管理費（賃管共: 賃料/管理費/共益費）
    const chinkan = segmentBetween(text, '賃管共', ['敷礼保', '敷', '間取り', '内見']);
    if (chinkan) {
      const parts = chinkan.split('/');
      res.rent = parseMoney(parts[0] || '');
      res.managementFee = parseMoney(parts[1] || '') + parseMoney(parts[2] || '');
    } else {
      const rm = text.match(/([\d.]+)万円/);
      if (rm) res.rent = Math.round(parseFloat(rm[1]) * 10000);
    }

    // 敷金・礼金（敷礼保: 敷金/礼金/保証金）
    const shiki = segmentBetween(text, '敷礼保', ['間取り', '内見・申込', '内見']);
    if (shiki) {
      const parts = shiki.split('/');
      res.deposit = cleanVal(parts[0] || '');
      res.keyMoney = cleanVal(parts[1] || '');
    }

    // 間取り・面積
    const madori = segmentBetween(text, '間取り', ['内見・申込', '内見', '入居']);
    const lm = madori.match(/(\d+[SLDKR]+)/);
    if (lm) res.layout = lm[1];
    else if (/ワンルーム/.test(madori)) res.layout = '1R';
    const am = madori.match(/([\d.]+)\s*㎡/);
    if (am) res.area = parseFloat(am[1]);

    return res;
  }

  // ─────────────────────────────────────────────
  // 手動送信パネル用アダプタ（itandi 検索結果一覧）
  // ─────────────────────────────────────────────
  const itandiManualAdapter = {
    source: 'itandi',
    collect: function () {
      const out = [];
      const seen = {};
      const cardCache = new Map();
      const links = document.querySelectorAll('.CommonButton.isDetail a[href*="/rent_rooms/"]');
      links.forEach(function (link) {
        const m = (link.href || '').match(/\/rent_rooms\/(\d+)/);
        if (!m) return;
        const roomId = m[1];
        if (seen[roomId]) return;

        const roomBox = getRoomBox(link);
        if (!roomBox) return;
        seen[roomId] = true;

        const card = getBuildingCard(roomBox);
        let bld = cardCache.get(card);
        if (!bld) { bld = parseBuilding(card); cardCache.set(card, bld); }

        const room = parseRoom(roomBox);
        if (!bld.buildingName) return;

        const prop = {
          source: 'itandi',
          room_id: 'itandi_' + roomId,
          building_name: bld.buildingName,
          room_number: room.roomNumber || '',
          rent: room.rent || 0,
          management_fee: room.managementFee || 0,
          deposit: room.deposit || '',
          key_money: room.keyMoney || '',
          layout: room.layout || '',
          area: room.area || 0,
          building_age: bld.buildingAge || '',
          station_info: bld.stationInfo || '',
          other_stations: bld.otherStations || [],
          story_text: bld.storyText || '',
          address: bld.address || '',
          image_url: '',
          image_urls: [],
          url: ITANDI_BASE + '/rent_rooms/' + roomId,
        };
        out.push({ rowEl: roomBox, prop: prop });
      });
      return out;
    }
  };

  // 検索結果が描画されたらパネルを初期化（React SPA のため遅延描画をポーリング）。
  (function waitForItandiResults() {
    if (window.__itandiManualInit) return;
    if (!window.ManualSendPanel) { setTimeout(waitForItandiResults, 600); return; }
    if (document.querySelector('.CommonButton.isDetail a[href*="/rent_rooms/"]')) {
      window.__itandiManualInit = true;
      window.ManualSendPanel.init(itandiManualAdapter);
      return;
    }
    setTimeout(waitForItandiResults, 1000);
  })();

})();
