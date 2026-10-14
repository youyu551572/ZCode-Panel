'use strict';
/**
 * 账号导出 —— import-account.js 的逆向操作
 * =====================================================================
 * 产出的就是导入方认的那份东西，不多不少：
 *   { "name": "xxx", "jwt": "eyJ…", "device_mid": "uuid", "note": "" }
 *
 * 为什么单独一个模块：和导入一样，这段逻辑要能**脱离 electron 单独测试**。
 *
 * 关键约定：**导出成功 ⇒ 导入必然接受**。
 * 所以这里不自己发明校验，而是直接复用 import-account 的 NAME_RE / JWT_RE /
 * UUID_RE，并在返回前把结果丢进导入方的 normalize() 走一遍。哪天导入方收紧了
 * 规则，导出会立刻跟着失败，而不是产出一份别人吃不下的 JSON。
 *
 * 数据来源（与面板读账号的口径一致）：
 *   jwt        <账号>/data/.zcode/v2/config.json 的 provider.*.options.apiKey
 *              （捕获导入两种来源都写这里；找不到时退回 <账号>/config.json）
 *   device_mid <账号>/meta.json 的 device_mid
 *   note       <账号>/meta.json 的 note
 */

const fs = require('fs');
const path = require('path');
const { NAME_RE, UUID_RE, JWT_RE, normalize } = require('./import-account');

const V2 = [path.join('data', '.zcode', 'v2', 'config.json'), 'config.json'];

function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
}

/**
 * 从一份 config 里找出这个账号的 JWT。
 *
 * 优先 `builtin:` 开头的 provider —— 导入账号时 JWT 就是写在这些下面的；
 * 实在找不到再放宽到全部 provider（「捕获当前登录」来的账号可能布局不同）。
 * 判定一律用导入方的 JWT_RE，避免导出一个人家不收的东西。
 */
function findJwt(cfg) {
  if (!cfg || !cfg.provider || typeof cfg.provider !== 'object') return null;
  const keys = Object.keys(cfg.provider);
  const ordered = keys.filter((k) => k.startsWith('builtin:')).concat(keys.filter((k) => !k.startsWith('builtin:')));

  for (const pid of ordered) {
    const provider = cfg.provider[pid];
    if (!provider || typeof provider !== 'object') continue;
    const found = [];
    (function walk(x) {
      if (!x || typeof x !== 'object') return;
      for (const v of Object.values(x)) {
        if (typeof v === 'string') {
          if (JWT_RE.test(v.trim())) found.push(v.trim());
        } else if (v && typeof v === 'object') {
          walk(v);
        }
      }
    })(provider);
    if (found.length) return found[0];
  }
  return null;
}

/**
 * 导出一个账号。
 * @param {object} opts
 * @param {string} opts.id           账号目录名（= 账号名）
 * @param {string} opts.accountsDir  面板账号目录
 * @returns {{ok:boolean, id?:string, payload?:object, text?:string, error?:string, msg?:string}}
 */
function exportAccount(opts = {}) {
  const id = String(opts.id || '').trim();
  const accountsDir = opts.accountsDir;
  if (!accountsDir) return { ok: false, error: 'no-dir', msg: '账号目录未配置' };
  if (!id) return { ok: false, error: 'no-id', msg: '没有指定要导出的账号' };
  // 目录名要能直接当导入方的 name 用；不合法就没法往返，早说早好
  if (!NAME_RE.test(id)) {
    return { ok: false, error: 'bad-name', msg: '账号目录名「' + id + '」不符合导入格式（只允许字母数字下划线短横，1–32 位），无法导出' };
  }

  const dir = path.join(accountsDir, id);
  if (!fs.existsSync(dir)) return { ok: false, error: 'not-found', msg: '账号不存在：' + id };

  // ---- jwt ----
  let cfg = null;
  for (const rel of V2) {
    cfg = readJson(path.join(dir, rel));
    if (cfg) break;
  }
  const jwt = findJwt(cfg);
  if (!jwt) {
    return {
      ok: false,
      error: 'no-jwt',
      msg: '这个账号里没有可用的 JWT（config.json 里找不到）。先在客户端里登录一次，或重新导入一次凭据，再导出。',
    };
  }

  // ---- device_mid / note ----
  const meta = readJson(path.join(dir, 'meta.json')) || {};
  const mid = typeof meta.device_mid === 'string' ? meta.device_mid.trim() : '';
  if (!UUID_RE.test(mid)) {
    return {
      ok: false,
      error: 'no-device-mid',
      msg: '这个账号没有合法的 device_mid（meta.json 里缺失或不是 UUID），导入方会拒绝。先切到这个账号启动一次客户端，让它生成设备码。',
    };
  }
  const note = typeof meta.note === 'string' ? meta.note : '';

  const payload = { name: id, jwt, device_mid: mid, note };

  // ---- 自检：拿导入方的校验器过一遍 ----
  // 这一步是「往返保证」的落点：宁可这里失败，也不要产出别人吃不下的 JSON。
  const check = normalize(payload);
  if (check.error) {
    return { ok: false, error: 'roundtrip', msg: '导出的内容没通过导入校验（' + check.error + '）：' + check.msg };
  }

  return { ok: true, id, payload, text: JSON.stringify(payload, null, 2) };
}

module.exports = { exportAccount, findJwt };
