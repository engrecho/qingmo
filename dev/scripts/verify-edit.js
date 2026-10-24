#!/usr/bin/env node
/**
 * 编辑状态全面验证（真实 Electron 窗口 + 真实 CodeMirror）
 *
 * 跟 verify-ui.js 的区别：那个只覆盖了 10 项（列表行首 + live-edit 焦点），
 * 这个把 22 个命令和多标签/预览区编辑的边界都过一遍。
 *
 * 覆盖：
 *   A. 格式命令（fmt:*）—— 包裹/取消包裹/无选区占位
 *   B. 插入命令（ins:*）—— 空文档、有选区、无选区
 *   C. 标题升降级
 *   D. 列表前缀 toggle（v1.5.0 新逻辑）
 *   E. live-edit 预览区编辑边界
 *   F. 多标签切换
 *   G. 组合场景（先插结构再改字）
 *
 * 用法：npx electron --no-sandbox --disable-gpu scripts/verify-edit.js
 */
if (!process.versions.electron) {
  console.error('用 electron 跑：npx electron --no-sandbox --disable-gpu scripts/verify-edit.js');
  process.exit(1);
}

const path = require('path');
const fs = require('fs');
const util = require('util');
const log = (...a) => console.error(util.format(...a));

const DEV = path.join(__dirname, '..');
const { app, BrowserWindow } = require('electron');

