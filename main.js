'use strict';

const { app, BrowserWindow, ipcMain, dialog, protocol, session, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const crypto = require('crypto');
const { execFile, exec, spawn } = require('child_process');
const oauth = require('./oauth');
const balance = require('./balance');
const plan = require('./plan');
const remotePlan = require('./remote-plan');
const { LoginDriver, ZaiMailDriver } = require('./login-driver');
const settings = require('./settings');

const HOME = os.homedir();

// 老架构里的全局 ZCode 数据目录。现在有两处用途：
//   ① 把使用者的旧登录态迁移进来；
//   ② 把「项目 / 会话 / 插件」这些属于使用者本人的目录联接给各账号共用。
const LEGACY_ZCODE_ROOT = path.join(HOME, '.zcode');
const LEGACY_ZCODE_V2 = path.join(LEGACY_ZCODE_ROOT, 'v2');

// ZCode 客户端的位置和账号库都由 settings 模块决定：先自动多源探测，找不到就让
// 使用者在设置页手动指定。不同机器上盘符、用户名、安装目录都不一样，不能写死。
// 账号库优先级：设置页指定 > ZPANEL_ACCOUNTS_DIR 环境变量 > 面板目录下的 accounts/。
const accountsDir = () => settings.accountsDir();
const zcodeExe = () => settings.currentExe().path;

// ===== 每个账号一个独立的 ZCode 数据根 =====
//
// ZCode 读 ZCODE_DATA_BASE_DIR，并在它下面再建 .zcode/v2/ 存放凭据、配置、日志。
// 把它按账号分开之后：
//   - 切换账号 = 启动时指向不同目录，不需要再把凭据复制来复制去
//   - 面板不再碰使用者的主 ~/.zcode（实测设了这个变量后主目录一个字节都不动）
//   - 同一台机器上跑多个面板也不会互相覆盖（老架构两者共用同一份 live 凭据）
//
// 实测确认（2026-09-20）：设 ZCODE_DATA_BASE_DIR=<X> 启动客户端，它会在
// <X>\.zcode\v2\ 下建出 config.json / logs / certs / telemetry-state.json 等，
// 而 %USERPROFILE%\.zcode 的项与时间戳完全不变。
const ACCOUNT_DATA_DIR = 'data';
const dataRootOf = (id) => path.join(accountsDir(), id, ACCOUNT_DATA_DIR);
const zcodeV2Of = (id) => path.join(dataRootOf(id), '.zcode', 'v2');
const credentialsOf = (id) => path.join(zcodeV2Of(id), 'credentials.json');
const configOf = (id) => path.join(zcodeV2Of(id), 'config.json');
const planCacheOf = (id) => path.join(zcodeV2Of(id), 'coding-plan-cache.json');
const telemetryOf = (id) => path.join(zcodeV2Of(id), 'telemetry-state.json');
const logsOf = (id) => path.join(zcodeV2Of(id), 'logs');

/**
 * ZCode 的 setting.json 实际位置——**不在**每个账号的数据根里。
 *
 * 实测：把 httpProxy 只写进 <账号>/data/.zcode/v2/setting.json，启动后日志里
 * 仍是 mode=direct；写主 ~/.zcode/v2/setting.json 才会变成 fixed_servers。
 * 也就是说 ZCODE_DATA_BASE_DIR 重定向了凭据、配置、日志、遥测，但没管设置。
 * 好在设置是应用级偏好（主题、最近项目、代理），跨账号共用本来就合理。
 */
const zcodeSettingFile = () => path.join(LEGACY_ZCODE_V2, 'setting.json');

/**
 * 这些目录属于使用者本人，不该跟着账号分家。
 *
 * cli/        —— 对话记录、agent 产物、rollout（模型 IO）、插件
 * workspace/  —— 会话工作区
 * plugin-workspace/ —— 插件工作区
 *
 * 把 ZCODE_DATA_BASE_DIR 指到账号目录后，客户端会去 <账号>/data/.zcode/ 下找它们，
 * 那里是空的 → 项目和会话全都看不见（实测：切到新架构后打开客户端，项目列表空白）。
 * 所以给这几个目录建目录联接（junction）指回真实的 ~/.zcode，让它们跨账号共用：
 * 凭据、配置、日志各账号独立，而项目与对话始终是同一批。
 */
const SHARED_ZCODE_DIRS = ['cli', 'workspace', 'plugin-workspace'];

/** 整棵树里一个文件都没有（只有空目录）—— 这种才敢删掉换成联接 */
function hasNoFiles(dir) {
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isFile()) return false;
      if (e.isDirectory() && !hasNoFiles(path.join(dir, e.name))) return false;
    }
    return true;
  } catch (_) {
    return false;   // 读不了就当它有内容，保守处理
  }
}

/** 建目录联接；已经是联接就跳过，空壳目录让位，有内容的绝不碰 */
function linkDir(link, target) {
  try {
    const st = fs.lstatSync(link);
    if (st.isSymbolicLink()) return 'already';
    if (!st.isDirectory()) return 'skip';
    if (!hasNoFiles(link)) return 'hasdata';
    fs.rmSync(link, { recursive: true, force: true });
  } catch (_) {
    /* 不存在，往下走建联接 */
  }
  try {
    if (!fs.existsSync(target)) fs.mkdirSync(target, { recursive: true });
    fs.symlinkSync(target, link, 'junction');
    return 'linked';
  } catch (_) {
    return 'failed';
  }
}

/** 让账号数据根下的共享目录指向真实的 ~/.zcode（失败不影响凭据隔离） */
function linkSharedZcodeDirs(accountId) {
  const dataZcode = path.join(dataRootOf(accountId), '.zcode');
  try { fs.mkdirSync(dataZcode, { recursive: true }); } catch (_) { return; }

  // ① 数据根下的项目 / 会话 / 插件
  for (const name of SHARED_ZCODE_DIRS) {
    linkDir(path.join(dataZcode, name), path.join(LEGACY_ZCODE_ROOT, name));
  }

  // ② 账号私有 HOME 下的 .zcode
  //
  // v3.14 起 setting.json 的位置改由 resolveUserHomeDir() 决定：
  //   resolveUserHomeDir() = ZCODE_DESKTOP_HOME_DIR || HOME || USERPROFILE
  //   getSettingsFile()    = resolveUserHomeDir()/.zcode/v2/setting.json
  // 而面板把 ZCODE_DESKTOP_HOME_DIR 指到了 <账号>/home（本意是隔离 agent 的 shell HOME）。
  // 不联回去的话，设置会落到账号私有的 home 里，与面板写的主 ~/.zcode/v2/setting.json
  // 对不上——实测日志里那行 `settingService writing settings to: ...` 会指错地方，
  // 面板的 httpProxy 也就写了个寂寞。
  // 联回去之后：设置跨账号共用（本来就该共用），而 shell HOME 仍是账号独立的。
  linkDir(path.join(accountsDir(), accountId, 'home', '.zcode'), LEGACY_ZCODE_ROOT);
}

/**
 * 使旧的 provider 配置失效，逼客户端下次启动时从 config.json 重新导入。
 *
 * v3.14 起 provider 配置改存 provider_config.json（新格式），面板写的仍是
 * config.json（老格式，字段更全）。客户端只在 provider_config.json **不存在**时
 * 做一次性 legacy 导入（readLegacyProviders），所以改完 config.json 必须把它挪走，
 * 否则面板这次的写入不会被采纳——表现为"账号导进来了但没登录"。
 *
 * 丢掉是安全的：该文件里的 providerId / apiKey / baseUrl / personalModelIds
 * 都能从 config.json 完整重建（实测逐个字段比对过）。
 */
function invalidateProviderConfig(accountId) {
  try {
    const p = path.join(zcodeV2Of(accountId), 'provider_config.json');
    if (!fs.existsSync(p)) return false;
    fs.rmSync(p, { force: true });
    return true;
  } catch (_) {
    return false;
  }
}

// 当前账号记在 accounts/.current 里（`.` 开头，账号扫描会跳过）。
// 比"从 live 凭据反查账号"可靠得多：新架构下 live 就是账号自己的目录，
// 不再需要猜测，认错账号导致串号的问题从根上没有了。
const CURRENT_FILE = '.current';

function readCurrentId() {
  try {
    const v = fs.readFileSync(path.join(accountsDir(), CURRENT_FILE), 'utf8').trim();
    if (!v) return null;
    if (!fs.existsSync(path.join(accountsDir(), v))) return null;
    return v;
  } catch {
    return null;
  }
}

function writeCurrentId(id) {
  try {
    fs.writeFileSync(path.join(accountsDir(), CURRENT_FILE), id || '', 'utf8');
    return true;
  } catch {
    return false;
  }
}

/**
 * 当前账号的全部关键路径。当前账号未确定时返回 null。
 *
 * 调用方必须判空——绝不能退回全局 ~/.zcode，那样等于又回到"所有账号共用一份
 * 凭据"的老路上去，正是这次改造要消灭的东西。
 */
function curPaths() {
  const id = readCurrentId();
  if (!id) return null;
  return {
    id,
    root: dataRootOf(id),
    v2: zcodeV2Of(id),
    credentials: credentialsOf(id),
    config: configOf(id),
    planCache: planCacheOf(id),
  };
}

/** 读某个账号目录下的一份 JSON；路径为 null 或文件不存在都返回 null */
function readJsonAt(file) {
  return file ? safeJson(file) : null;
}

// ZCode 打包版默认不开放 CDP（源码里是 !app.isPackaged 才 appendSwitch 9229），
// 但 --remote-debugging-port 是 Chromium 原生开关，命令行传入即可生效。
// 面板靠它接管 ZCode 的内置浏览器去完成 BigModel 授权。
const ZCODE_CDP_PORT = 9223;

