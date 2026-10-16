'use strict';

/**
 * ZCode OAuth（Authorization Code）实现 —— BigModel / Z.ai 双线路。
 *
 * 逆向自官方客户端 app.asar 的 OAuth adapter：
 *
 *   BigModel（id = "bigmodel"）
 *     authorizeUrl : https://bigmodel.cn/login
 *     appId        : zcode
 *     redirectUri  : zcode://oauth/callback
 *     tokenUrl     : https://zcode.z.ai/api/v1/oauth/token
 *     userinfoUrl  : https://bigmodel.cn/api/biz/customer/getCustomerInfo
 *     授权参数      : redirect=<uri> & appId=<appId> & state=<state>
 *
 *   Z.ai（id = "zai"）
 *     authorizeUrl : https://chat.z.ai/api/oauth/authorize
 *     appId        : client_P8X5CMWmlaRO9gyO-KSqtg
 *     redirectUri  : zcode://oauth/callback
 *     tokenUrl     : https://zcode.z.ai/api/v1/oauth/token
 *     userinfoUrl  : https://chat.z.ai/api/oauth/userinfo
 *     授权参数      : redirect_uri & response_type=code & client_id & state
 *
 * 桌面端生产环境 redirectUri 为 https 桥接页：
 *   https://zcode.z.ai/app/oauth/login?redirect=zcode://oauth/callback&app_version=<ver>
 * 授权完成后桥接页把 code 转交 zcode:// 自定义协议。两种形态本模块都支持。
 *
 * 凭据落盘键名（与官方一致）：
 *   oauth:active_provider / oauth:<provider>:access_token
 *   oauth:<provider>:refresh_token / oauth:<provider>:user_info / zcodejwttoken
 */

const crypto = require('crypto');
const os = require('os');

const APP_VERSION = '3.11.2';
const ZCODE_ORIGIN = 'https://zcode.z.ai';
const DESKTOP_REDIRECT = 'zcode://oauth/callback';

const PROVIDERS = {
  bigmodel: {
    id: 'bigmodel',
    displayName: 'BigModel',
    authorizeUrl: 'https://bigmodel.cn/login',
    appId: 'zcode',
    redirectUri: DESKTOP_REDIRECT,
    tokenUrl: ZCODE_ORIGIN + '/api/v1/oauth/token',
    userinfoUrl: 'https://bigmodel.cn/api/biz/customer/getCustomerInfo',
    paramStyle: 'redirect-appId',
  },
  zai: {
    id: 'zai',
    displayName: 'Z.ai',
    authorizeUrl: 'https://chat.z.ai/api/oauth/authorize',
    appId: 'client_P8X5CMWmlaRO9gyO-KSqtg',
    redirectUri: DESKTOP_REDIRECT,
    tokenUrl: ZCODE_ORIGIN + '/api/v1/oauth/token',
    userinfoUrl: 'https://chat.z.ai/api/oauth/userinfo',
    businessLoginUrl: 'https://api.z.ai/api/auth/z/login',
    paramStyle: 'oauth2',
  },
};

// ---------------------------------------------------------------- redirect

function desktopRedirectUri(appVersion = APP_VERSION) {
  const u = new URL('/app/oauth/login', ZCODE_ORIGIN);
  u.searchParams.set('redirect', DESKTOP_REDIRECT);
  u.searchParams.set('app_version', appVersion);
  return u.toString();
}

function resolveRedirectUri(providerId, mode, appVersion) {
  if (mode === 'direct') return DESKTOP_REDIRECT;
  return desktopRedirectUri(appVersion);
}

function buildAuthorizeUrl(providerId, state, mode = 'bridge', appVersion = APP_VERSION) {
  const p = PROVIDERS[providerId];
  if (!p) throw new Error('未知 OAuth provider: ' + providerId);
  const redirectUri = resolveRedirectUri(providerId, mode, appVersion);
  const q = p.paramStyle === 'oauth2'
    ? new URLSearchParams({
        redirect_uri: redirectUri,
        response_type: 'code',
        client_id: p.appId,
        state,
      })
    : new URLSearchParams({
        redirect: redirectUri,
        appId: p.appId,
        state,
      });
  return { url: p.authorizeUrl + '?' + q.toString(), redirectUri, provider: providerId };
}

