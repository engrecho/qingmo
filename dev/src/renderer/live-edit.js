/**
 * 预览区直接编辑（Live Preview）
 *
 * 思路：把预览区变成 contenteditable，用 marked.lexer() 把 Markdown 切成
 * 顶层 token，每个 token 的 raw 精确对应源码的一段（token.raw 顺序拼接
 * 起来 === 原文）。于是「预览区的第 N 个顶层元素」↔「源码的第 N 个
 * block token」建立一一映射，用户在预览区改字后，只把该 block 的
 * innerHTML 反向转成 Markdown，替换掉源码里对应的 raw，再触发 CodeMirror 更新。
 *
 * 为什么不做逐字符精确映射：那样要处理光标在 inline 标记（**粗体**）内部
 * 时的偏移换算，复杂度高且容易错位。按 block 粒度回写能覆盖 95% 的编辑
 * 需求，且永远不会把文档改坏。
 */
import { marked } from 'marked';

/* ============ 1. 源码分段 ============ */

/**
 * 把 Markdown 切成 block 列表。
 *
 * 关键：必须包含 space token（空行分隔符），否则 blocks[].raw 拼起来
 * 就不等于原文，按区间回写会吃掉段落之间的空行、把文档结构改坏。
 * space token 不产生 DOM 元素，用 `skip: true` 标记，渲染时跳过。
 *
 * @returns {{ blocks: Array<{token, start, end, raw, skip}> }}
 */
export function splitBlocks(md) {
  const tokens = marked.lexer(md);
  const blocks = [];
  let offset = 0;
  for (const tok of tokens) {
    const raw = tok.raw;
    const blocks0 = { token: tok, start: offset, end: offset + raw.length, raw };
    blocks.push(Object.assign({ skip: tok.type === 'space' }, blocks0));
    offset += raw.length;
  }
  return { blocks, all: tokens };
}

/* ============ 2. HTML → Markdown ============ */

/**
 * 转义文本里的 Markdown 元字符。
 *
 * 只转义**真的会改变语义**的字符，不转义尖括号、下划线这类 ——
 * 早期版本把它们也转义了，导致 `a < b` 变成 `a \< b`（反斜杠在
 * Markdown 里可见），`user_name` 变成 `user\_name`，非常难看。
 *
 * 反斜杠和反引号必须转义：前者防止转义失效，后者防止破坏行内代码结构。
 */
