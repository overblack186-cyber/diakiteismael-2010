// Rendu Markdown sûr (sans dépendance). Tout le texte est échappé AVANT d'être
// mis en forme : une réponse de modèle ne peut pas injecter de HTML ou de script.
// Fonction pure (sans DOM) : testée dans tests/js/markdown.test.mjs.

const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ESC[c]);

const KEYWORDS = new Set(("if else elif for while do return function def class import from export const let var new try catch " +
  "except finally raise throw async await yield with as in of is not and or pass break continue switch case default " +
  "public private protected static void int float double bool boolean string char struct enum interface extends " +
  "implements lambda None True False null true false undefined this self super fn pub mut use mod impl match where " +
  "select insert update delete create table into values set join on group order by limit package func go defer").split(" "));


const HASH_LANGS = new Set(["python", "py", "sh", "bash", "shell", "zsh", "yaml", "yml", "toml", "ruby", "rb", "r", "ps1", "powershell", "perl", "dockerfile", "makefile", "ini", "conf"]);
const DASH_LANGS = new Set(["sql", "lua", "haskell", "hs"]);

/** Coloration syntaxique légère, appliquée jeton par jeton sur le texte brut puis échappée. */
export function highlight(code, lang = "") {
  const l = lang.toLowerCase();
  const comment = HASH_LANGS.has(l) ? "#[^\\n]*" : DASH_LANGS.has(l) ? "--[^\\n]*" : "\\/\\*[\\s\\S]*?\\*\\/|\\/\\/[^\\n]*";
  const re = new RegExp(`(${comment})|("(?:\\\\.|[^"\\\\\\n])*"|'(?:\\\\.|[^'\\\\\\n])*'|\`(?:\\\\.|[^\`\\\\])*\`)|\\b(\\d+(?:\\.\\d+)?)\\b|([A-Za-z_][A-Za-z0-9_]*)`, "g");
  let out = "", last = 0, m;
  while ((m = re.exec(code))) {
    out += escapeHtml(code.slice(last, m.index));
    if (m[1]) out += `<span class="tok-c">${escapeHtml(m[1])}</span>`;
    else if (m[2]) out += `<span class="tok-s">${escapeHtml(m[2])}</span>`;
    else if (m[3]) out += `<span class="tok-n">${m[3]}</span>`;
    else out += KEYWORDS.has(m[4]) ? `<span class="tok-k">${m[4]}</span>` : m[4];
    last = re.lastIndex;
  }
  return out + escapeHtml(code.slice(last));
}

function safeUrl(url) {
  const u = url.trim();
  return /^(https?:\/\/|mailto:)/i.test(u) ? u : null;
}

export function inline(text) {
  const codes = [];
  let s = text.replace(/`([^`\n]+)`/g, (_, c) => { codes.push(c); return `\u0000${codes.length - 1}\u0000`; });
  s = escapeHtml(s);
  s = s.replace(/\[([^\]]+)\]\(((?:[^()\s]|\([^()\s]*\))+)\)/g, (all, label, url) => {
    const safe = safeUrl(url.replace(/&amp;/g, "&"));
    return safe ? `<a href="${escapeHtml(safe)}" target="_blank" rel="noopener noreferrer">${label}</a>` : label;
  });
  s = s.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, (all, pre, url) => `${pre}<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`);
  s = s.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>").replace(/__([^_\n]+)__/g, "<strong>$1</strong>");
  s = s.replace(/(^|[^*\w])\*([^*\n]+)\*(?!\*)/g, "$1<em>$2</em>").replace(/(^|[^_\w])_([^_\n]+)_(?!\w)/g, "$1<em>$2</em>");
  s = s.replace(/~~([^~\n]+)~~/g, "<del>$1</del>");
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${escapeHtml(codes[+i])}</code>`);
}

function renderCode(lang, code, closed) {
  const label = escapeHtml(lang || "code");
  return `<div class="codeblock" data-closed="${closed}"><div class="codeblock-head"><span>${label}</span>` +
    `<button class="icon-btn sm" data-copy-code title="Copier le code" aria-label="Copier le code"></button></div>` +
    `<pre><code>${highlight(code, lang)}</code></pre></div>`;
}

function renderTable(lines) {
  const cells = (l) => l.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
  const head = cells(lines[0]);
  const rows = lines.slice(2).map(cells);
  return `<table><thead><tr>${head.map((h) => `<th>${inline(h)}</th>`).join("")}</tr></thead><tbody>` +
    rows.map((r) => `<tr>${head.map((_, i) => `<td>${inline(r[i] ?? "")}</td>`).join("")}</tr>`).join("") + "</tbody></table>";
}

