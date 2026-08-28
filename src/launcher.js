'use strict';
/**
 * launcher.js — 以 CDP 端口启动/关闭 ZCode，及快捷方式管理
 */

const fs = require('fs');
const path = require('path');
const { spawn, execFile } = require('child_process');

/** 以 --remote-debugging-port 启动 ZCode（detached，不阻塞） */
function launchZCode(exePath, port) {
  return new Promise((resolve, reject) => {
    if (!exePath || !fs.existsSync(exePath)) {
      return reject(new Error(`找不到 ZCode.exe：${exePath}`));
    }
    const child = spawn(exePath, [`--remote-debugging-port=${port}`], {
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
    });
    child.once('error', reject);
    child.unref();
    resolve({ pid: child.pid, port });
  });
}

/** 关闭 ZCode（全部实例）。用 PowerShell 避免 Git Bash 下 taskkill /IM 被路径转换 */
function closeZCode() {
  return new Promise((resolve, reject) => {
    execFile('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command',
        'Get-Process ZCode -ErrorAction SilentlyContinue | Stop-Process -Force'],
      { timeout: 15000, windowsHide: true },
      (err) => {
        if (err) return reject(new Error(`关闭 ZCode 失败：${err.message}`));
        resolve({ killed: true });
      });
  });
}

/** 开始菜单快捷方式路径 */
function shortcutPath() {
  return path.join(
    process.env.APPDATA || '',
    'Microsoft', 'Windows', 'Start Menu', 'Programs', 'ZCode.lnk'
  );
}

/**
 * 给开始菜单 ZCode.lnk 增加/移除 --remote-debugging-port 参数。
 * 用 PowerShell WScript.Shell 保留原 Target/Icon/WorkDir。
 */
function setShortcutPort(port, enable) {
  return new Promise((resolve, reject) => {
    const lnk = shortcutPath();
    if (!fs.existsSync(lnk)) return reject(new Error(`未找到快捷方式：${lnk}`));
    const ps = [
      `$s=(New-Object -ComObject WScript.Shell).CreateShortcut('${lnk.replace(/'/g, "''")}');`,
      `$args = @($s.Arguments -split '\\s+' | Where-Object { $_ -and $_ -notmatch '^--remote-debugging-port=' });`,
      enable ? `$args += '--remote-debugging-port=${port}';` : '',
      `$s.Arguments = $args -join ' ';`,
      `$s.Save()`,
    ].join('');
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], {
      timeout: 15000, windowsHide: true,
    }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`修改快捷方式失败：${stderr || err.message}`));
      resolve({ shortcut: lnk, enabled: enable, port });
    });
  });
}

/** 读取快捷方式当前 Arguments（只读） */
function getShortcutArgs() {
  return new Promise((resolve) => {
    const lnk = shortcutPath();
    if (!fs.existsSync(lnk)) return resolve(null);
    const ps = [
      `$s=(New-Object -ComObject WScript.Shell).CreateShortcut('${lnk.replace(/'/g, "''")}');`,
      `Write-Output $s.Arguments`
    ].join('');
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], {
      timeout: 10000, windowsHide: true,
    }, (err, stdout) => {
      resolve(err ? null : String(stdout).trim());
    });
  });
}

module.exports = { launchZCode, closeZCode, setShortcutPort, getShortcutArgs, shortcutPath };
