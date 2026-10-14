'use strict';
/**
 * 会话/任务索引跨账号同步 —— 修「切号后我那些会话记录不见了」+「切号弄丢/弄脏会话记录」
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
 * =====================================================================
 * ⚠ 这一版的五道加固（对照 zcodeyy/lib/switch.js 的权威实现补的）
 * ---------------------------------------------------------------------
 *   ① **播种标记是磁盘上的文件**（`.session-index-seeded`），不是模块级变量。
 *      旧版用 `let lastSeeded`，面板一重启就归零 → 切号离开时走 `not-seeded`
 *      分支**静默不回写**，那个账号这一轮新建的会话全部留在账号私有库里，
 *      再也回不到共享库。表现就是"切走再切回来，刚才聊的那些没了"。
 *      ⇒ 现在谁播种过，磁盘说了算，跨进程/跨重启都成立。
 *
 *   ② **校验数据库完整性**（`PRAGMA quick_check`）。坏库绝不拷过去，
 *      否则一个坏 WAL 会被复制进每个账号，最后全员打不开会话列表。
 *
 *   ③ **拷贝前先 checkpoint**（`PRAGMA wal_checkpoint(TRUNCATE)`）。
 *      WAL 里没落盘的事务先并进主库，避免"主库拷过去了、新会话还在 wal 里"
 *      这种一半一半的状态。
 *
 *   ④ **回写前备份共享库 + 回写后复检 + 坏了自动还原**。
 *      回写是唯一一处会覆盖使用者既有数据的地方，必须留后路：
 *      备份进 `<账号库>/../.session-index-backups/`（保留 12 份），
 *      复检不过就把备份贴回去。共享库因此不可能因为切号而被写坏。
 *
 *   ⑤ **活库不碰**。客户端在跑时（`ZCode.exe` 存在）直接跳过同步。
 *      对着一个正在被 SQLite 写入的库做 copyFile，拷出来必然是撕裂的。
 *
 *   另外还有两道小保护：
 *      · 源端没有 `-wal`（或为 0 字节）时，把目标端的陈旧 `-wal` / `-shm` 删掉 ——
 *        否则 SQLite 打开时会重放旧 WAL，把刚拷过去的主库内容盖回去
 *        （现象："回写了但行数没变"）。
 *      · 账号侧存在**未曾播种过的真库**时先改名留档（`.pre-seed-<时间戳>`）再覆盖，
 *        避免该账号在隔离期间自己新建的会话被共享库直接盖掉。
 *
 * 全程有一份日志（`<账号库>/../.session-index.log`）：会话到底跟没跟过来，
 * 全靠"播种 / 回写"这两步，而它们会静默跳过的路径特别多（客户端在跑、没播种过、
 * 库坏了、源里没有 wal…）。没有日志时"切过去发现历史是空的"根本查不出卡在哪。
 *
 * 用法（main.js）：
 *   const sessionIndex = require('./session-index');
 *   // 客户端启动之前（此时旧客户端已退出）
 *   sessionIndex.syncIn(path.join(root, '.zcode', 'v2'), LEGACY_ZCODE_V2, accountId);
 *   // 客户端停止之后、切换/删除之前（每个 kill 点都要调，幂等）
 *   sessionIndex.syncOutAccount(prevAccountId, LEGACY_ZCODE_V2, accountsDir());
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const SYNC_FILES = ['tasks-index.sqlite', 'tasks-index.sqlite-wal'];
const SHM = 'tasks-index.sqlite-shm';
const MARK = '.session-index-seeded';

/** 备份保留份数（每份最多 2 个文件，12 份足够回看最近十几次切号） */
const BACKUP_KEEP = 12;
/** 日志超过这个大小只留最后 200 行 */
const LOG_MAX = 512 * 1024;

const markPath = (dataV2) => path.join(dataV2, MARK);

/**
 * 备份目录 / 日志文件都放在**账号库旁边**（`<账号库>/../`）。
 *
 * 为什么不是模块目录：打包后 `__dirname` 在只读的 `app.asar` 里，写不进去
 * （这个坑 settings.js / remote-plan.js 都踩过）。放账号库旁边既可写，
 * 又和使用者数据在同一处、便于连带备份。
 */
