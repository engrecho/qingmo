import { EditorView, keymap, lineNumbers, highlightActiveLineGutter,
         drawSelection, dropCursor } from '@codemirror/view';
import { EditorState } from '@codemirror/state';
import { defaultKeymap, history, historyKeymap, indentMore, indentLess, indentWithTab } from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { languages } from '@codemirror/language-data';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { indentUnit } from '@codemirror/language';
import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
import { searchKeymap } from '@codemirror/search';
import { tags as t } from '@lezer/highlight';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { headings } from './outline';
import { orderedListRange, renumberList } from './list-actions';
import { imageHtml, loadLocalImages } from './local-images';
import { splitBlocks, elementToMarkdown, annotateBlocks } from './live-edit';
import { planBlockAfter, coveringEmphasis, findEmphasisAt } from './editor-core';
import { planEnter, planBackspace, planTab, parseTableRow, isTableDivider, makeTableRow, parseListItem } from './editor-keys';
import { install as installLogger, logError, logInfo } from './logger.js';

// 全局异常捕获 —— 装在最早，早期报错也能进日志
installLogger();
// 平台标记：写入 <html data-platform="...">，供 styles/mac.css、styles/win.css
// 做平台专属样式（macOS 标题栏左侧要避让系统红绿灯）。
// 以副作用模块引入，保证首帧绘制前就生效，避免闪一下默认布局。
import './platform/index.js';

const DEFAULT_DOC = `# 欢迎使用轻墨

**轻墨** 是一个简洁轻量的 Markdown 编辑器。左边写，右边即时看到成品。

## 快速上手

| 想做什么 | 怎么做 |
| --- | --- |
| 保存 | Ctrl+S |
| 插入表格 | Ctrl+T |
| 插入引用 | Ctrl+Shift+Q |
| 切换视图 | Ctrl+1 / 2 / 3 |
| 深色模式 | Ctrl+D |

## 表格

选中若干行再按 Ctrl+T，首行自动作表头：

| 功能 | 快捷键 | 说明 |
| --- | --- | --- |
| 加粗 | Ctrl+B | 选中文字后按，再次按下取消 |
| 插入表格 | Ctrl+T | 无选区时插入空白表格 |
| 导出 HTML | Ctrl+Shift+E | 生成带样式的独立网页 |

## 代码

\`\`\`js
function hello(name) {
  return \`你好，\${name}\`;
}
\`\`\`

## 引用

> 好工具应该让人忘记它的存在。
> 你只管写，格式交给它。

- [x] 实时预览
- [x] 快捷插入表格 / 引用 / 列表
- [x] 深色模式
- [ ] 自定义主题（计划中）

---

*试试拖动中间的分隔线，或按 Ctrl+3 只看预览。*
`;

/* ============ Editor 初始化 ============ */
const editorTheme = EditorView.theme({
  "&": { color: "var(--fg)", backgroundColor: "var(--bg)", height: "100%" },
  ".cm-content": { caretColor: "var(--caret)", padding: "14px 0" },
  ".cm-line": { padding: "0 16px" },
  // 行号那一列：CodeMirror 内置的 &light .cm-gutters 特异性更高，
  // 不在这里再声明一次的话深色模式会留一条白带。
  ".cm-gutters": { backgroundColor: "var(--c-25)", color: "var(--c-400)" },
  ".cm-activeLineGutter": { backgroundColor: "transparent" },
  ".cm-activeLine": { backgroundColor: "transparent" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--caret)" }
});

const syntaxTheme = EditorView.theme({
  ".cm-header": { color: "var(--accent)", fontWeight: "700" },
  ".cm-strong": { fontWeight: "700" },
  ".cm-emphasis": { fontStyle: "italic" },
  ".cm-strikethrough": { textDecoration: "line-through", color: "var(--fg-faint)" },
  ".cm-monospace": { color: "#7c5cff" },
  ".cm-url": { color: "var(--fg-faint)" },
  ".cm-comment": { color: "var(--fg-faint)", fontStyle: "italic" },
  ".cm-list": { color: "var(--accent)" },
  ".cm-quote": { color: "var(--fg-dim)", fontStyle: "italic" },
  ".cm-hr": { color: "var(--fg-faint)" },
  ".cm-meta": { color: "var(--fg-faint)" },
  ".cm-formatting": { color: "var(--fg-faint)" },
  ".cm-formatting-link": { color: "var(--fg-faint)" },
  ".cm-formatting-list": { color: "var(--accent)" },
  ".cm-tag": { color: "var(--accent)" },
  ".cm-atom": { color: "var(--accent)" },
  ".cm-variable": { color: "#d4506a" }
});

const editorExtensions = [
    lineNumbers(), highlightActiveLineGutter(), history(),
    drawSelection(), dropCursor(),
    EditorState.allowMultipleSelections.of(true),
    indentUnit.of("  "),
    closeBrackets(),
    syntaxHighlighting(HighlightStyle.define([
      { tag: t.heading1, color: "var(--accent)", fontWeight: "700", fontSize: "1.35em" },
      { tag: t.heading2, color: "var(--accent)", fontWeight: "700", fontSize: "1.2em" },
      { tag: t.heading3, color: "var(--accent)", fontWeight: "700" },
      { tag: [t.heading4, t.heading5, t.heading6], color: "var(--accent)", fontWeight: "600" },
      { tag: t.strong, fontWeight: "700", color: "var(--fg)" },
      { tag: t.emphasis, fontStyle: "italic" },
      { tag: t.strikethrough, textDecoration: "line-through", color: "var(--fg-faint)" },
      { tag: t.monospace, color: "#7c5cff" },
      { tag: t.link, color: "var(--accent)" },
      { tag: t.url, color: "var(--fg-faint)" },
      { tag: t.quote, color: "var(--fg-dim)", fontStyle: "italic" },
      { tag: t.list, color: "var(--accent)" },
      { tag: t.processingInstruction, color: "var(--fg-faint)" },
      { tag: t.meta, color: "var(--fg-faint)" },
      { tag: t.comment, color: "var(--fg-faint)", fontStyle: "italic" },
      { tag: t.contentSeparator, color: "var(--fg-faint)" },
      { tag: t.labelName, color: "var(--accent)" },
      { tag: t.keyword, color: "#d4506a" },
      { tag: t.string, color: "#2ea043" }
    ])),
    markdown({ base: markdownLanguage, codeLanguages: languages }),
    keymap.of([
      // ⚠ Markdown 手感必须在 defaultKeymap 之前 ——
      //   defaultKeymap 里也有 Enter/Tab，放后面就抢不到了。
      ...markdownKeymap(),
      { key: "Tab", run: (v) => indentMore(v) || indentLess(v) },
      ...closeBracketsKeymap,
      ...defaultKeymap,
      ...historyKeymap,
      ...searchKeymap,
      indentWithTab,
      ...formattingKeymap()
    ]),
    editorTheme, syntaxTheme,
    EditorView.updateListener.of(onUpdate),
    EditorView.lineWrapping
  ];
const state = EditorState.create({ doc: DEFAULT_DOC, extensions: editorExtensions });

const view = new EditorView({ state, parent: document.getElementById("editor") });
window.__view = view;

/**
 * IME（中文输入法）状态跟踪
 *
 * 为什么不能只看 view.composing：
 *   CodeMirror 的 `view.composing` 是 `inputState.composing > 0`，
 *   而 compositionstart 时它只被设成 **0**（不是 1），
 *   要等第一次 compositionupdate 才变成 1。
 *   也就是说「刚开始组合」的那一瞬间 view.composing 是 false。
 *
 *   再加上 Chrome 里 CodeMirror 的 compositionPendingKey 机制
 *   **只在 Safari 生效**（源码 4685 行），所以 Chrome 下 IME 的
 *   Enter keydown 确实会到达 keymap。
 *
 * 所以额外记录【事件上的 isComposing / keyCode 229】——
 *   keyCode 229 是 IME 的标准标志（所有主流浏览器一致）。
 *
 * 漏掉这一层的后果：中文选词按 Enter 被自定义 keymap 抢走 → 中文打不出来。
 */
let lastKeyIsComposing = false;
view.contentDOM.addEventListener('keydown', (e) => {
  // 捕获阶段 —— 保证比 CodeMirror 自己的处理先跑到
  lastKeyIsComposing = !!(e.isComposing || e.keyCode === 229);
}, true);
// 组合结束后复位（compositionend 之后紧跟的 key 不该再被当成 IME 的）
view.contentDOM.addEventListener('compositionend', () => {
  lastKeyIsComposing = false;
});

/* ============ 状态 ============ */
let currentPath = null;
let dirty = false;
let loadingTab = false;
let renderTimer = null;
const DRAFT_KEY = "mdx.draft";
const THEME_KEY = "mdx.theme";
const SB_KEY = "mdx.sidebar";

/* 多标签：每个 tab 存一份内容 + 光标 + 滚动位置 */
let tabs = [];
let activeId = null;
let tabSeq = 0;

/* ============ 渲染预览 ============ */
const previewEl = document.getElementById("preview");

const outlineEl = document.getElementById('outline');
const outlineList = document.getElementById('outlineList');
let outlineVisible = localStorage.getItem('mdx.outline') !== '0';
let outlineTimer;
let outlineItems = [];
function toggleOutline(show = !outlineVisible) {
  outlineVisible = show;
  outlineEl.hidden = !show;
  document.getElementById('btnOutline').setAttribute('aria-pressed', String(show));
  localStorage.setItem('mdx.outline', show ? '1' : '0');
  if (show) renderOutline();
}
function renderOutline() {
  if (!outlineVisible) return;
  outlineItems = headings(view.state.doc.toString());
  outlineList.replaceChildren();
  if (!outlineItems.length) {
    const empty = document.createElement('p'); empty.className = 'outline-empty';
    empty.textContent = '暂无标题，添加标题后将在这里显示'; outlineList.appendChild(empty);
  }
  for (const item of outlineItems) {
    const button = document.createElement('button');
    const label = document.createElement('span');
    label.innerHTML = DOMPurify.sanitize(marked.parseInline(item.label));
    button.textContent = label.textContent || '未命名标题'; button.title = button.textContent;
    button.dataset.from = item.from; button.style.paddingLeft = `${12 + (item.level - 1) * 12}px`;
    button.addEventListener('click', () => {
      view.dispatch({ selection: { anchor: item.from }, scrollIntoView: true });
      if (panes.dataset.mode !== 'preview') view.focus();
      const candidates = [...previewEl.querySelectorAll(`h${item.level}`)];
      const matches = candidates.filter(el => el.textContent.trim() === button.textContent.trim());
      const index = outlineItems.filter(other => other.from < item.from && other.level === item.level && other.label === item.label).length;
      (matches[index] || matches[0])?.scrollIntoView({ block: 'start' });
      highlightOutline();
    });
    outlineList.appendChild(button);
  }
  highlightOutline();
}
function highlightOutline() {
  const position = view.state.selection.main.head;
  const active = [...outlineItems].reverse().find(item => item.from <= position)?.from;
  for (const button of outlineList.querySelectorAll('button')) {
    const selected = Number(button.dataset.from) === active;
    button.classList.toggle('active', selected);
    if (selected) button.setAttribute('aria-current', 'location'); else button.removeAttribute('aria-current');
  }
}
document.getElementById('btnOutline').addEventListener('click', () => toggleOutline());
document.getElementById('closeOutline').addEventListener('click', () => toggleOutline(false));
toggleOutline(outlineVisible);

marked.setOptions({ gfm: true, breaks: false, headerIds: true, mangle: false });

/* ---- 预览区直接编辑（Live Preview） ---- */
const LIVE_KEY = "mdx.live";
let liveEdit = localStorage.getItem(LIVE_KEY) === "1";

/**
 * 当前源码的 block 切分结果。
 * blocks 里含 space token（空行分隔符），它们不产生 DOM，渲染时跳过。
 */
let blockMap = { blocks: [], all: [] };

/**
 * 重渲染预览区。
 *
 * @param force 切标签 / 切模式 / 开关 liveEdit 这类必须立刻重建的场景传 true。
 *
 * 关键：用户在预览区直接打字时（live-edit），焦点在 previewEl 里面，
 * 而重建用的是 `previewEl.innerHTML = ...` —— innerHTML 一赋值，
 * contenteditable 里的焦点和光标会被整体丢弃，表现为「输入到一行
 * 就自动失焦、光标跳到别的地方」。所以焦点还在预览区时先挂起这次
 * 渲染，等失焦（focusout）后再补上。
 */
let previewRenderPending = false;

