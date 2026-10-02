  const $ = (s) => document.querySelector(s);
  const API_URL = "https://api.deepseek.com/user/balance";
  const LS_KEY = "deepseek_balance_api_key";
  const LS_REMEMBER = "deepseek_balance_remember_key";

  // 新增：多账户管理相关常量
  const LS_ACCOUNTS_KEY = "deepseek_balance_accounts_v2";
  const LS_HISTORY_KEY = "deepseek_balance_history_v2";
  const LS_CURRENT_ACCOUNT = "deepseek_balance_current_account";
  // 平台用量接口不支持浏览器跨域,用量查询经本地代理转发（先双击运行 启动服务器.bat）
  const USAGE_PROXY_URL = "http://127.0.0.1:3000";

  const keyInput = $("#key");
  const eyeBtn = $("#eye");
  const rememberChk = $("#remember");
  const queryBtn = $("#query");
  const alertBox = $("#alert");
  const resultBox = $("#result");
  const metaEl = $("#meta");

  // 新增：多账户管理UI元素
  const accountSelector = $("#account-selector");
  const addAccountBtn = $("#add-account-btn");
  const manageAccountsBtn = $("#manage-accounts-btn");
  const accountModal = $("#account-modal");
  const modalClose = $("#modal-close");

  let currentAccountId = null;
  let currentChart = null;

  const EYE_OPEN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>';
  const EYE_CLOSED = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/><path d="M14.12 14.12a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>';
  const ICON_ALERT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>';

  let busy = false;

  class UserError extends Error {}

  function showAlert(kind, message) {
    alertBox.className = "alert show " + kind;
    alertBox.innerHTML = ICON_ALERT + "<div>" + message + "</div>";
  }
  function hideAlert() {
    alertBox.className = "alert";
  }

  /* ========== 多账户管理 ========== */
  function getAccounts() {
    try {
      const raw = localStorage.getItem(LS_ACCOUNTS_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch (_) {
      return [];
    }
  }

  function saveAccounts(accounts) {
    try {
      localStorage.setItem(LS_ACCOUNTS_KEY, JSON.stringify(accounts));
    } catch (_) {}
  }

  function addAccount(name, apiKey) {
    const accounts = getAccounts();
    const newAccount = {
      id: 'acc_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9),
      name: name,
      apiKey: apiKey,
      createdAt: Date.now()
    };
    accounts.push(newAccount);
    saveAccounts(accounts);
    return newAccount;
  }

  function deleteAccount(id) {
    const accounts = getAccounts().filter(a => a.id !== id);
    saveAccounts(accounts);

    // 清理该账户的历史记录
    try {
      const allHistory = JSON.parse(localStorage.getItem(LS_HISTORY_KEY) || '{}');
      delete allHistory[id];
      localStorage.setItem(LS_HISTORY_KEY, JSON.stringify(allHistory));
    } catch (_) {}

    // 如果删除的是当前账户，清空选择
    if (currentAccountId === id) {
      currentAccountId = null;
      localStorage.removeItem(LS_CURRENT_ACCOUNT);
    }
  }

  function getAccountById(id) {
    return getAccounts().find(a => a.id === id);
  }

  function getCurrentAccountId() {
    try {
      return localStorage.getItem(LS_CURRENT_ACCOUNT);
    } catch (_) {
      return null;
    }
  }

  function setCurrentAccountId(id) {
    try {
      localStorage.setItem(LS_CURRENT_ACCOUNT, id);
    } catch (_) {}
  }

  /* ========== 历史记录管理 ========== */
  function saveHistoryRecord(accountId, balanceData) {
    try {
      const allHistory = JSON.parse(localStorage.getItem(LS_HISTORY_KEY) || '{}');

      if (!allHistory[accountId]) {
        allHistory[accountId] = [];
      }

      const record = {
        timestamp: Date.now(),
        data: balanceData
      };

      allHistory[accountId].push(record);

      // 只保留最近90天的数据
      const ninetyDaysAgo = Date.now() - 90 * 24 * 3600 * 1000;
      allHistory[accountId] = allHistory[accountId].filter(r => r.timestamp >= ninetyDaysAgo);

      localStorage.setItem(LS_HISTORY_KEY, JSON.stringify(allHistory));
    } catch (_) {}
  }

  function getHistory(accountId) {
    try {
      const allHistory = JSON.parse(localStorage.getItem(LS_HISTORY_KEY) || '{}');
      return allHistory[accountId] || [];
    } catch (_) {
      return [];
    }
  }

  /* ========== 数据迁移 ========== */
  function migrateOldData() {
    try {
      const oldKey = localStorage.getItem(LS_KEY);
      const oldRemember = localStorage.getItem(LS_REMEMBER);

      if (oldKey && oldRemember === '1') {
        const accounts = getAccounts();
        if (accounts.length === 0) {
          const newAccount = addAccount('默认账户', oldKey);
          setCurrentAccountId(newAccount.id);
        }
      }
    } catch (_) {}
  }

  /* ========== UI渲染 ========== */
  function renderAccountSelector() {
    const accounts = getAccounts();

    accountSelector.innerHTML = '<option value="">选择或输入API Key</option>' +
      accounts.map(acc => {
        const masked = acc.apiKey.substring(0, 7) + '...' + acc.apiKey.slice(-4);
        return `<option value="${acc.id}">${acc.name} (${masked})</option>`;
      }).join('');

    const currentId = getCurrentAccountId();
    if (currentId) {
      accountSelector.value = currentId;
    }
  }

  function renderAccountList() {
    const accounts = getAccounts();
    const listEl = $("#account-list");

    if (accounts.length === 0) {
      listEl.innerHTML = '<div class="empty-state">暂无保存的账户</div>';
      return;
    }

    listEl.innerHTML = accounts.map(acc => {
      const masked = acc.apiKey.substring(0, 7) + '...' + acc.apiKey.slice(-4);
      const history = getHistory(acc.id);
      const recordCount = history.length;

      return `
        <div class="account-item">
          <div class="account-info">
            <div class="account-name">${acc.name}</div>
            <div class="account-key">${masked}</div>
            <div class="account-meta">${recordCount} 条历史记录</div>
          </div>
          <button class="btn-delete" onclick="handleDeleteAccount('${acc.id}')">删除</button>
        </div>
      `;
    }).join('');
  }

  window.handleDeleteAccount = function(id) {
    const account = getAccountById(id);
    if (!account) return;

    if (confirm(`确定要删除账户"${account.name}"吗？这将同时删除该账户的所有历史记录。`)) {
      deleteAccount(id);
      renderAccountSelector();
      renderAccountList();

      if (currentAccountId === id) {
        keyInput.value = '';
        resultBox.innerHTML = '';
      }

      showAlert('info', '账户已删除');
      setTimeout(hideAlert, 2000);
    }
  };

  function fmtAmount(raw, currency) {
    const n = Number.parseFloat(raw);
    if (!Number.isFinite(n)) return raw == null ? "--" : String(raw);
    const symbol = currency === "CNY" ? "\u00a5" : currency === "USD" ? "$" : "";
    return symbol + n.toFixed(2);
  }

  const CURRENCY_NAME = { CNY: "人民币", USD: "美元" };

  /* ---------- USD → CNY 汇率（多来源竞速 + 本地缓存回退） ---------- */
  const RATE_CACHE_KEY = "deepseek_balance_usd_cny_rate";
  const RATE_PROVIDERS = [
    {
      name: "open.er-api.com",
      url: "https://open.er-api.com/v6/latest/USD",
      pick: (j) => j && j.rates && j.rates.CNY,
      date: (j) => isoDate(j && j.time_last_update_utc),
    },
    {
      name: "exchangerate-api.com",
      url: "https://api.exchangerate-api.com/v4/latest/USD",
      pick: (j) => j && j.rates && j.rates.CNY,
      date: (j) => isoDate(j && (j.time_last_update_utc || j.date)),
    },
    {
      name: "currency-api (jsDelivr)",
      url: "https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.json",
      pick: (j) => j && j.usd && j.usd.cny,
      date: (j) => (j && j.date) || "",
    },
  ];

  function isoDate(s) {
    const d = s ? new Date(s) : null;
    return d && !Number.isNaN(d.getTime()) ? d.toISOString().slice(0, 10) : "";
  }
  let rateMemo = null;

  function fetchRateFrom(provider) {
    return fetch(provider.url, { cache: "no-store", signal: AbortSignal.timeout(6000) })
      .then((res) => {
        if (!res.ok) throw new Error("HTTP " + res.status);
        return res.json();
      })
      .then((j) => {
        const v = provider.pick(j);
        if (typeof v !== "number" || !(v > 0)) throw new Error("invalid rate");
        return { value: v, date: provider.date(j) || "", source: provider.name, cached: false };
      });
  }

  function saveRateCache(r) {
    try {
      localStorage.setItem(RATE_CACHE_KEY, JSON.stringify({ value: r.value, date: r.date, source: r.source, ts: Date.now() }));
    } catch (_) {}
  }

  function loadRateCache() {
    try {
      const raw = localStorage.getItem(RATE_CACHE_KEY);
      if (!raw) return null;
      const j = JSON.parse(raw);
      if (j && typeof j.value === "number" && Date.now() - j.ts < 7 * 24 * 3600 * 1000) {
        return { value: j.value, date: j.date || "", source: j.source || "", cached: true };
      }
    } catch (_) {}
    return null;
  }

  function getUsdCnyRate() {
    if (rateMemo) return Promise.resolve(rateMemo);
    return new Promise((resolve) => {
      let remaining = RATE_PROVIDERS.length;
      let settled = false;
      const finish = (r) => {
        if (!settled) { settled = true; resolve(r); }
      };
      for (const p of RATE_PROVIDERS) {
        fetchRateFrom(p)
          .then((r) => { rateMemo = r; saveRateCache(r); finish(r); })
          .catch(() => {})
          .finally(() => { remaining -= 1; if (remaining === 0) finish(null); });
      }
    }).then((r) => {
      if (r) return r;
      const cached = loadRateCache();
      if (cached) rateMemo = cached;
      return cached;
    });
  }

  function renderCnyLine(info, cur, rate) {
    if (cur !== "USD") return "";
    if (!rate) return '<div class="rate-hint bad">人民币折算暂不可用（汇率获取失败）</div>';
    const usd = Number.parseFloat(info.total_balance);
    if (!Number.isFinite(usd)) return "";
    return (
      '<div class="cny">\u2248 \u00a5' + (usd * rate.value).toFixed(2) + "</div>" +
      '<div class="rate-hint">按汇率 1 USD \u2248 ' + rate.value.toFixed(4) + " CNY 估算" +
      (rate.cached ? "（缓存值）" : "") + "</div>"
    );
  }

  function render(data, rate) {
    const infos = Array.isArray(data.balance_infos) ? data.balance_infos : [];
    const ok = data.is_available === true;

    const badge = ok
      ? '<span class="badge ok">\u2713 账户可用</span>'
      : '<span class="badge bad">! 余额不足，无法调用</span>';

    let html = '<div class="status">' + badge +
      "<span>共 " + infos.length + " 个币种账户</span></div>";

    if (!infos.length) {
      html += '<div class="bal"><div class="top"><span class="label">接口未返回余额明细</span></div></div>';
    }

    for (const info of infos) {
      const cur = info.currency || "";
      const curName = CURRENCY_NAME[cur] ? " · " + CURRENCY_NAME[cur] : "";
      html +=
        '<div class="bal">' +
          '<div class="top">' +
            '<span class="label">总余额</span>' +
            '<span class="cur">' + (cur || "--") + curName + "</span>" +
          "</div>" +
          '<div class="total">' + fmtAmount(info.total_balance, cur) + "</div>" +
          renderCnyLine(info, cur, rate) +
          '<div class="rows">' +
            '<div class="row"><span>充值余额</span><b>' + fmtAmount(info.topped_up_balance, cur) + "</b></div>" +
            '<div class="row"><span>赠金余额</span><b>' + fmtAmount(info.granted_balance, cur) + "</b></div>" +
          "</div>" +
        "</div>";
    }

    resultBox.innerHTML = html;
    resultBox.classList.add("show");
  }

  async function query() {
    if (busy) return;
    const key = keyInput.value.trim();

    if (!key) {
      showAlert("warn", "请先输入 API Key。");
      keyInput.focus();
      return;
    }
    if (!key.startsWith("sk-")) {
      showAlert("warn", "提醒：DeepSeek 的 API Key 一般以 sk- 开头，请确认是否复制完整。");
    } else {
      hideAlert();
    }

    busy = true;
    queryBtn.disabled = true;
    queryBtn.innerHTML = '<span class="spinner"></span>查询中…';
    resultBox.classList.remove("show");

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 20000);

    try {
      const res = await fetch(API_URL, {
        method: "GET",
        headers: { "Authorization": "Bearer " + key, "Accept": "application/json" },
        signal: ctrl.signal,
        cache: "no-store",
      });

      if (!res.ok) {
        let detail = "";
        try {
          const body = await res.json();
          detail = (body && body.error && body.error.message) || "";
        } catch (_) {}

        if (res.status === 401) throw new UserError("API Key 无效或已被禁用。请检查是否复制完整、有没有多余的空格或换行。");
        if (res.status === 402) throw new UserError("账户余额不足。");
        if (res.status === 429) throw new UserError("请求太频繁，请稍后再试。");
        throw new UserError("DeepSeek 接口返回错误：HTTP " + res.status + (detail ? "（" + detail + "）" : ""));
      }

      const data = await res.json();

      let rate = null;
      const hasUsd = Array.isArray(data.balance_infos) &&
        data.balance_infos.some((x) => x && x.currency === "USD");
      if (hasUsd) rate = await getUsdCnyRate();

      hideAlert();
      render(data, rate);

      // 保存历史记录
      if (currentAccountId) {
        saveHistoryRecord(currentAccountId, data);
        updateHistoryView();
        updateStatsView();
      }

      try {
        if (rememberChk.checked) {
          localStorage.setItem(LS_KEY, key);
          localStorage.setItem(LS_REMEMBER, "1");
        } else {
          localStorage.removeItem(LS_KEY);
          localStorage.removeItem(LS_REMEMBER);
        }
      } catch (_) {}

      const timeStr = new Date().toLocaleString("zh-CN", { hour12: false });
      metaEl.innerHTML =
        (rate
          ? "汇率数据：" + rate.source + (rate.date ? "（" + rate.date + "）" : "") + "<br>"
          : "") +
        "查询时间 " + timeStr;
    } catch (err) {
      if (err instanceof UserError) {
        showAlert("err", err.message);
      } else if (err && err.name === "AbortError") {
        showAlert("err", "请求超时（20 秒）。请检查网络状况后重试。");
      } else {
        showAlert("err", "无法连接 api.deepseek.com。请检查网络或代理设置；若网络正常，请尝试用 Chrome / Edge 打开本页面。");
      }
    } finally {
      clearTimeout(timer);
      busy = false;
      queryBtn.disabled = false;
      queryBtn.textContent = "查询余额";
    }
  }

  eyeBtn.innerHTML = EYE_OPEN;
  eyeBtn.addEventListener("click", () => {
    const show = keyInput.type === "password";
    keyInput.type = show ? "text" : "password";
    eyeBtn.innerHTML = show ? EYE_CLOSED : EYE_OPEN;
    keyInput.focus();
  });

  rememberChk.addEventListener("change", () => {
    if (!rememberChk.checked) {
      try {
        localStorage.removeItem(LS_KEY);
        localStorage.removeItem(LS_REMEMBER);
      } catch (_) {}
    }
  });

  queryBtn.addEventListener("click", query);
  keyInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") query();
  });
  keyInput.addEventListener("input", () => {
    if (alertBox.classList.contains("warn")) hideAlert();
  });

  /* ========== 历史趋势图表 ========== */
  function updateHistoryView() {
    if (!currentAccountId) return;

    const history = getHistory(currentAccountId);
    const chartContainer = $("#chart-container");
    const chartCanvas = $("#balance-chart");
    const chartPlaceholder = $("#chart-placeholder");
    const historyList = $("#history-list");

    if (!history || history.length === 0) {
      chartPlaceholder.style.display = 'block';
      chartCanvas.style.display = 'none';
      historyList.innerHTML = '<div class="empty-state"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 3v18h18"/><polyline points="7 10 12 5 17 8 21 4"/></svg><div>暂无历史记录</div></div>';
      return;
    }

    // 获取时间范围
    const activeRange = document.querySelector('.range-btn.active');
    const range = activeRange ? activeRange.dataset.range : '7';

    let filteredHistory = history;
    if (range !== 'all') {
      const days = parseInt(range);
      const cutoff = Date.now() - days * 24 * 3600 * 1000;
      filteredHistory = history.filter(h => h.timestamp >= cutoff);
    }

    if (filteredHistory.length === 0) {
      chartPlaceholder.style.display = 'block';
      chartCanvas.style.display = 'none';
      historyList.innerHTML = '<div class="empty-state">该时间范围内无数据</div>';
      return;
    }

    // 绘制图表
    chartPlaceholder.style.display = 'none';
    chartCanvas.style.display = 'block';

    const labels = [];
    const cnyData = [];
    const usdData = [];

    filteredHistory.forEach(record => {
      const date = new Date(record.timestamp);
      labels.push(date.toLocaleDateString('zh-CN', {month: 'numeric', day: 'numeric'}));

      const infos = record.data?.balance_infos || [];
      const cnyInfo = infos.find(i => i.currency === 'CNY');
      const usdInfo = infos.find(i => i.currency === 'USD');

      if (cnyInfo) {
        cnyData.push(parseFloat(cnyInfo.total_balance) || 0);
      } else {
        cnyData.push(null);
      }

      if (usdInfo) {
        usdData.push(parseFloat(usdInfo.total_balance) || 0);
      } else {
        usdData.push(null);
      }
    });

    if (currentChart) {
      currentChart.destroy();
    }

    const ctx = chartCanvas.getContext('2d');
    currentChart = new Chart(ctx, {
      type: 'line',
      data: {
        labels: labels,
        datasets: [
          {
            label: '人民币 (CNY)',
            data: cnyData,
            borderColor: '#6ee7b7',
            backgroundColor: 'rgba(110, 231, 183, 0.1)',
            tension: 0.3,
            fill: true,
            pointRadius: 4,
            pointHoverRadius: 6
          },
          {
            label: '美元 (USD)',
            data: usdData,
            borderColor: '#60a5fa',
            backgroundColor: 'rgba(96, 165, 250, 0.1)',
            tension: 0.3,
            fill: true,
            pointRadius: 4,
            pointHoverRadius: 6
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: {
            labels: {
              color: '#9ca3af',
              font: {size: 12}
            }
          },
          tooltip: {
            backgroundColor: 'rgba(17, 24, 39, 0.95)',
            titleColor: '#e5e7eb',
            bodyColor: '#d1d5db',
            borderColor: 'rgba(255, 255, 255, 0.1)',
            borderWidth: 1
          }
        },
        scales: {
          y: {
            beginAtZero: true,
            ticks: {color: '#9ca3af'},
            grid: {color: 'rgba(255, 255, 255, 0.05)'}
          },
          x: {
            ticks: {color: '#9ca3af'},
            grid: {color: 'rgba(255, 255, 255, 0.05)'}
          }
        }
      }
    });

    // 渲染历史列表
    historyList.innerHTML = filteredHistory.slice().reverse().slice(0, 10).map((record, idx) => {
      const date = new Date(record.timestamp);
      const timeStr = date.toLocaleString('zh-CN', {
        month: 'numeric',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
      });

      const infos = record.data?.balance_infos || [];
      const cnyInfo = infos.find(i => i.currency === 'CNY');
      const usdInfo = infos.find(i => i.currency === 'USD');

      let balanceStr = '';
      if (cnyInfo) balanceStr += `¥${parseFloat(cnyInfo.total_balance).toFixed(2)}`;
      if (usdInfo) balanceStr += (balanceStr ? ' / ' : '') + `$${parseFloat(usdInfo.total_balance).toFixed(2)}`;

      let changeHtml = '';
      if (idx < filteredHistory.length - 1) {
        const prevRecord = filteredHistory[filteredHistory.length - 2 - idx];
        const prevInfos = prevRecord.data?.balance_infos || [];
        const prevCny = prevInfos.find(i => i.currency === 'CNY');

        if (cnyInfo && prevCny) {
          const diff = parseFloat(cnyInfo.total_balance) - parseFloat(prevCny.total_balance);
          if (Math.abs(diff) > 0.01) {
            const cls = diff > 0 ? 'positive' : 'negative';
            const sign = diff > 0 ? '+' : '';
            changeHtml = `<span class="history-change ${cls}">${sign}¥${diff.toFixed(2)}</span>`;
          }
        }
      }

      return `
        <div class="history-item">
          <span class="history-time">${timeStr}</span>
          <span class="history-balance">${balanceStr}</span>
          ${changeHtml}
        </div>
      `;
    }).join('');
  }

  /* ========== 消费统计 ========== */
  function updateStatsView() {
    if (!currentAccountId) {
      $("#stat-today").textContent = '--';
      $("#stat-week").textContent = '--';
      $("#stat-month").textContent = '--';
      $("#stat-avg").textContent = '--';
      return;
    }

    const history = getHistory(currentAccountId);
    if (!history || history.length < 2) {
      $("#stat-today").textContent = '无数据';
      $("#stat-week").textContent = '无数据';
      $("#stat-month").textContent = '无数据';
      $("#stat-avg").textContent = '无数据';
      return;
    }

    const now = Date.now();
    const oneDayAgo = now - 24 * 3600 * 1000;
    const oneWeekAgo = now - 7 * 24 * 3600 * 1000;
    const oneMonthAgo = now - 30 * 24 * 3600 * 1000;

    function calcConsumption(startTime) {
      const records = history.filter(h => h.timestamp >= startTime).sort((a, b) => a.timestamp - b.timestamp);
      if (records.length < 2) return null;

      const first = records[0];
      const last = records[records.length - 1];

      const firstCny = first.data?.balance_infos?.find(i => i.currency === 'CNY');
      const lastCny = last.data?.balance_infos?.find(i => i.currency === 'CNY');

      if (!firstCny || !lastCny) return null;

      const diff = parseFloat(firstCny.total_balance) - parseFloat(lastCny.total_balance);
      return diff;
    }

    const todayConsume = calcConsumption(oneDayAgo);
    const weekConsume = calcConsumption(oneWeekAgo);
    const monthConsume = calcConsumption(oneMonthAgo);

    const formatStat = (val) => {
      if (val === null) return '无数据';
      if (val < 0.01) return '¥0.00';
      return `¥${val.toFixed(2)}`;
    };

    $("#stat-today").textContent = formatStat(todayConsume);
    $("#stat-week").textContent = formatStat(weekConsume);
    $("#stat-month").textContent = formatStat(monthConsume);

    // 日均消费
    if (monthConsume !== null && monthConsume > 0) {
      const daysInPeriod = Math.max(1, (now - oneMonthAgo) / (24 * 3600 * 1000));
      const avgDaily = monthConsume / daysInPeriod;
      $("#stat-avg").textContent = formatStat(avgDaily);
    } else {
      $("#stat-avg").textContent = '无数据';
    }

    if (todayConsume !== null && todayConsume > 0) $("#stat-today").classList.add('negative');
    else $("#stat-today").classList.remove('negative');

    if (weekConsume !== null && weekConsume > 0) $("#stat-week").classList.add('negative');
    else $("#stat-week").classList.remove('negative');

    if (monthConsume !== null && monthConsume > 0) $("#stat-month").classList.add('negative');
    else $("#stat-month").classList.remove('negative');
  }
