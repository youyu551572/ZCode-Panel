'use strict';
/**
 * chrome-auth.js —— A′ 方案：用**本机真实 Chrome** 完成 BigModel 授权，面板自动收尾
 *
 * 为什么不用面板内嵌窗口（实测结论，见 captcha-report §16）：
 *   POST /api/biz/code/smsCode/TencentVerifyCaptcha 在 Electron 里被阿里云 WAF 挑战
 *   （返回 HTML 挑战页 → 界面显示「请进行验证，通过后即可注册/登录」，人拖滑块也没用），
 *   而**同一台机器、同一个出口 IP** 的真 Chrome 同一个请求畅通（同一张真 ticket 直接「获取成功」）。
 *   社区也没有 ITNA(ssxmod_itna) 的现成实现，通用答案是「换通道」。
 *
 * 为什么不用本地 HTTP 回调桥（原设想，已实测否掉）：
 *   zcode 桥接页只放行 zcode:// 类目标——
 *   `?redirect=http://127.0.0.1:PORT/...` 与任意 `https://` 都会渲染
 *   「无法打开 ZCode / 登录回调地址无效」，所以改成**从页面里把回调 URL 取回来**。
 *
 * 关键设计：默认用 **bridge 模式**（`redirect = https://zcode.z.ai/app/oauth/login?redirect=zcode://oauth/callback…`）。
 * 登录完成后桥接页会渲染一个「打开 ZCode」的 `<a href="zcode://oauth/callback?authCode=…&state=…">`，
 * 直接读这个 href 就能拿到 code —— 不依赖“外部协议跳转”，也不会唤起官方 ZCode 客户端。
 *
 * 多账号注意（详见 path-a-prime-multi-account.md）：
 *   · 每次授权用**独立 profile 目录**（本模块默认临时目录，用完删）→ 新号不可能绑到上一个账号；
 *   · bigmodel 线必须**直连**（direct:true → --no-proxy-server），套代理会 ERR_CONNECTION_CLOSED；
 *   · 建议串行（面板本来就是单流程），同 IP 并发会抬高 WAF / 天御评分。
 *
 * 自检（不需要真登录）:
 *   node chrome-auth.js --selftest
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { MiniWS, CDP, findBrowser, freePort, httpGetJson } = require('./cdp-mini.js');
const { CAPTCHA_HOOK_SRC } = require('./captcha-hook.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isCallbackUrl = (u) => /^zcode:\/\//i.test(String(u || '')) || /^[a-z][a-z0-9+.-]*:\/\/oauth\/callback/i.test(String(u || ''));
const isExternalScheme = (u) => /^zcode:/i.test(String(u || ''));

/** 从回调 URL 里取 code / state（判据与 oauth.parseManualInput 一致：authCode 或 code） */
function parseCallback(url) {
  const raw = String(url || '').trim();
  if (!raw) return null;
  let m = /[?&](?:authCode|code)=([^&#\s]+)/.exec(raw);
  const code = m ? decodeURIComponent(m[1]) : null;
  m = /[?&]state=([^&#\s]+)/.exec(raw);
  const state = m ? decodeURIComponent(m[1]) : null;
  if (!code) return null;
  return { code, state, href: raw };
}

class ChromeAuth {
  /**
   * @param {object} o
   * @param {string} o.authorizeUrl  要打开的授权页
   * @param {string} o.state         本次 state（回调里必须一致）
   * @param {function} [o.onEvent]   进度上报 (evt) => void
   * @param {boolean} [o.direct]     默认 true：--no-proxy-server（bigmodel 必须直连）
   * @param {number} [o.timeoutMs]   默认 15 分钟
   * @param {string} [o.profileDir]  可指定；默认临时目录，close 时删除
   * @param {string} [o.browserPath] 可指定浏览器可执行文件
   * @param {string} [o.phone]       可选：自动填入手机号（不做任何点击）
   */
  constructor(o) {
    this.authorizeUrl = o.authorizeUrl;
    this.state = o.state;
    this.onEvent = typeof o.onEvent === 'function' ? o.onEvent : () => {};
    this.direct = o.direct !== false;
    this.timeoutMs = o.timeoutMs || 15 * 60 * 1000;
    this.phone = o.phone || '';
    this.browserPath = o.browserPath || '';
    this.profileDir = o.profileDir || path.join(os.tmpdir(), 'zcode-panel-chrome', String(o.state || Date.now()));
    this.keepProfile = !!o.keepProfile;
    this.child = null;
    this.port = 0;
    this.ws = null;
    this.cdp = null;
    this.sessions = new Map();       // sessionId → { url }
    this.callbackUrl = null;
    this.closed = false;
  }

  log(msg, level = 'info') { try { this.onEvent({ level, msg }); } catch (_) {} }

  async start() {
    const browser = findBrowser(this.browserPath);
    this.port = await freePort();
    fs.mkdirSync(this.profileDir, { recursive: true });
    const args = [
      `--remote-debugging-port=${this.port}`,
      `--user-data-dir=${this.profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--remote-allow-origins=*',
      '--disable-features=Translate,ChromeWhatsNewUI',
    ];
    if (this.direct) args.push('--no-proxy-server');   // bigmodel.cn 国内站点，套境外代理会被掐断
    args.push(this.authorizeUrl);
    this.child = spawn(browser, args, { stdio: 'ignore' });
    this.log(`已拉起真实 Chrome（${path.basename(browser)}，端口 ${this.port}，${this.direct ? '直连' : '跟随系统代理'}）`);

    const ver = await httpGetJson(`http://127.0.0.1:${this.port}/json/version`);
    this.ws = new MiniWS(ver.webSocketDebuggerUrl);
    await this.ws.connect();
    this.cdp = new CDP(this.ws);
    this.cdp.on((msg) => this.onCdpMessage(msg));
    await this.attachPage();
    return this;
  }

  /** 等目标标签页出现并挂上（Chrome 129+ 的 createTarget 会返回 tab target，这里统一按 type==='page' 找） */
  async attachPage(timeoutMs = 40000) {
    const deadline = Date.now() + timeoutMs;
    let page = null;
    while (Date.now() < deadline) {
      const list = (await this.cdp.call('Target.getTargets')).targetInfos || [];
      page = list.find((t) => t.type === 'page' && /(bigmodel\.cn|zhipuai\.cn|z\.ai)/.test(t.url || ''))
        || list.find((t) => t.type === 'page' && !/^(devtools|about:|chrome:)/i.test(t.url || ''));
      if (page) break;
      await sleep(600);
    }
    if (!page) throw new Error('等不到浏览器标签页（Chrome 可能没起来）');
    const { sessionId } = await this.cdp.call('Target.attachToTarget', { targetId: page.targetId, flatten: true });
    await this.setupSession(sessionId, page);
    this.log('已挂上登录页：' + String(page.url || '').slice(0, 90));
    return sessionId;
  }

  async setupSession(sessionId, info) {
    const S = (m, p) => this.cdp.call(m, p, sessionId);
    this.sessions.set(sessionId, { url: info.url || '' });
    try {
      await S('Page.enable');
      await S('Runtime.enable');
      await S('Network.enable', { maxPostDataSize: 4 * 1024 * 1024 });
      await S('Page.addScriptToEvaluateOnNewDocument', { source: CAPTCHA_HOOK_SRC });
      // 当前文档补注入（页面可能已经加载完）
      await S('Runtime.evaluate', {
        expression: '(function(s){ try { (0,eval)(s); return !!window.__helmdCaptchaHook; } catch(e){ return "err:"+e.message; } })(' + JSON.stringify(CAPTCHA_HOOK_SRC) + ')',
        returnByValue: true,
      });
    } catch (_) {}
    if (this.phone) this.fillPhoneWhenReady(sessionId).catch(() => {});
  }

  /** 挂上时表单往往还没渲染出来，所以按重试填号（默认最多 30 秒），而不是只试一次 */
  async fillPhoneWhenReady(sessionId, timeoutMs = 30000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const r = await this.fillPhone(sessionId).catch(() => null);
      if (r === 'filled') return true;
      await sleep(800);
    }
    this.log('自动填号超时（页面上没找到手机号输入框），请在窗口里手填', 'warn');
    return false;
  }

  onCdpMessage(msg) {
    const p = msg.params || {};
    if (msg.method === 'Target.attachedToTarget') {
      const info = p.targetInfo || {};
      if (/^(page|webview)$/.test(info.type || '')) this.setupSession(p.sessionId, info).catch(() => {});
      return;
    }
    if (msg.sessionId) this.sessions.set(msg.sessionId, Object.assign(this.sessions.get(msg.sessionId) || {}, { url: (this.sessions.get(msg.sessionId) || {}).url }));
    // ① 外部协议跳转请求（direct 模式下 bigmodel 会直接跳 zcode://）
    if (msg.method === 'Network.requestWillBeSent') {
      const u = (p.request || {}).url;
      if (isCallbackUrl(u)) this.capture(u, 'Network.requestWillBeSent');
      return;
    }
    // ② 导航请求（桥接页 location 赋值 / 点击「打开 ZCode」）
    if (msg.method === 'Page.frameRequestedNavigation') {
      if (isCallbackUrl(p.url)) this.capture(p.url, 'Page.frameRequestedNavigation');
      return;
    }
    if (msg.method === 'Page.frameNavigated') {
      const u = (p.frame || {}).url;
      if (isCallbackUrl(u)) this.capture(u, 'Page.frameNavigated');
      return;
    }
  }

  /** 收下一个候选回调；返回是否真的收下（无 code / state 不匹配都算没收下） */
  capture(url, via) {
    if (this.callbackUrl) return false;
    const parsed = parseCallback(url);
    if (!parsed) return false;              // 例如桥接页自带的 href="zcode://oauth/callback"（没有 code）
    if (this.state && parsed.state && parsed.state !== this.state) {
      this.log(`收到 state 不匹配的回调（${String(parsed.state).slice(0, 8)}…），忽略`, 'warn');
      return false;
    }
    this.callbackUrl = url;
    this.log(`已捕获回调（来源 ${via}）：code=${String(parsed.code).slice(0, 8)}… state=${String(parsed.state || '').slice(0, 8)}…`, 'ok');
    return true;
  }

  /** 从页面里读回调：桥接页的「打开 ZCode」是个 <a href="zcode://…">，这是最可靠的来源 */
  async scanPages() {
    for (const [sessionId, info] of [...this.sessions]) {
      try {
        const r = await this.cdp.call('Runtime.evaluate', {
          expression: `(() => {
            const out = [];
            try {
              for (const a of document.querySelectorAll('a[href^="zcode:"], a[href*="oauth/callback"]')) out.push(a.getAttribute('href') || a.href || '');
            } catch (e) {}
            try {
              const m = (document.documentElement.innerHTML || '').match(/zcode:\\/\\/oauth\\/callback\\?[^"'\\\\\\s<]{5,400}/);
              if (m) out.push(m[0].replace(/&amp;/g, '&'));
            } catch (e) {}
            return JSON.stringify(out);
          })()`,
          returnByValue: true,
        }, sessionId);
        if (r && r.exceptionDetails) {
          if (!this.scanErrLogged) { this.scanErrLogged = true; this.log('页面内扫描表达式异常：' + JSON.stringify(r.exceptionDetails).slice(0, 160), 'warn'); }
          continue;
        }
        const list = JSON.parse((r && r.result && r.result.value) || '[]');
        for (const u of list) {
          if (!parseCallback(u)) continue;   // 没 code 的不是候选（桥接页常驻一个 href="zcode://oauth/callback"）
          if (this.capture(u, '页面内 <a href> / 内联数据')) return true;
          // state 不匹配的候选跳过，继续看下一个
        }
      } catch (e) {
        // 页面正在导航时 evaluate 会失败，这是常态；只报一次免得刷屏
        if (!this.scanErrLogged) { this.scanErrLogged = true; this.log('页面内扫描失败（页面可能正在跳转）：' + (e.message || e), 'warn'); }
      }
    }
    return !!this.callbackUrl;
  }

  async probeCaptcha() {
    const out = {};
    for (const [sessionId] of this.sessions) {
      try {
        const r = await this.cdp.call('Runtime.evaluate', { expression: 'JSON.stringify(window.__helmdCaptcha || null)', returnByValue: true }, sessionId);
        if (r && r.result && r.result.value) out[sessionId] = JSON.parse(r.result.value);
      } catch (_) {}
    }
    return out;
  }

  async fillPhone(sessionId) {
    const r = await this.cdp.call('Runtime.evaluate', {
      expression: `(() => {
        const vis = (e) => e && e.offsetParent !== null;
        const inputs = Array.from(document.querySelectorAll('input')).filter(vis);
        const el = inputs.find((e) => /手机|电话|phone|mobile/i.test((e.placeholder || '') + (e.name || '')) || e.type === 'tel');
        if (!el) return 'no-input';
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(el, ${JSON.stringify(this.phone)});
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        el.dispatchEvent(new Event('blur', { bubbles: true }));
        return 'filled';
      })()`,
      returnByValue: true,
    }, sessionId).catch(() => null);
    const v = r && r.result && r.result.value;
    if (v === 'filled') this.log('已自动填入手机号');
    return v;
  }

  /** 找「获取验证码」按钮；dry=true 只找不点（供自检用） */
  async getIdCodeButton(sessionId, dry) {
    const r = await this.cdp.call('Runtime.evaluate', {
      expression: `(() => {
        const vis = (e) => e && e.offsetParent !== null;
        const btn = Array.from(document.querySelectorAll('button, a, div, span')).filter(vis)
          .find((e) => /^获取验证码s?$|^\\d+s$/.test((e.innerText || '').trim()));
        if (!btn) return 'no-button';
        const txt = (btn.innerText || '').trim();
        if (/^\\d+s$/.test(txt)) return 'counting:' + txt;
        if (${dry ? 'true' : 'false'}) return 'would-click:' + txt;
        btn.click();
        return 'clicked:' + txt;
      })()`,
      returnByValue: true,
    }, sessionId).catch(() => null);
    return (r && r.result && r.result.value) || 'eval-failed';
  }

  /** 填号之后自动点「获取验证码」（省掉一次点击；弹窗仍由人来过） */
  async autoClickGetCode() {
    for (const [sid] of this.sessions) {
      const v = await this.getIdCodeButton(sid, false);
      if (String(v).startsWith('clicked') || String(v).startsWith('counting')) {
        this.log('已自动点「获取验证码」：' + v, 'ok');
        return v;
      }
      if (v === 'no-button') continue;
      return v;
    }
    this.log('没找到「获取验证码」按钮，请在窗口里手动点一下', 'warn');
    return 'no-button';
  }

  /** 等到按钮进入倒计时（= 短信请求被服务端受理），说明人机验证已过、短信已下发 */
  async waitForCodeSent(timeoutMs = 5 * 60 * 1000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.callbackUrl) return false;
      for (const [sid] of this.sessions) {
        const v = await this.getIdCodeButton(sid, true);
        if (String(v).startsWith('counting')) { this.log('短信已下发（按钮进入倒计时 ' + String(v).split(':')[1] + '）', 'ok'); return true; }
      }
      await sleep(1200);
    }
    return false;
  }

  /** 填短信验证码 + 点「登录 / 注册」 */
  async fillSmsCodeAndSubmit(code) {
    for (const [sid] of this.sessions) {
      const r = await this.cdp.call('Runtime.evaluate', {
        expression: `(() => {
          const vis = (e) => e && e.offsetParent !== null;
          const inputs = Array.from(document.querySelectorAll('input')).filter(vis);
          const codeEl = inputs.find((e) => /验证码|校验码|code/i.test((e.placeholder || '') + (e.name || '')) && !/手机|电话|phone/i.test(e.placeholder || ''));
          if (!codeEl) return 'no-code-input';
          const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
          setter.call(codeEl, ${JSON.stringify(String(code))});
          for (const ev of ['input', 'change', 'blur']) codeEl.dispatchEvent(new Event(ev, { bubbles: true }));
          // 协议勾选
          for (const cb of Array.from(document.querySelectorAll('.el-checkbox__original, input[type="checkbox"]')).filter(vis)) { if (!cb.checked) cb.click(); }
          const btn = Array.from(document.querySelectorAll('button')).filter(vis)
            .find((b) => /^登录\\s*\\/\\s*注\\s*册$/.test((b.innerText || '').trim()));
          if (!btn) return 'filled-no-button';
          if (btn.disabled || btn.getAttribute('aria-disabled') === 'true') return 'filled-btn-disabled';
          btn.click();
          return 'filled-submitted';
        })()`,
        returnByValue: true,
      }, sid).catch(() => null);
      const v = (r && r.result && r.result.value) || 'eval-failed';
      if (v === 'filled-submitted') { this.log('已回填短信验证码并点「登录 / 注册」', 'ok'); return v; }
      if (v !== 'no-code-input') { this.log('回填结果：' + v, 'warn'); return v; }
    }
    return 'no-code-input';
  }

  /** 读人机验证弹窗给的提示语（滑块 / 依次点击 / 请依次点击：X Y Z），让面板直接告诉人该做什么 */
  async readChallengeHint() {
    for (const [sid, rec] of [...this.sessions]) {
      try {
        const r = await this.cdp.call('Runtime.evaluate', {
          expression: `(() => {
            const fr = Array.from(document.querySelectorAll('iframe')).find((f) => /turing\\.captcha|fengkongcloud/.test(f.src || ''));
            if (!fr) return '';
            try {
              const d = fr.contentDocument;
              if (!d) return 'iframe-cross-origin';
              const t = (d.body && d.body.innerText || '').replace(/\\s+/g, ' ').trim();
              return t.slice(0, 120);
            } catch (e) { return 'iframe-cross-origin'; }
          })()`,
          returnByValue: true,
        }, sid);
        const v = (r && r.result && r.result.value) || '';
        if (v && v !== 'iframe-cross-origin') return v;
        if (v === 'iframe-cross-origin' && !rec.hintLogged) { rec.hintLogged = true; return 'iframe-cross-origin'; }
      } catch (_) {}
    }
    return '';
  }
  async waitForCallback() {
    const deadline = Date.now() + this.timeoutMs;
    let lastCaptchaLog = 0;
    let napTimer = 0;
    while (Date.now() < deadline && !this.callbackUrl) {
      if (this.child && this.child.exitCode !== null) throw new Error('浏览器被关掉了，授权未完成');
      await sleep(700);
      if (this.callbackUrl) break;
      await this.scanPages();
      if (this.callbackUrl) break;
      if (Date.now() - lastCaptchaLog > 8000) {
        lastCaptchaLog = Date.now();
        // 把弹窗给的提示语转达给面板（「向右滑动完成拼图」/「请依次点击：…」），人就不用盯窗口猜
        const hint = await this.readChallengeHint().catch(() => '');
        if (hint && hint !== this._lastHint) {
          this._lastHint = hint;
          this.log('人机验证提示：' + hint, 'info');
        }
        const st = await this.probeCaptcha();
        for (const key of Object.keys(st)) {
          const c = st[key];
          if (c && (c.ticket || c.rid) && !napTimer) {
            const which = c.smcpRid ? '数美 Shumei' : (c.ticket ? '腾讯天御' : '未识别');
            this.log(`人机验证已通过（${which}）—— 继续在窗口里完成登录/注册`, 'ok');
            napTimer = 1;
          }
        }
      }
    }
    if (!this.callbackUrl) throw new Error('等回调超时（' + Math.round(this.timeoutMs / 1000) + ' 秒内没拿到 code）');
    return parseCallback(this.callbackUrl);
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    try { this.ws && this.ws.close(); } catch (_) {}
    try { if (this.child && this.child.exitCode === null) this.child.kill(); } catch (_) {}
    if (!this.keepProfile) {
      for (let i = 0; i < 6; i++) {
        try { fs.rmSync(this.profileDir, { recursive: true, force: true }); break; }
        catch (_) { await sleep(500); }
      }
    }
  }
}

/** 一步到位：拉起 → 等回调 → 返回 { code, state, href }，无论成败都会关掉 Chrome */
async function runRealChromeOAuth(o) {
  const a = new ChromeAuth(o);
  try {
    await a.start();
    if (o.phone) for (const [sid] of a.sessions) await a.fillPhoneWhenReady(sid).catch(() => {});
    // 自动点「获取验证码」——人只需要在弹窗上过一次验证
    if (o.autoClickGetCode !== false && o.phone) {
      await sleep(600);
      await a.autoClickGetCode();
      // 后台支线：等短信被受理 → 向面板要验证码 → 回填并点「登录 / 注册」
      (async () => {
        const sent = await a.waitForCodeSent(o.codeWaitMs || 5 * 60 * 1000);
        if (!sent || typeof o.askSmsCode !== 'function') return;
        const code = await o.askSmsCode();
        if (!code) { a.log('没拿到短信验证码，请在窗口里手填', 'warn'); return; }
        await a.fillSmsCodeAndSubmit(code);
      })().catch((e) => a.log('自动回填验证码支线异常：' + ((e && e.message) || e), 'warn'));
    }
    const parsed = await a.waitForCallback();
    return { ok: true, ...parsed, profileDir: a.profileDir };
  } finally {
    if (!o.keepOpen) await a.close();
  }
}

module.exports = { ChromeAuth, runRealChromeOAuth, parseCallback };

// ------------------------------------------------------------------ 自检 / 命令
if (require.main === module) {
  const argv = process.argv.slice(2);
  const has = (f) => argv.includes(f);
  if (has('--parse')) {
    const i = argv.indexOf('--parse');
    console.log(JSON.stringify(parseCallback(argv[i + 1]), null, 2));
    process.exit(0);
  }
  if (has('--selftest')) {
    (async () => {
      const state = require('crypto').randomBytes(16).toString('hex');
      const url = 'https://bigmodel.cn/login?redirect=' + encodeURIComponent('https://zcode.z.ai/app/oauth/login?redirect=' + encodeURIComponent('zcode://oauth/callback') + '&app_version=3.11.2') + '&appId=zcode&state=' + state;
      const a = new ChromeAuth({ authorizeUrl: url, state, timeoutMs: 45000, phone: '13800000000', onEvent: (e) => console.log(`  [${e.level}] ${e.msg}`) });
      console.log('[*] 自检：拉起真 Chrome → 打开授权页 → 注入钩子 → 填手机号（不点任何按钮、不等待登录）');
      await a.start();
      await sleep(6000);
      const sid = [...a.sessions.keys()][0];
      const probe = await a.cdp.call('Runtime.evaluate', {
        expression: `JSON.stringify({ hook: !!window.__helmdCaptchaHook, url: location.href.slice(0,80),
          phoneFilled: Array.from(document.querySelectorAll('input')).some(e => /^1\\d{10}$/.test(e.value||'')),
          getCodeBtn: Array.from(document.querySelectorAll('button,div,span')).some(e => /^获取验证码$/.test((e.innerText||'').trim())),
          captchaScript: Array.from(document.querySelectorAll('script')).map(s=>s.src).filter(u=>/TJCaptcha/.test(u)) })`,
        returnByValue: true,
      }, sid).catch((e) => ({ result: { value: 'err: ' + e.message } }));
      console.log('[*] 页面状态：' + (probe.result && probe.result.value));
      console.log('[*] 会话数：' + a.sessions.size);
      const parsed = parseCallback('zcode://oauth/callback?authCode=ABC123&state=' + state);
      console.log('[*] 回调解析自检：' + JSON.stringify(parsed));
      await a.close();
      console.log('[✓] 自检结束（未做登录，故不会真的拿到 code）');
      process.exit(0);
    })().catch((e) => { console.error('[x] ' + e.message); process.exit(1); });
    return;
  }
  if (has('--run')) {
    // 直接跑一次完整授权（与面板走同一条代码路径）：拉起真 Chrome → 你在窗口里注册/登录 → 自动取回 code
    (async () => {
      const arg = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
      const state = require('crypto').randomBytes(16).toString('hex');
      const bridge = 'https://zcode.z.ai/app/oauth/login?redirect=' + encodeURIComponent('zcode://oauth/callback') + '&app_version=3.11.2';
      const url = 'https://bigmodel.cn/login?redirect=' + encodeURIComponent(bridge) + '&appId=zcode&state=' + state;
      const phone = String(arg('--phone', '')).replace(/\D/g, '');
      const a = new ChromeAuth({
        authorizeUrl: url,
        state,
        timeoutMs: (Number(arg('--timeout', '900')) || 900) * 1000,
        phone,
        direct: arg('--proxy', 'no') !== 'yes',
        onEvent: (e) => console.log(`[${new Date().toTimeString().slice(0, 8)}] [${e.level}] ${e.msg}`),
      });
      console.log('[*] 模式：bridge（回调从桥接页的 <a href> 取回）　直连：' + (arg('--proxy', 'no') !== 'yes'));
      console.log('[*] 请在打开的 Chrome 里：填手机号 → 获取验证码 → 过弹窗 → 填验证码 → 登录');
      process.on('SIGINT', async () => { await a.close(); process.exit(0); });
      try {
        await a.start();
        if (phone) for (const [sid] of a.sessions) await a.fillPhoneWhenReady(sid).catch(() => {});
        const parsed = await a.waitForCallback();
        console.log('\n[✓] 拿到回调：');
        console.log('    code  = ' + parsed.code);
        console.log('    state = ' + parsed.state);
        console.log('    href  = ' + parsed.href);
      } catch (e) {
        console.error('[x] ' + e.message);
      } finally {
        await a.close();
      }
      process.exit(0);
    })().catch((e) => { console.error('[x] ' + e.message); process.exit(1); });
    return;
  }
  console.log('用法：node chrome-auth.js --selftest | --parse "<回调URL>" | --run [--phone 138xxxxxxxx] [--timeout 900] [--proxy yes]');
}
