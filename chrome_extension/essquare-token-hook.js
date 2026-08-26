/**
 * essquare-token-hook.js — いい生活(ES-Square)のAPIトークンを拾う
 *
 * ES-Squareの物件データAPIはCookieでは通らず、Auth0のアクセストークンが要る。
 * トークンはSDKがメモリに持っていて localStorage には無いので、
 * アプリ自身が送っている Authorization ヘッダを横取りする。
 *
 * ・MAINワールド／document_start で動かす必要がある
 *   （分離ワールドからは XMLHttpRequest.prototype への差し込みがページに効かない）
 * ・拾った値は DOM の data 属性に置く。DOMは分離ワールドと共有されるので、
 *   postMessage の往復なしに background から executeScript で読める
 * ・ホストごとに形式が違う（api.e-bukken-1.com は "Bearer x"、
 *   api.rent.es-square.net は生のJWT）。加工せずそのまま保存する
 * ・ページが元々持っているトークンを写すだけなので、新たな露出は増やさない
 */
(function () {
  'use strict';
  if (window.__esqTokenHook) return;
  window.__esqTokenHook = true;

  const ATTR = 'esqTokens';

  function save(host, value) {
    if (!host || !value) return;
    try {
      const el = document.documentElement;
      const cur = JSON.parse(el.dataset[ATTR] || '{}');
      if (cur[host] === value) return;
      cur[host] = value;
      el.dataset[ATTR] = JSON.stringify(cur);
    } catch (e) {}
  }

  function hostOf(u) {
    try { return new URL(String(u), location.href).host; } catch (e) { return ''; }
  }

  // XHR
  const open = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (m, u) {
    this.__esqUrl = String(u);
    return open.apply(this, arguments);
  };
  const setHeader = XMLHttpRequest.prototype.setRequestHeader;
  XMLHttpRequest.prototype.setRequestHeader = function (k, v) {
    try {
      if (/^authorization$/i.test(k)) save(hostOf(this.__esqUrl), String(v));
    } catch (e) {}
    return setHeader.apply(this, arguments);
  };

  // fetch（SDKがfetchを使う場合に備えて両方見る）
  const origFetch = window.fetch;
  window.fetch = function (input, init) {
    try {
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      let auth = '';
      if (init && init.headers) {
        const h = init.headers;
        if (typeof h.get === 'function') auth = h.get('authorization') || '';
        else for (const k in h) if (/^authorization$/i.test(k)) auth = h[k];
      } else if (input && input.headers && typeof input.headers.get === 'function') {
        auth = input.headers.get('authorization') || '';
      }
      if (auth) save(hostOf(url), String(auth));
    } catch (e) {}
    return origFetch.apply(this, arguments);
  };
})();
