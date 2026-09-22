'use strict';

const api = window.zpanel;

let accounts = [];
let current = null;

const $ = (s) => document.querySelector(s);

const FRESH_LIMIT_DAYS = 1;

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmtAgo(iso) {
  if (!iso) return '从未';
  const d = (Date.now() - new Date(iso).getTime()) / 1000;
  if (d < 60) return '刚刚';
  if (d < 3600) return `${Math.floor(d / 60)} 分钟前`;
  if (d < 86400) return `${Math.floor(d / 3600)} 小时前`;
  return `${Math.floor(d / 86400)} 天前`;
}

function fmtDate(iso) {
  if (!iso) return '--';
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function toast(msg, ok = true, duration = 2600) {
  const el = $('#toast');
  el.textContent = msg;
  el.style.background = ok ? 'var(--blue-900)' : 'var(--bad)';
  el.classList.add('show');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('show'), duration);
}

function planLabel(name) {
  const short = name.replace(/^builtin:/, '');
  const map = {
    'zai-start-plan': 'ZAI Start',
    'zai-coding-plan': 'ZAI Coding',
    'bigmodel-coding-plan': 'BigModel Coding',
    'bigmodel-start-plan': 'BigModel Start',
  };
  return map[short] || short;
}

function planStatusClass(status) {
  if (status === 'available') return 'ok';
  if (status === 'unavailable') return 'no';
  return 'warn';
}

async function loadCurrent() {
  current = await api.currentUser();
  const userEl = $('#current-user');
  if (current && current.user_id) {
    const match = accounts.find((a) => a.user_id === current.user_id);
    userEl.textContent = match ? match.id : `uid ${current.user_id.slice(0, 8)}…`;
    $('#current-status').textContent = current.email ? current.email : '已登录';
  } else {
    userEl.textContent = '未登录';
    $('#current-status').textContent = '客户端未登录或凭据缺失';
  }
}

async function doQuotaRefresh() {
  const btn = $('#btn-quota-refresh');
  setLoading(btn, true);
  await loadQuota(true);
  setLoading(btn, false);
  toast('套餐额度已刷新', true);
}

function fmtTokens(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return '--';
  const trim = (s) => s.replace(/\.0+$/, '');
  if (n >= 100000000) return trim((n / 100000000).toFixed(2)) + '亿';
  if (n >= 10000) return trim((n / 10000).toFixed(1)) + '万';
  return String(n);
}

