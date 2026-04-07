/**
 * reins-timer-polyfill.js
 * REINS (Vue SPA) のバックグラウンドタブthrottling回避
 *
 * Chrome は背面タブで setTimeout/setInterval/requestAnimationFrame を強くthrottleするため、
 * Vue 内部の非同期処理（クリック→API→ルーティング遷移）が止まる。
 *
 * MessageChannel.postMessage は throttle 対象外なので、短い遅延の setTimeout と RAF を
 * MessageChannel ベースに差し替えることで Vue の処理が常時動くようにする。
 *
 * MAIN world / document_start で実行する必要がある（manifest.json で設定済み）
 */
(function () {
  'use strict';

  // 二重注入防止
  if (window.__reinsTimerPolyfillInstalled) return;
  window.__reinsTimerPolyfillInstalled = true;

  // === setTimeout 置き換え（短い遅延のみ） ===
  const stCh = new MessageChannel();
  const stTasks = new Map();
  let stId = 0;
  stCh.port1.onmessage = (e) => {
    const t = stTasks.get(e.data);
    if (t) {
      stTasks.delete(e.data);
      try { t(); } catch (err) { console.error('[reins-polyfill] setTimeout task error:', err); }
    }
  };
  const origSetTimeout = window.setTimeout.bind(window);
  const origClearTimeout = window.clearTimeout.bind(window);
  window.setTimeout = function (fn, delay, ...args) {
    // 100ms以下の遅延はMessageChannel経由（throttle回避）
    // 100ms超は元のsetTimeoutに委譲
    if (typeof fn !== 'function' || (delay && delay > 100)) {
      return origSetTimeout(fn, delay, ...args);
    }
    const myId = ++stId;
    // ネガティブIDで「polyfill用」と区別
    const polyId = -myId;
    stTasks.set(myId, () => fn(...args));
    stCh.port2.postMessage(myId);
    return polyId;
  };
  window.clearTimeout = function (id) {
    if (typeof id === 'number' && id < 0) {
      stTasks.delete(-id);
      return;
    }
    return origClearTimeout(id);
  };

  // === requestAnimationFrame 置き換え ===
  let rafQueue = [];
  let rafId = 0;
  const rafCallbacks = new Map();
  const rafCh = new MessageChannel();
  rafCh.port1.onmessage = () => {
    const q = rafQueue;
    rafQueue = [];
    const t = performance.now();
    for (const id of q) {
      const cb = rafCallbacks.get(id);
      if (cb) {
        rafCallbacks.delete(id);
        try { cb(t); } catch (err) { console.error('[reins-polyfill] RAF error:', err); }
      }
    }
  };
  window.requestAnimationFrame = function (cb) {
    const id = ++rafId;
    rafCallbacks.set(id, cb);
    rafQueue.push(id);
    if (rafQueue.length === 1) {
      rafCh.port2.postMessage(0);
    }
    return id;
  };
  window.cancelAnimationFrame = function (id) {
    rafCallbacks.delete(id);
  };

  console.log('[reins-polyfill] timer polyfill installed');
})();