function sideDir(dataV2, accountsRoot) {
  // dataV2 = <账号库>/<账号>/data/.zcode/v2 时，往上 4 层即 <账号库> 的父目录
  if (accountsRoot) return path.dirname(accountsRoot);
  const up = path.resolve(dataV2, '..', '..', '..', '..');
  return path.dirname(up);
}
function backupDir(dataV2, accountsRoot) { return path.join(sideDir(dataV2, accountsRoot), '.session-index-backups'); }
function logFile(dataV2, accountsRoot) { return path.join(sideDir(dataV2, accountsRoot), '.session-index.log'); }

/**
 * 会话索引日志。
 *
 * ⚠ 必须把换行/回车折成空格：sqlite 的错误消息自带换行，原样写进去会把
 *   「一行一条」的日志格式撑破，事后 grep 也难对上。
 */
function logSessionIndex(msg, dataV2, accountsRoot) {
  const oneLine = String(msg == null ? '' : msg).replace(/[\r\n\t]+/g, ' ').trim();
  console.log('[session-index] ' + oneLine);
  if (!dataV2) return;
  try {
    const f = logFile(dataV2, accountsRoot);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.appendFileSync(f, '[' + new Date().toISOString() + '] ' + oneLine + '\n', 'utf8');
    if (fs.statSync(f).size > LOG_MAX) {
      fs.writeFileSync(f, fs.readFileSync(f, 'utf8').split('\n').slice(-200).join('\n'), 'utf8');
    }
  } catch (_) { /* 日志写不进去绝不能影响切号 */ }
}

/** 包一层：把同步结果（含"为什么跳过"）记成一行日志，异常也记 */
function logSyncResult(action, accountId, dataV2, sharedV2, fn) {
  const t0 = Date.now();
  let note;
  try { note = fn(); }
  catch (e) { note = 'THREW(' + ((e && e.message) || e) + ')'; }
  logSessionIndex(`${action} ${accountId || '-'}：${note}（${Date.now() - t0}ms）`, dataV2);
  return note;
}

function copyFile(src, dst) {
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
}

// ---------------------------------------------------------------- 完整性

/**
 * `PRAGMA quick_check` —— 库坏没坏。
 *
 * 用 Node 自带的 `node:sqlite`（Node 22.5+ 内置），**不依赖外部 sqlite3.exe**：
 * 这个仓库要打包发给别人，机器上不一定有 sqlite3；少一个外部依赖少一类失败。
 * 拿不到驱动（老 Node / 被裁剪）时返回 ok —— 校验是加固，不是前置条件，
 * 不能因为它不可用就把切号整个卡死（对齐参考实现的 no-validator 语义）。
 *
 * ⚠ 实测坑（本函数的 `reapSidecars` 就是为它存在的）：
 *   对一个 **WAL 模式的库做「只读」打开，也会凭空创建 `<db>-shm` 和 `<db>-wal`**
 *   ——哪怕一个字都没写。SQLite 需要 shm 做 WAL 索引、需要 wal 文件句柄。
 *   而我们这里只是"看一眼坏没坏"，不该留下任何痕迹：
 *     · 在**共享库**上留下空 wal → 之后靠 copyDbFamily 拷过去，目标端就多一个
 *       配对不上的空 wal；
 *     · 在**账号库**上留下 wal → 播种/回写判据（"源端有没有 wal"）被自己污染。
 *   所以校验完必须把**我们这次新造出来的**空 sidecar 收掉。
 *   只收「本次之前不存在、且现在大小为 0」的：有真实内容的 wal 绝不碰
 *   （那是别人正在写的事务，删了就是丢数据）。
 *
 * @returns {{ok:boolean, reason:string}}
 */
function quickCheckDb(file) {
  if (!file || !fs.existsSync(file) || fs.statSync(file).size === 0) {
    return { ok: true, reason: 'absent' };
  }
  let DatabaseSync;
  try { ({ DatabaseSync } = require('node:sqlite')); }
  catch (_) { return { ok: true, reason: 'no-validator' }; }

  // 记录开口前 sidecar 的状态，好分辨"哪些是我们造的"
  const wal = file + '-wal';
  const shm = file + '-shm';
  const preWal = fs.existsSync(wal) ? fs.statSync(wal).size : -1;
  const preShm = fs.existsSync(shm) ? 1 : -1;

  let db = null;
  try {
    // 只读打开：这一步同时就是"能不能当数据库读"的判据
    db = new DatabaseSync(file, { readOnly: true });
    const row = db.prepare('PRAGMA quick_check').get();
    const v = String(row ? (row.quick_check || Object.values(row)[0]) : '').trim();
    return { ok: v === 'ok', reason: v || 'empty' };
  } catch (e) {
    const msg = String((e && e.message) || e).split(/\r?\n/)[0].trim();
    return { ok: false, reason: msg.slice(0, 140) || 'check-failed' };
  } finally {
    try { if (db) db.close(); } catch (_) { /* 无妨 */ }
    reapSidecars(wal, shm, preWal, preShm);
  }
}

