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

  // 使い方ページ（help.html）を開く
  document.getElementById('openHelp').addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('help.html') });
    window.close();
  });

  // 空室状況チェック (手動トリガー)
  const availBtn = document.getElementById('runAvailability');
  const availResult = document.getElementById('availabilityResult');
  if (availBtn) {
    availBtn.addEventListener('click', async () => {
      availBtn.disabled = true;
      availBtn.textContent = '⏳ 確認中...';
      if (availResult) availResult.textContent = '送付済み物件の空室状況を確認しています...';
      try {
        const response = await chrome.runtime.sendMessage({ action: 'run_availability_check', options: { limit: 20 } });
        if (response && typeof response.processed === 'number') {
          if (availResult) availResult.textContent = `✅ ${response.processed} 件の物件を確認しました`;
        } else if (response && response.error) {
          if (availResult) availResult.textContent = `❌ エラー: ${response.error}`;
        } else {
          if (availResult) availResult.textContent = '✅ 完了 (詳細は log.html で確認)';
        }
      } catch (e) {
        if (availResult) availResult.textContent = `❌ ${e.message}`;
      }
      availBtn.disabled = false;
      availBtn.textContent = '🔍 空室状況をチェック';
    });
  }
});