function renderPreview(force) {
  if (!force && liveEdit && previewEl.contains(document.activeElement)) {
    previewRenderPending = true;
    return;
  }
  previewRenderPending = false;

  renderOutline();
  const md = view.state.doc.toString();
  try {
    const raw = marked.parse(md);
    previewEl.innerHTML = imageHtml(raw, html => DOMPurify.sanitize(html, { USE_PROFILES: { html: true } }));
    void loadLocalImages(previewEl, currentPath, (source, doc) => window.api.readImage(source, doc));
    previewEl.querySelectorAll("input[type=checkbox]").forEach(cb => { cb.disabled = !liveEdit; });

    // 建立「预览区顶层元素 ↔ 源码 block」映射，供直接编辑时按区间回写
    blockMap = splitBlocks(md);
    const visible = blockMap.blocks.filter(b => !b.skip);
    annotateBlocks(previewEl, visible.length);

    if (liveEdit) {
      previewEl.contentEditable = 'true';
      previewEl.dataset.live = '1';
      previewEl.spellcheck = false;
    } else {
      previewEl.removeAttribute('contenteditable');
      delete previewEl.dataset.live;
    }
  } catch (e) {
    logError('render', '预览渲染失败: ' + (e && e.message), {
      stack: e && e.stack,
      docLength: md.length,
      docHead: md.slice(0, 200)
    });
    previewEl.innerHTML = '<p style="color:#d4506a">预览渲染出错：' + escapeHtml(e.message) + '</p>';
  }
  updateStatus();
}

function scheduleRender() {
  clearTimeout(renderTimer);
  renderTimer = setTimeout(() => {
    renderPreview();
    // 重渲染后刷新文本快照，否则下次 input 事件会误判成"内容变了"
    snapshotBlockTexts();
  }, 80);
}

/**
 * 焦点离开预览区时，把挂起的渲染补上。
 *
 * 用 focusout（冒泡）而不是 blur：contentEditable 内部元素之间的
 * 焦点移动不该触发整体重建，只有真正离开预览区才补。
 */
previewEl.addEventListener('focusout', () => {
  if (!previewRenderPending) return;
  // 放到下一帧，等 focus 已经完成，避免重建时焦点又被算回去
  setTimeout(() => {
    if (previewRenderPending) renderPreview();
    snapshotBlockTexts();
  }, 0);
});

/* ================================================================
 * 预览区直接编辑的实现
 *
 * 用户在预览区改字后：
 *   1. 找出被改动的那个顶层元素 → 它在 blockMap 里对应的源码区间
 *   2. 把该元素转回 Markdown
 *   3. 用 CodeMirror 的 transaction 替换那一个区间
 *
 * 只替换被改的那一段，其余内容（含光标位置）由 CodeMirror 自己维护，
 * 所以不会跳动、不会丢选区。
 * ================================================================ */

/** 阻止我们自己的回写触发无限循环 */
let suppressLiveInput = false;
/** 记录回写前预览区各 block 的文本，用于判断是哪个被改了 */
let blockTexts = [];
let blockElements = [];

function previewSignature(element) {
  const copy = element.cloneNode(true);
  copy.querySelectorAll('img[data-qingmo-image]').forEach(image => { image.removeAttribute('src'); image.removeAttribute('title'); });
  return copy.innerHTML;
}
function snapshotBlockTexts() {
  blockElements = [...previewEl.children];
  blockTexts = blockElements.map(previewSignature);
}

// 浏览器拆分/退出列表时顶层块数可能变化，同时保留未改动块的 Markdown。
function writeBackPreviewStructure() {
  const old = blockMap.blocks.filter(block => !block.skip);
  const elements = [...previewEl.children];
  let offset = 0;
  const blocks = elements.map((element, index) => {
    const previous = blockElements.indexOf(element);
    const unchanged = previous >= 0 && previewSignature(element) === blockTexts[previous] && old[previous];
    const markdown = (unchanged ? old[previous].raw : elementToMarkdown(element, 'paragraph')).replace(/\n+$/, '');
    const raw = markdown + (index < elements.length - 1 ? '\n\n' : '');
    const block = { start: offset, end: offset + raw.length, raw, skip: false, token: { type: 'paragraph' } };
    offset += raw.length;
    return block;
  });
  suppressLiveInput = true;
  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: blocks.map(block => block.raw).join('') } });
  suppressLiveInput = false;
  blockMap = { blocks, all: [] };
  annotateBlocks(previewEl, blocks.length);
  snapshotBlockTexts();
}


/** 找到内容发生变化的 block 下标；返回 -1 表示没变 */
function changedBlockIndex() {
  const kids = [...previewEl.children];
  if (kids.length !== blockTexts.length) return -1;
  for (let i = 0; i < kids.length; i++) {
    if (previewSignature(kids[i]) !== blockTexts[i]) return i;
  }
  return -1;
}

/** 把预览区的第 idx 个 block 转成 Markdown 并写回源码 */
function writeBackBlock(idx, caretOffset) {
  const kids = [...previewEl.children];
  const el = kids[idx];
  if (!el) return;

  const visible = blockMap.blocks.filter(b => !b.skip);
  const target = visible[idx];
  if (!target) return;

  let newMd;
  try {
    newMd = elementToMarkdown(el, target.token.type);
  } catch (e) {
    // 转换失败就放弃这次回写，保持源码不动（宁可不改，也不能改坏）
    // 但必须记日志 —— 否则「在预览区改了字但源码没变」完全无从查起
    logError('live-edit', 'DOM → Markdown 转换失败，已放弃本次回写', {
      blockIndex: idx,
      tokenType: target.token.type,
      raw: target.raw,
      html: el.outerHTML && el.outerHTML.slice(0, 300),
      message: e && e.message,
      stack: e && e.stack
    });
    return;
  }

  // 原来 raw 末尾的两个换行是块间分隔符，不要写回去，否则会产生空行堆积
  const trailing = /\n+$/.exec(target.raw);
  const tailNl = trailing ? trailing[0] : '';
  if (!newMd) {
    // 整个块被删空了 → 连同它后面的分隔空行一起删掉
    newMd = '';
  } else {
    newMd = newMd + tailNl;
  }

  if (newMd === target.raw) return;   // 没实质变化

  suppressLiveInput = true;
  view.dispatch({
    changes: { from: target.start, to: target.end, insert: newMd },
    // 把 CodeMirror 的光标放到改写后块的末尾，视觉上跟用户在预览区的位置一致
    selection: { anchor: target.start + newMd.length }
  });
  suppressLiveInput = false;
  blockMap = splitBlocks(view.state.doc.toString());
  annotateBlocks(previewEl, blockMap.blocks.filter(block => !block.skip).length);

  scheduleSidebarSync();
  saveDraft();
}

/** 在预览区粘贴：只取纯文本，避免把外部 HTML 带进来 */
previewEl.addEventListener('paste', (e) => {
  if (!liveEdit) return;
  e.preventDefault();
  const text = (e.clipboardData || window.clipboardData).getData('text/plain');
  if (!text) return;
  document.execCommand('insertText', false, text);
});

/** 预览列表沿用浏览器的 LI 拆分、空项退出和嵌套列表退级。 */
previewEl.addEventListener('keydown', (e) => {
  if (!liveEdit || e.isComposing || e.keyCode === 229) return;
  const selection = window.getSelection();
  const anchor = selection?.anchorNode;
  const element = anchor?.nodeType === 1 ? anchor : anchor?.parentElement;
  const inCode = element?.closest('pre');
  if (e.key === 'Enter' && !e.shiftKey && !inCode) {
    if (element?.closest('li')) {
      e.preventDefault();
      document.execCommand('insertParagraph');
      return;
    }
    e.preventDefault();
    document.execCommand('insertLineBreak');
    return;
  }

  // Backspace 保留浏览器原生的列表退级和块合并，input 统一回写。

});

previewEl.addEventListener('input', () => {
  if (!liveEdit || suppressLiveInput) return;
  const idx = changedBlockIndex();
  if (idx < 0 || previewEl.children.length !== blockMap.blocks.filter(block => !block.skip).length) {
    writeBackPreviewStructure();
    return;
  }
  writeBackBlock(idx);
  snapshotBlockTexts();
});

/** 勾选任务列表的复选框 → 回写成 [x] / [ ] */
previewEl.addEventListener('change', (e) => {
  if (!liveEdit) return;
  const cb = e.target;
  if (!cb || cb.type !== 'checkbox') return;
  const top = cb.closest('[data-block]');
  if (!top || top.dataset.block === undefined) return;
  const idx = Number(top.dataset.block);
  writeBackBlock(idx);
  snapshotBlockTexts();
});

/** 点击预览区的链接：预览模式下不跳转，新标签打开 */
previewEl.addEventListener('click', (e) => {
  const a = e.target.closest('a[href]');
  if (!a) return;
  e.preventDefault();
  window.open(a.href, '_blank', 'noopener');
});

function setLiveEdit(v) {
  liveEdit = v;
  localStorage.setItem(LIVE_KEY, v ? '1' : '0');
  const btn = document.getElementById('btnLive');
  if (btn) btn.classList.toggle('active', v);
  renderPreview(true);
  snapshotBlockTexts();
  toast(v ? '预览区可直接编辑' : '预览区恢复为只读');
}

function hasUnsavedChanges(tab) {
  if (!tab.path && !tab.content.trim()) return false;
  return tab.savedContent === null || tab.content !== tab.savedContent;
}

function onUpdate(u) {
  if (u.docChanged && !loadingTab) {
    const tab = activeTab();
    if (tab) { tab.content = view.state.doc.toString(); tab.dirty = hasUnsavedChanges(tab); }
    setDirty(tab ? tab.dirty : false);
    scheduleRender();
    saveDraft();
    // 同步到tab 并刷新侧边栏脏标记（节流，避免每次按键都重排 DOM）
    scheduleSidebarSync();
  }
  if (u.docChanged) {
    clearTimeout(outlineTimer);
    outlineTimer = setTimeout(renderOutline, 180);
  }
  if (u.selectionSet) highlightOutline();
  if (u.selectionSet || u.docChanged) updateStatus();
}

// 侧边栏脏标记刷新：250ms 内合并多次按键
let sbSyncTimer = null;
function scheduleSidebarSync() {
  if (sbSyncTimer) return;
  sbSyncTimer = setTimeout(() => {
    sbSyncTimer = null;
    renderSidebar();
  }, 250);
}

// 记录光标与滚动位置，供切回时恢复
let lastSaveCursor = 0;
setInterval(() => {
  const t = activeTab();
  if (!t) return;
  t.sel = view.state.selection.main.head;
  try { t.scroll = view.scrollDOM.scrollTop; } catch (e) {}
}, 800);

/* ============ 状态栏 ============ */
const stPath = document.getElementById("stPath");
const stSaved = document.getElementById("stSaved");
const stWords = document.getElementById("stWords");
const stLines = document.getElementById("stLines");
const fileName = document.getElementById("fileName");

function setDirty(v) {
  dirty = v;
  stSaved.textContent = v ? "未保存" : (activeTab()?.path ? "已保存" : "新文档");
  stSaved.classList.toggle("dirty", v);
}

function updateStatus() {
  const doc = view.state.doc;
  const text = doc.toString();
  const lines = doc.lines;
  const chars = text.replace(/\s/g, "").length;
  stWords.textContent = chars + " 字";
  stLines.textContent = lines + " 行";
  const pos = view.state.selection.main.head;
  const line = doc.lineAt(pos);
  stPath.textContent = `${currentPath || "未命名"}  ·  行 ${line.number}, 列 ${pos - line.from + 1}`;
}

/* ============ 文件操作（多标签） ============ */
function tabName(t) {
  if (t.path) return t.path.split(/[\\/]/).pop();
  return t.name || "未命名.md";
}

function activeTab() {
  return tabs.find(t => t.id === activeId) || null;
}

/** 同步当前编辑器内容回 active tab */
function syncActive() {
  const t = activeTab();
  if (!t) return;
  t.content = view.state.doc.toString();
  t.dirty = dirty;
  t.editorState = view.state;
  t.sel = view.state.selection.main.head;
}

function addTab({ path = null, content = '', name = '', dirty: restoredDirty = false, savedContent } = {}) {
  // 已打开同一路径则切过去
  if (path) {
    const exist = tabs.find(t => t.path === path);
    if (exist) { switchTab(exist.id); return exist; }
  }
  const baseline = savedContent !== undefined ? savedContent : (restoredDirty ? (path ? null : '') : content);
  const t = { id: ++tabSeq, path, name, content, savedContent: baseline, dirty: false, sel: 0, scroll: 0 };
  t.dirty = hasUnsavedChanges(t);
  tabs.push(t);
  switchTab(t.id);
  return t;
}

function switchTab(id) {
  if (id === activeId) return;
  syncActive();

  const t = tabs.find(x => x.id === id);
  if (!t) return;
  activeId = id;
  dirty = false;

  loadingTab = true;
  try {
    view.setState(t.editorState || EditorState.create({
      doc: t.content || '', extensions: editorExtensions,
      selection: { anchor: Math.min(t.sel || 0, (t.content || '').length) }
    }));
  } finally { loadingTab = false; }
  // 恢复滚动位置
  requestAnimationFrame(() => {
    try { view.scrollDOM.scrollTop = t.scroll || 0; } catch (e) {}
  });

  currentPath = t.path;
  fileName.textContent = tabName(t);
  setDirty(t.dirty);
  renderSidebar();
  renderPreview(true);
  renderOutline();
  updateStatus();
}

