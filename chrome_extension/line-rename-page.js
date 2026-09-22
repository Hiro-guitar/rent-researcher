/**
 * line-rename-page.js — ページ本体の世界で動く小さな見張り（content script / world: MAIN）
 *
 * なぜ要るか（2026-09-22）:
 *   chat.line.biz の改名APIは X-XSRF-TOKEN が無いと 403 を返す。
 *   ところがそのトークンは document.cookie に入っていない（見えるのは解析用のものだけ）。
 *   ページがどこから読んでいるのかを当てにいくより、
 *   **ページが実際に送っているヘッダーをそのまま借りる**ほうが確実で、
 *   LINE側が保存場所を変えても追随できる。
 *
 *   x-oa-chat-client-version も同じやり方で手に入る。
 *
 * ⚠️ これは通信を覗いているのではない。自分のページが自分のサーバーに送る
 *   ヘッダーの名前と値を控えているだけ。外には出さない。
 * ⚠️ 隔離された世界（ふつうの content script）からは本家の XHR を書き換えられない。
 *   そのため manifest で world: MAIN を指定している。
 */

(function () {
  'use strict';

  var WANT = /^(x-xsrf-token|x-oa-chat-client-version)$/i;
  var found = {};

  function note(k, v) {
    try {
      k = String(k || '').toLowerCase();
      v = (v == null) ? '' : String(v);
      if (!WANT.test(k) || !v || found[k] === v) return;
      found[k] = v;
      window.postMessage({ __lineRenameHeaders: true, headers: found }, location.origin);
    } catch (e) {}
  }

  var origSet = XMLHttpRequest.prototype.setRequestHeader;
  XMLHttpRequest.prototype.setRequestHeader = function (k, v) {
    note(k, v);
    return origSet.apply(this, arguments);
  };

  var origFetch = window.fetch;
  if (typeof origFetch === 'function') {
    window.fetch = function (input, init) {
      try {
        var h = (init && init.headers) || (input && input.headers);
        if (h) {
          if (typeof h.forEach === 'function') h.forEach(function (v, k) { note(k, v); });
          else Object.keys(h).forEach(function (k) { note(k, h[k]); });
        }
      } catch (e) {}
      return origFetch.apply(this, arguments);
    };
  }
})();
