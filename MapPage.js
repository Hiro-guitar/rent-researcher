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
 *
 * ⚠️ computeDigest は必ず UTF_8 を指定すること。
 *   2引数版 computeDigest(algorithm, value) は非ASCIIを扱えず、日本語を
 *   すべて '?' に潰してしまう。その結果「同じ文字数の日本語名は全員同じ
 *   トークン」になり、大江さま(4文字)の地図を開くと近藤麻美(4文字)の地図が
 *   出ていた（引き当ては先頭から探すので、その文字数で最初に出てくる人が返る）。
 *   配信停止リンク(_generateUnsubscribeToken)が無事なのは、ハッシュにかけるのが
 *   メールアドレス＝ASCIIだから。あちらは既に配ったリンクが変わってしまうので触らない。
 */
function _customerMapToken_(customerName) {
  var secret = PropertiesService.getScriptProperties().getProperty('UNSUBSCRIBE_SECRET')
    || 'ehomaki_unsub_2026';
  var raw = 'map:' + String(customerName || '').trim() + secret;
  var digest = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256, raw, Utilities.Charset.UTF_8);
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

/**
 * 【手動実行】住所座標シートに貯まった座標を作り直す。
 *
 * 検証を入れる前は、同じ地名の別の土地（東京の物件が北海道など）を
 * そのまま貯めていた。溜まった分は消して、次に開いたときに取り直させる。
 * シートの行を消すだけで、物件のデータには触らない。
 */
function resetGeocodeCache() {
  var sheet = _mapGeoSheet_();
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return '住所座標シートは空でした';
  var n = lastRow - 1;
  sheet.deleteRows(2, n);
  var msg = n + '件の座標を消しました。次に地図を開いたときに取り直します。';
  Logger.log(msg);
  return msg;
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
    var title = (arr[0].properties && arr[0].properties.title) || '';
    // 同じ地名の別の土地に当たっていないか確かめる
    if (!_gsiResultLooksRight_(address, title)) {
      console.log('[地図] 別の土地に当たったので捨てる: ' + address + ' → ' + title);
      return null;
    }
    return { lat: lat, lng: lng, title: title };
  } catch (e) {
    console.warn('[地図] ジオコーディング失敗(' + address + '): ' + e.message);
    return null;
  }
}

/** 住所から都道府県を取り出す。無ければ空。 */
function _addressPrefOf_(s) {
  var m = String(s || '').match(/^(北海道|東京都|(?:京都|大阪)府|.{2,3}?県)/);
  return m ? m[1] : '';
}

/** 住所から市区町村を取り出す（政令市は「○○市○○区」まで）。無ければ空。 */
function _addressCityOf_(s) {
  var rest = String(s || '').replace(/^(北海道|東京都|(?:京都|大阪)府|.{2,3}?県)/, '');
  var m = rest.match(/^(.+?市.+?区|.+?[市区町村])/);
  return m ? m[1] : '';
}

/**
 * 国土地理院が返してきた住所が、聞いた住所と同じ土地かを確かめる。
 *
 * 国土地理院は一番それらしいものを1件返すだけなので、都道府県も市区町村も
 * 無い住所を投げると同じ地名の別の土地に当たる。実際「本町1-1」を投げたら
 * 北海道七飯町本町が返り、東京の物件が北海道にピンを立てていた。
 *
 * 返ってきた住所の都道府県か市区町村が、聞いた住所に出てくることを条件にする。
 * 判断できないものは捨てる（間違った場所にピンを立てるより、出さない方がまし。
 * 出せなかった件数はページに出している）。
 */
