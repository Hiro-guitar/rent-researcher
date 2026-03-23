document.addEventListener('DOMContentLoaded', () => {
  loadStatus();

  document.getElementById('searchNowBtn').addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'SEARCH_NOW' });
    document.getElementById('searchNowBtn').disabled = true;
    document.getElementById('statusText').textContent = '検索開始中...';
    setTimeout(loadStatus, 2000);
  });

  document.getElementById('refreshCriteriaBtn').addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'REFRESH_CRITERIA' });
    document.getElementById('refreshCriteriaBtn').disabled = true;
    setTimeout(() => {
      document.getElementById('refreshCriteriaBtn').disabled = false;
      loadStatus();
    }, 3000);
  });

  document.getElementById('openOptions').addEventListener('click', (e) => {
    e.preventDefault();
    chrome.runtime.openOptionsPage();
  });
});

function loadStatus() {
  chrome.storage.local.get([
    'isSearching', 'loginDetected', 'lastSearchTime',
    'searchIntervalMinutes', 'stats', 'gasWebappUrl'
  ], (data) => {
    // ログイン状態
    const dot = document.getElementById('loginStatus');
    const statusText = document.getElementById('statusText');

    if (!data.gasWebappUrl) {
      dot.className = 'status-dot offline';
      statusText.textContent = 'GAS URL未設定 → 設定へ';
    } else if (data.isSearching) {
      dot.className = 'status-dot searching';
      statusText.textContent = '検索中...';
    } else if (data.loginDetected) {
      dot.className = 'status-dot online';
      statusText.textContent = 'REINS接続中';
    } else {
      dot.className = 'status-dot offline';
      statusText.textContent = 'REINSにログインしてください';
    }

    // 最終検索
    const lastSearch = document.getElementById('lastSearch');
    if (data.lastSearchTime) {
      lastSearch.textContent = formatTime(data.lastSearchTime);
    } else {
      lastSearch.textContent = '-';
    }

    // 次回検索
    const nextSearch = document.getElementById('nextSearch');
    chrome.alarms.get('reins-search', (alarm) => {
      if (alarm) {
        nextSearch.textContent = formatTime(alarm.scheduledTime);
      } else {
        nextSearch.textContent = '-';
      }
    });

    // 統計
    const stats = data.stats || {};
    document.getElementById('totalFound').textContent = stats.totalFound || 0;
    document.getElementById('totalSubmitted').textContent = stats.totalSubmitted || 0;
    document.getElementById('totalErrors').textContent = (stats.errors || []).length;

    // エラー表示
    const errorSection = document.getElementById('errorSection');
    if (stats.lastError) {
      errorSection.style.display = 'block';
      document.getElementById('lastError').textContent = stats.lastError;
    } else {
      errorSection.style.display = 'none';
    }

    // ボタン状態
    document.getElementById('searchNowBtn').disabled = data.isSearching || !data.gasWebappUrl;
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
