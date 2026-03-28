document.addEventListener('DOMContentLoaded', () => {
  // ステータス表示
  chrome.storage.local.get(['isSearching', 'loginDetected', 'gasWebappUrl'], (data) => {
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
      statusText.textContent = '未接続';
    }
  });

  // ダッシュボード（log.html）を開く
  document.getElementById('openDashboard').addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('log.html') });
    window.close();
  });
});
