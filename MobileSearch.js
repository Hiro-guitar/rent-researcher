/**
 * スマホから物件検索を回す
 *
 * 物件検索はサイトのCookieとDOM操作が要るので、スマホ単体では実行できない。
 * そこで「スマホで顧客を選んで指示を置く → PCの拡張が拾って実行する」形にする。
 * 結果は今まで通り承認待ちとDiscord通知に出るので、結果を見る画面は作らない。
 *
 * ⚠️ PCのChromeが起動していないと実行されない。指示は溜まったまま残る。
 *    画面に「PCが最後に見にきた時刻」を出して、動いているか分かるようにしてある。
 */

var MOBILE_SEARCH_KEY = 'MOBILE_SEARCH_REQUEST';   // 指示（1件だけ持つ）
var MOBILE_SEARCH_SEEN = 'MOBILE_SEARCH_LAST_SEEN'; // 拡張が最後に見にきた時刻

/** 顧客フィルタと同じキーの作り方（本人=名前 / おすすめ=rec::ID） */
function _mobileCritKey_(c) {
  return (c && c.recommend) ? ('rec::' + (c.recommendId || c.name)) : (c ? c.name : '');
}

/**
 * スマホの画面に出す顧客一覧。
 * 拡張の顧客フィルタ（log.html）と同じ並び — 本人のすぐ下にその人のおすすめ条件。
 */
function _mobileCustomerList_() {
  var res = {};
  try {
    res = JSON.parse(handleGetCriteria({ parameter: {} }).getContent());
  } catch (e) {
    return [];
  }
  var all = (res && res.criteria) || [];
  var order = [];
  var byName = {};
  for (var i = 0; i < all.length; i++) {
    var c = all[i];
    var nm = c.name || '';
    if (!byName[nm]) { byName[nm] = { base: [], rec: [] }; order.push(nm); }
    (c.recommend ? byName[nm].rec : byName[nm].base).push(c);
  }
  var out = [];
  for (var o = 0; o < order.length; o++) {
    var g = byName[order[o]];
    for (var b = 0; b < g.base.length; b++) {
      out.push({ key: _mobileCritKey_(g.base[b]), name: order[o], recommend: false, label: '' });
    }
    for (var r = 0; r < g.rec.length; r++) {
      out.push({
        key: _mobileCritKey_(g.rec[r]), name: order[o], recommend: true,
        label: g.rec[r].recommendLabel || 'おすすめ条件'
      });
    }
  }
  return out;
}

/** 拡張が指示を取りに来る。api_key必須。 */
function handleSearchRequestPoll(json) {
  var props = PropertiesService.getScriptProperties();
  props.setProperty(MOBILE_SEARCH_SEEN, String(Date.now()));
  var raw = props.getProperty(MOBILE_SEARCH_KEY);
  var req = null;
  if (raw) { try { req = JSON.parse(raw); } catch (e) {} }
  return ContentService.createTextOutput(JSON.stringify({
    ok: true,
    request: (req && req.status === 'pending') ? req : null
  })).setMimeType(ContentService.MimeType.JSON);
}

/** 拡張が「実行した」と報告してくる。api_key必須。 */
function handleSearchRequestDone(json) {
  var props = PropertiesService.getScriptProperties();
  var raw = props.getProperty(MOBILE_SEARCH_KEY);
  var req = null;
  if (raw) { try { req = JSON.parse(raw); } catch (e) {} }
  if (req && String(req.id) === String(json.id)) {
    req.status = 'done';
    req.doneAt = Date.now();
    req.result = String(json.result || '');
    props.setProperty(MOBILE_SEARCH_KEY, JSON.stringify(req));
  }
  return ContentService.createTextOutput(JSON.stringify({ ok: true }))
    .setMimeType(ContentService.MimeType.JSON);
}

/** スマホから指示を置く（画面のフォームから来る） */
function _mobileSaveRequest_(keys) {
  var props = PropertiesService.getScriptProperties();
  var req = {
    id: 'ms' + Date.now(),
    keys: keys,
    status: 'pending',
    requestedAt: Date.now()
  };
  props.setProperty(MOBILE_SEARCH_KEY, JSON.stringify(req));
  return req;
}

function _mobileAgo_(ms) {
  if (!ms) return '—';
  var d = Date.now() - Number(ms);
  if (d < 60000) return Math.floor(d / 1000) + '秒前';
  if (d < 3600000) return Math.floor(d / 60000) + '分前';
  if (d < 86400000) return Math.floor(d / 3600000) + '時間前';
  return Math.floor(d / 86400000) + '日前';
}

/**
 * スマホ用の検索指示ページ。
 * GET  … 顧客を選ぶ画面
 * POST … 指示を置いて、置けたことを表示
 */
