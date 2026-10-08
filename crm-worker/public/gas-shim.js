// GAS の替え玉（読むだけ）。Cloudflare の写し（D1）を、SpreadsheetApp などに見せかけて渡す。
// これで今の GAS のコード（CrmTree.gs など）を、ブラウザでそのまま動かせる。
// ⚠️ 書き込み（setValue・appendRow・deleteRow など）は何もしない。書くのは GAS（crm_call 経由）。
(function (G) {
  'use strict';
  var JST = 9 * 3600 * 1000;
  var pad = function (n, w) { n = String(n); while (n.length < (w || 2)) n = '0' + n; return n; };

  // 写しの行（JSON）を GAS の getValues() と同じ形に戻す。日付は {"$d": ミリ秒} → Date
  function revive(v) {
    if (v && typeof v === 'object' && !Array.isArray(v) && typeof v.$d === 'number') return new Date(v.$d);
    return v === null || v === undefined ? '' : v;
  }

  var store = { sheets: {}, writes: [] };   // シート名 → 行の配列（1行目＝見出し）

  /** 写しを入れる: { シート名: [[行番号, [セル…]], …] } */
  function loadSheets(raw) {
    Object.keys(raw || {}).forEach(function (name) {
      var rows = [];
      raw[name].forEach(function (x) {
        var r = x[0], cells = x[1];
        rows[r - 1] = (cells || []).map(revive);
      });
      var width = 0;
      for (var i = 0; i < rows.length; i++) { if (!rows[i]) rows[i] = []; if (rows[i].length > width) width = rows[i].length; }
      for (var j = 0; j < rows.length; j++) while (rows[j].length < width) rows[j].push('');
      store.sheets[name] = { rows: rows, width: width };
    });
  }

  function Range(sheet, r, c, nr, nc) { this.s = sheet; this.r = r; this.c = c; this.nr = nr; this.nc = nc; }
  Range.prototype.getValues = function () {
    var out = [];
    for (var i = 0; i < this.nr; i++) {
      var row = this.s.data.rows[this.r - 1 + i] || [];
      var o = [];
      for (var j = 0; j < this.nc; j++) { var v = row[this.c - 1 + j]; o.push(v === undefined ? '' : v); }
      out.push(o);
    }
    return out;
  };
  Range.prototype.getDisplayValues = function () { return this.getValues().map(function (r) { return r.map(function (v) { return v instanceof Date ? fmt(v, 'Asia/Tokyo', 'yyyy/MM/dd HH:mm:ss') : String(v); }); }); };
  Range.prototype.getValue = function () { return this.getValues()[0][0]; };
  Range.prototype.getDisplayValue = function () { return this.getDisplayValues()[0][0]; };
  Range.prototype.getRow = function () { return this.r; };
  Range.prototype.getNumRows = function () { return this.nr; };
  Range.prototype.getLastRow = function () { return this.r + this.nr - 1; };
  // 書き込みは手元の写しにだけ入れる（画面をすぐ変えるため）。本当の保存は GAS がする
  function ensureCell(d, r, c) {
    while (d.rows.length < r) { var e = []; while (e.length < d.width) e.push(''); d.rows.push(e); }
    if (c > d.width) { d.width = c; d.rows.forEach(function (x) { while (x.length < d.width) x.push(''); }); }
  }
  Range.prototype.setValues = function (vals) {
    var d = this.s.data;
    for (var i = 0; i < vals.length; i++) for (var j = 0; j < vals[i].length; j++) {
      ensureCell(d, this.r + i, this.c + j);
      d.rows[this.r - 1 + i][this.c - 1 + j] = vals[i][j];
    }
    store.writes.push(this.s.name + '.setValues');
    return this;
  };
  Range.prototype.setValue = function (v) { return this.setValues([[v]]); };
  Range.prototype.clearContent = function () {
    var vals = []; for (var i = 0; i < this.nr; i++) { var row = []; for (var j = 0; j < this.nc; j++) row.push(''); vals.push(row); }
    return this.setValues(vals);
  };
  ['setNumberFormat', 'setNumberFormats', 'setWrapStrategy', 'setFontWeight', 'setBackground', 'clear', 'setFormula']
    .forEach(function (m) { Range.prototype[m] = function () { return this; }; });

  function Sheet(name, data) { this.name = name; this.data = data; }
  Sheet.prototype.getName = function () { return this.name; };
  Sheet.prototype.getLastRow = function () { return this.data.rows.length; };
  Sheet.prototype.getLastColumn = function () { return this.data.width; };
  Sheet.prototype.getMaxRows = function () { return this.data.rows.length; };
  Sheet.prototype.getMaxColumns = function () { return this.data.width; };
  Sheet.prototype.getDataRange = function () { return new Range(this, 1, 1, this.getLastRow(), this.getLastColumn()); };
  Sheet.prototype.getRange = function (r, c, nr, nc) {
    if (typeof r === 'string') throw new Error('替え玉は A1 形式の getRange に未対応: ' + r);
    return new Range(this, r, c, nr === undefined ? 1 : nr, nc === undefined ? 1 : nc);
  };
  Sheet.prototype.appendRow = function (vals) {
    var d = this.data;
    ensureCell(d, d.rows.length + 1, vals.length);
    var row = d.rows[d.rows.length - 1];
    for (var j = 0; j < vals.length; j++) row[j] = vals[j];
    store.writes.push(this.name + '.appendRow');
    return this;
  };
  Sheet.prototype.deleteRow = function (r) { this.data.rows.splice(r - 1, 1); store.writes.push(this.name + '.deleteRow'); return this; };
  Sheet.prototype.deleteRows = function (r, n) { this.data.rows.splice(r - 1, n); store.writes.push(this.name + '.deleteRows'); return this; };
  ['insertRowAfter', 'insertRowBefore', 'setFrozenRows', 'hideSheet', 'autoResizeColumns', 'setColumnWidth', 'insertRows']
    .forEach(function (m) { Sheet.prototype[m] = function () { return this; }; });

  var spreadsheet = {
    getSheetByName: function (n) { var d = store.sheets[n]; return d ? new Sheet(n, d) : null; },
    getSheets: function () { return Object.keys(store.sheets).map(function (n) { return new Sheet(n, store.sheets[n]); }); },
    insertSheet: function (n) { store.writes.push('insertSheet:' + n); store.sheets[n] = store.sheets[n] || { rows: [], width: 0 }; return new Sheet(n, store.sheets[n]); },
    getId: function () { return 'mirror'; }
  };

  // Utilities.formatDate（Java の書式の一部）。Asia/Tokyo 固定（夏時間なし）
  var WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  function fmt(date, tz, f) {
    var d = new Date(new Date(date).getTime() + JST);
    var map = {
      yyyy: d.getUTCFullYear(), yy: pad(d.getUTCFullYear() % 100), MM: pad(d.getUTCMonth() + 1), M: d.getUTCMonth() + 1,
      dd: pad(d.getUTCDate()), d: d.getUTCDate(), HH: pad(d.getUTCHours()), H: d.getUTCHours(),
      mm: pad(d.getUTCMinutes()), m: d.getUTCMinutes(), ss: pad(d.getUTCSeconds()), s: d.getUTCSeconds(),
      E: WD[d.getUTCDay()], EEE: WD[d.getUTCDay()], SSS: pad(d.getUTCMilliseconds(), 3)
    };
    return String(f).replace(/'([^']*)'|yyyy|yy|MM|M|dd|d|HH|H|mm|m|ss|s|SSS|EEE|E/g, function (t, lit) {
      if (lit !== undefined) return lit;
      return String(map[t]);
    });
  }

  var memCache = {};
  var cache = {
    get: function (k) { var x = memCache[k]; return x && x.exp > Date.now() ? x.v : null; },
    getAll: function (ks) { var o = {}; ks.forEach(function (k) { var v = cache.get(k); if (v !== null) o[k] = v; }); return o; },
    put: function (k, v, sec) { memCache[k] = { v: String(v), exp: Date.now() + (sec || 600) * 1000 }; },
    putAll: function (o, sec) { Object.keys(o).forEach(function (k) { cache.put(k, o[k], sec); }); },
    remove: function (k) { delete memCache[k]; },
    removeAll: function (ks) { ks.forEach(function (k) { delete memCache[k]; }); }
  };
  var props = {};
  var propSvc = {
    getProperty: function (k) { return props[k] === undefined ? null : props[k]; },
    getProperties: function () { return Object.assign({}, props); },
    setProperty: function (k, v) { store.writes.push('prop:' + k); return propSvc; },
    setProperties: function () { store.writes.push('props'); return propSvc; },
    deleteProperty: function () { return propSvc; }
  };

  // 取っておいた外のデータ（祝日など）。fetch はこれだけ返す
  var fetchCache = {};
  function resp(text, code) {
    return { getContentText: function () { return text; }, getResponseCode: function () { return code || 200; }, getBlob: function () { return null; }, getHeaders: function () { return {}; } };
  }

  // 変わった行だけ差し替える（/api/delta）。消えた行は rows（今の行数）で切り詰める
  function patchRow(name, r, cells) {
    var d = store.sheets[name] || (store.sheets[name] = { rows: [], width: 0 });
    var row = (cells || []).map(revive);
    if (row.length > d.width) { d.width = row.length; d.rows.forEach(function (x) { while (x.length < d.width) x.push(''); }); }
    while (row.length < d.width) row.push('');
    while (d.rows.length < r - 1) { var e = []; while (e.length < d.width) e.push(''); d.rows.push(e); }
    d.rows[r - 1] = row;
  }
  function truncate(name, n) { var d = store.sheets[name]; if (d && d.rows.length > n) d.rows.length = n; }
  function clearCache() { memCache = {}; }
  G.GasShim = { patchRow: patchRow, truncate: truncate, clearCache: clearCache, loadSheets: loadSheets, store: store, setProps: function (o) { props = Object.assign({}, o); }, setFetch: function (u, t) { fetchCache[u] = t; } };
  G.SpreadsheetApp = { openById: function () { return spreadsheet; }, getActiveSpreadsheet: function () { return spreadsheet; }, flush: function () {}, WrapStrategy: { CLIP: 'CLIP', WRAP: 'WRAP' } };
  G.Utilities = {
    formatDate: fmt, sleep: function () {}, getUuid: function () { return (G.crypto && G.crypto.randomUUID) ? G.crypto.randomUUID() : String(Math.random()).slice(2); },
    base64Encode: function (s) { return G.btoa(unescape(encodeURIComponent(s))); }, base64Decode: function () { throw new Error('替え玉では使えません'); },
    newBlob: function () { throw new Error('替え玉では使えません'); }, Charset: { UTF_8: 'UTF-8' }, DigestAlgorithm: { MD5: 'MD5', SHA_256: 'SHA_256' },
    computeDigest: function () { throw new Error('替え玉では使えません'); }
  };
  G.CacheService = { getScriptCache: function () { return cache; }, getUserCache: function () { return cache; }, getDocumentCache: function () { return cache; } };
  G.PropertiesService = { getScriptProperties: function () { return propSvc; }, getUserProperties: function () { return propSvc; } };
  G.LockService = { getScriptLock: function () { return { tryLock: function () { return true; }, waitLock: function () {}, releaseLock: function () {}, hasLock: function () { return true; } }; } };
  G.UrlFetchApp = {
    fetch: function (u) { if (fetchCache[u] !== undefined) return resp(fetchCache[u]); throw new Error('替え玉では外に取りに行けません: ' + String(u).slice(0, 80)); },
    fetchAll: function (reqs) { return reqs.map(function (r) { return G.UrlFetchApp.fetch(typeof r === 'string' ? r : r.url); }); }
  };
  G.ScriptApp = { getService: function () { return { getUrl: function () { return G.GAS_WEBAPP_URL || ''; } }; }, getProjectTriggers: function () { return []; } };
  G.Logger = { log: function () { if (G.GAS_SHIM_VERBOSE) console.log.apply(console, arguments); } };
  G.HtmlService = { XFrameOptionsMode: { ALLOWALL: 'ALLOWALL' }, createHtmlOutput: function () { throw new Error('替え玉では使えません'); } };
  G.ContentService = { MimeType: { JSON: 'JSON', TEXT: 'TEXT' }, createTextOutput: function () { throw new Error('替え玉では使えません'); } };
  G.Session = { getScriptTimeZone: function () { return 'Asia/Tokyo'; }, getActiveUser: function () { return { getEmail: function () { return ''; } }; } };
})(typeof window !== 'undefined' ? window : globalThis);
