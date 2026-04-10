document.addEventListener('DOMContentLoaded', () => {
  // 保存済み設定を読み込み
  chrome.storage.local.get(['gasWebappUrl', 'gasApiKey', 'searchIntervalMinutes', 'pageDelaySeconds', 'discordWebhookUrl', 'errorWebhookUrl', 'jitterPercent', 'businessStartHour', 'businessEndHour', 'notifyMode', 'btMode'], (data) => {
    if (data.gasWebappUrl) document.getElementById('gasUrl').value = data.gasWebappUrl;
    if (data.gasApiKey) document.getElementById('apiKey').value = data.gasApiKey;
    if (data.discordWebhookUrl) document.getElementById('discordWebhook').value = data.discordWebhookUrl;
    if (data.errorWebhookUrl) document.getElementById('errorWebhook').value = data.errorWebhookUrl;
    if (data.searchIntervalMinutes) document.getElementById('interval').value = data.searchIntervalMinutes;
    if (data.pageDelaySeconds) document.getElementById('delay').value = data.pageDelaySeconds;
    if (data.jitterPercent !== undefined) document.getElementById('jitterPercent').value = data.jitterPercent;
    if (data.businessStartHour !== undefined) document.getElementById('startHour').value = data.businessStartHour;
    if (data.businessEndHour !== undefined) document.getElementById('endHour').value = data.businessEndHour;
    const mode = data.notifyMode || 'immediate';
    const radio = document.querySelector(`input[name="notifyMode"][value="${mode}"]`);
    if (radio) radio.checked = true;
    const bt = data.btMode || 'alert';
    const btRadio = document.querySelector(`input[name="btMode"][value="${bt}"]`);
    if (btRadio) btRadio.checked = true;
  });

  // 保存
  document.getElementById('saveBtn').addEventListener('click', () => {
    const gasWebappUrl = document.getElementById('gasUrl').value.trim();
    const gasApiKey = document.getElementById('apiKey').value.trim();
    const discordWebhookUrl = document.getElementById('discordWebhook').value.trim();
    const errorWebhookUrl = document.getElementById('errorWebhook').value.trim();
    const searchIntervalMinutes = Math.max(10, Math.min(240, parseInt(document.getElementById('interval').value) || 60));
    const pageDelaySeconds = Math.max(3, Math.min(30, parseInt(document.getElementById('delay').value) || 5));
    const jitterPercent = Math.max(0, Math.min(50, parseInt(document.getElementById('jitterPercent').value) || 0));
    const businessStartHour = Math.max(0, Math.min(23, parseInt(document.getElementById('startHour').value) || 0));
    const businessEndHour = Math.max(1, Math.min(24, parseInt(document.getElementById('endHour').value) || 24));
    const notifyMode = (document.querySelector('input[name="notifyMode"]:checked') || {}).value || 'immediate';
    const btMode = (document.querySelector('input[name="btMode"]:checked') || {}).value || 'alert';

    chrome.storage.local.set({
      gasWebappUrl,
      gasApiKey,
      discordWebhookUrl,
      errorWebhookUrl,
      searchIntervalMinutes,
      pageDelaySeconds,
      jitterPercent,
      businessStartHour,
      businessEndHour,
      notifyMode,
      btMode
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
