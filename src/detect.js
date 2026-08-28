'use strict';
/**
 * detect.js — 检测 ZCode 安装路径、版本、运行状态、空闲端口
 * 零依赖，全部使用 Node 原生能力 + PowerShell 只读查询。
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const net = require('net');
const { execFile } = require('child_process');

const ZCODE_EXE_NAME = 'ZCode.exe';

/** 常见安装位置（按优先级） */
function candidatePaths() {
  const candidates = [];
  // 环境变量显式指定
  if (process.env.ZCODE_HOME) {
    candidates.push(path.join(process.env.ZCODE_HOME, ZCODE_EXE_NAME));
    candidates.push(path.join(process.env.ZCODE_HOME, '..', ZCODE_EXE_NAME));
  }
  // 已知安装盘
  for (const drive of ['D:', 'C:', 'E:']) {
    candidates.push(path.join(drive, '\\Zcode', ZCODE_EXE_NAME));
    candidates.push(path.join(drive, '\\ZCode', ZCODE_EXE_NAME));
    candidates.push(path.join(drive, '\\Program Files', 'ZCode', ZCODE_EXE_NAME));
    candidates.push(path.join(drive, '\\Program Files (x86)', 'ZCode', ZCODE_EXE_NAME));
  }
  // 用户目录（便携版可能）
  candidates.push(path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'ZCode', ZCODE_EXE_NAME));
  candidates.push(path.join(os.homedir(), 'ZCode', ZCODE_EXE_NAME));
  return candidates;
}

/** 解析开始菜单快捷方式，拿到 ZCode.exe 真实路径（只读 PowerShell） */
function shortcutTarget() {
  return new Promise((resolve) => {
    const lnk = path.join(
      process.env.APPDATA || '',
      'Microsoft', 'Windows', 'Start Menu', 'Programs', 'ZCode.lnk'
    );
    if (!fs.existsSync(lnk)) return resolve(null);
    const ps = [
      `$s=(New-Object -ComObject WScript.Shell).CreateShortcut('${lnk.replace(/'/g, "''")}');`,
      `Write-Output $s.TargetPath`
    ].join('');
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], {
      timeout: 10000, windowsHide: true,
    }, (err, stdout) => {
      if (err) return resolve(null);
      const p = String(stdout).trim();
      resolve(p && fs.existsSync(p) ? p : null);
    });
  });
}

/** 找到 ZCode.exe 完整路径 */
async function findZCodeExe() {
  for (const p of candidatePaths()) {
    if (fs.existsSync(p)) return p;
  }
  const viaLnk = await shortcutTarget();
  if (viaLnk && /zcode\.exe$/i.test(viaLnk)) return viaLnk;
  return null;
}

/** 读取 exe 版本号（PowerShell 只读） */
function getVersion(exePath) {
  return new Promise((resolve) => {
    const ps = `(Get-Item '${String(exePath).replace(/'/g, "''")}').VersionInfo | Select-Object FileVersion,ProductVersion | ConvertTo-Json -Compress`;
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], {
      timeout: 10000, windowsHide: true,
    }, (err, stdout) => {
      if (err) return resolve(null);
      try {
        const j = JSON.parse(stdout.trim());
        resolve(j.FileVersion || j.ProductVersion || null);
      } catch {
        resolve(null);
      }
    });
  });
}

/** ZCode 进程是否在运行 */
function isZCodeRunning() {
  return new Promise((resolve) => {
    execFile('tasklist.exe', ['/FI', `IMAGENAME eq ${ZCODE_EXE_NAME}`, '/FO', 'CSV', '/NH'], {
      timeout: 10000, windowsHide: true,
    }, (err, stdout) => {
      if (err) return resolve(false);
      resolve(/ZCode\.exe/i.test(stdout));
    });
  });
}

/** 尝试监听端口判断是否空闲（true = 空闲），返回可用端口 */
function findFreePort(preferred = 9335) {
  return new Promise((resolve) => {
    const tryPort = (port, attemptsLeft) => {
      if (attemptsLeft <= 0) return resolve(0);
      const srv = net.createServer();
      srv.unref();
      srv.once('error', () => {
        srv.close();
        tryPort(port + 1, attemptsLeft - 1);
      });
      srv.once('listening', () => {
        const used = srv.address().port;
        srv.close(() => resolve(used));
      });
      srv.listen(port, '127.0.0.1');
    };
    tryPort(preferred, 50);
  });
}

/** 汇总一次完整检测 */
async function detectAll() {
  const exe = await findZCodeExe();
  const [version, running] = await Promise.all([
    exe ? getVersion(exe) : Promise.resolve(null),
    isZCodeRunning(),
  ]);
  return {
    exe,
    version,
    running,
    installDir: exe ? path.dirname(exe) : null,
    home: path.join(os.homedir(), '.zcode'),
    skinDir: path.join(os.homedir(), '.zcode', 'skin'),
  };
}

module.exports = {
  ZCODE_EXE_NAME,
  candidatePaths,
  findZCodeExe,
  getVersion,
  isZCodeRunning,
  findFreePort,
  detectAll,
};
