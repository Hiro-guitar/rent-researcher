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

  // Web Audio API (AudioContext + OscillatorNode) で無音を生成
  // dataURL <audio> はESQuareのCSP `media-src` 制限でブロックされるため、
  // src 不要の AudioContext を使用。
  function startSilentAudio() {
    if (window.__essquareAudioCtx) return;
    const urlPath = (location.pathname || '').slice(0, 40);
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) {
        diagToBg('AudioContext API なし');
        return;
      }
      const ctx = new Ctx();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      gain.gain.value = 0.001; // ほぼ無音 (0だと Chrome が audible 判定しない可能性)
      osc.frequency.value = 1; // 1Hz の超低周波 (人間に聴こえない)
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      window.__essquareAudioCtx = ctx;
      diagToBg('AudioContext起動 state=' + ctx.state + ' ' + urlPath);

      if (ctx.state === 'suspended') {
        ctx.resume().then(() => {
          diagToBg('AudioContext resumed state=' + ctx.state);
        }).catch((err) => {
          diagToBg('AudioContext resume失敗(' + (err && err.message || '?') + ')');
          // user gesture フォールバック
          const tryResume = () => {
            ctx.resume().then(() => diagToBg('AudioContext resumed(user gesture後)')).catch(() => {});
            ['click','keydown','touchstart','pointerdown'].forEach(ev =>
              document.removeEventListener(ev, tryResume, true));
          };
          ['click','keydown','touchstart','pointerdown'].forEach(ev =>
            document.addEventListener(ev, tryResume, { capture: true, passive: true }));
        });
      }
    } catch (e) {
      diagToBg('AudioContext init失敗: ' + (e && e.message || '?'));
    }
  }
  startSilentAudio();
})();
