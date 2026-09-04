/**
 * MapPage.gs — お客様向け「送った物件を地図で見る」ページのAPI
 *
 * form.ehomaki.com/map.html?t=<トークン> から呼ばれる。
 * その顧客にこれまで送った物件を、緯度経度つきで返す。
 *
 * 住所→緯度経度は国土地理院のジオコーディングAPIを使う。
 *   https://msearch.gsi.go.jp/address-search/AddressSearch?q=<住所>
 * キー不要・無料・日本の住所専用で、番地まで返る。
 * UrlFetchApp は既に使っているので、新しいOAuthスコープは増えない
 * （Mapsサービスを使うとスコープが増え、14デプロイメント全部が
 *   再承認待ちで止まるため避けている）。
 *
 * 変換した結果は「住所座標」シートに貯めて、同じ住所は二度と問い合わせない。
 */

var MAP_GEO_SHEET_NAME = '住所座標';
var MAP_PAGE_URL = 'https://form.ehomaki.com/map.html';
// 1回のリクエストで新しく変換する住所の上限。
// 初回は数十件まとめて変換することになるので、待ち時間が延びすぎないよう区切る。
// 足りない分は次に開いたときに変換される（変換済みは即返る）。
var MAP_GEOCODE_PER_REQUEST = 25;

/**
 * 顧客ごとのトークン。URLに顧客名を出さないためのもの。
 * 配信停止リンク(_generateUnsubscribeToken)と同じ作り方に揃えてある。
 */
function _customerMapToken_(customerName) {
  var secret = PropertiesService.getScriptProperties().getProperty('UNSUBSCRIBE_SECRET')
    || 'ehomaki_unsub_2026';
  var raw = 'map:' + String(customerName || '').trim() + secret;
  var digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, raw);
  return digest.map(function (b) {
    var v = (b < 0) ? b + 256 : b;
    return ('0' + v.toString(16)).slice(-2);
  }).join('').substring(0, 32);
}

/** CRMから「このお客様の地図ページのURL」を取るための関数。 */
function getCustomerMapUrl(customerName) {
  var name = String(customerName || '').trim();
  if (!name) return { ok: false, message: '顧客名が空です' };
  return { ok: true, url: MAP_PAGE_URL + '?t=' + _customerMapToken_(name) };
}

/** トークンから顧客名を引く。検索条件シートを一度なめて突き合わせる。 */
function _customerNameFromMapToken_(token) {
  token = String(token || '').trim().toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(token)) return '';
  var ss = SpreadsheetApp.openById(CRITERIA_SHEET_ID);
  var sheet = ss.getSheetByName(CRITERIA_SHEET_NAME);
  if (!sheet) return '';
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return '';
  var names = sheet.getRange(2, 2, lastRow - 1, 1).getValues();
  var seen = {};
  for (var i = 0; i < names.length; i++) {
    var n = String(names[i][0] || '').trim();
    if (!n || seen[n]) continue;
    seen[n] = true;
    if (_customerMapToken_(n) === token) return n;
  }
  return '';
}

/** 住所座標シートを用意して返す。 */
function _mapGeoSheet_() {
  var ss = SpreadsheetApp.openById(CRITERIA_SHEET_ID);
  var sheet = ss.getSheetByName(MAP_GEO_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(MAP_GEO_SHEET_NAME);
    sheet.appendRow(['住所', '緯度', '経度', '取得日時', '正規化された住所']);
  }
  return sheet;
}

/**
 * 住所を国土地理院に問い合わせて緯度経度にする。
 * @return {{lat:number, lng:number, title:string}|null} 取れなければ null
 */
function _geocodeAddressViaGsi_(address) {
  try {
    var url = 'https://msearch.gsi.go.jp/address-search/AddressSearch?q='
      + encodeURIComponent(address);
    var res = UrlFetchApp.fetch(url, {
      muteHttpExceptions: true,
      headers: { 'User-Agent': 'ehomaki-property-map' }
    });
    if (res.getResponseCode() !== 200) return null;
    var arr = JSON.parse(res.getContentText());
    if (!Array.isArray(arr) || arr.length === 0) return null;
    var c = arr[0].geometry && arr[0].geometry.coordinates;
    if (!c || c.length < 2) return null;
    var lng = Number(c[0]);
    var lat = Number(c[1]);
    if (!isFinite(lat) || !isFinite(lng)) return null;
    // 日本の範囲から外れていたら取り違えとみなす
    if (lat < 20 || lat > 46 || lng < 122 || lng > 154) return null;
    return {
      lat: lat, lng: lng,
      title: (arr[0].properties && arr[0].properties.title) || ''
    };
  } catch (e) {
    console.warn('[地図] ジオコーディング失敗(' + address + '): ' + e.message);
    return null;
  }
}

