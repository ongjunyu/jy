/* ===========================================================
   AI 存钱小帮手  ·  app.js
   纯前端 / 离线可用 / localStorage 持久化 / 内置智能逻辑
   =========================================================== */

(function () {
  'use strict';

  /* ---------- 基础工具 ---------- */
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const STORE_KEY = 'ai-savings-helper-v1';

  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const clampNum = (n) => (isFinite(n) ? n : 0);

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function money(n) {
    n = Math.round(clampNum(Number(n)) * 100) / 100;
    const neg = n < 0;
    const abs = Math.abs(n);
    const fixed = Number.isInteger(abs) ? abs.toString() : abs.toFixed(2);
    const parts = fixed.split('.');
    parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    const cur = state.settings.currency || '';
    // 字母型货币符号（如 RM/USD）与数字之间加不换行空格，更易读
    const gap = /[A-Za-z]$/.test(cur) ? ' ' : '';
    // 返回值会被拼进 innerHTML，货币符号来自用户输入，需转义防 XSS
    return (neg ? '-' : '') + esc(cur) + gap + parts.join('.');
  }

  function todayStr(d = new Date()) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }
  function parseDate(s) { const [y, m, d] = String(s).split('-').map(Number); return new Date(y, (m || 1) - 1, d || 1); }
  function daysBetween(a, b) { return Math.round((parseDate(b) - parseDate(a)) / 86400000); }
  function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
  function fmtDate(s) {
    const d = parseDate(s); const t = todayStr();
    if (s === t) return '今天';
    if (s === todayStr(addDays(new Date(), -1))) return '昨天';
    return `${d.getMonth() + 1}月${d.getDate()}日`;
  }

  /* ---------- 状态 ---------- */
  // 初始用默认值，真正的数据在 init() 里加载（确保此时 CHALLENGE_TEMPLATES 等已定义）
  let state = defaultState();
  let account = null;          // 已登录账号 {token, phone}（null 表示游客/本地模式）
  let pushTimer = null;        // 云同步防抖计时器
  let chatHistory = [];        // 与小帮手的对话历史（发给真 AI 用）
  let chatBusy = false;        // 真 AI 请求进行中，串行化避免消息错位
  const HAS_API = location.protocol === 'http:' || location.protocol === 'https:'; // file:// 打开时无后端

  function defaultState() {
    return {
      user: { name: '' },
      goals: [],
      records: [],
      challenges: [],
      settings: { currency: 'RM', activeGoalId: null, theme: 'auto', reminder: false },
      meta: { onboarded: false, lastReminder: '', updatedAt: 0 },
    };
  }

  function loadState() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (!raw) return defaultState();
      return sanitizeState(JSON.parse(raw));
    } catch (e) {
      console.warn('读取数据失败，重置', e);
      return defaultState();
    }
  }

  // 清洗/校验任意来源的数据（含用户导入的备份）。
  // 杜绝脏数据/恶意数据导致的崩溃与注入：白名单字段、限制长度、校验类型、丢弃非法项。
  function cleanStr(v, max) { return typeof v === 'string' ? v.slice(0, max) : ''; }
  function isDateStr(s) { return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s); }
  function safeId(id) { return (typeof id === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(id)) ? id : null; }

  function sanitizeState(raw) {
    const out = defaultState();
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;

    if (raw.user && typeof raw.user === 'object') out.user.name = cleanStr(raw.user.name, 12);
    if (raw.settings && typeof raw.settings === 'object') {
      const cur = cleanStr(raw.settings.currency, 3).replace(/[<>&"'`]/g, '');
      out.settings.currency = cur || 'RM';
      if (['auto', 'light', 'dark'].indexOf(raw.settings.theme) >= 0) out.settings.theme = raw.settings.theme;
      out.settings.reminder = !!raw.settings.reminder;
    }
    if (raw.meta && typeof raw.meta === 'object') {
      out.meta.onboarded = !!raw.meta.onboarded;
      if (isDateStr(raw.meta.lastReminder)) out.meta.lastReminder = raw.meta.lastReminder;
      const ua = Number(raw.meta.updatedAt);
      if (isFinite(ua) && ua > 0) out.meta.updatedAt = ua;
    }

    const goalIds = new Set();
    if (Array.isArray(raw.goals)) raw.goals.forEach(g => {
      if (!g || typeof g !== 'object') return;
      const id = safeId(g.id); if (!id || goalIds.has(id)) return;
      const target = Number(g.target); if (!isFinite(target) || target <= 0) return;
      goalIds.add(id);
      const plan = Number(g.monthlyPlan);
      out.goals.push({
        id, name: cleanStr(g.name, 30) || '未命名目标', emoji: cleanStr(g.emoji, 4) || '🎯',
        target, deadline: isDateStr(g.deadline) ? g.deadline : '', createdAt: Number(g.createdAt) || Date.now(),
        monthlyPlan: (isFinite(plan) && plan > 0) ? plan : 0, archived: !!g.archived,
      });
    });

    const chIds = new Set();
    if (Array.isArray(raw.challenges)) raw.challenges.forEach(c => {
      if (!c || typeof c !== 'object') return;
      const id = safeId(c.id); if (!id || chIds.has(id)) return;
      const tpl = CHALLENGE_TEMPLATES[c.type]; if (!tpl) return; // 丢弃未知类型挑战
      const base = Number(c.base); if (!isFinite(base) || base <= 0) return;
      const checks = {};
      if (c.checks && typeof c.checks === 'object') Object.keys(c.checks).forEach(k => { if (c.checks[k]) checks[String(k).slice(0, 20)] = true; });
      chIds.add(id);
      const obj = { id, type: c.type, name: cleanStr(c.name, 30) || tpl.name, base, checks, createdAt: Number(c.createdAt) || Date.now() };
      if (c.type === 'daily') { const d = parseInt(c.targetDays, 10); obj.targetDays = (isFinite(d) && d > 0) ? d : tpl.defaultDays; }
      const gid = safeId(c.goalId); if (gid && goalIds.has(gid)) obj.goalId = gid;
      out.challenges.push(obj);
    });

    if (Array.isArray(raw.records)) raw.records.forEach(r => {
      if (!r || typeof r !== 'object') return;
      const id = safeId(r.id); if (!id) return;
      const gid = safeId(r.goalId); if (!gid || !goalIds.has(gid)) return; // 记录必须属于一个有效目标
      const amount = Number(r.amount); if (!isFinite(amount) || amount <= 0) return;
      const rec = {
        id, goalId: gid, type: r.type === 'out' ? 'out' : 'in', amount,
        date: isDateStr(r.date) ? r.date : todayStr(), note: cleanStr(r.note, 40), createdAt: Number(r.createdAt) || Date.now(),
      };
      const cid = safeId(r.challengeId);
      if (cid && chIds.has(cid)) { rec.challengeId = cid; if (typeof r.stepKey === 'string') rec.stepKey = r.stepKey.slice(0, 20); }
      out.records.push(rec);
    });

    const wantActive = (raw.settings && safeId(raw.settings.activeGoalId)) || null;
    out.settings.activeGoalId = (wantActive && goalIds.has(wantActive)) ? wantActive : (out.goals[0] ? out.goals[0].id : null);
    return out;
  }

  function save() {
    state.meta.updatedAt = Date.now();
    try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); }
    catch (e) { toast('保存失败，存储空间可能已满'); }
    if (account) schedulePush(); // 已登录则同步到云端
  }

  // 应用主题（auto/light/dark）并同步状态栏颜色
  function applyTheme() {
    const t = state.settings.theme || 'auto';
    document.documentElement.dataset.theme = t;
    const dark = t === 'dark' ||
      (t === 'auto' && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', dark ? '#0f1418' : '#16a085');
  }

  // 每日存钱提醒：当天未存且开启提醒时，发浏览器通知（每天最多一次）
  function maybeRemind() {
    const today = todayStr();
    const hasActive = state.goals.some(g => !g.archived);
    const savedToday = state.records.some(r => r.type === 'in' && r.date === today);
    if (!hasActive || savedToday) return;
    if (state.settings.reminder && 'Notification' in window &&
        Notification.permission === 'granted' && state.meta.lastReminder !== today) {
      try {
        new Notification('存钱小帮手 🐷', { body: '今天还没存钱哦，来存一笔，离目标更近一步！', icon: 'icon.svg' });
        state.meta.lastReminder = today; save();
      } catch (_) {}
    }
  }

  /* ===========================================================
     账号 / 云端同步（手机号 + 密码登录）
     =========================================================== */
  const AUTH_KEY = 'ash-auth-v1';
  function loadAuth() { try { return JSON.parse(localStorage.getItem(AUTH_KEY) || 'null'); } catch (_) { return null; } }
  function saveAuth(a) { try { a ? localStorage.setItem(AUTH_KEY, JSON.stringify(a)) : localStorage.removeItem(AUTH_KEY); } catch (_) {} }

  async function api(path, opts) {
    opts = opts || {};
    const headers = { 'Content-Type': 'application/json' };
    if (account && account.token) headers['Authorization'] = 'Bearer ' + account.token;
    const res = await fetch('/api' + path, {
      method: opts.method || 'GET', headers,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    let data = {};
    try { data = await res.json(); } catch (_) {}
    if (!res.ok) { const err = new Error(data.error || ('请求失败 ' + res.status)); err.status = res.status; throw err; }
    return data;
  }

  function schedulePush() {
    if (!account) return;
    clearTimeout(pushTimer);
    pushTimer = setTimeout(pushNow, 800); // 防抖：连续操作只推一次
  }
  function stateHasData(s) {
    return !!(s && ((s.goals && s.goals.length) || (s.records && s.records.length) || (s.challenges && s.challenges.length)));
  }
  async function pushNow() {
    if (!account) return;
    try {
      const res = await api('/data', { method: 'PUT', body: { state, updatedAt: state.meta.updatedAt || 0 } });
      // 用服务端返回的时间戳对齐本地，避免下次启动误判“云端更新”而反复拉取
      if (res && res.updatedAt && res.updatedAt !== state.meta.updatedAt) {
        state.meta.updatedAt = res.updatedAt;
        try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch (_) {} // 直接写，勿走 save() 以免回推
      }
    } catch (e) { if (e.status === 401) doLogout(true); }
  }
  // 登录/启动时与云端合并：有数据的一方优先，杜绝“空数据覆盖真实数据”；两边都有则后写覆盖
  async function syncPull() {
    if (!account) return;
    try {
      const data = await api('/data');
      const serverState = data && data.state;
      const serverAt = (data && data.updatedAt) || 0;
      const localAt = state.meta.updatedAt || 0;
      const localHas = stateHasData(state);
      const serverHas = stateHasData(serverState);
      const adopt = () => {
        state = sanitizeState(serverState);
        state.meta.updatedAt = serverAt;
        try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch (_) {} // 直接写，勿走 save()
        lastAssistant = AI.daily(); applyTheme(); renderAll();
      };
      if (serverHas && !localHas) adopt();              // 新设备/重装：恢复云端数据
      else if (localHas && !serverHas) await pushNow();  // 云端为空：上传本地
      else if (serverHas && localHas) {                  // 两边都有数据：按时间后写覆盖
        if (serverAt > localAt) adopt();
        else if (localAt > serverAt) await pushNow();
      }
      // 两边都空：什么都不做（避免空覆盖空、反复写）
    } catch (e) {
      if (e.status === 401) doLogout(true);
    }
  }

  async function doRegisterOrLogin(mode, phone, password) {
    const data = await api('/auth/' + mode, { method: 'POST', body: { phone, password } });
    account = { token: data.token, phone: data.phone };
    saveAuth(account);
    await syncPull();
  }
  function doLogout(silent) {
    account = null; saveAuth(null); clearTimeout(pushTimer);
    if (!silent) toast('已退出登录（本地数据保留）');
    renderAll();
  }

  function openAuthForm() {
    if (!HAS_API) {
      return openSheet('账号', `<div class="empty"><div class="ico">🌐</div><p>账号与云同步需要通过<br>部署后的网址访问，<br>本地直接打开文件时不可用。</p></div>`);
    }
    const html = `
      <p class="section-sub">用手机号 + 密码登录，数据会安全同步到云端，换手机或重装也不会丢失。</p>
      <div class="field"><label>手机号</label>
        <input id="auPhone" type="tel" inputmode="tel" autocomplete="username" placeholder="例如 0123456789"/></div>
      <div class="field"><label>密码（至少 6 位）</label>
        <input id="auPass" type="password" autocomplete="current-password" placeholder="输入密码"/></div>
      <div class="row">
        <button class="btn btn-primary" id="auLogin">登录</button>
        <button class="btn btn-ghost" id="auRegister">注册新账号</button>
      </div>
      <p class="center mt8" id="auMsg" style="font-size:12.5px; color:var(--bad)"></p>
    `;
    openSheet('登录 / 注册', html, (root) => {
      const msg = $('#auMsg', root);
      const run = async (mode) => {
        const phone = $('#auPhone', root).value.trim();
        const pass = $('#auPass', root).value;
        if (!phone) { msg.textContent = '请输入手机号'; return; }
        if (pass.length < 6) { msg.textContent = '密码至少 6 位'; return; }
        msg.style.color = 'var(--muted)';
        msg.textContent = mode === 'login' ? '登录中…' : '注册中…';
        try {
          await doRegisterOrLogin(mode, phone, pass);
          closeSheet();
          toast(mode === 'login' ? '登录成功，已云端同步 ☁️' : '注册成功，已登录 🎉');
        } catch (e) {
          msg.style.color = 'var(--bad)';
          msg.textContent = e.message || '操作失败，请重试';
        }
      };
      $('#auLogin', root).addEventListener('click', () => run('login'));
      $('#auRegister', root).addEventListener('click', () => run('register'));
    });
  }

  /* ---------- 计算 ---------- */
  function goalSaved(goalId) {
    return state.records
      .filter(r => r.goalId === goalId)
      .reduce((s, r) => s + (r.type === 'in' ? r.amount : -r.amount), 0);
  }
  function getGoal(id) { return state.goals.find(g => g.id === id) || null; }
  function activeGoal() {
    let g = getGoal(state.settings.activeGoalId);
    if (g && g.archived) g = null;
    if (!g) { g = state.goals.find(x => !x.archived) || null; if (g) state.settings.activeGoalId = g.id; }
    return g;
  }

  function totalSaved() {
    return state.records.reduce((s, r) => s + (r.type === 'in' ? r.amount : -r.amount), 0);
  }
  function sumInRange(fromStr, toStr, type) {
    return state.records.filter(r => r.date >= fromStr && r.date <= toStr && (!type || r.type === type))
      .reduce((s, r) => s + (r.type === 'in' ? r.amount : -r.amount), 0);
  }
  function monthRange(d = new Date()) {
    const from = todayStr(new Date(d.getFullYear(), d.getMonth(), 1));
    const to = todayStr(new Date(d.getFullYear(), d.getMonth() + 1, 0));
    return [from, to];
  }
  function weekRange(d = new Date()) {
    const day = (d.getDay() + 6) % 7; // 周一为一周起点
    const from = todayStr(addDays(d, -day));
    const to = todayStr(addDays(d, 6 - day));
    return [from, to];
  }
  // 连续存钱天数（含/截至今天）
  function depositStreak() {
    const dates = new Set(state.records.filter(r => r.type === 'in').map(r => r.date));
    if (!dates.size) return 0;
    let streak = 0;
    let cur = new Date();
    // 若今天没存，从昨天开始算
    if (!dates.has(todayStr(cur))) cur = addDays(cur, -1);
    while (dates.has(todayStr(cur))) { streak++; cur = addDays(cur, -1); }
    return streak;
  }
  function lastDepositDaysAgo() {
    const ins = state.records.filter(r => r.type === 'in').map(r => r.date).sort();
    if (!ins.length) return null;
    return daysBetween(ins[ins.length - 1], todayStr());
  }
  // 基于近30天日均，预测目标达成日期
  function projectGoalDate(goal) {
    const saved = goalSaved(goal.id);
    const remain = goal.target - saved;
    if (remain <= 0) return { done: true };
    const from = todayStr(addDays(new Date(), -29));
    // 仅统计该目标近 30 天的存入，预测更贴合此目标
    const recent = state.records.filter(r => r.goalId === goal.id && r.type === 'in' && r.date >= from)
      .reduce((s, r) => s + r.amount, 0);
    let avg = recent / 30;
    // 有月度计划时，按计划与实际中更快的节奏估算
    if (goal.monthlyPlan > 0) avg = Math.max(avg, goal.monthlyPlan / 30);
    if (avg <= 0) return { done: false, avg: 0 };
    const days = Math.ceil(remain / avg);
    return { done: false, avg, days, date: todayStr(addDays(new Date(), days)) };
  }

  // 历史最长连续存钱天数
  function bestStreak() {
    const dates = Array.from(new Set(state.records.filter(r => r.type === 'in').map(r => r.date))).sort();
    if (!dates.length) return 0;
    let best = 1, cur = 1;
    for (let i = 1; i < dates.length; i++) {
      if (daysBetween(dates[i - 1], dates[i]) === 1) cur++; else cur = 1;
      if (cur > best) best = cur;
    }
    return best;
  }
  // 紧凑金额（图表标签用，纯数字无 HTML）
  function shortMoney(n) {
    const abs = Math.abs(n);
    if (abs >= 1000) {
      const k = abs / 1000;
      return (n < 0 ? '-' : '') + (abs >= 10000 ? Math.round(k) : k.toFixed(1).replace(/\.0$/, '')) + 'k';
    }
    return Math.round(n).toString();
  }
  // 近 6 个月净存入柱状图
  function buildBarsHTML() {
    const now = new Date();
    const months = [];
    for (let i = 5; i >= 0; i--) months.push(new Date(now.getFullYear(), now.getMonth() - i, 1));
    const vals = months.map(m => { const [f, t] = monthRange(m); return sumInRange(f, t); });
    const max = Math.max(1, ...vals.map(v => Math.abs(v)));
    const hasAny = state.records.length > 0;
    if (!hasAny) return '<div class="empty" style="padding:20px"><p class="muted">还没有数据，存一笔就有啦 📊</p></div>';
    const cols = months.map((m, i) => {
      const v = vals[i];
      const h = Math.round(Math.abs(v) / max * 100);
      const isCur = i === months.length - 1;
      return `<div class="bar-col"><div class="bar-v">${v ? shortMoney(v) : ''}</div>` +
        `<div class="bar-fill ${v < 0 ? 'neg' : ''} ${isCur ? 'on' : ''}" style="height:${h}%"></div>` +
        `<div class="bar-x">${m.getMonth() + 1}月</div></div>`;
    }).join('');
    return `<div class="bars">${cols}</div>`;
  }
  // 数据洞察列表
  function buildInsightsHTML() {
    const [mf, mt] = monthRange();
    const now = new Date();
    // 用 1 号构造上月，避免月末 setMonth 溢出（如 3/31 减一个月会跳到 3/3）
    const lastM = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const [lf, lt] = monthRange(lastM);
    const thisMonth = sumInRange(mf, mt, 'in');
    const lastMonth = sumInRange(lf, lt, 'in');
    let delta = '';
    if (lastMonth > 0) {
      const pct = Math.round((thisMonth - lastMonth) / lastMonth * 100);
      delta = pct >= 0 ? ` <span class="delta-up">▲${pct}%</span>` : ` <span class="delta-down">▼${Math.abs(pct)}%</span>`;
    } else if (thisMonth > 0) delta = ' <span class="delta-up">▲新增</span>';
    const avg30 = sumInRange(todayStr(addDays(new Date(), -29)), todayStr(), 'in') / 30;
    const completed = state.goals.filter(g => goalSaved(g.id) >= g.target).length;
    const insCount = state.records.filter(r => r.type === 'in').length;
    const rows = [
      ['📆 本月存入', money(thisMonth) + delta],
      ['📉 上月存入', money(lastMonth)],
      ['📈 近 30 天日均', money(avg30)],
      ['🔥 当前连续', depositStreak() + ' 天'],
      ['🏅 最长连续', bestStreak() + ' 天'],
      ['✅ 已达成目标', completed + ' 个'],
      ['🧾 存入笔数', insCount + ' 笔'],
    ];
    return rows.map(r => `<div class="insight-row"><span class="k">${r[0]}</span><span class="v">${r[1]}</span></div>`).join('');
  }

  /* ===========================================================
     AI 小帮手（内置智能逻辑）
     =========================================================== */
  const AI = (() => {
    const TIPS = [
      '把零钱罐换成「自动转账」：发工资当天就先存，剩下的才花。',
      '记账时给每笔支出问一句「这是想要还是需要」，能砍掉不少冲动消费。',
      '试试「24 小时法则」：想买非必需品先等一天，多数冲动会自己消失。',
      '把想买的东西换算成「要存几天钱」，往往就没那么想买了。',
      '取消那些一个月用不到一次的订阅会员，一年能省出一笔。',
      '自带水杯和午饭，每天省 20 元，一年就是 7000+。',
      '设置一个「不花钱日」，每周挑一天完全不消费。',
      '大额消费用「单价 ÷ 使用次数」评估，常用的贵一点也值，闲置的便宜也是浪费。',
      '把找零和红包零头全部转进存钱目标，积少成多。',
      '购物车放 3 天再结算，会发现一半都不想买了。',
      '关注「省下来」而不是「赚更多」：省下的每一块都是净利润。',
      '把存钱目标设成手机壁纸，每次解锁都提醒自己。',
      '用现金消费一周，花钱的「痛感」会让你更克制。',
      '先存后花：把储蓄当成一笔必须交的「给未来的账单」。',
      '比价 3 家再下单，大件商品差价可能够你存好几天。',
      '警惕「凑满减」：为省 10 元多花 50 元并不划算。',
      '把外卖改成自己做，省钱又健康。',
      '设置消费提醒，每笔超过预算就让 App 提醒你。',
      '把年费、保险等大额支出按月摊进预算，避免某个月被「掏空」。',
      '断舍离一次，把闲置二手卖掉，回笼的钱直接存进目标。',
    ];
    const CHEERS = [
      '每一笔小小的存入，都是未来的你在说谢谢。🌱',
      '存钱不是省下现在，而是买下自由的未来。加油！',
      '你正在做一件了不起的事——对自己的人生负责。',
      '慢慢来，比停下来强。坚持就是胜利！💪',
      '今天的克制，是明天的底气。你超棒的！',
      '罗马不是一天建成的，你的小金库也是。继续！',
      '别小看复利的力量，时间会奖励坚持的人。',
      '存下的不只是钱，是选择的权利和安全感。',
      '你已经比昨天更接近梦想一点点了，真好。✨',
      '财富自由的路上，最难的是开始，而你已经在路上了。',
    ];

    function pickSeeded(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

    function greeting() {
      const h = new Date().getHours();
      const name = state.user.name ? state.user.name : '朋友';
      if (h < 6) return `夜深了，${name}`;
      if (h < 11) return `早上好，${name} ☀️`;
      if (h < 14) return `中午好，${name} 🍱`;
      if (h < 18) return `下午好，${name} ☕`;
      return `晚上好，${name} 🌙`;
    }

    // 首页每日洞察
    function daily() {
      const g = activeGoal();
      const streak = depositStreak();
      const lines = [];
      let chips = [];

      if (!g) {
        return {
          bubble: '欢迎来到存钱小帮手！🐷\n我会陪你一起攒下梦想。先创建一个存钱目标吧，比如「旅行基金」或「应急储备金」。',
          chips: [{ label: '🎯 创建第一个目标', action: 'add-goal' }],
        };
      }

      const saved = goalSaved(g.id);
      const pct = Math.min(100, Math.round((saved / g.target) * 100));
      const remain = Math.max(0, g.target - saved);

      if (saved >= g.target) {
        lines.push(`🎉 太厉害了！「${g.name}」已经达成目标！要不要为自己定个新目标？`);
        chips = [{ label: '🎯 新目标', action: 'add-goal' }, { label: '💰 继续存', action: 'deposit' }];
        return { bubble: lines.join('\n'), chips };
      }

      lines.push(`你的目标「${g.name}」已完成 ${pct}%，还差 ${money(remain)}。`);

      // 进度 vs 截止日
      if (g.deadline) {
        const daysLeft = daysBetween(todayStr(), g.deadline);
        if (daysLeft < 0) {
          lines.push(`⏰ 截止日已过，别灰心，重新设个日期，我们继续冲！`);
        } else if (daysLeft === 0) {
          lines.push(`⏰ 今天就是截止日啦！`);
        } else {
          const perDay = remain / daysLeft;
          lines.push(`距离截止还有 ${daysLeft} 天，平均每天存 ${money(perDay)} 就能达成。`);
        }
      } else {
        const p = projectGoalDate(g);
        if (p.avg > 0) lines.push(`按最近的节奏，预计 ${fmtDate(p.date)} 左右达成 👍`);
      }

      // 连续天数 / 提醒
      const last = lastDepositDaysAgo();
      if (streak >= 2) lines.push(`🔥 已连续存钱 ${streak} 天，保持住！`);
      else if (last !== null && last >= 3) lines.push(`已经 ${last} 天没存啦，今天来一笔小的也好～`);

      chips = [
        { label: '💰 存一笔', action: 'deposit' },
        { label: '📈 怎样更快达成', action: 'ask:更快达成' },
        { label: '💡 省钱技巧', action: 'ask:省钱技巧' },
      ];
      return { bubble: lines.join('\n'), chips };
    }

    // 对话：根据关键词回答
    function answer(text) {
      const t = String(text || '').trim();
      const g = activeGoal();
      const has = (...kw) => kw.some(k => t.includes(k));

      if (!t) return '你可以问我：怎么开始存钱、怎样更快达成目标、推荐挑战、最近存得怎么样～';

      // 鼓励
      if (has('鼓励', '加油', '累', '坚持不', '放弃', '难', '丧')) {
        return pickSeeded(CHEERS);
      }
      // 省钱技巧
      if (has('省钱', '省点', '技巧', '方法', '怎么省', '攻略', '建议')) {
        return '💡 省钱小贴士：\n' + pickSeeded(TIPS) + '\n\n需要我再说一条吗？';
      }
      // 开始 / 新手
      if (has('开始', '新手', '入门', '第一步', '怎么存', '如何存')) {
        return [
          '存钱其实只需要三步：',
          '1️⃣ 设一个具体目标（金额 + 期限），越具体越有动力；',
          '2️⃣ 「先存后花」——一发工资先转一笔进目标，剩下的再花；',
          '3️⃣ 坚持记录，每天/每周存一点，让它变成习惯。',
          g ? `\n你已经有目标「${g.name}」啦，点底部的 ＋ 就能存一笔！` : '\n现在就去「目标」页创建第一个目标吧！',
        ].join('\n');
      }
      // 更快 / 加速 / 达成
      if (has('更快', '快点', '加速', '达成', '提前', '多久', '什么时候完成')) {
        if (!g) return '先创建一个目标，我才能帮你算出最佳存钱节奏哦～';
        const remain = Math.max(0, g.target - goalSaved(g.id));
        if (remain <= 0) return `「${g.name}」已经达成啦！🎉 给自己定个更大的目标吧。`;
        let out = `要更快达成「${g.name}」（还差 ${money(remain)}）：\n`;
        if (g.deadline) {
          const dl = Math.max(1, daysBetween(todayStr(), g.deadline));
          out += `· 想按时完成：每天约 ${money(remain / dl)}，每周约 ${money(remain / dl * 7)}。\n`;
        }
        out += `· 想 3 个月内完成：每月约 ${money(remain / 3)}。\n`;
        out += `· 想 1 个月内完成：每周约 ${money(remain / 4)}。\n`;
        out += '小技巧：把这笔钱设成发薪日自动转账，最不容易半途而废。';
        return out;
      }
      // 推荐挑战
      if (has('挑战', '推荐', '游戏', '玩法', '52', '打卡')) {
        const cap = suggestCapacity();
        return [
          '🏆 给你推荐几个有趣的存钱挑战：',
          `· 52 周存钱法：第 N 周存 N×基数，循序渐进，一年攒下一大笔；`,
          `· 每日打卡：每天固定存一点（比如 ${money(cap.daily)}），靠习惯取胜；`,
          `· 12 个月递增：每月递增，压力小、成就感强。`,
          '\n去「挑战」页点「加入挑战」就能开始，完成的存入会自动记到你的目标里～',
        ].join('\n');
      }
      // 进度 / 分析
      if (has('怎么样', '进度', '最近', '分析', '情况', '统计', '多少钱', '存了')) {
        return progressReport();
      }
      // 建议金额
      if (has('多少', '建议金额', '存多少', '该存')) {
        const cap = suggestCapacity();
        return `不确定存多少？可以从「无痛金额」开始：每天 ${money(cap.daily)}、每周 ${money(cap.weekly)}。\n等习惯养成后再慢慢加码。关键是开始并坚持，而不是一次存很多。`;
      }
      // 删除/清空类敏感词引导
      if (has('删除', '清空', '重置')) {
        return '想删除目标或记录，可以在对应卡片右上角的「⋯」里操作；想清空全部数据，去右上角 ⚙️ 设置里。操作前记得先导出备份哦～';
      }

      // 兜底
      return [
        '我没太确定你的意思 😅，不过我可以帮你：',
        '· 制定/优化存钱计划　· 算出每天该存多少',
        '· 推荐存钱挑战　· 分析你的存钱进度　· 给你打打气',
        '换种说法再问我一次？或点下面的快捷问题～',
      ].join('\n');
    }

    // 进度报告
    function progressReport() {
      if (!state.goals.length) return '你还没有目标呢，先去创建一个吧！🎯';
      const total = totalSaved();
      const [mf, mt] = monthRange();
      const monthIn = sumInRange(mf, mt, 'in');
      const streak = depositStreak();
      const lines = [`📊 你的存钱小报告：`, `· 累计已存：${money(total)}`, `· 本月存入：${money(monthIn)}`];
      if (streak >= 1) lines.push(`· 连续存钱：${streak} 天 🔥`);
      const g = activeGoal();
      if (g) {
        const saved = goalSaved(g.id);
        const pct = Math.min(100, Math.round(saved / g.target * 100));
        lines.push(`· 当前目标「${g.name}」：${pct}%（${money(saved)} / ${money(g.target)}）`);
        const p = projectGoalDate(g);
        if (p.done) lines.push('  这个目标已经达成啦，恭喜！🎉');
        else if (p.avg > 0) lines.push(`  按当前节奏预计 ${fmtDate(p.date)} 达成`);
        else lines.push('  最近 30 天还没存入，今天来一笔重启动力吧～');
      }
      return lines.join('\n');
    }

    // 估算用户「无痛」存钱能力（基于历史，给个温和默认值）
    function suggestCapacity() {
      const from = todayStr(addDays(new Date(), -29));
      const recent = sumInRange(from, todayStr(), 'in');
      const avgDaily = recent / 30;
      const daily = Math.max(5, Math.round((avgDaily || 10) / 5) * 5);
      return { daily, weekly: daily * 7, monthly: daily * 30 };
    }

    return { daily, answer, greeting, tip: () => pickSeeded(TIPS), cheer: () => pickSeeded(CHEERS), progressReport };
  })();

  /* ===========================================================
     存钱挑战定义
     =========================================================== */
  const CHALLENGE_TEMPLATES = {
    week52: {
      name: '52 周存钱法', emoji: '📅', mode: 'grid', unit: '周', steps: 52,
      defaultBase: 10,
      desc: '第 N 周存「N × 基数」，循序渐进攒下一大笔。',
      amountAt: (i, base) => base * i,
    },
    month12: {
      name: '12 个月递增', emoji: '🗓️', mode: 'grid', unit: '月', steps: 12,
      defaultBase: 100,
      desc: '每月递增存入，压力小、成就感强。',
      amountAt: (i, base) => base * i,
    },
    daily: {
      name: '每日打卡', emoji: '✅', mode: 'daily',
      defaultBase: 10, defaultDays: 100,
      desc: '每天固定存一点，靠习惯积累，养成存钱肌肉记忆。',
    },
  };

  function challengeTotal(c) {
    const tpl = CHALLENGE_TEMPLATES[c.type];
    if (!tpl) return 0;
    if (tpl.mode === 'grid') {
      let s = 0; for (let i = 1; i <= tpl.steps; i++) s += tpl.amountAt(i, c.base); return s;
    }
    return c.base * (c.targetDays || tpl.defaultDays);
  }
  function challengeSaved(c) {
    const tpl = CHALLENGE_TEMPLATES[c.type];
    if (!tpl) return 0;
    if (tpl.mode === 'grid') {
      let s = 0;
      for (let i = 1; i <= tpl.steps; i++) if (c.checks['s' + i]) s += tpl.amountAt(i, c.base);
      return s;
    }
    return c.base * Object.keys(c.checks || {}).length;
  }
  function challengeDoneCount(c) {
    const tpl = CHALLENGE_TEMPLATES[c.type];
    if (tpl && tpl.mode === 'grid') {
      let n = 0; for (let i = 1; i <= tpl.steps; i++) if (c.checks['s' + i]) n++; return n;
    }
    return Object.keys(c.checks || {}).length;
  }
  function challengeTargetCount(c) {
    const tpl = CHALLENGE_TEMPLATES[c.type];
    return tpl && tpl.mode === 'grid' ? tpl.steps : (c.targetDays || 100);
  }
  function dailyStreak(c) {
    const set = new Set(Object.keys(c.checks || {}));
    if (!set.size) return 0;
    let s = 0, cur = new Date();
    if (!set.has(todayStr(cur))) cur = addDays(cur, -1);
    while (set.has(todayStr(cur))) { s++; cur = addDays(cur, -1); }
    return s;
  }

  // 勾选挑战步骤 -> 同步生成存入记录（若已关联目标）
  function setChallengeStep(c, stepKey, on, meta) {
    if (on) {
      c.checks[stepKey] = true;
      if (c.goalId && getGoal(c.goalId)) {
        state.records.push({
          id: uid(), goalId: c.goalId, type: 'in', amount: meta.amount,
          date: meta.date || todayStr(), note: meta.note, createdAt: Date.now(),
          challengeId: c.id, stepKey,
        });
      }
    } else {
      delete c.checks[stepKey];
      state.records = state.records.filter(r => !(r.challengeId === c.id && r.stepKey === stepKey));
    }
  }

  /* ===========================================================
     渲染
     =========================================================== */
  function renderAll() {
    renderHome();
    renderGoals();
    renderRecords();
    renderChallenges();
  }

  /* ----- 首页 ----- */
  let lastAssistant = null;
  function renderHome() {
    $('#heroGreeting').textContent = AI.greeting();
    const g = activeGoal();
    $('#heroSub').textContent = g
      ? `「${g.name}」加油，离梦想又近一步！`
      : '今天也要为梦想存一笔哦～';

    if (!lastAssistant) lastAssistant = AI.daily();
    renderAssistantCard(lastAssistant);

    // 每日提醒横幅（当天未存且有进行中目标时）
    const rem = $('#homeReminder');
    const hasActive = state.goals.some(x => !x.archived);
    const savedToday = state.records.some(r => r.type === 'in' && r.date === todayStr());
    rem.innerHTML = (hasActive && !savedToday)
      ? `<div class="reminder"><span class="r-ico">⏰</span><span class="r-text">今天还没存钱，来一笔离目标更近一步！</span><button class="r-btn" data-action="deposit">去存钱</button></div>`
      : '';

    // 目标卡
    const wrap = $('#homeGoalWrap');
    if (g) wrap.innerHTML = goalCardHTML(g, true);
    else wrap.innerHTML = `<div class="card empty"><div class="ico">🎯</div><p>还没有存钱目标</p><button class="btn btn-primary" data-action="add-goal">创建第一个目标</button></div>`;

    // 统计
    const [mf, mt] = monthRange();
    const [wf, wt] = weekRange();
    $('#homeStats').innerHTML = [
      stat('💰', money(totalSaved()), '累计已存'),
      stat('📆', money(sumInRange(mf, mt, 'in')), '本月存入'),
      stat('🔥', depositStreak() + ' 天', '连续存钱'),
      stat('🎯', state.goals.filter(g => !g.archived).length + ' 个', '进行中目标'),
    ].join('');

    // 挑战预览
    const ch = state.challenges[0];
    const cwrap = $('#homeChallenge');
    if (ch && CHALLENGE_TEMPLATES[ch.type]) {
      const done = challengeDoneCount(ch), tot = challengeTargetCount(ch);
      cwrap.innerHTML = `<div class="card" data-action="goto:challenges" style="cursor:pointer">
        <div class="challenge-top"><span class="challenge-emoji">${CHALLENGE_TEMPLATES[ch.type].emoji}</span>
        <div><div class="challenge-name">${esc(ch.name)}</div>
        <div class="challenge-desc">已完成 ${done}/${tot} · 累计 ${money(challengeSaved(ch))}</div></div></div>
        <div class="progress" style="margin-top:12px"><i style="width:${Math.min(100, done / tot * 100)}%"></i></div>
      </div>`;
    } else { cwrap.innerHTML = ''; }
  }

  function renderAssistantCard(data) {
    $('#assistantBubble').textContent = data.bubble;
    $('#assistantActions').innerHTML = (data.chips || [])
      .map(c => `<button class="chip" data-action="chip:${esc(c.action)}">${esc(c.label)}</button>`).join('');
  }

  function stat(ico, val, label) {
    return `<div class="stat"><div class="stat-ico">${ico}</div><div class="stat-val">${esc(val)}</div><div class="stat-label">${esc(label)}</div></div>`;
  }

  function goalCardHTML(g, isActive) {
    const saved = goalSaved(g.id);
    const pct = Math.min(100, Math.round((saved / g.target) * 100));
    const remain = Math.max(0, g.target - saved);
    let tag = '';
    if (g.archived) tag = '<span class="tag">已归档</span>';
    else if (saved >= g.target) tag = '<span class="tag done">已达成 🎉</span>';
    else if (isActive) tag = '<span class="tag">当前目标</span>';
    let meta = `<span class="goal-pct">${pct}%</span>`;
    if (g.deadline) {
      const dl = daysBetween(todayStr(), g.deadline);
      if (saved < g.target) {
        if (dl < 0) meta += `<span class="tag warn">已超期</span>`;
        else meta += `<span>还剩 ${dl} 天</span>`;
      }
    } else if (saved < g.target) {
      const p = projectGoalDate(g);
      if (p.avg > 0) meta += `<span>预计 ${fmtDate(p.date)}</span>`;
    }
    return `<div class="goal-card">
      <div class="goal-top">
        <span class="goal-emoji">${esc(g.emoji || '🎯')}</span>
        <div><div class="goal-name">${esc(g.name)}${tag}</div>
        <div class="goal-sub">目标 ${money(g.target)}${g.deadline ? ' · 截止 ' + fmtDate(g.deadline) : ''}${g.monthlyPlan ? ' · 每月 ' + money(g.monthlyPlan) : ''}</div></div>
        <button class="goal-menu" data-action="goal-menu:${esc(g.id)}">⋯</button>
      </div>
      <div class="goal-amount"><span class="cur">${money(saved)}</span> <span class="tot">/ ${money(g.target)}</span></div>
      <div class="progress"><i style="width:${pct}%"></i></div>
      <div class="goal-meta">${meta}<span>还差 ${money(remain)}</span></div>
      <div class="goal-actions">
        ${g.archived
          ? `<button class="btn btn-ghost" data-action="archive-goal:${esc(g.id)}">↩️ 取消归档</button>`
          : `<button class="btn btn-primary" data-action="deposit-goal:${esc(g.id)}">＋ 存一笔</button>${isActive ? '' : `<button class="btn btn-ghost" data-action="set-active:${esc(g.id)}">设为当前</button>`}`}
      </div>
    </div>`;
  }

  /* ----- 目标页 ----- */
  let showArchived = false;
  function renderGoals() {
    const list = $('#goalsList');
    if (!state.goals.length) {
      list.innerHTML = `<div class="empty"><div class="ico">🎯</div><p>还没有存钱目标<br>设一个小目标，开始攒钱之旅吧！</p><button class="btn btn-primary" data-action="add-goal">+ 创建目标</button></div>`;
      return;
    }
    const act = activeGoal();
    const activeGoals = state.goals.filter(g => !g.archived);
    const archivedGoals = state.goals.filter(g => g.archived);
    let html = activeGoals.length
      ? activeGoals.map(g => goalCardHTML(g, act && g.id === act.id)).join('')
      : `<div class="empty"><div class="ico">📦</div><p>进行中的目标都已归档</p><button class="btn btn-primary" data-action="add-goal">+ 新建目标</button></div>`;
    if (archivedGoals.length) {
      html += `<div class="center" style="margin:4px 0 12px"><button class="chip" data-action="toggle-archived">${showArchived ? '隐藏已归档' : '查看已归档 (' + archivedGoals.length + ')'}</button></div>`;
      if (showArchived) html += archivedGoals.map(g => goalCardHTML(g, false)).join('');
    }
    list.innerHTML = html;
  }

  /* ----- 记录页 ----- */
  let recordFilter = 'all';
  function renderRecords() {
    // 图表
    $('#chartWrap').innerHTML = buildChartSVG();
    $('#barsWrap').innerHTML = buildBarsHTML();
    $('#insights').innerHTML = buildInsightsHTML();

    // 摘要
    const [mf, mt] = monthRange();
    $('#recordSummary').innerHTML = `
      <div class="rs"><b style="color:var(--good)">${money(totalSaved())}</b><span>累计净存</span></div>
      <div class="rs"><b>${money(sumInRange(mf, mt, 'in'))}</b><span>本月存入</span></div>
      <div class="rs"><b>${state.records.length}</b><span>笔记录</span></div>`;

    // 筛选条
    const segs = [['all', '全部'], ['week', '本周'], ['month', '本月'], ['in', '仅存入'], ['out', '仅取出']];
    $('#recordFilter').innerHTML = segs.map(([k, l]) =>
      `<button class="seg ${recordFilter === k ? 'on' : ''}" data-action="rfilter:${k}">${l}</button>`).join('');

    // 列表
    let recs = state.records.slice();
    if (recordFilter === 'in') recs = recs.filter(r => r.type === 'in');
    else if (recordFilter === 'out') recs = recs.filter(r => r.type === 'out');
    else if (recordFilter === 'week') { const [f, t] = weekRange(); recs = recs.filter(r => r.date >= f && r.date <= t); }
    else if (recordFilter === 'month') { const [f, t] = monthRange(); recs = recs.filter(r => r.date >= f && r.date <= t); }

    recs.sort((a, b) => ((b.date || '').localeCompare(a.date || '')) || (b.createdAt - a.createdAt));

    const listEl = $('#recordsList');
    if (!recs.length) {
      listEl.innerHTML = `<div class="empty"><div class="ico">📒</div><p>暂无记录<br>点右下角 ＋ 存第一笔吧！</p></div>`;
      return;
    }
    // 按天分组
    const groups = {};
    recs.forEach(r => { (groups[r.date] = groups[r.date] || []).push(r); });
    const days = Object.keys(groups).sort((a, b) => b.localeCompare(a));
    listEl.innerHTML = days.map(d => {
      const items = groups[d].map(r => recordRowHTML(r)).join('');
      return `<div class="day-group"><div class="day-label">${fmtDate(d)}</div>${items}</div>`;
    }).join('');
  }

  function recordRowHTML(r) {
    const g = getGoal(r.goalId);
    const isIn = r.type === 'in';
    const title = r.note ? esc(r.note) : (isIn ? '存入' : '取出');
    return `<div class="rec">
      <div class="rec-ico ${isIn ? 'in' : 'out'}">${isIn ? '💰' : '💸'}</div>
      <div class="rec-main" data-action="edit-record:${esc(r.id)}">
        <div class="rec-title">${title}${r.challengeId ? ' <span class="muted" style="font-size:11px">· 挑战</span>' : ''}</div>
        <div class="rec-note">${g ? esc(g.emoji || '🎯') + ' ' + esc(g.name) : '未分类'}</div>
      </div>
      <div class="rec-amt ${isIn ? 'in' : 'out'}">${isIn ? '+' : '-'}${money(r.amount)}</div>
      <button class="rec-del" data-action="del-record:${esc(r.id)}" title="删除">🗑</button>
    </div>`;
  }

  function buildChartSVG() {
    const W = 320, H = 120, pad = 6;
    const days = 30;
    const labels = [];
    for (let i = days - 1; i >= 0; i--) labels.push(todayStr(addDays(new Date(), -i)));
    // 累计净额（从0起算这30天内的变化）
    const dayNet = {};
    state.records.forEach(r => {
      if (r.date >= labels[0] && r.date <= labels[labels.length - 1])
        dayNet[r.date] = (dayNet[r.date] || 0) + (r.type === 'in' ? r.amount : -r.amount);
    });
    let cum = 0; const series = labels.map(d => (cum += (dayNet[d] || 0)));
    const max = Math.max(1, ...series), min = Math.min(0, ...series);
    const range = max - min || 1;
    const x = i => pad + (i / (labels.length - 1)) * (W - pad * 2);
    const y = v => H - pad - ((v - min) / range) * (H - pad * 2);

    if (!state.records.length) {
      return `<svg viewBox="0 0 ${W} ${H}"><text x="${W / 2}" y="${H / 2}" text-anchor="middle" fill="#aab4ba" font-size="12">还没有数据，存一笔就有图啦 📈</text></svg>`;
    }
    const line = series.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
    const area = `${pad},${H - pad} ${line} ${(W - pad)},${H - pad}`;
    return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
      <defs><linearGradient id="g1" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#1abc9c" stop-opacity="0.35"/>
        <stop offset="1" stop-color="#1abc9c" stop-opacity="0"/>
      </linearGradient></defs>
      <polygon points="${area}" fill="url(#g1)"/>
      <polyline points="${line}" fill="none" stroke="#16a085" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>
      <circle cx="${x(series.length - 1).toFixed(1)}" cy="${y(series[series.length - 1]).toFixed(1)}" r="3.5" fill="#16a085"/>
    </svg>`;
  }

  /* ----- 挑战页 ----- */
  function renderChallenges() {
    const list = $('#challengesList');
    if (!state.challenges.length) {
      list.innerHTML = `<div class="empty"><div class="ico">🏆</div><p>加入一个存钱挑战<br>让存钱像游戏一样上瘾！</p><button class="btn btn-primary" data-action="add-challenge">+ 加入挑战</button></div>`;
      return;
    }
    list.innerHTML = state.challenges.map(challengeCardHTML).join('');
  }

  function challengeCardHTML(c) {
    const tpl = CHALLENGE_TEMPLATES[c.type];
    if (!tpl) return '';
    const done = challengeDoneCount(c), tot = challengeTargetCount(c);
    const saved = challengeSaved(c), goalT = challengeTotal(c);
    const g = getGoal(c.goalId);
    let body = '';

    if (tpl.mode === 'grid') {
      let cells = '';
      const today = todayStr();
      for (let i = 1; i <= tpl.steps; i++) {
        const on = !!c.checks['s' + i];
        cells += `<div class="cell ${on ? 'done' : ''}" data-action="cell:${esc(c.id)}:${i}" title="第${i}${tpl.unit} · ${money(tpl.amountAt(i, c.base))}">${i}</div>`;
      }
      const cls = tpl.steps > 12 ? 'weeks' : 'months';
      body = `<div class="cells ${cls}">${cells}</div>
        <div class="goal-meta" style="margin-top:10px"><span>点格子标记完成</span><span>下一格存 ${money(tpl.amountAt(Math.min(tpl.steps, done + 1), c.base))}</span></div>`;
    } else {
      const today = todayStr();
      const doneToday = !!c.checks[today];
      const streak = dailyStreak(c);
      // 最近 14 天小圆点
      let dots = '';
      for (let i = 13; i >= 0; i--) {
        const ds = todayStr(addDays(new Date(), -i));
        dots += `<div class="cell ${c.checks[ds] ? 'done' : ''}" style="font-size:0" title="${ds}"></div>`;
      }
      body = `<div class="cells" style="grid-template-columns:repeat(14,1fr)">${dots}</div>
        <div class="goal-meta" style="margin-top:10px"><span>🔥 连续 ${streak} 天</span><span>每天存 ${money(c.base)}</span></div>
        <div class="mini-actions">
          <button class="btn ${doneToday ? 'btn-ghost' : 'btn-primary'}" data-action="checkin:${esc(c.id)}" ${doneToday ? 'disabled' : ''}>${doneToday ? '今日已打卡 ✓' : '今日打卡 ＋' + money(c.base)}</button>
        </div>`;
    }

    return `<div class="challenge-card">
      <div class="challenge-top">
        <span class="challenge-emoji">${tpl.emoji}</span>
        <div><div class="challenge-name">${esc(c.name)}</div>
        <div class="challenge-desc">${g ? '存入 → ' + esc(g.emoji || '🎯') + esc(g.name) : '未关联目标'}</div></div>
        <button class="goal-menu" data-action="challenge-menu:${esc(c.id)}">⋯</button>
      </div>
      <div class="challenge-stat">
        <div><b>${money(saved)}</b> <span class="muted">/ ${money(goalT)}</span></div>
        <div class="muted">${done}/${tot}</div>
      </div>
      <div class="progress" style="margin-bottom:12px"><i style="width:${Math.min(100, done / tot * 100)}%"></i></div>
      ${body}
    </div>`;
  }

  /* ===========================================================
     交互：导航 / 弹窗 / 表单
     =========================================================== */
  function switchTab(name) {
    $$('.tab').forEach(t => {
      const on = t.dataset.tab === name;
      t.classList.toggle('is-active', on);
      t.setAttribute('aria-current', on ? 'page' : 'false');
    });
    $$('.screen').forEach(s => s.classList.toggle('is-active', s.dataset.screen === name));
    const titles = { home: '存钱小帮手', goals: '我的目标', records: '存钱记录', challenges: '存钱挑战', assistant: 'AI 小帮手' };
    $('#topbarTitle').textContent = titles[name] || '存钱小帮手';
    // 聊天屏底部有固定输入栏，隐藏 FAB 以免遮挡发送按钮
    $('#fab').hidden = (name === 'assistant');
    $('#screens').scrollTop = 0;
  }

  /* ----- Sheet ----- */
  let lastFocus = null;
  function openSheet(title, bodyHTML, onMount) {
    lastFocus = document.activeElement;
    $('#sheetTitle').textContent = title;
    $('#sheetBody').innerHTML = bodyHTML;
    $('#sheetMask').hidden = false;
    $('#app').setAttribute('inert', '');     // 背景失活，键盘/读屏焦点不会跑到下层
    if (onMount) onMount($('#sheetBody'));
    try { $('#sheet').focus(); } catch (_) {} // 焦点移入对话框
  }
  function closeSheet() {
    $('#sheetMask').hidden = true;
    $('#sheetBody').innerHTML = '';
    $('#app').removeAttribute('inert');
    if (lastFocus && typeof lastFocus.focus === 'function') { try { lastFocus.focus(); } catch (_) {} }
    lastFocus = null;
  }

  const EMOJIS = ['🎯', '✈️', '🏠', '🚗', '📱', '💻', '🎓', '💍', '👶', '🏥', '🎁', '🐷', '🌍', '📷', '🎮'];

  /* ----- 目标表单 ----- */
  function openGoalForm(goal) {
    const editing = !!goal;
    const g = goal || { emoji: '🎯', name: '', target: '', deadline: '', monthlyPlan: '' };
    const html = `
      <div class="field"><label>选个图标</label>
        <div class="emoji-picker" id="emojiPick">
          ${EMOJIS.map(e => `<button type="button" data-emoji="${e}" class="${e === g.emoji ? 'on' : ''}">${e}</button>`).join('')}
        </div>
      </div>
      <div class="field"><label>目标名称</label>
        <input id="gName" type="text" maxlength="20" placeholder="例如：日本旅行 / 应急基金" value="${esc(g.name)}"/></div>
      <div class="field"><label>目标金额</label>
        <input id="gTarget" type="number" inputmode="decimal" min="1" placeholder="例如：10000" value="${g.target || ''}"/></div>
      <div class="field"><label>截止日期（可选）</label>
        <input id="gDeadline" type="date" value="${g.deadline || ''}"/></div>
      <div class="field"><label>计划每月存（可选）</label>
        <input id="gPlan" type="number" inputmode="decimal" min="0" placeholder="例如：500，用于预测达成时间" value="${g.monthlyPlan || ''}"/></div>
      <button class="btn btn-primary btn-block" id="saveGoal">${editing ? '保存修改' : '创建目标'}</button>
      ${editing ? `<button class="btn btn-danger btn-block mt8" data-action="del-goal:${esc(g.id)}">删除目标</button>` : ''}
    `;
    openSheet(editing ? '编辑目标' : '新建目标', html, (root) => {
      let chosen = g.emoji;
      $('#emojiPick', root).addEventListener('click', e => {
        const b = e.target.closest('[data-emoji]'); if (!b) return;
        chosen = b.dataset.emoji;
        $$('#emojiPick button', root).forEach(x => x.classList.toggle('on', x === b));
      });
      $('#saveGoal', root).addEventListener('click', () => {
        const name = $('#gName', root).value.trim();
        const target = parseFloat($('#gTarget', root).value);
        const deadline = $('#gDeadline', root).value || '';
        const planRaw = parseFloat($('#gPlan', root).value);
        const monthlyPlan = (isFinite(planRaw) && planRaw > 0) ? planRaw : 0;
        if (!name) return toast('给目标起个名字吧');
        if (!target || target <= 0) return toast('请输入有效的目标金额');
        if (editing) {
          Object.assign(goal, { name, target, deadline, emoji: chosen, monthlyPlan });
        } else {
          const ng = { id: uid(), name, target, deadline, emoji: chosen, monthlyPlan, archived: false, createdAt: Date.now() };
          state.goals.push(ng);
          if (!state.settings.activeGoalId) state.settings.activeGoalId = ng.id;
        }
        save(); renderAll(); closeSheet();
        toast(editing ? '已保存 ✅' : '目标已创建，开始存钱吧！🎉');
      });
    });
  }

  /* ----- 存/取款表单 ----- */
  function openRecordForm(presetGoalId, presetType, editRecord) {
    const editing = !!editRecord;
    const selectable = state.goals.filter(g => !g.archived);
    if (!selectable.length && !editing) {
      return openSheet('先创建目标', `<div class="empty"><div class="ico">🎯</div><p>还没有目标，先建一个再存钱～</p><button class="btn btn-primary" data-action="add-goal">+ 创建目标</button></div>`);
    }
    let type = editing ? editRecord.type : (presetType || 'in');
    let goalId = editing ? editRecord.goalId : (presetGoalId || (activeGoal() && activeGoal().id) || selectable[0].id);
    // 确保当前目标在可选列表里（编辑历史记录时其目标可能已归档）
    let goals = selectable.slice();
    if (!goals.some(g => g.id === goalId)) { const gx = getGoal(goalId); if (gx) goals = [gx, ...goals]; }
    const quick = [10, 50, 100, 500, 1000];
    const sources = ['工资', '红包', '省下的', '兼职', '利息'];
    const html = `
      <div class="seg-toggle" id="typeToggle">
        <button data-type="in" class="${type === 'in' ? 'on' : ''}">💰 存入</button>
        <button data-type="out" class="${type === 'out' ? 'on' : ''}">💸 取出</button>
      </div>
      <div class="field" style="margin-top:14px"><label>金额</label>
        <input id="rAmount" type="number" inputmode="decimal" min="0.01" placeholder="0.00" value="${editing ? editRecord.amount : ''}"/>
        <div class="amount-quick">${quick.map(q => `<button type="button" data-q="${q}">+${q}</button>`).join('')}</div>
      </div>
      <div class="field"><label>选择目标</label>
        <div class="goal-select-list" id="goalSel">
          ${goals.map(g => `<div class="opt ${g.id === goalId ? 'on' : ''}" data-gid="${esc(g.id)}">
            <span style="font-size:20px">${esc(g.emoji || '🎯')}</span>
            <div><div style="font-weight:600">${esc(g.name)}</div>
            <div class="muted" style="font-size:12px">${money(goalSaved(g.id))} / ${money(g.target)}</div></div></div>`).join('')}
        </div>
      </div>
      <div class="field"><label>备注（可选）</label>
        <input id="rNote" type="text" maxlength="30" placeholder="例如：本月工资 / 省下的奶茶钱" value="${editing ? esc(editRecord.note || '') : ''}"/>
        <div class="tag-chips" id="srcTags">${sources.map(s => `<button type="button" data-src="${s}">${s}</button>`).join('')}</div>
      </div>
      <div class="field"><label>日期</label>
        <input id="rDate" type="date" value="${editing ? editRecord.date : todayStr()}" max="${todayStr()}"/></div>
      <button class="btn btn-primary btn-block" id="saveRecord">${editing ? '保存修改' : '确认存入'}</button>
    `;
    openSheet(editing ? '编辑记录' : '记一笔', html, (root) => {
      const updateBtn = () => { $('#saveRecord', root).textContent = editing ? '保存修改' : (type === 'in' ? '确认存入' : '确认取出'); };
      $('#typeToggle', root).addEventListener('click', e => {
        const b = e.target.closest('[data-type]'); if (!b) return;
        type = b.dataset.type;
        $$('#typeToggle button', root).forEach(x => x.classList.toggle('on', x === b));
        updateBtn();
      });
      updateBtn();
      const amtInput = $('#rAmount', root);
      $('.amount-quick', root).addEventListener('click', e => {
        const b = e.target.closest('[data-q]'); if (!b) return;
        amtInput.value = ((parseFloat(amtInput.value) || 0) + Number(b.dataset.q)).toString();
      });
      $('#srcTags', root).addEventListener('click', e => {
        const b = e.target.closest('[data-src]'); if (!b) return;
        $('#rNote', root).value = b.dataset.src;
        $$('#srcTags button', root).forEach(x => x.classList.toggle('on', x === b));
      });
      $('#goalSel', root).addEventListener('click', e => {
        const opt = e.target.closest('[data-gid]'); if (!opt) return;
        goalId = opt.dataset.gid;
        $$('#goalSel .opt', root).forEach(x => x.classList.toggle('on', x === opt));
      });
      $('#saveRecord', root).addEventListener('click', () => {
        const amount = parseFloat(amtInput.value);
        if (!amount || amount <= 0) return toast('请输入有效金额');
        const date = $('#rDate', root).value || todayStr();
        const note = $('#rNote', root).value.trim();
        if (editing) {
          Object.assign(editRecord, { type, amount, date, note, goalId });
          save(); lastAssistant = AI.daily(); renderAll(); closeSheet(); toast('已保存 ✅');
          return;
        }
        const rec = { id: uid(), goalId, type, amount, date, note, createdAt: Date.now() };
        const before = goalSaved(goalId);
        state.records.push(rec);
        const after = goalSaved(goalId);
        const g = getGoal(goalId);
        save();
        lastAssistant = AI.daily();
        renderAll(); closeSheet();
        if (type === 'in' && g && before < g.target && after >= g.target) {
          celebrate(); toast(`🎉 恭喜！「${g.name}」目标达成！`);
        } else {
          toast(type === 'in' ? `已存入 ${money(amount)} 💰` : `已取出 ${money(amount)}`);
        }
      });
    });
  }

  /* ----- 挑战表单 ----- */
  function openChallengeForm() {
    let chosenType = 'week52';
    let goalId = (activeGoal() && activeGoal().id) || (state.goals[0] && state.goals[0].id) || '';
    const optHTML = Object.entries(CHALLENGE_TEMPLATES).map(([k, t]) =>
      `<div class="opt ${k === chosenType ? 'on' : ''}" data-ct="${k}">
        <b>${t.emoji} ${t.name}</b><p>${t.desc}</p></div>`).join('');

    const goalOpts = state.goals.length
      ? `<div class="field"><label>存入哪个目标（完成时自动记账）</label>
          <select id="cGoal">${state.goals.map(g => `<option value="${g.id}" ${g.id === goalId ? 'selected' : ''}>${esc(g.emoji || '🎯')} ${esc(g.name)}</option>`).join('')}</select></div>`
      : `<div class="field"><p class="muted">还没有目标，挑战将独立记录进度（建议先创建目标以便自动记账）。</p></div>`;

    const html = `
      <div class="challenge-pick" id="ctPick">${optHTML}</div>
      <div id="ctConfig"></div>
      ${goalOpts}
      <button class="btn btn-primary btn-block" id="saveChallenge">开始挑战</button>
    `;
    openSheet('加入挑战', html, (root) => {
      const renderConfig = () => {
        const t = CHALLENGE_TEMPLATES[chosenType];
        let c = `<div class="field"><label>${chosenType === 'daily' ? '每天存入金额' : '基数（每' + t.unit + '递增）'}</label>
          <input id="cBase" type="number" inputmode="decimal" min="1" value="${t.defaultBase}"/></div>`;
        if (chosenType === 'daily') {
          c += `<div class="field"><label>目标天数</label><input id="cDays" type="number" min="1" value="${t.defaultDays}"/></div>`;
        }
        // 预估总额
        c += `<p class="muted" id="cEstimate"></p>`;
        $('#ctConfig', root).innerHTML = c;
        updateEstimate(root);
        const bi = $('#cBase', root); if (bi) bi.addEventListener('input', () => updateEstimate(root));
        const di = $('#cDays', root); if (di) di.addEventListener('input', () => updateEstimate(root));
      };
      $('#ctPick', root).addEventListener('click', e => {
        const o = e.target.closest('[data-ct]'); if (!o) return;
        chosenType = o.dataset.ct;
        $$('#ctPick .opt', root).forEach(x => x.classList.toggle('on', x === o));
        renderConfig();
      });
      renderConfig();
      $('#saveChallenge', root).addEventListener('click', () => {
        const t = CHALLENGE_TEMPLATES[chosenType];
        const base = parseFloat($('#cBase', root).value) || t.defaultBase;
        if (base <= 0) return toast('请输入有效金额');
        const c = { id: uid(), type: chosenType, name: t.name, base, checks: {}, createdAt: Date.now() };
        if (chosenType === 'daily') c.targetDays = Math.max(1, parseInt($('#cDays', root).value) || t.defaultDays);
        const gsel = $('#cGoal', root); if (gsel) c.goalId = gsel.value;
        state.challenges.push(c);
        save(); renderAll(); closeSheet();
        switchTab('challenges');
        toast('挑战已开始，加油！🏆');
      });
    });
  }
  function updateEstimate(root) {
    const t = CHALLENGE_TEMPLATES[$$('#ctPick .opt.on', root)[0] ? $$('#ctPick .opt.on', root)[0].dataset.ct : 'week52'];
    const base = parseFloat($('#cBase', root) ? $('#cBase', root).value : 0) || 0;
    let total = 0, label = '';
    const ctEl = $('#ctPick .opt.on', root);
    const type = ctEl ? ctEl.dataset.ct : 'week52';
    if (type === 'daily') {
      const days = parseInt($('#cDays', root) ? $('#cDays', root).value : 0) || 0;
      total = base * days; label = `坚持 ${days} 天，共可存 ${money(total)}`;
    } else {
      const steps = CHALLENGE_TEMPLATES[type].steps;
      for (let i = 1; i <= steps; i++) total += base * i;
      label = `完成全部 ${steps} ${CHALLENGE_TEMPLATES[type].unit}，共可存 ${money(total)}`;
    }
    const est = $('#cEstimate', root); if (est) est.textContent = '💡 ' + label;
  }

  /* ----- 菜单（目标/挑战 ⋯） ----- */
  function openGoalMenu(id) {
    const g = getGoal(id); if (!g) return;
    const isActive = activeGoal() && activeGoal().id === id;
    const eid = esc(id);
    const html = `<div class="menu-list">
      ${(isActive || g.archived) ? '' : `<button data-action="set-active:${eid}">⭐ 设为当前目标</button>`}
      ${g.archived ? '' : `<button data-action="deposit-goal:${eid}">💰 存一笔</button>`}
      <button data-action="edit-goal:${eid}">✏️ 编辑目标</button>
      <button data-action="archive-goal:${eid}">${g.archived ? '↩️ 取消归档' : '🗄️ 归档目标'}</button>
      <button class="danger" data-action="del-goal:${eid}">🗑 删除目标</button>
    </div>`;
    openSheet(esc(g.name), html);
  }
  function openChallengeMenu(id) {
    const c = state.challenges.find(x => x.id === id); if (!c) return;
    const tpl = CHALLENGE_TEMPLATES[c.type];
    const today = todayStr();
    const undoToday = tpl.mode === 'daily' && c.checks[today]
      ? `<button data-action="undo-checkin:${id}">↩️ 撤销今日打卡</button>` : '';
    const html = `<div class="menu-list">
      ${undoToday}
      <button class="danger" data-action="del-challenge:${id}">🗑 退出并删除挑战</button>
    </div>`;
    openSheet(esc(c.name), html);
  }

  /* ----- 设置 ----- */
  function openSettings() {
    const t = state.settings.theme || 'auto';
    const accountHtml = !HAS_API
      ? `<p class="muted" style="font-size:12.5px">通过部署后的网址访问，可登录账号、云端同步、并使用真·AI 对话。</p>`
      : (account
        ? `<div class="setting-row"><div><div class="sr-label">已登录 ☁️</div><div class="sr-sub">${esc(account.phone)} · 数据云端同步中</div></div><button class="btn btn-ghost" id="logoutBtn" style="flex:0 0 auto;padding:8px 14px">退出</button></div>`
        : `<button class="btn btn-primary btn-block" id="loginBtn">登录 / 注册账号（云同步 + 真 AI）</button>`);
    const html = `
      <div class="field"><label>账号与云同步</label>${accountHtml}</div>
      <div class="field"><label>你的昵称</label>
        <input id="sName" type="text" maxlength="12" placeholder="怎么称呼你？" value="${esc(state.user.name)}"/></div>
      <div class="field"><label>货币符号</label>
        <input id="sCur" type="text" maxlength="3" placeholder="RM / ¥ / $" value="${esc(state.settings.currency)}"/></div>
      <div class="field"><label>外观主题</label>
        <div class="seg-toggle" id="themeSeg">
          <button data-theme-opt="auto" class="${t === 'auto' ? 'on' : ''}">跟随系统</button>
          <button data-theme-opt="light" class="${t === 'light' ? 'on' : ''}">浅色</button>
          <button data-theme-opt="dark" class="${t === 'dark' ? 'on' : ''}">深色</button>
        </div>
      </div>
      <div class="setting-row">
        <div><div class="sr-label">每日存钱提醒</div><div class="sr-sub">当天还没存钱时用浏览器通知提醒你</div></div>
        <label class="switch"><input type="checkbox" id="sRemind" ${state.settings.reminder ? 'checked' : ''}/><span class="slider"></span></label>
      </div>
      <button class="btn btn-primary btn-block" id="saveSettings" style="margin-top:14px">保存</button>
      <div class="row mt8">
        <button class="btn btn-ghost" id="exportData">📤 导出备份</button>
        <button class="btn btn-ghost" id="importData">📥 导入数据</button>
      </div>
      <button class="btn btn-danger btn-block mt8" id="clearData">清空所有数据</button>
      <p class="muted center mt8" style="font-size:12px">${account ? '数据已同步到云端，换设备登录即可恢复。' : '数据保存在本机浏览器；登录账号后可云端同步、换手机不丢。'}</p>
    `;
    openSheet('设置', html, (root) => {
      // 账号
      const lb = $('#loginBtn', root); if (lb) lb.addEventListener('click', () => { closeSheet(); openAuthForm(); });
      const ob = $('#logoutBtn', root); if (ob) ob.addEventListener('click', () => { doLogout(); closeSheet(); });
      // 主题：点击即时预览并保存
      $('#themeSeg', root).addEventListener('click', e => {
        const b = e.target.closest('[data-theme-opt]'); if (!b) return;
        state.settings.theme = b.dataset.themeOpt;
        $$('#themeSeg button', root).forEach(x => x.classList.toggle('on', x === b));
        applyTheme(); save();
      });
      // 开启提醒时请求通知权限
      $('#sRemind', root).addEventListener('change', async (e) => {
        if (e.target.checked && 'Notification' in window && Notification.permission !== 'granted') {
          try {
            const perm = await Notification.requestPermission();
            if (perm !== 'granted') { e.target.checked = false; toast('未获得通知权限，可在浏览器设置中开启'); }
          } catch (_) { e.target.checked = false; }
        } else if (e.target.checked && !('Notification' in window)) {
          e.target.checked = false; toast('当前环境不支持通知');
        }
      });
      $('#saveSettings', root).addEventListener('click', () => {
        state.user.name = $('#sName', root).value.trim();
        const cur = $('#sCur', root).value.trim().replace(/[<>&"'`]/g, ''); if (cur) state.settings.currency = cur;
        state.settings.reminder = $('#sRemind', root).checked && ('Notification' in window) && Notification.permission === 'granted';
        save(); applyTheme(); lastAssistant = AI.daily(); renderAll(); closeSheet(); toast('已保存 ✅');
      });
      $('#exportData', root).addEventListener('click', exportData);
      $('#importData', root).addEventListener('click', importData);
      $('#clearData', root).addEventListener('click', () => {
        if (confirm('确定清空所有目标、记录和挑战吗？此操作不可恢复。')) {
          state = defaultState(); save(); lastAssistant = null; showArchived = false;
          applyTheme(); renderAll(); closeSheet(); switchTab('home'); toast('已清空');
        }
      });
    });
  }
  function exportData() {
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `存钱小帮手备份-${todayStr()}.json`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast('备份已导出 📤');
  }
  function importData() {
    const input = document.createElement('input');
    input.type = 'file'; input.accept = 'application/json,.json';
    input.addEventListener('change', () => {
      const f = input.files[0]; if (!f) return;
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const data = JSON.parse(reader.result);
          if (!data || typeof data !== 'object') throw new Error('格式错误');
          state = sanitizeState(data); save(); lastAssistant = null; renderAll(); closeSheet();
          switchTab('home'); toast('导入成功 ✅');
        } catch (e) { toast('导入失败：文件格式不正确'); }
      };
      reader.readAsText(f);
    });
    input.click();
  }

  /* ----- 聊天 ----- */
  function initChat() {
    const chat = $('#chat');
    if (!chat.dataset.init) {
      chat.dataset.init = '1';
      pushMsg('bot', `你好！我是你的存钱小帮手 🐷\n有任何关于存钱的问题都可以问我，或者点下面的快捷问题～`);
    }
    const qs = [
      ['怎么开始存钱？', '怎么开始存钱'],
      ['怎样更快达成目标？', '更快达成目标'],
      ['推荐一个存钱挑战', '推荐挑战'],
      ['我最近存得怎么样？', '我最近存得怎么样'],
      ['给我一句鼓励', '鼓励我'],
      ['一条省钱技巧', '省钱技巧'],
    ];
    $('#quickQuestions').innerHTML = qs.map(q => `<button class="chip" data-action="askq:${esc(q[1])}">${esc(q[0])}</button>`).join('');
  }
  function pushMsg(who, text) {
    const div = document.createElement('div');
    div.className = 'msg ' + who;
    div.textContent = text;
    $('#chat').appendChild(div);
    div.scrollIntoView({ behavior: 'smooth', block: 'end' });
    return div;
  }
  // 给真 AI 的上下文：把用户当前数据浓缩成一段文字
  function aiContext() {
    const lines = [];
    if (state.user.name) lines.push('昵称：' + state.user.name);
    lines.push('货币：' + state.settings.currency);
    lines.push('累计已存：' + money(totalSaved()) + '；连续存钱：' + depositStreak() + ' 天');
    const [mf, mt] = monthRange();
    lines.push('本月存入：' + money(sumInRange(mf, mt, 'in')));
    const act = state.goals.filter(x => !x.archived);
    if (act.length) {
      lines.push('目标：');
      act.forEach(x => {
        const s = goalSaved(x.id), pct = Math.min(100, Math.round(s / x.target * 100));
        lines.push(`- ${x.name}：${money(s)}/${money(x.target)}（${pct}%）` +
          (x.deadline ? '，截止' + x.deadline : '') + (x.monthlyPlan ? '，每月计划' + money(x.monthlyPlan) : ''));
      });
    } else { lines.push('（还没有存钱目标）'); }
    if (state.challenges.length) lines.push('进行中的挑战：' + state.challenges.map(c => c.name).join('、'));
    return lines.join('\n');
  }
  async function sendChat(text) {
    text = (text || '').trim(); if (!text || chatBusy) return; // 串行化，防止并发请求错位
    pushMsg('me', text);
    chatHistory.push({ role: 'user', content: text });
    // 已登录且有后端 → 调用真·Claude；否则用内置逻辑
    if (HAS_API && account) {
      chatBusy = true;
      const input = $('#chatInput'), sendBtn = $('#chatSend');
      if (input) input.disabled = true;
      if (sendBtn) sendBtn.disabled = true;
      const ph = pushMsg('bot', '小帮手正在思考…');
      let reply, unauthorized = false;
      try {
        const data = await api('/chat', { method: 'POST', body: { messages: chatHistory.slice(-20), context: aiContext() } });
        reply = (data && data.reply && !data.fallback) ? data.reply : AI.answer(text);
      } catch (e) {
        if (e.status === 401) unauthorized = true;
        reply = AI.answer(text);
      }
      ph.textContent = reply;
      ph.scrollIntoView({ behavior: 'smooth', block: 'end' });
      chatHistory.push({ role: 'assistant', content: reply });
      chatBusy = false;
      if (input) { input.disabled = false; input.focus(); }
      if (sendBtn) sendBtn.disabled = false;
      if (unauthorized) doLogout(true); // token 失效 → 同步登出，避免“变笨却仍显示已登录”
      return;
    }
    setTimeout(() => {
      const reply = AI.answer(text);
      pushMsg('bot', reply);
      chatHistory.push({ role: 'assistant', content: reply });
    }, 240);
  }

  /* ----- Toast / 撒花 ----- */
  let toastTimer;
  function toast(msg) {
    const el = $('#toast'); el.textContent = msg; el.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => (el.hidden = true), 2200);
  }
  function celebrate() {
    const wrap = $('#confetti');
    const colors = ['#16a085', '#1abc9c', '#ff8a5c', '#ffb86c', '#3498db', '#9b59b6'];
    for (let i = 0; i < 90; i++) {
      const p = document.createElement('i');
      p.style.left = Math.random() * 100 + '%';
      p.style.background = colors[Math.floor(Math.random() * colors.length)];
      p.style.animationDuration = (1.6 + Math.random() * 1.6) + 's';
      p.style.animationDelay = (Math.random() * 0.3) + 's';
      p.style.transform = `rotate(${Math.random() * 360}deg)`;
      wrap.appendChild(p);
    }
    setTimeout(() => (wrap.innerHTML = ''), 3600);
  }

  /* ===========================================================
     全局事件委托
     =========================================================== */
  document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-action]');
    if (!el) return;
    const raw = el.dataset.action;
    const [action, ...rest] = raw.split(':');
    const arg = rest.join(':');

    switch (action) {
      case 'add-goal': closeSheet(); openGoalForm(); break;
      case 'edit-goal': closeSheet(); openGoalForm(getGoal(arg)); break;
      case 'goal-menu': openGoalMenu(arg); break;
      case 'set-active': state.settings.activeGoalId = arg; save(); lastAssistant = AI.daily(); renderAll(); closeSheet(); toast('已设为当前目标 ⭐'); break;
      case 'del-goal': delGoal(arg); break;
      case 'archive-goal': archiveGoal(arg); break;
      case 'toggle-archived': showArchived = !showArchived; renderGoals(); break;
      case 'deposit': closeSheet(); openRecordForm(null, 'in'); break;
      case 'deposit-goal': closeSheet(); openRecordForm(arg, 'in'); break;
      case 'del-record': delRecord(arg); break;
      case 'edit-record': editRecordById(arg); break;
      case 'rfilter': recordFilter = arg; renderRecords(); break;
      case 'add-challenge': closeSheet(); openChallengeForm(); break;
      case 'challenge-menu': openChallengeMenu(arg); break;
      case 'del-challenge': delChallenge(arg); break;
      case 'cell': toggleCell(rest[0], parseInt(rest[1])); break;
      case 'checkin': checkinDaily(arg); break;
      case 'undo-checkin': undoCheckin(arg); break;
      case 'chip': handleChip(arg); break;
      case 'askq': switchTab('assistant'); initChat(); sendChat(arg); break;
      case 'goto': switchTab(arg); break;
      default: break;
    }
  });

  function handleChip(action) {
    const [a, ...rest] = action.split(':');
    if (a === 'add-goal') { openGoalForm(); }
    else if (a === 'deposit') { openRecordForm(null, 'in'); }
    else if (a === 'ask') { lastAssistant = { bubble: AI.answer(rest.join(':')), chips: lastAssistant.chips }; renderAssistantCard(lastAssistant); }
  }

  function delGoal(id) {
    const g = getGoal(id); if (!g) return;
    const n = state.records.filter(r => r.goalId === id).length;
    if (!confirm(`删除「${g.name}」？将同时删除其 ${n} 条记录。`)) return;
    state.goals = state.goals.filter(x => x.id !== id);
    state.records = state.records.filter(r => r.goalId !== id);
    state.challenges.forEach(c => { if (c.goalId === id) delete c.goalId; });
    if (state.settings.activeGoalId === id) state.settings.activeGoalId = state.goals[0] ? state.goals[0].id : null;
    save(); lastAssistant = AI.daily(); renderAll(); closeSheet(); toast('已删除');
  }
  function delRecord(id) {
    const r = state.records.find(x => x.id === id); if (!r) return;
    // 若该记录由挑战生成，同时取消对应勾选
    if (r.challengeId) {
      const c = state.challenges.find(x => x.id === r.challengeId);
      if (c && r.stepKey) delete c.checks[r.stepKey];
    }
    state.records = state.records.filter(x => x.id !== id);
    save(); lastAssistant = AI.daily(); renderAll(); toast('已删除记录');
  }
  function editRecordById(id) {
    const r = state.records.find(x => x.id === id); if (!r) return;
    if (r.challengeId) { toast('该记录来自挑战，请在「挑战」页调整'); return; }
    closeSheet(); openRecordForm(null, null, r);
  }
  function archiveGoal(id) {
    const g = getGoal(id); if (!g) return;
    g.archived = !g.archived;
    if (g.archived && state.settings.activeGoalId === id) {
      const next = state.goals.find(x => !x.archived);
      state.settings.activeGoalId = next ? next.id : null;
    }
    save(); lastAssistant = AI.daily(); renderAll(); closeSheet();
    toast(g.archived ? '已归档 🗄️' : '已取消归档');
  }
  function delChallenge(id) {
    const c = state.challenges.find(x => x.id === id); if (!c) return;
    if (!confirm(`退出「${c.name}」？挑战产生的存入记录也会一并删除。`)) return;
    state.records = state.records.filter(r => r.challengeId !== id);
    state.challenges = state.challenges.filter(x => x.id !== id);
    save(); lastAssistant = AI.daily(); renderAll(); closeSheet(); toast('已退出挑战');
  }
  function toggleCell(cid, i) {
    const c = state.challenges.find(x => x.id === cid); if (!c) return;
    const tpl = CHALLENGE_TEMPLATES[c.type];
    const key = 's' + i;
    const on = !c.checks[key];
    const amount = tpl.amountAt(i, c.base);
    setChallengeStep(c, key, on, { amount, note: `${c.name} · 第${i}${tpl.unit}` });
    save();
    const done = challengeDoneCount(c), tot = challengeTargetCount(c);
    lastAssistant = AI.daily(); renderAll();
    if (on && done === tot) { celebrate(); toast(`🎉 挑战「${c.name}」全部完成！`); }
    else if (on) toast(`完成第 ${i} ${tpl.unit}，存入 ${money(amount)} 💰`);
  }
  function checkinDaily(cid) {
    const c = state.challenges.find(x => x.id === cid); if (!c) return;
    const today = todayStr();
    if (c.checks[today]) return toast('今天已经打卡啦～');
    setChallengeStep(c, today, true, { amount: c.base, note: `${c.name} · 打卡`, date: today });
    save();
    const done = challengeDoneCount(c), tot = challengeTargetCount(c);
    lastAssistant = AI.daily(); renderAll();
    if (done >= tot) { celebrate(); toast(`🎉 挑战「${c.name}」达成目标天数！`); }
    else { const s = dailyStreak(c); toast(s >= 2 ? `打卡成功！已连续 ${s} 天 🔥` : '打卡成功！存入 ' + money(c.base)); }
  }
  function undoCheckin(cid) {
    const c = state.challenges.find(x => x.id === cid); if (!c) return;
    const today = todayStr();
    if (!c.checks[today]) { closeSheet(); return; }
    setChallengeStep(c, today, false, {});
    save(); lastAssistant = AI.daily(); renderAll(); closeSheet(); toast('已撤销今日打卡');
  }

  /* ===========================================================
     绑定固定控件 & 启动
     =========================================================== */
  function bindStatic() {
    $('#tabbar').addEventListener('click', e => {
      const b = e.target.closest('.tab'); if (!b) return;
      switchTab(b.dataset.tab);
      if (b.dataset.tab === 'assistant') initChat();
    });
    $('#fab').addEventListener('click', () => openRecordForm(null, 'in'));
    $('#topbarAction').addEventListener('click', openSettings);
    $('#addGoalBtn').addEventListener('click', () => openGoalForm());
    $('#addChallengeBtn').addEventListener('click', () => openChallengeForm());
    $('#assistantRefresh').addEventListener('click', () => {
      lastAssistant = AI.daily(); renderAssistantCard(lastAssistant);
    });

    $('#sheetClose').addEventListener('click', closeSheet);
    $('#sheetMask').addEventListener('click', e => { if (e.target === $('#sheetMask')) closeSheet(); });
    document.addEventListener('keydown', e => { if (e.key === 'Escape') closeSheet(); });
    // 键盘弹出时把聚焦的输入框滚动到可见区域
    $('#sheetBody').addEventListener('focusin', e => {
      if (e.target.matches && e.target.matches('input, select, textarea')) {
        setTimeout(() => { try { e.target.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch (_) {} }, 200);
      }
    });

    $('#chatSend').addEventListener('click', () => { const i = $('#chatInput'); sendChat(i.value); i.value = ''; });
    $('#chatInput').addEventListener('keydown', e => {
      if (e.key === 'Enter') { sendChat(e.target.value); e.target.value = ''; }
    });
  }

  function registerSW() {
    if ('serviceWorker' in navigator) {
      window.addEventListener('load', () => {
        navigator.serviceWorker.register('sw.js').catch(() => {});
      });
    }
  }

  function init() {
    state = loadState();
    account = loadAuth();
    applyTheme();
    // 系统主题切换时，若设为「跟随系统」则同步状态栏色
    if (window.matchMedia) {
      try {
        window.matchMedia('(prefers-color-scheme: dark)')
          .addEventListener('change', () => { if ((state.settings.theme || 'auto') === 'auto') applyTheme(); });
      } catch (_) {}
    }
    bindStatic();
    lastAssistant = AI.daily();
    renderAll();
    switchTab('home');
    registerSW();
    maybeRemind();
    if (account) syncPull(); // 已登录则从云端拉取最新数据
  }

  init();
})();
