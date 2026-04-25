document.addEventListener('DOMContentLoaded', () => {
  // 保存済み設定を読み込み
  chrome.storage.local.get(['gasWebappUrl', 'gasApiKey', 'searchIntervalMinutes', 'pageDelaySeconds', 'discordWebhookUrl', 'suumoDiscordWebhookUrl', 'errorWebhookUrl', 'jitterPercent', 'businessStartHour', 'businessEndHour', 'notifyMode', 'btMode', 'forrentLoginId', 'forrentPassword', 'suumoCompSkipThresholds', 'suumoBusinessKissCode', 'suumoBusinessFetchUrl', 'suumoBusinessLoginId', 'suumoBusinessPassword', 'suumoBusinessLoginBlocked', 'suumoBusinessLoginBlockedReason', 'suumoForrentStopDryRun', 'suumoSkipLowImageCount', 'itandiUpdatedWithinDays', 'suumoFinalSubmitDryRun',
    // 4サービス自動ログイン
    'reinsLoginId', 'reinsPassword', 'reinsLoginBlocked', 'reinsLoginBlockedReason',
    'itandiLoginId', 'itandiPassword', 'itandiLoginBlocked', 'itandiLoginBlockedReason',
    'essquareLoginId', 'essquarePassword', 'essquareLoginBlocked', 'essquareLoginBlockedReason',
    'ieloveLoginId', 'ielovePassword', 'ieloveLoginBlocked', 'ieloveLoginBlockedReason'
  ], (data) => {
    if (data.gasWebappUrl) document.getElementById('gasUrl').value = data.gasWebappUrl;
    if (data.gasApiKey) document.getElementById('apiKey').value = data.gasApiKey;
    if (data.discordWebhookUrl) document.getElementById('discordWebhook').value = data.discordWebhookUrl;
    if (data.suumoDiscordWebhookUrl) document.getElementById('suumoDiscordWebhook').value = data.suumoDiscordWebhookUrl;
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
    if (data.forrentLoginId) document.getElementById('forrentLoginId').value = data.forrentLoginId;
    if (data.forrentPassword) document.getElementById('forrentPassword').value = data.forrentPassword;
    // SUUMO競合スキップ閾値
    const t = data.suumoCompSkipThresholds || {};
    if (t.withNameHighlighted !== undefined && t.withNameHighlighted !== null) document.getElementById('suumoCompSkipWithNameHL').value = t.withNameHighlighted;
    if (t.withName !== undefined && t.withName !== null) document.getElementById('suumoCompSkipWithName').value = t.withName;
    if (t.withoutNameHighlighted !== undefined && t.withoutNameHighlighted !== null) document.getElementById('suumoCompSkipWithoutNameHL').value = t.withoutNameHighlighted;
    if (t.withoutName !== undefined && t.withoutName !== null) document.getElementById('suumoCompSkipWithoutName').value = t.withoutName;
    // SUUMOビジネス設定
    if (data.suumoBusinessKissCode) document.getElementById('suumoBusinessKissCode').value = data.suumoBusinessKissCode;
    if (data.suumoBusinessFetchUrl) document.getElementById('suumoBusinessFetchUrl').value = data.suumoBusinessFetchUrl;
    if (data.suumoBusinessLoginId) document.getElementById('suumoBusinessLoginId').value = data.suumoBusinessLoginId;
    if (data.suumoBusinessPassword) document.getElementById('suumoBusinessPassword').value = data.suumoBusinessPassword;

    // 画像枚数スキップ(デフォルト false = 無効)
    const skipLowImgCheckbox = document.getElementById('suumoSkipLowImageCount');
    if (skipLowImgCheckbox) skipLowImgCheckbox.checked = !!data.suumoSkipLowImageCount;

    // itandi 募集条件更新N日以内(デフォルト空欄 = 制限なし)
    const itandiDaysInput = document.getElementById('itandiUpdatedWithinDays');
    if (itandiDaysInput && data.itandiUpdatedWithinDays !== undefined && data.itandiUpdatedWithinDays !== null && data.itandiUpdatedWithinDays !== '') {
      itandiDaysInput.value = data.itandiUpdatedWithinDays;
    }

    // ForRent停止 ドライラン設定(デフォルト true)
    const dryRunCheckbox = document.getElementById('suumoForrentStopDryRun');
    if (dryRunCheckbox) {
      dryRunCheckbox.checked = (data.suumoForrentStopDryRun === undefined || data.suumoForrentStopDryRun === null)
        ? true
        : !!data.suumoForrentStopDryRun;
    }

    // Phase 5 最終登録 ドライラン設定(デフォルト true = 安全側)
    const finalSubmitDryRunCb = document.getElementById('suumoFinalSubmitDryRun');
    if (finalSubmitDryRunCb) {
      finalSubmitDryRunCb.checked = (data.suumoFinalSubmitDryRun === undefined || data.suumoFinalSubmitDryRun === null)
        ? true
        : !!data.suumoFinalSubmitDryRun;
    }

    // ログインブロック状態表示
    const blockedEl = document.getElementById('suumoBusinessLoginBlockedStatus');
    if (blockedEl) {
      if (data.suumoBusinessLoginBlocked) {
        const reason = data.suumoBusinessLoginBlockedReason || '(理由不明)';
        blockedEl.textContent = '⚠️ ブロック中: ' + reason;
        blockedEl.style.color = '#dc2626';
      } else {
        blockedEl.textContent = '✓ ブロックなし(正常)';
        blockedEl.style.color = '#065f46';
      }
    }

    // 4サービス自動ログイン: 既存値の反映とブロック状態表示
    const renderBlockStatus = (elId, blockedKey, reasonKey) => {
      const el = document.getElementById(elId);
      if (!el) return;
      if (data[blockedKey]) {
        const reason = data[reasonKey] || '(理由不明)';
        el.textContent = '⚠️ ブロック中: ' + reason;
        el.style.color = '#dc2626';
      } else {
        el.textContent = '✓ ブロックなし(正常)';
        el.style.color = '#065f46';
      }
    };
    const fillValue = (elId, val) => {
      if (!val) return;
      const el = document.getElementById(elId);
      if (el) el.value = val;
    };
    fillValue('reinsLoginId', data.reinsLoginId);
    fillValue('reinsPassword', data.reinsPassword);
    renderBlockStatus('reinsLoginBlockedStatus', 'reinsLoginBlocked', 'reinsLoginBlockedReason');
    fillValue('itandiLoginId', data.itandiLoginId);
    fillValue('itandiPassword', data.itandiPassword);
    renderBlockStatus('itandiLoginBlockedStatus', 'itandiLoginBlocked', 'itandiLoginBlockedReason');
    fillValue('essquareLoginId', data.essquareLoginId);
    fillValue('essquarePassword', data.essquarePassword);
    renderBlockStatus('essquareLoginBlockedStatus', 'essquareLoginBlocked', 'essquareLoginBlockedReason');
    fillValue('ieloveLoginId', data.ieloveLoginId);
    fillValue('ielovePassword', data.ielovePassword);
    renderBlockStatus('ieloveLoginBlockedStatus', 'ieloveLoginBlocked', 'ieloveLoginBlockedReason');
  });

  // 保存
  document.getElementById('saveBtn').addEventListener('click', () => {
    const gasWebappUrl = document.getElementById('gasUrl').value.trim();
    const gasApiKey = document.getElementById('apiKey').value.trim();
    const discordWebhookUrl = document.getElementById('discordWebhook').value.trim();
    const suumoDiscordWebhookUrl = document.getElementById('suumoDiscordWebhook').value.trim();
    const errorWebhookUrl = document.getElementById('errorWebhook').value.trim();
    const searchIntervalMinutes = Math.max(10, Math.min(240, parseInt(document.getElementById('interval').value) || 60));
    const pageDelaySeconds = Math.max(3, Math.min(30, parseInt(document.getElementById('delay').value) || 5));
    const jitterPercent = Math.max(0, Math.min(50, parseInt(document.getElementById('jitterPercent').value) || 0));
    const businessStartHour = Math.max(0, Math.min(23, parseInt(document.getElementById('startHour').value) || 0));
    const businessEndHour = Math.max(1, Math.min(24, parseInt(document.getElementById('endHour').value) || 24));
    const notifyMode = (document.querySelector('input[name="notifyMode"]:checked') || {}).value || 'immediate';
    const btMode = (document.querySelector('input[name="btMode"]:checked') || {}).value || 'alert';
    const forrentLoginId = document.getElementById('forrentLoginId').value.trim();
    const forrentPassword = document.getElementById('forrentPassword').value.trim();
    const suumoBusinessKissCode = (document.getElementById('suumoBusinessKissCode').value || '').trim().replace(/[^0-9]/g, '');
    const suumoBusinessFetchUrl = (document.getElementById('suumoBusinessFetchUrl').value || '').trim();
    const suumoBusinessLoginId = (document.getElementById('suumoBusinessLoginId').value || '').trim();
    const suumoBusinessPassword = document.getElementById('suumoBusinessPassword').value || '';
    const suumoForrentStopDryRun = !!(document.getElementById('suumoForrentStopDryRun') && document.getElementById('suumoForrentStopDryRun').checked);
    const suumoFinalSubmitDryRun = !!(document.getElementById('suumoFinalSubmitDryRun') && document.getElementById('suumoFinalSubmitDryRun').checked);
    const suumoSkipLowImageCount = !!(document.getElementById('suumoSkipLowImageCount') && document.getElementById('suumoSkipLowImageCount').checked);
    // itandiUpdatedWithinDays: 数値(1..30) / 空欄ならnullで「制限なし」
    const itandiDaysRaw = (document.getElementById('itandiUpdatedWithinDays').value || '').trim();
    let itandiUpdatedWithinDays = null;
    if (itandiDaysRaw !== '') {
      const n = parseInt(itandiDaysRaw, 10);
      if (!isNaN(n) && n >= 0 && n <= 30) itandiUpdatedWithinDays = n;
    }

    // SUUMO競合スキップ閾値（空欄なら null で「制限なし」扱い）
    const parseThreshold = (id) => {
      const v = document.getElementById(id).value.trim();
      if (v === '') return null;
      const n = parseInt(v, 10);
      return isNaN(n) || n < 0 ? null : n;
    };
    const suumoCompSkipThresholds = {
      withNameHighlighted: parseThreshold('suumoCompSkipWithNameHL'),
      withName: parseThreshold('suumoCompSkipWithName'),
      withoutNameHighlighted: parseThreshold('suumoCompSkipWithoutNameHL'),
      withoutName: parseThreshold('suumoCompSkipWithoutName'),
    };

    // 4サービス 自動ログイン情報
    const reinsLoginId = (document.getElementById('reinsLoginId').value || '').trim();
    const reinsPassword = document.getElementById('reinsPassword').value || '';
    const itandiLoginId = (document.getElementById('itandiLoginId').value || '').trim();
    const itandiPassword = document.getElementById('itandiPassword').value || '';
    const essquareLoginId = (document.getElementById('essquareLoginId').value || '').trim();
    const essquarePassword = document.getElementById('essquarePassword').value || '';
    const ieloveLoginId = (document.getElementById('ieloveLoginId').value || '').trim();
    const ielovePassword = document.getElementById('ielovePassword').value || '';

    chrome.storage.local.set({
      gasWebappUrl,
      gasApiKey,
      discordWebhookUrl,
      suumoDiscordWebhookUrl,
      errorWebhookUrl,
      searchIntervalMinutes,
      pageDelaySeconds,
      jitterPercent,
      businessStartHour,
      businessEndHour,
      notifyMode,
      btMode,
      forrentLoginId,
      forrentPassword,
      suumoCompSkipThresholds,
      suumoBusinessKissCode,
      suumoBusinessFetchUrl,
      suumoBusinessLoginId,
      suumoBusinessPassword,
      suumoForrentStopDryRun,
      suumoSkipLowImageCount,
      itandiUpdatedWithinDays,
      suumoFinalSubmitDryRun,
      reinsLoginId, reinsPassword,
      itandiLoginId, itandiPassword,
      essquareLoginId, essquarePassword,
      ieloveLoginId, ielovePassword
    }, () => {
      // アラームを再設定
      chrome.runtime.sendMessage({ type: 'UPDATE_ALARM' });

      // SUUMO Discord Webhook URLをGASにも同期
      if (gasWebappUrl && suumoDiscordWebhookUrl) {
        fetch(gasWebappUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'set_suumo_webhook',
            api_key: gasApiKey,
            webhookUrl: suumoDiscordWebhookUrl
          })
        }).catch(err => console.warn('SUUMO Webhook URL同期失敗:', err));
      }

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

  // ForRent 停止テスト実行
  const forrentStopBtn = document.getElementById('forrentStopTestBtn');
  if (forrentStopBtn) {
    forrentStopBtn.addEventListener('click', () => {
      const codeInput = document.getElementById('forrentStopTestCode');
      const resultEl = document.getElementById('forrentStopTestResult');
      const dryRun = !!(document.getElementById('suumoForrentStopDryRun') || {}).checked;
      const code = (codeInput.value || '').trim().replace(/[^0-9]/g, '');
      if (!resultEl) return;
      if (!code) {
        resultEl.textContent = 'SUUMO物件コード(12桁)を入力してください';
        resultEl.style.color = '#dc2626';
        return;
      }
      if (code.length !== 12) {
        resultEl.textContent = `物件コードは12桁である必要があります(入力: ${code.length}桁)`;
        resultEl.style.color = '#dc2626';
        return;
      }
      // 本番実行時は最終確認ダイアログ
      if (!dryRun) {
        const confirmed = window.confirm(`⚠️ ドライランOFFで実行します。\n\n物件コード ${code} を ForRent で本当に「保留」に切り替えます。\n\n実行してよろしいですか？`);
        if (!confirmed) {
          resultEl.textContent = 'キャンセルされました';
          resultEl.style.color = '#6b7280';
          return;
        }
      }
      resultEl.textContent = (dryRun ? 'ドライラン実行中...' : '本番実行中...') + '(数十秒かかります)';
      resultEl.style.color = '#374151';
      forrentStopBtn.disabled = true;
      chrome.runtime.sendMessage({ type: 'FORRENT_STOP_TEST', suumoPropertyCode: code, dryRun: dryRun }, (response) => {
        forrentStopBtn.disabled = false;
        if (chrome.runtime.lastError) {
          resultEl.textContent = 'エラー: ' + chrome.runtime.lastError.message;
          resultEl.style.color = '#dc2626';
          return;
        }
        if (!response) {
          resultEl.textContent = '応答なし';
          resultEl.style.color = '#dc2626';
          return;
        }
        if (response.ok) {
          if (response.dryRun) {
            resultEl.textContent = 'ドライラン完了: 一括更新実行の直前で停止しました。開いているタブで目視確認してください';
            resultEl.style.color = '#065f46';
          } else if (response.alreadyStopped) {
            resultEl.textContent = '既に保留状態でした(何もせず終了)';
            resultEl.style.color = '#065f46';
          } else {
            resultEl.textContent = `本番実行完了: ${response.warning || '正常終了'}`;
            resultEl.style.color = response.warning ? '#f59e0b' : '#065f46';
          }
        } else {
          resultEl.textContent = '失敗: ' + (response.error || '不明なエラー');
          resultEl.style.color = '#dc2626';
        }
      });
    });
  }

  // ForRent状態同期 (PUB1R2801直読み)
  const forrentSyncBtn = document.getElementById('forrentStatusSyncBtn');
  if (forrentSyncBtn) {
    forrentSyncBtn.addEventListener('click', () => {
      const resultEl = document.getElementById('forrentStatusSyncResult');
      if (resultEl) {
        resultEl.textContent = 'ForRent PUB1R2801 から現在の成約状態を取得中...(数十秒)';
        resultEl.style.color = '#374151';
      }
      forrentSyncBtn.disabled = true;
      chrome.runtime.sendMessage({ type: 'SUUMO_FORRENT_STATUS_SYNC' }, (response) => {
        forrentSyncBtn.disabled = false;
        if (!resultEl) return;
        if (chrome.runtime.lastError) {
          resultEl.textContent = 'エラー: ' + chrome.runtime.lastError.message;
          resultEl.style.color = '#dc2626';
          return;
        }
        if (response && response.ok) {
          const r = response.result || {};
          resultEl.textContent = `完了: 取得${response.count}件 / stopped化=${r.stopped || 0} 復活=${r.reactivated || 0} 未マッチ=${r.unmatched || 0}`;
          resultEl.style.color = '#065f46';
        } else {
          resultEl.textContent = '失敗: ' + ((response && response.error) || '不明なエラー');
          resultEl.style.color = '#dc2626';
        }
      });
    });
  }

  // SUUMOビジネス ログインブロック解除
  const unblockBtn = document.getElementById('suumoBusinessUnblockBtn');
  if (unblockBtn) {
    unblockBtn.addEventListener('click', () => {
      chrome.storage.local.remove(['suumoBusinessLoginBlocked', 'suumoBusinessLoginBlockedReason'], () => {
        const blockedEl = document.getElementById('suumoBusinessLoginBlockedStatus');
        if (blockedEl) {
          blockedEl.textContent = '✓ ブロックなし(解除済み)';
          blockedEl.style.color = '#065f46';
        }
      });
    });
  }

  // ワンショット強制再取得リスト
  const forceList = document.getElementById('forceRefetchList');
  const forceCurrent = document.getElementById('forceRefetchCurrent');
  const forceStatus = document.getElementById('forceRefetchStatus');
  const renderForceCurrent = (arr) => {
    if (!forceCurrent) return;
    const list = Array.isArray(arr) ? arr : [];
    if (list.length === 0) {
      forceCurrent.textContent = '現在の登録: なし';
      forceCurrent.style.color = '#6b7280';
    } else {
      forceCurrent.textContent = `現在の登録: ${list.length}件 (${list.slice(0,3).join(', ')}${list.length > 3 ? '...' : ''})`;
      forceCurrent.style.color = '#059669';
    }
  };
  // 既存値を読み込み
  chrome.storage.local.get(['oneShotForceRefetch'], (data) => {
    const arr = Array.isArray(data.oneShotForceRefetch) ? data.oneShotForceRefetch : [];
    if (forceList) forceList.value = arr.join('\n');
    renderForceCurrent(arr);
  });
  const parseForceListText = (text) => {
    return (text || '')
      .split(/[\n,;]+/)
      .map(s => s.trim())
      .filter(Boolean);
  };
  const forceSaveBtn = document.getElementById('forceRefetchSaveBtn');
  if (forceSaveBtn) {
    forceSaveBtn.addEventListener('click', () => {
      const arr = parseForceListText(forceList && forceList.value);
      chrome.storage.local.set({ oneShotForceRefetch: arr }, () => {
        renderForceCurrent(arr);
        if (forceStatus) {
          forceStatus.textContent = `${arr.length}件を保存しました`;
          forceStatus.style.color = '#059669';
        }
      });
    });
  }
  const forceClearBtn = document.getElementById('forceRefetchClearBtn');
  if (forceClearBtn) {
    forceClearBtn.addEventListener('click', () => {
      chrome.storage.local.set({ oneShotForceRefetch: [] }, () => {
        if (forceList) forceList.value = '';
        renderForceCurrent([]);
        if (forceStatus) {
          forceStatus.textContent = 'リストをクリアしました';
          forceStatus.style.color = '#6b7280';
        }
      });
    });
  }
  const forceRunBtn = document.getElementById('forceRefetchRunBtn');
  if (forceRunBtn) {
    forceRunBtn.addEventListener('click', () => {
      // textareaの現在値を保存してから検索を実行
      const arr = parseForceListText(forceList && forceList.value);
      if (arr.length === 0) {
        if (forceStatus) {
          forceStatus.textContent = 'リストが空です。物件番号を入力してください';
          forceStatus.style.color = '#dc2626';
        }
        return;
      }
      chrome.storage.local.set({ oneShotForceRefetch: arr }, () => {
        renderForceCurrent(arr);
        if (forceStatus) {
          forceStatus.textContent = `${arr.length}件を保存 → 検索開始リクエスト送信中...`;
          forceStatus.style.color = '#059669';
        }
        chrome.runtime.sendMessage({ type: 'SEARCH_NOW' }, (response) => {
          if (chrome.runtime.lastError) {
            if (forceStatus) {
              forceStatus.textContent = '検索開始エラー: ' + chrome.runtime.lastError.message;
              forceStatus.style.color = '#dc2626';
            }
            return;
          }
          if (forceStatus) {
            forceStatus.textContent = `${arr.length}件の強制再取得つきで検索を開始しました。ログ画面で進行を確認してください`;
            forceStatus.style.color = '#059669';
          }
        });
      });
    });
  }

  // 4サービス ログインブロック解除ボタン(共通)
  const bindUnblock = (btnId, blockedKey, reasonKey, statusId) => {
    const btn = document.getElementById(btnId);
    if (!btn) return;
    btn.addEventListener('click', () => {
      chrome.storage.local.remove([blockedKey, reasonKey], () => {
        const el = document.getElementById(statusId);
        if (el) {
          el.textContent = '✓ ブロックなし(解除済み)';
          el.style.color = '#065f46';
        }
      });
    });
  };
  bindUnblock('reinsUnblockBtn', 'reinsLoginBlocked', 'reinsLoginBlockedReason', 'reinsLoginBlockedStatus');
  bindUnblock('itandiUnblockBtn', 'itandiLoginBlocked', 'itandiLoginBlockedReason', 'itandiLoginBlockedStatus');
  bindUnblock('essquareUnblockBtn', 'essquareLoginBlocked', 'essquareLoginBlockedReason', 'essquareLoginBlockedStatus');
  bindUnblock('ieloveUnblockBtn', 'ieloveLoginBlocked', 'ieloveLoginBlockedReason', 'ieloveLoginBlockedStatus');

  // SUUMOビジネス データ取得(手動実行ボタン)
  const suumoBusinessBtn = document.getElementById('suumoBusinessFetchBtn');
  if (suumoBusinessBtn) {
    suumoBusinessBtn.addEventListener('click', () => {
      const resultEl = document.getElementById('suumoBusinessFetchResult');
      if (resultEl) {
        resultEl.textContent = 'SUUMOビジネスを開いてデータ取得中...(数十秒かかることがあります)';
        resultEl.style.color = '#374151';
      }
      suumoBusinessBtn.disabled = true;
      chrome.runtime.sendMessage({ type: 'SUUMO_BUSINESS_FETCH_NOW' }, (response) => {
        suumoBusinessBtn.disabled = false;
        if (!resultEl) return;
        if (chrome.runtime.lastError) {
          resultEl.textContent = 'エラー: ' + chrome.runtime.lastError.message;
          resultEl.style.color = '#dc2626';
          return;
        }
        if (response && response.ok) {
          const r = response.result || {};
          const fmt = (v) => (v === undefined || v === null) ? '?' : v;
          resultEl.textContent = `完了: 送信${response.count}件 / GAS更新${fmt(r.updated)}件・新規${fmt(r.inserted)}件`;
          resultEl.style.color = '#065f46';
        } else {
          resultEl.textContent = '失敗: ' + ((response && response.error) || '不明なエラー');
          resultEl.style.color = '#dc2626';
        }
      });
    });
  }
});