// 内置浏览器（<webview partition="persist:zcode-embedded-browser">）的落盘位置。
// 注意：面板传的 --user-data-dir 对 ZCode 无效——它启动时用
// app.setPath('userData'|'sessionData') 覆盖了，所以浏览器会话与账号目录无关，
// 六个账号共用这一份。BigModel 授权页显示的账号就来自这里。
// ZCode 的 userData / session 是它自己用 app.setPath 定的，面板传的
// --user-data-dir 对它无效。这里只用于诊断展示，面板不写这些目录。
const ZCODE_SESSION_DIR = path.join(process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming'), 'ZCode', 'session');
const BROWSER_PARTITION_DIR = path.join(ZCODE_SESSION_DIR, 'Partitions', 'zcode-embedded-browser');

// 面板自己授权窗口的分区。BigModel 绑定全程在这里完成，与 ZCode 的内置浏览器无关，
// 所以每个账号授权前把它清空即可拿到干净的 bigmodel.cn 会话。
const PANEL_OAUTH_PARTITION = (provider) => 'persist:zcode-oauth-' + provider;
const PANEL_USER_DATA = path.join(process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming'), 'zcode-panel');

// 这些目录名是内部用途，不作为账号展示
const RESERVED_DIRS = new Set(['last', 'profile', 'backup', 'tmp']);

// OAuth 回调协议在本进程内注册，等页面 302 到 zcode:// 时由 handler 接住。
protocol.registerSchemesAsPrivileged([
  { scheme: 'zcode', privileges: { standard: false, secure: false, supportFetchAPI: false } },
]);

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function ensureAccountsDir() {
  fs.mkdirSync(accountsDir(), { recursive: true });
  return accountsDir();
}

function safeJson(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function decodeJwtPayload(jwt) {
  try {
    const part = jwt.split('.')[1];
    const b64 = part.replace(/-/g, '+').replace(/_/g, '/');
    const pad = part.length % 4 === 0 ? '' : '='.repeat(4 - (part.length % 4));
    return JSON.parse(Buffer.from(b64 + pad, 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

/**
 * 当前账号的身份。
 *
 * 先读它自己数据目录里的 config.json；ZCode 启动后会把 builtin provider 的
 * apiKey 清空（实测那几个 builtin 全是空值 + enabled:false），那时退回
 * credentials.json 里的 access_token——那是稳定来源。
 */
function currentUser() {
  const p = curPaths();
  if (!p) return null;
  const cfg = readJsonAt(p.config);
  if (cfg && cfg.provider) {
    for (const [, pr] of Object.entries(cfg.provider)) {
      const key = pr && pr.options && pr.options.apiKey;
      if (key && String(key).startsWith('eyJ')) {
        const payload = decodeJwtPayload(key);
        if (payload) return { user_id: payload.user_id, email: payload.email || null };
      }
    }
  }
  const ident = identityOfCredentials(readJsonAt(p.credentials));
  if (ident) return { user_id: ident.uid, email: ident.email || null };
  return null;
}

function currentPlanStatus() {
  const p = curPaths();
  const cache = p ? readJsonAt(p.planCache) : null;
  const items = cache && cache.entryStatus && cache.entryStatus.items ? cache.entryStatus.items : {};
  return Object.entries(items).map(([name, v]) => ({
    name,
    status: v.status,
    reason: v.reason || null,
  }));
}

// ===== 套餐快照 =====
// 日志里的 billing/balance 只属于"当前活跃账号"，所以每次读到就把结果
// 沉淀到该账号目录，别的账号卡片才有东西可显示。
const SNAPSHOT_FILE = 'plan-snapshot.json';

function flattenPlanItems(planData) {
  const out = [];
  for (const plan of planData.plans || []) {
    const ents = plan.entitlements || [];
    const gift = ents.some((e) => e.period === 'one_time');
    const buckets = plan.buckets || [];
    if (buckets.length) {
      for (const b of buckets) {
        out.push({
          plan: plan.name,
          gift,
          name: b.showName,
          period: b.period || null,
          total: Number(b.totalUnits) || 0,
          used: Number(b.usedUnits) || 0,
          left: Number.isFinite(Number(b.availableUnits))
            ? Number(b.availableUnits)
            : Math.max(0, (Number(b.totalUnits) || 0) - (Number(b.usedUnits) || 0)),
          pending: false,
        });
      }
    } else {
      // 没有 balance 桶，只剩套餐定义里的 grant_units。
      //
      // 这不能当成可用额度：接口实测会返回空的 balances（比如
      // ziqhei95_7825，plans 有、balances 为空），那时 grant_units 只是
      // 「承诺给多少」，不是「还剩多少」。之前把它当满额渲染，结果是
      // GLM-5.3-Flash 实际已用尽（0/500万）却显示成 500万/500万。
      //
      // 真正「还没生效」的 entitlement 用 pending 标记；已经生效却没有桶的，
      // 属于用量数据缺失，单独标 unknown，让渲染层别编数字。
      for (const e of ents) {
        out.push({
          plan: plan.name,
          gift,
          name: e.showName,
          period: e.period || null,
          total: Number(e.grantUnits) || 0,
          used: 0,
          left: Number(e.grantUnits) || 0,
          pending: !!e.pending,
          unknown: !e.pending,
        });
      }
    }
  }
  // 与侧栏一致：日额度在前，赠送/一次性在后，待生效排最后
  return out.sort((a, b) => {
    const ka = (a.gift ? 2 : 0) + (a.pending ? 1 : 0);
    const kb = (b.gift ? 2 : 0) + (b.pending ? 1 : 0);
    return ka - kb;
  });
}

// ZCode 主进程启动时间。
// 必须异步取：在 Electron 主进程里用 execSync 调外部程序会阻塞事件循环，
// 实测直接把整个应用卡死（连 CDP 都不再响应）。这里只在后台刷新，读值永远不阻塞。
let _zcodeStart = { at: 0, val: 0, pending: null };

function getZcodeStartMs() {
  return _zcodeStart.val; // 只读缓存值，绝不阻塞
}

async function refreshZcodeStart() {
  if (Date.now() - _zcodeStart.at < 60000) return _zcodeStart.val;
  if (_zcodeStart.pending) return _zcodeStart.pending;
  const cmd = "(Get-Process ZCode -ErrorAction SilentlyContinue | Sort-Object StartTime | Select-Object -First 1).StartTime.ToString('o')";
  _zcodeStart.pending = new Promise((resolve) => {
    execFile(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-Command', cmd],
      { timeout: 8000, windowsHide: true },
      (err, stdout) => {
        const val = !err && stdout ? Date.parse(String(stdout).trim()) || 0 : 0;
        _zcodeStart = { at: Date.now(), val, pending: null };
        resolve(val);
      }
    );
  });
  return _zcodeStart.pending;
}

/**
 * 把读到的额度沉淀到当前账号，别的账号卡片才有数据可显示。
 *
 * 新架构下归属不再需要猜：当前账号就是面板自己启动的那个，读 .current 即可。
 * 老架构要"从 uid 反查账号目录"，遇到 live 停在本库没有的账号上就完全认不出，
 * 日志混号时还会写错——那套逻辑现在整个删掉了。
 */
function writePlanSnapshot(planData) {
  if (!planData || !planData.ok) return null;
  // 日志里的 provider 与当前账号不是同一家，说明数据是别人的
  if (planData.providerMismatch) return null;

  const accountId = readCurrentId();
  if (!accountId) return null;
  const dir = path.join(accountsDir(), accountId);
  const meta0 = safeJson(path.join(dir, 'meta.json'));

  // 更换账号后，正在运行的客户端用的仍是上一个账号，它写出的日志不属于本账号。
  // 判据：账号是在客户端进程启动之后才导入的 → 这个进程不可能在用它。
  // 用 captured_at（导入时间，不变）而不是 JWT 的 iat —— 客户端会自行刷新 JWT，
  // 刷新后的 iat 会晚于进程启动时间，用 iat 会误伤。
  const capturedMs = meta0 && meta0.captured_at ? Date.parse(meta0.captured_at) : 0;
  const zStartMs = getZcodeStartMs();
  if (zStartMs && capturedMs && capturedMs > zStartMs) return null;

  // 切换账号后日志里仍是上一个账号的数据，必须等客户端真的用新账号请求过。
  // 日志时间戳是平台时间（UTC+8），meta.last_used_at 是本机 ISO。
  if (meta0 && meta0.last_used_at && planData.logTs) {
    const logMs = Date.parse(planData.logTs.replace(' ', 'T') + '+08:00');
    const usedMs = Date.parse(meta0.last_used_at);
    if (Number.isFinite(logMs) && Number.isFinite(usedMs) && logMs < usedMs) return null;
  }

  const cur = currentUser();
  const snap = {
    captured_at: new Date().toISOString(),
    source: 'client',
    log_ts: planData.logTs || null,
    age_seconds: typeof planData.ageSeconds === 'number' ? planData.ageSeconds : null,
    provider_id: planData.providerId || null,
    user_plan_id: planData.userPlanId || null,
    user_id: (cur && cur.user_id) || null,
    items: flattenPlanItems(planData),
  };
  try {
    writeJsonAtomic(path.join(dir, SNAPSHOT_FILE), snap);
  } catch {
    return null;
  }
  return snap;
}

/**
 * 该账号已知的 user_plan_id。
 *
 * 日志是全局混合的，只能靠这个账号级的标识去里面精确挑出属于它的记录。
 * 值从它自己的快照里读——快照写盘时已经过了 provider / 账号目录 / 时间三重校验。
 */
function userPlanIdOfAccount(accountId) {
  if (!accountId) return null;
  const snap = safeJson(path.join(accountsDir(), accountId, SNAPSHOT_FILE));
  const v = snap && snap.user_plan_id;
  if (!v) return null;
  return String(v).split(',').map((s) => s.trim()).filter(Boolean)[0] || null;
}

/**
 * 把账号快照折回 fetchPlans 的形状，供「日志里没有本账号新记录」时兜底。
 *
 * 快照的数据虽然旧，但它属于这个账号自己；总比把别的账号的额度显示出来强。
 * 渲染层靠 stale 标记提示使用者这份数据不是实时的。
 */
function snapshotToPlanData(accountId) {
  if (!accountId) return null;
  const snap = safeJson(path.join(accountsDir(), accountId, SNAPSHOT_FILE));
  if (!snap || !Array.isArray(snap.items) || !snap.items.length) return null;

  const byPlan = new Map();
  for (const it of snap.items) {
    const key = it.plan || '套餐';
    if (!byPlan.has(key)) {
      byPlan.set(key, {
        planId: null,
        userPlanId: null,
        name: key,
        description: null,
        status: null,
        startsAt: null,
        endsAt: null,
        entitlements: [],
        buckets: [],
        pending: false,
        expired: false,
      });
    }
    const pl = byPlan.get(key);
    pl.buckets.push({
      showName: it.name,
      period: it.period || null,
      totalUnits: Number(it.total) || 0,
      usedUnits: Number(it.used) || 0,
      availableUnits: Number(it.left) || 0,
    });
    if (it.gift) {
      pl.entitlements.push({
        showName: it.name,
        period: 'one_time',
        grantUnits: Number(it.total) || 0,
        pending: false,
      });
    }
  }

  return {
    ok: true,
    logTs: snap.log_ts || null,
    serverTime: null,
    providerId: snap.provider_id || null,
    providerMismatch: false,
    userPlanId: snap.user_plan_id || null,
    source: 'snapshot',
    logFile: null,
    stale: true,
    staleAt: snap.captured_at || null,
    plans: Array.from(byPlan.values()),
  };
}

// ===== 联网查询套餐（不要求本机登录过客户端）=====
// 账号数据目录里的 JWT 足以完成认证；服务端接口不需要请求签名。
function readAccountJwt(id) {
  const cfg = readJsonAt(configOf(id));
  if (!cfg || !cfg.provider) return null;
  for (const pid of ['builtin:bigmodel-start-plan', 'builtin:zai-start-plan']) {
    const k = cfg.provider[pid] && cfg.provider[pid].options && cfg.provider[pid].options.apiKey;
    if (k && k.startsWith('eyJ')) return k;
  }
  return null;
}

function readAccountAccessToken(id) {
  const cred = readJsonAt(credentialsOf(id));
  if (!cred) return null;
  for (const key of Object.keys(cred)) {
    if (/^oauth:.+:access_token$/.test(key)) {
      const v = cred[key];
      try {
        return oauth.isEncrypted(v) ? oauth.decrypt(v) : v;
      } catch {
        return null;
      }
    }
  }
  return null;
}

// 查某账号的套餐并落盘为快照。请求由用户主动触发，内部已有节流。
async function fetchRemotePlanForAccount(id) {
  const dir = path.join(accountsDir(), id);
  if (!fs.existsSync(dir)) return { ok: false, msg: '账号不存在：' + id };

  const jwt = readAccountJwt(id);
  if (!jwt) {
    return { ok: false, reason: 'no-jwt', msg: '该账号还没有 JWT，先在网页登录一次再导入' };
  }

  // 必须带上这个账号自己的 device_mid：服务端拿它当参数，缺了直接 400 parameter error。
  // 用 accountDeviceId 而不是读 meta —— 老账号的 meta 里可能还没有这个字段，
  // 这个函数会顺带补上并持久化。
  let deviceMid = null;
  try { deviceMid = accountDeviceId(id); } catch (_) {}
  if (!deviceMid) {
    return { ok: false, reason: 'no-device-mid', msg: '该账号还没有设备标识，联网查询会被服务端判参数错误' };
  }

  const r = await remotePlan.fetchPlanByJwt(jwt, deviceMid);
  if (!r.ok) return r;

  const normalized = plan.normalizeRemote(r.data, 'remote:' + id);
  const snap = {
    captured_at: new Date().toISOString(),
    source: 'server',
    log_ts: normalized.logTs || null,
    provider_id: normalized.providerId || null,
    user_plan_id: normalized.userPlanId || null,
    items: flattenPlanItems(normalized),
  };
  if (!snap.items.length) return { ok: false, reason: 'empty', msg: '服务端返回里没有可显示的额度' };
  writeJsonAtomic(path.join(dir, SNAPSHOT_FILE), snap);
  return { ok: true, snapshot: snap };
}

function planSummaryOf(dir) {
  const snap = safeJson(path.join(dir, SNAPSHOT_FILE));
  if (!snap || !Array.isArray(snap.items) || !snap.items.length) return null;
  return {
    captured_at: snap.captured_at || null,
    log_ts: snap.log_ts || null,
    source: snap.source || 'client',
    items: snap.items,
  };
}

async function listAccounts() {
  ensureAccountsDir();
  const out = [];
  const curId = readCurrentId();
  const entries = await fsp.readdir(accountsDir(), { withFileTypes: true });
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    // 跳过内部目录：点开头的是备份/回滚目录，不是账号
    if (e.name.startsWith('.') || RESERVED_DIRS.has(e.name)) continue;
    const dir = path.join(accountsDir(), e.name);
    const meta = safeJson(path.join(dir, 'meta.json'));
    // 凭据在新架构下位于 <账号>/data/.zcode/v2/ 里
    const hasCred = fs.existsSync(credentialsOf(e.name));
    const hasCfg = fs.existsSync(configOf(e.name));
    let uid = null;
    if (hasCfg) {
      uid = uidOfConfig(readJsonAt(configOf(e.name)));
    }
    if (!uid) uid = uidOfJwt(readAccountJwt(e.name));
    const ageDays = meta && meta.registered_at
      ? Math.max(0, Math.floor((Date.now() - new Date(meta.registered_at).getTime()) / 86400000))
      : null;
    out.push({
      id: e.name,
      registered_at: meta ? meta.registered_at : null,
      registered_at_source: meta ? meta.registered_at_source || 'capture' : null,
      registered_at_raw: meta ? meta.registered_at_raw || null : null,
      captured_at: meta ? meta.captured_at || null : null,
      last_used_at: meta ? meta.last_used_at : null,
      switch_count: meta ? meta.switch_count || 0 : 0,
      switches_today: meta ? meta.switches_today || 0 : 0,
      last_switch_date: meta ? meta.last_switch_date || null : null,
      age_days: ageDays,
      user_id: uid,
      valid: hasCred && hasCfg,
      plan_summary: planSummaryOf(dir),
      path: dir,
    });
  }
  // 当前账号置顶（新架构下就是 .current 记的那个，不用再比对 uid），
  // 其余按注册时间从早到晚（即录入顺序）
  for (const a of out) a.is_current = a.id === curId;
  return out.sort((a, b) => {
    if (a.is_current !== b.is_current) return a.is_current ? -1 : 1;
    const ta = a.registered_at ? Date.parse(a.registered_at) : 0;
    const tb = b.registered_at ? Date.parse(b.registered_at) : 0;
    if (ta !== tb) return ta - tb;
    return (a.captured_at || '').localeCompare(b.captured_at || '');
  });
}

/**
 * 清掉 config 里属于「另一个账号」的 JWT。
 *
 * 快照必须是单一身份：只要一份快照里混进了别的账号的 JWT，
 * 两个目录就会解析出同一个 user_id，列表里就会凭空多出一个「当前账号」。
 * keepUid 为 null 时不动作，避免误清。
 */
function pruneForeignIdentity(cfg, keepUid) {
  const cleared = [];
  if (!cfg || !cfg.provider || !keepUid) return cleared;
  for (const pid of Object.keys(cfg.provider)) {
    if (!pid.startsWith('builtin:')) continue;
    const o = cfg.provider[pid] && cfg.provider[pid].options;
    const k = o && o.apiKey;
    if (!isJwtShaped(k)) continue;
    const uid = uidOfJwt(k);
    if (uid && uid !== keepUid) {
      o.apiKey = '';
      cfg.provider[pid].enabled = false;
      cleared.push(pid);
    }
  }
  return cleared;
}

/**
 * 捕获 / 认领当前登录。
 *
 * 新架构下账号目录里的 data/.zcode/v2/ 就是它自己的登录态本体，不再是副本。
 * 所以这里只有两件事可做：
 *   ① 该账号自己已经有凭据 → 刷新元信息（认领）
 *   ② 凭据还在老架构的全局 ~/.zcode/v2 里 → 迁移进来，之后它就在自己的数据根里跑
 * 两者都没有，就说明还没登录过，如实告诉使用者先去登录。
 */
async function captureAccount(id, replace) {
  ensureAccountsDir();
  const dir = path.join(accountsDir(), id);
  fs.mkdirSync(dir, { recursive: true });

  const credFile = credentialsOf(id);
  const cfgFile = configOf(id);
  const legacyCred = path.join(LEGACY_ZCODE_V2, 'credentials.json');
  const legacyCfg = path.join(LEGACY_ZCODE_V2, 'config.json');

  const ownHasCred = fs.existsSync(credFile);
  const canMigrate = fs.existsSync(legacyCred) && fs.existsSync(legacyCfg);

  if (ownHasCred && !replace) {
    return { ok: false, msg: `账号 ${id} 已经有自己的登录态了，确认覆盖后再试` };
  }

  let migrated = false;
  if (!ownHasCred && canMigrate) {
    try {
      fs.mkdirSync(path.dirname(credFile), { recursive: true });
      fs.copyFileSync(legacyCred, credFile);
      fs.copyFileSync(legacyCfg, cfgFile);
      migrated = true;
    } catch (e) {
      return { ok: false, msg: '迁移旧登录态失败：' + ((e && e.message) || e) };
    }
  }

  if (!fs.existsSync(credFile)) {
    return {
      ok: false,
      msg: '还没有可记录的登录态。先用这个账号启动客户端并在里面登录，然后再点「捕获当前登录」。',
    };
  }

  // 落地前过一遍，别把别的账号的 JWT 一起封进来
  let pruned = [];
  try {
    const cfg = safeJson(cfgFile);
    pruned = pruneForeignIdentity(cfg, uidOfConfig(cfg));
    if (pruned.length) fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2), 'utf8');
  } catch (_) {}
  const now = new Date().toISOString();
  const metaFile = path.join(dir, 'meta.json');
  const old = safeJson(metaFile);

  // 注册时间以平台为准（本地捕获时间单独记），否则账号年龄会失真
  let reg = null;
  try {
    reg = await balance.fetchRegisteredAt(credFile);
  } catch (_) {}

  const meta = {
    registered_at: (reg && reg.iso) || (old && old.registered_at) || now,
    registered_at_source: reg && reg.iso ? 'platform' : ((old && old.registered_at_source) || 'capture'),
    registered_at_raw: (reg && reg.raw) || (old && old.registered_at_raw) || null,
    captured_at: (old && old.captured_at) || now,
    last_used_at: now,
    switch_count: old ? old.switch_count || 0 : 0,
    switches_today: old ? old.switches_today || 0 : 0,
    last_switch_date: old ? old.last_switch_date : null,
    // 设备码：老账号保留它原有的值，不能重生成——换了设备码等于换了台机器，
    // 服务端那边看就是一次异常的设备迁移。
    device_mid: (old && old.device_mid) || crypto.randomUUID(),
  };
  await fsp.writeFile(metaFile, JSON.stringify(meta, null, 2));

  // 捕获的就是它 → 顺手记为当前账号
  writeCurrentId(id);

  const src = meta.registered_at_source === 'platform' ? '（注册时间取自平台）' : '（未取到平台注册时间，暂用本地时间）';
  const mig = migrated ? '，已从旧的全局 ~/.zcode 迁移登录态' : '';
  const note = pruned.length ? `，已剔除混入的其它账号凭据：${pruned.join(', ')}` : '';
  return { ok: true, msg: `已保存 ${id}${src}${mig}${note}`, pruned, migrated };
}

// 批量校准历史账号的注册时间
async function calibrateRegisteredAt() {
  const list = await listAccounts();
  const results = [];
  for (const a of list) {
    const credFile = credentialsOf(a.id);
    let reg = null;
    try {
      reg = await balance.fetchRegisteredAt(credFile);
    } catch (_) {}
    if (!reg || !reg.iso) {
      results.push({ id: a.id, ok: false });
      continue;
    }
    const metaFile = path.join(a.path, 'meta.json');
    const meta = safeJson(metaFile) || {};
    // 补齐录入时间：旧快照的 registered_at 就是当时的捕获时间；已校准过的用目录创建时间兜底
    if (!meta.captured_at) {
      if (meta.registered_at && meta.registered_at_source !== 'platform') {
        meta.captured_at = meta.registered_at;
      } else {
        try {
          const st = fs.statSync(a.path);
          const t = st.birthtime && st.birthtime.getTime() > 0 ? st.birthtime : st.ctime;
          if (t) meta.captured_at = new Date(t).toISOString();
        } catch (_) {}
      }
    }
    meta.registered_at = reg.iso;
    meta.registered_at_source = 'platform';
    meta.registered_at_raw = reg.raw;
    await fsp.writeFile(metaFile, JSON.stringify(meta, null, 2));
    results.push({ id: a.id, ok: true, raw: reg.raw });
    // 轻微错开，避免一串请求同时打出去
    await wait(350);
  }
  const okCount = results.filter((r) => r.ok).length;
  return {
    ok: true,
    results,
    msg: `校准完成：${okCount}/${results.length} 个账号取到平台注册时间`,
  };
}

// 当前登录的 provider（用于校核日志里的额度记录是否属于当前账号）
function readActiveProvider() {
  const p = curPaths();
  if (!p) return null;
  const cred = readJsonAt(p.credentials);
  if (!cred) return null;
  const v = cred['oauth:active_provider'];
  if (typeof v !== 'string') return null;
  if (v.startsWith('enc:v1:')) {
    try { return oauth.decrypt(v); } catch { return null; }
  }
  return v;
}

// 面板授权窗口的分区落盘位置
function panelOAuthPartitionDir(provider) {
  return path.join(PANEL_USER_DATA, 'Partitions', 'zcode-oauth-' + provider);
}

const EGRESS_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// ---------------------------------------------------------------- ZCode 代理

/**
 * 读 Windows 系统代理。
 *
 * 面板自己走 Chromium 默认（跟随系统代理），但 ZCode 不是——它启动时会给
 * default-session 下发 setProxy({mode:"direct"})，主动绕过系统代理。
 * 所以要把系统代理的值取出来，再写进 ZCode 自己的配置里。
 */
function detectSystemProxy() {
  try {
    const { execFileSync } = require('child_process');
    const key = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';
    const en = execFileSync('reg', ['query', key, '/v', 'ProxyEnable'], { encoding: 'utf8', windowsHide: true });
    if (!/ProxyEnable\s+REG_DWORD\s+0x1/i.test(en)) return null;
    const out = execFileSync('reg', ['query', key, '/v', 'ProxyServer'], { encoding: 'utf8', windowsHide: true });
    const m = /ProxyServer\s+REG_SZ\s+(.+)/.exec(out);
    if (!m) return null;
    const raw = m[1].trim();
    // 可能是 "127.0.0.1:7897"，也可能是 "http=127.0.0.1:7897;https=127.0.0.1:7897"
    if (raw.includes('=')) {
      // 必须精确找 http=，不能写成 https?= —— 那个 s? 会让 https= 也命中，
      // 碰到 "https=10809;http=10808" 这种（v2rayN 的写法）就会取错端口。
      const h = /(?:^|;)\s*http=([^;]+)/i.exec(raw) || /(?:^|;)\s*https=([^;]+)/i.exec(raw);
      if (!h) return null;
      const v = h[1].trim();
      return /^https?:\/\//i.test(v) ? v : 'http://' + v;
    }
    return /^https?:\/\//i.test(raw) ? raw : 'http://' + raw;
  } catch {
    return null;
  }
}

/** ZCode 当前配的代理（setting.json 的 httpProxy） */
function getZcodeProxy() {
  const j = safeJson(zcodeSettingFile()) || {};
  const v = j.httpProxy;
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

/**
 * 写/清 ZCode 的 httpProxy。
 *
 * 位置必须是 setting.json —— 实测环境变量 ZCODE_HTTP_PROXY 完全不被读取，
 * 而 asar 里 network policy 是从 settingService 取的：
 *   { httpProxy: (await settingService.get()).httpProxy, ... }
 * 写进去之后 setProxy 的模式会从 direct 变成 fixed_servers。
 *
 * 注意 setting.json 不受 ZCODE_DATA_BASE_DIR 影响：实测把 httpProxy 只写进
 * 账号自己的数据目录，ZCode 启动后仍是 mode=direct，它读的是主目录那一份。
 * 所以这里照旧写全局路径——它是应用级偏好（主题、最近项目、代理），
 * 跨账号共用本来就是合理的。
 */
function setZcodeProxy(url) {
  const file = zcodeSettingFile();
  const j = safeJson(file) || {};
  const before = (typeof j.httpProxy === 'string' && j.httpProxy.trim()) ? j.httpProxy.trim() : null;
  const next = url ? String(url).trim() : '';
  if (next) j.httpProxy = next;
  else delete j.httpProxy;
  writeJsonAtomic(file, j);
  return { before, after: next || null, changed: before !== (next || null) };
}

// 出口地区探测服务。任何一个答上来就够用，所以并发发出去、谁先回用谁，
// 而不是排队重试——没开代理时三个都要各自超时，排队最坏要等二十多秒。
const EGRESS_PROBES = [
  { url: 'https://api.country.is/', pick: (j) => j.country },
  { url: 'https://api.ip.sb/geoip', pick: (j) => j.country_code },
  { url: 'https://ipinfo.io/json', pick: (j) => j.country },
];

/**
 * 探测「授权窗口发请求时实际从哪里出去」。
 *
 * 必须用 session.fetch：它走 Chrome 网络栈，吃系统代理和 TUN，
 * 和授权窗口是同一条通道。node 的全局 fetch 是直连，无论代理开没开
 * 都只会报本机真实出口——拿它测等于没测。
 *
 * country 为 CN 说明还在直连；全部服务都不可达，多半也是没走代理
 * （这几个服务在国内基本不通），但也可能只是它们自己挂了，所以措辞要留余地。
 */
async function probeEgressRegion(provider = 'zai') {
  const ses = session.fromPartition('persist:zcode-oauth-' + provider);
  const attempts = EGRESS_PROBES.map(async (p) => {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 6000);
    try {
      const r = await ses.fetch(p.url, {
        signal: ctl.signal,
        headers: { 'User-Agent': EGRESS_UA, Accept: 'application/json' },
      });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const j = await r.json();
      const cc = String(p.pick(j) || '').toUpperCase();
      if (!cc) throw new Error('返回里没有地区字段');
      return { ok: true, country: cc, ip: j.ip || null, source: p.url, domestic: cc === 'CN' };
    } finally {
      clearTimeout(timer);
    }
  });
  try {
    return await Promise.any(attempts);
  } catch (e) {
    const errs = (e && e.errors ? e.errors : []).map((x) => (x && x.message) || String(x));
    return { ok: false, msg: '探测服务全部不可达', errors: errs };
  }
}

/**
 * 清空面板授权窗口的浏览器会话。
 *
 * 必须做，否则会绑错账号。授权窗口的 partition 是写死的
 * 'persist:zcode-oauth-bigmodel'，全局共用一个——绑完 A 账号后
 * bigmodel.cn 的会话留在里面，下次给 B 账号点授权，页面直接是 A 的登录态，
 * 一点「进行授权」就把 B 的 Z.ai 账号绑到了 A 的 BigModel 上。
 * 套餐只发一次，B 等于白注册。
 *
 * 走 Electron 的 session API 而不是直接删目录：分区一旦被加载过就常驻内存，
 * Chromium 锁着 Cookies 和 leveldb，硬删会和运行中的进程打架。
 */
async function clearPanelOAuthSession(provider) {
  const partition = PANEL_OAUTH_PARTITION(provider);
  const via = [];
  let err = null;
  let before = 0;

  try {
    const ses = session.fromPartition(partition);
    before = (await ses.cookies.get({})).length;
    await ses.clearStorageData({
      storages: [
        'cookies',
        'localstorage',
        'indexdb',
        'websql',
        'serviceworkers',
        'cachestorage',
        'shadercache',
        'filesystem',
      ],
    });
    via.push('session');
  } catch (e) {
    err = e.message || String(e);
  }

  // 兜底：分区还没被加载过时目录可能仍在，直接删更彻底
  try {
    const dir = panelOAuthPartitionDir(provider);
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
      via.push('fs');
    }
  } catch (_) {
    // 被锁说明分区活着，session API 那条路已经清过了，忽略
  }

  let after = 0;
  try {
    after = (await session.fromPartition(partition).cookies.get({})).length;
  } catch (_) {}

  return { ok: !err, provider, cleared: via.length > 0, before, after, via, reason: err };
}

// 授权会话里还剩什么。
// 不能用 Cookies 文件大小判断：Chromium 清掉 cookie 后 SQLite 页大小不变，
// 文件仍是 20KB，看着像还登录着。要数真实条数。
async function panelOAuthSessionInfo(provider) {
  const partition = PANEL_OAUTH_PARTITION(provider);
  const dir = panelOAuthPartitionDir(provider);
  const exists = fs.existsSync(dir);
  let cookieCount = 0;
  let domains = [];
  try {
    const cookies = await session.fromPartition(partition).cookies.get({});
    cookieCount = cookies.length;
    domains = [...new Set(cookies.map((c) => c.domain))].slice(0, 6);
  } catch (_) {}
  return { exists, cookieCount, loggedIn: cookieCount > 0, domains };
}

function killZCode() {
  return new Promise((resolve) => {
    execFile('taskkill', ['/IM', 'ZCode.exe', '/F'], (err) => {
      // Exit code 128 means process not found; either way we proceed.
      resolve(!err || err.code === 128);
    });
  });
}

/**
 * 每个账号独占的设备标识。
 *
 * ZCode 把设备码原样发给服务端，两处通道：
 *   X-Device-Mid 请求头   ← 读 ~/.zcode/v2/telemetry-state.json 的 deviceMid
 *   __ZCODE_DEVICE_ID__   ← 读命令行 --device-id=
 * 该值由 ensureDeviceMid 生成一次后永久复用，和账号无关。
 * 不隔离的话，同一台机器上所有账号上报的是同一个设备码——服务端按它分组
 * 就能确定这些号来自同一台机器，这不是统计推断而是精确匹配。
 */
function accountDeviceId(id) {
  const file = path.join(accountsDir(), id, 'meta.json');
  const meta = safeJson(file) || {};
  if (typeof meta.device_mid !== 'string' || !meta.device_mid.trim()) {
    meta.device_mid = crypto.randomUUID();
    try {
      fs.writeFileSync(file, JSON.stringify(meta, null, 2), 'utf8');
    } catch (_) {}
  }
  return meta.device_mid.trim();
}

// 把设备码写进 ZCode 启动时会读的位置（当前账号自己的数据目录）。
// 它在进程内按文件路径缓存，但每次切换都会重启客户端，所以重启后一定读到新值。
function syncDeviceMidToZCode(mid, accountId = null) {
  if (!mid) return false;
  const id = accountId || readCurrentId();
  if (!id) return false;
  const f = telemetryOf(id);
  const cur = safeJson(f) || {};
  if (cur.deviceMid === mid) return true;
  cur.deviceMid = mid;
  try {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, JSON.stringify(cur, null, 2), 'utf8');
    return true;
  } catch {
    return false;
  }
}

/**
 * 启动 ZCode。accountId 必传。
 *
 * 不做"没有账号就用默认目录兜底"——那样启动出来的客户端会直接用上使用者的
 * 主 ~/.zcode，整个隔离就破了：它写的凭据落在面板管不到的地方，使用者本机
 * 真正的登录态也会被这个面板改掉。没有账号时宁可拒启动。
 */
function launchZCode(accountId) {
  if (!accountId) {
    return Promise.reject(new Error('没有指定账号，拒绝启动客户端（否则会直接改动你本机的 ~/.zcode）'));
  }
  if (!fs.existsSync(path.join(accountsDir(), accountId))) {
    return Promise.reject(new Error(`账号 ${accountId} 不存在`));
  }

  // 先确认客户端真的在。spawn 一个不存在的路径不会同步抛错，
  // 而是在下一个 tick 发 'error' 事件——不提前挡掉就会变成一条没人接的异常。
  const exe = zcodeExe();
  const check = settings.describeExe(exe);
  if (!check.ok) {
    return Promise.reject(new Error(
      `找不到 ZCode 客户端（${check.msg}）。请在面板右上角「设置」里指定 ZCode.exe 的位置。`
    ));
  }

  const args = [`--remote-debugging-port=${ZCODE_CDP_PORT}`];
  const env = { ...process.env };

  {
    const mid = accountDeviceId(accountId);
    args.push(`--device-id=${mid}`);
    syncDeviceMidToZCode(mid, accountId);

    // ① ZCode 自己的数据根：凭据、配置、日志、遥测全落在这里。
    //    这是本次改造的核心——设上它，每个账号才真正互不干扰，
    //    面板也不再碰使用者的主 ~/.zcode。
    const root = dataRootOf(accountId);
    try { fs.mkdirSync(root, { recursive: true }); } catch (_) {}
    env.ZCODE_DATA_BASE_DIR = root;

    // ①-b 但项目 / 会话 / 插件是使用者的东西，要跨账号共用，
    //     否则切过来会看到一个空的项目列表（凭据隔离不该把它们也隔离掉）。
    linkSharedZcodeDirs(accountId);

    // ② Chromium 侧也按账号分开：
    //    userData    → %APPDATA%\ZCode，里面的 .updaterId 是跨账号不变的持久 uuid
    //    sessionData → cookies / localStorage，共享就等于所有账号共用一套登录态
    //    ZCode 用 app.setPath 覆盖了 Electron 默认值，所以只能靠这三个环境变量，
    //    命令行 --user-data-dir 对它无效。
    const ud = path.join(accountsDir(), accountId, 'userdata');
    const sd = path.join(accountsDir(), accountId, 'session');
    const hm = path.join(accountsDir(), accountId, 'home');
    for (const d of [ud, sd, hm]) {
      try { fs.mkdirSync(d, { recursive: true }); } catch (_) {}
    }
    env.ZCODE_DESKTOP_USER_DATA_DIR = ud;
    env.ZCODE_DESKTOP_SESSION_DATA_DIR = sd;
    env.ZCODE_DESKTOP_HOME_DIR = hm;
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    let child;
    try {
      child = spawn(exe, args, { detached: true, stdio: 'ignore', env });
    } catch (e) {
      reject(new Error('启动 ZCode 失败：' + (e.message || e)));
      return;
    }
    child.once('error', (e) => {
      if (settled) return;
      settled = true;
      reject(new Error('启动 ZCode 失败：' + (e.message || e)));
    });
    child.unref();
    // ENOENT 之类的失败是异步冒出来的，给它一点时间；过了就算启动成功
    setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(true);
    }, 500);
  });
}

