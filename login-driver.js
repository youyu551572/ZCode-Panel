'use strict';

/**
 * 登录窗口自动化驱动。
 *
 * 两条流程，共用同一套页面操作基础设施：
 *
 *   LoginDriver（BigModel 手机号）
 *     面板问手机号 -> 填手机号 -> 勾协议 -> 人工点获取验证码并过人机验证
 *     -> 面板问短信验证码 -> 回填 -> 自动点登录 -> 自动确认授权
 *
 *   ZaiMailDriver（Z.ai 邮箱注册）
 *     点「注册」-> 面板问邮箱 -> 填名称/邮箱/密码 -> 人工过人机验证
 *     -> 自动点创建账号 -> 面板问激活链接 -> 在同一窗口打开链接
 *
 * 手机号、短信验证码、邮箱、激活链接一律由使用者自己提供（面板弹框输入），
 * 驱动不持有任何取号 / 收信通道。
 *
 * 关键约束：
 *   - 激活链接必须用 win.loadURL 在原窗口打开。若交给系统浏览器，
 *     新窗口没有该 partition 的会话，用户得重新登录一遍。
 *   - 每步幂等、失败只记录不抛错，使用者随时可以接管操作。
 *   - Vue/React 受控输入必须走 native setter + input 事件。
 */

const STEP_INTERVAL_MS = 600;
const ELEMENT_WAIT_MS = 30000;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------- 基础设施

class BaseDriver {
  constructor({ win, log, emitPrefix = '', ask = null } = {}) {
    this.win = win;
    this.emit = typeof log === 'function' ? log : () => {};
    this.prefix = emitPrefix;
    this.ask = typeof ask === 'function' ? ask : null;
    this.stopped = false;
    this.phase = 'idle';
    this.lastError = null;
  }

  get alive() {
    return !this.stopped && this.win && !this.win.isDestroyed();
  }

  log(msg, level = 'info') {
    this.emit({ level, msg, phase: this.phase });
  }

  setPhase(p) {
    this.phase = p;
    this.emit({ level: 'phase', msg: p, phase: p });
  }

  stop(reason = 'stopped') {
    if (this.stopped) return;
    this.stopped = true;
    this.log(`自动化已停止（${reason}）`, 'warn');
  }

  ok(msg) { this.log(msg, 'ok'); }
  warn(msg) { this.log(msg, 'warn'); }
  fail(msg) { this.lastError = msg; this.log(msg, 'error'); }

  /**
   * 需要使用者手动介入的提示（人机验证、手动点提交…）。
   *
   * active=true 表示现在轮到你动手，面板会亮出顶部那条提示；
   * active=false 表示这一步已经过去、自动化接着往下跑，提示随之收起。
   * 人机验证是整条流程里唯一必须人工的环节，不能只丢一行普通日志——
   * 埋在日志流里根本注意不到，人会一直干等。
   */
  manual(msg, active = true) {
    this.emit({ level: 'manual', msg, phase: this.phase, manual: true, active });
  }

  /**
   * 向使用者要一段文本（手机号 / 短信验证码 / 邮箱 / 激活链接）。
   *
   * 面板会弹出一个输入框；使用者填完提交后这里才继续往下走，取消则返回 null。
   * 自动化停掉时立刻收口，避免人已经关掉窗口、流程还挂在等待上。
   */
  async askText({ kind, label, placeholder = '', hint = '', validate = null }) {
    if (!this.ask) { this.fail('面板未提供输入通道'); return null; }
    this.manual(label, true);
    let value = null;
    try {
      value = await this.ask({ kind, label, placeholder, hint, validate });
    } catch (e) {
      this.warn('输入环节异常：' + ((e && e.message) || e));
      return null;
    } finally {
      this.manual('', false);
    }
    if (value === null || value === undefined || value === '') return null;
    return String(value).trim();
  }

  /** 在登录页主世界执行一段函数，参数以 JSON 传递 */
  async eval(fn, ...args) {
    if (!this.alive) return null;
    const argSrc = args.map((a) => JSON.stringify(a === undefined ? null : a)).join(', ');
    const src = `(function(){ return (${fn.toString()})(${argSrc}); })()`;
    try {
      return await this.win.webContents.executeJavaScript(src, true);
    } catch (_) {
      // 页面导航中执行会失败，属正常
      return null;
    }
  }