let closePromptActive = false;
async function prepareClose(candidates) {
  if (closePromptActive) return false;
  closePromptActive = true;
  try {
    syncActive();
    const changed = candidates.filter(tab => tab.dirty);
    if (!changed.length) return true;
    const action = await window.api.confirmClose(changed.map(tab => tabName(tab) + (tab.path ? ' — ' + tab.path : '')));
    if (action === 'save') {
      for (const tab of changed) if (!await saveTab(tab)) return false;
      return true;
    }
    if (action === 'discard') {
      // 窗口关闭也会恢复会话，放弃的草稿必须从恢复记录移除。
      for (const tab of changed) {
        tab.content = tab.savedContent || ''; tab.dirty = false;
        if (tab.id === activeId) setDirty(false);
      }
      return true;
    }
    return false;
  } catch (error) {
    toast('保存失败，文档未关闭：' + error.message);
    return false;
  } finally { closePromptActive = false; }
}
window.api.on('app:requestClose', async () => {
  const approved = await closeAllTabs();
  window.api.finishClose(approved);
});

let closingTabs = false;
async function withCloseLock(operation) {
  if (closingTabs) return false;
  closingTabs = true;
  try { return await operation(); } finally { closingTabs = false; }
}
function closeTab(id) { return withCloseLock(() => closeTabImpl(id)); }
function closeAllTabs() { return withCloseLock(closeAllTabsImpl); }
async function closeTabImpl(id) {
  const idx = tabs.findIndex(t => t.id === id);
  if (idx < 0) return;
  const t = tabs[idx];

  if (!await prepareClose([t])) return;

  rememberClosed(t);
  tabs.splice(idx, 1);
  if (activeId === id) {
    activeId = null;
    if (tabs.length) {
      // 打开相邻的：优先右侧，其次左侧
      const next = tabs[idx] || tabs[idx - 1];
      if (next) switchTab(next.id);
    } else {
      addTab();   // 全部关掉后留一个空文档
    }
  } else {
    renderSidebar();
  }
  persistSession();
}

async function closeAllTabsImpl() {
  if (!await prepareClose(tabs)) return false;
  tabs.forEach(rememberClosed);
  tabs = [];
  activeId = null;
  addTab();
  persistSession();
  return true;
}

async function newFile() {
  addTab();
  view.focus();
  toast("已新建文档");
}

async function openFile() {
  const r = await window.api.open();
  if (!r) return;
  if (r.error) { toast("打开失败：" + r.error); return; }
  addTab({ path: r.path, content: r.content || '' });
  toast("已打开 " + tabName(tabs.find(t => t.id === activeId) || {}));
}

/** 保存指定 tab（可指定是否另存为）；返回是否成功 */
async function saveTab(t, saveAs = false) {
  const content = t.id === activeId ? view.state.doc.toString() : t.content;
  if (saveAs || !t.path) {
    const r = await window.api.saveAs(content, tabName(t));
    if (!r) return false;
    if (r.error || r.ok === false || typeof r.path !== 'string') throw new Error(r.error || '保存失败');
    t.path = r.path;
    t.name = '';
  } else {
    const result = await window.api.save(t.path, content);
    if (!result || result.error || result.ok === false) throw new Error(result?.error || '保存失败');
  }
  t.savedContent = content;
  t.content = t.id === activeId ? view.state.doc.toString() : content;
  t.dirty = hasUnsavedChanges(t);
  if (t.id === activeId) { setDirty(t.dirty); fileName.textContent = tabName(t); }
  renderSidebar();
  window.api.rebuildMenu();
  persistSession();
  if (t.id === activeId) { currentPath = t.path; renderPreview(true); }
  return true;
}

async function saveFile(saveAs) {
  syncActive();
  const t = activeTab();
  if (!t) return;
  try {
    const ok = await saveTab(t, saveAs);
    if (ok) toast("已保存");
  } catch (error) { toast('保存失败：' + error.message); }
}

/* ============ 会话持久化（多标签崩溃恢复） ============ */
const SESSION_KEY = "mdx.session";

function saveDraft() {
  try {
    syncActive();
    // 已保存的文档不存内容（从磁盘读），只存路径，减小体积
    const list = tabs.map(t => ({
      path: t.path,
      name: t.name,
      dirty: t.dirty,
      content: t.dirty ? t.content : null
    }));
    localStorage.setItem(SESSION_KEY, JSON.stringify({
      v: 1,
      activePath: (activeTab() && activeTab().path) || null,
      activeIndex: tabs.findIndex(tab => tab.id === activeId),
      list: list
    }));
  } catch (e) {
    // 容量超限时兜底：只存未保存的内容
    try {
      localStorage.setItem(SESSION_KEY, JSON.stringify({
        v: 1,
        list: tabs.filter(t => t.dirty).map(t => ({ path: t.path, name: t.name, dirty: true, content: t.content }))
      }));
    } catch (e2) {}
  }
}

/** 恢复上次会话：已保存的从磁盘重读，未保存的用暂存内容 */
async function loadDraft() {
  let d = null;
  try { d = JSON.parse(localStorage.getItem(SESSION_KEY) || "null"); } catch (e) {}
  if (!d || !d.list || !d.list.length) return false;

  const restored = [];
  for (const it of d.list) {
    let baseline = it.path ? null : '';
    if (it.path) {
      try {
        const result = await window.api.openPath(it.path);
        if (result && !result.error) baseline = result.content || '';
        else if (!it.dirty) continue;
      } catch { if (!it.dirty) continue; }
    }
    const content = it.dirty && typeof it.content === 'string' ? it.content : (baseline || '');
    restored.push({ path: it.path, name: it.name, content,
      savedContent: baseline, dirty: !!it.dirty });
  }
  if (!restored.length) return false;

  for (const r of restored) addTab(r);
  const target = d.activePath ? tabs.find(t => t.path === d.activePath) : tabs[d.activeIndex || 0];
  if (target) switchTab(target.id);
  return true;
}

function clearDraft() { try { localStorage.removeItem(SESSION_KEY); } catch (e) {} }
function persistSession() { saveDraft(); }

/* ============ 重命名与最近关闭 ============ */
const CLOSED_KEY = 'mdx.closedFiles';
let closedFiles = [];
try {
  const stored = JSON.parse(localStorage.getItem(CLOSED_KEY) || '[]');
  if (Array.isArray(stored)) closedFiles = stored.filter(item => item && typeof item.path === 'string').slice(0, 20);
} catch {}
function persistClosed() {
  try { localStorage.setItem(CLOSED_KEY, JSON.stringify(closedFiles)); } catch {}
}
function rememberClosed(tab) {
  if (!tab.path) return;
  closedFiles = [{ path: tab.path }, ...closedFiles.filter(item => item.path !== tab.path)].slice(0, 20);
  persistClosed();
}
async function reopenClosed(filename = closedFiles[0]?.path) {
  if (!filename) { toast('暂无最近关闭的文件'); return false; }
  try {
    const existing = tabs.find(tab => tab.path === filename);
    if (existing) switchTab(existing.id);
    else {
      const result = await window.api.openPath(filename);
      if (!result || result.error) throw new Error(result?.error || '文件无法读取');
      addTab({ path: result.path, content: result.content || '' });
    }
    closedFiles = closedFiles.filter(item => item.path !== filename);
    persistClosed(); persistSession();
    return true;
  } catch (error) { toast('重新打开失败：' + error.message); return false; }
}
function documentDialog(id, title) {
  if (document.querySelector('.modal-mask')) return null;
  const dialog = document.createElement('div'); dialog.id = id; dialog.className = 'modal-mask show';
  dialog.innerHTML = `<div class="modal" role="dialog" aria-modal="true" aria-labelledby="${id}-title" style="width:min(520px,100%)"><div class="modal-head"><span class="modal-title" id="${id}-title">${title}</span><button class="ub-btn" data-act="cancel" aria-label="关闭">×</button></div><div class="modal-body"></div><div class="modal-foot"><button class="ub-btn" data-act="cancel">取消</button></div></div>`;
  const dismiss = () => { dialog.remove(); view.focus(); };
  dialog.querySelectorAll('[data-act="cancel"]').forEach(button => button.addEventListener('click', dismiss));
  dialog.addEventListener('keydown', event => {
    event.stopPropagation();
    if (event.key === 'Escape' && !dialog.dataset.busy) { event.preventDefault(); dismiss(); }
  });
  document.body.appendChild(dialog);
  return dialog;
}
function renameTab(id) {
  const tab = tabs.find(item => item.id === id); if (!tab) return;
  const dialog = documentDialog('renameDialog', '重命名文件'); if (!dialog) return;
  dialog.querySelector('.modal-body').innerHTML = '<label for="renameInput">文件名</label><input class="rename-input" id="renameInput" aria-describedby="renameError" /><p class="rename-error" id="renameError" role="alert"></p>';
  const input = dialog.querySelector('input'); input.value = tabName(tab);
  const submit = document.createElement('button'); submit.className = 'ub-btn primary'; submit.textContent = '重命名'; submit.dataset.act = 'rename';
  dialog.querySelector('.modal-foot').appendChild(submit);
  submit.addEventListener('click', async () => {
    if (dialog.dataset.busy) return;
    let name = input.value.trim();
    if (name && !name.includes('.')) name += /\.[^.]+$/.exec(tabName(tab))?.[0] || '.md';
    if (!name || /[<>:"/\\|?*\x00-\x1f]/.test(name) || /[. ]$/.test(name) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) {
      dialog.querySelector('#renameError').textContent = '请输入有效文件名，不要包含路径或特殊字符'; return;
    }
    dialog.dataset.busy = '1';
    dialog.querySelectorAll('button').forEach(button => { button.disabled = true; });
    try {
      if (tab.path) {
        const source = tab.path;
        const proposed = source.replace(/[^\\/]+$/, name);
        if (tabs.some(other => other.id !== tab.id && other.path === proposed)) throw new Error('该文件已在其他标签打开');
        const result = await window.api.rename(source, name);
        if (!result?.ok) throw new Error(result?.error || '重命名失败');
        tab.path = result.path; tab.name = '';
        closedFiles = closedFiles.map(item => item.path === source ? { path: result.path } : item); persistClosed();
        if (tab.id === activeId) currentPath = tab.path;
        window.api.rebuildMenu();
      } else tab.name = name;
      if (tab.id === activeId) { fileName.textContent = tabName(tab); updateStatus(); renderPreview(true); }
      renderSidebar(); persistSession(); dialog.remove(); view.focus(); toast('已重命名');
    } catch (error) { dialog.querySelector('#renameError').textContent = error.message; }
    finally {
      delete dialog.dataset.busy;
      dialog.querySelectorAll('button').forEach(button => { button.disabled = false; });
    }
  });
  input.addEventListener('keydown', event => { if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); submit.click(); } });
  input.focus(); input.setSelectionRange(0, Math.max(0, input.value.lastIndexOf('.')) || input.value.length);
}
function showClosedHistory() {
  const dialog = documentDialog('closedHistoryDialog', '最近关闭的文件'); if (!dialog) return;
  const list = dialog.querySelector('.modal-body'); list.classList.add('closed-files');
  if (!closedFiles.length) list.textContent = '暂无最近关闭的文件';
  for (const item of closedFiles) {
    const button = document.createElement('button'); button.className = 'closed-file';
    const name = document.createElement('b'); name.textContent = item.path.split(/[\\/]/).pop();
    const location = document.createElement('span'); location.textContent = item.path;
    button.append(name, location);
    button.addEventListener('click', async () => { if (await reopenClosed(item.path)) dialog.remove(); });
    list.appendChild(button);
  }
  (list.querySelector('button') || dialog.querySelector('button')).focus();
}

/* ============ 侧边栏折叠 ============ */
function setSidebar(collapsed) {
  const ws = document.querySelector(".workspace");
  if (!ws) return;
  ws.dataset.sb = collapsed ? "collapsed" : "open";
  try { localStorage.setItem(SB_KEY, collapsed ? "collapsed" : "open"); } catch (e) {}
  const u = document.querySelector("#btnPanel use");
  if (u) u.setAttribute("href", collapsed ? "#i-panel-close" : "#i-panel");
  requestAnimationFrame(() => { view.requestMeasure(); renderPreview(); });
}
function toggleSidebar() {
  const ws = document.querySelector(".workspace");
  setSidebar(ws.dataset.sb !== "collapsed");
}

/* ============ 侧边栏渲染 ============ */
const sbList = document.getElementById("sbList");
const sbCount = document.getElementById("sbCount");