function _gsiResultLooksRight_(query, title) {
  var q = String(query || '');
  var t = String(title || '');
  if (!q || !t) return false;
  var pref = _addressPrefOf_(t);
  if (pref && q.indexOf(pref) >= 0) return true;
  var city = _addressCityOf_(t);
  if (city && q.indexOf(city) >= 0) return true;
  return false;
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
        // 同じ建物の別の部屋を地図でまとめるため、建物名と部屋番号は分けて渡す
        building: p.buildingName || '',
        room: p.roomNumber || '',
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

// ══════════════════════════════════════════════════════════
//  エッジ配信（Cloudflare Worker + R2）
//
//  GASのWebアプリは一番軽い応答でも3秒かかる（実測 3.0〜3.6秒）。
//  地図を開くたびに待たせることになり、お客様に出せない。
//  物件詳細ページ(property.html)が速いのと同じ理由で、先に作って
//  エッジに置き、map.html はそこから読む（実測 0.2秒）。
//
//  置き場所は m/<顧客トークン>.json。顧客ごとに同じキーへ上書きするので、
//  一度配ったURLはそのまま使い続けられる。
// ══════════════════════════════════════════════════════════

var EHOMAKI_MAP_POST_URL = 'https://ehomaki-img.delicate-bush-f5a9.workers.dev/m';
var EHOMAKI_MAP_GET_BASE = 'https://ehomaki-img.delicate-bush-f5a9.workers.dev/m/';

/** 作った地図データをエッジに置く。 */
function _publishMapToEdge_(token, payload) {
  var res = UrlFetchApp.fetch(EHOMAKI_MAP_POST_URL, {
    method: 'post',
    contentType: 'application/json; charset=utf-8',
    headers: {
      Authorization: 'Bearer ' + EHOMAKI_IMG_TOKEN,
      'x-map-key': token
    },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });
  if (res.getResponseCode() !== 200) {
    throw new Error('エッジへの保存に失敗 HTTP ' + res.getResponseCode()
      + ': ' + res.getContentText().slice(0, 120));
  }
  return true;
}

/** 1顧客ぶんだけ作り直してエッジに置く。CRMの「作り直す」から呼ぶ。 */
function rebuildCustomerMap(customerName) {
  var name = String(customerName || '').trim();
  if (!name) return { ok: false, message: '顧客名が空です' };
  try {
    var payload = _buildCustomerMapPayload_(name);
    payload.builtAt = new Date().toISOString();
    _publishMapToEdge_(_customerMapToken_(name), payload);
    return { ok: true, count: payload.count, noCoord: payload.noCoord };
  } catch (e) {
    return { ok: false, message: e.message };
  }
}

/**
 * 【日次トリガー】送付済み物件がある顧客ぶんの地図をまとめて作り直す。
 *
 * 顧客ごとに _buildCustomerMapPayload_ を呼ぶとシートを人数分読み直すことになる
 * （1人あたり16秒かかっていた）。ここではシートを1回ずつだけ読んで、
 * 顧客ごとに振り分ける。
 */
function rebuildAllCustomerMaps() {
  var t0 = Date.now();
  var ss = SpreadsheetApp.openById(SPREADSHEET_ID);

  // ── 通知済み物件を1回だけ読む ──
  var seenSheet = ss.getSheetByName(SEEN_SHEET_NAME);
  if (!seenSheet || seenSheet.getLastRow() < 2) return '通知済み物件がありません';
  var seen = seenSheet.getRange(2, 1, seenSheet.getLastRow() - 1, 16).getValues();

  // ── 承認待ち物件を1回だけ読む。顧客名+room_id で引けるようにする ──
  var pendingByKey = {};
  var pSheet = ss.getSheetByName(PENDING_SHEET_NAME);
  if (pSheet && pSheet.getLastRow() >= 2) {
    var pData = pSheet.getDataRange().getValues();
    for (var pi = 1; pi < pData.length; pi++) {
      var pStatus = String(pData[pi][10] || '');
      if (pStatus !== 'sent' && pStatus !== 'pending') continue;
      var pk = String(pData[pi][0]).trim() + '\u0000' + String(pData[pi][2]).trim();
      if (!pendingByKey[pk]) pendingByKey[pk] = pData[pi];
    }
  }

  // ── 顧客ごとに、地図に出す物件を組み立てる ──
  var byCustomer = {};
  var addresses = [];
  for (var i = 0; i < seen.length; i++) {
    var row = seen[i];
    var cust = String(row[0] || '').trim();
    if (!cust) continue;
    var status = String(row[5] || '');
    var watching = !!row[9];
    if ((status === 'closed' || status === 'applied') && !watching) continue;
    if (String(row[13] || '') === 'closed') continue;                      // 手動で募集終了
    if (String(row[14] || '').trim() === 'watch_only') continue;           // 送っていない
    var rid = String(row[1] || '').trim();
    var prow = pendingByKey[cust + '\u0000' + rid];
    if (!prow) continue;                                                    // 詳細が無ければ出せない
    var prop = _pendingRowToFlexProp_(prow);
    if (!prop || !prop.address) continue;
    if (!byCustomer[cust]) byCustomer[cust] = [];
    byCustomer[cust].push({ roomId: rid, sentAt: row[3], p: prop });
    addresses.push(prop.address);
  }

  // ── 住所をまとめて座標にする（キャッシュ済みはそのまま） ──
  var coords = _geocodeAddresses_(addresses);

  // ── 顧客ごとにエッジへ置く ──
  var done = 0, failed = 0, totalPins = 0;
  for (var cname in byCustomer) {
    var list = byCustomer[cname];
    // 送信が新しい順
    list.sort(function (a, b) {
      return String(b.sentAt || '').localeCompare(String(a.sentAt || ''));
    });
    var props = [];
    var noCoord = 0;
    for (var k = 0; k < list.length; k++) {
      var it = list[k], p = it.p;
      var c = coords[_normalizeAddressForGeo_(p.address)];
      if (!c) { noCoord++; continue; }
      props.push({
        roomId: it.roomId,
        building: p.buildingName || '',
        room: p.roomNumber || '',
        name: p.buildingName + (p.roomNumber ? ' ' + p.roomNumber : ''),
        rent: p.rent || 0,
        managementFee: p.managementFee || 0,
        layout: p.layout || '',
        area: p.area || 0,
        station: p.stationInfo || '',
        image: p.imageUrl || '',
        lat: c.lat, lng: c.lng,
        url: 'https://form.ehomaki.com/property.html?customer='
          + encodeURIComponent(cname) + '&room_id=' + encodeURIComponent(it.roomId)
      });
    }
    try {
      _publishMapToEdge_(_customerMapToken_(cname), {
        ok: true, customer: cname, count: props.length,
        noCoord: noCoord, properties: props, builtAt: new Date().toISOString()
      });
      done++;
      totalPins += props.length;
    } catch (e) {
      failed++;
      console.warn('[地図] ' + cname + ' の保存に失敗: ' + e.message);
    }
  }

  var msg = '[地図] ' + done + '名ぶんを作成（ピン計' + totalPins + '）'
    + (failed ? ' / 失敗' + failed + '名' : '')
    + ' / ' + Math.round((Date.now() - t0) / 1000) + '秒';
  console.log(msg);
  return msg;
}