  async waitFor(fn, { timeout = ELEMENT_WAIT_MS } = {}) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline && this.alive) {
      const ok = await this.eval(fn);
      if (ok) return true;
      await sleep(STEP_INTERVAL_MS);
    }
    return false;
  }

  currentUrl() {
    try {
      return this.win && !this.win.isDestroyed() ? this.win.webContents.getURL() : '';
    } catch (_) {
      return '';
    }
  }

  /** 在窗口内导航（保留本窗口会话，这是激活链接必须走这里的理由） */
  async navigate(url) {
    if (!this.alive) return false;
    try {
      await this.win.webContents.loadURL(url);
      return true;
    } catch (e) {
      this.warn('窗口内导航失败：' + (e.message || e));
      return false;
    }
  }

  /**
   * 勾选页面上的协议复选框。
   *
   * 这类自绘控件的原生 input 常是 opacity:0 铺在自绘方块上。
   * 必须走真实 click() —— 它不受不可见影响，且能触发 React 的 onChange；
   * 直接改 .checked 框架不认，「继续」按钮会一直是禁用态。
   * 返回 'checked' | 'already-checked' | 'no-checkbox' | 'failed'
   */
  ensureAgreementChecked() {
    return this.eval(() => {
      const vis = (e) => e && e.offsetParent !== null;
      const cbs = Array.from(document.querySelectorAll('input[type=checkbox]'));
      if (!cbs.length) return 'no-checkbox';
      const target = cbs.find((cb) => vis(cb) && !cb.checked);
      if (!target) return cbs.some((cb) => cb.checked) ? 'already-checked' : 'no-checkbox';
      target.click();
      if (!target.checked) {
        // click 被拦下的兜底：置位并补发事件
        target.checked = true;
        target.dispatchEvent(new Event('input', { bubbles: true }));
        target.dispatchEvent(new Event('change', { bubbles: true }));
      }
      return target.checked ? 'checked' : 'failed';
    });
  }

  /**
   * 授权页确认：勾协议 + 点「继续」。
   *
   * BigModel 与 Z.ai 落地的是同一套授权页，两家都要这一步，
   * 所以放在基类里共用。协议不勾，「继续」按不动；勾选是异步驱动按钮状态的，
   * 勾完还得等它真变成可点再点，否则点了个寂寞。
   *
   * 返回 'clicked' | 'no-button' | 'click-failed' | 'stopped'
   */
  async confirmAuthorize({ timeout = 90000 } = {}) {
    const labels = await this.waitFor(() => {
      const vis = (e) => e && e.offsetParent !== null;
      const t = document.body.innerText || '';
      // 授权页的特征：出现协议类文案 + 有按钮
      return Array.from(document.querySelectorAll('button'))
        .some((b) => vis(b) && /^(继续|同意|确认授权|授权|确认)$/.test((b.innerText || '').trim()))
        || /同意授权|授权登录|authorize/i.test(t);
    }, { timeout });

    if (!labels) return this.alive ? 'no-button' : 'stopped';
    if (!this.alive) return 'stopped';

    const st = await this.ensureAgreementChecked();
    if (st === 'checked') this.ok('已勾选用户协议');
    else if (st === 'already-checked') this.log('用户协议已是勾选态');
    else if (st === 'no-checkbox') this.warn('授权页没找到协议勾选框');
    else this.warn('协议勾选失败，若「继续」点不动请手动勾一下');

    // 勾选会异步驱动按钮状态，等它真正可点
    const usable = await this.waitFor(() => {
      const vis = (e) => e && e.offsetParent !== null;
      const b = Array.from(document.querySelectorAll('button')).filter(vis)
        .find((x) => /^(继续|同意|确认授权|授权|确认)$/.test((x.innerText || '').trim()));
      return !!b && !b.disabled && b.getAttribute('aria-disabled') !== 'true';
    }, { timeout: 20000 });
    if (!usable) this.warn('「继续」仍不可点，可能协议没勾上');

    const clicked = await this.eval(PAGE_CLICK_TEXT, ['继续', '同意', '确认授权', '授权', '确认'], { exact: true });
    if (clicked) this.ok('已点「继续」，授权确认完成');
    return clicked ? 'clicked' : 'click-failed';
  }
}

// ---------------------------------------------------------------- 公共页面动作