// ---------------------------------------------------------------- callback

// 官方 parseCallbackParams：authCode ?? code，配合 state
function parseCallbackUrl(input) {
  if (!input || typeof input !== 'string') return null;
  const raw = input.trim();
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) return null;
  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const code = url.searchParams.get('authCode') || url.searchParams.get('code');
  const state = url.searchParams.get('state');
  if (!code || !state) return null;
  return { code: code.trim(), state: state.trim(), href: raw };
}

function parseManualInput(input, state) {
  const raw = (input || '').trim();
  if (!raw) return null;
  const asUrl = parseCallbackUrl(raw);
  if (asUrl) return asUrl;
  if (state && raw === state) return null;
  return { code: raw, state: state || '', href: null };
}

// ---------------------------------------------------------------- token

function trimOrNull(v) {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

// 官方 resolveBigModelBusinessAccessToken 的回退链
function resolveAccessToken(providerId, data) {
  if (!data) return null;
  const bag = data[providerId] || {};
  for (const c of [bag.access_token, bag.accessToken, data.access_token, data.accessToken]) {
    const v = trimOrNull(c);
    if (v) return v;
  }
  return null;
}

function resolveRefreshToken(providerId, data) {
  if (!data) return null;
  const bag = data[providerId] || {};
  return trimOrNull(bag.refresh_token) || trimOrNull(bag.refreshToken) || null;
}

async function exchangeCode(providerId, code, state, redirectUri) {
  const p = PROVIDERS[providerId];
  if (!p) throw new Error('未知 OAuth provider: ' + providerId);

  const res = await fetch(p.tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      provider: providerId,
      code,
      redirect_uri: redirectUri || p.redirectUri,
      state: state || '',
    }),
  });

  const text = await res.text().catch(() => '');
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    throw new Error('token 响应不是 JSON（HTTP ' + res.status + '）：' + text.slice(0, 200));
  }
  if (!json) throw new Error('token 响应为空（HTTP ' + res.status + '）');
  if (json.code !== undefined && json.code !== 0) {
    throw new Error((json.msg && String(json.msg).trim()) || ('token 交换被拒绝（code: ' + json.code + '）'));
  }

  const data = json.data || {};
  const accessToken = resolveAccessToken(providerId, data);
  if (!accessToken) throw new Error('token 响应缺少 data.' + providerId + '.access_token');

  return {
    provider: providerId,
    accessToken,
    refreshToken: resolveRefreshToken(providerId, data),
    zcodeJwt: trimOrNull(data.token) || trimOrNull(data.zcodeJwtToken) || null,
    raw: data,
  };
}

async function fetchUserInfo(providerId, accessToken) {
  const p = PROVIDERS[providerId];
  if (!p) throw new Error('未知 OAuth provider: ' + providerId);
  try {
    const res = await fetch(p.userinfoUrl, {
      headers: {
        // 必须带 Bearer。实测 z.ai 不带前缀直接 401「Missing Authorization header」，
        // 拿不到用户名，账号就只能落成 user_<jwt尾号> 这种认不出来的名字。
        // bigmodel 两种写法都收，所以统一加上不会破坏它。
        authorization: /^Bearer\s/i.test(accessToken) ? accessToken : 'Bearer ' + accessToken,
        'content-type': 'application/json',
        accept: 'application/json',
      },
    });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { return null; }
    const d = (json && (json.data || json)) || {};
    // z.ai 顶层直接给 name / sub / email；bigmodel 包在 data 里且叫 customerName / customerNumber
    const name = trimOrNull(d.customerName) || trimOrNull(d.username)
      || trimOrNull(d.displayName) || trimOrNull(d.name) || trimOrNull(d.customerNumber);
    return {
      id: trimOrNull(d.customerNumber) || trimOrNull(d.id) || trimOrNull(d.sub) || 'unknown',
      username: name || 'user',
      displayName: name || 'user',
      email: trimOrNull(d.email) || null,
      avatarUrl: trimOrNull(d.avatar) || trimOrNull(d.picture) || null,
      raw: d,
    };
  } catch {
    return null;
  }
}