function renderSidebar() {
  if (!sbList) return;
  sbCount.textContent = tabs.length;
  if (!tabs.length) {
    const e = document.createElement("div");
    e.className = "sb-empty";
    e.textContent = "没有打开的文档";
    sbList.replaceChildren(e);
    return;
  }
  const frag = document.createDocumentFragment();
  for (const t of tabs) {
    const el = document.createElement("div");
    el.className = "sb-item" + (t.id === activeId ? " active" : "");
    el.dataset.id = t.id;
    el.title = t.path || "（未保存）";

    const ico = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
    use.setAttribute("href", "#i-doc");
    ico.appendChild(use);

    const name = document.createElement("span");
    name.className = "sb-name";
    name.textContent = tabName(t);
    if (t.dirty) {
      const dot = document.createElement("i");
      dot.className = "sb-dot";
      dot.title = '未保存的修改';
      dot.setAttribute('role', 'img'); dot.setAttribute('aria-label', '未保存');
      el.appendChild(dot);
    }

    const close = document.createElement("button");
    close.className = "sb-close";
    close.title = "关闭（中间键）";
    close.innerHTML = '<svg><use href="#i-x"/></svg>';
    close.addEventListener("click", (e) => {
      e.stopPropagation();
      closeTab(t.id);
    });

    el.addEventListener("click", () => switchTab(t.id));
    el.addEventListener("auxclick", (e) => { if (e.button === 1) closeTab(t.id); });

    name.title = '双击重命名';
    name.addEventListener('dblclick', event => { event.stopPropagation(); renameTab(t.id); });
    const dot = el.querySelector('.sb-dot');
    el.replaceChildren(ico, name);
    if (dot) el.appendChild(dot);
    el.appendChild(close);
    frag.appendChild(el);
  }
  sbList.replaceChildren(frag);
  const act = sbList.querySelector(".sb-item.active");
  if (act) act.scrollIntoView({ block: "nearest" });
}

/* ============ 插入 / 格式化 ============ */
function getSel() {
  const r = view.state.selection.main;
  return { from: r.from, to: r.to, text: view.state.sliceDoc(r.from, r.to) };
}

function replaceSelection(text, selectOffset) {
  const { from, to } = getSel();
  view.dispatch({
    changes: { from, to, insert: text },
    selection: { anchor: from + (selectOffset != null ? selectOffset : text.length) }
  });
  view.focus();
}

function wrap(before, after) {
  const { from, to, text } = getSel();
  if (!text) {
    replaceSelection(before + after, before.length);
    return;
  }
  // 判断「是否已包裹」。
  //
  // 不能只看「前 N 个字符 == before」—— 那样嵌套格式会互相破坏：
  //   文档是 **文字**（粗体），选区正好是「文字」
  //   点斜体时 before='*'，取到的前 1 个字符是粗体 '**' 的第二个 '*'
  //   → 误判成「已经斜体了」→ 走取消分支 → 粗体被吃掉，文档变成 *文字*
  //
  // 所以还要确认这个包裹是【独立】的：包裹标记的前后不能再是同类标记字符。
  const docLen = view.state.doc.length;
  const beforeStart = Math.max(0, from - before.length);
  const beforeText = view.state.sliceDoc(beforeStart, from);
  const afterText = view.state.sliceDoc(to, Math.min(docLen, to + after.length));
  // 包裹前面的那个字符 / 后面的那个字符
  const charBefore = beforeStart > 0 ? view.state.sliceDoc(beforeStart - 1, beforeStart) : '';
  const charAfter = (to + after.length) < docLen
    ? view.state.sliceDoc(to + after.length, to + after.length + 1) : '';
  const standalone = !charBefore.includes(before[0]) && !charAfter.includes(after[0]);

  if (beforeText === before && afterText === after && standalone) {
    view.dispatch({
      changes: [
        { from: from - before.length, to, insert: text },
        { from: from - before.length + text.length, to: to + after.length }
      ],
      selection: { anchor: from - before.length, head: from - before.length + text.length }
    });
    view.focus();
    return;
  }

  // ⚠ 选区落在某个强调区间里时的处理。
  //
  // 之前没有这个检查，于是：
  //   '这是**加粗**的文字' 选中「粗」再点加粗
  //   → '这是**加****粗**的文字'   ← 嵌套垃圾，Markdown 渲染也乱
  //
  // 三种情况要分开：
  //   ① 同种格式 + 完整覆盖 → 取消该强调（**文字** 点加粗 → 文字）
  //   ② 异种格式 + 完整覆盖 → 叠加（**文字** 点斜体 → ***文字***）
  //   ③ 只覆盖强调的一部分 → 放弃修改
  //      （局部取消强调需要嵌套语法 **加*粗**，极易写错，
  //        所以宁可什么都不做，也不要产生垃圾语法）
  const docText = view.state.doc.toString();
  const emp = findEmphasisAt(docText, from);
  if (emp) {
    const fullCover = from <= emp.innerStart && to >= emp.innerEnd;
    if (!fullCover) return;                    // ③ 局部 → 放弃
    if (emp.marker === before) {               // ① 同种 → 取消
      view.dispatch({
        changes: {
          from: emp.start, to: emp.end,
          insert: docText.slice(emp.innerStart, emp.innerEnd)
        },
        selection: {
          anchor: emp.start, head: emp.start + (emp.innerEnd - emp.innerStart)
        }
      });
      view.focus();
      return;
    }
    // ② 异种 → 继续往下走，套一层（Markdown 支持 ***文字*** 这种嵌套）
  }

  replaceSelection(before + text + after, before.length + text.length);
  view.dispatch({ selection: { anchor: from + before.length, head: from + before.length + text.length } });
}

// 块级插入：智能处理行首
/**
 * 用一段新内容替换「光标所在的整行」。
 *
 * ⚠ 光标位置必须相对【新文档】算，不能用 from + offset ——
 * 因为整行被替换后，光标所在行之前的字符数变了。
 * 之前写成 `from + prefix.length + offset`，当 from 大于新块的起始位置时
 * 光标会落到文档末尾之外 → CodeMirror 报
 * "Selection points outside of document"，而且【整篇文档会变成空的】。
 */
function insertBlock(text, cursorOffsetInBlock) {
  const { from, to } = getSel();
  const startLine = view.state.doc.lineAt(from);
  const endLine = view.state.doc.lineAt(to);
  const selText = view.state.sliceDoc(from, to);
  const body = selText || text;

  const prefix = startLine.from === 0 ? '' : '\n\n';
  const full = prefix + body + '\n';
  // 关键：以【替换区起点】为基准算光标
  const pos = startLine.from + prefix.length +
    (cursorOffsetInBlock != null ? cursorOffsetInBlock : body.length);
  view.dispatch({
    changes: { from: startLine.from, to: endLine.to, insert: full },
    selection: { anchor: pos }
  });
  view.focus();
}

/**
 * 在【当前行之后】另起一块插入内容。
 *
 * 块级内容（代码块、分隔线、表格）必须另起一块 ——
 * 之前 ins:code / ins:hr / ins:table 都在光标处直接插，
 * 会把所在段落从中间劈成两半：
 *   `> 这是引` + '```\n\n```' + `用内容`
 * 而且 ins:table 还会把整个列表项吃掉。
 */
function insertBlockAfter(block, caretOffsetInBlock) {
  const { from } = getSel();
  const docText = view.state.doc.toString();
  const plan = planBlockAfter(docText, from, block);
  if (!plan) return;
  view.dispatch({
    changes: { from: plan.from, to: plan.to, insert: plan.insert },
    selection: { anchor: plan.caret - (caretOffsetInBlock != null ? caretOffsetInBlock : 0) }
  });
  view.focus();
}

function insertTable() {
  const { from, to } = getSel();
  const hasSel = view.state.sliceDoc(from, to).length > 0;
  const tpl =
`| 表头 A | 表头 B | 表头 C |\n` +
`| --- | --- | --- |\n` +
`| 内容 1 | 内容 2 | 内容 3 |\n` +
`| 内容 4 | 内容 5 | 内容 6 |`;
  if (hasSel) {
    // 把选区当表头
    const sel = view.state.sliceDoc(from, to).split('\n').map(s => s.trim()).filter(Boolean);
    const cols = Math.max(2, sel.length);
    const head = sel.length >= cols ? sel.slice(0, cols) : Array.from({ length: cols }, (_, i) => sel[i] || `列${i + 1}`);
    const rows = sel.length > cols ? sel.slice(cols) : [];
    // 空行必须跟表头列数一致 —— 早期版本硬编码了 '|  |  |'（两列），
    // 表头是三列时就生成了列数不齐的表格，渲染出来会错位。
    const emptyRow = '| ' + head.map(() => ' ').join(' | ') + ' |';
    const t2 =
      `| ${head.join(' | ')} |\n| ${head.map(() => '---').join(' | ')} |\n` +
      (rows.length ? rows.map(r => `| ${r} | ${head.slice(1).map(() => ' ').join(' | ')} |`).join('\n') + '\n' : emptyRow + '\n');
    replaceSelection(t2, 2);
  } else {
    // 表格是块级内容，必须另起一块。
    // 之前用 insertBlock（整行替换），在列表项中间点插入表格
    // 会把整个列表项吃掉：
    //   '- 列表项甲\n- 列表项乙' → '|表头...|\n\n- 列表项乙'
    insertBlockAfter(tpl);
  }
  toast('已插入表格');
}

function insertQuote() {
  toggleLinePrefix(
    (t) => { const m = /^(\s*>\s?)/.exec(t); return m ? m[1] : null; },
    () => '> '
  );
  toast('已插入引用');
}

function insertCodeBlock() {
  const { from, to, text } = getSel();
  if (text) {
    // 有选区：把选区包进代码块（块级内容，替换选区所在整行）
    const startLine = view.state.doc.lineAt(from);
    const endLine = view.state.doc.lineAt(to);
    const block = '```\n' + text + '\n```';
    view.dispatch({
      changes: { from: startLine.from, to: endLine.to, insert: block },
      selection: { anchor: startLine.from + 4 + text.length }
    });
    view.focus();
  } else {
    // 无选区：另起一块插入，不要把当前段落从中间劈开
    insertBlockAfter('```\n\n```', 3);
  }
  toast('已插入代码块');
}

/**
 * 行首前缀切换（无序 / 有序列表、任务列表、引用都走这里）。
 *
 * 之前无选区时用 replaceSelection 把模板插在**光标处**，于是点在行中间
 * 就会把「光标到行尾」那一段变成列表，行首反而没标记 —— 行为不对。
 * 正确语义跟 heading() 一致：作用于**行首**。
 *   · 行首没有同类前缀 → 逐行插入前缀（列表序号按行序递增）
 *   · 行首已有同类前缀 → 整块撤掉（再点一次复原，起 toggle 作用）
 * 选区跨多行时，每一行都按上面的规则处理。
 *
 * @param match (lineText) => 命中的前缀全文；没有则返回 null
 * @param make  (行序号，1 起) => 要插入的前缀
 */
function toggleLinePrefix(match, make) {
  const { from, to } = getSel();
  const startLine = view.state.doc.lineAt(from);
  const endLine = view.state.doc.lineAt(to);
  const removing = !!match(view.state.sliceDoc(startLine.from, startLine.to));

  const changes = [];
  for (let n = startLine.number; n <= endLine.number; n++) {
    const ln = view.state.doc.line(n);
    if (removing) {
      const m = match(view.state.sliceDoc(ln.from, ln.to));
      if (m) changes.push({ from: ln.from, to: ln.from + m.length, insert: '' });
    } else {
      changes.push({ from: ln.from, insert: make(n - startLine.number + 1) });
    }
  }
  if (changes.length) view.dispatch({ changes });
  // 不指定 selection：CodeMirror 会把光标映射到同一段文字上，
  // 正好停在刚插入的前缀之后，位置感不变。
  view.focus();
}

/* ============ 列表类型互相切换 ============
 *
 * 需求：无序 / 有序 / 任务 三者支持切换。
 * 之前每个按钮各管各的：
 *   · 点「无序」在有序行上 → 因为有序行不匹配 ul 的正则，会**再加一个** `- `，变成两行标记
 *   · 点「任务」在无序行上 → 无序行匹配了 todo 的正则（todo 的正则把方括号设成可选），
 *     于是走「删除」分支，把 `- ` 删了 —— 用户以为是要转成任务列表，结果列表没了
 *
 * 现在按「当前是什么类型」决定动作：
 *   当前是同一类型   → 取消（去掉标记）
 *   当前是别的类型   → 原地替换成目标类型
 *   当前不是列表     → 加标记
 */
const LIST_TYPES = ['ul', 'ol', 'todo'];

/** 判断一行属于哪种列表类型 */
function listKindOf(text) {
  if (/^\s*[-*+]\s+\[[ xX]\]\s+/.test(text)) return 'todo';
  if (/^\s*\d+[.)]\s+/.test(text)) return 'ol';
  if (/^\s*[-*+]\s+/.test(text)) return 'ul';
  return null;
}

/** 该类型该用的标记（有序列表按行序号递增） */
function listMarkerFor(kind, index) {
  if (kind === 'ol') return (index + 1) + '. ';
  if (kind === 'todo') return '- [ ] ';
  return '- ';
}

