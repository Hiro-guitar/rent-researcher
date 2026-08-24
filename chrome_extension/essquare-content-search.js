/**
 * essquare-content-search.js  （分離ワールド、manual-send-panel.js と同居）
 *
 * いい生活(ES-Square)の検索結果一覧に「物件をLINEで送る」パネルを対応させるアダプタ。
 * 物件情報は React Fiber にあり分離ワールドから直接読めないため、MAINワールドの
 * essquare-fiber-reader.js が各行 [data-testclass="bukkenListItem"] の情報を
 * row.dataset.essqManualProp (JSON) に書き込んでいる。ここではそれを同期で読むだけ。
 *
 * 画像・設備は一覧に無いので prop には入れない。送信時に background.js の
 * fetchEssquareDetailForManual が詳細（スライドモーダル）から補完する。
 */
(function () {
  'use strict';
  if (window.__essquareManualLoaded) return;
  window.__essquareManualLoaded = true;

  var ESSQUARE_BASE = 'https://rent.es-square.net';

  // 元付会社名は resultItemMotoduke の中。「元付」というラベルの次の要素が会社名。
  // 位置(nth-child)ではなくラベル起点にしておけば、並び順が変わっても追従できる。
  function findOwnerCompany(row) {
    try {
      var box = row.querySelector('[data-testid="resultItemMotoduke"]');
      if (!box) return '';
      var kids = Array.prototype.slice.call(box.children);
      for (var i = 0; i < kids.length - 1; i++) {
        if (kids[i].textContent.trim() !== '元付') continue;
        return kids[i + 1].textContent.trim();
      }
      // ラベルが見つからないときだけ位置で拾う
      var byPos = box.children[3];
      return byPos ? byPos.textContent.trim() : '';
    } catch (e) { return ''; }
  }

  var essquareManualAdapter = {
    source: 'essquare',
    collect: function () {
      var out = [];
      var seen = {};
      var rows = document.querySelectorAll('[data-testclass="bukkenListItem"]');
      for (var i = 0; i < rows.length; i++) {
        var row = rows[i];
        var raw = row.dataset ? row.dataset.essqManualProp : '';
        if (!raw) continue;
        var d;
        try { d = JSON.parse(raw); } catch (e) { continue; }
        if (!d || !d.uuid || seen[d.uuid]) continue;
        seen[d.uuid] = true;

        var prop = {
          source: 'essquare',
          room_id: 'essquare_' + d.uuid,
          _raw_room_id: d.uuid,
          building_name: d.building_name || '',
          room_number: d.room_number || '',
          rent: d.rent || 0,
          management_fee: d.management_fee || 0,
          deposit: d.deposit || '',
          key_money: d.key_money || '',
          layout: d.layout || '',
          area: d.area || 0,
          building_age: d.building_age || '',
          station_info: d.station_info || '',
          other_stations: d.other_stations || [],
          story_text: d.total_floors ? (d.total_floors + '階建') : '',
          address: d.address || '',
          move_in_date: d.move_in_date || '',
          lease_type: d.lease_type || '',
          renewal_fee: d.renewal_fee || '',
          contract_period: d.contract_period || '',
          listing_status: d.listing_status || '',
          image_url: '',
          image_urls: [],
          url: ESSQUARE_BASE + '/bukken/chintai/search/detail/' + d.uuid,
          // 依頼書の宛名に使う。一覧で取れれば詳細ページを開かずに済む
          owner_company: findOwnerCompany(row),
        };
        if (!prop.building_name) continue;
        out.push({ rowEl: row, prop: prop });
      }
      return out;
    }
  };

  // 検索結果とパネルの準備が整ったら init（React SPA のため遅延描画をポーリング）
  (function waitForResults() {
    if (window.__essquareManualInit) return;
    if (!window.ManualSendPanel) { setTimeout(waitForResults, 600); return; }
    var rows = document.querySelectorAll('[data-testclass="bukkenListItem"]');
    var hasData = false;
    for (var i = 0; i < rows.length; i++) {
      if (rows[i].dataset && rows[i].dataset.essqManualProp) { hasData = true; break; }
    }
    if (hasData) {
      window.__essquareManualInit = true;
      window.ManualSendPanel.init(essquareManualAdapter);
      return;
    }
    setTimeout(waitForResults, 1000);
  })();
})();
