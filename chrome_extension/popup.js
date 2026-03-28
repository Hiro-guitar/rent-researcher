document.addEventListener('DOMContentLoaded', () => {
  loadStatus();
  loadServiceSettings();

  document.getElementById('searchNowBtn').addEventListener('click', () => {
    // サービス選択状態を保存してから検索開始
    saveServiceSettings(() => {
      chrome.runtime.sendMessage({ type: 'SEARCH_NOW' }, (response) => {
        console.log('SEARCH_NOW response:', response);
      });
      document.getElementById('searchNowBtn').disabled = true;
      document.getElementById('statusText').textContent = '検索開始中...';
      const interval = setInterval(loadStatus, 2000);
      setTimeout(() => clearInterval(interval), 30000);
    });
  });

  document.getElementById('stopSearchBtn').addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'STOP_SEARCH' }, () => {
      loadStatus();
    });
  });

  document.getElementById('openLog').addEventListener('click', (e) => {
    e.preventDefault();
    chrome.tabs.create({ url: chrome.runtime.getURL('log.html') });
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
      loadStatus();
    });
  });

  // サービスチェックボックス変更時に即保存
  document.getElementById('enableReins').addEventListener('change', () => saveServiceSettings());
  document.getElementById('enableIelove').addEventListener('change', () => saveServiceSettings());
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

    // デバッグ: debugLog があれば表示
    chrome.storage.local.get(['debugLog'], (d) => {
      if (d.debugLog) {
        errorSection.style.display = 'block';
        document.getElementById('lastError').textContent = d.debugLog;
      }
    });

    // ボタン状態（検索中は中止ボタン表示）
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

// === サービス選択の保存・復元 ===

function loadServiceSettings() {
  chrome.storage.local.get(['enabledServices'], (data) => {
    const services = data.enabledServices || { reins: true, ielove: true };
    document.getElementById('enableReins').checked = services.reins;
    document.getElementById('enableIelove').checked = services.ielove;
  });
}

function saveServiceSettings(callback) {
  const enabledServices = {
    reins: document.getElementById('enableReins').checked,
    ielove: document.getElementById('enableIelove').checked,
  };
  chrome.storage.local.set({ enabledServices }, callback);
}
