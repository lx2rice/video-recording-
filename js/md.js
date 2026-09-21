// A small Markdown renderer for model output. Everything is HTML-escaped first,
// so nothing the model writes can inject markup.

function escapeHtml(s) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function inline(text) {
  return escapeHtml(text)
    .replace(/`([^`]+)`/g, (_, code) => `<code>${code}</code>`)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
    .replace(/(^|\s)(https?:\/\/[^\s<]+)/g, '$1<a href="$2" target="_blank" rel="noopener">$2</a>');
}

export function renderMarkdown(src) {
  const lines = (src || '').split('\n');
  const out = [];
  let list = null;           // 'ul' | 'ol'
  let inCode = false;
  let para = [];
  let table = null;

  const flushPara = () => {
    if (para.length) {
      out.push(`<p>${inline(para.join(' '))}</p>`);
      para = [];
    }
  };
  const closeList = () => {
    if (list) { out.push(`</${list}>`); list = null; }
  };
  const closeTable = () => {
    if (table) { out.push('</tbody></table>'); table = null; }
  };
  const closeAll = () => { flushPara(); closeList(); closeTable(); };

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');

    if (/^```/.test(line)) {
      closeAll();
      out.push(inCode ? '</code></pre>' : '<pre><code>');
      inCode = !inCode;
      continue;
    }
    if (inCode) { out.push(`${escapeHtml(raw)}\n`); continue; }

    if (!line.trim()) { closeAll(); continue; }

    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      closeAll();
      const level = Math.min(6, heading[1].length + 2);
      out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      continue;
    }

    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) { closeAll(); out.push('<hr />'); continue; }

    if (/^\s*>\s?/.test(line)) {
      closeAll();
      out.push(`<blockquote>${inline(line.replace(/^\s*>\s?/, ''))}</blockquote>`);
      continue;
    }

    // Tables: a header row followed by a |---|---| separator.
    if (/^\s*\|.*\|\s*$/.test(line)) {
      const cells = line.trim().slice(1, -1).split('|').map((c) => c.trim());
      if (!table && cells.every((c) => /^:?-{2,}:?$/.test(c))) continue;   // stray separator
      if (!table) {
        flushPara(); closeList();
        table = true;
        out.push(`<table><thead><tr>${cells.map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>`);
      } else if (!cells.every((c) => /^:?-{2,}:?$/.test(c))) {
        out.push(`<tr>${cells.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`);
      }
      continue;
    }
    closeTable();

    const ordered = line.match(/^\s*\d+[.)]\s+(.*)$/);
    const bullet = line.match(/^\s*[-*•]\s+(.*)$/);
    if (ordered || bullet) {
      flushPara();
      const want = ordered ? 'ol' : 'ul';
      if (list !== want) { closeList(); out.push(`<${want}>`); list = want; }
      out.push(`<li>${inline((ordered || bullet)[1])}</li>`);
      continue;
    }
    closeList();

    para.push(line.trim());
  }

  if (inCode) out.push('</code></pre>');
  closeAll();
  return out.join('\n');
}
