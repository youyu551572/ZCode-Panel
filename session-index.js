'use strict';
/**
 * 会话/任务索引跨账号同步 —— 修「切号后我那些会话记录不见了」
 * =====================================================================
 * 病根（实测）：
 *   切号用的是「每账号独立数据根」`ZCODE_DATA_BASE_DIR=<账号>/data`，
 *   客户端把 `credentials / config / logs / telemetry / provider_config`
 *   全部落进 `<账号>/data/.zcode/v2/`。但 **`tasks-index.sqlite`
 *   （客户端任务列表 / 会话索引，主键 (workspace_key, task_id)）也在 v2 里** ——
 *   于是切过去的客户端只看到本账号那个几乎空的库，历史会话就"不见了"。
 *
 *   实测数据：共享库 `~/.zcode/v2/tasks-index.sqlite` = 22 条（跨 12 个工作区），
 *   而账号库只有 3 条，且**账号库里没有任何共享库没有的行** → 指过去不丢数据。
 *
 * 为什么不能把 v2 整个共享：v2 里还有 per-account 的
 *   credentials / provider_config / telemetry / logs，那些必须隔离。
 *
 * 为什么不用符号链接：实测行不通。SQLite 打开 WAL 库时按「打开者的路径」拼
 *   `<db>-wal` / `<db>-shm`，关闭/checkpoint 时会删掉再重建 —— 链接会被换成真文件；
 *   后果是主库共享了但各账号 WAL 里未 checkpoint 的事务互相看不见，
 *   切号后仍会「少几条最近会话」。
 *
 * ⇒ 正确做法：**在切换边界做文件拷贝**（本模块）。
 *   进入前：共享 → 账号；离开后：账号 → 共享。
 *   只拷 main + wal，不拷 shm（SQLite 会自己重建；拷一个陈旧的 shm 反而可能出问题）。
 *
 * 用法（main.js 里只需要一处）：
 *   const sessionIndex = require('./session-index');
 *   // 启动客户端之前（此时旧客户端已退出）
 *   sessionIndex.syncIn(path.join(root, '.zcode', 'v2'), LEGACY_ZCODE_V2);
 *
 * syncIn 内部会**先对上一次播种过的账号做回写**，所以不需要第二处调用点。
 */

const fs = require('fs');
const path = require('path');

const SYNC_FILES = ['tasks-index.sqlite', 'tasks-index.sqlite-wal'];
const MARK = '.session-index-seeded';

/** 上一次 syncIn 播种的账号数据根（模块级，用于下次自动回写） */
let lastSeeded = null;

const markPath = (dataV2) => path.join(dataV2, MARK);

function copyFile(src, dst) {
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
}

/**
 * 拷一份 SQLite 主库（含 wal）。
 *
 * ⚠ 关键细节（实测踩到）：源端**没有 `-wal`**（事务已 checkpoint 进主库）时，
 * 目标端若还留着陈旧的 `-wal`，SQLite 打开时会把它重放上去，
 * **把刚拷过去的主库内容盖回去** —— 表现就是"回写了但行数没变"。
 * 所以：源 wal 不存在或为 0 字节时，必须把目标的 `-wal` / `-shm` 一起删掉。
 *
 * @returns {string} 说明串，便于日志定位
 */
function copyDbFamily(srcDir, dstDir, base, notes) {
  const s = path.join(srcDir, base);
  const d = path.join(dstDir, base);
  const sw = s + '-wal';
  const dw = d + '-wal';
  const ds = d + '-shm';
  if (!fs.existsSync(s)) { try { fs.rmSync(d, { force: true }); fs.rmSync(dw, { force: true }); fs.rmSync(ds, { force: true }); } catch (_) { } notes.push(base + ':nosrc'); return; }
  try { copyFile(s, d); notes.push(base + ':copied'); }
  catch (e) { notes.push(base + ':fail(' + e.message + ')'); return; }
  const hasWal = fs.existsSync(sw) && fs.statSync(sw).size > 0;
  if (hasWal) {
    try { copyFile(sw, dw); notes.push(base + '-wal:copied'); }
    catch (e) { notes.push(base + '-wal:fail(' + e.message + ')'); }
  } else {
    // 源端无 wal ⇒ 主库是权威，清掉目标端的陈旧 wal/shm，否则会被重放盖回去
    let cleared = false;
    try { if (fs.existsSync(dw)) { fs.rmSync(dw, { force: true }); cleared = true; } } catch (_) { }
    try { if (fs.existsSync(ds)) { fs.rmSync(ds, { force: true }); cleared = true; } } catch (_) { }
    notes.push(base + '-wal:nosrc' + (cleared ? '(cleared stale)' : ''));
  }
}

