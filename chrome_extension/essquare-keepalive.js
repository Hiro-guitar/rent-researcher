/**
 * essquare-keepalive.js
 * ES-Square のすべてのページ (検索結果/詳細) に注入される軽量 content script。
 *
 * 目的: バックグラウンドタブの throttling 回避のため、無音 audio を再生して
 *       タブを audible 状態に維持する。
 *
 * 経緯 (2026-05-05):
 *   essquare-content-detail.js は物件詳細ページにしか注入されないため、
 *   検索結果ページの広告可チェック (100件 tooltip ホバー) で throttling 直撃。
 *   keepalive はすべての ES-Square ページに注入されて audio を起動する。
 */
(() => {
  'use strict';

  // 重複注入防止
  if (window.__essquareKeepaliveLoaded) return;
  window.__essquareKeepaliveLoaded = true;

  // ダッシュボードログに転送 (タブを開かずに状態確認するため)
  function diagToBg(msg) {
    try { console.log('[ES-Square keepalive]', msg); } catch (e) {}
    try {
      chrome.runtime.sendMessage({ type: 'DEBUG_LOG', message: '[ES-Square keepalive] ' + msg }, () => {
        if (chrome.runtime.lastError) {} // 無視
      });
    } catch (e) {}
  }

  function startSilentAudio() {
    if (window.__essquareSilentAudio) return;
    const urlPath = (location.pathname || '').slice(0, 40);
    try {
      const audio = new Audio();
      // 約1秒の無音 WAV (8kHz mono 16bit)
      audio.src = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=';
      audio.loop = true;
      audio.volume = 0.001;
      audio.muted = false; // muted=true だと audible 判定にならない
      window.__essquareSilentAudio = audio;
      audio.play().then(() => {
        diagToBg('audio起動OK ' + urlPath);
      }).catch((err) => {
        // autoplay blocked: 初回 user gesture を待って再試行
        diagToBg('audio autoplay失敗(' + (err && err.message || '?') + ') ' + urlPath);
        const tryStart = () => {
          audio.play().then(() => {
            diagToBg('audio起動OK(user gesture後) ' + urlPath);
          }).catch(() => {});
          ['click','keydown','touchstart','pointerdown'].forEach(ev =>
            document.removeEventListener(ev, tryStart, true));
        };
        ['click','keydown','touchstart','pointerdown'].forEach(ev =>
          document.addEventListener(ev, tryStart, { capture: true, passive: true }));
      });
    } catch (e) {
      diagToBg('audio init失敗: ' + (e && e.message || '?'));
    }
  }
  startSilentAudio();
})();
