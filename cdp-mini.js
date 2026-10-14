'use strict';
/**
 * CDP 基础设施（零依赖）：自实现 WebSocket + CDP 会话 + 浏览器定位。
 *
 * 由 capture-captcha-rid.js / monitor-register.js 共用；MiniWS 负责握手校验与帧编解码
 * （掩码帧、分片、ping/pong、close），CDP 负责会话内 JSON-RPC 与事件分发。
 */

const net = require('net');
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
// ------------------------------------------------------------------ 迷你 WebSocket 客户端（CDP 用）

class MiniWS {
  constructor(url) {
    this.url = url;
    this.sock = null;
    this.buf = Buffer.alloc(0);
    this.fragOpcode = 0;
    this.fragParts = [];
    this.handlers = { message: [], error: [], close: [] };
    this.alive = false;
  }
  on(ev, fn) { this.handlers[ev].push(fn); return this; }
  emit(ev, ...a) { for (const f of this.handlers[ev]) { try { f(...a); } catch (_) {} } }

  connect() {
    return new Promise((resolve, reject) => {
      const u = new URL(this.url);
      const key = crypto.randomBytes(16).toString('base64');
      const req = http.request({
        host: u.hostname,
        port: u.port || 80,
        path: u.pathname + (u.search || ''),
        headers: {
          Connection: 'Upgrade',
          Upgrade: 'websocket',
          'Sec-WebSocket-Version': '13',
          'Sec-WebSocket-Key': key,
          Host: `${u.hostname}:${u.port || 80}`,
        },
      });
      req.on('upgrade', (res, socket) => {
        const expect = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
        if ((res.headers['sec-websocket-accept'] || '') !== expect) { reject(new Error('WebSocket 握手校验失败')); return; }
        this.sock = socket;
        this.alive = true;
        socket.on('data', (d) => this._onData(d));
        socket.on('error', (e) => this.emit('error', e));
        socket.on('close', () => { this.alive = false; this.emit('close'); });
        resolve();
      });
      req.on('error', reject);
      req.end();
    });
  }

  _frame(opcode, payload) {
    const data = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
    const len = data.length;
    let head;
    const mask = crypto.randomBytes(4);
    if (len < 126) {
      head = Buffer.alloc(2);
      head[1] = 0x80 | len;
    } else if (len < 65536) {
      head = Buffer.alloc(4);
      head[1] = 0x80 | 126;
      head.writeUInt16BE(len, 2);
    } else {
      head = Buffer.alloc(10);
      head[1] = 0x80 | 127;
      head.writeBigUInt64BE(BigInt(len), 2);
    }
    head[0] = 0x80 | opcode;                      // FIN + opcode
    head[1] |= 0x80;                              // MASK
    const masked = Buffer.allocUnsafe(len);
    for (let i = 0; i < len; i++) masked[i] = data[i] ^ mask[i & 3];
    return Buffer.concat([head, mask, masked]);
  }

  send(text) {
    if (!this.alive) throw new Error('WebSocket 未连接');
    this.sock.write(this._frame(0x1, text));
  }

  close() { try { if (this.alive) { this.sock.write(this._frame(0x8, Buffer.alloc(0))); this.sock.end(); } } catch (_) {} }

  _onData(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    for (;;) {
      if (this.buf.length < 2) return;
      const b0 = this.buf[0], b1 = this.buf[1];
      const fin = !!(b0 & 0x80);
      const opcode = b0 & 0x0f;
      const masked = !!(b1 & 0x80);
      let len = b1 & 0x7f;
      let off = 2;
      if (len === 126) { if (this.buf.length < 4) return; len = this.buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (this.buf.length < 10) return; len = Number(this.buf.readBigUInt64BE(2)); off = 10; }
      let mask = null;
      if (masked) { if (this.buf.length < off + 4) return; mask = this.buf.slice(off, off + 4); off += 4; }
      if (this.buf.length < off + len) return;
      let payload = this.buf.slice(off, off + len);
      this.buf = this.buf.slice(off + len);
      if (mask) { const c = Buffer.from(payload); for (let i = 0; i < c.length; i++) c[i] ^= mask[i & 3]; payload = c; }

      if (opcode === 0x9) { this.sock.write(this._frame(0xa, payload)); continue; }   // ping → pong
      if (opcode === 0xa) continue;                                                  // pong
      if (opcode === 0x8) { this.alive = false; this.emit('close'); return; }         // close
      if (opcode === 0x0) { this.fragParts.push(payload); if (fin) { const full = Buffer.concat(this.fragParts); this.fragParts = []; this.emit('message', full.toString('utf8')); } continue; }
      if (opcode === 0x1 || opcode === 0x2) {
        if (fin) { this.emit('message', payload.toString('utf8')); }
        else { this.fragOpcode = opcode; this.fragParts = [payload]; }
      }
    }
  }
}

// ------------------------------------------------------------------ CDP 会话

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.listeners = [];
    ws.on('message', (txt) => {
      let msg;
      try { msg = JSON.parse(txt); } catch (_) { return; }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
      } else if (msg.method) {
        for (const l of this.listeners) { try { l(msg); } catch (_) {} }
      }
    });
  }
  on(fn) { this.listeners.push(fn); }
  call(method, params = {}, sessionId) {
    const id = ++this.id;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try { this.ws.send(JSON.stringify(payload)); } catch (e) { this.pending.delete(id); reject(e); }
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('CDP 超时: ' + method)); } }, 30000);
    });
  }
}

// ------------------------------------------------------------------ 浏览器定位 / 启动

function browserCandidates() {
  const c = [];
  const env = process.env.CHROME_PATH || process.env.EDGE_PATH || process.env.HELMD_BROWSER;
  if (env) c.push(env);
  if (process.platform === 'win32') {
    const pf = process.env['ProgramFiles'] || 'C:\\Program Files';
    const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    const local = process.env['LOCALAPPDATA'] || path.join(os.homedir(), 'AppData', 'Local');
    c.push(path.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
    c.push(path.join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
    c.push(path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'));
    c.push(path.join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'));
    c.push(path.join(local, 'Google', 'Chrome', 'Application', 'chrome.exe'));
    c.push(path.join(local, 'Chromium', 'Application', 'chrome.exe'));
  } else if (process.platform === 'darwin') {
    c.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
    c.push('/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge');
    c.push('/Applications/Chromium.app/Contents/MacOS/Chromium');
  } else {
    c.push('/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium');
  }
  return c;
}

function findBrowser(explicit) {
  if (explicit) { if (fs.existsSync(explicit)) return explicit; throw new Error('指定的浏览器不存在: ' + explicit); }
  for (const p of browserCandidates()) { try { if (p && fs.existsSync(p)) return p; } catch (_) {} }
  throw new Error('没找到 Chromium 内核浏览器，请用 --browser 指定，或设置 CHROME_PATH');
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
}

function httpGetJson(url, tries = 60, gapMs = 500) {
  return new Promise((resolve, reject) => {
    const attempt = (n) => {
      http.get(url, (res) => {
        let body = '';
        res.on('data', (d) => { body += d; });
        res.on('end', () => {
          try { resolve(JSON.parse(body)); } catch (e) { n > 0 ? setTimeout(() => attempt(n - 1), gapMs) : reject(e); }
        });
      }).on('error', (e) => { n > 0 ? setTimeout(() => attempt(n - 1), gapMs) : reject(e); });
    };
    attempt(tries);
  });
}

module.exports = { MiniWS, CDP, browserCandidates, findBrowser, freePort, httpGetJson };