/**
 * 切换账号。
 *
 * 新架构下切换只做两件事：改「当前账号」这个标记，然后用该账号自己的数据根
 * 重启客户端。一个字节的文件复制都不需要——每个账号的凭据本来就在它自己的
 * data/.zcode/v2/ 里，ZCode 直接读写它。
 *
 * 老架构要"把快照复制成全局 live"，既多了一层覆盖写，也是账号库一分家就
 * 互相认不出的根源。这里把它彻底去掉了。
 *
 * opts.writeBack 保留是为了不破坏调用方，但已经没有意义。
 */
async function switchAccount(id, opts = {}) {
  const dir = path.join(accountsDir(), id);
  if (!fs.existsSync(dir)) return { ok: false, msg: `账号 ${id} 不存在` };
  if (!fs.existsSync(credentialsOf(id))) {
    return {
      ok: false,
      msg: `账号 ${id} 还没有登录态。先切到它、在弹出的客户端里登录一次，之后就能正常来回切了。`,
    };
  }

  const prevId = readCurrentId();

  await killZCode();
  await wait(800);

  writeCurrentId(id);
  bumpSwitchMeta(dir, 'switch');

  // 客户端启动失败不该把整次切换判为失败：标记已经改好，凭据也各在各家，
  // 只是进程没起来。分开报，免得使用者以为没切过去而反复重试。
  let launchError = null;
  try {
    await launchZCode(id);
  } catch (e) {
    launchError = (e && e.message) || String(e);
  }
  return {
    ok: true,
    msg: launchError ? `已切到 ${id}，但 ZCode 没能启动：${launchError}` : `已切换到 ${id}`,
    prevId: prevId || null,
    noRollbackTarget: !prevId,
    launchError,
  };
}