/** 收掉「本次之前不存在/为空、现在为空」的 sidecar；有内容的绝对不动 */
function reapSidecars(wal, shm, preWal, preShm) {
  try {
    if (fs.existsSync(wal) && preWal <= 0 && fs.statSync(wal).size === 0) fs.rmSync(wal, { force: true });
  } catch (_) { /* 无妨 */ }
  try {
    if (fs.existsSync(shm) && preShm < 0) fs.rmSync(shm, { force: true });
  } catch (_) { /* 无妨 */ }
}

/**
 * `PRAGMA wal_checkpoint(TRUNCATE)` —— 把 WAL 里未落盘的事务并进主库并把 WAL 截断。
 * 拷贝前做一次，保证"主库 = 全部数据"。
 *
 * ⚠ 只有**真的存在非空 wal** 时才动手：
 *   没有 wal 时本来就没有未落盘的事务，而"打开一下"反而会凭空造出一个空 wal
 *   （见 quickCheckDb 的说明），把后面的判据搞脏。
 */
function checkpointDb(file) {
  if (!file || !fs.existsSync(file)) return 'skip';
  const wal = file + '-wal';
  let hasWal = false;
  try { hasWal = fs.existsSync(wal) && fs.statSync(wal).size > 0; } catch (_) { hasWal = false; }
  if (!hasWal) return 'no-wal';

  let DatabaseSync;
  try { ({ DatabaseSync } = require('node:sqlite')); }
  catch (_) { return 'no-validator'; }

  // 记下开口前的 sidecar 状态，好收掉自己造出来的空文件
  const shm = file + '-shm';
  const preShm = fs.existsSync(shm) ? 1 : -1;

  let db = null;
  try {
    db = new DatabaseSync(file);
    db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
    return 'ok';
  } catch (_) {
    return 'fail';
  } finally {
    try { if (db) db.close(); } catch (_) { /* 无妨 */ }
    reapSidecars(wal, shm, 1, preShm);   // preWal=1：wal 原本就在，别删它（TRUNCATE 后它可能已归零）
  }
}

/**
 * ZCode.exe 在跑吗？（同步探测；查不到就当作没跑 —— 避免探测失败导致永久跳过修复）
 *
 * 可用环境变量强制指定探测结果，两个用途：
 *   `ZCODE_SESSION_SYNC_FORCE_IDLE=1` —— 当作"客户端没在跑"。
 *       给验证脚本用：开发机上客户端常常正开着，那样同步会被 running 门正确拦下，
 *       脚本里"应该被播种/回写"的断言就全部落空。验证「已退出时的同步行为」
 *       必须能把这道门关掉，否则测的是环境噪声。
 *   `ZCODE_SESSION_SYNC_FORCE_RUNNING=1` —— 当作"客户端在跑"，
 *       用来在没有客户端的机器上验证 running 门本身。
 * 两者都只影响本模块的同步决策，不改客户端行为。
 */
function zcodeRunningSync() {
  if (process.env.ZCODE_SESSION_SYNC_FORCE_IDLE === '1') return false;
  if (process.env.ZCODE_SESSION_SYNC_FORCE_RUNNING === '1') return true;
  try {
    const out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq ZCode.exe', '/NH'],
      { encoding: 'utf8', windowsHide: true, timeout: 15000 });
    return /ZCode\.exe/i.test(out);
  } catch (_) {
    return false;
  }
}

// ---------------------------------------------------------------- 备份