function renderBlocks(text) {
  const lines = text.split("\n");
  const out = [];
  let i = 0;
  const isList = (l) => /^\s*([-*+]|\d+[.)])\s+/.test(l);
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    let m;
    if ((m = line.match(/^(#{1,4})\s+(.*)$/))) { out.push(`<h${m[1].length}>${inline(m[2])}</h${m[1].length}>`); i++; continue; }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { out.push("<hr>"); i++; continue; }
    if (/^\s*>/.test(line)) {
      const quote = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) quote.push(lines[i++].replace(/^\s*>\s?/, ""));
      out.push(`<blockquote>${renderBlocks(quote.join("\n"))}</blockquote>`);
      continue;
    }
    if (line.includes("|") && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1]) && lines[i + 1].includes("-")) {
      const tbl = [];
      while (i < lines.length && lines[i].includes("|")) tbl.push(lines[i++]);
      out.push(renderTable(tbl));
      continue;
    }
    if (isList(line)) {
      out.push(renderList(lines, i, (next) => { i = next; }));
      continue;
    }
    const para = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,4})\s/.test(lines[i]) && !isList(lines[i]) && !/^\s*>/.test(lines[i])) para.push(lines[i++]);
    out.push(`<p>${para.map(inline).join("<br>")}</p>`);
  }
  return out.join("");
}

function renderList(lines, start, setIndex) {
  const indentOf = (l) => l.match(/^\s*/)[0].length;
  const base = indentOf(lines[start]);
  const ordered = /^\s*\d+[.)]/.test(lines[start]);
  const sameKind = (l) => (ordered ? /^\s*\d+[.)]\s+/ : /^\s*[-*+]\s+/).test(l);
  const items = [];
  let i = start;
  while (i < lines.length) {
    const l = lines[i];
    if (!l.trim()) {
      // ligne vide : la liste continue seulement si la suite est un élément du même type
      const next = lines[i + 1];
      if (next !== undefined && ((indentOf(next) === base && sameKind(next)) || (indentOf(next) > base && items.length))) { i++; continue; }
      break;
    }
    const ind = indentOf(l);
    const m = l.match(/^\s*([-*+]|\d+[.)])\s+(.*)$/);
    if (m && ind === base && !sameKind(l)) break;
    if (m && ind === base) { items.push({ text: m[2], sub: [] }); i++; continue; }
    if (ind > base && items.length) { items.at(-1).sub.push(l); i++; continue; }
    break;
  }
  setIndex(i);
  const tag = ordered ? "ol" : "ul";
  const body = items.map((it) => {
    const sub = it.sub.length ? renderBlocks(dedent(it.sub).join("\n")) : "";
    return `<li>${inline(it.text)}${sub}</li>`;
  }).join("");
  return `<${tag}>${body}</${tag}>`;
}

function dedent(lines) {
  const min = Math.min(...lines.filter((l) => l.trim()).map((l) => l.match(/^\s*/)[0].length));
  return lines.map((l) => l.slice(min));
}

/** Convertit du Markdown en HTML sûr. Les blocs de code non refermés (streaming) sont acceptés. */
export function renderMarkdown(src) {
  const text = String(src ?? "").replace(/\r\n/g, "\n");
  const parts = [];
  const fence = /^([ \t]*)(```|~~~)([^\n]*)\n/gm;
  let last = 0, m;
  while ((m = fence.exec(text))) {
    parts.push(renderBlocks(text.slice(last, m.index)));
    const marker = m[2];
    const lang = m[3].trim().split(/\s+/)[0];
    const startCode = fence.lastIndex;
    const endRe = new RegExp(`^[ \\t]*${marker}[ \\t]*$`, "gm");
    endRe.lastIndex = startCode;
    const end = endRe.exec(text);
    if (!end) {
      parts.push(renderCode(lang, text.slice(startCode), false));
      last = text.length;
      fence.lastIndex = text.length;
      break;
    }
    parts.push(renderCode(lang, text.slice(startCode, end.index).replace(/\n$/, ""), true));
    last = endRe.lastIndex;
    fence.lastIndex = last;
  }
  if (last < text.length) parts.push(renderBlocks(text.slice(last)));
  return parts.join("");
}

/** Texte brut (pour la synthèse vocale) : retire la syntaxe Markdown et les blocs de code. */
export function toSpeech(src) {
  return String(src ?? "")
    .replace(/```[\s\S]*?(```|$)/g, " (bloc de code) ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/[*_~>|#]/g, "")
    .replace(/https?:\/\/\S+/g, "lien")
    .replace(/\n{2,}/g, ". ")
    .replace(/\s+/g, " ")
    .trim();
}