// 侧栏窄栏用的短日期：MM-DD HH:mm
function fmtDateShort(iso) {
  if (!iso) return '--';
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// ===== ZCode 侧套餐与额度（数据来自客户端日志里的 billing/balance 响应）=====

function fmtAgoShort(sec) {
  if (sec === null || sec === undefined) return '';
  if (sec < 60) return `${sec} 秒前`;
  if (sec < 3600) return `${Math.floor(sec / 60)} 分钟前`;
  return `${Math.floor(sec / 3600)} 小时前`;
}

function quotaDesc(plan, now) {
  if (plan.expired) return `已结束（${fmtDateShort(plan.endsAt)} 截止）`;
  const end = fmtDateShort(plan.endsAt);
  // 一次性活动类：强调窗口
  const ent = plan.entitlements[0];
  if (ent && ent.period === 'one_time' && ent.pending) {
    return `${fmtDateShort(ent.effectiveAt)} 生效 · ${end} 截止`;
  }
  if (ent && ent.period === 'one_time') return `生效中 · ${end} 截止`;
  return `有效期至 ${end}`;
}

function renderQuotaItem(name, total, used, available, period, gift) {
  const pct = total > 0 ? Math.min(100, (used / total) * 100) : 0;
  const left = total > 0 ? total - used : 0;
  const cls = pct >= 100 ? 'quota-item--full' : (pct > 70 ? 'quota-item--warn' : '');
  return `<div class="quota-item ${cls}">
    <div class="quota-item__row">
      <span class="quota-item__name">${name}</span>
      <span class="quota-item__num">${fmtTokens(left)}/${fmtTokens(total)}</span>
    </div>
    <div class="quota-bar"><span style="width:${pct.toFixed(1)}%"></span></div>
    <div class="quota-item__foot">${period === 'daily' ? '剩余 · 今日已用 ' + fmtTokens(used) : (gift ? '剩余 · 一次性赠送' : '剩余 · 一次性额度')}</div>
  </div>`;
}

function renderQuotaItemPending(name, grant, effectiveAt) {
  return `<div class="quota-item quota-item--pending">
    <div class="quota-item__row">
      <span class="quota-item__name">${name}</span>
      <span class="quota-item__num">${fmtTokens(grant)}</span>
    </div>
    <div class="quota-bar"><span style="width:0%"></span></div>
    <div class="quota-item__foot">尚未生效 · ${fmtDateShort(effectiveAt)} 起可用</div>
  </div>`;
}

function renderQuota(data) {
  const grid = $('#quota-grid');
  const upd = $('#quota-updated');
  grid.innerHTML = '';

  if (!data || !data.ok) {
    upd.textContent = data && data.msg ? data.msg : '读取失败';
    grid.innerHTML = `<div class="quota-empty">${data && data.msg ? data.msg : '没有可用的套餐数据'}</div>`;
    return;
  }

  const ago = fmtAgoShort(data.ageSeconds);
  upd.textContent = `${data.logTs || '--'} 读取${ago ? ' · ' + ago : ''}`;

  // 新架构下每个账号各写各的日志，本来就只含它自己的记录。
  // providerMismatch 只在"客户端还在跑上一个账号"这种过渡期才会出现。
  if (data.providerMismatch) {
    const warn = document.createElement('div');
    warn.className = 'quota-warn';
    warn.textContent = `注意：这份额度记录属于 ${data.providerId}，与当前账号不一致——客户端可能还在跑上一个账号。重启客户端后即会刷新。`;
    grid.appendChild(warn);
  }

  // 当前账号自己的日志里还没有记录时，主进程会退回它自己的旧快照并打上 stale，
  // 这时必须说清楚"这不是实时值"，否则使用者会以为额度真的就是这个数。
  if (data.stale) {
    const warn = document.createElement('div');
    warn.className = 'quota-warn';
    warn.textContent = data.staleReason === 'no-record-for-account'
      ? '下面是该账号上次记录的额度。它自己的日志里还没有新的 billing 记录——启动一次该账号的客户端后会自动刷新。'
      : '下面是该账号上次记录的额度，不是实时值。';
    grid.appendChild(warn);
  }

  if (!data.plans.length) {
    grid.innerHTML += '<div class="quota-empty">客户端还没有返回任何套餐</div>';
    return;
  }

  // 个人套餐的日额度排前面，赠送/活动额度排后面
  const isGift = (p) => p.entitlements.some((e) => e.period === 'one_time');
  const ordered = [...data.plans].sort((a, b) => Number(isGift(a)) - Number(isGift(b)));

  for (const plan of ordered) {
    const gift = isGift(plan);
    const card = document.createElement('div');
    card.className = 'quota-card'
      + (plan.expired ? ' quota-card--dim' : '')
      + (gift ? ' quota-card--gift' : '');
    let badge = 'quota-badge--on';
    let badgeText = '生效中';
    if (plan.expired) { badge = 'quota-badge--off'; badgeText = '已结束'; }
    else if (plan.pending) { badge = 'quota-badge--wait'; badgeText = '待生效'; }

    let items = '';
    for (const b of plan.buckets) {
      items += renderQuotaItem(b.showName, b.totalUnits, b.usedUnits, b.availableUnits, b.period, gift);
    }
    // 有 entitlement 但没有额度桶 → 还没生效，把承诺额度也显示出来
    for (const e of plan.entitlements) {
      if (e.pending) items += renderQuotaItemPending(e.showName, e.grantUnits, e.effectiveAt);
    }
    if (!items) items = '<div class="quota-item__foot">暂无额度明细</div>';

    card.innerHTML = `
      <div class="quota-card__head">
        <span class="quota-card__name">${gift ? '赠送 · ' : ''}${plan.name}</span>
        <span class="quota-badge ${badge}">${badgeText}</span>
      </div>
      <div class="quota-card__time">${quotaDesc(plan, Date.now())}</div>
      ${items}`;
    grid.appendChild(card);
  }
}

async function loadQuota(force = false) {
  try {
    const data = await api.planQuota(force);
    renderQuota(data);
  } catch (e) {
    $('#quota-updated').textContent = '读取失败';
    $('#quota-grid').innerHTML = `<div class="quota-empty">${e.message || e}</div>`;
  }
}

function userPayloadOf(account) {
  return account.user_id ? account.user_id.slice(0, 8) : '--';
}

// 服务端熔断剩余时间：冷却期内不提供任何触发入口，避免反复试探加重限制
let remoteCooldownMs = 0;

function fmtCooldown(ms) {
  const m = Math.ceil(ms / 60000);
  return m >= 60 ? Math.ceil(m / 60) + ' 小时' : m + ' 分钟';
}

function cdKeyOf() {
  return remoteCooldownMs > 0 ? 'cd' + Math.ceil(remoteCooldownMs / 60000) : 'ok';
}

function refreshBtnHtml(a) {
  if (remoteCooldownMs > 0) {
    return `<button class="plan-refresh" disabled title="服务端此前判定异常活动，冷却期内不再发起请求">冷却 ${fmtCooldown(remoteCooldownMs)}</button>`;
  }
  return `<button class="plan-refresh" data-act="plan-remote" data-id="${a.id}" title="用该账号自己的凭据联网获取套餐">联网刷新</button>`;
}

async function refreshRemoteState() {
  try {
    const s = await api.planState();
    remoteCooldownMs = (s && s.cooldownMs) || 0;
  } catch {
    remoteCooldownMs = 0;
  }
}

// 账号卡片里的套餐简略区：数据来自该账号最近一次被读取到的 billing 快照
// 横向排布，整条只占一行高度
function planRows(a) {
  const s = a.plan_summary;
  const refreshBtn = refreshBtnHtml(a);
  if (!s || !Array.isArray(s.items) || !s.items.length) {
    return `<div class="card__plan card__plan--empty" data-at="" data-cd="${cdKeyOf()}">
      <span class="plan-empty__title">套餐未获取</span>
      <span class="plan-empty__hint">用该账号凭据直接查询，或切换登录一次后自动同步</span>
      ${refreshBtn}
    </div>`;
  }
  const show = s.items.slice(0, 3);
  const chips = show.map((it) => {
    // unknown：只有套餐承诺额、没有真实用量数据（接口这次没返回 balances）。
    // 这时不能把 grant 当成「还剩这么多」显示——会直接误导。
    const cls = it.pending ? ' plan-chip--pending'
      : (it.unknown ? ' plan-chip--pending' : (it.gift ? ' plan-chip--gift' : ''));
    const num = it.pending
      ? `${fmtTokens(it.total)} 待生效`
      : (it.unknown ? '用量未知' : `${fmtTokens(it.left)}/${fmtTokens(it.total)}`);
    const tip = it.unknown ? `${it.plan}（接口未返回用量，仅知承诺额度 ${fmtTokens(it.total)}）` : it.plan;
    return `<span class="plan-chip${cls}" title="${tip}"><span class="plan-chip__n">${it.name}</span><span class="plan-chip__v">${num}</span></span>`;
  }).join('');
  const more = s.items.length > show.length
    ? `<span class="plan-chip plan-chip--more">+${s.items.length - show.length}</span>`
    : '';
  return `<div class="card__plan" data-at="${s.captured_at || ''}" data-cd="${cdKeyOf()}">
    <span class="plan-tag">套餐<span class="plan-src${s.source === 'server' ? ' plan-src--net' : ''}">${s.source === 'server' ? '联网' : '本机'}</span></span>
    ${chips}${more}
    <span class="plan-age">${fmtAgo(s.captured_at)}</span>
    ${refreshBtn}
  </div>`;
}

// 只替换卡片里的套餐区，不重建卡片，避免动画重放
async function refreshAccountPlans() {
  await refreshRemoteState();
  let list;
  try {
    list = await api.listAccounts();
  } catch {
    return;
  }
  const cdKey = cdKeyOf();
  const map = new Map(list.map((a) => [a.id, a]));
  for (const card of document.querySelectorAll('#account-grid .card[data-id]')) {
    const id = card.dataset.id;
    const host = card.querySelector('.card__plan');
    if (!host) continue;
    const at = (map.get(id) && map.get(id).plan_summary && map.get(id).plan_summary.captured_at) || '';
    if (host.dataset.at === at && host.dataset.cd === cdKey) continue;
    host.outerHTML = planRows(map.get(id) || {});
  }
  accounts = accounts.map((a) => (map.has(a.id) ? { ...a, plan_summary: map.get(a.id).plan_summary } : a));
}

async function renderGrid() {
  const grid = $('#account-grid');
  grid.innerHTML = '';
  if (accounts.length === 0) {
    grid.innerHTML = '<div class="card card--row card--blank">还没有账号快照，登录后点击「捕获当前登录」</div>';
    return;
  }
  accounts.forEach((a, i) => {
    const card = document.createElement('div');
    const active = a.is_current || (current && a.user_id === current.user_id);
    card.className = 'card card--row' + (active ? ' card--current' : '');
    card.dataset.id = a.id;
    card.style.animationDelay = `${i * 0.04}s`;
    card.innerHTML = `
      <div class="card__ident">
        <div class="card__name" title="${a.id}">${a.id}</div>
        <div class="card__badge ${active ? 'active' : 'inactive'}">${active ? '当前' : '未激活'}</div>
      </div>
      <div class="card__body">
        <div class="card__meta">
          <span class="meta-item"><span class="meta-item__k">注册${a.registered_at_source === 'platform' ? '<i class="dot dot--ok" title="平台时间"></i>' : (a.registered_at_source === 'capture' ? '<i class="dot dot--warn" title="本地捕获时间"></i>' : '')}</span><span class="meta-item__v">${fmtDateShort(a.registered_at)}</span></span>
          <span class="meta-item"><span class="meta-item__k">年龄</span><span class="meta-item__v${a.age_days !== null && a.age_days < FRESH_LIMIT_DAYS ? ' warn-text' : ''}">${a.age_days === null ? '未知' : a.age_days + ' 天'}</span></span>
          <span class="meta-item"><span class="meta-item__k">录入</span><span class="meta-item__v">${fmtDateShort(a.captured_at)}</span></span>
          <span class="meta-item"><span class="meta-item__k">最近</span><span class="meta-item__v">${fmtAgo(a.last_used_at)}</span></span>
          <span class="meta-item"><span class="meta-item__k">切换</span><span class="meta-item__v">${a.switch_count} 次</span></span>
        </div>
        ${planRows(a)}
      </div>
      <div class="card__actions">
        <button class="btn btn--primary btn--sm" data-act="switch" data-id="${a.id}">切换</button>
        <button class="btn btn--danger btn--sm" data-act="delete" data-id="${a.id}">删除</button>
      </div>`;
    grid.appendChild(card);
  });
}

function setLoading(btn, on) {
  if (!btn) return;
  if (on) {
    btn.classList.add('loading');
    btn.disabled = true;
    btn.setAttribute('aria-busy', 'true');
  } else {
    btn.classList.remove('loading');
    btn.disabled = false;
    btn.removeAttribute('aria-busy');
  }
}

async function refresh() {
  $('.sync-state') && ($('.sync-state').textContent = '同步中…');
  await refreshRemoteState();
  accounts = await api.listAccounts();
  const cur = await api.currentUser();
  if (cur && cur.user_id) {
    // 把当前登录 uid 关联回快照（jwt 解码在 main 侧完成，这里靠 server 补充 uid 到快照）
    accounts = accounts.map((a) => ({ ...a }));
  }
  await loadCurrent();
  await loadQuota();
  renderGrid();
  $('.sync-state') && ($('.sync-state').textContent = '已同步');
}

function openCapture() {
  $('#capture-modal').classList.remove('hidden');
  $('#capture-name').value = '';
  $('#capture-name').focus();
}

async function confirmCapture() {
  const name = $('#capture-name').value.trim();
  if (!name) { toast('请输入账号名称', false); return; }
  const replace = $('#capture-replace').checked;
  closeCapture();
  const res = await api.capture(name, replace);
  toast(res.msg, res.ok);
  await refresh();
}

function closeCapture() {
  $('#capture-modal').classList.add('hidden');
}

async function doSwitch(id) {
  const btn = document.querySelector(`[data-act="switch"][data-id="${id}"]`);
  const isFresh = accounts.find((a) => a.id === id && a.age_days !== null && a.age_days < FRESH_LIMIT_DAYS);
  if (isFresh && !confirm(`账号 ${id} 不足 1 天，仍要切换吗？`)) return;
  setLoading(btn, true);
  // 新架构下切换 = 启动该账号自己的数据目录，不再有"回写旧账号"这一步：
  // 客户端直接读写它自己的文件，没有会被覆盖的中间态。
  const res = await api.switchTo(id, {});
  setLoading(btn, false);
  toast(res.msg, res.ok);
  await refresh();
}

async function doDelete(id) {
  const res = await api.remove(id);
  toast(res.msg, res.ok);
  await refresh();
}

// 用该账号自己的 JWT 直接向服务端查套餐（不需要本机登录过客户端）
async function doPlanRemote(id, btn) {
  if (btn) {
    btn.disabled = true;
    btn.textContent = '查询中…';
  }
  const restore = () => {
    if (btn && btn.isConnected) {
      btn.disabled = false;
      btn.textContent = '联网刷新';
    }
  };
  try {
    const r = await api.planRemote(id);
    if (r && r.ok) {
      toast(`已获取 ${id} 的套餐`, true);
      await refreshAccountPlans();
      return;
    }
    await refreshRemoteState();
    toast((r && r.msg) || '获取失败', false, 4600);
    if (remoteCooldownMs > 0) {
      // 已熔断：立刻把按钮换成冷却态，避免继续点
      await refreshAccountPlans();
      return;
    }
  } catch (e) {
    toast('获取失败：' + (e.message || e), false, 4600);
  }
  restore();
}

async function doRollback() {
  const res = await api.rollback();
  toast(res.msg, res.ok);
  await refresh();
}

async function doCalibrate() {
  const btn = $('#btn-calibrate');
  setLoading(btn, true);
  try {
    const res = await api.calibrate();
    toast(res.msg || '校准完成', !!(res && res.ok), 4200);
    await refresh();
  } catch (e) {
    toast('校准失败：' + (e.message || e), false);
  } finally {
    setLoading(btn, false);
  }
}

function setOAuthBusy(on, which) {
  const btn = $(which === 'zai' ? '#btn-oauth-zai' : '#btn-oauth');
  setLoading(btn, on);
}

// 授权成功后的收尾：账号已经落成快照（未切换），刷新列表即可
function afterOAuthSuccess(res) {
  const u = res.user || {};
  const label = (res.account && res.account.name) || u.displayName || u.username || res.provider || 'acct';
  const pname = res.provider === 'bigmodel' ? 'BigModel' : 'Z.ai';
  if (res.switched) {
    toast(`${pname} 导入成功：${label}`, true);
  } else {
    toast(`${pname} 已添加 ${label}，未切换；需要时在列表里点「切换」`, true);
  }
  refresh();
  // 授权跑完，分区里就留下这个账号的 bigmodel.cn 登录态了，状态条要跟着更新
  renderSession({ silent: true });
}

// 出口地区检测。放在弹窗里而不是只写在说明里，是因为「我开了加速器」
// 和「这扇 Electron 窗口真的走出去了」是两件事——PAC/规则模式下窗口是直连的。
let zaiProbeBusy = false;
// null = 还没测出来 / 检测中。只有明确测到境外才放行，其余一律再问一次。
let zaiEgressDomestic = null;

function setProbeLine(kind, text) {
  const line = $('#zai-probe');
  const txt = $('#zai-probe-text');
  if (line) line.className = 'probe-line' + (kind ? ' probe-line--' + kind : '');
  if (txt) txt.textContent = text;
}

async function probeZaiEgress() {
  if (zaiProbeBusy) return;
  zaiProbeBusy = true;
  zaiEgressDomestic = null;
  setProbeLine('busy', '正在检测这扇窗口的实际出口…');
  try {
    const r = await api.oauthProbeRegion('zai');
    if (!r || !r.ok) {
      setProbeLine('warn', `检测不到（${(r && r.msg) || '未知'}）。多半是没走代理——请把加速器切到全局模式`);
      return;
    }
    const where = `${r.country}${r.ip ? ' · ' + r.ip : ''}`;
    zaiEgressDomestic = !!r.domestic;
    if (r.domestic) setProbeLine('bad', `出口 ${where} —— 还是直连，全局模式没生效或节点不在境外`);
    else setProbeLine('ok', `出口 ${where} —— 线路在境外，可以注册纯 Z.ai 账号`);
  } catch (e) {
    setProbeLine('warn', '检测异常：' + ((e && e.message) || '未知'));
  } finally {
    zaiProbeBusy = false;
  }
}

async function openZaiModal() {
  $('#zai-modal').classList.remove('hidden');
  await probeZaiEgress();
}

function closeZaiModal() {
  $('#zai-modal').classList.add('hidden');
}

/**
 * 出口还在国内时拦一次。
 *
 * 不是禁止——万一你的代理只在浏览器里生效，仍可能想试。但必须先告诉你：
 * 这一步走错要白费一次人机验证和一个邮箱，最后只换来一个要补绑 BigModel 的账号。
 */
function continueZaiAfterProbe() {
  if (zaiEgressDomestic !== false) {
    const reason = zaiEgressDomestic === true
      ? '检测到当前出口还在国内。'
      : '还没测出出口地区。';
    if (!confirm(`${reason}继续的话，注册大概率拿不到国际版 Z.ai 账号，可能要额外补绑 BigModel。\n\n仍要继续？`)) return;
  }
  closeZaiModal();
  doOAuth('zai');
}

async function doOAuth(which) {
  setOAuthBusy(true, which);
  try {
    const res = await api.oauthStart(which, 'bridge', {});
    if (!res || !res.ok) {
      toast(res && res.msg ? res.msg : 'OAuth 登录失败', false);
      return;
    }
    afterOAuthSuccess(res);
  } catch (e) {
    const msg = String(e && e.message ? e.message : e);
    if (msg.includes('window_closed') || msg.includes('登录窗口已关闭')) {
      toast('已取消登录', false);
    } else {
      toast('OAuth 登录失败：' + msg, false);
    }
  } finally {
    setOAuthBusy(false, which);
  }
}

function setLinkBusy(on) {
  setLoading($('#link-submit'), on);
}

function openLinkModal() {
  $('#link-modal').classList.remove('hidden');
  $('#link-code').value = '';
  $('#link-url').value = '';
  // 直接生成一条可直接在浏览器打开的链接
  api.oauthLink('bigmodel', 'direct').then((res) => {
    if (res && res.ok) {
      $('#link-url').value = res.url;
      $('#link-url').dataset.state = res.state;
    }
  });
}

function closeLinkModal() {
  $('#link-modal').classList.add('hidden');
}

async function copyLink() {
  const val = $('#link-url').value;
  if (!val) { toast('请先生成授权链接', false); return; }
  try {
    await navigator.clipboard.writeText(val);
    toast('授权链接已复制', true);
  } catch (_) {
    $('#link-url').select();
    toast('已选中，请按 Ctrl+C 复制', true);
  }
}

async function openLinkExternal() {
  const val = $('#link-url').value;
  if (!val) { toast('请先生成授权链接', false); return; }
  // 交给系统默认浏览器（已是 bigmodel 登录态）
  window.open(val, '_blank');
}

async function submitLink() {
  const input = $('#link-code').value.trim();
  if (!input) { toast('请粘贴回跳地址或授权码', false); return; }
  setLinkBusy(true);
  try {
    const res = await api.oauthSubmit(input);
    if (!res || !res.ok) {
      toast(res && res.msg ? res.msg : '导入失败', false);
      return;
    }
    closeLinkModal();
    afterOAuthSuccess(res);
  } catch (e) {
    toast('导入失败：' + (e.message || e), false);
  } finally {
    setLinkBusy(false);
  }
}

// 容错绑定：某个元素缺失时只告警，不影响其余监听器
function on(selector, event, handler) {
  const el = document.querySelector(selector);
  if (!el) {
    console.warn('[panel] 缺少元素，已跳过绑定:', selector);
    return null;
  }
  el.addEventListener(event, handler);
  return el;
}

// ===== 自动化日志 =====
const driverLog = [];
const LOG_MAX = 40;

// 人机验证是整条流程里唯一必须人工的环节，单独拉一条醒目的提示出来。
// 只丢在日志流里的话，一屏日志刷过去人根本注意不到，会一直干等。
function setManualPrompt(msg, active) {
  const strip = $('#manual-strip');
  const text = $('#manual-msg');
  if (!strip) return;
  if (!active || !msg) {
    strip.classList.add('hidden');
    if (text) text.textContent = '';
    return;
  }
  if (text) text.textContent = msg;
  strip.classList.remove('hidden');
}

function renderDriverLog() {
  const box = $('#driver-log');
  if (!box) return;
  if (!driverLog.length) {
    box.innerHTML = '<div class="driver-log__empty">点「BigModel 网页登录」或「Z.ai 邮箱注册」后，流程会在这里逐步显示</div>';
    return;
  }
  box.innerHTML = driverLog
    .slice(-LOG_MAX)
    .map((e) => `<div class="driver-log__row driver-log__row--${e.level}"><span class="driver-log__t">${e.time}</span><span class="driver-log__m">${escapeHtml(e.msg)}</span></div>`)
    .join('');
  box.scrollTop = box.scrollHeight;
}

function pushDriverLog(ev) {
  if (!ev || ev.level === 'phase') return;
  // 手工提示走独立的提示条，同时也在日志里留一行，方便事后回看当时轮到谁操作
  if (ev.manual) setManualPrompt(ev.msg, ev.active !== false);
  if (!ev.msg) return;
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  driverLog.push({ time: `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`, level: ev.level || 'info', msg: ev.msg });
  if (driverLog.length > LOG_MAX * 2) driverLog.splice(0, driverLog.length - LOG_MAX);
  renderDriverLog();
}

// ---------------------------------------------------------------- ZCode 代理

/**
 * 显示/设置 ZCode 自己的代理。
 *
 * 面板这扇窗口走 Chromium 默认（跟随系统代理），但 ZCode 会给它的主会话
 * 下发 setProxy({mode:"direct"})，主动绕过系统代理——加速器开着也没用。
 * 只有把代理写进 ZCode 的 setting.json，它才真的走。
 */
async function loadZcodeProxy({ silent = false } = {}) {
  const state = $('#proxy-state');
  try {
    const r = await api.proxyGet();
    if (!r || !r.ok) {
      if (state) { state.textContent = '读取失败'; state.className = 'proxy-state proxy-state--bad'; }
      return null;
    }
    if (state) {
      if (r.current) {
        // 系统代理换了端口（换了加速器/改了设置）时，ZCode 还停在旧值上，
        // 这种情况不说出来，会表现为「代理明明开着但 ZCode 还是走直连」。
        const stale = r.system && r.system !== r.current;
        state.textContent = stale
          ? `${r.current}（系统代理已是 ${r.system}，点右边更新）`
          : r.current;
        state.className = 'proxy-state ' + (stale ? 'proxy-state--off' : 'proxy-state--on');
        state.title = stale
          ? `ZCode 还在用 ${r.current}，但系统代理现在是 ${r.system}。点「用系统代理」同步，然后重启 ZCode。`
          : `ZCode 已配置走 ${r.current}；重启 ZCode 后生效`;
      } else {
        state.textContent = r.system
          ? `直连中（系统代理是 ${r.system}，ZCode 没用）`
          : '直连中（未检测到系统代理）';
        state.className = 'proxy-state proxy-state--off';
        state.title = 'ZCode 默认给主会话下发 direct，会主动绕过系统代理。点「用系统代理」写进它的配置。';
      }
    }
    return r;
  } catch (e) {
    if (state) { state.textContent = '读取异常：' + ((e && e.message) || '未知'); state.className = 'proxy-state proxy-state--bad'; }
    if (!silent) toast('读取 ZCode 代理失败', false, 2600);
    return null;
  }
}

async function doProxyAuto() {
  const btn = $('#btn-proxy-auto');
  setLoading(btn, true);
  try {
    const info = await api.proxyGet();
    const url = info && info.system;
    if (!url) {
      toast('没读到系统代理：请先打开加速器并开启系统代理（或全局模式）', false, 3600);
      return;
    }
    const r = await api.proxySet(url);
    if (!r || !r.ok) { toast('写入失败：' + ((r && r.msg) || '未知'), false, 3200); return; }
    toast(`已让 ZCode 走 ${url}；重启 ZCode 生效`, true, 3600);
    await loadZcodeProxy({ silent: true });
  } finally {
    setLoading(btn, false);
  }
}

async function doProxyClear() {
  const r = await api.proxySet('');
  if (!r || !r.ok) { toast('清除失败：' + ((r && r.msg) || '未知'), false, 3200); return; }
  toast('已清除 ZCode 代理配置，恢复直连', true, 2600);
  await loadZcodeProxy({ silent: true });
}

// 转圈至少显示这么久。请求几十毫秒就回来时，圈一闪而过反而显得界面在抖。
const MIN_SPIN_MS = 380;

/**
 * 把授权会话状态格式化成展示文案。
 * 提成纯函数是为了能单独验证分支——真实分区没法轻易造出「脏」的状态。
 */
function formatSessionText(s) {
  const bm = (s && s.bigmodel && s.bigmodel.cookieCount) || 0;
  const zai = (s && s.zai && s.zai.cookieCount) || 0;
  if (bm === 0 && zai === 0) {
    return { text: '干净 · 授权时会用新登录态', dirty: false };
  }
  const parts = [];
  if (bm) parts.push(`BigModel ${bm} 条`);
  if (zai) parts.push(`Z.ai ${zai} 条`);
  return { text: `残留 ${parts.join(' · ')}，授权前会自动清`, dirty: true };
}

/**
 * 授权会话状态。
 *
 * 面板的授权窗口共用一个浏览器分区，绑完一个账号后 bigmodel.cn 的登录态
 * 会留在里面，下次授权就会绑到上一个 BigModel 账号上——套餐只发一次，
 * 新号等于白注册。这里把「残留了没有」摆出来，让使用者一眼能看到。
 */
async function renderSession({ silent = false } = {}) {
  const host = $('#sess-info');
  if (!host) return;
  try {
    const s = await api.oauthSessionStatus();
    if (!s || !s.ok) {
      host.textContent = '状态不可用';
      host.className = 'sess-info sess-info--dirty';
      return;
    }
    const f = formatSessionText(s);
    host.textContent = f.text;
    host.className = f.dirty ? 'sess-info sess-info--dirty' : 'sess-info';
  } catch (e) {
    host.textContent = '状态读取失败';
    host.className = 'sess-info sess-info--dirty';
    if (!silent) toast('读取授权会话状态失败：' + ((e && e.message) || '未知'), false, 3000);
  }
}

async function doResetSession() {
  const btn = $('#btn-sess-reset');
  const started = Date.now();
  setLoading(btn, true);
  try {
    const a = await api.oauthResetSession('bigmodel');
    const b = await api.oauthResetSession('zai');
    const n = ((a && a.after) || 0) + ((b && b.after) || 0);
    await renderSession({ silent: true });
    toast(n === 0 ? '授权会话已清空' : `仍有 ${n} 条未清掉`, n === 0, 1800);
  } catch (e) {
    toast('清空失败：' + ((e && e.message) || '未知'), false, 3000);
  } finally {
    const rest = MIN_SPIN_MS - (Date.now() - started);
    if (rest > 0) await new Promise((res) => setTimeout(res, rest));
    setLoading(btn, false);
  }
}

// ---------------------------------------------------------------- 设置页
// ZCode 客户端的位置因机器而异：盘符、用户名、安装目录都可能不一样。
// 主进程会多源自动探测，探测不到就得靠这一页手动指定——所以它要能独立完成配置，
// 不能让使用者卡在"找不到程序又不知道去哪填"上。

let settingsSnap = null;
let detectedExe = '';

const SOURCE_LABEL = {
  settings: '来自设置',
  env: '来自 ZCODE_EXE 环境变量',
  detect: '来自自动检测',
  common: '来自常见安装路径',
  guess: '按常见路径推测（未确认）',
};

function setChip(el, level, text) {
  if (!el) return;
  el.className = 'status-chip status-chip--' + level;
  el.textContent = text;
}

function chipLevel(st) {
  if (!st || !st.ok) return 'bad';
  return st.level === 'good' ? 'ok' : 'warn';
}

function chipText(st) {
  if (!st || !st.ok) return '不可用';
  return st.level === 'good' ? '可用' : '可能不对';
}

function paintExeStatus(st, effective, source) {
  setChip($('#exe-status'), chipLevel(st), chipText(st));
  const hint = $('#exe-hint');
  if (!hint) return;
  const src = source ? `　（${SOURCE_LABEL[source] || source}）` : '';
  hint.textContent = st && st.ok
    ? `${st.msg}${effective ? '　生效：' + effective : ''}${src}`
    : `${(st && st.msg) || '未指定'}${effective ? '　当前生效：' + effective : ''}${src}`;
  hint.className = 'field__hint' + (st && st.ok ? '' : ' field__hint--bad');
}

function renderSettings(snap) {
  if (!snap) return;
  settingsSnap = snap;

  const saved = snap.exe.saved || '';
  const exeInput = $('#set-exe');
  if (exeInput && document.activeElement !== exeInput) exeInput.value = saved;

  const accInput = $('#set-accounts');
  if (accInput && document.activeElement !== accInput) accInput.value = snap.accounts.saved || '';

  const fileInput = $('#set-file');
  if (fileInput) fileInput.value = snap.file || '';

  // 输入框里已经有内容就按它显示，否则按当前生效值显示
  if (saved) paintExeStatus(snap.exe.status, snap.exe.effective, snap.exe.source);
  else paintExeStatus(snap.exe.status, snap.exe.effective, snap.exe.source);

  const accHint = $('#acc-hint');
  if (accHint) {
    accHint.textContent = snap.accounts.saved
      ? `生效目录：${snap.accounts.effective}`
      : `未自定义，使用面板目录下的位置：${snap.accounts.effective}`;
  }
}

function renderDetectLog(d) {
  const box = $('#detect-log');
  if (!box) return;
  if (!d) { box.classList.add('hidden'); box.innerHTML = ''; return; }
  const tried = d.tried || [];
  const missCount = tried.filter((t) => !t.ok).length;
  const head = d.ok
    ? `已找到：${d.exe}　（${d.source}）`
    : (d.msg || '没找到 ZCode.exe');
  const sub = d.ok
    ? (missCount ? `另有 ${missCount} 个位置没有命中，已忽略。` : '')
    : (missCount ? `已检查 ${missCount} 个位置：注册表 zcode:// 协议、卸载项、常见安装目录、正在运行的 ZCode 进程。` : '');
  box.className = 'detect-log';
  box.innerHTML =
    `<div class="detect-log__head">${escapeHtml(head)}</div>` +
    (sub ? `<div class="detect-log__sub">${escapeHtml(sub)}</div>` : '');
}

async function openSettings(auto = false) {
  const modal = $('#settings-modal');
  if (modal) modal.classList.remove('hidden');
  const warn = $('#setup-warn');
  if (warn) warn.classList.toggle('hidden', !auto);
  try {
    const snap = await api.settingsGet();
    renderSettings(snap);
    // 启动自检跑过的探测结果直接拿来用，不必让使用者再点一次「自动检测」
    if (snap.detected) {
      renderDetectLog(snap.detected);
      if (snap.detected.exe) detectedExe = snap.detected.exe;
    } else {
      renderDetectLog(null);
    }
  } catch (e) {
    toast('读取设置失败：' + ((e && e.message) || '未知'), false, 3200);
  }
}

function closeSettings() {
  const modal = $('#settings-modal');
  if (modal) modal.classList.add('hidden');
  const warn = $('#setup-warn');
  if (warn) warn.classList.add('hidden');
  const log = $('#detect-log');
  if (log) { log.classList.add('hidden'); log.innerHTML = ''; }
}

async function doSettingsDetect() {
  const btn = $('#set-exe-detect');
  setLoading(btn, true);
  try {
    const snap = await api.settingsDetect();
    detectedExe = (snap.detect && snap.detect.exe) || '';
    renderSettings(snap);
    renderDetectLog(snap.detect);
    if (snap.detect && snap.detect.ok) {
      const input = $('#set-exe');
      if (input && !input.value.trim()) input.value = detectedExe;
      toast('已找到 ZCode：' + detectedExe, true, 3600);
    } else {
      toast('自动检测没找到 ZCode，请手动指定 ZCode.exe 的完整路径', false, 4600);
    }
  } catch (e) {
    toast('检测失败：' + ((e && e.message) || '未知'), false, 3200);
  } finally {
    setLoading(btn, false);
  }
}

async function doSettingsApplyDetected() {
  if (!detectedExe) { toast('还没有检测结果，先点「自动检测」', false, 2600); return; }
  const input = $('#set-exe');
  if (input) input.value = detectedExe;
  await verifyExeInput();
  toast('已填入检测到的路径，点「保存」生效', true, 2800);
}

async function verifyExeInput() {
  const input = $('#set-exe');
  const v = input ? input.value.trim() : '';
  if (!v) { setChip($('#exe-status'), 'idle', '未指定'); return; }
  try {
    const st = await api.settingsVerify(v);
    paintExeStatus(st, '', '');
  } catch (_) {}
}

async function doSettingsPickExe() {
  const r = await api.settingsPickExe().catch(() => null);
  if (!r || !r.ok) return;
  const input = $('#set-exe');
  if (input) input.value = r.path;
  paintExeStatus(r.status, '', '');
}

async function doSettingsPickDir() {
  const r = await api.settingsPickDir().catch(() => null);
  if (!r || !r.ok) return;
  const input = $('#set-accounts');
  if (input) input.value = r.path;
}

async function doSettingsSave() {
  const btn = $('#set-save');
  const exe = (($('#set-exe') || {}).value || '').trim();
  const acc = (($('#set-accounts') || {}).value || '').trim();
  const prevAcc = (settingsSnap && settingsSnap.accounts && settingsSnap.accounts.effective) || '';
  setLoading(btn, true);
  try {
    const r = await api.settingsSave({ zcodeExe: exe, accountsDir: acc });
    if (!r || !r.ok) { toast((r && r.msg) || '保存失败', false, 3600); return; }
    const snap = r.snapshot || {};
    renderSettings(snap);
    const st = (snap.exe || {}).status || {};

    if (exe && !st.ok) {
      // 存下来了但用不了，得说清楚——不关窗，让人当场改
      toast('已保存，但这个路径用不了：' + (st.msg || ''), false, 5000);
      return;
    }

    const nextAcc = (snap.accounts || {}).effective || '';
    const accChanged = nextAcc && prevAcc && nextAcc !== prevAcc;
    closeSettings();
    refresh();

    if (!exe) toast('已保存。没指定 ZCode 主程序，切换账号仍然会失败', false, 4600);
    else if (accChanged) toast('设置已保存。账号数据目录换了，原有账号文件不会自动搬过去', false, 5200);
    else toast('设置已保存', true, 2200);
  } catch (e) {
    toast('保存失败：' + ((e && e.message) || '未知'), false, 3200);
  } finally {
    setLoading(btn, false);
  }
}

// ---------------------------------------------------------------- 输入弹窗
// 手机号 / 短信验证码 / 邮箱 / 激活链接都由使用者在这里手填。
// 主进程那边正挂着等这个答案，提交或取消都会立刻解挂。
let pendingAskId = null;

function openAskModal(req) {
  if (!req) return;
  pendingAskId = req.id || null;
  const modal = $('#ask-modal');
  const label = $('#ask-label');
  const hint = $('#ask-hint');
  const input = $('#ask-input');
  if (label) label.textContent = req.label || '请输入';
  if (hint) {
    hint.textContent = req.hint || '';
    hint.classList.toggle('hidden', !req.hint);
  }
  if (input) {
    input.value = '';
    input.placeholder = req.placeholder || '';
    const numeric = req.kind === 'phone' || req.kind === 'code';
    input.setAttribute('inputmode', numeric ? 'numeric' : 'text');
    input.setAttribute('autocomplete', req.kind === 'code' ? 'one-time-code' : 'off');
  }
  if (modal) modal.classList.remove('hidden');
  setTimeout(() => { if (input) input.focus(); }, 30);
}

function closeAskModalSilently(payload) {
  pendingAskId = null;
  const modal = $('#ask-modal');
  if (modal) modal.classList.add('hidden');
  if (payload && payload.reason) toast(payload.reason, false, 2600);
}

async function submitAsk() {
  const input = $('#ask-input');
  const v = input ? input.value.trim() : '';
  if (!v) { toast('请先填写内容', false, 1800); return; }
  const id = pendingAskId;
  pendingAskId = null;
  const modal = $('#ask-modal');
  if (modal) modal.classList.add('hidden');
  if (typeof api.panelAnswer === 'function') await api.panelAnswer(id, v);
}

async function abortAsk() {
  const id = pendingAskId;
  pendingAskId = null;
  const modal = $('#ask-modal');
  if (modal) modal.classList.add('hidden');
  if (typeof api.panelAskAbort === 'function') await api.panelAskAbort(id);
}

function initPanel() {
  renderDriverLog();
  if (typeof api.onPanelEvent === 'function') api.onPanelEvent((ev) => pushDriverLog(ev));
  if (typeof api.onPanelAsk === 'function') api.onPanelAsk((req) => openAskModal(req));
  if (typeof api.onPanelAskCancel === 'function') api.onPanelAskCancel((p) => closeAskModalSilently(p));
  // 主进程自检发现 ZCode 客户端不可用时，直接把设置页推到使用者面前
  if (typeof api.onNeedSetup === 'function') {
    api.onNeedSetup((snap) => {
      settingsSnap = snap;
      openSettings(true);
    });
  }
  renderSession({ silent: true });
  loadZcodeProxy({ silent: true });
}

function bindEvents() {
  on('#btn-oauth', 'click', () => doOAuth('bigmodel'));
  // Z.ai 那条线必须先连上国际版，否则注册不出纯 Z.ai 账号——用弹窗说清楚，
  // 而不是等流程跑到「切注册表单」失败再让人猜原因。
  on('#btn-oauth-zai', 'click', openZaiModal);
  on('#zai-cancel', 'click', closeZaiModal);
  on('#zai-continue', 'click', continueZaiAfterProbe);
  on('#zai-probe-again', 'click', probeZaiEgress);
  on('#zai-modal', 'click', (e) => {
    if (e.target === $('#zai-modal')) closeZaiModal();
  });
  on('#btn-sess-reset', 'click', () => doResetSession());
  on('#btn-proxy-auto', 'click', doProxyAuto);
  on('#btn-proxy-clear', 'click', doProxyClear);
  // 输入弹窗（手机号 / 短信验证码 / 邮箱 / 激活链接）
  on('#ask-submit', 'click', () => submitAsk());
  on('#ask-cancel', 'click', () => abortAsk());
  on('#ask-modal', 'click', (e) => {
    if (e.target === $('#ask-modal')) abortAsk();
  });
  on('#ask-input', 'keydown', (e) => {
    if (e.key === 'Enter') submitAsk();
  });
  on('#btn-driver-log-clear', 'click', () => {
    // 清空的只是下面那份流程记录，不动账号
    if (!driverLog.length) {
      toast('暂无记录', true, 1200);
      return;
    }
    const n = driverLog.length;
    driverLog.length = 0;
    renderDriverLog();
    toast(`已清空 ${n} 条记录`, true, 1400);
  });
  on('#btn-oauth-link', 'click', openLinkModal);
  on('#link-copy', 'click', copyLink);
  on('#link-open', 'click', openLinkExternal);
  on('#link-cancel', 'click', closeLinkModal);
  on('#link-submit', 'click', submitLink);
  on('#link-modal', 'click', (e) => {
    if (e.target === $('#link-modal')) closeLinkModal();
  });
  on('#link-code', 'keydown', (e) => {
    if (e.key === 'Enter') submitLink();
  });
  on('#btn-quota-refresh', 'click', () => doQuotaRefresh());
  on('#btn-refresh', 'click', refresh);
  on('#btn-settings', 'click', () => openSettings(false));
  on('#set-close', 'click', closeSettings);
  on('#set-save', 'click', doSettingsSave);
  on('#set-exe-pick', 'click', doSettingsPickExe);
  on('#set-exe-detect', 'click', doSettingsDetect);
  on('#set-exe-apply', 'click', doSettingsApplyDetected);
  on('#set-acc-pick', 'click', doSettingsPickDir);
  on('#set-acc-default', 'click', () => {
    const i = $('#set-accounts');
    if (i) i.value = '';
    toast('已清空，保存后回到默认目录', true, 2400);
  });
  on('#set-open-folder', 'click', async () => {
    const r = await api.settingsOpenFolder('config').catch(() => null);
    if (r && !r.ok) toast('打开目录失败：' + ((r && r.msg) || '未知'), false, 3000);
  });
  on('#settings-modal', 'click', (e) => {
    if (e.target === $('#settings-modal')) closeSettings();
  });
  on('#set-exe', 'change', verifyExeInput);
  on('#set-exe', 'blur', verifyExeInput);
  on('#btn-capture', 'click', openCapture);
  on('#btn-calibrate', 'click', doCalibrate);
  on('#btn-rollback', 'click', doRollback);
  on('#capture-ok', 'click', confirmCapture);
  on('#capture-cancel', 'click', closeCapture);
  on('#capture-modal', 'click', (e) => {
    if (e.target === $('#capture-modal')) closeCapture();
  });
  on('#capture-name', 'keydown', (e) => {
    if (e.key === 'Enter') confirmCapture();
  });
  document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-act]');
    if (!el) return;
    const act = el.dataset.act;
    const id = el.dataset.id;
    if (act === 'switch') doSwitch(id);
    if (act === 'delete') doDelete(id);
    if (act === 'plan-remote') doPlanRemote(id, el);
  });

  // 大按钮的点击涟漪：把光标位置写进 CSS 变量
  document.addEventListener('pointerdown', (e) => {
    const btn = e.target.closest('.btn--lg');
    if (!btn) return;
    const r = btn.getBoundingClientRect();
    btn.style.setProperty('--rx', `${((e.clientX - r.left) / r.width) * 100}%`);
    btn.style.setProperty('--ry', `${((e.clientY - r.top) / r.height) * 100}%`);
  });
}

bindEvents();
initPanel();
refresh();

// 套餐额度跟随客户端日志自动刷新（主进程按日志 mtime 缓存，未更新时开销极小）
setInterval(() => {
  loadQuota();
}, 30000);

// 账号卡片的套餐快照变化较慢，低频更新即可
setInterval(() => {
  refreshAccountPlans();
}, 60000);
