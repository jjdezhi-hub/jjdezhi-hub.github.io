  /* ========== 用量统计（平台内部接口,经本地代理） ========== */
  const LS_USAGE_TOKEN = "deepseek_usage_token_v1";
  const LS_USAGE_REMEMBER = "deepseek_usage_remember_v1";
  const USAGE_CMD = "copy(JSON.parse(localStorage.userToken).value)";

  const usageTokenInput = $("#usage-token");
  const usageTokenEye = $("#usage-token-eye");
  const usageTokenRemember = $("#usage-token-remember");
  const usageQueryBtn = $("#query-usage-btn");
  const usageStatsEl = $("#usage-stats");
  const usageChartsEl = $("#usage-charts");
  const usageResultsEl = $("#usage-results");

  let usageBusy = false;
  let usageDays = null; // { 'YYYY-MM-DD': {cost,tokens,hit,miss,resp,requests} }
  let usageRange = 7;
  let usageCostChart = null;
  let usageTokenChart = null;

  function pad2(n) { return n < 10 ? "0" + n : "" + n; }
  function dayKeyOf(d) { return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate()); }
  function emptyUsageRec() { return { cost: 0, tokens: 0, hit: 0, miss: 0, resp: 0, requests: 0 }; }

  function ensureUsageRec(map, date) {
    if (!map[date]) map[date] = emptyUsageRec();
    return map[date];
  }

  function setUsageTokenStatus(text, cls) {
    const el = $("#usage-token-status");
    if (!el) return;
    el.textContent = text;
    el.className = "usage-token-status" + (cls ? " " + cls : "");
  }

  function toNumber(value) {
    if (value == null) return 0;
    if (typeof value === "object") value = value.value;
    const n = parseFloat(value);
    return Number.isFinite(n) ? n : 0;
  }
  function toInt(value) { return Math.round(toNumber(value)); }

  function usageBucketDate(unix) {
    let ms = Number(unix);
    if (!Number.isFinite(ms)) return null;
    if (ms < 1e12) ms *= 1000; // 秒 → 毫秒
    return dayKeyOf(new Date(ms));
  }

  function addAmountItem(rec, type, raw) {
    const v = toInt(raw);
    if (type === "REQUEST") { rec.requests += v; return; }
    rec.tokens += v;
    if (type === "PROMPT_CACHE_HIT_TOKEN") rec.hit += v;
    else if (type === "PROMPT_CACHE_MISS_TOKEN") rec.miss += v;
    else if (type === "RESPONSE_TOKEN") rec.resp += v;
  }

  // 解析平台返回;兼容两种结构：
  //   按日范围（by_api_key）: biz_data.series[].buckets[].usage / .cost
  //   按月（month/year）    : biz_data.days[].data[].usage[]（cost 为 biz_data[0].days）
  function parseUsagePayloads(amountBody, costBody) {
    const aData = amountBody && amountBody.data && amountBody.data.biz_data;
    if (!aData) throw new Error("amount 响应缺少 biz_data");
    const days = {};
    let mode = "range";

    if (Array.isArray(aData.series)) {
      for (const series of aData.series) {
        for (const bucket of (series.buckets || [])) {
          const date = usageBucketDate(bucket.time);
          if (!date) continue;
          const rec = ensureUsageRec(days, date);
          const usage = bucket.usage || {};
          for (const type of Object.keys(usage)) addAmountItem(rec, type, usage[type]);
        }
      }
    } else if (Array.isArray(aData.days)) {
      mode = "month";
      for (const day of aData.days) {
        if (!day || !day.date) continue;
        const rec = ensureUsageRec(days, day.date);
        for (const modelUsage of (day.data || [])) {
          for (const item of (modelUsage.usage || [])) addAmountItem(rec, item.type, item.amount);
        }
      }
    } else {
      throw new Error("无法识别的用量数据结构");
    }

    let currency = "CNY";
    const cData = costBody && costBody.data && costBody.data.biz_data;
    let costBlock = null;
    if (Array.isArray(cData)) {
      costBlock = cData.find((b) => b && b.currency === "CNY") || cData[0] || null;
    } else if (cData && Array.isArray(cData.data)) {
      costBlock = cData.data.find((b) => b && b.currency === "CNY") || cData.data[0] || null;
    }
    if (costBlock) {
      currency = costBlock.currency || currency;
      for (const series of (costBlock.series || [])) {
        for (const bucket of (series.buckets || [])) {
          const date = usageBucketDate(bucket.time);
          if (!date) continue;
          ensureUsageRec(days, date).cost += toNumber(bucket.cost);
        }
      }
      for (const day of (costBlock.days || [])) {
        if (!day || !day.date) continue;
        const rec = ensureUsageRec(days, day.date);
        for (const modelUsage of (day.data || [])) {
          for (const item of (modelUsage.usage || [])) {
            if (item.type === "REQUEST") continue;
            rec.cost += toNumber(item.amount);
          }
        }
      }
    }

    return { mode, currency, days };
  }

  // 合并多个月份的解析结果
  function mergeUsageResults(results) {
    const merged = { mode: "month", currency: "CNY", days: {} };
    for (const r of results) {
      merged.currency = r.currency || merged.currency;
      for (const date of Object.keys(r.days)) {
        const src = r.days[date];
        const dst = ensureUsageRec(merged.days, date);
        dst.cost += src.cost;
        dst.tokens += src.tokens;
        dst.hit += src.hit;
        dst.miss += src.miss;
        dst.resp += src.resp;
        dst.requests += src.requests;
      }
    }
    return merged;
  }

  async function usageProxyPost(pathname, payload) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 25000);
    try {
      const res = await fetch(USAGE_PROXY_URL + pathname, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: ctrl.signal,
        cache: "no-store"
      });
      let body = null;
      try { body = await res.json(); } catch (_) {}
      return { status: res.status, body };
    } catch (err) {
      const e = new Error(err && err.name === "AbortError" ? "本地代理请求超时" : "无法连接本地代理服务器");
      e.isProxyDown = true;
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  function isUsageAuthError(res) {
    if (!res) return false;
    if (res.status === 401 || res.status === 403) return true;
    const body = res.body || {};
    const codes = [body.code, body.data && body.data.biz_code];
    return codes.some((c) => c === 40002 || c === 40003);
  }

  function usageErrDetail(res) {
    const body = (res && res.body) || {};
    const msg = body.msg || (body.data && body.data.biz_msg) || body.details || body.error || "";
    return "HTTP " + (res ? res.status : "?") + (msg ? "（" + msg + "）" : "");
  }

  function usageRangeParams() {
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 29, 0, 0, 0);
    const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0);
    const tz = -now.getTimezoneOffset() * 60;
    return { start: Math.floor(start.getTime() / 1000), end: Math.floor(end.getTime() / 1000), tz };
  }

  async function fetchUsageRange(token) {
    const w = usageRangeParams();
    return await Promise.all([
      usageProxyPost("/api/usage/amount", { token, start: w.start, end: w.end, tz: w.tz }),
      usageProxyPost("/api/usage/cost", { token, start: w.start, end: w.end, tz: w.tz })
    ]);
  }

  async function fetchUsageMonthly(token) {
    const now = new Date();
    const months = [];
    for (const back of [1, 0]) {
      const d = new Date(now.getFullYear(), now.getMonth() - back, 1);
      months.push({ month: d.getMonth() + 1, year: d.getFullYear() });
    }
    const jobs = [];
    for (const m of months) {
      jobs.push(usageProxyPost("/api/usage/amount", { token, month: m.month, year: m.year }).then((r) => ({ ...r, kind: "amount", month: m.month })));
      jobs.push(usageProxyPost("/api/usage/cost", { token, month: m.month, year: m.year }).then((r) => ({ ...r, kind: "cost", month: m.month })));
    }
    return await Promise.all(jobs);
  }

  async function queryUsage() {
    if (usageBusy) return;
    const token = usageTokenInput.value.trim();
    if (!token) {
      showAlert("warn", "请先粘贴平台登录 Token（展开上方“如何获取 Token？”查看步骤）。");
      usageTokenInput.focus();
      return;
    }

    try {
      if (usageTokenRemember.checked) {
        localStorage.setItem(LS_USAGE_TOKEN, token);
        localStorage.setItem(LS_USAGE_REMEMBER, "1");
        setUsageTokenStatus("已保存", "ok");
      } else {
        localStorage.removeItem(LS_USAGE_TOKEN);
        localStorage.removeItem(LS_USAGE_REMEMBER);
        setUsageTokenStatus("未保存");
      }
    } catch (_) {}

    usageBusy = true;
    usageQueryBtn.disabled = true;
    usageQueryBtn.innerHTML = '<span class="spinner"></span>查询中…';
    usageResultsEl.innerHTML = '<div class="empty-state">正在通过本地代理获取平台用量数据…</div>';

    try {
      let parsed = null;
      let source = "range";
      let rangeError = "";

      // 1) 优先：按日范围接口（官网用量页同款）,一次可拿最近 30 天
      try {
        const [amountRes, costRes] = await fetchUsageRange(token);
        if (isUsageAuthError(amountRes) || isUsageAuthError(costRes)) {
          throw new UserError("平台 Token 无效或已过期,请重新获取（展开上方“如何获取 Token？”查看步骤）。");
        }
        if (amountRes.status !== 200 || costRes.status !== 200) {
          rangeError = "按日接口 " + usageErrDetail(amountRes.status !== 200 ? amountRes : costRes);
        } else {
          parsed = parseUsagePayloads(amountRes.body, costRes.body);
        }
      } catch (err) {
        if (err instanceof UserError) throw err;
        if (err.isProxyDown) throw err;
        rangeError = err.message || "按日接口请求失败";
      }

      // 2) 回退：按月接口（当前月 + 上一个月）
      if (!parsed) {
        const results = await fetchUsageMonthly(token);
        if (results.some((r) => isUsageAuthError(r))) {
          throw new UserError("平台 Token 无效或已过期,请重新获取（展开上方“如何获取 Token？”查看步骤）。");
        }
        const bad = results.find((r) => r.status !== 200);
        if (bad) {
          throw new Error("按日接口失败（" + rangeError + "）,按月接口也不可用（" + usageErrDetail(bad) + "）;若持续失败,可能是平台接口有调整。");
        }
        const byMonth = {};
        for (const r of results) (byMonth[r.month] = byMonth[r.month] || {})[r.kind] = r;
        const parsedList = [];
        for (const month of Object.keys(byMonth)) {
          const pair = byMonth[month];
          parsedList.push(parseUsagePayloads(pair.amount.body, pair.cost.body));
        }
        parsed = mergeUsageResults(parsedList);
        source = "month";
      }

      hideAlert();
      renderUsage(parsed, source);
    } catch (err) {
      let msg;
      if (err && err.isProxyDown) {
        msg = err.message + "（" + USAGE_PROXY_URL + "）。请先双击运行 <b>启动服务器.bat</b> 启动本地代理,再重试。";
      } else if (err instanceof UserError) {
        msg = err.message;
      } else {
        msg = "查询用量失败：" + ((err && err.message) || "未知错误");
      }
      showAlert("err", msg);
      usageResultsEl.innerHTML = "";
    } finally {
      usageBusy = false;
      usageQueryBtn.disabled = false;
      usageQueryBtn.textContent = "查询用量";
    }
  }

  function usageWindowDates(n) {
    const now = new Date();
    const list = [];
    for (let i = n - 1; i >= 0; i--) {
      list.push(dayKeyOf(new Date(now.getFullYear(), now.getMonth(), now.getDate() - i)));
    }
    return list;
  }

  function sumUsageDates(dates) {
    let cost = 0, tokens = 0, requests = 0;
    for (const d of dates) {
      const r = usageDays[d];
      if (r) { cost += r.cost; tokens += r.tokens; requests += r.requests; }
    }
    return { cost, tokens, requests };
  }

  function fmtCost(n) {
    if (!Number.isFinite(n) || n <= 0) return "¥0.00";
    if (n < 0.01) return "¥" + n.toFixed(4);
    if (n < 10000) return "¥" + n.toFixed(2);
    return "¥" + n.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function fmtTokens(n) {
    if (!Number.isFinite(n) || n <= 0) return "0";
    if (n >= 1e8) return (n / 1e8).toFixed(2) + " 亿";
    if (n >= 1e4) return (n / 1e4).toFixed(1) + " 万";
    return n.toLocaleString("zh-CN");
  }

  function fmtTokensFull(n) { return (Number.isFinite(n) ? n : 0).toLocaleString("zh-CN"); }

  function renderUsage(parsed, source) {
    usageDays = parsed.days || {};
    const todayKey = dayKeyOf(new Date());
    const todayRec = usageDays[todayKey] || emptyUsageRec();
    const week = sumUsageDates(usageWindowDates(7));
    const month = sumUsageDates(usageWindowDates(30));

    $("#usage-today-cost").textContent = fmtCost(todayRec.cost);
    $("#usage-week-cost").textContent = fmtCost(week.cost);
    $("#usage-month-cost").textContent = fmtCost(month.cost);
    $("#usage-today-tokens").textContent = fmtTokens(todayRec.tokens);
    $("#usage-week-tokens").textContent = fmtTokens(week.tokens);
    $("#usage-month-tokens").textContent = fmtTokens(month.tokens);

    usageStatsEl.style.display = "";
    usageChartsEl.style.display = "";

    const timeStr = new Date().toLocaleString("zh-CN", { hour12: false, month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
    $("#usage-updated").textContent = "更新于 " + timeStr + (source === "month" ? " · 按月接口" : "");

    renderUsageCharts();
    renderUsageTable();
  }

  function compactTick(v) {
    if (v >= 1e8) return (v / 1e8).toFixed(1) + "亿";
    if (v >= 1e4) return Math.round(v / 1e4) + "万";
    return v;
  }

  function usageChartBaseOptions(tooltipFormatter) {
    return {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 250 },
      plugins: {
        legend: { labels: { color: "#8b94a8", font: { size: 11 }, boxWidth: 10, boxHeight: 10 } },
        tooltip: {
          backgroundColor: "rgba(17,24,39,.96)",
          titleColor: "#e9edf6",
          bodyColor: "#d1d5db",
          borderColor: "rgba(255,255,255,.1)",
          borderWidth: 1,
          callbacks: { label: (ctx) => " " + ctx.dataset.label + "：" + tooltipFormatter(ctx.parsed.y) }
        }
      },
      scales: {
        x: { ticks: { color: "#5f6880", font: { size: 10 }, maxTicksLimit: 16 }, grid: { display: false } },
        y: {
          beginAtZero: true,
          ticks: { color: "#5f6880", font: { size: 10 }, callback: compactTick },
          grid: { color: "rgba(255,255,255,.05)" }
        }
      }
    };
  }

  function renderUsageCharts() {
    if (!usageDays) return;
    const dates = usageWindowDates(usageRange);
    const labels = dates.map((d) => d.slice(5).replace("-", "/"));
    const costData = dates.map((d) => Number((((usageDays[d] || {}).cost || 0)).toFixed(4)));
    const hit = dates.map((d) => (usageDays[d] || {}).hit || 0);
    const miss = dates.map((d) => (usageDays[d] || {}).miss || 0);
    const resp = dates.map((d) => (usageDays[d] || {}).resp || 0);
    const maxThickness = usageRange === 7 ? 42 : 16;

    if (usageCostChart) { usageCostChart.destroy(); usageCostChart = null; }
    usageCostChart = new Chart($("#usage-cost-chart"), {
      type: "bar",
      data: {
        labels,
        datasets: [{
          label: "消费",
          data: costData,
          backgroundColor: "rgba(77,107,254,.8)",
          hoverBackgroundColor: "rgba(124,92,255,.95)",
          borderRadius: 4,
          maxBarThickness: maxThickness
        }]
      },
      options: usageChartBaseOptions((v) => fmtCost(v))
    });

    if (usageTokenChart) { usageTokenChart.destroy(); usageTokenChart = null; }
    usageTokenChart = new Chart($("#usage-token-chart"), {
      type: "bar",
      data: {
        labels,
        datasets: [
          { label: "缓存命中", data: hit, backgroundColor: "rgba(96,165,250,.85)", stack: "t", maxBarThickness: maxThickness },
          { label: "缓存未命中", data: miss, backgroundColor: "rgba(167,139,250,.85)", stack: "t", maxBarThickness: maxThickness },
          { label: "输出", data: resp, backgroundColor: "rgba(52,211,153,.85)", stack: "t", maxBarThickness: maxThickness }
        ]
      },
      options: usageChartBaseOptions((v) => fmtTokensFull(v) + " tokens")
    });
  }

  function renderUsageTable() {
    const rows = [];
    for (const d of usageWindowDates(30)) {
      const r = usageDays[d];
      if (r && (r.tokens > 0 || r.cost > 0 || r.requests > 0)) rows.push([d, r]);
    }
    rows.reverse();

    if (!rows.length) {
      usageResultsEl.innerHTML = '<div class="empty-state"><div>最近 30 天暂无用量记录</div></div>';
      return;
    }

    usageResultsEl.innerHTML =
      '<div class="usage-table-wrap"><table class="usage-table">' +
      "<thead><tr><th>日期</th><th>请求数</th><th>Token 用量</th><th>消费 (¥)</th></tr></thead><tbody>" +
      rows.map(([date, r]) =>
        "<tr><td>" + date + "</td><td>" + r.requests.toLocaleString("zh-CN") + "</td><td>" +
        fmtTokensFull(r.tokens) + "</td><td>" + fmtCost(r.cost) + "</td></tr>"
      ).join("") +
      "</tbody></table></div>";
  }

  async function copyTextToClipboard(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      try { await navigator.clipboard.writeText(text); return true; } catch (_) {}
    }
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      return ok;
    } catch (_) {
      return false;
    }
  }

  /* ===== 万能方案：控制台获取数据 → 剪贴板导入（无需本地服务器） ===== */
  const USAGE_FETCH_CMD = `(async function () {
  function copyText(t) {
    if (typeof copy === 'function') { copy(t); } else { console.log(t); }
  }
  function done(data) {
    copyText(JSON.stringify(data));
    console.log('%c✅ 数据已复制!回到余额查询页面,点击「从剪贴板导入并显示」', 'color:#4ade80;font-size:14px');
  }
  function fail(msg) { console.error('❌ 获取失败: ' + msg); alert('获取用量数据失败: ' + msg); }
  try {
    var tk = null;
    try { tk = JSON.parse(localStorage.getItem('userToken') || 'null'); } catch (e) {}
    var token = tk && tk.value;
    if (!token) { return fail('未找到登录 Token,请先登录 platform.deepseek.com'); }
    var h = { 'Authorization': 'Bearer ' + token, 'Accept': 'application/json', 'x-app-version': '1.0.0', 'x-client-platform': 'web' };
    var now = new Date();
    var start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 29, 0, 0, 0);
    var end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0);
    var qs = 'start=' + Math.floor(start.getTime() / 1000) + '&end=' + Math.floor(end.getTime() / 1000) + '&tz=' + (-now.getTimezoneOffset() * 60);
    function isAuth(j) {
      return j && (j.code === 40002 || j.code === 40003 || (j.data && (j.data.biz_code === 40002 || j.data.biz_code === 40003)));
    }
    async function get(url) {
      var r = await fetch(url, { headers: h });
      var j = null;
      try { j = await r.json(); } catch (e) {}
      if (!r.ok || !j) { throw new Error('HTTP ' + r.status); }
      if (isAuth(j)) { var e1 = new Error('登录已过期,请重新登录 platform.deepseek.com 后再试'); e1.auth = true; throw e1; }
      if (j.code && j.code !== 0) { throw new Error(j.msg || ('code ' + j.code)); }
      if (j.data && j.data.biz_code && j.data.biz_code !== 0) { throw new Error(j.data.biz_msg || ('biz_code ' + j.data.biz_code)); }
      return j;
    }
    var amount = null;
    var cost = null;
    try {
      amount = await get('/api/v0/usage/by_api_key/amount?' + qs);
      cost = await get('/api/v0/usage/by_api_key/cost?' + qs);
    } catch (e) {
      if (e && e.auth) { return fail(e.message); }
      console.warn('按日接口不可用(' + e.message + '),改用按月接口…');
      amount = null;
      cost = null;
    }
    if (amount && cost) { return done({ v: 1, mode: 'range', amount: amount, cost: cost }); }
    var pairs = [];
    for (var back = 1; back >= 0; back--) {
      var d = new Date(now.getFullYear(), now.getMonth() - back, 1);
      var q = 'month=' + (d.getMonth() + 1) + '&year=' + d.getFullYear();
      pairs.push({ amount: await get('/api/v0/usage/amount?' + q), cost: await get('/api/v0/usage/cost?' + q) });
    }
    done({ v: 1, mode: 'month', pairs: pairs });
  } catch (e) {
    fail((e && e.message) ? e.message : String(e));
  }
})();`;

  function parseImportedUsage(text) {
    let obj;
    try { obj = JSON.parse(String(text).trim()); } catch (_) {
      throw new Error("剪贴板/输入框里的内容不是有效的 JSON 数据");
    }
    if (!obj || obj.v !== 1) throw new Error("数据版本不匹配,请重新执行「获取数据命令」");
    if (isUsageAuthError({ status: 200, body: obj.amount || {} }) || isUsageAuthError({ status: 200, body: obj.cost || {} })) {
      throw new Error("平台登录已过期,请重新登录 platform.deepseek.com 后再执行「获取数据命令」");
    }
    if (obj.mode === "range" && obj.amount && obj.cost) {
      return { data: parseUsagePayloads(obj.amount, obj.cost), source: "range" };
    }
    if (obj.mode === "month" && Array.isArray(obj.pairs)) {
      const list = obj.pairs.map((p) => parseUsagePayloads(p.amount, p.cost));
      return { data: mergeUsageResults(list), source: "month" };
    }
    throw new Error("数据内容不完整,请重新执行「获取数据命令」");
  }

  async function importUsageFromClipboard() {
    let text = "";
    if (navigator.clipboard && navigator.clipboard.readText) {
      try { text = await navigator.clipboard.readText(); } catch (_) {}
    }
    const ta = $("#usage-import-text");
    if (!text || text.trim().charAt(0) !== "{") text = ta ? ta.value.trim() : "";
    if (!text) {
      showAlert("warn", "剪贴板里没有数据。请先到 platform.deepseek.com 控制台执行「获取数据命令」,或把数据粘贴到下方的输入框。");
      return;
    }
    try {
      const result = parseImportedUsage(text);
      hideAlert();
      renderUsage(result.data, result.source);
      $("#usage-updated").textContent += " · 控制台导入";
      if (ta) ta.value = "";
    } catch (err) {
      showAlert("err", "导入失败：" + (err.message || "未知错误") + "。请确认已执行最新版「获取数据命令」。");
    }
  }

  function initUsageUI() {
    const labelEl = $("#usage-proxy-label");
    if (labelEl) labelEl.textContent = USAGE_PROXY_URL;

    try {
      const saved = localStorage.getItem(LS_USAGE_TOKEN);
      if (saved && localStorage.getItem(LS_USAGE_REMEMBER) === "1") {
        usageTokenInput.value = saved;
        usageTokenRemember.checked = true;
        setUsageTokenStatus("已保存", "ok");
      }
    } catch (_) {}

    usageTokenEye.innerHTML = EYE_OPEN;
    usageTokenEye.addEventListener("click", () => {
      const show = usageTokenInput.type === "password";
      usageTokenInput.type = show ? "text" : "password";
      usageTokenEye.innerHTML = show ? EYE_CLOSED : EYE_OPEN;
      usageTokenInput.focus();
    });

    usageTokenRemember.addEventListener("change", () => {
      if (!usageTokenRemember.checked) {
        try {
          localStorage.removeItem(LS_USAGE_TOKEN);
          localStorage.removeItem(LS_USAGE_REMEMBER);
        } catch (_) {}
        setUsageTokenStatus("未保存");
      }
    });

    usageQueryBtn.addEventListener("click", queryUsage);
    usageTokenInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") queryUsage();
    });

    document.querySelectorAll(".usage-range-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        document.querySelectorAll(".usage-range-btn").forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        usageRange = parseInt(btn.dataset.range, 10) || 7;
        renderUsageCharts();
      });
    });

    const copyBtn = $("#usage-copy-cmd");
    copyBtn.addEventListener("click", async () => {
      const old = copyBtn.textContent;
      const ok = await copyTextToClipboard(USAGE_CMD);
      copyBtn.textContent = ok ? "已复制 ✓ 请到平台控制台粘贴运行" : "复制失败,请手动输入命令";
      setTimeout(() => { copyBtn.textContent = old; }, 2200);
    });

    const copyFetchBtn = $("#usage-copy-fetch-cmd");
    copyFetchBtn.addEventListener("click", async () => {
      const old = copyFetchBtn.textContent;
      const ok = await copyTextToClipboard(USAGE_FETCH_CMD);
      copyFetchBtn.textContent = ok ? "已复制 ✓ 请到平台控制台粘贴运行" : "复制失败,请手动选择复制";
      setTimeout(() => { copyFetchBtn.textContent = old; }, 2500);
    });

    $("#usage-import-btn").addEventListener("click", importUsageFromClipboard);
  }

  /* ========== 标签页切换 ========== */
  function initTabs() {
    const tabs = document.querySelectorAll('.tab');
    const tabContents = document.querySelectorAll('.tab-content');

    tabs.forEach(tab => {
      tab.addEventListener('click', () => {
        const targetTab = tab.dataset.tab;

        tabs.forEach(t => t.classList.remove('active'));
        tab.classList.add('active');

        tabContents.forEach(content => {
          content.classList.remove('active');
          content.style.display = 'none';
        });

        let targetContent = null;
        if (targetTab === 'balance') {
          targetContent = $("#result");
        } else if (targetTab === 'history') {
          targetContent = $("#history-section");
          updateHistoryView();
        } else if (targetTab === 'stats') {
          targetContent = $("#stats-section");
          updateStatsView();
        } else if (targetTab === 'usage') {
          targetContent = $("#usage-section");
          if (usageDays) renderUsageCharts(); // 切回标签时补渲染,确保图表尺寸正确
        }

        if (targetContent) {
          targetContent.classList.add('active');
          targetContent.style.display = 'block';
        }
      });
    });

    // 时间范围选择器
    const rangeBtns = document.querySelectorAll('.range-btn');
    rangeBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        rangeBtns.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        updateHistoryView();
      });
    });
  }

  /* ========== 账户管理UI ========== */
  function initAccountUI() {
    // 账户选择器变化
    accountSelector.addEventListener('change', () => {
      const selectedId = accountSelector.value;
      if (selectedId) {
        setCurrentAccountId(selectedId);
        currentAccountId = selectedId;
        const account = getAccountById(selectedId);
        if (account) {
          keyInput.value = account.apiKey;
          rememberChk.checked = false;
        }
      } else {
        currentAccountId = null;
        keyInput.value = '';
        rememberChk.checked = false;
      }
    });

    // 添加账户按钮
    addAccountBtn.addEventListener('click', () => {
      accountModal.classList.add('show');
      $("#add-account-form").style.display = 'block';
      $("#show-add-form").style.display = 'none';
    });

    // 管理账户按钮
    manageAccountsBtn.addEventListener('click', () => {
      renderAccountList();
      accountModal.classList.add('show');
      $("#add-account-form").style.display = 'none';
      $("#show-add-form").style.display = 'block';
    });

    // 关闭模态框
    modalClose.addEventListener('click', () => {
      accountModal.classList.remove('show');
    });

    accountModal.addEventListener('click', (e) => {
      if (e.target === accountModal) {
        accountModal.classList.remove('show');
      }
    });

    // 显示添加表单
    $("#show-add-form").addEventListener('click', () => {
      $("#add-account-form").style.display = 'block';
      $("#show-add-form").style.display = 'none';
    });

    // 取消添加
    $("#cancel-add-account").addEventListener('click', () => {
      $("#add-account-form").style.display = 'none';
      $("#show-add-form").style.display = 'block';
      $("#new-account-name").value = '';
      $("#new-account-key").value = '';
    });

    // 保存新账户
    $("#save-new-account").addEventListener('click', () => {
      const name = $("#new-account-name").value.trim();
      const key = $("#new-account-key").value.trim();

      if (!name) {
        alert('请输入账户名称');
        return;
      }

      if (!key || !key.startsWith('sk-')) {
        alert('请输入有效的API Key（以sk-开头）');
        return;
      }

      const newAccount = addAccount(name, key);
      renderAccountSelector();
      renderAccountList();

      $("#new-account-name").value = '';
      $("#new-account-key").value = '';
      $("#add-account-form").style.display = 'none';
      $("#show-add-form").style.display = 'block';

      showAlert('info', '账户添加成功');
      setTimeout(hideAlert, 2000);
    });

  }

  /* ========== 初始化 ========== */
  function init() {
    migrateOldData();
    renderAccountSelector();
    initTabs();
    initAccountUI();
    initUsageUI();

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

    // 页面空闲时预取汇率
    window.setTimeout(() => { getUsdCnyRate(); }, 500);

    // 恢复旧版保存的Key
    (function restore() {
      try {
        const saved = localStorage.getItem(LS_KEY);
        if (saved && localStorage.getItem(LS_REMEMBER) === "1") {
          keyInput.value = saved;
          rememberChk.checked = true;
          query();
        }
      } catch (_) {}
    })();

    // 如果有当前账户，自动查询
    const currentId = getCurrentAccountId();
    if (currentId) {
      const account = getAccountById(currentId);
      if (account) {
        currentAccountId = currentId;
        accountSelector.value = currentId;
        keyInput.value = account.apiKey;
        query();
      }
    }
  }

  // 启动应用
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