/**
 * Z.ai 侧需要用 oauth access_token 再换一次业务 token。
 *
 * ★ 这里**必须把换到的 token 带回去**，不能只回一个状态字符串。
 *
 *   以前本函数只 `return 'ready' / 'failed'`，调用方拿到状态就当没事了 ——
 *   于是 `oauth:zai:access_token` 落盘的仍是那个**短命的 OAuth token**。
 *   后果：客户端启动时判过期 → 把 credentials.json 清成 `{}` →
 *   界面显示「登录已过期，请重新登录」。
 *
 *   官方开源源码把契约写死了（zaiProviderAdapter）：
 *     · CLI flow 拿到的 **仍是 Z.ai OAuth token**
 *     · `oauth:zai:access_token` 的契约是 **POST api.z.ai 的 auth/z/login 换来的业务 token**
 *     · 「登录阶段完成转换…后续不再做兜底二次交换」
 *   ⇒ 转换必须在这里做完，而且**必须用返回的那个 token**。
 *
 * @returns {Promise<{ok:boolean, token:string|null, code:any, msg:string|null, expiresIn:any}>}
 */
async function triggerBusinessLogin(accessToken) {
  const p = PROVIDERS.zai;
  if (!p.businessLoginUrl) return { ok: false, token: null, code: null, msg: 'no-business-url' };
  const tok = trimOrNull(accessToken);
  if (!tok) return { ok: false, token: null, code: null, msg: 'empty-token' };
  try {
    const res = await fetch(p.businessLoginUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: tok }),
    });
    const json = await res.json().catch(() => null);
    if (!json) return { ok: false, token: null, code: null, msg: 'no-json' };
    const codeOk = json.code === 0 || json.code === 200 || json.code === '0' || json.code === '200';
    if (!codeOk || json.success === false) {
      return { ok: false, token: null, code: json.code, msg: json.msg || 'rejected' };
    }
    const data = json.data || {};
    const business = trimOrNull(data.access_token) || trimOrNull(data.accessToken);
    if (!business) return { ok: false, token: null, code: json.code, msg: '缺 data.access_token' };
    return { ok: true, token: business, code: json.code, msg: null, expiresIn: data.expires_in ?? null };
  } catch (e) {
    return { ok: false, token: null, code: null, msg: String((e && e.message) || e) };
  }
}