const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass: !!pass, detail: detail || '' });
};

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1280, height: 820, show: false,
    webPreferences: {
      preload: path.join(DEV, 'src', 'main', 'preload.js'),
      contextIsolation: true, nodeIntegration: false
    }
  });

  const errors = [];
  win.webContents.on('console-message', (e, level, message) => {
    if (level >= 2) errors.push(message);
  });

  await win.loadFile(path.join(DEV, 'src', 'renderer', 'index.html'), { query: { test: '1' } });
  await new Promise(r => setTimeout(r, 900));

  const js = (code) => win.webContents.executeJavaScript(code, true);
  const hasHook = await js('typeof window.__qingmo === "object"');
  if (!hasHook) {
    check('测试钩子注入', false, 'window.__qingmo 不存在（bundle 是不是没重新构建？）');
    report();
    return;
  }
  check('测试钩子注入', true);

  /* 在页面里跑一段测试脚本，返回结果数组 */
  const pageScript = `(async () => {
    const Q = window.__qingmo;
    const out = [];
    const eq = (name, actual, expected) => {
      const pass = actual === expected;
      out.push({ name, pass, detail: pass ? '' : ('期望 ' + JSON.stringify(expected) + ' / 实际 ' + JSON.stringify(actual)) });
    };
    const ok = (name, pass, detail) => out.push({ name, pass: !!pass, detail: detail || '' });

    /** 设定文档 + 选区，然后跑命令，返回新文档 */
    function act(doc, from, to, cmd) {
      Q.setDoc(doc, from);
      if (to != null) {
        Q.setCursor(to);
        // setCursor 只设 anchor，要设 range 用 setDoc 的 selection
        const v = window.__view;
        v.dispatch({ selection: { anchor: from, head: to } });
      }
      Q.run(cmd);
      return Q.getDoc();
    }
    /** 只设光标（无选区） */
    function actAt(doc, pos, cmd) {
      Q.setDoc(doc, pos);
      Q.run(cmd);
      return Q.getDoc();
    }
    /** 选中一段文字 */
    function actSel(doc, from, to, cmd) {
      Q.setDoc(doc, from);
      window.__view.dispatch({ selection: { anchor: from, head: to } });
      Q.run(cmd);
      return Q.getDoc();
    }

    // 每条用例独立 try/catch：一条抛异常不该让整轮测试挂掉
    const guard = (fn) => { try { return fn(); } catch (e) { return { __err: String((e && e.message) || e) }; } };
    const eqG = (name, fn, expected) => {
      const r = guard(fn);
      if (r && r.__err !== undefined) {
        out.push({ name, pass: false, detail: '抛异常: ' + r.__err });
      } else {
        eq(name, r, expected);
      }
    };
    const okG = (name, fn, detail) => {
      const r = guard(fn);
      if (r && r.__err !== undefined) {
        out.push({ name, pass: false, detail: '抛异常: ' + r.__err });
      } else {
        ok(name, !!r, typeof detail === 'function' ? detail() : detail);
      }
    };

    /* ============ A. 格式命令 ============ */
    eqG('A/加粗-包裹选区', () => actSel('hello', 0, 5, 'fmt:bold'), '**hello**');
    eqG('A/加粗-再次取消', () => actSel('**hello**', 2, 7, 'fmt:bold'), 'hello');
    eqG('A/斜体-包裹选区', () => actSel('hello', 0, 5, 'fmt:italic'), '*hello*');
    eqG('A/删除线-包裹选区', () => actSel('hello', 0, 5, 'fmt:strike'), '~~hello~~');
    eqG('A/行内代码-包裹选区', () => actSel('hello', 0, 5, 'fmt:code'), '\`hello\`');
    eqG('A/加粗-无选区插占位', () => actAt('', 0, 'fmt:bold'), '****');
    eqG('A/行内代码-无选区', () => actAt('', 0, 'fmt:code'), '\`\`');

    /* ============ B. 插入命令 ============ */
    okG('B/插入表格', () => actAt('', 0, 'ins:table').includes('| 表头'), () => JSON.stringify(actAt('', 0, 'ins:table')));
    okG('B/插入引用', () => actAt('', 0, 'ins:quote').includes('> '), () => JSON.stringify(actAt('', 0, 'ins:quote')));
    okG('B/插入代码块', () => actAt('', 0, 'ins:code').includes('\`\`\`'), () => JSON.stringify(actAt('', 0, 'ins:code')));
    okG('B/插入无序列表', () => actAt('', 0, 'ins:ul').includes('- '), () => JSON.stringify(actAt('', 0, 'ins:ul')));
    okG('B/插入有序列表', () => actAt('', 0, 'ins:ol').includes('1. '), () => JSON.stringify(actAt('', 0, 'ins:ol')));
    okG('B/插入任务列表', () => actAt('', 0, 'ins:todo').includes('- [ ]'), () => JSON.stringify(actAt('', 0, 'ins:todo')));
    okG('B/插入分隔线', () => actAt('', 0, 'ins:hr').includes('---'), () => JSON.stringify(actAt('', 0, 'ins:hr')));
    okG('B/插入链接', () => actAt('', 0, 'ins:link').includes(']('), () => JSON.stringify(actAt('', 0, 'ins:link')));
    // 插入图片现在是弹窗（选本地 / 远程），不再直接往文档里塞语法。
    // 这里只验证「命令确实触发了弹窗」，具体两种插入路径由 verify-ui-changes.js 覆盖。
    okG('B/插入图片弹窗', () => {
      Q.setDoc('', 0);
      Q.run('ins:image');
      const dlg = document.querySelector('.modal-mask');
      const acts = dlg ? Array.from(dlg.querySelectorAll('.img-choice')).map(b => b.dataset.act) : [];
      if (dlg) dlg.remove();
      return acts.includes('local') && acts.includes('remote');
    }, () => '未出现本地/远程两个选项');

    /* 表格用选区当表头 */
    eqG('B/表格-选区当表头', () => actSel('A\\nB\\nC', 0, 5, 'ins:table'),
      '| A | B | C |\\n| --- | --- | --- |\\n|   |   |   |\\n');

    /* 插入到已有文本中间 */
    eqG('B/插入列表-行首', () => actAt('第一行\\n第二行', 4, 'ins:ul'), '第一行\\n- 第二行');

    /* ============ C. 标题升降级 ============ */
    eqG('C/无标题行变H1', () => actAt('内容', 0, 'fmt:h1'), '# 内容');
    eqG('C/H1再按变正文', () => actAt('# 内容', 0, 'fmt:h1'), '内容');
    eqG('C/H1变H2', () => actAt('# 内容', 0, 'fmt:h2'), '## 内容');
    eqG('C/无选区加H3', () => actAt('内容', 2, 'fmt:h3'), '### 内容');

    /* ============ D. 列表前缀 toggle ============ */
    eqG('D/行首插无序', () => actAt('第一行\\n第二行', 4, 'ins:ul'), '第一行\\n- 第二行');
    eqG('D/再点撤销', () => actAt('第一行\\n- 第二行', 4, 'ins:ul'), '第一行\\n第二行');
    eqG('D/行首插任务', () => actAt('待办', 0, 'ins:todo'), '- [ ] 待办');
    eqG('D/任务再点撤销', () => actAt('- [ ] 待办', 0, 'ins:todo'), '待办');
    eqG('D/行首插引用', () => actAt('引文', 0, 'ins:quote'), '> 引文');
    eqG('D/引用再点撤销', () => actAt('> 引文', 0, 'ins:quote'), '引文');

    /* 多行选区：逐行加前缀，序号递增 */
    eqG('D/多行选区加有序前缀', () => actSel('甲\\n乙\\n丙', 0, 5, 'ins:ol'), '1. 甲\\n2. 乙\\n3. 丙');
    /* 多行选区：再点一次应全部撤销 */
    eqG('D/多行选区再点撤销', () => actSel('1. 甲\\n2. 乙\\n3. 丙', 0, 14, 'ins:ol'), '甲\\n乙\\n丙');

    /* 光标在行中间时，作用行首而不是光标处 */
    eqG('D/光标在行中间仍作用行首', () => actAt('这是内容', 3, 'ins:ul'), '- 这是内容');

    /* ============ E. live-edit 预览区 ============ */
    ok('E/预览区可聚焦', Q.focusInPreview(0), 'focusInPreview 返回 false');

    /* 预览区改字后源码同步 */
    {
      Q.setDoc('# 标题\\n\\n原始段落', 0);
      Q.setLiveEdit(true);
      await new Promise(r => setTimeout(r, 200));
      const el = document.getElementById('preview').children[1];
      ok('E/预览区有内容块', !!el, 'children[1] 不存在');
      if (el) {
        el.textContent = '改过的段落';
        el.dispatchEvent(new Event('input', { bubbles: true }));
        await new Promise(r => setTimeout(r, 300));
        const doc = Q.getDoc();
        ok('E/预览区改字回写源码', doc.includes('改过的段落'), '源码: ' + JSON.stringify(doc));
        ok('E/回写不影响其他块', doc.includes('# 标题'), '源码: ' + JSON.stringify(doc));
      }
      Q.setLiveEdit(false);
    }

    /* 预览区删除整段 */
    {
      Q.setDoc('# 标题\\n\\n要删的段落\\n\\n保留', 0);
      Q.setLiveEdit(true);
      await new Promise(r => setTimeout(r, 200));
      const el = document.getElementById('preview').children[1];
      if (el) {
        el.textContent = '';
        el.dispatchEvent(new Event('input', { bubbles: true }));
        await new Promise(r => setTimeout(r, 300));
        const doc = Q.getDoc();
        ok('E/删空段后其他内容还在', doc.includes('保留'), '源码: ' + JSON.stringify(doc));
        ok('E/删空段后原文消失', !doc.includes('要删的段落'), '源码: ' + JSON.stringify(doc));
      }
      Q.setLiveEdit(false);
    }

    /* ============ F. 组合场景 ============ */
    eqG('F/先插表格再改单元格', () => {
      Q.setDoc('', 0);
      Q.run('ins:table');
      const d = Q.getDoc();
      // 选中表格里的「内容 1」加粗
      const i = d.indexOf('内容 1');
      Q.setDoc(d, i);
      window.__view.dispatch({ selection: { anchor: i, head: i + 4 } });
      Q.run('fmt:bold');
      return Q.getDoc().includes('**内容 1**');
    }, true);

    /* 连续操作：加粗 → 斜体 → 看是否叠加 */
    {
      Q.setDoc('文字', 0);
      window.__view.dispatch({ selection: { anchor: 0, head: 2 } });
      Q.run('fmt:bold');
      Q.run('fmt:italic');
      const d = Q.getDoc();
      ok('F/加粗后斜体可叠加', d === '***文字***' || d === '**_文字_**', '实际: ' + JSON.stringify(d));
    }

    /* ============ G. 边界 ============ */
    eqG('G/空文档加粗不崩', () => actAt('', 0, 'fmt:bold'), '****');
    ok('G/空文档插表格不崩', actAt('', 0, 'ins:table').length > 0, '');
    {
      let crashed = false;
      try { actAt('# 标题', 0, 'fmt:h1'); } catch (e) { crashed = true; }
      ok('G/标题降级不崩', !crashed, '');
    }
    {
      // 文档末尾换行后再插入
      const d = actAt('内容\\n', 3, 'ins:ul');
      ok('G/末尾换行后插列表', d.includes('- '), JSON.stringify(d));
    }

    return out;
  })()`;

  let raw = null;
  try {
    raw = await js(pageScript);
  } catch (e) {
    log('X 页面脚本执行失败: ' + (e && e.message));
    raw = [{ name: 'HARNESS', pass: false, detail: String((e && e.stack) || e) }];
  }
  if (!raw) raw = [{ name: 'HARNESS', pass: false, detail: '页面脚本无返回' }];
  for (const r of raw) check(r.name, r.pass, r.detail);
  if (errors.length) {
    check('渲染进程无报错', false, errors.slice(0, 3).join(' | '));
  } else {
    check('渲染进程无报错', true);
  }

  report();
  function report() {
    let cur = '';
    for (const r of results) {
      if (r.name.startsWith('A/')) { if (cur !== 'A') { console.log('\n── A. 格式命令 ──'); cur = 'A'; } }
      else if (r.name.startsWith('B/')) { if (cur !== 'B') { console.log('\n── B. 插入命令 ──'); cur = 'B'; } }
      else if (r.name.startsWith('C/')) { if (cur !== 'C') { console.log('\n── C. 标题 ──'); cur = 'C'; } }
      else if (r.name.startsWith('D/')) { if (cur !== 'D') { console.log('\n── D. 列表前缀 toggle ──'); cur = 'D'; } }
      else if (r.name.startsWith('E/')) { if (cur !== 'E') { console.log('\n── E. 预览区编辑 ──'); cur = 'E'; } }
      else if (r.name.startsWith('F/')) { if (cur !== 'F') { console.log('\n── F. 组合场景 ──'); cur = 'F'; } }
      else if (r.name.startsWith('G/')) { if (cur !== 'G') { console.log('\n── G. 边界 ──'); cur = 'G'; } }
      if (r.pass) console.log('  ✓ ' + r.name);
      else {
        console.log('  ✗ ' + r.name);
        if (r.detail) console.log('      ' + String(r.detail).split('\n').join('\n      '));
      }
    }
    const pass = results.filter(r => r.pass).length;
    const fail = results.length - pass;
    console.log('\n' + '='.repeat(60));
    console.log('通过 ' + pass + ' / ' + results.length);
    if (fail) console.log('失败 ' + fail);
    const outDir = path.join(DEV, '..', '.cache', 'scratch');
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'verify-edit-result.json'),
      JSON.stringify({ results, pass, fail, total: results.length }, null, 2), 'utf8');
    setTimeout(() => app.exit(fail ? 1 : 0), 200);
  }
});