/**
 * 老架构里的「把 live 凭据回写进账号快照」。
 *
 * 新架构下客户端直接读写账号自己的文件，不存在"要不要回写"的问题，
 * 因此不再有调用方。留一个空实现只为兼容可能残留的引用，不做事也不报错。
 */
function writeLiveBackToSnapshot() {
  return { ok: true, changed: false, skipped: 'datadir-architecture' };
}

async function deleteAccount(id) {
  const dir = path.join(accountsDir(), id);
  if (!fs.existsSync(dir)) return { ok: false, msg: `账号 ${id} 不存在` };
  const isCurrent = readCurrentId() === id;
  const { response } = await dialog.showMessageBox({
    type: 'warning',
    buttons: ['取消', '移到回收站'],
    defaultId: 0,
    cancelId: 0,
    message: `移除账号 ${id}？`,
    detail: isCurrent
      ? '它自己的数据目录会移到 .trash-<日期>，可以手动取回。这是当前账号，移除后面板就没有选中账号了。'
      : '它自己的数据目录会移到 .trash-<日期>，可以手动取回；其他账号不受影响。',
  });
  if (response !== 1) return { ok: false, msg: '已取消' };

  // 移到回收站而不是直接删。凭据里带着 access_token，误删一个还有效的账号
  // 只能重新授权，代价远大于留一个目录。
  const trashDir = path.join(accountsDir(), '.trash-' + localDate().replace(/-/g, ''));
  fs.mkdirSync(trashDir, { recursive: true });
  let dst = path.join(trashDir, id);
  let n = 1;
  while (fs.existsSync(dst)) {
    dst = path.join(trashDir, `${id}-${n}`);
    n += 1;
  }

  // 删掉的正好是当前账号 → 清掉 .current，否则它指向一个不存在的目录，
  // 界面会显示"当前账号 XXX"却什么都读不到。
  const clearCurrent = () => { if (isCurrent) writeCurrentId(null); };

  try {
    fs.renameSync(dir, dst);
    clearCurrent();
    return { ok: true, msg: `已移到回收站：.trash-${localDate().replace(/-/g, '')}/${path.basename(dst)}`, trash: dst };
  } catch (e) {
    // 跨卷 rename 会失败，退回复制再删
    try {
      await fsp.cp(dir, dst, { recursive: true });
      await fsp.rm(dir, { recursive: true, force: true });
      clearCurrent();
      return { ok: true, msg: `已移到回收站：${path.basename(dst)}`, trash: dst };
    } catch (e2) {
      return { ok: false, msg: '移除失败：' + ((e2 && e2.message) || String(e2)) };
    }
  }
}

