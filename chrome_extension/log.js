(() => {
  'use strict';

  const container = document.getElementById('log-container');
  const autoScrollCb = document.getElementById('autoScroll');
  const searchInput = document.getElementById('searchInput');

  let lastLogLength = 0;
  let allLines = []; // { html, tag, text }

  // ============================================================
  // Dashboard control panel (merged from popup.js)
  // ============================================================

  function loadDashboardStatus() {
    chrome.storage.local.get([
      'isSearching', 'loginDetected', 'lastSearchTime',
      'searchIntervalMinutes', 'stats', 'gasWebappUrl',
      'suumoPatrolLastRunTime', 'suumoPatrolEnabled',
      'reinsUsageMonthly'
    ], (data) => {
      const dot = document.getElementById('loginStatus');
      const statusText = document.getElementById('statusText');

      if (!data.gasWebappUrl) {
        dot.className = 'status-dot offline';
        statusText.textContent = 'GAS URL未設定';
      } else if (data.isSearching) {
        dot.className = 'status-dot searching';
        statusText.textContent = '検索中...';
      } else if (data.loginDetected) {
        dot.className = 'status-dot online';
        statusText.textContent = '接続中';
      } else {
        dot.className = 'status-dot offline';
        statusText.textContent = 'REINSにログインしてください';
      }

      // 顧客物件検索: 最終
      const lastSearch = document.getElementById('lastSearch');
      lastSearch.textContent = data.lastSearchTime ? formatTime(data.lastSearchTime) : '-';

      // 顧客物件検索: 次回 (アラーム scheduledTime)
      const nextSearch = document.getElementById('nextSearch');
      chrome.alarms.get('reins-search', (alarm) => {
        nextSearch.textContent = alarm ? formatTime(alarm.scheduledTime) : '-';
      });

      // SUUMO巡回: 最終
      const lastPatrol = document.getElementById('lastSuumoPatrol');
      if (lastPatrol) {
        lastPatrol.textContent = data.suumoPatrolLastRunTime ? formatTime(data.suumoPatrolLastRunTime) : '-';
      }

      // SUUMO巡回: 次回 (定期巡回 OFF なら "-")
      const nextPatrol = document.getElementById('nextSuumoPatrol');
      if (nextPatrol) {
        if (!data.suumoPatrolEnabled) {
          nextPatrol.textContent = '-';
        } else {
          chrome.alarms.get('suumo-patrol', (alarm) => {
            nextPatrol.textContent = alarm ? formatTime(alarm.scheduledTime) : '-';
          });
        }
      }

      // 統計
      const stats = data.stats || {};
      document.getElementById('totalFound').textContent = stats.totalFound || 0;
      document.getElementById('totalSubmitted').textContent = stats.totalSubmitted || 0;
      document.getElementById('totalErrors').textContent = (stats.errors || []).length;

      // REINS利用カウンター（日次＋月次）
      const mu = data.reinsUsageMonthly || { month: '', days: {} };
      const today = new Date().toLocaleDateString('sv-SE');
      const curMonth = today.slice(0, 7);
      const isThisMonth = mu.month === curMonth;
      const dayData = (isThisMonth && mu.days[today]) || { s: 0, d: 0 };
      let monthS = 0, monthD = 0;
      if (isThisMonth) {
        for (const k in mu.days) { monthS += mu.days[k].s || 0; monthD += mu.days[k].d || 0; }
      }
      const scEl = document.getElementById('reinsSearchCount');
      const dcEl = document.getElementById('reinsDetailCount');
      const mscEl = document.getElementById('reinsMonthSearchCount');
      const mdcEl = document.getElementById('reinsMonthDetailCount');
      if (scEl) {
        scEl.textContent = dayData.s;
      }
      if (dcEl) {
        dcEl.textContent = dayData.d;
      }
      if (mscEl) {
        mscEl.textContent = monthS;
        mscEl.style.color = monthS > 6000 ? '#f44747' : monthS > 5000 ? '#dcdcaa' : '#d4d4d4';
      }
      if (mdcEl) {
        mdcEl.textContent = monthD;
        mdcEl.style.color = monthD > 6000 ? '#f44747' : monthD > 5000 ? '#dcdcaa' : '#d4d4d4';
      }

      // ボタン状態
      const searchBtn = document.getElementById('searchNowBtn');
      const stopBtn = document.getElementById('stopSearchBtn');
      if (data.isSearching) {
        searchBtn.style.display = 'none';
        stopBtn.style.display = '';
      } else {
        searchBtn.style.display = '';
        stopBtn.style.display = 'none';
        searchBtn.disabled = !data.gasWebappUrl;
      }
    });
  }

  function formatTime(ts) {
    const d = new Date(ts);
    const now = new Date();
    const pad = n => String(n).padStart(2, '0');
    if (d.toDateString() === now.toDateString()) {
      return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    }
    return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function loadServiceSettings() {
    chrome.storage.local.get(['enabledServices', 'autoSearchEnabled'], (data) => {
      const services = data.enabledServices || { reins: true, ielove: true, itandi: true, essquare: true };
      document.getElementById('enableReins').checked = services.reins;
      document.getElementById('enableIelove').checked = services.ielove;
      document.getElementById('enableItandi').checked = services.itandi !== false;
      // いい生活Square は恒久停止(2026-06-03 規約違反BAN)。UIから削除済み。
      document.getElementById('autoSearchEnabled').checked = data.autoSearchEnabled !== false;
    });
  }

  function saveServiceSettings(callback) {
    const enabledServices = {
      reins: document.getElementById('enableReins').checked,
      ielove: document.getElementById('enableIelove').checked,
      itandi: document.getElementById('enableItandi').checked,
      essquare: false, // 恒久停止(2026-06-03 規約違反BAN)。常にfalseで保存。
    };
    const autoSearchEnabled = document.getElementById('autoSearchEnabled').checked;
    chrome.storage.local.set({ enabledServices, autoSearchEnabled }, callback);
  }

  // Dashboard events
  document.getElementById('searchNowBtn').addEventListener('click', () => {
    saveServiceSettings(() => {
      chrome.runtime.sendMessage({ type: 'SEARCH_NOW' }, (response) => {
        console.log('SEARCH_NOW response:', response);
      });
      document.getElementById('searchNowBtn').disabled = true;
      document.getElementById('statusText').textContent = '検索開始中...';
    });
  });

  document.getElementById('stopSearchBtn').addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'STOP_SEARCH' }, () => {
      loadDashboardStatus();
    });
  });

  // 条件管理ページを開く
  document.getElementById('adminPageBtn').addEventListener('click', () => {
    chrome.storage.local.get(['gasWebappUrl', 'gasApiKey'], (data) => {
      if (!data.gasWebappUrl) {
        alert('GAS Web App URLが設定されていません。設定画面から設定してください。');
        return;
      }
      if (!data.gasApiKey) {
        alert('GAS API Keyが設定されていません。設定画面から設定してください。');
        return;
      }
      const url = data.gasWebappUrl + '?action=admin&api_key=' + encodeURIComponent(data.gasApiKey);
      window.open(url, '_blank');
    });
  });

  // キャンセル監視中物件一覧
  const cancellationWatchListBtn = document.getElementById('cancellationWatchListBtn');
  if (cancellationWatchListBtn) {
    cancellationWatchListBtn.addEventListener('click', () => {
      chrome.storage.local.get(['gasWebappUrl'], (data) => {
        if (!data.gasWebappUrl) {
          alert('GAS Web App URLが設定されていません。設定画面から設定してください。');
          return;
        }
        const url = data.gasWebappUrl + '?action=list_cancellation_watches';
        window.open(url, '_blank');
      });
    });
  }

  // SUUMO巡回条件管理ページを直接開く
  document.getElementById('suumoConfigBtn').addEventListener('click', () => {
    chrome.storage.local.get(['gasWebappUrl', 'gasApiKey'], (data) => {
      if (!data.gasWebappUrl) {
        alert('GAS Web App URLが設定されていません。設定画面から設定してください。');
        return;
      }
      if (!data.gasApiKey) {
        alert('GAS API Keyが設定されていません。設定画面から設定してください。');
        return;
      }
      const url = data.gasWebappUrl + '?action=suumo_patrol_config&api_key=' + encodeURIComponent(data.gasApiKey);
      window.open(url, '_blank');
    });
  });

  document.getElementById('openOptions').addEventListener('click', (e) => {
    e.preventDefault();
    chrome.runtime.openOptionsPage();
  });

  document.getElementById('resetBtn').addEventListener('click', (e) => {
    e.preventDefault();
    chrome.storage.local.set({
      isSearching: false,
      debugLog: '',
      stats: { totalFound: 0, totalSubmitted: 0, errors: [], lastError: null }
    }, () => {
      loadDashboardStatus();
      allLines = [];
      lastLogLength = 0;
      container.innerHTML = '<div id="empty-msg">リセットしました</div>';
    });
  });

  document.getElementById('enableReins').addEventListener('change', () => saveServiceSettings());
  document.getElementById('enableIelove').addEventListener('change', () => saveServiceSettings());
  document.getElementById('enableItandi').addEventListener('change', () => saveServiceSettings());
  document.getElementById('autoSearchEnabled').addEventListener('change', () => saveServiceSettings());

  // ── SUUMO巡回トグル ──
  // 仕様 (A案: 完全分離):
  //   - チェックボックス(suumoPatrolEnabled) = 定期巡回(60分アラーム) の ON/OFF のみ
  //   - 「巡回実行」ボタン = 単発実行のみ。チェックには触れない
  //   - 「巡回停止」ボタン = 実行中サイクルの中断のみ。チェック/アラームには触れない
  //   - ボタン表示は「実行中か否か」(suumoPatrolRunning) で切替。チェック状態と独立
  const suumoCheckbox = document.getElementById('suumoPatrolEnabled');
  const suumoStartBtn = document.getElementById('suumoPatrolNowBtn');
  const suumoStopBtn = document.getElementById('suumoPatrolStopBtn');

  function updateSuumoButtons(running) {
    if (running) {
      suumoStartBtn.style.display = 'none';
      suumoStopBtn.style.display = '';
    } else {
      suumoStartBtn.style.display = '';
      suumoStopBtn.style.display = 'none';
    }
  }

  // チェックボックス: 定期巡回 ON/OFF だけ
  suumoCheckbox.addEventListener('change', (e) => {
    chrome.runtime.sendMessage({ type: 'SUUMO_PATROL_TOGGLE', enabled: e.target.checked });
  });
  // 巡回実行: 単発のみ (チェックには触らない)
  suumoStartBtn.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'SUUMO_PATROL_NOW' });
    // 実行中フラグは background 側で立てるが、UX 上ここで先行表示
    updateSuumoButtons(true);
  });
  // 巡回停止: 実行中サイクルの中断のみ (チェック/アラームには触らない)
  suumoStopBtn.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'SUUMO_PATROL_STOP' });
    updateSuumoButtons(false);
  });

  // 初期状態の読み込み
  chrome.storage.local.get(['suumoPatrolEnabled', 'suumoPatrolRunning'], (data) => {
    suumoCheckbox.checked = !!data.suumoPatrolEnabled;
    updateSuumoButtons(!!data.suumoPatrolRunning);
  });

  // 実行状態の変化を監視して、ボタン表示を自動で切替
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.suumoPatrolRunning) {
      updateSuumoButtons(!!changes.suumoPatrolRunning.newValue);
    }
    if (changes.suumoPatrolEnabled) {
      suumoCheckbox.checked = !!changes.suumoPatrolEnabled.newValue;
    }
  });

  // ── SUUMO巡回 N日以内フィルタ ──
  // ダッシュボードのこの入力が唯一の daysWithin 設定。
  // 空欄なら制限なし、数値なら「N日以内」フィルタを全巡回条件に適用する。
  // chrome.storage.local.suumoPatrolDaysWithin に保存して、
  // 手動「巡回実行」と自動アラーム両方で参照される。
  const daysWithinInput = document.getElementById('suumoPatrolDaysWithin');
  if (daysWithinInput) {
    chrome.storage.local.get(['suumoPatrolDaysWithin'], (data) => {
      const v = data && data.suumoPatrolDaysWithin;
      daysWithinInput.value = (v === undefined || v === null) ? '' : String(v);
    });
    daysWithinInput.addEventListener('change', () => {
      const raw = daysWithinInput.value.trim();
      // 数値以外/負数は空欄扱い (= 制限なし)
      const n = parseInt(raw, 10);
      const save = (!raw || isNaN(n) || n < 0) ? '' : String(n);
      if (save !== raw) daysWithinInput.value = save;
      chrome.storage.local.set({ suumoPatrolDaysWithin: save });
    });
  }

  // ── SUUMO入稿開始ボタン ──
  document.getElementById('suumoFillNowBtn').addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'SUUMO_QUEUE_POLL_NOW' }, (resp) => {
      console.log('SUUMO_QUEUE_POLL_NOW response:', resp);
    });
  });

  // ── 空室状況チェック ボタン ──
  const availBtn = document.getElementById('availabilityCheckBtn');
  const availStopBtn = document.getElementById('availabilityStopBtn');
  const availStatus = document.getElementById('availabilityCheckStatus');
  if (availBtn) {
    availBtn.addEventListener('click', async () => {
      availBtn.disabled = true;
      const oldText = availBtn.textContent;
      availBtn.textContent = '⏳ 確認中...';
      if (availStopBtn) availStopBtn.style.display = '';
      if (availStatus) availStatus.textContent = '送付済み物件を全件スキャン中...';
      try {
        // batchSize 単位で GAS から取得し、キューが空になるまでループ
        const response = await chrome.runtime.sendMessage({
          action: 'run_availability_check',
          options: { batchSize: 30 }
        });
        if (response && response.stopped) {
          if (availStatus) availStatus.textContent = `⏹ 中断 (${response.processed || 0} 件 確認済)`;
        } else if (response && typeof response.processed === 'number') {
          const errStr = response.errors ? ` / エラー ${response.errors}` : '';
          if (availStatus) availStatus.textContent = `✅ ${response.processed} 件確認完了${errStr}`;
        } else if (response && response.error) {
          if (availStatus) availStatus.textContent = `❌ ${response.error}`;
        } else {
          if (availStatus) availStatus.textContent = '✅ 完了';
        }
      } catch (e) {
        if (availStatus) availStatus.textContent = `❌ ${e.message}`;
      }
      availBtn.disabled = false;
      availBtn.textContent = oldText;
      if (availStopBtn) availStopBtn.style.display = 'none';
    });
  }
  if (availStopBtn) {
    availStopBtn.addEventListener('click', async () => {
      availStopBtn.disabled = true;
      availStopBtn.textContent = '中断中...';
      try {
        await chrome.runtime.sendMessage({ action: 'stop_availability_check' });
        if (availStatus) availStatus.textContent = '⏹ 中断要求を送信...';
      } catch (e) {
        if (availStatus) availStatus.textContent = `❌ 中断失敗: ${e.message}`;
      }
      availStopBtn.disabled = false;
      availStopBtn.textContent = '中断';
    });
  }

  // --- 顧客チェックボックス ---
  // 「除外リスト」方式: excludedCustomers に入っている顧客だけスキップ
  // → 新規追加された顧客は自動的にチェックON
  function loadCustomerCheckboxes() {
    chrome.storage.local.get(['customerCriteria', 'excludedCustomers'], (data) => {
      const criteria = data.customerCriteria || [];
      const excluded = data.excludedCustomers || []; // 除外リスト
      const container = document.getElementById('customerCheckboxes');
      const label = container.querySelector('span');
      container.innerHTML = '';
      container.appendChild(label);

      if (criteria.length === 0) return;

      // 全選択/全解除ボタン
      const allBtn = document.createElement('button');
      allBtn.className = 'dp-btn';
      allBtn.textContent = '全選択';
      allBtn.style.cssText = 'padding:2px 6px;font-size:10px;';
      allBtn.addEventListener('click', () => {
        container.querySelectorAll('input[type="checkbox"]').forEach(cb => cb.checked = true);
        saveExcludedCustomers();
      });
      container.appendChild(allBtn);

      const noneBtn = document.createElement('button');
      noneBtn.className = 'dp-btn';
      noneBtn.textContent = '全解除';
      noneBtn.style.cssText = 'padding:2px 6px;font-size:10px;';
      noneBtn.addEventListener('click', () => {
        container.querySelectorAll('input[type="checkbox"]').forEach(cb => cb.checked = false);
        saveExcludedCustomers();
      });
      container.appendChild(noneBtn);

      for (const c of criteria) {
        const lbl = document.createElement('label');
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.className = 'customer-filter';
        cb.value = c.name;
        cb.checked = !excluded.includes(c.name); // 除外リストに無い → ON
        cb.addEventListener('change', saveExcludedCustomers);
        lbl.appendChild(cb);
        lbl.appendChild(document.createTextNode(' ' + c.name));
        container.appendChild(lbl);
      }
    });
  }

  function saveExcludedCustomers() {
    const checkboxes = document.querySelectorAll('.customer-filter');
    const excluded = Array.from(checkboxes).filter(cb => !cb.checked).map(cb => cb.value);
    chrome.storage.local.set({ excludedCustomers: excluded });
  }

  // Init dashboard
  loadDashboardStatus();
  loadServiceSettings();
  loadCustomerCheckboxes();

  // ============================================================
  // Log viewer
  // ============================================================

  function parseLine(raw) {
    raw = raw.trim();
    if (!raw) return null;

    let time = '';
    let body = raw;
    const tm = raw.match(/^\[(\d{1,2}:\d{2}:\d{2})\]\s*/);
    if (tm) {
      time = tm[1];
      body = raw.slice(tm[0].length);
    }

    let tag = 'system';
    if (body.startsWith('[REINS]') || body.startsWith('[reins]')) {
      tag = 'reins';
    } else if (body.startsWith('[いえらぶ]') || body.startsWith('[ielove]')) {
      tag = 'ielove';
    } else if (body.startsWith('[itandi]') || body.startsWith('[ITANDI]')) {
      tag = 'itandi';
    } else if (body.startsWith('[ES-Square]') || body.startsWith('[essquare]')) {
      tag = 'essquare';
    }

    let cls = '';
    if (body.includes('━━━')) {
      cls = 'log-separator';
    } else if (body.includes('✓') || body.includes('送信完了') || body.includes('取得完了')) {
      cls = 'log-ok';
    } else if (body.includes('✗') || body.includes('スキップ') || body.includes('フィルタ')) {
      cls = 'log-skip';
    } else if (body.includes('エラー') || body.includes('失敗')) {
      cls = 'log-error';
    } else if (body.includes('⚠') || body.includes('WARN')) {
      cls = 'log-warn';
    } else if (body.includes('送信対象') || body.includes('送信中')) {
      cls = 'log-submit';
    }

    let tagHtml = '';
    if (tag === 'reins') {
      tagHtml = '<span class="log-tag tag-reins">[REINS]</span> ';
      body = body.replace(/^\[REINS\]\s*/, '');
    } else if (tag === 'ielove') {
      tagHtml = '<span class="log-tag tag-ielove">[いえらぶ]</span> ';
      body = body.replace(/^\[いえらぶ\]\s*/, '').replace(/^\[ielove\]\s*/, '');
    } else if (tag === 'itandi') {
      tagHtml = '<span class="log-tag tag-itandi">[itandi]</span> ';
      body = body.replace(/^\[itandi\]\s*/, '').replace(/^\[ITANDI\]\s*/, '');
    } else if (tag === 'essquare') {
      tagHtml = '<span class="log-tag tag-essquare">[ES-Square]</span> ';
      body = body.replace(/^\[ES-Square\]\s*/, '').replace(/^\[essquare\]\s*/, '');
    }

    const timeHtml = time ? `<span class="log-time">${time}</span> ` : '';
    const bodyHtml = linkifyUrls(escapeHtml(body));
    const html = `${timeHtml}${tagHtml}<span class="${cls}">${bodyHtml}</span>`;

    return { html, tag, text: raw };
  }

  function escapeHtml(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function linkifyUrls(escaped) {
    return escaped.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" style="color:#569cd6;text-decoration:underline">$1</a>');
  }

  function getActiveFilters() {
    const tags = new Set();
    document.querySelectorAll('.tag-filter:checked').forEach(cb => tags.add(cb.value));
    const search = searchInput.value.trim().toLowerCase();
    return { tags, search };
  }

  function matchesFilter(line, filters) {
    if (!filters.tags.has(line.tag)) return false;
    if (filters.search && !line.text.toLowerCase().includes(filters.search)) return false;
    return true;
  }

  function renderAll() {
    const filters = getActiveFilters();
    const visible = allLines.filter(l => matchesFilter(l, filters));

    if (visible.length === 0) {
      container.innerHTML = '<div id="empty-msg">表示するログがありません</div>';
      return;
    }

    container.innerHTML = visible.map(l =>
      `<div class="log-line">${l.html}</div>`
    ).join('');

    if (autoScrollCb.checked) {
      container.scrollTop = container.scrollHeight;
    }
  }

  function pollLog() {
    chrome.storage.local.get(['debugLog', 'isSearching'], (data) => {
      const log = data.debugLog || '';

      // ダッシュボードステータスも更新
      loadDashboardStatus();

      // 差分チェック
      if (log.length === lastLogLength) return;
      lastLogLength = log.length;

      const rawLines = log.split('\n');
      allLines = [];
      for (const raw of rawLines) {
        const parsed = parseLine(raw);
        if (parsed) allLines.push(parsed);
      }

      renderAll();
    });
  }

  // storage変更をリアルタイムで拾う
  chrome.storage.onChanged.addListener((changes) => {
    if (changes.debugLog || changes.isSearching) {
      pollLog();
    }
    if (changes.customerCriteria) {
      loadCustomerCheckboxes();
    }
  });

  // 初回ロード
  pollLog();
  // フォールバック
  setInterval(pollLog, 500);

  // Log toolbar events
  document.getElementById('clearBtn').addEventListener('click', () => {
    chrome.storage.local.set({ debugLog: '' }, () => {
      allLines = [];
      lastLogLength = 0;
      container.innerHTML = '<div id="empty-msg">ログをクリアしました</div>';
    });
  });

  document.getElementById('scrollBtn').addEventListener('click', () => {
    container.scrollTop = container.scrollHeight;
  });

  document.querySelectorAll('.tag-filter').forEach(cb => {
    cb.addEventListener('change', renderAll);
  });

  searchInput.addEventListener('input', renderAll);
})();
