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

/**
 * スマホ検索ページのURL。CRMのリンクから呼ぶ。
 * APIキーを画面側に渡さずに済むよう、URLはサーバ側で組み立てる。
 */
function getMobileSearchUrl() {
  var baseUrl = ScriptApp.getService().getUrl();
  var apiKey = PropertiesService.getScriptProperties().getProperty('REINS_API_KEY') || '';
  return baseUrl + '?action=mobile_search&api_key=' + encodeURIComponent(apiKey);
}

/** 顧客フィルタと同じキーの作り方（本人=名前 / おすすめ=rec::ID） */
function _mobileCritKey_(c) {
  return (c && c.recommend) ? ('rec::' + (c.recommendId || c.name)) : (c ? c.name : '');
}

/**
 * スマホの画面に出す顧客一覧。
 * 拡張の顧客フィルタ（log.html）と同じ並び — 本人のすぐ下にその人のおすすめ条件。
 */
function _mobileCustomerGroups_(e) {
  var flat = _mobileCustomerList_(e);
  var order = [], by = {};
  for (var i = 0; i < flat.length; i++) {
    var it = flat[i];
    if (!by[it.name]) { by[it.name] = { name: it.name, base: [], rec: [] }; order.push(it.name); }
    (it.recommend ? by[it.name].rec : by[it.name].base).push(it);
  }
  return order.map(function (n) { return by[n]; });
}

/**
 * 顧客一覧を作る。
 *
 * 元にするのは handleGetCriteria。拡張が実際に検索する対象と同じでないと、
 * 選んでも動かない人が画面に出てしまうため。
 * ただしこの関数はLINEのブロック判定を含んでいて6秒以上かかる。
 * 画面を開くたびに待たされるので、名前とキーだけを10分キャッシュする。
 * （ブロック判定そのものの挙動は変えていない。検索側は今までどおり毎回走る）
 */