function switchList(kind) {
  const { from, to } = getSel();
  const startLine = view.state.doc.lineAt(from);
  const endLine = view.state.doc.lineAt(to);

  // 整段取出再整段写回 ——
  // 之前是「每行一个 change」，但第一行转换后长度会变（'1. 甲' → '- 甲' 少一个字符），
  // 后面几行的位置就全偏了：结果变成 '- 甲\n2. 乙'（第二行的 '2. ' 没被替换）。
  const raw = view.state.sliceDoc(startLine.from, endLine.to);
  const rawLines = raw.split('\n');

  const out = rawLines.map((text, i) => {
    const cur = listKindOf(text);
    const m = /^(\s*)(?:[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+)?/.exec(text);
    const indent = m ? m[1] : '';
    const body = text.slice(m ? m[0].length : 0);

    if (cur === kind) {
      // 同一类型 → 取消列表标记，留正文
      return indent + body;
    }
    // 别的类型 → 原地换成目标标记
    return indent + listMarkerFor(kind, i) + body;
  });

  const newText = out.join('\n');
  if (newText === raw) return;
  view.dispatch({
    changes: { from: startLine.from, to: endLine.to, insert: newText },
    selection: { anchor: startLine.from }
  });
  view.focus();
}

/** 将预览光标定位到源码的当前行，工具栏与快捷键共用。 */
function syncPreviewCursor() {
  const selection = window.getSelection();
  const node = selection?.anchorNode;
  if (!node || !previewEl.contains(node)) return false;
  const element = node.nodeType === 1 ? node : node.parentElement;
  const top = element.closest('[data-block]');
  if (!top) return false;
  const block = blockMap.blocks.filter(item => !item.skip)[Number(top.dataset.block)];
  if (!block) return false;
  const lines = block.raw.split('\n');
  const item = element.closest('li');
  let lineIndex = 0;
  if (item) {
    const itemIndex = [...top.querySelectorAll('li')].indexOf(item);
    const positions = lines.map((line, index) => /^\s*(?:[-*+](?:\s+|$)|\d+[.)](?:\s+|$))/.test(line) ? index : -1).filter(index => index >= 0);
    lineIndex = positions[Math.max(0, itemIndex)] || 0;
  } else {
    const range = document.createRange(); range.selectNodeContents(top); range.setEnd(node, selection.anchorOffset);
    lineIndex = Math.min(lines.length - 1, range.toString().split('\n').length - 1);
  }
  const position = block.start + lines.slice(0, lineIndex).reduce((sum, line) => sum + line.length + 1, 0);
  view.dispatch({ selection: { anchor: Math.min(position, view.state.doc.length) } });
  return true;
}

function focusPreviewSource(position) {
  renderPreview(true); snapshotBlockTexts();
  const visible = blockMap.blocks.filter(block => !block.skip);
  const index = visible.findIndex(block => position >= block.start && position <= block.end);
  const element = previewEl.children[Math.max(0, index)];
  if (!element) return;
  previewEl.focus();
  const range = document.createRange(); range.selectNodeContents(element); range.collapse(true);
  const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
}

/** 一键清除当前行的块级和行内格式，保留正文。 */
function clearFormat() {
  const inPreview = syncPreviewCursor();
  const line = view.state.doc.lineAt(view.state.selection.main.head);
  let body = line.text.trimStart();
  for (;;) {
    const stripped = body.replace(/^(\s*)(?:#{1,6}\s+|>\s?|[-*+](?:\s+|$)(?:\[[ xX]\]\s*)?|\d+[.)](?:\s+|$))/, '$1');
    if (stripped === body) break;
    body = stripped;
  }
  const template = document.createElement('template');
  template.innerHTML = DOMPurify.sanitize(marked.parseInline(body));
  template.content.querySelectorAll('img').forEach(image => image.replaceWith(document.createTextNode(image.getAttribute('alt') || '')));
  template.content.querySelectorAll('br').forEach(br => br.replaceWith(document.createTextNode(' ')));
  const plain = template.content.textContent;
  if (plain === line.text) { toast('当前行没有可清除的格式'); return; }
  view.dispatch({ changes: { from: line.from, to: line.to, insert: plain }, selection: { anchor: line.from } });
  if (inPreview) focusPreviewSource(line.from); else view.focus();
  toast('已清除当前行格式');
}

function chooseListStart(context) {
  const inPreview = context?.inPreview ?? syncPreviewCursor();
  if (context?.position != null) view.dispatch({ selection: { anchor: context.position } });
  const position = view.state.selection.main.head;
  const list = orderedListRange(view.state.doc.toString(), position);
  if (!list) { toast('请先将光标放在有序列表项中'); return; }
  document.getElementById('listStartDialog')?.remove();
  const dialog = document.createElement('div');
  dialog.id = 'listStartDialog'; dialog.className = 'modal-mask show';
  dialog.innerHTML = `<div class="modal"><div class="modal-head"><span class="modal-title">有序列表编号</span></div>
    <div class="modal-body">
      <label><input type="radio" name="list-start" value="reset" checked> 从 1 重新编号</label><br><br>
      <label><input type="radio" name="list-start" value="custom"> 从指定编号开始</label>
      <input class="img-input" id="listStartNumber" type="number" min="0" max="999999999" value="${list.start}" aria-label="起始编号">
    </div><div class="modal-foot"><button class="ub-btn" data-act="cancel">取消</button><button class="ub-btn primary" data-act="apply">应用</button></div></div>`;
  const input = dialog.querySelector('#listStartNumber');
  input.addEventListener('input', () => { dialog.querySelector('[value="custom"]').checked = true; });
  dialog.addEventListener('click', event => {
    const action = event.target.closest('[data-act]')?.dataset.act;
    if (action === 'cancel') dialog.remove();
    if (action !== 'apply') return;
    try {
      const start = dialog.querySelector('[name="list-start"]:checked').value === 'reset' ? 1 : Number(input.value);
      if (!input.value.trim() && start !== 1) throw new Error('请填写起始编号');
      const text = renumberList(list, start);
      view.dispatch({ changes: { from: list.from, to: list.to, insert: text }, selection: { anchor: list.from } });
      dialog.remove();
      if (inPreview) focusPreviewSource(list.from); else view.focus();
    } catch (error) { toast(error.message); }
  });
  dialog.addEventListener('keydown', event => { if (event.key === 'Escape') dialog.remove(); if (event.key === 'Enter') dialog.querySelector('[data-act="apply"]').click(); });
  document.body.appendChild(dialog);
}

// 保留原生列表标记，通过标记区域命中检测提供点击操作，不向可编辑内容插入控件。
const markerMeasure = document.createElement('canvas').getContext('2d');
function previewNumberAt(event) {
  for (const item of [...previewEl.querySelectorAll('ol > li')].reverse()) {
    const box = item.getBoundingClientRect();
    const style = getComputedStyle(item);
    const height = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.85;
    if (event.clientY < box.top || event.clientY > Math.min(box.bottom, box.top + height)) continue;
    const start = Number(item.parentElement.getAttribute('start') ?? 1);
    const index = [...item.parentElement.children].filter(element => element.tagName === 'LI').indexOf(item);
    markerMeasure.font = style.font || `${style.fontSize} ${style.fontFamily}`;
    const width = markerMeasure.measureText(`${start + index}.`).width + 12;
    if (event.clientX < box.left && event.clientX >= box.left - width) return item;
  }
  return null;
}
previewEl.addEventListener('mousedown', event => {
  if (event.button !== 0 || event.shiftKey || event.metaKey || event.ctrlKey || event.altKey) return;
  const item = previewNumberAt(event);
  if (!item) return;
  event.preventDefault();
  const range = document.createRange(); range.selectNodeContents(item); range.collapse(true);
  const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
  syncPreviewCursor();
  chooseListStart({ inPreview: true, position: view.state.selection.main.head });
});
previewEl.addEventListener('mousemove', event => {
  const overNumber = !!previewNumberAt(event);
  previewEl.style.cursor = overNumber ? 'pointer' : '';
  previewEl.title = overNumber ? '点击序号，选择是否从 1 开始' : '';
});
previewEl.addEventListener('mouseleave', () => { previewEl.style.cursor = ''; previewEl.title = ''; });

// 源码编辑区同样可以直接点击行首数字，正文点击仍正常定位光标。
function sourceNumberAt(event) {
  const position = view.posAtCoords({ x: event.clientX, y: event.clientY });
  if (position == null) return null;
  const line = view.state.doc.lineAt(position);
  const match = /^(\s*)(\d+[.)])(?=\s|$)/.exec(line.text);
  if (!match) return null;
  const from = line.from + match[1].length;
  const to = from + match[2].length;
  const left = view.coordsAtPos(from), right = view.coordsAtPos(to);
  if (!left || !right || event.clientY < left.top || event.clientY > left.bottom || event.clientX < left.left || event.clientX > right.left) return null;
  return from;
}
view.contentDOM.addEventListener('mousedown', event => {
  if (event.button !== 0 || event.shiftKey || event.metaKey || event.ctrlKey || event.altKey || view.composing) return;
  const position = sourceNumberAt(event);
  if (position == null) return;
  event.preventDefault();
  event.stopPropagation();
  chooseListStart({ inPreview: false, position });
}, true);
view.contentDOM.addEventListener('mousemove', event => {
  view.contentDOM.style.cursor = sourceNumberAt(event) == null ? '' : 'pointer';
});
view.contentDOM.addEventListener('mouseleave', () => { view.contentDOM.style.cursor = ''; });

function insertHr() {
  // 分隔线是块级内容，必须另起一块。
  // 之前用 replaceSelection('\n\n---\n\n') 直接插在光标处，
  // 会把段落从中间劈开：
  //   '- 列表项甲' → '- 列表\n\n---\n\n项甲'
  insertBlockAfter('---');
}

function insertLink() {
  const { from, to, text } = getSel();
  if (text) {
    const s = `[${text}](https://)`;
    replaceSelection(s, s.length - 1);
  } else {
    replaceSelection('[链接文字](https://)', 4);
  }
  toast('已插入链接，填入地址后按 Esc');
}

/* ============ 插入图片（弹窗选本地 / 远程） ============ */
function insertImage() {
  const dlg = document.createElement('div');
  dlg.className = 'modal-mask';
  dlg.innerHTML = `
    <div class="modal">
      <div class="modal-head">
        <span class="modal-title">插入图片</span>
        <button class="ub-btn icon" data-act="close" title="关闭">
          <svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>
        </button>
      </div>
      <div class="modal-body">
        <div class="img-picker">
          <button class="img-choice" data-act="local">
            <svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8.5" cy="9.5" r="1.6"/><path d="M21 16l-5-5-5.5 5.5L8 14l-5 5"/></svg>
            <b>本地图片</b>
            <span>从电脑里选一张图片文件</span>
          </button>
          <button class="img-choice" data-act="remote">
            <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a15 15 0 0 1 0 18M12 3a15 15 0 0 0 0 18"/></svg>
            <b>远程图片</b>
            <span>填图片网址（http/https）</span>
          </button>
        </div>
        <div class="img-remote" style="display:none">
          <label class="img-label" for="imgUrl">图片网址</label>
          <input class="img-input" id="imgUrl" type="url" placeholder="https://example.com/photo.png" />
          <div class="img-hint">插入后可以再改说明文字（alt）</div>
        </div>
      </div>
      <div class="modal-foot">
        <button class="ub-btn" data-act="close">取消</button>
        <button class="ub-btn primary" data-act="confirm" style="display:none">插入</button>
      </div>
    </div>
  `;

  const remoteBox = dlg.querySelector('.img-remote');
  const urlInput = dlg.querySelector('#imgUrl');
  const confirmBtn = dlg.querySelector('[data-act="confirm"]');
  let mode = null;

  const close = () => dlg.remove();

  const insert = (src, alt) => {
    const s = String(src || '').trim();
    if (!s) { toast('请填写图片网址'); return; }
    const safeAlt = String(alt || '图片').replace(/[\[\]]/g, '');
    const md = `![${safeAlt}](<${s.replace(/</g, '%3C').replace(/>/g, '%3E')}>)`;
    replaceSelection(md, md.length);
    close();
    toast('已插入图片');
  };

  dlg.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const act = btn.dataset.act;

    if (act === 'close') { close(); return; }

    if (act === 'local') {
      // 本地文件要拿到当前文档所在目录，才能算出相对路径
      let baseDir = '';
      try {
        const tab = tabs.find(t => t.id === activeId);
        if (tab && tab.path) baseDir = tab.path.replace(/[\\/][^\\/]*$/, '');
      } catch (err) { /* 拿不到就用绝对路径 */ }
      const r = await window.api.pickImage(baseDir);
      if (r && r.path) insert(r.path, '图片');
      return;
    }

    if (act === 'remote') {
      mode = 'remote';
      remoteBox.style.display = '';
      confirmBtn.style.display = '';
      dlg.querySelectorAll('.img-choice').forEach(b => { b.style.display = 'none'; });
      urlInput.focus();
      return;
    }

    if (act === 'confirm') {
      insert(urlInput.value, '图片');
      return;
    }
  });

  urlInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); insert(urlInput.value, '图片'); }
  });

  document.body.appendChild(dlg);
  requestAnimationFrame(() => dlg.classList.add('show'));
}