// 本地日期（YYYY-MM-DD）。不能用 toISOString——那是 UTC，本机 UTC+8 时
// 每日边界会落在早上 8 点，凌晨的切换会被算进前一天。
function localDate(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// 记录一次账号变更（切换或回滚）。两者都真的换了活跃账号，都该计入当日节奏。
function bumpSwitchMeta(dir, action) {
  const metaFile = path.join(dir, 'meta.json');
  const meta = safeJson(metaFile) || {};
  const now = new Date();
  const today = localDate(now);
  // 先取出旧日期再覆盖。原写法先赋值 today 再比较，条件恒真，
  // switches_today 只会累加、永不归零，等于变成历史总次数。
  const prevDate = meta.last_switch_date;
  meta.last_used_at = now.toISOString();
  meta.switch_count = (meta.switch_count || 0) + 1;
  meta.last_switch_date = today;
  meta.switches_today = prevDate === today ? (meta.switches_today || 0) + 1 : 1;
  if (action) meta.last_action = action;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(metaFile, JSON.stringify(meta, null, 2));
}

// 从一份 credentials.json 内容里解析身份 uid。
// 同一个账号目录里 bigmodel 和 zai 的 token 可能共存（实测四个 Z.ai 账号
// 都残留着同一个 bigmodel token），按固定顺序读会解析出另一个身份，
// 所以必须由 oauth:active_provider 决定先看哪个。
function identityOfCredentials(cred) {
  if (!cred) return null;
  let active = null;
  try {
    const v = cred['oauth:active_provider'];
    active = oauth.isEncrypted(v) ? oauth.decrypt(v) : v;
  } catch (_) {}

  const providers = ['bigmodel', 'zai'];
  const order = providers.includes(active)
    ? [active].concat(providers.filter((p) => p !== active))
    : providers;

  for (const pid of order) {
    const raw = cred['oauth:' + pid + ':access_token'];
    if (!raw) continue;
    let tok = raw;
    try {
      tok = oauth.isEncrypted(raw) ? oauth.decrypt(raw) : raw;
    } catch (_) {
      continue;
    }
    const uid = uidOfJwt(tok);
    if (uid) return { uid, provider: pid, active };
  }
  return null;
}

/**
 * 当前活跃账号。
 *
 * 新架构下这个答案由面板自己决定：启动哪个账号就把 id 写进 accounts/.current，
 * 读它即可。以前那套"从 live 凭据反查 uid 再匹配账号目录"整个不需要了——
 * 那套做法在账号库里没有对应账号时会认不出来（实测过：live 停在原版库的账号上，
 * 开源版就完全认不出当前是谁），而且日志混号时还会认错。
 */
function currentAccountId() {
  return readCurrentId();
}

/**
 * 老架构里的「回滚上次切换」。
 *
 * 新架构下切换不再覆盖任何凭据——每个账号的登录态始终待在它自己的数据目录里，
 * 切过去就是启动它、切回来就是再启动它，不存在"把上一个账号的凭据盖回去"这种
 * 需要撤销的动作。所以这个按钮的语义变成了「按当前账号重启一次客户端」，
 * 用于客户端状态异常时恢复。
 *
 * 如果还留着老架构的 .rollback 快照，如实说明它已经不适用，别假装回滚了。
 */
async function rollback() {
  const legacy = path.join(accountsDir(), '.rollback');
  const hasLegacy = fs.existsSync(path.join(legacy, 'credentials.json'));

  const id = readCurrentId();
  if (!id) {
    return {
      ok: false,
      msg: hasLegacy
        ? '新架构下切换账号不再覆盖凭据，旧的 .rollback 快照已不适用。请先在列表里选一个账号。'
        : '还没有当前账号，先在列表里选一个。',
    };
  }

  await killZCode();
  await wait(600);

  let launchError = null;
  try {
    await launchZCode(id);
  } catch (e) {
    launchError = (e && e.message) || String(e);
  }
  return {
    ok: true,
    msg: launchError
      ? `已用 ${id} 重启，但 ZCode 没能启动：${launchError}`
      : `已用当前账号 ${id} 重启客户端（新架构下登录态不会被覆盖，无需回滚）`,
    launchError,
  };
}

function writeJsonAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

// 各 OAuth provider 对应的 config.json provider 家族
const PROVIDER_FAMILY = {
  bigmodel: ['builtin:bigmodel', 'builtin:bigmodel-coding-plan', 'builtin:bigmodel-start-plan'],
  zai: ['builtin:zai', 'builtin:zai-coding-plan', 'builtin:zai-start-plan'],
};

function isJwtShaped(v) {
  return typeof v === 'string' && v.startsWith('eyJ') && v.split('.').length === 3;
}

// `<32位hex>.<secret>` 形式的请求签名凭据，由 BigModel 业务接口按账号派生，
// 换账号后旧值必然失效，不能沿用。
function isSigningKeyShaped(v) {
  return typeof v === 'string' && /^[0-9a-f]{32}\.[A-Za-z0-9_-]{8,}$/.test(v);
}

// 取 JWT 里的账号标识，用于判断本次导入是否换了账号
function uidOfJwt(jwt) {
  const pl = decodeJwtPayload(jwt);
  return (pl && (pl.sub || pl.user_id)) || null;
}

// 账号身份优先从「基础 provider」读，套餐类 provider 只是同一身份的载体。
// 顺序固定，避免不同目录因遍历次序不同而解析出不同账号。
const IDENTITY_PRIORITY = ['builtin:bigmodel', 'builtin:zai'];

function uidOfConfig(cfg) {
  if (!cfg || !cfg.provider) return null;
  const names = Object.keys(cfg.provider);
  const order = IDENTITY_PRIORITY.filter((p) => names.includes(p))
    .concat(names.filter((p) => !IDENTITY_PRIORITY.includes(p)));
  for (const pid of order) {
    const o = cfg.provider[pid] && cfg.provider[pid].options;
    const k = o && o.apiKey;
    if (isJwtShaped(k)) {
      const uid = uidOfJwt(k);
      if (uid) return uid;
    }
  }
  return null;
}

// 网页 OAuth 完成后把 token 写盘，结构对齐官方客户端。
function applyOAuthToken(tokenSet, userInfo, opts = {}) {
  const { writeLive = true, freshAccount = false, accountId = null } = opts;
  const p = tokenSet.provider;
  if (!p) throw new Error('tokenSet 缺少 provider');

  // 新架构下"live"就是这个账号自己的数据目录，不再有全局那一份。
  const targetId = accountId || readCurrentId();
  if (!targetId) throw new Error('还没有当前账号，无法写入登录态');
  const credFile = credentialsOf(targetId);
  const cfgFile = configOf(targetId);

  // 写盘前备份当前登录态。备份放在账号自己的目录里，不再共用一个全局 .rollback。
  if (writeLive) {
    const rollbackDir = path.join(accountsDir(), targetId, '.rollback');
    try {
      fs.mkdirSync(rollbackDir, { recursive: true });
      if (fs.existsSync(credFile)) fs.copyFileSync(credFile, path.join(rollbackDir, 'credentials.json'));
      if (fs.existsSync(cfgFile)) fs.copyFileSync(cfgFile, path.join(rollbackDir, 'config.json'));
    } catch (_) {}
  }

  // 备份本次导入前的活动账号，便于切回
  const prevUser = currentUser();

  const cred = safeJson(credFile) || {};
  // 快照必须只含「本次导入的这一个身份」。
  // cred 是从 live credentials 改出来的，另一个 provider 的 token 会原样带过来。
  // 实测后果：三个 Z.ai 账号的快照里都塞进了同一个 bigmodel token
  // （sha256 指纹相同、uid 都是 12303308），看起来像都绑过同一个 BigModel 账号，
  // 实际上谁也没绑——只是导入时从 live 继承下来的。
  // config.json 那边早有同样意义的清理（见下面的 freshAccount 分支），
  // credentials.json 这边一直漏了。
  if (freshAccount) {
    for (const pid of ['bigmodel', 'zai']) {
      if (pid === p) continue;
      for (const k of Object.keys(cred)) {
        if (k.startsWith('oauth:' + pid + ':')) delete cred[k];
      }
    }
  }

  cred['oauth:active_provider'] = oauth.encrypt(p);
  cred['oauth:' + p + ':access_token'] = oauth.encrypt(tokenSet.accessToken);
  if (tokenSet.refreshToken) cred['oauth:' + p + ':refresh_token'] = oauth.encrypt(tokenSet.refreshToken);
  if (userInfo) {
    cred['oauth:' + p + ':user_info'] = oauth.encrypt(JSON.stringify({
      id: userInfo.id,
      username: userInfo.username,
      displayName: userInfo.displayName,
      avatarUrl: userInfo.avatarUrl || undefined,
      rawProfile: userInfo.raw || undefined,
    }));
  }
  // zcode JWT 只在拿到新值时覆盖，避免写空
  if (tokenSet.zcodeJwt) cred.zcodejwttoken = oauth.encrypt(tokenSet.zcodeJwt);
  if (writeLive) writeJsonAtomic(credFile, cred);

  // config.json：plan 类 provider 的 apiKey 就是 zcode JWT（已实测与官方一致）
  let accountChanged = false;
  const signingKeysCleared = [];
  const cfg = safeJson(cfgFile) || { provider: {} };
  if (!cfg.provider || typeof cfg.provider !== 'object') cfg.provider = {};

  // 快照必须是「某一个账号」的完整身份。这里是从 live config 改出来的，
  // 而本次 OAuth 只会覆盖自己那套 provider，另一套的旧凭据会原样残留，
  // 会让两个目录解析出同一个 user_id（列表里凭空多出一个「当前账号」）。
  if (freshAccount) {
    const keep = new Set(PROVIDER_FAMILY[p] || []);
    for (const pid of Object.keys(cfg.provider)) {
      if (!pid.startsWith('builtin:') || keep.has(pid)) continue;
      const o = cfg.provider[pid] && cfg.provider[pid].options;
      if (!o) continue;
      o.apiKey = '';
      cfg.provider[pid].enabled = false;
    }
  }

  if (tokenSet.zcodeJwt) {
    const newUid = uidOfJwt(tokenSet.zcodeJwt);
    const oldUid = prevUser && prevUser.user_id;
    accountChanged = !!(newUid && oldUid && newUid !== oldUid);

    for (const pid of PROVIDER_FAMILY[p] || []) {
      const cur = cfg.provider[pid];
      if (!cur || typeof cur !== 'object') cfg.provider[pid] = { options: {}, enabled: true };
      if (!cfg.provider[pid].options || typeof cfg.provider[pid].options !== 'object') cfg.provider[pid].options = {};
      const existing = cfg.provider[pid].options.apiKey;

      // 签名凭据（<hex32>.<secret>）是按账号派生的：换了账号旧值必然失效，
      // 必须清掉，否则会拿上一个账号的 key 去签名。
      if (accountChanged && isSigningKeyShaped(existing)) {
        cfg.provider[pid].options.apiKey = '';
        cfg.provider[pid].enabled = false;
        signingKeysCleared.push(pid);
        continue;
      }
      // 只覆盖空值或已失效的 JWT，保留本账号自己的券类 key
      if (!existing || isJwtShaped(existing)) {
        cfg.provider[pid].options.apiKey = tokenSet.zcodeJwt;
        cfg.provider[pid].enabled = true;
      }
    }
    if (writeLive) writeJsonAtomic(cfgFile, cfg);
  }

  // v3.14 起 provider 配置另存 provider_config.json，且只做一次性 legacy 导入。
  // 刚改完 config.json，把这个文件挪走，逼客户端下次启动重新导入。
  const invalidated = writeLive ? invalidateProviderConfig(targetId) : false;

  return {
    provider: p,
    accountId: targetId,
    previousUser: prevUser,
    accountChanged,
    signingKeysCleared,
    providerConfigInvalidated: invalidated,
    cred,
    cfg,
  };
}

/**
 * 把 OAuth 结果存成一个新账号，但不把它设为当前账号。
 * 使用者什么时候切过去由自己点「切换」决定。
 */
function importAsSnapshot(tokenSet, userInfo, opts = {}) {
  const uid = tokenSet.zcodeJwt ? uidOfJwt(tokenSet.zcodeJwt) : null;
  const raw = opts.name || (userInfo && (userInfo.username || userInfo.displayName)) || null;
  // Z.ai 会返回 "user" 这种通用名，直接拿来当目录名毫无区分度，补 uid 尾号
  const generic = !raw || /^(user|unknown|acct|account)$/i.test(String(raw).trim());
  const name = slugifyAccountName(
    generic ? `${raw || 'acct'}_${String(uid || Date.now()).slice(-6)}` : raw
  );
  const dir = path.join(accountsDir(), name);
  fs.mkdirSync(dir, { recursive: true });

  // 关键：把目标账号显式传进去。新账号的数据目录里还没有凭据，
  // applyOAuthToken 从空对象起步，不会把当前账号的身份继承过来。
  const applied = applyOAuthToken(tokenSet, userInfo, {
    writeLive: true,
    freshAccount: true,
    accountId: name,
  });

  // 二次保险：落地后再按 uid 复核一遍，确保这个账号里只有一套身份
  const pruned = pruneForeignIdentity(applied.cfg, uidOfConfig(applied.cfg));
  if (pruned.length) writeJsonAtomic(configOf(name), applied.cfg);

  const now = new Date().toISOString();
  const metaFile = path.join(dir, 'meta.json');
  const old = safeJson(metaFile) || {};
  writeJsonAtomic(metaFile, {
    ...old,
    registered_at: old.registered_at || now,
    registered_at_source: old.registered_at_source || 'capture',
    captured_at: now,
    last_used_at: now,
    switch_count: old.switch_count || 0,
    switches_today: old.switches_today || 0,
    last_switch_date: old.last_switch_date || null,
    via: opts.via || 'oauth',
    phone: opts.phone || old.phone || null,
    email: opts.email || old.email || null,
    device_mid: old.device_mid || crypto.randomUUID(),
  });

  return { ok: true, name, dir, uid, provider: applied.provider, accountChanged: applied.accountChanged };
}

/** 账号目录名：去掉路径分隔符与首尾空白，最长 40 字符 */
function slugifyAccountName(raw) {
  const s = String(raw || '')
    .trim()
    .replace(/[\\/:*?"<>|]+/g, '_')
    .replace(/\s+/g, '_')
    .replace(/^[._]+/, '');
  return (s || 'acct' + Date.now()).slice(0, 40);
}

let pendingOAuth = null;
let oauthWin = null;
let loginDriver = null;

/**
 * 把 OAuth 授权结果「附加」到当前身份上，而不是新建一个账号。
 *
 * 这是「连接 BigModel」要的语义：Z.ai 账号保持自己的身份，额外获得 BigModel 能力。
 *
 * 实测依据——已经绑好的 zai_774031 和没绑的 user_55cae9，凭据只差两个键：
 *   oauth:bigmodel:access_token / oauth:bigmodel:user_info
 * 其余全部一致：active_provider 仍是 "zai"，zcodejwttoken 连长度都一样。
 * 所以绑定就是补这两个键，绝不能碰 active_provider——一碰就变成
 * 「换成 BigModel 登录」，那是替换身份，ZCode 会提示「新登录会替换当前登录身份」。
 *
 * user_info 的结构照抄 ZCode 的写法：id 取 token 里的 customer_id（zcode 账号 id），
 * 不是授权接口返回的 customerNumber；rawProfile 只是个版本标记。
 */
async function bindOAuthToCurrent(tokenSet) {
  const p = tokenSet.provider;
  if (!p) throw new Error('tokenSet 缺少 provider');

  const accountId = readCurrentId();
  if (!accountId) throw new Error('还没有当前账号，无法绑定');
  const credFile = credentialsOf(accountId);

  const payload = decodeJwtPayload(tokenSet.accessToken) || {};
  const id = String(payload.customer_id || payload.user_id || 'unknown');
  const username = payload.username || 'user';
  const info = { id, username, displayName: username, rawProfile: { zcodeProfileSchemaVersion: 2 } };

  const apply = (obj) => {
    obj['oauth:' + p + ':access_token'] = oauth.encrypt(tokenSet.accessToken);
    obj['oauth:' + p + ':user_info'] = oauth.encrypt(JSON.stringify(info));
    return obj;
  };

  // 绑之前留一份，出问题能还原（放在这个账号自己的目录里）
  try {
    const rollbackDir = path.join(accountsDir(), accountId, '.rollback');
    fs.mkdirSync(rollbackDir, { recursive: true });
    if (fs.existsSync(credFile)) fs.copyFileSync(credFile, path.join(rollbackDir, 'credentials.json'));
  } catch (_) {}

  // 只补键，其余原样。新架构下这份就是该账号的登录态本体，
  // 不需要再"同步进快照"——它就是快照。
  writeJsonAtomic(credFile, apply(safeJson(credFile) || {}));

  return { accountId, provider: p, boundId: id, boundName: username, snapshotUpdated: true };
}

function stopLoginDriver(reason) {
  // 先收掉「需要你操作」提示：这一步的人工环节已结束，或整个流程已终止。
  // 放在 return 之前，保证任何一条退出路径都不会把提示留在面板上。
  pushDriverEvent({ manual: true, active: false, msg: '' });
  // 若面板正弹着输入框，一并取消，免得流程已停还在等人填。
  cancelPendingAsk('流程已结束');
  if (!loginDriver) return;
  const d = loginDriver;
  loginDriver = null;
  try { d.stop(reason || 'finished'); } catch (_) {}
}

// 把自动化进度推给面板，让使用者看到每一步
function pushDriverEvent(ev) {
  try {
    if (win && !win.isDestroyed()) win.webContents.send('panel:event', ev);
  } catch (_) {}
}

// ---- 面板提问通道 ----
// 激活链接这类只能由使用者提供的信息：driver 调 askPanel 挂起，面板弹框，
// 提交或取消后 resolve。
let pendingAsk = null;
let askSeq = 0;

/**
 * 把面板的输入框推到使用者眼前。
 *
 * 授权窗口是面板的子窗口，在 Windows 上会始终压在父窗口之上——设在面板里的
 * 输入框会被它整个盖住，使用者只会觉得"点了没反应"。所以提问期间临时解除
 * 父子关系，让面板能显示在前面。
 *
 * 刻意不用 setAlwaysOnTop：那样面板会浮在所有窗口之上，使用者切去邮箱复制
 * 激活链接时会被一直挡着。解除父子关系只在"弹出这一刻"把面板提到前面，
 * 之后他照常切窗口。
 */
function raisePanelForAsk() {
  try {
    if (oauthWin && !oauthWin.isDestroyed()) oauthWin.setParentWindow(null);
  } catch (_) {}
  try {
    if (win && !win.isDestroyed()) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
      win.flashFrame(true);
    }
  } catch (_) {}
}

/** 答复之后收尾：停掉闪烁，把父子关系还回去，授权窗口重新浮在面板之上 */
function lowerPanelAfterAsk() {
  try { if (win && !win.isDestroyed()) win.flashFrame(false); } catch (_) {}
  try {
    if (oauthWin && !oauthWin.isDestroyed() && win && !win.isDestroyed()) {
      oauthWin.setParentWindow(win);
    }
  } catch (_) {}
}

function cancelPendingAsk(reason) {
  if (!pendingAsk) return;
  const p = pendingAsk;
  pendingAsk = null;
  lowerPanelAfterAsk();
  try { p.resolve(null); } catch (_) {}
  try {
    if (win && !win.isDestroyed()) win.webContents.send('panel:ask-cancel', { id: p.id, reason: reason || '' });
  } catch (_) {}
}

function askPanel(desc = {}) {
  return new Promise((resolve) => {
    if (!win || win.isDestroyed()) { resolve(null); return; }
    cancelPendingAsk('已被新的输入请求取代');
    const id = 'ask' + (++askSeq);
    pendingAsk = { id, resolve };
    try {
      win.webContents.send('panel:ask', {
        id,
        kind: desc.kind || 'text',
        label: desc.label || '请输入',
        placeholder: desc.placeholder || '',
        hint: desc.hint || '',
      });
    } catch (_) {
      pendingAsk = null;
      resolve(null);
      return;
    }
    // 弹框内容推给渲染进程之后再提窗口，免得窗口先跳出来、内容还是空的
    raisePanelForAsk();
  });
}

// 桥接页：授权后 https 落到这里，再转 zcode:// 自定义协议
const BRIDGE_PREFIX = 'https://zcode.z.ai/app/oauth/login';

/**
 * 给授权窗口的 session 配置按域名分流的代理。
 *
 * 实测（本机系统代理 127.0.0.1:7897）：
 *   bigmodel.cn   全走代理 → ERR_CONNECTION_CLOSED ；绕过代理直连 → HTTP 200（328ms）
 *   chat.z.ai     走代理   → 200；绕过代理 → 不通
 *   zcode.z.ai    走代理   → 200
 *
 * bigmodel.cn 是国内站点，套境外节点会被直接掐断。ZCode 客户端自己给主会话下发
 * mode=direct，所以它从来没暴露过这个问题——只有面板这扇跟随系统代理的窗口会中招，
 * 表现为「窗口打开了但一片空白」。反过来 chat.z.ai 必须走代理才通。
 *
 * 结论：国内域名绕过代理直连，其余跟随系统代理。代理地址不写死，从系统代理现读。
 */
const PROXY_BYPASS_RULES = 'bigmodel.cn;*.bigmodel.cn;*.zhipuai.cn;<local>';

/** "PROXY 127.0.0.1:7897" / "SOCKS5 127.0.0.1:1080" / "DIRECT" → Chromium 的 proxyRules */
function toProxyRules(resolved) {
  const m = /(PROXY|SOCKS5?|HTTPS?)\s+([^\s;]+)/i.exec(String(resolved || ''));
  if (!m) return '';
  const kind = m[1].toUpperCase();
  const addr = m[2];
  if (kind.startsWith('SOCKS')) return 'socks5://' + addr;
  return addr;
}

async function applyOAuthProxyPolicy(providerId) {
  const ses = session.fromPartition(PANEL_OAUTH_PARTITION(providerId));
  try {
    const probe = await ses.resolveProxy('https://chat.z.ai/');
    const rules = toProxyRules(probe);
    if (!rules) {
      // 系统没配代理（或本身就是直连），不动它——保持 Electron 默认行为
      return { ok: true, mode: 'untouched', resolved: probe };
    }
    await ses.setProxy({
      mode: 'fixed_servers',
      proxyRules: rules,
      proxyBypassRules: PROXY_BYPASS_RULES,
    });
    // 换代理配置后要断开既有连接，否则旧连接还挂在老策略上
    try { ses.closeAllConnections(); } catch (_) {}
    return { ok: true, mode: 'split', proxyRules: rules, resolved: probe };
  } catch (e) {
    return { ok: false, msg: (e && e.message) || String(e) };
  }
}

const htmlEscape = (s) => String(s == null ? '' : s)
  .replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** 加载失败时在窗口里写一段说明，别留一个纯白窗口让人猜 */
function showLoadErrorPage(targetWin, host, desc, code) {
  if (!targetWin || targetWin.isDestroyed()) return;
  const html = `
    <div style="font-family:system-ui,'Microsoft YaHei',sans-serif;padding:30px;color:#1b2a44;line-height:1.75">
      <div style="font-size:17px;font-weight:600;margin-bottom:10px">打不开 ${htmlEscape(host)}</div>
      <div style="font-size:13px;color:#e1554b;margin-bottom:14px">${htmlEscape(desc)}（${htmlEscape(code)}）</div>
      <div style="font-size:13px;color:#6b7f9d">
        这个地址需要走系统代理。如果加速器没打开、节点不可用，或者节点不接受这个域名，
        就会连不上。<br><br>
        检查网络后，回到面板重新点一次即可。
      </div>
    </div>`;
  targetWin.webContents
    .executeJavaScript(`document.body.innerHTML = ${JSON.stringify(html)};`)
    .catch(() => {});
}

function extractCallbackCode(url) {
  if (!url) return null;
  const isBridge = url.startsWith(BRIDGE_PREFIX);
  const isScheme = url.startsWith('zcode://');
  if (!isBridge && !isScheme) return null;
  return oauth.parseCallbackUrl(url);
}

// 内嵌登录窗口：打开授权页，等回调落地后换取 token。
// 两条线都是混合模式：手机号 / 邮箱、获取验证码、人机验证、填验证码由使用者在窗口里
// 自己完成，驱动只负责自动点提交按钮和最后的授权确认。
async function startOAuthFlow(providerId = 'bigmodel', mode = 'bridge', options = {}) {
  // 授权窗口的 partition 是全局共用的，上一次授权登录的 bigmodel.cn 会留在里面。
  // 不先清掉，这次点「进行授权」就会把当前 Z.ai 账号绑到上一个 BigModel 账号上——
  // 套餐只发一次，新号等于白注册。必须在创建窗口之前清，窗口一建分区就被锁。
  // options.keepSession = true 可跳过（例如重试同一次授权，不想重输密码）。
  if (!options.keepSession) {
    const reset = await clearPanelOAuthSession(providerId);
    if (!reset.ok || !reset.cleared) {
      try {
        pushDriverEvent({ level: 'warn', msg: '授权会话未能清空：' + (reset.reason || '无残留') + '，本次可能绑到上一个 BigModel 账号' });
      } catch (_) {}
    }
  }

  // 代理策略必须在建窗口 / loadURL 之前设好：bigmodel.cn 走代理会被掐断，
  // 而 chat.z.ai 必须走代理，只能按域名分流。
  const proxyPolicy = await applyOAuthProxyPolicy(providerId);
  if (proxyPolicy.ok && proxyPolicy.mode === 'split') {
    pushDriverEvent({ level: 'info', msg: `授权窗口代理已分流：国际域名走 ${proxyPolicy.proxyRules}，bigmodel.cn 直连` });
  } else if (!proxyPolicy.ok) {
    pushDriverEvent({ level: 'warn', msg: '授权窗口代理设置失败：' + proxyPolicy.msg });
  }

  return new Promise((resolve, reject) => {
    // 连点「开始注册」会叠出多个授权窗口。旧窗口的 state 已经不可能被接住了，
    // 留着只会让人分不清该在哪个窗口里操作，所以先收掉再开新的。
    if (oauthWin && !oauthWin.isDestroyed()) {
      const old = oauthWin;
      const prev = pendingOAuth;
      oauthWin = null;
      pendingOAuth = null;   // 先摘掉，免得 old 的 'closed' 回调去 reject 新流程
      try { old.destroy(); } catch (_) {}
      if (prev && !prev.done) {
        prev.done = true;
        try { prev.reject(new Error('已被新的授权流程取代')); } catch (_) {}
      }
    }

    const state = crypto.randomBytes(16).toString('hex');
    const started = oauth.buildAuthorizeUrl(providerId, state, mode);
    pendingOAuth = {
      provider: providerId,
      mode,
      state,
      redirectUri: started.redirectUri,
      authorizeUrl: started.url,
      resolve,
      reject,
      done: false,
      accountName: options.accountName || null,
      bind: !!options.bind,
      phone: null,
      email: null,
      via: providerId === 'zai' ? 'zai-mail' : 'phone-manual',
    };

    stopLoginDriver('restart');

    oauthWin = new BrowserWindow({
      width: 520,
      height: 760,
      parent: win,
      modal: false,
      autoHideMenuBar: true,
      title: (oauth.PROVIDERS[providerId] || {}).displayName + ' 登录',
      backgroundColor: '#f5f9ff',
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        partition: 'persist:zcode-oauth-' + providerId,
      },
    });

    const tryCapture = (url) => {
      if (!pendingOAuth || pendingOAuth.done) return false;
      const parsed = extractCallbackCode(url);
      if (!parsed) return false;
      if (parsed.state !== pendingOAuth.state) {
        // 不是本次流程的 code，忽略（可能来自并发窗口）
        return false;
      }
      pendingOAuth.done = true;
      stopLoginDriver('authorized');
      completeOAuth(parsed.code, parsed.state);
      return true;
    };

    oauthWin.webContents.on('will-redirect', (e, url) => {
      if (tryCapture(url)) { try { e.preventDefault(); } catch (_) {} }
    });
    oauthWin.webContents.on('will-navigate', (e, url) => {
      if (tryCapture(url)) { try { e.preventDefault(); } catch (_) {} }
    });
    oauthWin.webContents.on('did-navigate', (_e, url) => tryCapture(url));
    oauthWin.webContents.on('did-redirect-navigation', (_e, url) => tryCapture(url));

    // 页面打不开时绝不能静默：窗口是白的，使用者只会以为"点了没反应"。
    // 最常见的成因是 bigmodel.cn 走了境外代理节点被掐断（ERR_CONNECTION_CLOSED）。
    oauthWin.webContents.on('did-fail-load', (_e, code, desc, failedUrl, isMainFrame) => {
      if (!isMainFrame) return;
      if (code === -3) return; // ERR_ABORTED：正常的导航取消，不是故障
      let host = String(failedUrl || '');
      try { host = new URL(failedUrl).host; } catch (_) {}
      pushDriverEvent({ level: 'error', msg: `登录页打不开：${host}　${desc}（${code}）` });
      pushDriverEvent({
        level: 'manual', manual: true, active: true,
        msg: `登录窗口打不开 ${host}（${desc}）。检查网络或加速器后，回面板重新点一次。`,
      });
      showLoadErrorPage(oauthWin, host, desc, code);
    });

    // 授权窗口里跑的驱动。两条线都是混合模式——填账号、获取验证码、过人机验证、
    // 填验证码由使用者在窗口里自己完成；驱动负责自动点提交按钮和最后的授权确认。
    oauthWin.webContents.on('did-finish-load', () => {
      if (!oauthWin || oauthWin.isDestroyed()) return;
      if (pendingOAuth && pendingOAuth.done) return;
      if (loginDriver && !loginDriver.stopped) return; // 页面跳转会重复触发，防重入
      const url = oauthWin.webContents.getURL();
      const expectHost = providerId === 'zai' ? /chat\.z\.ai/ : /bigmodel\.cn/;
      if (!expectHost.test(url)) return;

      if (providerId === 'zai') {
        pushDriverEvent({ level: 'info', msg: '开始 Z.ai 邮箱注册：名称 / 邮箱 / 密码和人机验证由你在窗口里完成，填好后自动点「创建账号」' });
        loginDriver = new ZaiMailDriver({
          win: oauthWin,
          ask: askPanel,
          authorizeUrl: started.url,
          log: pushDriverEvent,
        });
        loginDriver
          .run()
          .then((r) => {
            if (pendingOAuth && r && r.email) pendingOAuth.email = r.email;
            pushDriverEvent({
              level: r.ok ? 'ok' : 'error',
              msg: r.ok
                ? `注册与授权已完成　邮箱=${r.email}`
                : (r.msg || '注册流程未完成'),
              final: true,
              email: r.email || null,
            });
          })
          .catch((e) => pushDriverEvent({ level: 'error', msg: '注册流程异常：' + (e.message || e), final: true }));
        return;
      }

      pushDriverEvent({ level: 'info', msg: '开始 BigModel 网页登录：手机号 / 获取验证码 / 人机验证 / 填验证码由你在窗口里完成，填好后自动点「登录 / 注册」' });
      loginDriver = new LoginDriver({
        win: oauthWin,
        ask: askPanel,
        log: pushDriverEvent,
      });
      loginDriver
        .run()
        .then((r) => {
          if (pendingOAuth && r && r.phone) pendingOAuth.phone = r.phone;
          pushDriverEvent({
            level: r.ok ? 'ok' : 'error',
            msg: r.ok
              ? '登录与授权确认（协议勾选 + 继续）已自动完成'
              : (r.msg || '登录流程未完成'),
            final: true,
            phone: r.phone || null,
          });
        })
        .catch((e) => pushDriverEvent({ level: 'error', msg: '登录流程异常：' + (e.message || e), final: true }));
    });

    oauthWin.on('closed', () => {
      stopLoginDriver('window-closed');
      if (pendingOAuth && !pendingOAuth.done) {
        const err = new Error('登录窗口已关闭，未完成授权');
        err.code = 'window_closed';
        pendingOAuth.reject(err);
        pendingOAuth = null;
      }
      oauthWin = null;
    });

    oauthWin.loadURL(started.url);
  });
}

// 换取 token → 取用户信息 → 写盘 → 返回结果
function completeOAuth(code, state) {
  const pending = pendingOAuth;
  (async () => {
    try {
      const tokenSet = await oauth.exchangeCode(pending.provider, code, state, pending.redirectUri);
      let userInfo = null;
      try {
        userInfo = await oauth.fetchUserInfo(pending.provider, tokenSet.accessToken);
      } catch (_) {}

      // 绑定模式：附加到当前账号身份上，不新建快照
      if (pending.bind) {
        const bound = await bindOAuthToCurrent(tokenSet);
        pending.resolve({
          ok: true,
          bind: true,
          provider: pending.provider,
          account: bound,
          user: userInfo || { id: bound.boundId, username: bound.boundName, displayName: bound.boundName },
          switched: false,
        });
        if (oauthWin && !oauthWin.isDestroyed()) {
          setTimeout(() => { try { oauthWin && oauthWin.close(); } catch (_) {} }, 900);
        }
        return;
      }

      // 只落成账号快照，绝不改动当前 ZCode 登录态。
      // 新号进来先躺在列表里，什么时候切过去由使用者自己点「切换」。
      const saved = importAsSnapshot(tokenSet, userInfo, {
        name: pending.accountName || null,
        phone: pending.phone || null,
        email: pending.email || null,
        via: pending.via || 'oauth',
      });

      let business = 'skipped';
      if (pending.provider === 'zai') {
        business = await oauth.triggerBusinessLogin(tokenSet.accessToken).catch(() => 'failed');
      }
      pending.resolve({
        ok: true,
        provider: pending.provider,
        business,
        user: userInfo || { id: 'unknown', username: 'user', displayName: 'user' },
        account: saved,
        switched: false,
      });
      // 授权已经拿到码、账号也落好了，这次授权窗口的登录态再无用处。
      // 不清的话它会一直躺在分区里（表现为「残留 N 条」），而下次授权前反正还要再清一次。
      // 先关窗口再清：清 storage 会让页面掉登录态，窗口还开着没必要制造这一幕。
      // 只对内置窗口这条路清——手动粘贴模式（buildManualAuthorizeLink）本来就没用分区。
      if (oauthWin && !oauthWin.isDestroyed()) {
        setTimeout(() => {
          try { oauthWin && oauthWin.close(); } catch (_) {}
          clearPanelOAuthSession(pending.provider).catch(() => {});
        }, 900);
      } else {
        clearPanelOAuthSession(pending.provider).catch(() => {});
      }
    } catch (e) {
      pending.reject(e);
    } finally {
      pendingOAuth = null;
      stopLoginDriver();
    }
  })();
}

// 复制授权链接模式：用户在已登录的浏览器里打开，再把回跳地址贴回来
function buildManualAuthorizeLink(providerId = 'bigmodel', mode = 'direct') {
  const state = crypto.randomBytes(16).toString('hex');
  const started = oauth.buildAuthorizeUrl(providerId, state, mode);
  pendingOAuth = {
    provider: providerId,
    mode,
    state,
    redirectUri: started.redirectUri,
    authorizeUrl: started.url,
    resolve: () => {},
    reject: () => {},
    done: false,
  };
  return { ok: true, provider: providerId, state, url: started.url, redirectUri: started.redirectUri };
}

// 粘贴回调地址或授权码完成导入
function submitManualCode(input) {
  const pending = pendingOAuth;
  if (!pending) return Promise.resolve({ ok: false, msg: '请先点「生成授权链接」，再粘贴回跳地址' });
  if (pending.done) return Promise.resolve({ ok: false, msg: '本次流程已完成，请重新生成链接' });

  const parsed = oauth.parseManualInput(input, pending.state);
  if (!parsed) return Promise.resolve({ ok: false, msg: '没解析出授权码，请粘贴完整回跳地址' });
  if (parsed.state && parsed.state !== pending.state) {
    return Promise.resolve({ ok: false, msg: 'state 与本次流程不匹配，请重新生成链接' });
  }

  pending.done = true;
  return new Promise((resolve) => {
    pending.resolve = resolve;
    pending.reject = (e) => resolve({ ok: false, msg: e.message || String(e) });
    completeOAuth(parsed.code, parsed.state || pending.state);
  });
}

// zcode:// 协议在本进程内被接住（不会唤起官方客户端）
function handleOAuthCallback(url) {
  const parsed = extractCallbackCode(url);
  if (!parsed || !pendingOAuth || pendingOAuth.done) {
    return new Response('ignored', { status: 400 });
  }
  if (parsed.state !== pendingOAuth.state) {
    return new Response('state mismatch', { status: 403 });
  }
  pendingOAuth.done = true;
  completeOAuth(parsed.code, parsed.state);
  return new Response(
    '<html><body style="font-family:sans-serif;display:grid;place-items:center;height:100vh;background:#f5f9ff"><div style="text-align:center"><h2 style="color:#0c2d6b">登录成功</h2><p style="color:#6b7f9d">已获取账号凭证，正在写盘，可关闭此窗口</p></div></body></html>',
    { headers: { 'content-type': 'text/html; charset=utf-8' } }
  );
}

let win = null;

function createWindow() {
  win = new BrowserWindow({
    width: 1080,
    height: 720,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#f5f9ff',
    title: 'ZCode Panel',
    icon: path.join(__dirname, 'icon.ico'),
    // 隐藏 Electron 默认菜单栏（File/Edit/View/Window/Help），按 Alt 仍可调出。
    // 不删是因为 Ctrl+C/V/A 这些输入框快捷键挂在 Edit 菜单的 accelerator 上，
    // setApplicationMenu(null) 会把它们一起带走——面板里要粘贴授权码和手机号，
    // 那时就粘不进去了。隐藏则两者兼得，还省下菜单栏那条高度。
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // 加载完成后立刻自检一次 ZCode 客户端在不在。放在这里而不是 before-quit 之类，
  // 是因为要等渲染进程准备好接收 'panel:need-setup'。
  win.webContents.once('did-finish-load', () => { startupCheck(); });
}

// ---------------------------------------------------------------- 设置页

/**
 * 设置页要的全部状态：当前生效值、值是从哪来的、可不可用，以及兜底默认值。
 * 界面上「为什么不能用」比「设为空」重要得多，所以状态一律带上说明。
 */
function settingsSnapshot() {
  const saved = settings.load();
  const cur = settings.currentExe();
  const status = settings.describeExe(cur.path);
  return {
    ok: true,
    file: settings.settingsFile(),
    appDir: settings.APP_DIR,
    exe: {
      saved: saved.zcodeExe,
      effective: cur.path,
      source: cur.source,
      status,
    },
    accounts: {
      saved: saved.accountsDir,
      effective: accountsDir(),
      fallback: settings.defaultAccountsDir(),
    },
    detected: settings.lastDetectResult(),
  };
}

/**
 * 启动自检：客户端不在就主动把设置页叫出来。
 * 不这么做的话界面上看不出任何异常，用户要等到点「切换账号」才会莫名其妙失败。
 */
async function startupCheck() {
  try {
    let status = settings.describeExe(settings.currentExe().path);
    if (!status.ok) {
      await settings.detect();
      status = settings.describeExe(settings.currentExe().path);
    }
    settings.load(); // 确保缓存已建，后面 snapshot 拿到的是一致的值
    if (win && !win.isDestroyed() && !status.ok) {
      win.webContents.send('panel:need-setup', settingsSnapshot());
    }
  } catch (_) {}
}

ipcMain.handle('settings:get', () => settingsSnapshot());

ipcMain.handle('settings:detect', async () => {
  try {
    // 探测明细一并带回：没有找到时，使用者需要看到"查过哪些地方"才判断得出该手动填什么
    const r = await settings.detect();
    return { ...settingsSnapshot(), detect: r };
  } catch (e) {
    return { ...settingsSnapshot(), detectError: (e && e.message) || String(e) };
  }
});

ipcMain.handle('settings:verify', (_e, p) => settings.describeExe(p));

ipcMain.handle('settings:save', (_e, patch) => {
  const r = settings.save(patch || {});
  return { ...r, snapshot: settingsSnapshot() };
});

ipcMain.handle('settings:pick-exe', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: '选择 ZCode.exe',
    buttonLabel: '使用这个程序',
    properties: ['openFile'],
    filters: [{ name: '可执行文件', extensions: ['exe'] }],
  });
  if (r.canceled || !r.filePaths || !r.filePaths.length) return { ok: false, canceled: true };
  const picked = r.filePaths[0];
  return { ok: true, path: picked, status: settings.describeExe(picked) };
});