function handleMobileSearchPage(e) {
  var props = PropertiesService.getScriptProperties();
  var params = (e && e.parameter) || {};

  var justSent = null;
  if (params.keys !== undefined) {
    var keys = String(params.keys || '').split('\n')
      .map(function (k) { return k.trim(); })
      .filter(function (k) { return k; });
    if (keys.length) justSent = _mobileSaveRequest_(keys);
  }

  var lastSeen = Number(props.getProperty(MOBILE_SEARCH_SEEN) || 0);
  var raw = props.getProperty(MOBILE_SEARCH_KEY);
  var cur = null;
  if (raw) { try { cur = JSON.parse(raw); } catch (eP) {} }

  var list = _mobileCustomerList_();
  var apiKey = String(params.api_key || '');

  var h = [];
  h.push('<!DOCTYPE html><html lang="ja"><head><meta charset="utf-8">');
  h.push('<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">');
  h.push('<title>物件検索を回す</title><style>');
  h.push('*{box-sizing:border-box}');
  h.push('body{margin:0;padding:14px 14px 96px;background:#181818;color:#eee;'
    + 'font-family:-apple-system,BlinkMacSystemFont,"Hiragino Kaku Gothic ProN",sans-serif;font-size:15px}');
  h.push('h1{font-size:17px;margin:0 0 4px}');
  h.push('.sub{font-size:12px;color:#999;margin-bottom:14px;line-height:1.6}');
  h.push('.warn{background:#3a2a12;border:1px solid #6b4c14;color:#f0c674;'
    + 'border-radius:8px;padding:10px 12px;font-size:12px;margin-bottom:14px;line-height:1.6}');
  h.push('.ok{background:#1d3320;border:1px solid #2f6b3a;color:#a6e3ad;'
    + 'border-radius:8px;padding:12px;font-size:13px;margin-bottom:14px;line-height:1.7}');
  // タップしやすいよう1行1人。指を置ける高さを確保する
  h.push('label.row{display:flex;align-items:center;gap:10px;padding:12px 12px;'
    + 'background:#232323;border:1px solid #383838;border-radius:10px;margin-bottom:7px}');
  h.push('label.row.rec{margin-left:22px;background:#1e2418;border-color:#3c4a2c}');
  h.push('input[type=checkbox]{width:22px;height:22px;accent-color:#8ec41d;flex:0 0 22px;margin:0}');
  h.push('.nm{font-weight:600}.lb{font-size:12px;color:#9c9}');
  h.push('.bar{position:fixed;left:0;right:0;bottom:0;padding:12px 14px calc(12px + env(safe-area-inset-bottom));'
    + 'background:#111;border-top:1px solid #333;display:flex;gap:10px;align-items:center}');
  h.push('button{flex:1;padding:15px;border:none;border-radius:10px;font-size:16px;font-weight:700;'
    + 'background:#8ec41d;color:#141414}');
  h.push('button:disabled{background:#444;color:#888}');
  h.push('.mini{padding:9px 14px;background:#2a2a2a;color:#ddd;border:1px solid #444;'
    + 'border-radius:8px;font-size:13px;font-weight:400;flex:0 0 auto}');
  h.push('.cnt{font-size:13px;color:#aaa;flex:0 0 auto}');
  h.push('</style></head><body>');

  h.push('<h1>物件検索を回す</h1>');
  h.push('<div class="sub">選んだお客さんの条件だけ検索します。'
    + '結果は今までどおり承認待ちとDiscordに出ます。<br>'
    + 'PCの検索を止めたり、顧客フィルタを変えたりはしません。</div>');

  if (justSent) {
    h.push('<div class="ok">✅ 指示を置きました（' + justSent.keys.length + '件）<br>'
      + 'PCのChromeが次に確認したときに実行されます。結果はDiscordに出ます。</div>');
  }

  // PCが動いているかを出す。これが古いと、指示を置いても実行されない。
  var seenAgo = _mobileAgo_(lastSeen);
  var stale = !lastSeen || (Date.now() - lastSeen > 10 * 60 * 1000);
  if (stale) {
    h.push('<div class="warn">⚠ PCが最後に確認しにきたのは <b>' + seenAgo + '</b> です。<br>'
      + 'PCのChromeが起動していないと実行されません。指示は消えずに残るので、'
      + 'PCを起動すれば実行されます。</div>');
  } else {
    h.push('<div class="sub">PCの確認: ' + seenAgo
      + (cur && cur.status === 'pending' ? ' ／ <b>実行待ちの指示があります</b>' : '') + '</div>');
  }

  h.push('<form method="get">');
  h.push('<input type="hidden" name="action" value="mobile_search">');
  if (apiKey) h.push('<input type="hidden" name="api_key" value="' + _mobileEsc_(apiKey) + '">');
  h.push('<input type="hidden" name="keys" id="keys">');

  for (var i = 0; i < list.length; i++) {
    var it = list[i];
    h.push('<label class="row' + (it.recommend ? ' rec' : '') + '">'
      + '<input type="checkbox" class="cb" value="' + _mobileEsc_(it.key) + '">'
      + '<span class="nm">' + _mobileEsc_(it.name) + '</span>'
      + (it.recommend ? '<span class="lb">↳ ' + _mobileEsc_(it.label) + '</span>' : '')
      + '</label>');
  }

  h.push('<div class="bar">'
    + '<span class="mini" onclick="setAll(false)">全解除</span>'
    + '<span class="cnt" id="cnt">0件</span>'
    + '<button type="submit" id="go" disabled>検索する</button>'
    + '</div>');
  h.push('</form>');

  h.push('<script>'
    + 'var cbs=[].slice.call(document.querySelectorAll(".cb"));'
    + 'function upd(){var s=cbs.filter(function(c){return c.checked});'
    + 'document.getElementById("cnt").textContent=s.length+"件";'
    + 'document.getElementById("go").disabled=(s.length===0);'
    + 'document.getElementById("keys").value=s.map(function(c){return c.value}).join("\\n");}'
    + 'function setAll(v){cbs.forEach(function(c){c.checked=v});upd();}'
    + 'cbs.forEach(function(c){c.addEventListener("change",upd)});upd();'
    + '</script>');

  h.push('</body></html>');

  return HtmlService.createHtmlOutput(h.join(''))
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setTitle('物件検索を回す');
}

function _mobileEsc_(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
