document.addEventListener('DOMContentLoaded', () => {
  // 保存済み設定を読み込み
  chrome.storage.local.get(['gasWebappUrl', 'gasApiKey', 'searchIntervalMinutes', 'pageDelaySeconds'], (data) => {
    if (data.gasWebappUrl) document.getElementById('gasUrl').value = data.gasWebappUrl;
    if (data.gasApiKey) document.getElementById('apiKey').value = data.gasApiKey;
    if (data.searchIntervalMinutes) document.getElementById('interval').value = data.searchIntervalMinutes;
    if (data.pageDelaySeconds) document.getElementById('delay').value = data.pageDelaySeconds;
  });

  // 保存
  document.getElementById('saveBtn').addEventListener('click', () => {
    const gasWebappUrl = document.getElementById('gasUrl').value.trim();
    const gasApiKey = document.getElementById('apiKey').value.trim();
    const searchIntervalMinutes = Math.max(10, Math.min(120, parseInt(document.getElementById('interval').value) || 30));
    const pageDelaySeconds = Math.max(3, Math.min(30, parseInt(document.getElementById('delay').value) || 5));

    chrome.storage.local.set({
      gasWebappUrl,
      gasApiKey,
      searchIntervalMinutes,
      pageDelaySeconds
    }, () => {
      // アラームを再設定
      chrome.runtime.sendMessage({ type: 'UPDATE_ALARM' });

      const msg = document.getElementById('savedMsg');
      msg.style.display = 'block';
      setTimeout(() => { msg.style.display = 'none'; }, 2000);
    });
  });

  // 接続テスト
  document.getElementById('testBtn').addEventListener('click', async () => {
    const resultEl = document.getElementById('testResult');
    resultEl.className = '';
    resultEl.style.display = 'none';
    resultEl.textContent = 'テスト中...';
    resultEl.style.display = 'block';

    const gasUrl = document.getElementById('gasUrl').value.trim();
    const apiKey = document.getElementById('apiKey').value.trim();

    if (!gasUrl) {
      resultEl.className = 'error';
      resultEl.textContent = 'GAS URLを入力してください';
      return;
    }

    try {
      const url = `${gasUrl}?action=status&api_key=${encodeURIComponent(apiKey)}`;
      const resp = await fetch(url, { redirect: 'follow' });
      const json = await resp.json();

      if (json.status === 'ok') {
        resultEl.className = 'success';
        resultEl.textContent = '接続成功';
      } else {
        resultEl.className = 'error';
        resultEl.textContent = '応答エラー: ' + JSON.stringify(json);
      }
    } catch (err) {
      resultEl.className = 'error';
      resultEl.textContent = '接続失敗: ' + err.message;
    }
  });
});