function escapeInline(text) {
  return text.replace(/([\\`])/g, '\\$1');
}

/** 把单个 DOM 节点转成 Markdown 文本 */
function nodeToMd(node, listCtx) {
  // 文本节点
  if (node.nodeType === 3) {
    // 只合并空格/制表符，保留换行（blockquote 等场景的软换行要靠它）
    return escapeInline(node.textContent).replace(/[ \t]+/g, ' ');
  }
  if (node.nodeType !== 1) return '';

  const el = node;
  const tag = el.tagName;

  switch (tag) {
    case 'BR':
      return '  \n';

    case 'STRONG':
    case 'B':
      return wrapInline(el, '**');
    case 'EM':
    case 'I':
      return wrapInline(el, '*');
    case 'DEL':
    case 'S':
    case 'STRIKE':
      return wrapInline(el, '~~');
    case 'CODE': {
      // 行内代码：不转义内部内容
      const inner = el.textContent.replace(/`/g, '\\`');
      return '`' + inner + '`';
    }

    case 'PRE': {
      // 语言标识在 <code class="language-js"> 上，不在 <pre> 上
      const codeEl = el.querySelector('code');
      const lang = (codeEl && codeEl.className
        ? (String(codeEl.className).match(/language-([\w+-]+)/) || [])[1]
        : '') || '';
      const body = (codeEl || el).textContent.replace(/\n$/, '');
      return '```' + lang + '\n' + body + '\n```';
    }

    case 'BLOCKQUOTE': {
      const inner = blockquoteToMd(el);
      return inner.split('\n').map(l => (l ? '> ' + l : '>')).join('\n');
    }

    case 'UL':
    case 'OL': {
      const ordered = tag === 'OL';
      // marked 渲染的 <ol> 不带 start 属性，默认从 1 开始
      const parsedStart = Number(el.getAttribute('start') ?? 1);
      const startAttr = Number.isInteger(parsedStart) && parsedStart >= 0 ? parsedStart : 1;
      const items = [...el.children].filter(c => c.tagName === 'LI');
      const lines = [];
      items.forEach((li, i) => {
        // 注意：这里传的是「第几项」（0 起），listItemToMd 内部会 +1。
        // 早期版本传的是 startAttr + i，里面又 +1，导致编号从 2 开始。
        lines.push(listItemToMd(li, ordered, ordered ? startAttr - 1 + i : 0));
      });
      return lines.join('\n');
    }

    case 'HR':
      return '---';

    case 'A': {
      const href = el.getAttribute('href') || '';
      const inner = elToMd(el);
      return '[' + inner + '](' + href + ')';
    }

    case 'IMG': {
      const src = el.getAttribute('data-qingmo-image') || el.getAttribute('src') || '';
      const alt = el.getAttribute('alt') || '';
      return '![' + alt.replace(/[\[\]]/g, '') + '](<' + src.replace(/</g, '%3C').replace(/>/g, '%3E') + '>)';
    }

    case 'TABLE':
      return tableToMd(el);

    case 'P': {
      // 有序/无序列表项里的 <p>（loose list）只取内容
      if (listCtx) return elToMd(el);
      // elToMd 里 <br> 已经转成了 '  \n'（带软换行标记），
      // 文本节点里的 \n 保持原样 —— 不能给所有 \n 都补 '  '，
      // 否则 blockquote 里的 "一\n二" 会变成 "一  \n二"，
      // 渲染出来就多出两个空格。
      return elToMd(el);
    }

    case 'INPUT':
      // checkbox 在 li 里由 listItemToMd 专门处理；走到这里说明
      // input 出现在其他位置，直接忽略（返回 boolean 会拼出 "true"）。
      return '';

    case 'DIV':
    case 'SECTION':
    case 'ARTICLE':
      return blockToMd(el, listCtx);

    default:
      return elToMd(el);
  }
}

/** 包裹行内内容；空内容不加标记 */
function wrapInline(el, marker) {
  const inner = elToMd(el);
  if (!inner) return '';
  return marker + inner + marker;
}

/**
 * 行内内容（不换行）
 *
 * 注意：换行**不能**在这里压成空格。marked 渲染的 blockquote 里
 * `> 一\n> 二` 会变成 `<p>一\n二</p>`，`\n` 是软换行，压成空格
 * 会让引用块的两行粘成一行。只有连续空格/制表符才合并。
 */
function elToMd(el) {
  let out = '';
  for (const child of el.childNodes) {
    if (child.nodeType === 3) {
      out += escapeInline(child.textContent).replace(/[ \t]+/g, ' ');
    } else if (child.nodeType === 1) {
      if (child.tagName === 'BR') out += '  \n';
      else out += nodeToMd(child, null);
    }
  }
  return out;
}

/** 块级内容（保留换行） */
function blockToMd(el, listCtx) {
  const parts = [];
  for (const child of el.childNodes) {
    if (child.nodeType === 3) {
      const t = escapeInline(child.textContent);
      if (t.trim()) parts.push(t);
    } else if (child.nodeType === 1) {
      const piece = nodeToMd(child, listCtx);
      if (piece) parts.push(piece);
    }
  }
  // 块之间要换行，否则两个 <p> 会粘成一行
  return parts.join('\n');
}

function blockquoteToMd(el) {
  let out = '';
  for (const child of el.childNodes) {
    if (child.nodeType === 3) {
      const t = escapeInline(child.textContent);
      if (t.trim()) out += t;
    } else if (child.nodeType === 1) {
      const piece = nodeToMd(child, null);
      if (piece) out += piece;
    }
  }
  return out.trim();
}

/**
 * 列表项转 Markdown。
 *
 * marked 渲染的任务列表用 <input type=checkbox> 表示勾选状态，
 * 这里还原成 [x] / [ ]。
 *
 * @param li        <li> 元素
 * @param ordered   是否有序列表
 * @param index     第几项（**0 起**，内部会 +1）
 */