/** 住所を正規化する。表記ゆれでキャッシュが当たらないのを減らすため。 */
function _normalizeAddressForGeo_(address) {
  return String(address || '')
    .replace(/[Ａ-Ｚａ-ｚ０-９]/g, function (ch) {
      return String.fromCharCode(ch.charCodeAt(0) - 0xFEE0);
    })
    .replace(/[\s　]+/g, '')
    .replace(/地図を見る.*$/, '')
    .trim();
}

/**
 * 住所の一覧をまとめて緯度経度にする。
 * キャッシュ(住所座標シート)にあるものはそのまま返し、
 * 無いものだけ国土地理院に聞いて、シートに書き足す。
 * @param {Array<string>} addresses
 * @return {Object} 正規化住所 -> {lat, lng}
 */
function _geocodeAddresses_(addresses) {
  var out = {};
  var sheet = _mapGeoSheet_();
  var lastRow = sheet.getLastRow();
  var cached = {};
  if (lastRow > 1) {
    var data = sheet.getRange(2, 1, lastRow - 1, 3).getValues();
    for (var i = 0; i < data.length; i++) {
      var key = _normalizeAddressForGeo_(data[i][0]);
      if (!key) continue;
      var lat = Number(data[i][1]), lng = Number(data[i][2]);
      if (isFinite(lat) && isFinite(lng) && lat !== 0) cached[key] = { lat: lat, lng: lng };
    }
  }

  var todo = [];
  var seen = {};
  for (var a = 0; a < addresses.length; a++) {
    var norm = _normalizeAddressForGeo_(addresses[a]);
    if (!norm || seen[norm]) continue;
    seen[norm] = true;
    if (cached[norm]) { out[norm] = cached[norm]; continue; }
    todo.push(norm);
  }

  var added = [];
  for (var t = 0; t < todo.length && t < MAP_GEOCODE_PER_REQUEST; t++) {
    var r = _geocodeAddressViaGsi_(todo[t]);
    if (r) {
      out[todo[t]] = { lat: r.lat, lng: r.lng };
      added.push([todo[t], r.lat, r.lng, new Date(), r.title]);
    } else {
      // 取れなかった住所も残す。毎回問い合わせに行かないようにするため。
      added.push([todo[t], '', '', new Date(), '(取得できず)']);
    }
    Utilities.sleep(200);   // 国土地理院に連続で叩きに行かない
  }
  if (added.length > 0) {
    sheet.getRange(sheet.getLastRow() + 1, 1, added.length, 5).setValues(added);
  }
  return out;
}

/**
 * 地図に出す物件を組み立てる。お客様向けページとCRMの両方から使う。
 * @param {string} name 顧客名
 */
function _buildCustomerMapPayload_(name) {
    var seen = getSeenPropertiesForResend(name) || [];
    var addresses = [];
    for (var i = 0; i < seen.length; i++) {
      // お客様向けなので、募集終了・手動で終了にしたものは出さない
      if (seen[i].manualClosed) continue;
      if (seen[i].watchOnly) continue;      // 送っていない(キャンセル待ち監視だけ)物件
      if (seen[i].address) addresses.push(seen[i].address);
    }
    var coords = _geocodeAddresses_(addresses);

    var props = [];
    var noCoord = 0;
    for (var j = 0; j < seen.length; j++) {
      var p = seen[j];
      if (p.manualClosed || p.watchOnly) continue;
      var key = _normalizeAddressForGeo_(p.address);
      var c = key ? coords[key] : null;
      if (!c) { noCoord++; continue; }
      props.push({
        roomId: p.roomId,
        name: p.buildingName + (p.roomNumber ? ' ' + p.roomNumber : ''),
        rent: p.rent || 0,
        managementFee: p.managementFee || 0,
        layout: p.layout || '',
        area: p.area || 0,
        station: p.stationInfo || '',
        image: p.imageUrl || '',
        lat: c.lat,
        lng: c.lng,
        url: 'https://form.ehomaki.com/property.html?customer='
          + encodeURIComponent(name) + '&room_id=' + encodeURIComponent(p.roomId)
      });
    }

    return {
      ok: true,
      customer: name,
      count: props.length,
      noCoord: noCoord,
      properties: props
    };
}

/**
 * doGet: action=customer_map&t=<トークン>
 * お客様向けページから呼ばれる。トークンで顧客を引く。
 */
function handleCustomerMapApi(e) {
  var out = function (obj) {
    return ContentService.createTextOutput(JSON.stringify(obj))
      .setMimeType(ContentService.MimeType.JSON);
  };
  try {
    var name = _customerNameFromMapToken_(e.parameter.t);
    if (!name) return out({ ok: false, error: 'リンクが正しくありません' });
    return out(_buildCustomerMapPayload_(name));
  } catch (err) {
    console.error('[地図] handleCustomerMapApi: ' + err.message);
    return out({ ok: false, error: err.message });
  }
}
