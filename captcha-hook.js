'use strict';
/**
 * 人机验证探针（页面内钩子源码）——login-driver.js 与 capture-captcha-rid.js 共用同一份。
 *
 * 注入方式：在页面主世界执行 `(0, eval)(CAPTCHA_HOOK_SRC)`（间接 eval = 全局作用域）。
 * 幂等：重复注入直接返回（window.__helmdCaptchaHook 已置位）。
 *
 * 抓什么：
 *   ① 腾讯天御  new TencentCaptcha(appid, cb, opts) 的 cb({ret:0, ticket, randstr})
 *   ② 数美      window.initSMCaptcha → sdk.onSuccess({rid, pass})
 *   ③ rid 落盘  Storage.prototype.setItem 命中 /rid/i 的键（localStorage 还是 sessionStorage 由运行时判定）
 *   ④ 验证码请求 /api/biz/code/{smsCode,emailCode}/* 的完整请求体（fetch + XHR）
 *   ⑤ 设备指纹  _TDID.getDeviceTokenV3 的 deviceToken（可为空）
 *
 * 结果落在 window.__helmdCaptcha，字段见 capture-captcha-rid.js 的 probeCaptchaCreds / 抓取器输出。
 */

const CAPTCHA_HOOK_SRC = `(() => {
  if (window.__helmdCaptchaHook) return;
  window.__helmdCaptchaHook = true;
  const rec = { requests: [], rid: null, smcpRid: null, ticket: null, randstr: null, pass: null, deviceToken: null, hits: [], startedAt: Date.now() };
  window.__helmdCaptcha = rec;
  const note = (what, data) => { try { rec.hits.push({ what, at: Date.now(), data }); } catch (e) {} };
  const apiRe = /\\/api\\/biz\\/code\\/(smsCode|emailCode)\\//;

  const of = window.fetch;
  if (typeof of === 'function') {
    window.fetch = function (input, init) {
      try {
        const url = typeof input === 'string' ? input : (input && input.url) || '';
        const body = (init && init.body) || null;
        if (url && apiRe.test(url)) {
          let text = null;
          if (typeof body === 'string') text = body;
          else if (body && typeof body.toString === 'function' && Object.prototype.toString.call(body) !== '[object Object]') { try { text = body.toString(); } catch (e) {} }
          rec.requests.push({ via: 'fetch', url: String(url), body: text });
        }
      } catch (e) {}
      return of.apply(this, arguments);
    };
  }

  const oOpen = XMLHttpRequest.prototype.open, oSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (m, u) { try { this.__helmdUrl = u; } catch (e) {} return oOpen.apply(this, arguments); };
  XMLHttpRequest.prototype.send = function (b) {
    try {
      if (this.__helmdUrl && apiRe.test(this.__helmdUrl)) {
        rec.requests.push({ via: 'xhr', url: String(this.__helmdUrl), body: typeof b === 'string' ? b : (b ? '[非字符串: ' + Object.prototype.toString.call(b) + ']' : null) });
      }
    } catch (e) {}
    return oSend.apply(this, arguments);
  };

  try {
    const oSet = Storage.prototype.setItem;
    Storage.prototype.setItem = function (k, v) {
      try {
        if (typeof k === 'string' && /rid/i.test(k)) {
          rec.rid = { key: k, value: String(v), store: this === window.sessionStorage ? 'sessionStorage' : (this === window.localStorage ? 'localStorage' : 'unknown') };
          note('storage.setItem', rec.rid);
        }
      } catch (e) {}
      return oSet.apply(this, arguments);
    };
  } catch (e) {}

  const trap = (name, wrap) => {
    let cur = window[name];
    try {
      Object.defineProperty(window, name, {
        configurable: true,
        get() { return cur; },
        set(nv) { try { cur = wrap(nv); } catch (e) { cur = nv; } },
      });
    } catch (e) { return; }
    if (cur) { try { window[name] = cur; } catch (e) {} }
  };

  trap('TencentCaptcha', (TC) => {
    if (typeof TC !== 'function') return TC;
    const W = function (appid, cb, opts) {
      const wrapped = function (res) {
        try {
          if (res && res.ret === 0) {
            rec.ticket = res.ticket; rec.randstr = res.randstr;
            note('TencentCaptcha.ret0', { ticketLen: String(res.ticket || '').length, randstrLen: String(res.randstr || '').length });
          } else note('TencentCaptcha.ret', { ret: res && res.ret });
        } catch (e) {}
        return cb && cb(res);
      };
      return new TC(appid, wrapped, opts);
    };
    W.prototype = TC.prototype;
    note('TencentCaptcha.wrapped', true);
    return W;
  });

  trap('initSMCaptcha', (fn) => {
    if (typeof fn !== 'function') return fn;
    const W = function (cb) {
      return fn(function (sdk) {
        try {
          const oOk = sdk && sdk.onSuccess;
          if (sdk && typeof oOk === 'function') {
            sdk.onSuccess = function (res) {
              try {
                if (res && res.rid) {
                  rec.smcpRid = { value: String(res.rid), pass: res.pass };
                  rec.pass = res.pass;
                  if (!rec.rid) rec.rid = { key: 'smcp.onSuccess', value: String(res.rid), store: 'memory' };
                }
                note('smcp.onSuccess', { ridLen: String((res && res.rid) || '').length, pass: res && res.pass });
              } catch (e) {}
              return oOk.apply(this, arguments);
            };
          }
        } catch (e) {}
        return cb && cb(sdk);
      });
    };
    note('initSMCaptcha.wrapped', true);
    return W;
  });

  trap('_TDID', (T) => {
    try {
      if (T && T.getDeviceTokenV3 && !T.__helmdWrapped) {
        const o = T.getDeviceTokenV3;
        T.getDeviceTokenV3 = function (cb) {
          return o.call(this, function (r) { try { if (r && r.deviceToken) rec.deviceToken = String(r.deviceToken); } catch (e) {} return cb && cb(r); });
        };
        T.__helmdWrapped = true;
        note('_TDID.wrapped', true);
      }
    } catch (e) {}
    return T;
  });
})();`;

module.exports = { CAPTCHA_HOOK_SRC };
