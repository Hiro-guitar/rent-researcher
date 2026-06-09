/**
 * gas-frame.js
 * GAS Webアプリ(/exec)を iframe で表示するための汎用ラッパー。
 *
 * GAS Webアプリを通常のタブで直接開くと Google が
 * 「このアプリケーションは Google Apps Script のユーザーによって作成されたものです」
 * バナーを自動表示する。iframe 内で表示するとこのバナーは出ない。
 *
 * 使い方:
 *   chrome.runtime.getURL('gas-frame.html') + '?t=' + encodeURIComponent(タイトル) + '&u=' + encodeURIComponent(gasUrl)
 * を window.open / tabs.create で開く。
 */
(function () {
  'use strict';
  var params = new URLSearchParams(location.search);
  var u = params.get('u');
  var t = params.get('t');
  if (t) document.title = t;
  var f = document.getElementById('f');
  if (u) {
    f.src = u;
  } else {
    document.body.innerHTML = '<p style="color:#ccc;font-family:sans-serif;padding:24px;">URLが指定されていません（?u=...）。</p>';
  }
})();
