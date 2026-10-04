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

  // === setTimeout 置き換え（全遅延をMessageChannelベースのスケジューラで処理） ===
  // performance.now() ベースで発火時刻を管理し、MessageChannel をポンプにして常時pump
  const origSetTimeout = window.setTimeout.bind(window);
  const origClearTimeout = window.clearTimeout.bind(window);
  const stCh = new MessageChannel();
  /** @type {Map<number, {fireAt:number, fn:Function, args:any[], cancelled:boolean}>} */
  const stTasks = new Map();
  let stId = 0;
  let stPumpScheduled = false;
  function stSchedulePump() {
    if (stPumpScheduled) return;
    stPumpScheduled = true;
    stCh.port2.postMessage(0);
  }
  stCh.port1.onmessage = () => {
    stPumpScheduled = false;
    const now = performance.now();
    let nextWait = Infinity;
    // 発火時刻が来たタスクを順に実行
    for (const [id, t] of stTasks) {
      if (t.cancelled) { stTasks.delete(id); continue; }
      if (t.fireAt <= now) {
        stTasks.delete(id);
        try { t.fn(...t.args); } catch (err) { console.error('[reins-polyfill] setTimeout error:', err); }
      } else {
        if (t.fireAt - now < nextWait) nextWait = t.fireAt - now;
      }
    }
    if (stTasks.size > 0) {
      // 残タスクあり: 次発火まで待ってから再pump
      if (nextWait <= 4) {
        stSchedulePump();
      } else {
        // 長めの待ち時間は origSetTimeout で叩き起こす（background throttleを受けるが、MessageChannel pumpで即実行される）
        origSetTimeout(stSchedulePump, Math.max(4, Math.floor(nextWait)));
      }
    }
  };
  window.setTimeout = function (fn, delay, ...args) {
    if (typeof fn !== 'function') {
      return origSetTimeout(fn, delay, ...args);
    }
    const d = Number(delay) || 0;
    const myId = ++stId;
    const polyId = -myId;
    stTasks.set(myId, { fireAt: performance.now() + d, fn, args, cancelled: false });
    // 0ms は即pump、そうでなければorigSetTimeoutで予約してbackground時も動くようにする
    if (d <= 4) {
      stSchedulePump();
    } else {
      origSetTimeout(stSchedulePump, d);
    }
    return polyId;
  };
  window.clearTimeout = function (id) {
    if (typeof id === 'number' && id < 0) {
      const t = stTasks.get(-id);
      if (t) t.cancelled = true;
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

/**
 * REINS が新しい版に入れ替わったあと、Chrome に残った古いページで止まる（くるくるのまま）のを自分で直す（2026-10-02）。
 *
 * 症状: 古いページが読みに行く部品ファイル（app_123.古い記号.js）がもう無く、JSON が返ってきて画面が組み上がらない。
 * 直し方: 8秒たっても画面（window.$nuxt）ができていなければ、このページを cache:'reload' で取り直して
 *   Chrome の保存を新しい版に置き換え、読み込み直す。ループしないよう、同じページは1分に1回まで。
 * ⚠️ setTimeout は上で差し替えているが、ここは普通に動けばよいので気にしない。
 */
(function () {
  'use strict';
  var KEY = '__reinsStaleReloadAt';
  // ⚠️ ページごとに古いものが残るので、1回直すときによく使うページもまとめて取り直す（2026-10-04: ログイン画面で再発）
  var PATHS = ['/login/main/KG/GKG001200', '/main/KG/GKG003100', '/main/BK/GBK001310', '/main/BK/GBK002200', '/main/BK/GBK004100', '/'];
  var started = false;
  function heal(why) {
    if (started || window.$nuxt) return;
    var last = 0;
    try { last = Number(localStorage.getItem(KEY) || 0); } catch (_) {}
    if (Date.now() - last < 60000) return;          // 1分以内にやり直したばかりなら何もしない（ループ防止）
    started = true;
    try { localStorage.setItem(KEY, String(Date.now())); } catch (_) {}
    console.warn('[reins-polyfill] 古いページが残っています（' + why + '）。新しい版を取り直して読み込み直します');
    var urls = [location.href].concat(PATHS.map(function (p) { return location.origin + p; }));
    Promise.all(urls.map(function (u) { return fetch(u, { cache: 'reload', credentials: 'include' }).catch(function () {}); }))
      .then(function () { location.reload(); });
  }
  // 部品ファイル（app_*.js / chunk_*.js）が読めなかったら、すぐ直す
  window.addEventListener('error', function (ev) {
    var t = ev && ev.target;
    if (t && t.tagName === 'SCRIPT' && /\/app\/js\/(app|chunk)_/.test(t.src || '')) heal('部品ファイルが読めない');
  }, true);
  // 念のため: 8秒たっても画面ができていなければ直す（REINSのどのページでも）
  window.addEventListener('load', function () {
    (window.__origSetTimeoutForReins || window.setTimeout)(function () {
      if (!window.$nuxt && /system\.reins\.jp\//.test(location.href) && document.querySelector('script[src*="/app/js/app_"]')) heal('画面ができない');
    }, 8000);
  });
})();
