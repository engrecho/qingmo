/**
 * Windows 文件关联 —— 检查与修复
 *
 * 为什么需要：
 *   v1.5.0 才在 package.json 里加了 fileAssociations 声明，
 *   而【已安装的旧版本不会自动注册】—— 用户双击 .md 打开的还是
 *   Windows 自带的 md_auto_file，不是轻墨。
 *   而且注册表里的关联可能被别的软件（Typora / Obsidian / VS Code）抢走。
 *
 * 排查这类问题时，日志里能直接看到「关联指向谁」，一眼就知道。
 */
const { execFile } = require('child_process');
const path = require('path');
const util = require('util');

const log = (...a) => console.error(util.format(...a));

const EXTS = ['md', 'markdown', 'mdown', 'mkd', 'mkdn', 'mdtxt', 'mdtext'];
const PROGID = 'Markdown';

/**
 * 跑 reg.exe 读注册表，返回 stdout 文本。
 * 失败（被策略拦 / 不存在）时返回 null —— 调用方会走 PowerShell 降级。
 */
function reg(args, timeout) {
  return new Promise((resolve) => {
    try {
      execFile('reg.exe', args, { timeout: timeout || 5000, windowsHide: true },
        (err, stdout) => resolve(err ? null : stdout));
    } catch (e) {
      resolve(null);
    }
  });
}

/**
 * PowerShell 降级 —— 有些环境 reg.exe 会被安全策略拦掉。
 * 写法上要小心引号：路径里的反斜杠在 PowerShell 里没问题，
 * 但值里可能有空格，所以用 -EncodedCommand 传 UTF-16LE 更稳。
 */
function ps(script, timeout) {
  return new Promise((resolve) => {
    try {
      const enc = Buffer.from(script, 'utf16le').toString('base64');
      execFile('powershell.exe',
        ['-NoProfile', '-NonInteractive', '-EncodedCommand', enc],
        { timeout: timeout || 8000, windowsHide: true, maxBuffer: 1024 * 1024 },
        (err, stdout) => resolve(err ? null : stdout));
    } catch (e) {
      resolve(null);
    }
  });
}

/** 读某个键的默认值 */
async function regQuery(key) {
  let out = await reg(['query', key, '/ve']);
  if (out !== null) {
    const m = /^\s*\(Default\)\s+REG_(?:SZ|EXPAND_SZ)\s+(.*)$/mi.exec(out);
    if (m) return m[1].trim();
  }
  // 降级：PowerShell
  const p = await ps(
    `$ErrorActionPreference='SilentlyContinue';` +
    `$v=(Get-ItemProperty -LiteralPath 'Registry::${key.replace(/'/g, "''")}' -Name '(default)' -ErrorAction SilentlyContinue).'(default)';` +
    `if($v){$v}else{'__NONE__'}`);
  if (p === null) return null;
  const t = p.trim();
  if (!t || t === '__NONE__') return null;
  return t;
}

/**
 * 检查 .md 之类的扩展名当前关联到哪个程序。
 *
 * @returns {Promise<{ext, progid, isQingMo, command}>}
 */
async function check() {
  const results = [];
  for (const ext of EXTS) {
    const key = 'HKCU\\Software\\Classes\\.' + ext;
    const progid = await regQuery(key);
    let command = '';
    let isQingMo = false;
    if (progid) {
      command = (await regQuery(key + '\\shell\\open\\command')) || '';
      isQingMo = /qingmo|轻墨/i.test(command) || progid === PROGID;
    }
    results.push({ ext, progid: progid || '(未关联)', command, isQingMo });
  }
  return results;
}

/** 当前 exe 路径（安装后的） */
function exePath() {
  return process.execPath;
}

/**
 * 重新注册文件关联（写 HKCU，不需要管理员权限）。
 *
 * 写的内容：
 *   HKCU\Software\Classes\.md          → "Markdown"
 *   HKCU\Software\Classes\Markdown      → 描述 + DefaultIcon
 *   HKCU\Software\Classes\Markdown\shell\open\command → "轻墨.exe" "%1"
 *
 * @returns {Promise<{ok, results}>}
 */
async function register() {
  const exe = exePath();
  const results = [];

  for (const ext of EXTS) {
    const cmds = [
      ['add', 'HKCU\\Software\\Classes\\.' + ext, '/ve', '/t', 'REG_SZ', '/d', PROGID, '/f'],
      ['add', 'HKCU\\Software\\Classes\\' + PROGID, '/ve', '/t', 'REG_SZ', '/d', 'Markdown 文档', '/f'],
      ['add', 'HKCU\\Software\\Classes\\' + PROGID + '\\DefaultIcon', '/ve', '/t', 'REG_SZ', '/d', '"' + exe + '",0', '/f'],
      ['add', 'HKCU\\Software\\Classes\\' + PROGID + '\\shell\\open\\command', '/ve', '/t', 'REG_SZ', '/d', '"' + exe + '" "%1"', '/f']
    ];
    let ok = true;
    for (const c of cmds) {
      const r = await reg(c);
      if (r === null) { ok = false; break; }
    }
    // reg.exe 不可用时用 PowerShell 兜底
    if (!ok) {
      const exeQ = exe.replace(/'/g, "''");
      const p = await ps(
        `$ErrorActionPreference='Stop';` +
        `$base='HKCU:\\Software\\Classes';` +
        `New-Item -Path "$base\\.${ext}" -Force | Out-Null;` +
        `Set-Item -Path "$base\\.${ext}" -Value '${PROGID}';` +
        `New-Item -Path "$base\\${PROGID}\\shell\\open\\command" -Force | Out-Null;` +
        `Set-Item -Path "$base\\${PROGID}" -Value 'Markdown 文档';` +
        `New-Item -Path "$base\\${PROGID}\\DefaultIcon" -Force | Out-Null;` +
        `Set-Item -Path "$base\\${PROGID}\\DefaultIcon" -Value '"${exeQ}",0';` +
        `Set-Item -Path "$base\\${PROGID}\\shell\\open\\command" -Value ('"' + '${exeQ}' + '" "%1"');` +
        `Write-Output 'OK'`);
      ok = !!p && p.indexOf('OK') >= 0;
    }
    results.push({ ext, ok });
  }
  return { ok: results.every(r => r.ok), results, exe };
}

module.exports = { check, register, EXTS, PROGID };