/** Vue/React 受控输入：必须用原生 setter 再派发事件，否则框架状态不更新 */
const PAGE_FILL = function (selectorSpec, value) {
  const norm = (s) => String(s || '').replace(/\s+/g, '');
  const inputs = Array.from(document.querySelectorAll('input, textarea')).filter((e) => e.offsetParent !== null);
  let el = null;
  if (selectorSpec.selector) {
    try { el = document.querySelector(selectorSpec.selector); } catch (_) { el = null; }
  }
  if (!el && selectorSpec.placeholder) {
    el = inputs.find((e) => norm(e.placeholder).includes(norm(selectorSpec.placeholder)));
  }
  if (!el && selectorSpec.type) {
    el = inputs.find((e) => e.type === selectorSpec.type);
  }
  if (!el || el.offsetParent === null) return false;

  const desc = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
  const setter = desc && desc.set;
  if (setter) setter.call(el, String(value));
  else el.value = String(value);

  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  el.dispatchEvent(new Event('blur', { bubbles: true }));
  return (el.value || '') === String(value);
};

/** 按文案点按钮，优先真正的 button 元素 */
const PAGE_CLICK_TEXT = function (texts, opts) {
  const want = (texts || []).map((t) => String(t).trim());
  const exact = !opts || opts.exact !== false;
  const visible = Array.from(document.querySelectorAll('button, a, div, span, [role="button"]'))
    .filter((e) => e.offsetParent !== null && !e.disabled);
  const match = (t) => want.some((w) => (exact ? t === w : t.includes(w)));
  const cands = visible.filter((e) => match((e.innerText || '').trim()));
  if (!cands.length) return false;
  // 文案命中的既有容器也有内层 span：优先真 button，否则选最内层让其冒泡
  const btn = cands.find((e) => e.tagName === 'BUTTON') || cands[cands.length - 1];
  btn.click();
  return true;
};

// ---------------------------------------------------------------- BigModel 手机号

/**
 * BigModel 手机号登录。
 *
 * 分工：手机号、点「获取验证码」、过腾讯拼图、填验证码全部由人在窗口里手动完成；
 * 驱动只管两件机器该干的事——
 *   1. 等手机号和验证码都填好了，自动点「登录 / 注册」
 *   2. 登录后落到授权页，自动勾协议 + 点「继续」
 *
 * 为什么不能拿"提交按钮可点"当信号：实测登录页一加载完，「登录 / 注册」的
 * disabled 就是 false。若等这个条件再点，等于在人还没填完时空提交一次。
 * 必须两个输入框都有有效值才点。
 */
class LoginDriver extends BaseDriver {
  constructor({ win, log, ask, timeoutMs = 20 * 60 * 1000, clickGapMs = 4500 }) {
    super({ win, log, ask });
    this.timeoutMs = timeoutMs;
    this.clickGapMs = clickGapMs;
    this.lastClickAt = 0;
    this.lastCode = null;
    this.phone = null;
  }

  /** 登录/注册提交按钮。文案带斜杠和空格两种写法都试 */
  clickLogin() {
    return this.eval(PAGE_CLICK_TEXT, ['登录 / 注册', '登录/注册', '登录 / 注 册'], { exact: true });
  }

  checkAgreement() {
    return this.eval(() => {
      const boxes = Array.from(
        document.querySelectorAll('.el-checkbox__original, input[type="checkbox"]')
      ).filter((e) => e.offsetParent !== null);
      if (!boxes.length) return false;
      for (const cb of boxes) { if (!cb.checked) cb.click(); }
      return true;
    });
  }

  /** 登录表单当前状态 */
  probeForm() {
    return this.eval(() => {
      const vis = (e) => e && e.offsetParent !== null;
      const inputs = Array.from(document.querySelectorAll('input')).filter(vis);
      const digits = (v) => String(v || '').replace(/\D/g, '');
      const byPh = (re) => inputs.find((e) => re.test(e.placeholder || ''));
      const phoneEl = byPh(/手机|电话/);
      const codeEl = byPh(/验证码|校验码/);
      const btn = Array.from(document.querySelectorAll('button')).filter(vis)
        .find((b) => /^登录\s*\/\s*注\s*册$/.test((b.innerText || '').trim()));
      const phone = phoneEl ? digits(phoneEl.value) : '';
      const code = codeEl ? digits(codeEl.value) : '';
      return {
        hasForm: !!phoneEl && !!codeEl,
        phone, code,
        phoneOk: phone.length >= 11,
        codeOk: code.length >= 4,
        btnOk: !!btn && !btn.disabled && btn.getAttribute('aria-disabled') !== 'true',
        needAgree: Array.from(document.querySelectorAll('input[type="checkbox"]'))
          .filter(vis).some((c) => !c.checked),
      };
    });
  }