/** 读 JWT 载荷（不验签，只看形状）。解不动返回 null。 */
function decodeJwtPayloadLoose(token) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    return JSON.parse(Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

/**
 * 判断一个 token 是「业务 token」还是「OAuth token」。
 *
 * **判据必须看载荷特征键，不能看长度。** 长度是巧合，载荷形状是契约：
 *   · 业务 token：带 `user_key` / `customer_id`，**没有 `exp`**（实测 len≈1404）
 *   · OAuth token：`iss === 'user-service'`、带 `scopes`（实测 len≈404）
 *
 * @returns {{ok:boolean, gen:'business'|'oauth'|'unknown', exp:number|null, secondsLeft:number|null, payload:object|null}}
 */
function classifyToken(token, nowSec = Math.floor(Date.now() / 1000)) {
  const payload = decodeJwtPayloadLoose(token);
  if (!payload || typeof payload !== 'object') {
    return { ok: false, gen: 'unknown', exp: null, secondsLeft: null, payload: null };
  }
  const hasBiz = payload.user_key !== undefined || payload.customer_id !== undefined;
  const hasOauth = payload.iss === 'user-service'
    || payload.token_type === 'access_token'
    || payload.scopes !== undefined;
  const gen = hasBiz && !hasOauth ? 'business' : (hasOauth ? 'oauth' : 'unknown');
  const exp = Number.isFinite(Number(payload.exp)) ? Number(payload.exp) : null;
  return {
    ok: true,
    gen,
    exp,
    // 业务 token 没有 exp ⇒ secondsLeft 为 null（**不能**因此判它过期）
    secondsLeft: exp === null ? null : exp - nowSec,
    payload,
  };
}

/**
 * ★ 把 tokenSet 归一化成「客户端契约要求的形态」—— **落盘前必须过这一道**。
 *
 * 语义（别改成"失败就抛"）：换失败时**回退成原 token**，并如实标 `swapped:false` ——
 * 一次业务接口抽风不该把整个号的授权结果丢掉。
 *
 * 短路条件（各有一条实测依据）：
 *   · 已经是业务 token ⇒ 不重复兑换（业务 token 打 /z/login 会回 "user information is invalid"）
 *   · bigmodel 线 ⇒ /oauth/token 直接给长期 token，本就不需要这一步
 *   · 形状不像 OAuth ⇒ 不乱打接口
 *
 * 全程保留 `oauthAccessToken`：取用户信息必须用**原始 OAuth token**，
 * 业务 token 打 chat.z.ai 不认（那是给客户端本地登录态用的，不是 api 凭据）。
 *
 * @param {object} tokenSet
 * @param {object} [deps] 便于单测注入 { login }
 */
async function normalizeTokenSet(tokenSet, deps = {}) {
  if (!tokenSet || typeof tokenSet !== 'object') return tokenSet;
  const login = deps.login || triggerBusinessLogin;
  const p = String(tokenSet.provider || '');
  const tok = trimOrNull(tokenSet.accessToken);
  if (!tok) return { ...tokenSet, swapped: false, swapMsg: 'no-token' };

  const c = classifyToken(tok);
  if (c.gen === 'business') {
    return { ...tokenSet, oauthAccessToken: tok, swapped: false, swapMsg: 'already-business' };
  }
  if (p && p !== 'zai') {
    return { ...tokenSet, oauthAccessToken: tok, swapped: false, swapMsg: 'not-zai' };
  }
  if (c.gen !== 'oauth') {
    return { ...tokenSet, oauthAccessToken: tok, swapped: false, swapMsg: 'not-oauth-shaped' };
  }

  const r = await login(tok);
  if (r && r.ok && r.token) {
    return {
      ...tokenSet,
      accessToken: r.token,
      oauthAccessToken: tok,
      swapped: true,
      swapMsg: null,
      swapExpiresIn: r.expiresIn ?? null,
    };
  }
  return { ...tokenSet, oauthAccessToken: tok, swapped: false, swapMsg: (r && r.msg) || 'failed' };
}

// ---------------------------------------------------------------- crypto

const PREFIX = 'enc:v1:';
const ALGO = 'aes-256-gcm';
const NONCE_SIZE = 12;
const CREDENTIAL_SECRET_ENV = 'ZCODE_CREDENTIAL_SECRET';

function defaultCredentialSecret(env = process.env) {
  if (env[CREDENTIAL_SECRET_ENV]) return env[CREDENTIAL_SECRET_ENV];
  let username = 'unknown';
  try { username = os.userInfo().username; } catch (_) {}
  return `zcode-credential-fallback:${os.platform()}:${os.homedir()}:${username}`;
}

function deriveKey(secret = defaultCredentialSecret()) {
  return crypto.createHash('sha256').update(secret).digest();
}

function isEncrypted(value) {
  return typeof value === 'string' && value.startsWith(PREFIX);
}

function decrypt(value, secret = defaultCredentialSecret()) {
  if (!isEncrypted(value)) return value;
  const parts = value.slice(PREFIX.length).split('.');
  if (parts.length !== 3) throw new Error('enc:v1 格式不正确');
  const [noncePart, tagPart, cipherPart] = parts;
  const decipher = crypto.createDecipheriv(ALGO, deriveKey(secret), Buffer.from(noncePart, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagPart, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(cipherPart, 'base64url')), decipher.final()]).toString('utf8');
}

function encrypt(plainText, secret = defaultCredentialSecret()) {
  const nonce = crypto.randomBytes(NONCE_SIZE);
  const cipher = crypto.createCipheriv(ALGO, deriveKey(secret), nonce);
  const cipherText = Buffer.concat([cipher.update(String(plainText), 'utf8'), cipher.final()]);
  return [PREFIX, nonce.toString('base64url'), '.', cipher.getAuthTag().toString('base64url'), '.', cipherText.toString('base64url')].join('');
}

module.exports = {
  APP_VERSION,
  DESKTOP_REDIRECT,
  PROVIDERS,
  desktopRedirectUri,
  resolveRedirectUri,
  buildAuthorizeUrl,
  parseCallbackUrl,
  parseManualInput,
  exchangeCode,
  fetchUserInfo,
  triggerBusinessLogin,
  // 落盘前的 token 归一化：OAuth token → 业务 token
  normalizeTokenSet,
  classifyToken,
  decodeJwtPayloadLoose,
  encrypt,
  decrypt,
  isEncrypted,
  defaultCredentialSecret,
};