/** 备份共享库（只备有内容的）。返回 {files, tag}，files 供还原用 */
function backupShared(dataV2, sharedV2, accountsRoot, tag) {
  const res = { files: [], tag: 'nothing' };
  try {
    const dir = backupDir(dataV2, accountsRoot);
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    for (const n of SYNC_FILES) {
      const s = path.join(sharedV2, n);
      if (!fs.existsSync(s) || fs.statSync(s).size === 0) continue;
      const d = path.join(dir, stamp + '.' + tag + '.' + n);
      fs.copyFileSync(s, d);
      res.files.push(d);
    }
    // 轮转：只留最近 BACKUP_KEEP 个文件
    const all = fs.readdirSync(dir).sort();
    for (const old of all.slice(0, Math.max(0, all.length - BACKUP_KEEP))) {
      try { fs.rmSync(path.join(dir, old), { force: true }); } catch (_) { /* 忽略 */ }
    }
    res.tag = res.files.length ? path.basename(res.files[0]).split('.').slice(-1)[0] : 'nothing';
  } catch (e) {
    res.tag = 'fail(' + e.message + ')';
  }
  return res;
}

/** 把备份贴回共享库，并清掉 wal/shm（避免旧 WAL 重放） */
function restoreShared(sharedV2, files) {
  let done = 0;
  for (const f of files || []) {
    const base = path.basename(f);
    const orig = SYNC_FILES.find((n) => base.endsWith('.' + n));
    if (!orig) continue;
    try { copyFile(f, path.join(sharedV2, orig)); done += 1; } catch (_) { /* 忽略 */ }
  }
  for (const s of ['-wal', '-shm']) {
    try { fs.rmSync(path.join(sharedV2, 'tasks-index.sqlite' + s), { force: true }); } catch (_) { /* 忽略 */ }
  }
  return done;
}

// ---------------------------------------------------------------- 文件族拷贝

/**
 * 拷一份 SQLite 主库（含 wal）。
 *
 * ⚠ 关键细节（实测踩到）：源端**没有 `-wal`**（事务已 checkpoint 进主库）时，
 * 目标端若还留着陈旧的 `-wal`，SQLite 打开时会把它重放上去，
 * **把刚拷过去的主库内容盖回去** —— 表现就是"回写了但行数没变"。
 * 所以：源 wal 不存在或为 0 字节时，必须把目标的 `-wal` / `-shm` 一起删掉。
 */