  /** 是否已经落到授权确认页 */
  onAuthorizePage() {
    return this.eval(() => {
      const vis = (e) => e && e.offsetParent !== null;
      if (/请输入验证码|请输入手机号/.test(document.body.innerText || '')) return false;
      return Array.from(document.querySelectorAll('button')).filter(vis)
        .some((b) => /^(继续|同意|确认授权|授权|确认)$/.test((b.innerText || '').trim()));
    });
  }

  async run() {
    try {
      this.setPhase('waiting-page');
      const ready = await this.waitFor(
        () => !!Array.from(document.querySelectorAll('input')).find(
          (e) => /手机|电话/.test(e.placeholder || '') || e.type === 'tel'
        ),
        { timeout: 45000 }
      );
      if (!ready) { this.fail('登录页未出现手机号输入框'); return { ok: false, msg: this.lastError }; }
      this.ok('登录页已就绪');

      this.manual('请填写手机号 → 点「获取验证码」→ 过拼图验证 → 填写收到的验证码；填好后会自动点「登录 / 注册」');

      this.setPhase('waiting-user');
      const deadline = Date.now() + this.timeoutMs;
      let submits = 0;
      let authorized = false;

      while (Date.now() < deadline && this.alive && !authorized) {
        if (await this.onAuthorizePage()) { authorized = true; break; }
        const s = await this.probeForm();
        if (s && s.hasForm && s.phoneOk && s.codeOk) {
          this.phone = s.phone;
          if (s.needAgree) await this.checkAgreement();
          // 只有验证码变过才重提：填错时反复原样提交最容易招风控
          const changed = s.code !== this.lastCode;
          if (s.btnOk && changed && Date.now() - this.lastClickAt > this.clickGapMs) {
            this.lastClickAt = Date.now();
            this.lastCode = s.code;
            if (await this.clickLogin()) {
              submits += 1;
              this.ok(`已自动点「登录 / 注册」（手机号 ${s.phone}，验证码 ${s.code}）`);
            }
          }
        }
        await sleep(900);
      }

      if (!this.alive) return { ok: false, msg: '自动化已停止', phone: this.phone };
      if (!authorized) {
        this.fail('等不到授权确认页，请确认窗口还开着');
        return { ok: false, msg: this.lastError, submits };
      }

      this.manual('', false);
      this.setPhase('confirm-authorize');
      const auth = await this.confirmAuthorize({ timeout: 60000 });
      if (auth === 'no-button') this.manual('若窗口停在授权页，请手动勾选协议并点「继续」');
      else if (auth === 'click-failed') this.manual('「继续」按钮点击失败，请手动点一下');

      this.setPhase('done');
      return { ok: true, phone: this.phone, submits, authorize: auth };
    } catch (e) {
      this.fail('自动化异常：' + (e.message || e));
      return { ok: false, msg: this.lastError, phone: this.phone };
    }
  }
}


// ---------------------------------------------------------------- Z.ai 邮箱注册

class ZaiMailDriver extends BaseDriver {
  constructor({ win, log, ask, authorizeUrl = null, timeoutMs = 20 * 60 * 1000, formSettleMs = 12000 }) {
    super({ win, log, ask });
    this.authorizeUrl = authorizeUrl;
    this.timeoutMs = timeoutMs;
    this.formSettleMs = formSettleMs;
    this.email = null;
    this.password = null;
    this.displayName = null;
    this.verifyLink = null;
  }

  /** 注册表单是否已出现 */
  probeSignup() {
    return this.eval(() => {
      const vis = (e) => e && e.offsetParent !== null;
      const inputs = Array.from(document.querySelectorAll('input')).filter(vis);
      const email = inputs.find((e) => e.type === 'email');
      const pw = inputs.find((e) => e.type === 'password');
      const name = inputs.find((e) => (e.autocomplete || '') === 'name')
        || inputs.find((e) => e.type === 'text' && !e.offsetParent === false);
      const btns = Array.from(document.querySelectorAll('button, a, div, span'))
        .filter(vis).map((e) => (e.innerText || '').trim());
      return {
        hasEmail: !!email,
        hasPassword: !!pw,
        hasName: !!name,
        hasCreate: btns.includes('创建账号'),
        hasVerifyBtn: btns.includes('点击开始验证'),
        url: location.href,
      };
    });
  }

  clickRegisterTab() {
    return this.eval(PAGE_CLICK_TEXT, ['注册'], { exact: true });
  }

