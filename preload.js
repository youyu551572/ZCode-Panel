'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('zpanel', {
  listAccounts: () => ipcRenderer.invoke('accounts:list'),
  currentUser: () => ipcRenderer.invoke('accounts:current'),
  plans: () => ipcRenderer.invoke('accounts:plans'),
  capture: (id, replace) => ipcRenderer.invoke('accounts:capture', id, replace),
  switchTo: (id, opts) => ipcRenderer.invoke('accounts:switch', id, opts),
  remove: (id) => ipcRenderer.invoke('accounts:delete', id),
  rollback: () => ipcRenderer.invoke('accounts:rollback'),
  oauthSessionStatus: () => ipcRenderer.invoke('oauth:session-status'),
  oauthResetSession: (provider) => ipcRenderer.invoke('oauth:reset-session', provider),
  calibrate: () => ipcRenderer.invoke('accounts:calibrate'),
  oauthStart: (provider, mode, options) => ipcRenderer.invoke('oauth:start', provider, mode, options),
  oauthProbeRegion: (provider) => ipcRenderer.invoke('oauth:probe-region', provider),
  // ZCode 自己的代理（写 setting.json；环境变量 ZCODE_HTTP_PROXY 它不读）
  proxyGet: () => ipcRenderer.invoke('proxy:get'),
  proxySet: (url) => ipcRenderer.invoke('proxy:set', url),
  oauthLink: (provider, mode) => ipcRenderer.invoke('oauth:link', provider, mode),
  oauthSubmit: (input) => ipcRenderer.invoke('oauth:submit', input),
  // 自动化进度事件流
  onPanelEvent: (cb) => {
    const h = (_e, payload) => cb(payload);
    ipcRenderer.on('panel:event', h);
    return () => ipcRenderer.removeListener('panel:event', h);
  },
  // 主进程向使用者索要输入（手机号 / 短信验证码 / 邮箱 / 激活链接）
  onPanelAsk: (cb) => {
    const h = (_e, payload) => cb(payload);
    ipcRenderer.on('panel:ask', h);
    return () => ipcRenderer.removeListener('panel:ask', h);
  },
  onPanelAskCancel: (cb) => {
    const h = (_e, payload) => cb(payload);
    ipcRenderer.on('panel:ask-cancel', h);
    return () => ipcRenderer.removeListener('panel:ask-cancel', h);
  },
  panelAnswer: (id, value) => ipcRenderer.invoke('panel:answer', { id, value }),
  panelAskAbort: (id) => ipcRenderer.invoke('panel:ask-abort', id),
  // 设置：ZCode 客户端位置与账号数据目录
  settingsGet: () => ipcRenderer.invoke('settings:get'),
  settingsDetect: () => ipcRenderer.invoke('settings:detect'),
  settingsVerify: (p) => ipcRenderer.invoke('settings:verify', p),
  settingsSave: (patch) => ipcRenderer.invoke('settings:save', patch),
  settingsPickExe: () => ipcRenderer.invoke('settings:pick-exe'),
  settingsPickDir: () => ipcRenderer.invoke('settings:pick-dir'),
  settingsOpenFolder: (target) => ipcRenderer.invoke('settings:open-folder', target),
  // 启动自检发现客户端不可用时会推一次，界面据此自动打开设置页
  onNeedSetup: (cb) => {
    const h = (_e, payload) => cb(payload);
    ipcRenderer.on('panel:need-setup', h);
    return () => ipcRenderer.removeListener('panel:need-setup', h);
  },
  fetchBalance: (force) => ipcRenderer.invoke('balance:fetch', force),
  planQuota: (force) => ipcRenderer.invoke('plans:quota', force),
  planRemote: (id) => ipcRenderer.invoke('plan:remote', id),
  planState: () => ipcRenderer.invoke('plan:state'),
  openApp: () => ipcRenderer.invoke('app:open'),
  // 外链一律交给系统默认浏览器打开（主进程侧带地址白名单校验）
  openUrl: (url) => ipcRenderer.invoke('app:open-url', url),
  quitApp: () => ipcRenderer.invoke('app:quit'),
  // 强制更新：检查 GitHub Releases，有新版就要求先更新
  updateCheck: () => ipcRenderer.invoke('update:check'),
  updateOpenDownload: () => ipcRenderer.invoke('update:open-download'),
  updateOpenPage: () => ipcRenderer.invoke('update:open-page'),
  updateQuit: () => ipcRenderer.invoke('update:quit'),
});
