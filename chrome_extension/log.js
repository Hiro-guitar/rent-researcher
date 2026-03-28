(() => {
  'use strict';

  const container = document.getElementById('log-container');
  const emptyMsg = document.getElementById('empty-msg');
  const statusEl = document.getElementById('status');
  const autoScrollCb = document.getElementById('autoScroll');
  const searchInput = document.getElementById('searchInput');

  let lastLogLength = 0;
  let allLines = []; // { html, tag, text }

  // === ログ行を分類・装飾 ===
  function parseLine(raw) {
    raw = raw.trim();
    if (!raw) return null;

    // タイムスタンプ抽出: [HH:MM:SS]
    let time = '';
    let body = raw;
    const tm = raw.match(/^\[(\d{1,2}:\d{2}:\d{2})\]\s*/);
    if (tm) {
      time = tm[1];
      body = raw.slice(tm[0].length);
    }

    // タグ判定
    let tag = 'system';
    if (body.startsWith('[REINS]') || body.startsWith('[reins]')) {
      tag = 'reins';
    } else if (body.startsWith('[いえらぶ]') || body.startsWith('[ielove]')) {
      tag = 'ielove';
    }

    // 行の色分けクラス
    let cls = '';
    if (body.includes('✓') || body.includes('送信完了') || body.includes('取得完了')) {
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

    // タグ装飾
    let tagHtml = '';
    if (tag === 'reins') {
      tagHtml = '<span class="log-tag tag-reins">[REINS]</span> ';
      body = body.replace(/^\[REINS\]\s*/, '');
    } else if (tag === 'ielove') {
      tagHtml = '<span class="log-tag tag-ielove">[いえらぶ]</span> ';
      body = body.replace(/^\[いえらぶ\]\s*/, '').replace(/^\[ielove\]\s*/, '');
    }

    const timeHtml = time ? `<span class="log-time">${time}</span> ` : '';
    const bodyHtml = escapeHtml(body);

    const html = `${timeHtml}${tagHtml}<span class="${cls}">${bodyHtml}</span>`;

    return { html, tag, text: raw };
  }

  function escapeHtml(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // === フィルタ適用 ===
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

  // === ストレージ監視 ===
  function pollLog() {
    chrome.storage.local.get(['debugLog', 'isSearching'], (data) => {
      const log = data.debugLog || '';

      // ステータス
      if (data.isSearching) {
        statusEl.textContent = '検索中...';
        statusEl.className = 'status active';
      } else {
        statusEl.textContent = '待機中';
        statusEl.className = 'status';
      }

      // 差分チェック
      if (log.length === lastLogLength) return;
      lastLogLength = log.length;

      // パース
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
  // フォールバック: 500msごとにポーリング
  setInterval(pollLog, 500);

  // === イベント ===
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