  clickCreate() {
    return this.eval(PAGE_CLICK_TEXT, ['创建账号', '注册'], { exact: true });
  }

  /**
   * 勾选授权页的协议复选框 —— 不勾，「继续」按不动。
   * 实现已提到 BaseDriver（BigModel 那条线也要用），这里只留指向。
   */

  /** 页面当前状态：是否已发出注册请求 / 是否提示查收邮件 */
  probeAfterCreate() {
    return this.eval(() => {
      const body = (document.body.innerText || '').replace(/\s+/g, ' ');
      return {
        url: location.href,
        sentHint: /验证邮件|已发送|查收|check your email|verify your email/i.test(body),
        errorHint: (body.match(/(错误|失败|频繁|重试|稍后|无效|已被|已存在|重复|invalid|error|too many|rate limit|try again)[^\s。]{0,40}/i) || [])[0] || null,
        snippet: body.slice(0, 300),
      };
    });
  }

  /** 邮箱验证后的第二步表单：填「密码」+「确认密码」 */
  fillPasswordTwice(password) {
    return this.eval((pw) => {
      const vis = Array.from(document.querySelectorAll('input')).filter((e) => e.offsetParent !== null);
      const pws = vis.filter((e) => e.type === 'password');
      if (pws.length < 2) return false;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      for (const el of pws) {
        setter.call(el, String(pw));
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        el.dispatchEvent(new Event('blur', { bubbles: true }));
      }
      return true;
    }, password);
  }

  /** 探测人机验证类型与凭据状态（纯观察，不点击任何东西） */
  probeChallenge() {
    return this.eval(() => {
      const vis = (e) => e && e.offsetParent !== null;
      const inputs = Array.from(document.querySelectorAll('input'));
      const len = (name) => {
        const el = inputs.find((e) => e.name === name);
        return el ? String(el.value || '').length : -1; // -1 = 页面无该字段
      };
      const kinds = [];
      if (document.querySelector('iframe[src*="challenges.cloudflare.com"]') || document.querySelector('.cf-turnstile')) kinds.push('Cloudflare Turnstile');
      if (document.querySelector('iframe[src*="recaptcha"]') || document.querySelector('.g-recaptcha')) kinds.push('Google reCAPTCHA');
      if (document.querySelector('iframe[src*="hcaptcha"]') || document.querySelector('.h-captcha')) kinds.push('hCaptcha');
      if (document.querySelector('[class*="geetest"], [class*="gt_"]')) kinds.push('极验 Geetest');
      if (document.querySelector('canvas')) kinds.push('canvas 自绘');
      const btn = Array.from(document.querySelectorAll('button, a, div, span'))
        .filter(vis).find((e) => (e.innerText || '').trim() === '点击开始验证');
      if (btn) kinds.push('自定义「点击开始验证」按钮');
      const body = document.body.innerText || '';
      return {
        kinds,
        tokens: {
          turnstile: len('cf-turnstile-response'),
          recaptcha: len('g-recaptcha-response'),
          hcaptcha: len('h-captcha-response'),
        },
        hiddenInputs: inputs.filter((e) => e.type === 'hidden')
          .map((e) => ({ name: e.name || '(未命名)', len: String(e.value || '').length })),
        verifyBtnVisible: !!btn,
        // 验证过关后「点击开始验证」按钮会换成「验证通过！」文案：
        // 按钮消失 + 出现该文案，才是真的过了（只看文案可能被别处提示误伤）
        verifyPassed: !btn && /验证通过|验证成功/.test(body),
        iframes: Array.from(document.querySelectorAll('iframe')).map((f) => (f.src || '').slice(0, 110)).filter(Boolean),
      };
    });
  }

  /** 把人机验证探测结果写进日志，便于定位是哪家方案 */
  reportChallenge(c) {
    if (!c) { this.warn('没能探测到人机验证信息'); return; }
    this.log(`人机验证类型：${c.kinds.length ? c.kinds.join(' / ') : '未识别到已知类型'}`);
    const t = c.tokens || {};
    this.log(`凭据长度 turnstile=${t.turnstile} recaptcha=${t.recaptcha} hcaptcha=${t.hcaptcha}（-1 表示页面无该字段）`);
    if (c.iframes && c.iframes.length) this.log('页面 iframe：' + c.iframes.join(' | '));
    if (c.hiddenInputs && c.hiddenInputs.length) {
      this.log('隐藏字段：' + c.hiddenInputs.map((h) => `${h.name}(len=${h.len})`).join(', '));
    }
  }