function _mobileCustomerList_(e) {
  var cache = CacheService.getScriptCache();
  var CACHE_KEY = 'mobile_customer_list_v1';
  try {
    var hit = cache.get(CACHE_KEY);
    if (hit) return JSON.parse(hit);
  } catch (eC) {}

  var res = {};
  try {
    // api_key が要る。呼び出し元の e をそのまま渡す
    res = JSON.parse(handleGetCriteria(e || { parameter: {} }).getContent());
  } catch (eP) {
    return [];
  }
  if (res && res.error) return [];
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
  try { cache.put(CACHE_KEY, JSON.stringify(out), 600); } catch (eC2) {}
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
function _mobileSaveRequest_(keys, mode) {
  var props = PropertiesService.getScriptProperties();
  var req = {
    id: 'ms' + Date.now(),
    keys: keys,
    mode: mode || 'selected',   // 'all' はPCの顧客フィルタどおりに全部回す
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
  if (params.mode === 'all') {
    // 顧客を指定しない指示。拡張はいつもどおり（PCの顧客フィルタに従って）回す。
    justSent = _mobileSaveRequest_([], 'all');
  } else if (params.keys !== undefined) {
    var keys = String(params.keys || '').split('\n')
      .map(function (k) { return k.trim(); })
      .filter(function (k) { return k; });
    if (keys.length) justSent = _mobileSaveRequest_(keys, 'selected');
  }

  var lastSeen = Number(props.getProperty(MOBILE_SEARCH_SEEN) || 0);
  var raw = props.getProperty(MOBILE_SEARCH_KEY);
  var cur = null;
  if (raw) { try { cur = JSON.parse(raw); } catch (eP) {} }

  var groups = _mobileCustomerGroups_(e);
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
  // PC版の顧客フィルタと同じ「人ごとの枠が折り返して並ぶ」形。
  // 47人を1行1人にすると延々スクロールになるので、一画面に多く入る形にする。
  // ただしタップできるよう、チェックボックスと余白はPC版より大きくする。
  h.push('.list{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:10px}');
  h.push('.grp{display:flex;flex-direction:column;gap:2px;border:1px solid #383838;'
    + 'border-radius:8px;padding:6px 10px;background:#212121}');
  h.push('.grp.on{border-color:#4a8a5c;background:#1e2a21}');
  h.push('.grp label{display:flex;align-items:center;gap:7px;white-space:nowrap;'
    + 'padding:5px 2px;margin:0;font-size:14px}');
  h.push('.grp input[type=checkbox]{width:20px;height:20px;accent-color:#8ec41d;margin:0;flex:0 0 20px}');
  h.push('.nm{font-weight:600;color:#e6e6e6}');
  h.push('.lb{color:#9cdc9c;font-size:12px}');
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
  h.push('<div class="sub">結果は今までどおり承認待ちとDiscordに出ます。</div>');

  if (justSent) {
    h.push('<div class="ok">✅ 指示を置きました（'
      + (justSent.mode === 'all' ? 'いつもの検索' : justSent.keys.length + '件') + '）<br>'
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
    h.push('<div class="sub" style="margin-bottom:10px">PCの確認: ' + seenAgo
      + (cur && cur.status === 'pending' ? ' ／ <b>実行待ちの指示あり</b>' : '') + '</div>');
  }

  // いつもの検索をそのまま回す入口。顧客を選ぶ必要がない一番よく使う操作なので上に置く。
  h.push('<form method="get" style="margin-bottom:16px">');
  h.push('<input type="hidden" name="action" value="mobile_search">');
  if (apiKey) h.push('<input type="hidden" name="api_key" value="' + _mobileEsc_(apiKey) + '">');
  h.push('<input type="hidden" name="mode" value="all">');
  h.push('<button type="submit" style="width:100%;background:#2f6b3a;color:#eaffea;padding:13px">'
    + 'いつもの検索を今すぐ回す</button>');
  h.push('<div class="sub" style="margin:5px 0 0">PCの顧客フィルタどおりの人が対象</div>');
  h.push('</form>');

  h.push('<div class="sub" style="border-top:1px solid #333;padding-top:12px;margin-bottom:8px">'
    + '<b>選んで回す</b> — フィルタに関係なく、選んだ人だけ検索します</div>');

  h.push('<form method="get">');
  h.push('<input type="hidden" name="action" value="mobile_search">');
  if (apiKey) h.push('<input type="hidden" name="api_key" value="' + _mobileEsc_(apiKey) + '">');
  h.push('<input type="hidden" name="keys" id="keys">');

  if (!groups.length) {
    h.push('<div class="warn">顧客一覧を取得できませんでした。'
      + 'URLのapi_keyが正しいか、検索条件シートに条件が入っているか確認してください。</div>');
  }
  h.push('<div class="list">');
  for (var gi = 0; gi < groups.length; gi++) {
    var g = groups[gi];
    h.push('<div class="grp">');
    for (var bi = 0; bi < g.base.length; bi++) {
      h.push('<label><input type="checkbox" class="cb" value="' + _mobileEsc_(g.base[bi].key) + '">'
        + '<span class="nm">' + _mobileEsc_(g.name) + '</span></label>');
    }
    if (!g.base.length) {
      h.push('<div class="nm" style="font-size:12px;color:#999;padding:5px 2px">'
        + _mobileEsc_(g.name) + '</div>');
    }
    for (var ri = 0; ri < g.rec.length; ri++) {
      h.push('<label><input type="checkbox" class="cb" value="' + _mobileEsc_(g.rec[ri].key) + '">'
        + '<span class="lb">↳ ' + _mobileEsc_(g.rec[ri].label) + '</span></label>');
    }
    h.push('</div>');
  }
  h.push('</div>');

  h.push('<div class="bar">'
    + '<span class="mini" onclick="setAll(true)">全選択</span>'
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
    + 'document.getElementById("keys").value=s.map(function(c){return c.value}).join("\\n");paint();}'
    + 'function setAll(v){cbs.forEach(function(c){c.checked=v});upd();}'
    + 'function paint(){[].forEach.call(document.querySelectorAll(".grp"),function(g){'
    + 'g.classList.toggle("on",!!g.querySelector(".cb:checked"))});}'
    + 'cbs.forEach(function(c){c.addEventListener("change",upd)});upd();'
    + '</script>');

  h.push('<div class="sub" style="margin-top:18px;text-align:center">'
    + '<a href="' + _mobileEsc_(getCustomerPageUrl()) + '" style="color:#569cd6">← 顧客管理に戻る</a></div>');
  h.push('</body></html>');

  return HtmlService.createHtmlOutput(h.join(''))
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setTitle('物件検索を回す');
}

function _mobileEsc_(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
