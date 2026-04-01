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
      'searchIntervalMinutes', 'stats', 'gasWebappUrl'
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

      // 最終検索
      const lastSearch = document.getElementById('lastSearch');
      lastSearch.textContent = data.lastSearchTime ? formatTime(data.lastSearchTime) : '-';

      // 次回検索
      const nextSearch = document.getElementById('nextSearch');
      chrome.alarms.get('reins-search', (alarm) => {
        nextSearch.textContent = alarm ? formatTime(alarm.scheduledTime) : '-';
      });

      // 統計
      const stats = data.stats || {};
      document.getElementById('totalFound').textContent = stats.totalFound || 0;
      document.getElementById('totalSubmitted').textContent = stats.totalSubmitted || 0;
      document.getElementById('totalErrors').textContent = (stats.errors || []).length;

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
      document.getElementById('enableEssquare').checked = services.essquare !== false;
      document.getElementById('autoSearchEnabled').checked = data.autoSearchEnabled !== false;
    });
  }

  function saveServiceSettings(callback) {
    const enabledServices = {
      reins: document.getElementById('enableReins').checked,
      ielove: document.getElementById('enableIelove').checked,
      itandi: document.getElementById('enableItandi').checked,
      essquare: document.getElementById('enableEssquare').checked,
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

  // Init dashboard
  loadDashboardStatus();
  loadServiceSettings();

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