function heading(level) {
  const { from, to, text } = getSel();
  const line = view.state.doc.lineAt(from);
  const existing = /^(#{1,6})\s/.exec(view.state.sliceDoc(line.from, line.to));
  const prefix = '#'.repeat(level) + ' ';
  if (text) {
    // 有选区：如果整行已是目标级别则降级为正文
    if (existing && existing[1].length === level) {
      view.dispatch({ changes: { from: line.from, to: line.from + existing[0].length, insert: '' } });
      view.focus(); return;
    }
    insertBlock(prefix + text, prefix.length);
  } else {
    if (existing) {
      if (existing[1].length === level) {
        view.dispatch({ changes: { from: line.from, to: line.from + existing[0].length, insert: '' } });
      } else {
        view.dispatch({ changes: { from: line.from, to: line.from + existing[0].length, insert: prefix } });
      }
    } else {
      view.dispatch({ changes: { from: line.from, insert: prefix } });
    }
    view.focus();
  }
}

/**
 * Markdown 编辑手感（列表续行 / Backspace 取消标记 / 表格跳格）的开关。
 *
 * 为什么要有这个开关：
 *   这些增强是「抢」默认按键行为的（Enter / Backspace / Tab），
 *   一旦在某种输入场景下出问题（最典型的是中文输入法），
 *   用户就完全没法编辑了 —— 没有任何办法临时绕过。
 *
 *   所以做成运行时可关：菜单「帮助 → Markdown 编辑手感」，
 *   关掉后立刻回到 CodeMirror 默认行为，不用重启。
 */
const MD_KEYMAP_KEY = 'qingmo.mdKeymap.off';

function mdKeymapEnabled() {
  try { return localStorage.getItem(MD_KEYMAP_KEY) !== '1'; } catch (e) { return true; }
}

function setMdKeymapEnabled(on) {
  try {
    if (on) localStorage.removeItem(MD_KEYMAP_KEY);
    else localStorage.setItem(MD_KEYMAP_KEY, '1');
  } catch (e) { /* 隐私模式下写不了，忽略 */ }
}

// 初始化时暴露（主进程菜单要读，测试也要用）
window.__mdKeymapEnabled = () => mdKeymapEnabled();
window.__setMdKeymapEnabled = setMdKeymapEnabled;

// 主进程点菜单 → 切换
window.api.on('app:setMdKeymap', (_ch, on) => {
  setMdKeymapEnabled(!!on);
  toast(on ? '已开启 Markdown 编辑手感' : '已关闭 Markdown 编辑手感（列表续行等不再生效）');
  logger.info('Markdown 编辑手感已切换', { enabled: !!on });
});

/**
 * Markdown 编辑手感 —— Enter / Backspace / Tab
 *
 * 之前完全没有这些处理，导致：
 *   · 列表项按 Enter 不会续列表（要手打 '- '）
 *   · 列表行首按 Backspace 不会取消标记
 *   · 表格里按 Tab 反而是缩进，跳不到下一格
 * 这是 Markdown 编辑器最基础的手感，缺了就「没法用」。
 *
 * 行为规划在 editor-keys.js（纯函数，可单测），
 * 这里只负责把规划翻译成 CodeMirror 的 transaction。
 */
function markdownKeymap() {
  /** 拿到全文行数组 + 光标所在行列 */
  function ctx() {
    const sel = view.state.selection.main;
    const docText = view.state.doc.toString();
    const lines = docText.split('\n');
    const line = view.state.doc.lineAt(sel.head);
    return { sel, docText, lines, lineNo: line.number - 1, col: sel.head - line.from };
  }

  return [
    // ⚠⚠ 这里【不要】再实现 Enter / Backspace。
    //
    // CodeMirror 的 @codemirror/lang-markdown 自带一套 Markdown 专用绑定
    //   （源码 399-400 行）：
    //     { key: "Enter",    run: insertNewlineContinueMarkup }
    //     { key: "Backspace", run: deleteMarkupBackward }
    //   而且是 Prec.high 优先级 —— 比我这里的普通 keymap 更高，先跑。
    //
    // 之前自己又实现了一遍 Enter/Backspace，等于用「自己的粗糙版本」
    // 去覆盖 CodeMirror 那套经过大量打磨的实现：
    //   · 它不懂代码块 / HTML 区域（原生会正确地不处理）
    //   · 拆分点的处理和我不一样
    //   · 一旦用 Prec.high 去抢，preventDefault 反而会打断 IME 选词
    //
    // 所以现在只补 CodeMirror 【没有】的：表格里 Tab 跳格。
    // Tab 上保留了 IME 检查 —— IME 组合中按 Tab 基本不会发生，
    // 拦一下的副作用可以忽略，而漏掉的代价是「中文候选框被 Tab 打断」。
    {
      key: "Tab",
      run: (v) => {
        if (!mdKeymapEnabled()) return false;   // 用户关了 Markdown 手感
        if (v.composing || lastKeyIsComposing) return false;
        const { sel, docText, lines, lineNo, col } = ctx();
        const plan = planTab(lines, lineNo, col, false);
        if (!plan) {
          // 非表格 → 保持原有的缩进行为
          return indentMore(v) || indentLess(v);
        }
        const lineObj = view.state.doc.line(lineNo + 1);

        if (plan.type === 'next-cell') {
          view.dispatch({ selection: { anchor: lineObj.from + plan.col } });
          view.focus();
          return true;
        }

        if (plan.type === 'add-row') {
          // 表格最后一行按 Tab → 加一行
          const newRow = makeTableRow(plan.cells);
          view.dispatch({
            changes: { from: lineObj.to, insert: '\n' + newRow },
            selection: { anchor: lineObj.to + 1 + 2 }
          });
          view.focus();
          return true;
        }

        // 列表缩进也交给 CodeMirror 的 indentMore（它懂 Markdown 的缩进规则）
        return indentMore(v) || indentLess(v);
      }
    },

    {
      key: "Shift-Tab",
      run: (v) => {
        if (!mdKeymapEnabled()) return false;   // 用户关了 Markdown 手感
        if (v.composing || lastKeyIsComposing) return false;
        const { sel, lines, lineNo, col } = ctx();
        const plan = planTab(lines, lineNo, col, true);
        if (!plan) return indentLess(v);
        const lineObj = view.state.doc.line(lineNo + 1);

        if (plan.type === 'next-cell') {
          view.dispatch({ selection: { anchor: lineObj.from + plan.col } });
          view.focus();
          return true;
        }
        // 升级为父项也交给 CodeMirror 的 indentLess
        return indentLess(v);
      }
    }
  ];
}

function formattingKeymap() {
  return [
    { key: "Mod-b", run: () => (wrap("**", "**"), true) },
    { key: "Mod-i", run: () => (wrap("*", "*"), true) },
    { key: "Mod-e", run: () => (wrap("`", "`"), true) },
    { key: "Mod-Shift-x", run: () => (wrap("~~", "~~"), true) },
    { key: "Mod-Shift-k", run: () => (insertCodeBlock(), true) },
    { key: "Mod-Shift-q", run: () => (insertQuote(), true) },
    { key: "Mod-Alt-1", run: () => (heading(1), true) },
    { key: "Mod-Alt-2", run: () => (heading(2), true) },
    { key: "Mod-Alt-3", run: () => (heading(3), true) }
  ];
}

/* ============ 设置面板 ============
 *
 * 原来这些功能散在原生菜单里（帮助 → 检查更新 / 修复文件关联 / 导出日志），
 * 但页面上已经有全套可视化图标，再挂文字菜单是重复的（Windows 上还占一行）。
 * 现在：菜单栏隐藏，只保留快捷键；页面上没图标的功能收进这个面板。
 */
function openSettings() {
  const old = document.getElementById('settingsDialog');
  if (old) old.remove();

  let ver = '—';
  try { ver = window.api.version ? window.api.version() : '—'; } catch (e) {}

  const dlg = document.createElement('div');
  dlg.id = 'settingsDialog';
  dlg.className = 'modal-mask';
  dlg.innerHTML = `
    <div class="modal" style="width:min(520px,100%)">
      <div class="modal-head">
        <span class="modal-title">设置</span>
        <button class="ub-btn icon" data-act="close" title="关闭">
          <svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>
        </button>
      </div>
      <div class="modal-body">
        <div class="set-sec">
          <div class="set-sec-title">外观</div>
          <div class="set-row">
            <div class="set-label">
              <b>深色模式</b>
              <span>编辑区与预览区同时切换</span>
            </div>
            <label class="set-switch">
              <input type="checkbox" data-set="dark" />
              <span class="set-switch-track"></span>
            </label>
          </div>
        </div>

        <div class="set-sec">
          <div class="set-sec-title">编辑</div>
          <div class="set-row">
            <div class="set-label">
              <b>Markdown 编辑手感</b>
              <span>表格 Tab 跳格等快捷行为</span>
            </div>
            <label class="set-switch">
              <input type="checkbox" data-set="mdkeymap" />
              <span class="set-switch-track"></span>
            </label>
          </div>
          <div class="set-row">
            <div class="set-label">
              <b>预览区直接编辑</b>
              <span>在右侧渲染结果里直接打字</span>
            </div>
            <label class="set-switch">
              <input type="checkbox" data-set="liveedit" />
              <span class="set-switch-track"></span>
            </label>
          </div>
        </div>

        <div class="set-sec">
          <div class="set-sec-title">文件</div>
          <div class="set-row">
            <div class="set-label"><b>关闭窗口后留在后台</b><span>保留打开的文档；通过 ${window.api.platform === 'darwin' ? 'Cmd+Q' : 'Ctrl+Q 或设置中的“退出应用”'} 退出时检查全部未保存文件</span></div>
            <label class="set-switch"><input type="checkbox" data-set="background" disabled /><span class="set-switch-track"></span></label>
          </div>
          <div class="set-row">
            <div class="set-label">
              <b>Markdown 文件关联</b>
              <span id="setAssoc">检查中…</span>
            </div>
            <button class="ub-btn" data-act="repair-assoc">修复</button>
          </div>
        </div>

        <div class="set-sec">
          <div class="set-sec-title">高级</div>
          <div class="set-actions">
            <button class="ub-btn" data-act="check-update">检查更新</button>
            <button class="ub-btn" data-act="export-log">导出诊断日志</button>
            <button class="ub-btn" data-act="devtools">开发者工具</button>
            ${window.api.platform !== 'darwin' ? '<button class="ub-btn" data-act="quit">退出应用</button>' : ''}
          </div>
        </div>

        <div class="set-foot">
          <span>轻墨 QingMo · 版本 ${ver}</span>
          <button class="ub-btn" data-url="https://github.com/engrecho/qingmo">项目主页</button>
        </div>
      </div>
      <div class="modal-foot">
        <button class="ub-btn primary" data-act="close">完成</button>
      </div>
    </div>
  `;

  const dark = dlg.querySelector('[data-set="dark"]');
  const mdk = dlg.querySelector('[data-set="mdkeymap"]');
  const live = dlg.querySelector('[data-set="liveedit"]');
  dark.checked = document.documentElement.dataset.theme === 'dark';
  mdk.checked = mdKeymapEnabled();
  live.checked = !!liveEdit;
  const background = dlg.querySelector('[data-set="background"]');
  window.api.getPreferences().then(value => { background.checked = value.closeToBackground; background.disabled = false; }).catch(() => { background.title = '无法读取关闭设置'; });

  dlg.addEventListener('change', async (e) => {
    const t = e.target;
    if (t.dataset.set === 'dark') setTheme(t.checked ? 'dark' : 'light');
    if (t.dataset.set === 'mdkeymap') setMdKeymapEnabled(t.checked);
    if (t.dataset.set === 'liveedit') setLiveEdit(t.checked);
    if (t.dataset.set === 'background') {
      t.disabled = true;
      try { const value = await window.api.setPreferences({ closeToBackground: t.checked }); t.checked = value.closeToBackground; }
      catch (error) { t.checked = !t.checked; toast('设置保存失败：' + error.message); }
      finally { t.disabled = false; }
    }
  });

  dlg.addEventListener('click', async (e) => {
    const u = e.target.closest('[data-url]');
    if (u) { window.api.openExternal(u.dataset.url); return; }

    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const act = btn.dataset.act;

    if (act === 'close') { dlg.remove(); return; }

    if (act === 'repair-assoc') {
      const box = dlg.querySelector('#setAssoc');
      if (box) box.textContent = '正在修复…';
      try {
        const r = await window.api.repairFileAssoc();
        if (box) {
          box.textContent = (r && r.ok)
            ? '已修复 —— 双击 .md 现在会用轻墨打开'
            : '修复失败：' + ((r && r.error) || '未知原因');
        }
        toast((r && r.ok) ? '文件关联已修复' : '修复失败');
      } catch (err) {
        if (box) box.textContent = '修复失败：' + (err && err.message);
      }
      return;
    }

    if (act === 'check-update') {
      dlg.remove();
      // 复用 update.js 的检查逻辑（它会弹更新对话框）——
      // 两个 bundle 只能通过 window 搭桥
      if (typeof window.qingmoCheckUpdate === 'function') {
        window.qingmoCheckUpdate(true);
      } else {
        toast('更新模块还没加载好');
      }
      return;
    }

    if (act === 'export-log') {
      dlg.remove();
      try { await window.api.exportLog(); } catch (e) { toast('导出失败'); }
      return;
    }

    if (act === 'quit') { dlg.remove(); await window.api.quit(); return; }

    if (act === 'devtools') {
      dlg.remove();
      try { await window.api.devtools(); } catch (e) { /* 忽略 */ }
      return;
    }
  });

  document.body.appendChild(dlg);
  requestAnimationFrame(() => dlg.classList.add('show'));

  // 异步查关联状态
  (async () => {
    const box = dlg.querySelector('#setAssoc');
    if (!box) return;
    try {
      const r = await window.api.fileAssocStatus();
      if (!r || !r.ok) { box.textContent = '检查失败'; return; }
      box.textContent = r.isQingMo
        ? '已关联到轻墨 ✓'
        : '未关联（当前指向 ' + r.progid + '）';
    } catch (e) {
      box.textContent = '检查失败';
    }
  })();
}

/* ============ 命令分发 ============ */
const COMMANDS = {
  'cmd:new': newFile,
  'cmd:open': openFile,
  'cmd:save': () => saveFile(false),
  'cmd:saveAs': () => saveFile(true),
  'cmd:exportHtml': exportHtml,
  'cmd:exportPdf': exportPdf,
  'cmd:rename': () => renameTab(activeId),
  'cmd:reopenClosed': () => reopenClosed(),
  'cmd:closedHistory': showClosedHistory,
  'cmd:closeAll': closeAllTabs,
  'cmd:closeTab': () => closeTab(activeId),
  'cmd:find': () => view.dispatch({ effects: [] }),
  'fmt:bold': () => wrap("**", "**"),
  'fmt:italic': () => wrap("*", "*"),
  'fmt:strike': () => wrap("~~", "~~"),
  'fmt:code': () => wrap("`", "`"),
  'fmt:clear': clearFormat,
  'list:start': chooseListStart,
  'fmt:h1': () => heading(1),
  'fmt:h2': () => heading(2),
  'fmt:h3': () => heading(3),
  'ins:table': insertTable,
  'ins:quote': insertQuote,
  'ins:code': insertCodeBlock,
  'ins:ul': () => switchList('ul'),
  'ins:ol': () => switchList('ol'),
  'ins:todo': () => switchList('todo'),
  'ins:hr': insertHr,
  'ins:link': insertLink,
  'ins:image': insertImage,
  'app:settings': openSettings
};

function run(cmd) {
  const fn = COMMANDS[cmd];
  if (fn) fn();
}

async function buildExportDocument(format) {
  const css = `
    :root { color-scheme: light dark }
    * { box-sizing: border-box }
    body {
      max-width: 760px; margin: 0 auto; padding: 64px 28px 96px;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC",
                   "Microsoft YaHei", sans-serif;
      font-size: 16px; line-height: 1.85; color: #1a1d23; background: #fff;
      -webkit-font-smoothing: antialiased;
    }
    h1, h2, h3, h4, h5, h6 { font-weight: 650; line-height: 1.35; margin: 1.9em 0 .7em }
    h1 { font-size: 1.95em; letter-spacing: -.02em }
    h2 { font-size: 1.5em; padding-bottom: .35em; border-bottom: 1px solid #e4e7ec }
    h3 { font-size: 1.24em } h4 { font-size: 1.06em }
    p { margin: 0 0 1.15em }
    a { color: #3b6ef0; text-decoration: none; border-bottom: 1px solid #c3d4fb }
    a:hover { border-bottom-color: #3b6ef0 }
    strong { font-weight: 700 }
    code {
      font-family: "SF Mono", "Cascadia Code", Menlo, Consolas, monospace;
      font-size: .87em; padding: .18em .42em;
      background: #eef0f3; border-radius: 5px;
    }
    pre {
      margin: 1.4em 0; padding: 18px 20px; line-height: 1.7;
      background: #fafbfc; border: 1px solid #e4e7ec;
      border-radius: 10px; overflow-x: auto;
    }
    pre code { background: none; padding: 0; font-size: .86em; color: #3d4550 }
    blockquote {
      margin: 1.4em 0; padding: .7em 1.3em; color: #3d4550;
      border-left: 3px solid #3b6ef0; background: #fafbfc;
      border-radius: 0 7px 7px 0;
    }
    blockquote p:last-child { margin-bottom: 0 }
    table {
      border-collapse: separate; border-spacing: 0; width: 100%;
      margin: 1.5em 0; font-size: .94em;
      border: 1px solid #e4e7ec; border-radius: 7px; overflow: hidden;
    }
    th, td { padding: 10px 15px; border-bottom: 1px solid #e4e7ec; border-right: 1px solid #e4e7ec; text-align: left }
    th:last-child, td:last-child { border-right: none }
    tr:last-child td { border-bottom: none }
    th { background: #f5f6f8; font-weight: 600; font-size: .95em; color: #3d4550 }
    tbody tr:nth-child(even) { background: #fafbfc }
    ul, ol { padding-left: 1.5em; margin: 0 0 1.15em }
    li { margin: .35em 0 }
    li::marker { color: #9aa3af }
    li.task-list-item { list-style: none; margin-left: -1.5em }
    input[type="checkbox"] { margin-right: .55em; accent-color: #3b6ef0; vertical-align: middle }
    hr { margin: 2.6em 0; border: none; height: 1px; background: #e4e7ec }
    img { max-width: 100%; border-radius: 7px }

    @media screen and (prefers-color-scheme: dark) {
      body { background: #16181c; color: #e9edf3 }
      h2, hr { border-color: #2b3038 }
      code { background: #23272e }
      pre { background: #191c21; border-color: #2b3038 }
      pre code { color: #c8cfd9 }
      blockquote { background: #191c21; color: #c8cfd9; border-left-color: #5b8cff }
      table, th, td { border-color: #2b3038 }
      th { background: #1d2127; color: #c8cfd9 }
      tbody tr:nth-child(even) { background: #191c21 }
      a { color: #5b8cff; border-bottom-color: #2f4470 }
      li::marker { color: #79828f }
    }
    @media print {
      :root { color-scheme: light }
      body { max-width: none; padding: 0; color: #1a1d23; background: #fff; font-size: 11pt }
      h1, h2, h3, h4, h5, h6 { break-after: avoid }
      pre { white-space: pre-wrap; overflow-wrap: anywhere }
      img { max-height: 240mm; object-fit: contain; break-inside: avoid }
      tr, blockquote { break-inside: avoid }
      thead { display: table-header-group }
    }`;
  const title = currentPath ? currentPath.split(/[\\/]/).pop() : 'untitled';
  const body = document.createElement('div');
  body.innerHTML = imageHtml(marked.parse(view.state.doc.toString()), html => DOMPurify.sanitize(html));
  await loadLocalImages(body, currentPath, (source, doc) => window.api.readImage(source, doc));
  if (format === 'PDF' && body.querySelector('img[data-qingmo-image]:not([src])')) throw new Error('本地图片读取失败，请检查图片路径后重试');
  body.querySelectorAll('[data-qingmo-image]').forEach(image => image.removeAttribute('data-qingmo-image'));
  const html = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title><style>${css}</style></head>
<body>${body.innerHTML}</body></html>`;
  return { html, name: title.replace(/\.md$/i, '') };
}

async function exportDocument(format) {
  try {
    const { html, name } = await buildExportDocument(format);
    const result = format === 'PDF' ? await window.api.exportPdf(html, name) : await window.api.exportHtml(html, name);
    if (result && result.ok) toast('已导出 ' + format);
    else if (result && result.error) toast('导出失败：' + result.error);
  } catch (error) { toast('导出失败：' + (error.message || '请重试')); }
}
function exportHtml() { return exportDocument('HTML'); }
function exportPdf() { return exportDocument('PDF'); }

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ============ 视图模式 ============ */
const panes = document.getElementById("panes");
function setMode(mode) {
  panes.dataset.mode = mode;
  document.querySelectorAll('#segbar .seg').forEach(b => b.classList.toggle('active', b.dataset.view === mode));
  localStorage.setItem('mdx.mode', mode);
  requestAnimationFrame(() => { view.requestMeasure(); if (mode !== 'preview') renderPreview(true); });
}

/* ============ 主题 ============ */
function setTheme(t) {
  document.documentElement.dataset.theme = t;
  localStorage.setItem(THEME_KEY, t);
  const meta = document.querySelector('meta[name="theme-color"]') || (() => {
    const m = document.createElement('meta'); m.name = 'theme-color'; document.head.appendChild(m); return m;
  })();
  meta.content = t === 'dark' ? '#16181d' : '#ffffff';
}
function toggleTheme() {
  setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
}

/* ============ Toast ============ */
const toastEl = document.getElementById("toast");
let toastTimer;
function toast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), 1600);
}

/* ============ 分隔条拖拽 ============ */
(function setupDivider() {
  const divider = document.getElementById("divider");
  let dragging = false;
  divider.addEventListener("mousedown", e => {
    dragging = true;
    divider.classList.add('dragging');
    e.preventDefault();
  });
  window.addEventListener("mousemove", e => {
    if (!dragging) return;
    const rect = panes.getBoundingClientRect();
    let pct = ((e.clientX - rect.left) / rect.width) * 100;
    pct = Math.min(80, Math.max(20, pct));
    panes.style.setProperty('--split', pct + '%');
    view.requestMeasure();
  });
  window.addEventListener("mouseup", () => {
    if (dragging) { dragging = false; divider.classList.remove('dragging'); renderPreview(); }
  });
})();

/* ============ 事件绑定 ============ */
document.getElementById('titlebar').addEventListener('mousedown', event => {
  const command = event.target.closest('[data-cmd]')?.dataset.cmd;
  if (command === 'fmt:clear') { syncPreviewCursor(); event.preventDefault(); }
});
document.getElementById("titlebar").addEventListener("click", e => {
  const btn = e.target.closest('[data-cmd]');
  if (btn) { run(btn.dataset.cmd); return; }
  const seg = e.target.closest('[data-view]');
  if (seg) setMode(seg.dataset.view);
});
document.getElementById("btnTheme").addEventListener("click", toggleTheme);
document.getElementById("btnLive").addEventListener("click", () => setLiveEdit(!liveEdit));
document.getElementById("btnSettings").addEventListener("click", openSettings);
document.getElementById("btnPanel").addEventListener("click", toggleSidebar);
document.getElementById("btnCollapse").addEventListener("click", toggleSidebar);
document.getElementById("sbNew").addEventListener("click", () => newFile());
document.getElementById("sbOpen").addEventListener("click", () => openFile());
document.getElementById('sbClosedHistory').addEventListener('click', showClosedHistory);
fileName.addEventListener('dblclick', () => renameTab(activeId));
fileName.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); renameTab(activeId); } });
document.getElementById("sbCloseAll").addEventListener("click", () => closeAllTabs());

/* 侧边栏宽度拖拽；折叠态下双击把手展开 */
(function setupSidebarHandle() {
  const handle = document.getElementById("sbHandle");
  const ws = document.querySelector(".workspace");
  let dragging = false, startX = 0, startW = 0;

  handle.addEventListener("mousedown", e => {
    if (ws.dataset.sb === "collapsed") return;
    dragging = true;
    startX = e.clientX;
    startW = parseInt(getComputedStyle(ws).getPropertyValue("--sb-w")) || 208;
    handle.classList.add("dragging");
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    e.preventDefault();
  });

  handle.addEventListener("dblclick", () => setSidebar(ws.dataset.sb !== "collapsed"));

  window.addEventListener("mousemove", e => {
    if (!dragging) return;
    const w = Math.min(420, Math.max(140, startW + (e.clientX - startX)));
    ws.style.setProperty("--sb-w", w + "px");
    view.requestMeasure();
  });

  window.addEventListener("mouseup", () => {
    if (!dragging) return;
    dragging = false;
    handle.classList.remove("dragging");
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    try {
      const w = parseInt(getComputedStyle(ws).getPropertyValue("--sb-w"));
      if (w) localStorage.setItem("mdx.sbWidth", String(w));
    } catch (e) {}
    renderPreview();
  });
})();

/* ============================================
   全局快捷键
   --------------------------------------------
   Windows / Linux 上【没有原生菜单栏】了（页面上全是图标按钮，
   文字菜单是重复的）。而原生菜单的 accelerator 是绑在菜单项上的 ——
   菜单一撤，快捷键就全没了。
   所以快捷键全部由这里接管。

   已经在 CodeMirror keymap 里实现的（不要重复，否则会双触发）：
     Mod-b / Mod-i / Mod-e / Mod-Shift-x   加粗/斜体/行内代码/删除线
     Mod-Shift-k / Mod-Shift-q             代码块/引用
     Mod-Alt-1/2/3                         一到三级标题
     Mod-f                                 查找（searchKeymap）
     Mod-z / Mod-y                         撤销/重做（historyKeymap）
   ============================================ */
window.addEventListener("keydown", e => {
  if (e.defaultPrevented || e.target.closest?.('.modal-mask')) return;
  const mod = e.ctrlKey || e.metaKey;
  const k = e.key.toLowerCase();
  if (window.api.platform !== 'darwin' && mod && !e.shiftKey && !e.altKey && k === 'q') { e.preventDefault(); window.api.quit(); return; }

  // 数字键必须看【物理键位】e.code，不能看 e.key ——
  // 按住 Shift 时 e.key 会变成符号（Shift+7 是 '&'、Shift+8 是 '*'、Shift+9 是 '('），
  // 用 e.key 判断会全部落空。e.code 恒为 'Digit7' 这种，不受 Shift 影响。
  const digit = /^Digit([1-9])$/.exec(e.code || '');

  if (mod && e.code === 'Backslash' && !e.altKey && !e.isComposing) { e.preventDefault(); clearFormat(); return; }

  // ---------- 文件 ----------
  if (mod && !e.shiftKey && !e.altKey && k === "n") {
    e.preventDefault(); newFile(); return;
  }
  if (mod && !e.shiftKey && !e.altKey && k === "o") {
    e.preventDefault(); openFile(); return;
  }
  if (mod && !e.shiftKey && !e.altKey && k === "s") {
    e.preventDefault(); saveFile(false); return;
  }
  if (mod && e.shiftKey && !e.altKey && k === "s") {
    e.preventDefault(); saveFile(true); return;
  }
  if (mod && e.shiftKey && !e.altKey && k === "e") {
    e.preventDefault(); exportHtml(); return;
  }

  if (mod && e.shiftKey && !e.altKey && k === 't') { e.preventDefault(); reopenClosed(); return; }
  if (e.key === 'F2' && !e.ctrlKey && !e.metaKey && !document.querySelector('.modal-mask')) { e.preventDefault(); renameTab(activeId); return; }

  // ---------- 插入 ----------
  if (mod && !e.shiftKey && !e.altKey && k === "t") {
    e.preventDefault(); insertTable(); return;
  }
  if (mod && e.shiftKey && !e.altKey) {
    if (digit && digit[1] === "8") { e.preventDefault(); switchList('ul'); return; }
    if (digit && digit[1] === "7") { e.preventDefault(); switchList('ol'); return; }
    if (digit && digit[1] === "9") { e.preventDefault(); switchList('todo'); return; }
    if (k === "m") { e.preventDefault(); insertHr(); return; }
    if (k === "l") { e.preventDefault(); insertLink(); return; }
    if (k === "i") { e.preventDefault(); insertImage(); return; }
  }

  // ---------- 视图 ----------
  // Ctrl+1/2/3 = 仅编辑 / 分栏 / 仅预览
  if (mod && !e.shiftKey && !e.altKey && digit) {
    const n = digit[1];
    if (n === "1" || n === "2" || n === "3") {
      e.preventDefault();
      setMode(n === "1" ? 'edit' : n === "2" ? 'split' : 'preview');
      return;
    }
  }
  // Ctrl+Shift+P 切换「预览区直接编辑」
  if (mod && e.shiftKey && !e.altKey && k === "p") {
    e.preventDefault();
    setLiveEdit(!liveEdit);
    return;
  }
  // Ctrl+D 切换深色模式
  if (mod && !e.shiftKey && !e.altKey && k === "d") {
    e.preventDefault();
    toggleTheme();
    return;
  }

  // Ctrl+B 折叠侧边栏
  if (mod && !e.shiftKey && !e.altKey && k === "b") {
    // 如果有选区，优先给加粗（CodeMirror 的 Mod-b 会处理）
    const sel = view.state.selection.main;
    if (sel.empty) { e.preventDefault(); toggleSidebar(); return; }
  }

  // Ctrl+W 关闭当前标签
  if (mod && !e.shiftKey && !e.altKey && k === "w" && activeId != null) {
    e.preventDefault();
    closeTab(activeId);
    return;
  }

  // Ctrl+Tab / Ctrl+Shift+Tab 切换标签
  if (mod && e.key === "Tab") {
    e.preventDefault();
    if (tabs.length < 2) return;
    const i = tabs.findIndex(t => t.id === activeId);
    const next = e.shiftKey
      ? (i - 1 + tabs.length) % tabs.length
      : (i + 1) % tabs.length;
    switchTab(tabs[next].id);
    return;
  }

  // Alt+1..9 直接跳到第 N 个标签
  //
  // 之前是 Ctrl+1..9 —— 但 Ctrl+1/2/3 要留给视图切换（仅编辑/分栏/预览），
  // 两者本来就打架，标签直达实际上从来没生效过。改用 Alt，无冲突。
  if (e.altKey && !mod && !e.shiftKey && digit) {
    const idx = parseInt(digit[1], 10) - 1;
    if (idx < tabs.length) { e.preventDefault(); switchTab(tabs[idx].id); }
  }
});

window.api.on([
  'cmd:new', 'cmd:open', 'cmd:save', 'cmd:saveAs', 'cmd:exportHtml', 'cmd:exportPdf', 'cmd:rename', 'cmd:reopenClosed', 'cmd:closedHistory', 'cmd:closeAll', 'cmd:closeTab', 'cmd:find',
  'view:edit', 'view:split', 'view:preview', 'view:theme', 'view:liveEdit'
], (ch) => {
  const map = {
    'view:edit': () => setMode('edit'),
    'view:split': () => setMode('split'),
    'view:preview': () => setMode('preview'),
    'view:theme': toggleTheme,
    'view:liveEdit': () => setLiveEdit(!liveEdit)
  };
  if (map[ch]) map[ch](); else run(ch);
});

window.api.on([
  'ins:table', 'ins:quote', 'ins:code', 'ins:ul', 'ins:ol', 'ins:todo', 'ins:hr', 'ins:link', 'ins:image',
  'fmt:bold', 'fmt:italic', 'fmt:code', 'fmt:strike', 'fmt:h1', 'fmt:h2', 'fmt:h3'
], (ch) => run(ch));

// 注意参数：preload 的 on 回调签名是 (channel, arg)，这里第一个参数是频道名，
// 文件路径在第二个。写成 (p) => 会把 'cmd:openPath' 当成路径传下去，
// 结果就是「双击 md 打开没反应」「最近打开点了也没反应」。
window.api.on('cmd:openPath', async (_ch, p) => {
  logInfo('收到打开文件指令', { path: p });
  try {
    const r = await window.api.openPath(p);
    if (r && r.error) {
      logError('openPath', '读取文件失败: ' + r.error, { path: p });
      toast('打开失败：' + (r.error || '未知错误'));
      return;
    }
    if (!r) {
      logError('openPath', '主进程没有返回结果', { path: p });
      toast('打开失败：主进程无响应');
      return;
    }
    addTab({ path: r.path, content: r.content || '' });
    logInfo('文件已打开', { path: r.path, bytes: (r.content || '').length });
  } catch (e) {
    logError('openPath', '处理打开指令时异常: ' + (e && e.message), {
      path: p, stack: e && e.stack
    });
    toast('打开失败：' + (e && e.message || '未知错误'));
  }
});

/* 预览区点击表格不触发任何编辑 */
previewEl.addEventListener("click", e => {
  const a = e.target.closest('a');
  if (a && /^https?:/.test(a.getAttribute('href') || '')) {
    e.preventDefault();
    window.open(a.getAttribute('href'), '_blank');
  }
});

/* 拖拽图片文件插入 */
document.getElementById("panes").addEventListener("dragover", e => e.preventDefault());
document.getElementById("panes").addEventListener("drop", e => {
  e.preventDefault();
  const f = Array.from(e.dataTransfer.files)[0];
  if (f) toast("提示：图片请用 Markdown 语法 ![](路径) 引用");
});

/* ============ 启动 ============ */
async function boot() {
  setTheme(localStorage.getItem(THEME_KEY) ||
    (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));
  setMode(localStorage.getItem('mdx.mode') || 'split');

  // 侧边栏折叠状态与宽度
  try {
    const w = localStorage.getItem('mdx.sbWidth');
    if (w) document.querySelector('.workspace').style.setProperty('--sb-w', w + 'px');
  } catch (e) {}
  setSidebar(localStorage.getItem(SB_KEY) === 'collapsed');

  // 恢复上次会话；没有则新建一个空白文档
  const restored = await loadDraft();
  if (!restored) addTab({ content: DEFAULT_DOC });

  renderSidebar();
  renderPreview(true);
  snapshotBlockTexts();
  updateStatus();
  // 恢复「预览区直接编辑」状态，并同步按钮高亮
  const liveBtn = document.getElementById('btnLive');
  if (liveBtn) liveBtn.classList.toggle('active', liveEdit);
  view.focus();

  // 自动更新调度由主进程负责，两个 renderer bundle 不再重复触发。
}

// designPreview 需在 boot 完成后执行，否则两者会互相覆盖 tab 状态
const booted = boot();

/* 自动化验证入口：仅 ?test=1 时暴露内部状态，供 scripts/verify-ui.js 用。
 * 跟 designPreview 一样是走查/测试专用钩子，正常使用不暴露任何东西。 */
if (/[?&]test=1/.test(location.search)) {
  window.__qingmo = {
    // 编辑内核的纯函数，测试用（测表格解析这类容易算错位置的逻辑）
    __ek: { parseTableRow, isTableDivider, planEnter, planBackspace, planTab, parseListItem },
    toggleOutline,
    closeActiveTab: () => closeTab(activeId),
    closeAllTabs,
    addTab, switchTab, saveFile, renameTab, reopenClosed, closeTab,
    tabs: () => tabs.map(t => ({ id: t.id, path: t.path, name: tabName(t), dirty: t.dirty, content: t.content })),
    tabCount: () => tabs.length,
    getDoc: () => view.state.doc.toString(),
    setDoc: (text, cursor) => view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: text },
      // 光标要夹在新文档范围内。文档变短时旧的 selection 会越界，
      // 后续再 dispatch 一个合法 selection 就会报
      // "Selection points outside of document"。
      selection: { anchor: Math.min(cursor == null ? 0 : cursor, text.length) }
    }),
    setCursor: (pos) => view.dispatch({ selection: { anchor: pos } }),
    run,
    setLiveEdit,
    isLiveEdit: () => liveEdit,
    focusInPreview: (blockIndex) => {
      // contenteditable 的编辑宿主是 previewEl 本身，聚焦子元素不生效，
      // 要先聚焦宿主，再把选区放到目标 block 里
      const el = previewEl.children[blockIndex || 0];
      if (!el) return false;
      previewEl.focus();
      const range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(false);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      return true;
    }
  };
}

/* 设计走查用：?shot=1&theme=light|dark 注入多标签演示数据并置顶主题 */
(async function designPreview() {
  let q;
  try { q = new URLSearchParams(location.search); } catch (e) { return; }
  if (q.get('shot') !== '1') return;
  await booted;   // 等 boot 完成，避免 addTab(DEFAULT_DOC) 覆盖演示数据

  setTheme(q.get('theme') === 'dark' ? 'dark' : 'light');
  if (q.get('sb') === 'collapsed') setSidebar(true);

  const seed = window.__SEED_DOC__ || '';
  // 造几个演示标签，展示侧边栏效果
  const demo = [
    { path: '/Users/jaylon/Documents/产品需求文档.md', content: seed, dirty: false },
    { path: '/Users/jaylon/Documents/周报/2026-W42.md', content: '# 2026 第 42 周周报\n\n## 本周完成\n\n- Markdown 编辑器侧边栏\n- 图标体系\n\n## 下周计划\n\n- [ ] macOS 版本验证\n- [ ] 主题定制', dirty: true },
    { path: '/Users/jaylon/Documents/读书笔记.md', content: '# 读书笔记\n\n> 好书值得反复读。\n\n## 待读\n\n- 《思考，快与慢》\n- 《原则》', dirty: false },
    { name: '未命名.md', content: '# 草稿\n\n随手记点东西的地方。', dirty: true }
  ];
  tabs = [];
  activeId = null;
  tabSeq = 0;
  for (const d of demo) addTab(d);
  if (tabs[0]) switchTab(tabs[0].id);   // 切到第一个（产品需求文档）

  const f = document.getElementById('fileName');
  if (f) f.textContent = '产品需求文档.md';
  const p = document.getElementById('stPath');
  if (p) p.textContent = '/Users/jaylon/Documents/产品需求文档.md  ·  行 1, 列 1';

  clearDraft();
  renderSidebar();
  renderPreview(true);
  updateStatus();
})();