function copyDbFamily(srcDir, dstDir, base, notes) {
  const s = path.join(srcDir, base);
  const d = path.join(dstDir, base);
  const sw = s + '-wal';
  const dw = d + '-wal';
  const ds = d + '-shm';
  if (!fs.existsSync(s)) {
    try { fs.rmSync(d, { force: true }); fs.rmSync(dw, { force: true }); fs.rmSync(ds, { force: true }); } catch (_) { }
    notes.push(base + ':nosrc');
    return;
  }
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

// ---------------------------------------------------------------- 回写：账号 → 共享

/**
 * 账号 → 共享（回写）。
 *
 * **没播种过就不回写**：账号库里可能是共享库的一个子集（甚至空库），
 * 拿它去覆盖共享库 = 把使用者全部历史会话删掉。
 *
 * 顺序（每一步都有事故背书）：
 *   标记检查 → 活库检查 → 源库 quick_check → checkpoint → 备份共享库
 *   → 拷贝 → 清 shm → 复检共享库 → 坏了就还原 → 删标记
 *
 * @param {string} dataV2   账号的 .zcode/v2 目录
 * @param {string} sharedV2 共享的 .zcode/v2 目录
 * @param {string} [accountId] 仅用于日志
 * @returns {string} 说明串
 */
function syncOut(dataV2, sharedV2, accountId) {
  if (!dataV2 || !sharedV2) return 'no-path';
  if (!fs.existsSync(markPath(dataV2))) return 'not-seeded';
  if (zcodeRunningSync()) return 'running';        // 活库上覆盖 = 写坏它

  const src = path.join(dataV2, 'tasks-index.sqlite');

  // ⚠【必须有这道门】源库不存在就直接返回，绝不能让 copyDbFamily 的 `:nosrc` 分支跑起来。
  //
  //   copyDbFamily 对"源端没有库"的处理是**删掉目标端**（那是对的语义：源端发话了，
  //   说这个库不该存在）。用在 syncIn（共享→账号）上没问题；
  //   但用在**回写方向**上就是灾难：标记还在、库被删了（使用者手删了、清理工具删了、
  //   或上一轮播种失败只留下了标记）时，它会去删**共享库** —— 使用者的全部会话记录
  //   一次性清空。
  //
  //   而且这个错误**不会被发现**：quickCheckDb 对"文件不存在"返回 {ok:true,'absent'}，
  //   所以下面的复检会判定"健康"，备份还原分支根本不会触发 —— 静默清空。
  //
  //   实测复现：造一个只有 .session-index-seeded、没有 tasks-index.sqlite 的账号目录，
  //   调 syncOut 后共享库消失。故此处硬拦：没有源就什么都不做。
  if (!fs.existsSync(src)) return 'no-source-db';

  const chk = quickCheckDb(src);
  if (!chk.ok) return 'source-corrupt:' + chk.reason;   // 坏库绝不推回共享库
  if (fs.statSync(src).size === 0) return 'empty-source-db';   // 0 字节同样不能覆盖共享库

  const notes = ['checkpoint:' + checkpointDb(src)];
  const bak = backupShared(dataV2, sharedV2, null, 'out-' + (accountId || 'cur'));
  notes.push('backup:' + bak.tag);

  copyDbFamily(dataV2, sharedV2, 'tasks-index.sqlite', notes);
  try { fs.rmSync(path.join(sharedV2, SHM), { force: true }); } catch (_) { /* 忽略 */ }

  // 复检共享库；坏了就还原备份 —— 共享库绝不能被切号写坏
  //
  // ⚠ 这里**不能只看 after.ok**：quickCheckDb 对"文件不存在"返回 ok('absent')，
  //   而同步刚刚才写过这个文件，它**不该**是 absent。
  //   少了这层判断的话，"拷贝没成功但也没报错"（比如被别的进程挡住、被安全软件拦下）
  //   会被判成 post-check:ok，共享库其实已经没了却没人知道 —— 静默清空。
  //   所以：写过之后还读不到 = 失败，走还原。
  const sharedDb = path.join(sharedV2, 'tasks-index.sqlite');
  const after = quickCheckDb(sharedDb);
  const gone = !fs.existsSync(sharedDb) || fs.statSync(sharedDb).size === 0;
  if (gone || !after.ok) {
    const n = restoreShared(sharedV2, bak.files);
    const why = gone ? 'shared-db-missing-after-copy' : after.reason;
    notes.push('post-check-FAILED:' + why + '→restored(' + n + ')');
  } else {
    notes.push('post-check:ok');
  }

  try { fs.rmSync(markPath(dataV2), { force: true }); } catch (_) { /* 无妨 */ }
  return notes.join(', ');
}

/**
 * 按账号 id 回写（main.js 用这个 —— 它手上只有 id）。
 * `accountId` 找不到目录或没播种过时如实返回原因，不抛。
 *
 * @param {string} accountId
 * @param {string} sharedV2
 * @param {string} accountsRoot 账号库根目录（用于定位备份/日志）
 */
function syncOutAccount(accountId, sharedV2, accountsRoot) {
  if (!accountId || !sharedV2) return 'no-account';
  const dataV2 = path.join(accountsRoot, accountId, 'data', '.zcode', 'v2');
  return logSyncResult('回写', accountId, dataV2, sharedV2, () => {
    if (!fs.existsSync(dataV2)) return 'no-datadir';
    return syncOut(dataV2, sharedV2, accountId);
  });
}

// ---------------------------------------------------------------- 播种：共享 → 账号

/**
 * 共享 → 账号（进入前）。顺带清掉早期版本留下的符号链接。
 * @param {string} dataV2   账号的 .zcode/v2 目录
 * @param {string} sharedV2 共享的 .zcode/v2 目录
 * @param {string} [accountId] 仅用于日志
 */
function syncIn(dataV2, sharedV2, accountId) {
  if (!dataV2 || !sharedV2) return 'no-path';

  return logSyncResult('播种', accountId, dataV2, sharedV2, () => {
    const notes = [];

    // ① 【关键】先把**上一个播种过的账号**回写进共享库。
    //
    // 旧版靠模块级 `let lastSeeded` 记这个 —— 面板一重启就丢了，于是
    // 「关机/重启面板 → 切号」这条路静默不回写，那个账号的会话沉在私有库里。
    // 现在扫磁盘上的标记文件：**谁的账号目录里有标记，谁就是上次播种的那个**。
    // 客户端此刻已退出（所有调用点都在 killZCode 之后），所以回写是安全的。
    for (const prev of findSeeded(dataV2, sharedV2)) {
      if (path.resolve(prev.dataV2) === path.resolve(dataV2)) continue;   // 就是本次要进的账号，跳过
      notes.push('prev[' + prev.id + ':' + syncOut(prev.dataV2, sharedV2, prev.id) + ']');
    }

    if (zcodeRunningSync()) return 'running';   // 动活库 = 写坏它
    try { fs.mkdirSync(dataV2, { recursive: true }); } catch (_) { return 'failed'; }

    // ② 共享库先校验 + checkpoint，坏库/半落盘绝不拷进账号
    const srcDb = path.join(sharedV2, 'tasks-index.sqlite');
    if (fs.existsSync(srcDb)) {
      const chk = quickCheckDb(srcDb);
      if (!chk.ok) return 'source-corrupt:' + chk.reason;
    }
    notes.push('checkpoint:' + checkpointDb(srcDb));

    // ③ 清掉早期版本留下的符号链接（连同 shm）
    for (const n of SYNC_FILES.concat([SHM])) {
      const d = path.join(dataV2, n);
      try { if (fs.lstatSync(d).isSymbolicLink()) { fs.unlinkSync(d); notes.push(n + ':unlink'); } } catch (_) { /* 不存在就算了 */ }
    }

    // ④ 拷 main + wal（内部处理陈旧 wal 覆盖问题）
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

    // ⑤ 陈旧 shm 一律删掉，让 SQLite 按主库+wal 重建
    try { fs.rmSync(path.join(dataV2, SHM), { force: true }); } catch (_) { /* 无妨 */ }
    try { fs.writeFileSync(markPath(dataV2), new Date().toISOString(), 'utf8'); } catch (_) { /* 无妨 */ }

    return notes.join(', ');
  });
}

/**
 * 找出所有「已播种」的账号（磁盘标记为准），返回 [{id, dataV2}]。
 *
 * 遍历的是**账号库的同级结构**：从传入的 dataV2 往上还原到账号库根，
 * 再逐个账号看 `<账号>/data/.zcode/v2/.session-index-seeded`。
 * 拿不到账号库（结构不符合预期）时返回空数组 —— 只是少一次回写机会，不阻断切号。
 *
 * @param {string} dataV2   本次要播种的账号数据目录（用于反推账号库根）
 * @param {string} sharedV2 共享目录（跳过 dataV2 本身用得到）
 */
function findSeeded(dataV2, sharedV2) {
  const out = [];
  try {
    // dataV2 形如 <accountsRoot>/<id>/data/.zcode/v2 → 往上 4 层
    const dataRoot = path.resolve(dataV2, '..', '..');        // <accountsRoot>/<id>/data
    const idDir = path.resolve(dataRoot, '..');               // <accountsRoot>/<id>
    const accountsRoot = path.resolve(idDir, '..');           // <accountsRoot>
    for (const ent of fs.readdirSync(accountsRoot, { withFileTypes: true })) {
      if (!ent.isDirectory()) continue;
      if (ent.name.startsWith('.') || ent.name === 'node_modules') continue;
      const v2 = path.join(accountsRoot, ent.name, 'data', '.zcode', 'v2');
      try {
        if (!fs.existsSync(markPath(v2))) continue;
        if (path.resolve(v2) === path.resolve(dataV2)) continue;
        out.push({ id: ent.name, dataV2: v2 });
      } catch (_) { /* 单个账号读不了不影响其他 */ }
    }
  } catch (_) { /* 账号库结构不符合预期：跳过 */ }
  return out;
}

module.exports = {
  syncIn,
  syncOut,
  syncOutAccount,
  // 供 main.js / 验证脚本使用
  quickCheckDb,
  checkpointDb,
  zcodeRunningSync,
  logSessionIndex,
  logSyncResult,
  // 备份与还原：导出是为了让"回写把共享库写坏 → 自动还原"这条支路
  // 能被验证脚本真正跑到。不能验证的回滚等于没有回滚。
  backupShared,
  restoreShared,
  logFile,
  backupDir,
  SYNC_FILES,
  MARK,
};
