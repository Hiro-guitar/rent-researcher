/**
 * essquare-keepalive.js
 * ES-Square のすべてのページ (検索結果/詳細) に注入される軽量 content script。
 *
 * 目的: バックグラウンドタブの throttling 回避のため、無音 audio を再生して
 *       タブを audible 状態に維持する。
 *
 * 【診断・一時 2026-07-19】音方式の生死を確定するテスト版:
 *   実測で「fresh なページ読込直後は audible=true、SPA遷移した瞬間 false」と判明。
 *   これまでは同じ AudioContext を鳴らし続けていた。今回は【遷移のたびに
 *   AudioContext を作り直し】、fresh 状態の audible=true を再現できるか試す。
 *   同時に throttling が実際に止まっているかも 100ms 発火カウントで測る。
 *   （debugger は background 側で一時OFFにして、音だけの効果を純粋に測る）
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

  // 無音オシレータを起動/維持する。
  function startSilentAudio() {
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) { diagToBg('AudioContext API なし'); return; }
      let ctx = window.__essquareAudioCtx;
      // コンテキストが無い or 閉じられていたら作り直す
      if (!ctx || ctx.state === 'closed') {
        ctx = new Ctx();
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.frequency.value = 440;
        gain.gain.value = 0.003;
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start();
        window.__essquareAudioCtx = ctx;
      }
      if (ctx.state === 'suspended') {
        ctx.resume().catch(() => {
          const tryResume = () => { try { ctx.resume(); } catch (e) {} };
          ['click', 'keydown', 'touchstart', 'pointerdown'].forEach((ev) =>
            document.addEventListener(ev, tryResume, { capture: true, passive: true, once: true }));
        });
      }
    } catch (e) {
      diagToBg('AudioContext init失敗: ' + (e && e.message || '?'));
    }
  }

  // 【テスト核心】既存 context を閉じて新規に作り直す（fresh 状態を再現）
  function recreateSilentAudio(why) {
    try {
      const old = window.__essquareAudioCtx;
      window.__essquareAudioCtx = null;
      if (old && old.state !== 'closed') { old.close().catch(() => {}); }
    } catch (e) {}
    startSilentAudio();
    diagToBg('audio再作成 (' + why + ')');
  }

  startSilentAudio();

  // navigation 検出 → 音を作り直す。
  // ES-Square の検索遷移は history.pushState + popstate(MAIN world発火)。
  // popstate は同一DOMなので分離ワールドのここでも受け取れる。取りこぼし対策で
  // href 変化ポーリングも併用。
  let __lastHref = location.href;
  window.addEventListener('popstate', () => {
    recreateSilentAudio('popstate');
    __lastHref = location.href;
  }, true);

  // ウォッチドッグ(1秒): href が変わっていたら作り直し、それ以外は維持。
  setInterval(function () {
    if (location.href !== __lastHref) {
      __lastHref = location.href;
      recreateSilentAudio('href変化');
    } else {
      startSilentAudio(); // suspended落ち等の保険
    }
  }, 1000);
  document.addEventListener('visibilitychange', startSilentAudio, true);

  // 【診断】throttling が止まっているか: 100ms interval が3秒に何回発火したか。
  // 裏タブで ~3回=throttled / ~30回=throttlingされていない。
  (function throttleProbe() {
    let ticks = 0;
    setInterval(function () { ticks++; }, 100);
    setInterval(function () {
      diagToBg('throttle計測: 3秒で ' + ticks + '回 vis=' + document.visibilityState + ' (~3=throttled/~30=OK)');
      ticks = 0;
    }, 3000);
  })();
})();