function listItemToMd(li, ordered, index) {
  const checkbox = li.querySelector(':scope > input[type=checkbox]');
  let prefix = ordered ? (index + 1) + '. ' : '- ';

  // 取 li 里去掉 checkbox 之后的内容
  let inner = '';
  for (const child of li.childNodes) {
    if (child.nodeType === 1 && child.tagName === 'INPUT' && child.type === 'checkbox') {
      prefix += checkbox.checked ? '[x] ' : '[ ] ';
      continue;
    }
    if (child.nodeType === 1 && /^(UL|OL)$/.test(child.tagName)) {
      // 嵌套列表：先记住，后面单独缩进
      inner += '\n' + nodeToMd(child, null);
      continue;
    }
    if (child.nodeType === 1 && child.tagName === 'P') {
      inner += elToMd(child);
      continue;
    }
    if (child.nodeType === 3) {
      inner += escapeInline(child.textContent);
    } else if (child.nodeType === 1) {
      inner += nodeToMd(child, null);
    }
  }

  // 去掉首尾空白：marked 生成的 <li>文本</li> 里文本常带前导空格
  // （如 <li><input> 待办</li> 的文本节点是 " 待办"），不 trim 会双空格。
  inner = inner.replace(/^[ \t]+|[ \t]+$/g, '');

  const nested = inner.startsWith('\n') ? inner.slice(1) : inner;
  if (!nested) {
    // 空列表项：不要 trim 掉 prefix 的尾空格
    return prefix.replace(/\s+$/, '');
  }

  // 缩进宽度：无序列表是 "- " 两格，有序列表要按 "1. " 的实际宽度。
  // 早期版本统一用两格，导致 "1. 父\n  1. 子" 被还原成 "1. 父\n  1. 子"
  // 时 numbered list 嵌套失效（marked 要求 3 空格才算子项）。
  const indent = ordered ? ' '.repeat(String(index + 1).length + 2) : '  ';

  const lines = nested.split('\n');
  const first = prefix + lines[0];
  const rest = lines.slice(1).map(l => (l ? indent + l : ''));
  return [first].concat(rest).join('\n');
}

function tableToMd(table) {
  const rows = [...table.querySelectorAll('tr')];
  if (!rows.length) return '';
  // 单元格里的 <br> 必须换成空格：单元格是单行的，<br> 若转成换行
  // 会让表格行断裂，整个表格就坏了。
  const cellText = (cell) => {
    let s = '';
    for (const child of cell.childNodes) {
      if (child.nodeType === 3) s += child.textContent;
      else if (child.nodeType === 1) {
        s += child.tagName === 'BR' ? ' ' : (child.textContent || '');
      }
    }
    return s.replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();
  };

  const matrix = rows.map(tr =>
    [...tr.children].filter(c => /^(TD|TH)$/.test(c.tagName)).map(cellText)
  );
  const cols = Math.max(...matrix.map(r => r.length));
  const pad = (r) => {
    const copy = r.slice();
    while (copy.length < cols) copy.push('');
    return copy;
  };

  const lines = [];
  const header = pad(matrix[0]);
  lines.push('| ' + header.join(' | ') + ' |');
  lines.push('| ' + header.map(() => '---').join(' | ') + ' |');
  for (let i = 1; i < matrix.length; i++) {
    lines.push('| ' + pad(matrix[i]).join(' | ') + ' |');
  }
  return lines.join('\n');
}

/**
 * 把预览区的一个顶层元素转回 Markdown。
 * 这是本模块的核心：DOM → 源码。
 */
export function elementToMarkdown(el, tokenType) {
  // 标题：<h1>文本</h1> → # 文本
  if (/^H[1-6]$/.test(el.tagName)) {
    const level = el.tagName[1];
    const inner = elToMd(el).trim();
    return '#'.repeat(level) + ' ' + inner;
  }
  // 段落
  if (el.tagName === 'P') {
    return elToMd(el).trim();
  }
  return nodeToMd(el, null).trim();
}

/* ============ 3. 挂载到 DOM ============ */

/**
 * 给预览区的每个顶层元素打上 data-block 索引，
 * 让输入事件能定位到它对应源码里的哪一段。
 */
export function annotateBlocks(previewEl, blockCount) {
  const children = [...previewEl.children];
  for (let i = 0; i < children.length; i++) {
    children[i].dataset.block = String(i);
    // contenteditable 区域内不保留浏览器自带的 spellcheck 红线
    children[i].spellcheck = false;
  }
  return children.length;
}