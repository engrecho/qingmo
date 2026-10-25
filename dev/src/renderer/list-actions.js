// 修改当前同级有序列表的编号，保留缩进、续行及嵌套列表。
export function orderedListRange(text, position) {
  const lines = text.split('\n');
  const offsets = []; let offset = 0;
  for (const line of lines) { offsets.push(offset); offset += line.length + 1; }
  const index = lines.findIndex((line, i) => position <= offsets[i] + line.length);
  const current = /^(\s*)(\d+)([.)])(?:\s+|$)/.exec(lines[index] || '');
  if (!current) return null;
  const indent = current[1];
  const inList = line => {
    if (!line.trim()) return false;
    const prefix = /^\s*/.exec(line)[0];
    return prefix.length > indent.length || (prefix === indent && /^\d+[.)](?:\s+|$)/.test(line.slice(indent.length)));
  };
  let first = index, last = index;
  const connected = (at, step) => {
    while (at >= 0 && at < lines.length && !lines[at].trim()) at += step;
    return at >= 0 && at < lines.length && inList(lines[at]);
  };
  while (first > 0 && connected(first - 1, -1)) first--;
  while (last + 1 < lines.length && connected(last + 1, 1)) last++;
  while (first < index && !/^\s*\d+[.)](?:\s+|$)/.test(lines[first])) first++;
  return { from: offsets[first], to: offsets[last] + lines[last].length, indent, start: Number(/\d+/.exec(lines[first].slice(indent.length))[0]), text: lines.slice(first, last + 1).join('\n') };
}
export function renumberList(range, start) {
  if (!Number.isInteger(start) || start < 0 || start > 999999999) throw new Error('请输入 0 到 999999999 之间的整数');
  let number = start;
  return range.text.split('\n').map(line => {
    const match = /^(\s*)(\d+)([.)])(\s+|$)/.exec(line);
    if (!match || match[1] !== range.indent) return line;
    if (number > 999999999) throw new Error('列表编号超出 Markdown 支持的范围');
    return match[1] + number++ + match[3] + match[4] + line.slice(match[0].length);
  }).join('\n');
}