ipcMain.handle('settings:pick-dir', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: '选择账号数据目录',
    buttonLabel: '使用这个目录',
    properties: ['openDirectory', 'createDirectory'],
  });
  if (r.canceled || !r.filePaths || !r.filePaths.length) return { ok: false, canceled: true };
  return { ok: true, path: r.filePaths[0] };
});

ipcMain.handle('settings:open-folder', (_e, target) => {
  const p = target === 'accounts' ? accountsDir() : settings.APP_DIR;
  try {
    const err = shell.openPath(p);
    return err ? { ok: false, msg: String(err) } : { ok: true, path: p };
  } catch (e) {
    return { ok: false, msg: (e && e.message) || String(e) };
  }
});

ipcMain.handle('accounts:list', () => listAccounts());
ipcMain.handle('accounts:current', () => currentUser());
ipcMain.handle('accounts:plans', () => currentPlanStatus());
ipcMain.handle('accounts:capture', async (_e, id, replace) => {
  const res = await captureAccount(id, replace);
  // 刚捕获的账号就成了当前账号，顺手把套餐也存下来
  if (res && res.ok) {
    try {
      await refreshZcodeStart();
      const pd = plan.fetchPlans(readActiveProvider(), true, null, logsOf(currentAccountId()));
      if (pd && pd.ok) writePlanSnapshot(pd);
    } catch (_) {}
  }
  return res;
});
ipcMain.handle('accounts:switch', (_e, id, opts) => switchAccount(id, opts || {}));
ipcMain.handle('accounts:delete', (_e, id) => deleteAccount(id));
ipcMain.handle('accounts:rollback', () => rollback());
// 面板授权窗口的会话状态。残留会话会导致下次授权绑到上一个 BigModel 账号，
// 所以前端要知道它脏了没有。
ipcMain.handle('oauth:session-status', async () => {
  return {
    ok: true,
    currentId: currentAccountId(),
    partitionDir: path.join(PANEL_USER_DATA, 'Partitions'),
    bigmodel: await panelOAuthSessionInfo('bigmodel'),
    zai: await panelOAuthSessionInfo('zai'),
  };
});
// 手动清空授权窗口会话（换账号绑 BigModel 前用）
ipcMain.handle('oauth:reset-session', async (_e, provider) => {
  const p = provider === 'zai' ? 'zai' : 'bigmodel';
  return await clearPanelOAuthSession(p);
});
ipcMain.handle('accounts:calibrate', () => calibrateRegisteredAt());
ipcMain.handle('plans:quota', async (_e, force) => {
  // 先确保拿到客户端进程启动时间，账号归属判据依赖它
  try { await refreshZcodeStart(); } catch (_) {}

  // 以客户端日志为准。
  //
  // 不要改用联网结果：那个接口实测会返回空的 balances，只剩套餐定义里的
  // grant_units，看着像「满额未用」，其实不是当前用量。实测对比同一账号、
  // 同一 user_plan_id：日志里 GLM-5.3-Flash 已用尽（0/500万，真实的），
  // 联网结果却是 500万/500万（拿 grant_units 顶替的假数据）。
  // 日志才是客户端实际收到的 billing 响应，含真实 balances。
  //
  // 新架构下每个账号各写各的日志，本来就只含它自己的记录。再叠一层
  // user_plan_id 精确匹配，是为了兜住"客户端还在跑上一个账号"这种过渡期。
  const accId = currentAccountId();
  const expectPlanId = userPlanIdOfAccount(accId);
  const data = await plan.fetchPlans(readActiveProvider(), !!force, expectPlanId, logsOf(accId));

  // 还没有当前账号（账号库是空的，或刚被清空）时没有可显示的额度，
  // 如实说明，不要退回全局日志去猜——那正是以前串号的来源。
  if (!accId) {
    return {
      ok: false,
      reason: 'no-current-account',
      msg: '还没有选中任何账号。先在列表里切一个，或点「捕获当前登录」把当前账号存进来。',
    };
  }

  // 这个账号自己的日志里还没有记录时，退回它自己的旧快照并标注 stale。
  // 绝不能退回"最后一条"——新架构下虽然各写各的，但客户端可能还在跑上一个账号。
  if (!data || !data.ok) {
    const snapData = snapshotToPlanData(accId);
    if (snapData) {
      snapData.staleReason = (data && data.reason) || 'unknown';
      return snapData;
    }
    return data;
  }

  // 读到就沉淀到当前账号，别的账号卡片才有数据可显示
  try {
    const s = writePlanSnapshot(data);
    if (s && data && typeof data === 'object') data.snapshotSaved = true;
  } catch (_) {}

  return data;
});
ipcMain.handle('plan:state', () => ({ cooldownMs: remotePlan.cooldownLeftMs() }));
ipcMain.handle('plan:remote', async (_e, id) => {
  try {
    return await fetchRemotePlanForAccount(id);
  } catch (e) {
    return { ok: false, msg: '联网查询失败：' + (e && e.message ? e.message : String(e)) };
  }
});
ipcMain.handle('oauth:start', (_e, provider, mode, options) => startOAuthFlow(provider || 'bigmodel', mode || 'bridge', options || {}));
// 探测授权窗口发请求时的实际出口地区：判断加速器是不是真的把这扇窗口也带出去了
ipcMain.handle('oauth:probe-region', async (_e, provider) => {
  try {
    return await probeEgressRegion(provider || 'zai');
  } catch (e) {
    return { ok: false, msg: (e && e.message) || String(e) };
  }
});
// ZCode 自己的代理设置。它默认 direct 绕过系统代理，必须显式写 setting.json 才走代理。
ipcMain.handle('proxy:get', () => {
  try {
    return { ok: true, current: getZcodeProxy(), system: detectSystemProxy() };
  } catch (e) {
    return { ok: false, msg: e.message || String(e) };
  }
});
ipcMain.handle('proxy:set', (_e, url) => {
  try {
    const r = setZcodeProxy(url);
    return { ok: true, ...r };
  } catch (e) {
    return { ok: false, msg: e.message || String(e) };
  }
});
// 使用者在弹框里提交的输入（手机号 / 短信验证码 / 邮箱 / 激活链接）
ipcMain.handle('panel:answer', (_e, payload) => {
  const { id, value } = payload || {};
  if (!pendingAsk || (id && pendingAsk.id !== id)) return { ok: false, msg: '该输入请求已失效' };
  const p = pendingAsk;
  pendingAsk = null;
  lowerPanelAfterAsk();
  const v = value === undefined || value === null ? '' : String(value).trim();
  try { p.resolve(v || null); } catch (_) {}
  return { ok: true };
});
// 使用者在弹框里点了取消：driver 会收到 null 并终止本步
ipcMain.handle('panel:ask-abort', (_e, id) => {
  if (pendingAsk && id && pendingAsk.id !== id) return { ok: false, msg: '该输入请求已失效' };
  cancelPendingAsk('使用者取消了输入');
  return { ok: true };
});
ipcMain.handle('oauth:link', (_e, provider, mode) => buildManualAuthorizeLink(provider || 'bigmodel', mode || 'direct'));
ipcMain.handle('oauth:submit', (_e, input) => submitManualCode(input));
ipcMain.handle('balance:fetch', (_e, force) => balance.fetchBalance(force));
ipcMain.handle('app:open', async () => {
  const id = currentAccountId();
  if (!id) {
    return { ok: false, msg: '还没有选中账号。先在列表里切一个，或点「捕获当前登录」把当前账号存进来。' };
  }
  await killZCode();
  await wait(500);
  try {
    await launchZCode(id);
    return { ok: true };
  } catch (e) {
    return { ok: false, msg: (e && e.message) || String(e) };
  }
});
ipcMain.handle('app:quit', async () => {
  await killZCode();
  return { ok: true };
});

// 只允许一个面板实例。
// 两个实例会共用同一个账号库（.current 与各账号的 meta），而且都能执行
// 「切换账号」（杀客户端 + 重启到另一个数据根），互相打断对方。
// 第二个实例把已有窗口拉到前台，然后自己退出。
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const [win] = BrowserWindow.getAllWindows();
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  });

  app.whenReady().then(() => {
    protocol.handle('zcode', handleOAuthCallback);
    createWindow();
    // 预热客户端进程启动时间，避免首次写快照时判据拿不到值
    refreshZcodeStart().catch(() => {});
  });
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