  /** 注册表单当前状态：名称 / 邮箱 / 密码填好了没、提交按钮在不在 */
  probeForm() {
    return this.eval(() => {
      const vis = (e) => e && e.offsetParent !== null;
      const inputs = Array.from(document.querySelectorAll('input')).filter(vis);
      const emailEl = inputs.find((e) => e.type === 'email')
        || inputs.find((e) => /邮箱|mail/i.test(e.placeholder || ''));
      const pwdEl = inputs.find((e) => e.type === 'password')
        || inputs.find((e) => /密码|password/i.test(e.placeholder || ''));
      const nameEl = inputs.find((e) => /名称|昵称|名字/i.test(e.placeholder || ''));
      const btn = Array.from(document.querySelectorAll('button')).filter(vis)
        .find((b) => (b.innerText || '').trim() === '创建账号');
      const email = emailEl ? String(emailEl.value || '').trim() : '';
      const pwd = pwdEl ? String(pwdEl.value || '') : '';
      const name = nameEl ? String(nameEl.value || '').trim() : '';
      return {
        hasForm: !!emailEl && !!pwdEl,
        email, name, password: pwd,
        emailOk: /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email),
        nameOk: nameEl ? name.length > 0 : true,
        pwdOk: pwd.length >= 6,
        btnOk: !!btn && !btn.disabled,
      };
    });
  }

  /** 是否已经落到授权确认页（注册表单还在就说明没到） */
  onAuthorizePage() {
    return this.eval(() => {
      const vis = (e) => e && e.offsetParent !== null;
      const t = document.body.innerText || '';
      if (/输入您的电子邮箱|输入您的密码|创建账号/.test(t)) return false;
      return Array.from(document.querySelectorAll('button')).filter(vis)
        .some((b) => /^(继续|同意|确认授权|授权|确认)$/.test((b.innerText || '').trim()));
    });
  }

  /** 读授权页上出现的全部邮箱，用来核对是不是本次注册的那个账号 */
  readShownEmails() {
    return this.eval(() => {
      const t = document.body.innerText || '';
      const all = t.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) || [];
      return Array.from(new Set(all));
    }).then((r) => (Array.isArray(r) ? r : []));
  }

  async run() {
    try {
      this.setPhase('waiting-page');
      const ready = await this.waitFor(
        () => !!Array.from(document.querySelectorAll('input')).find((e) => e.offsetParent !== null),
        { timeout: 45000 }
      );
      if (!ready) { this.fail('Z.ai 登录页未加载出表单'); return { ok: false, msg: this.lastError }; }
      this.ok('Z.ai 登录页已就绪');

      // 先把页面实际长什么样记一笔。注册入口在不在、落在哪个地址，
      // 是判断「访问到的是不是国际版」的第一手依据，别等失败了再回头猜。
      const probe0 = await this.probeSignup();
      if (probe0) {
        this.log('页面：' + probe0.url + '　邮箱框=' + (probe0.hasEmail ? '有' : '无')
          + ' 密码框=' + (probe0.hasPassword ? '有' : '无')
          + ' 创建账号=' + (probe0.hasCreate ? '有' : '无'));
      }

      // ---- 1. 自动切到注册表单（这一步该机器干）
      this.setPhase('open-signup');
      let st = await this.probeSignup();
      if (st && !st.hasCreate) {
        await this.clickRegisterTab();
        for (let i = 0; i < 12 && this.alive; i += 1) {
          await sleep(700);
          st = await this.probeSignup();
          if (st && st.hasCreate) break;
        }
      }
      if (!st || !st.hasCreate) {
        // 国际版才有邮箱注册入口。点了「注册」还找不到「创建账号」，
        // 基本就是没连上国际版——直接说清楚，别让人对着「未找到表单」干猜。
        this.fail('未找到「创建账号」表单');
        this.manual('页面没有邮箱注册入口。请确认加速器已开启并连到境外节点，再重新点「Z.ai 邮箱注册」');
        return { ok: false, msg: this.lastError };
      }
      this.ok('已切到注册表单');

      // ---- 2. 名称 / 邮箱 / 密码 + 人机验证都由使用者在窗口里完成
      this.manual('请填写名称、电子邮箱、密码，并点「点击开始验证」完成人机验证；填好后会自动点「创建账号」');

      this.setPhase('waiting-user');
      const deadline = Date.now() + this.timeoutMs;
      const startedAt = Date.now();
      let submitted = false;
      let submittedEmail = null;
      let authorized = false;
      let nudged = false;
      let settleAt = 0;        // 表单首次填满的时间点 + 宽限期
      let nextAttemptAt = 0;   // 提交被拒后的退避时间点

      while (Date.now() < deadline && this.alive && !authorized) {
        if (await this.onAuthorizePage()) { authorized = true; break; }

        // 每轮先看页面状态：使用者也可能自己点了「创建账号」，那同样往下走
        const pre = await this.probeAfterCreate();
        if (pre && pre.sentHint) {
          const s0 = await this.probeForm();
          if (s0 && s0.email) { this.email = s0.email; this.password = s0.password; this.displayName = s0.name; }
          submitted = true;
          break;
        }
        // 提交被拒（多半是人机验证还没过）→ 放行重试，等使用者过完验证再点一次
        if (pre && pre.errorHint && submittedEmail) {
          this.warn('上次提交未通过：' + pre.errorHint + '　过完人机验证后会自动再试');
          submittedEmail = null;
          nextAttemptAt = Date.now() + 12000;
        }

        const s = await this.probeForm();
        if (s && s.hasForm && s.emailOk && s.pwdOk && s.nameOk) {
          this.email = s.email;
          this.password = s.password;  // 激活之后还要再填一次密码，沿用同一个
          this.displayName = s.name;
          if (!settleAt) settleAt = Date.now() + this.formSettleMs;

          // 不去猜人机验证过没过：阿里云验证组件的 DOM 会随框架重渲染整体
          // 消失又重建，拿"入口还在不在"当判据必然是错的（实测 t+12s 元素数
          // 直接归零，而验证根本没通过）。
          // 改为留一段宽限期让使用者先把验证做完，再去点；被拒就退避重试。
          const changed = s.email !== submittedEmail;
          if (s.btnOk && changed && Date.now() >= settleAt && Date.now() >= nextAttemptAt) {
            submittedEmail = s.email;
            nextAttemptAt = Date.now() + 12000;
            if (await this.clickCreate()) {
              this.ok('已自动点「创建账号」（邮箱 ' + s.email + '）');
            }
          } else if (!nudged && Date.now() - startedAt > 45000 && !submittedEmail) {
            nudged = true;
            this.manual('表单已填好。过完人机验证后会自动提交；若一直没动静，请手动点一次「创建账号」。');
          }
        }
        await sleep(900);
      }

      if (!this.alive) return { ok: false, msg: '自动化已停止', email: this.email };
      if (!authorized && !submitted) {
        this.fail('等不到注册提交或授权页，请确认窗口还开着');
        return { ok: false, msg: this.lastError, email: this.email };
      }

      // ---- 3. 激活链接在外部邮箱里，这是唯一必须由人粘贴回来的一步
      this.manual('', false);
      this.setPhase('asking-link');
      const raw = await this.askText({
        kind: 'link',
        label: '注册已提交。请到邮箱打开 Z.ai 的验证邮件，把邮件里的链接复制过来粘贴到这里',
        placeholder: 'https://chat.z.ai/...',
        hint: '只复制链接、粘贴到这儿，别直接点开它——链接必须在本窗口打开，新账号的登录态才会建在这个窗口里。',
      });
      if (!raw) { this.fail('未提供激活链接'); return { ok: false, msg: this.lastError, email: this.email }; }

      const found = (raw.match(/https?:\/\/[^\s"'<>）)]+/gi) || []).map((u) => u.replace(/[.,;]+$/, ''));
      const links = found.filter((u) => /^https?:\/\/chat\.z\.ai\//i.test(u));
      if (!links.length) {
        const hint = found.length ? '（粘贴内容里只有非 Z.ai 链接：' + found[0] + '）' : '';
        this.fail('没识别到 chat.z.ai 的激活链接' + hint);
        return { ok: false, msg: this.lastError, email: this.email };
      }
      this.verifyLink = links[0];
      this.ok('激活链接：' + this.verifyLink);

      this.setPhase('opening-verify-link');
      const okNav = await this.navigate(this.verifyLink);
      if (!okNav) { this.fail('激活链接未能在原窗口打开'); return { ok: false, msg: this.lastError, email: this.email }; }
      this.ok('已在原窗口打开激活链接（会话保持，无需重新登录）');

      // ---- 4. 邮箱验证后还有第二步：设置密码并点「完成注册」
      this.setPhase('completing-signup');
      const needPw = await this.waitFor(() => {
        const vis = Array.from(document.querySelectorAll('input')).filter((e) => e.offsetParent !== null);
        const btns = Array.from(document.querySelectorAll('button')).filter((e) => e.offsetParent !== null);
        return vis.filter((e) => e.type === 'password').length >= 2
          || btns.some((b) => (b.innerText || '').trim() === '完成注册');
      }, { timeout: 25000 });

      let verified = false;
      if (needPw) {
        const ok2 = await this.fillPasswordTwice(this.password);
        if (ok2) {
          await sleep(500);
          await this.eval(PAGE_CLICK_TEXT, ['完成注册'], { exact: true });
          this.ok('已提交「完成注册」');
          verified = await this.waitFor(
            () => /注册完成|账户已成功创建|即将跳转/.test(document.body.innerText || ''),
            { timeout: 30000 }
          );
          if (verified) this.ok('账号创建完成　邮箱=' + this.email);
          else this.warn('没读到「注册完成」提示，请到窗口确认');
        } else {
          this.warn('密码填写失败，请手动填两次再点「完成注册」');
        }
      } else {
        this.log('未出现「完成注册」表单，可能此前已验证过');
      }

      // ---- 5. 回到 OAuth 授权页
      let backOn = false;
      if (this.authorizeUrl) {
        this.setPhase('back-to-authorize');
        await sleep(1500);
        backOn = await this.navigate(this.authorizeUrl);
        if (backOn) this.ok('已回到 OAuth 授权页');
        else this.warn('未能回到授权页，请手动重新点一次「Z.ai 网页登录」');
      } else {
        this.warn('缺少授权页地址，请手动重新点一次「Z.ai 网页登录」');
      }

      // ---- 5.5 确认授权页上的账号就是本次注册的那个
      //
      // 窗口里可能还留着上一次的登录态。最常见的原因不是流程出错，而是使用者
      // 直接在邮箱里点开了激活链接——那样激活发生在别的浏览器里，本窗口的会话
      // 没建立起来，回到授权页看到的还是旧账号。所以先重开一次链接补救，
      // 仍然不对才中止，并且把原因和该怎么做说清楚。
      if (backOn && this.alive && this.email) {
        const mine = String(this.email).toLowerCase();
        let emails = await this.readShownEmails();
        // 只要求"本账号邮箱出现在页面上"就算通过：授权页页脚、帮助链接里
        // 也可能有别家的邮箱，抓第一个就比对会把正常流程误判成账号不符。
        if (emails.length && !emails.some((e) => e.toLowerCase() === mine)) {
          this.warn('授权页显示的是 ' + emails[0] + '，不是本次注册的 ' + this.email + '，正在重试一次…');
          if (this.verifyLink) {
            await this.navigate(this.verifyLink);
            await sleep(2500);
            await this.navigate(this.authorizeUrl);
            await sleep(1500);
            emails = await this.readShownEmails();
          }
        }

        if (emails.length && !emails.some((e) => e.toLowerCase() === mine)) {
          this.fail('授权页账号是 ' + emails[0] + '，与本次注册邮箱 ' + this.email + ' 不一致。'
            + '多半是激活链接被直接在邮箱里点开了——那样激活发生在别的浏览器，本窗口没有建起新账号的登录态。'
            + '请回邮箱复制链接（不要点开），重新走一次「Z.ai 邮箱注册」。');
          return { ok: false, msg: this.lastError, email: this.email };
        }
        if (emails.length) this.ok('授权页账号核对通过：' + this.email);
        else this.warn('授权页上没读到账号邮箱，继续但不做校验');
      }

      // ---- 6. 勾协议 + 点「继续」完成授权确认
      let authorize = 'skipped';
      if (backOn && this.alive) {
        this.setPhase('confirm-authorize');
        authorize = await this.confirmAuthorize({ timeout: 30000 });
        if (authorize === 'no-button') this.log('授权页没有「继续」按钮，可能已自动放行');
        else if (authorize === 'click-failed') this.warn('没能点到「继续」，请手动点一下');
        await sleep(3000);
      }

      this.setPhase('done');
      return { ok: true, email: this.email, password: this.password, link: this.verifyLink, verified, authorize };
    } catch (e) {
      this.fail('自动化异常：' + (e.message || e));
      return { ok: false, msg: this.lastError, email: this.email };
    }
  }
}

module.exports = { LoginDriver, ZaiMailDriver, BaseDriver };