/**
 * 账号 → 共享（回写）。没播种过就不回写（避免把空库推回共享）。
 * @param {string} dataV2  账号的 .zcode/v2 目录
 * @param {string} sharedV2 共享的 .zcode/v2 目录
 */
function syncOut(dataV2, sharedV2) {
  if (!dataV2 || !sharedV2) return 'no-path';
  if (!fs.existsSync(markPath(dataV2))) return 'not-seeded';
  const notes = [];
  copyDbFamily(dataV2, sharedV2, 'tasks-index.sqlite', notes);
  try { fs.rmSync(markPath(dataV2), { force: true }); } catch (_) { /* 无妨 */ }
  return notes.join(', ');
}

/**
 * 共享 → 账号（进入前）。顺带清掉早期版本留下的符号链接。
 * @param {string} dataV2  账号的 .zcode/v2 目录
 * @param {string} sharedV2 共享的 .zcode/v2 目录
 * @param {string} accountId 仅用于日志
 */
function syncIn(dataV2, sharedV2, accountId) {
  if (!dataV2 || !sharedV2) return 'no-path';
  const notes = [];
  // ① 先把上一个用过的账号回写进共享库（客户端此刻已退出）
  if (lastSeeded && lastSeeded !== dataV2) {
    try { notes.push('prev[' + syncOut(lastSeeded, sharedV2) + ']'); } catch (e) { notes.push('prevFail(' + e.message + ')'); }
  }
  try { fs.mkdirSync(dataV2, { recursive: true }); } catch (_) { return 'failed'; }

  // ② 清掉早期版本留下的符号链接（连同 shm）
  for (const n of SYNC_FILES.concat(['tasks-index.sqlite-shm'])) {
    const d = path.join(dataV2, n);
    try { if (fs.lstatSync(d).isSymbolicLink()) { fs.unlinkSync(d); notes.push(n + ':unlink'); } } catch (_) { /* 不存在就算了 */ }
  }

  // ③ 拷 main + wal（内部处理陈旧 wal 覆盖问题）
  {
    const d = path.join(dataV2, 'tasks-index.sqlite');
    const seeded = fs.existsSync(markPath(dataV2));
    // 安全阀：账号侧存在**未曾播种过的真库**时先改名留档再覆盖。
    // 没有这道保护，某账号在隔离期间新建的会话会被共享库直接盖掉。
    if (!seeded && fs.existsSync(d)) {
      const keep = d + '.pre-seed-' + new Date().toISOString().replace(/[:.]/g, '-');
      try { fs.renameSync(d, keep); notes.push('tasks-index.sqlite:pre-seed-kept'); }
      catch (e) { notes.push('tasks-index.sqlite:pre-seed-fail(' + e.message + ')'); }
    }
    copyDbFamily(sharedV2, dataV2, 'tasks-index.sqlite', notes);
  }

  // ④ 陈旧 shm 一律删掉，让 SQLite 按主库+wal 重建
  try { fs.rmSync(path.join(dataV2, 'tasks-index.sqlite-shm'), { force: true }); } catch (_) { /* 无妨 */ }
  try { fs.writeFileSync(markPath(dataV2), new Date().toISOString(), 'utf8'); } catch (_) { /* 无妨 */ }

  lastSeeded = dataV2;
  return notes.join(', ');
}

module.exports = { syncIn, syncOut, SYNC_FILES, MARK };
