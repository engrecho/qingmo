import { markdownLanguage } from '@codemirror/lang-markdown';

// 使用 Markdown 语法树，避免把代码块中的 # 误识别为标题。
export function headings(text) {
  const result = [];
  markdownLanguage.parser.parse(text).iterate({ enter(node) {
    const match = /^(?:ATXHeading|SetextHeading)([1-6])$/.exec(node.name);
    if (!match) return;
    const raw = text.slice(node.from, node.to);
    const label = node.name.startsWith('ATX')
      ? raw.replace(/^ {0,3}#{1,6}(?:[ \t]+|$)/, '').replace(/[ \t]+#+[ \t]*$/, '')
      : raw.replace(/\n[ \t]*[=-]+[ \t]*$/, '').replace(/\n/g, ' ');
    result.push({ from: node.from, level: Number(match[1]), label });
  }});
  return result;
}
