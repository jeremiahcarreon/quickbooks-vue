/**
 * Small XML helpers for the raw qbXML console: a tokenizer for syntax
 * highlighting, a pretty printer and a well-formedness check. XSD validity is
 * decided by the server (libxml2); these only give fast local feedback.
 */

export type XmlTokenKind =
  'text' | 'tag' | 'attr' | 'value' | 'comment' | 'pi' | 'cdata' | 'punct' | 'entity';

export interface XmlToken {
  kind: XmlTokenKind;
  text: string;
}

/** Split XML into tokens. Never throws; malformed input is returned as text. */
export function tokenizeXml(src: string): XmlToken[] {
  const out: XmlToken[] = [];
  let i = 0;
  const push = (kind: XmlTokenKind, text: string) => {
    if (!text) return;
    const last = out[out.length - 1];
    if (last && last.kind === kind && kind === 'text') last.text += text;
    else out.push({ kind, text });
  };
  while (i < src.length) {
    if (src.startsWith('<!--', i)) {
      const end = src.indexOf('-->', i + 4);
      const j = end < 0 ? src.length : end + 3;
      push('comment', src.slice(i, j));
      i = j;
    } else if (src.startsWith('<![CDATA[', i)) {
      const end = src.indexOf(']]>', i);
      const j = end < 0 ? src.length : end + 3;
      push('cdata', src.slice(i, j));
      i = j;
    } else if (src.startsWith('<?', i)) {
      const end = src.indexOf('?>', i);
      const j = end < 0 ? src.length : end + 2;
      push('pi', src.slice(i, j));
      i = j;
    } else if (src[i] === '<') {
      const m = /^<\/?[A-Za-z_][\w.:-]*/.exec(src.slice(i));
      if (!m) {
        push('text', '<');
        i++;
        continue;
      }
      push('punct', m[0].startsWith('</') ? '</' : '<');
      push('tag', m[0].replace(/^<\/?/, ''));
      i += m[0].length;
      // attributes until > or />
      while (i < src.length && src[i] !== '>' && !src.startsWith('/>', i)) {
        const rest = src.slice(i);
        const ws = /^\s+/.exec(rest);
        if (ws) {
          push('text', ws[0]);
          i += ws[0].length;
          continue;
        }
        const attr = /^([A-Za-z_][\w.:-]*)(\s*=\s*)?("[^"]*"?|'[^']*'?)?/.exec(rest);
        if (attr && attr[0]) {
          push('attr', attr[1]!);
          if (attr[2]) push('punct', attr[2]);
          if (attr[3]) push('value', attr[3]);
          i += attr[0].length;
          continue;
        }
        if (src[i] === '<') break;
        push('text', src[i]!);
        i++;
      }
      if (src.startsWith('/>', i)) {
        push('punct', '/>');
        i += 2;
      } else if (src[i] === '>') {
        push('punct', '>');
        i++;
      }
    } else if (src[i] === '&') {
      const m = /^&(#\d+|#x[0-9a-fA-F]+|[A-Za-z]+);/.exec(src.slice(i));
      if (m) {
        push('entity', m[0]);
        i += m[0].length;
      } else {
        push('text', '&');
        i++;
      }
    } else {
      const next = src.slice(i).search(/[<&]/);
      const j = next < 0 ? src.length : i + next;
      push('text', src.slice(i, j));
      i = j;
    }
  }
  return out;
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** HTML with `<span class="xml-<kind>">` per token. */
export function highlightXml(src: string): string {
  return tokenizeXml(src)
    .map((t) =>
      t.kind === 'text'
        ? escapeHtml(t.text)
        : `<span class="xml-${t.kind}">${escapeHtml(t.text)}</span>`,
    )
    .join('');
}

export interface WellFormedResult {
  ok: boolean;
  message?: string;
  line?: number;
}

/** Well-formedness via DOMParser (browser / jsdom). */
export function checkWellFormed(xml: string): WellFormedResult {
  if (!xml.trim()) return { ok: false, message: 'Empty document' };
  if (typeof DOMParser === 'undefined') return { ok: true };
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  const err = doc.getElementsByTagName('parsererror')[0];
  if (!err) {
    const root = doc.documentElement?.nodeName;
    if (root !== 'QBXML')
      return { ok: false, message: `Root element must be QBXML, found ${root}` };
    return { ok: true };
  }
  const text = (err.textContent ?? 'Malformed XML').trim();
  const line = /line(?: number)?\s*(\d+)/i.exec(text);
  return { ok: false, message: text.split('\n')[0], ...(line ? { line: Number(line[1]) } : {}) };
}

/** Re-indent XML (two spaces). Text-only elements stay on one line. */
export function prettyXml(xml: string): string {
  const parts = xml
    .replace(/>\s+</g, '><')
    .trim()
    .split(/(<[^>]+>)/)
    .filter((p) => p !== '');
  const lines: string[] = [];
  let depth = 0;
  for (let k = 0; k < parts.length; k++) {
    const p = parts[k]!;
    const pad = '  '.repeat(depth);
    if (p.startsWith('<?') || p.startsWith('<!')) {
      lines.push(pad + p);
    } else if (p.startsWith('</')) {
      depth = Math.max(0, depth - 1);
      lines.push('  '.repeat(depth) + p);
    } else if (p.startsWith('<') && p.endsWith('/>')) {
      lines.push(pad + p);
    } else if (p.startsWith('<')) {
      const text = parts[k + 1];
      const close = parts[k + 2];
      if (text !== undefined && !text.startsWith('<') && close?.startsWith('</')) {
        lines.push(pad + p + text + close);
        k += 2;
      } else {
        lines.push(pad + p);
        depth++;
      }
    } else {
      lines.push(pad + p.trim());
    }
  }
  return lines.join('\n');
}
