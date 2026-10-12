// Registre des commandes, palette de commandes et raccourcis clavier.
// Les commandes servent aussi d'actions pour les gestes : une seule source de vérité.
import { icon } from "./icons.js";
import { esc, html } from "./ui.js";

const commands = new Map();
const providers = [];   // fonctions renvoyant des commandes dynamiques (conversations, modèles…)

/**
 * cmd : {id, title, group, icon, keywords, run(), enabled() -> true | "raison", sensitive, shortcut (clé de réglage),
 *        gesture (utilisable comme action de geste, défaut true)}
 */
export function register(cmd) { commands.set(cmd.id, { gesture: true, ...cmd }); }
export function registerProvider(fn) { providers.push(fn); }
export function getCommand(id) { return commands.get(id) || allCommands().find((c) => c.id === id); }
export function staticCommands() { return [...commands.values()]; }
export function allCommands() {
  const dyn = providers.flatMap((p) => { try { return p(); } catch { return []; } });
  return [...commands.values(), ...dyn];
}

export function availability(cmd) {
  if (!cmd.enabled) return true;
  try { return cmd.enabled(); } catch (err) { return err.message; }
}

// -- Recherche approximative --------------------------------------------------
const fold = (s) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

/** Score de correspondance (null si pas de correspondance) et positions à surligner. */
export function fuzzyMatch(query, text) {
  const q = fold(query).replace(/\s+/g, " ").trim();
  if (!q) return { score: 0, positions: [] };
  const t = fold(text);
  const direct = t.indexOf(q);
  if (direct >= 0) {
    const atWord = direct === 0 || /[\s\-_/›]/.test(t[direct - 1]);
    return { score: 100 - direct + (atWord ? 40 : 0) + (direct === 0 ? 20 : 0), positions: [...Array(q.length).keys()].map((i) => direct + i) };
  }
  // Sous-séquence « intelligente » : chaque lettre doit suivre la précédente ou commencer un mot
  // (ex. « nouv conv » → Nouvelle conversation), pour éviter les correspondances dispersées.
  const wordStart = (i) => i === 0 || /[\s\-_/›:]/.test(t[i - 1]);
  let ti = 0, score = 0, prev = -2;
  const positions = [];
  for (const ch of q.replace(/ /g, "")) {
    let found = -1;
    for (let i = t.indexOf(ch, ti); i >= 0; i = t.indexOf(ch, i + 1)) {
      if (i === prev + 1 || wordStart(i)) { found = i; break; }
    }
    if (found < 0) return null;
    score += found === prev + 1 ? 6 : 8;
    positions.push(found);
    prev = found;
    ti = found + 1;
  }
  return { score: score - (t.length - q.length) * 0.05, positions };
}

export function filterCommands(query, list) {
  const out = [];
  for (const cmd of list) {
    const m = fuzzyMatch(query, cmd.title);
    const k = !m && cmd.keywords ? fuzzyMatch(query, cmd.keywords) : null;
    if (m || k) out.push({ cmd, score: m ? m.score : k.score - 80, positions: m ? m.positions : [] });
  }
  return out.sort((a, b) => b.score - a.score);
}

function highlightLabel(text, positions) {
  if (!positions.length) return esc(text);
  const set = new Set(positions);
  return [...text].map((ch, i) => (set.has(i) ? `<mark>${esc(ch)}</mark>` : esc(ch))).join("");
}

// -- Raccourcis ------------------------------------------------------------------
export function eventToShortcut(e) {
  const parts = [];
  if (e.ctrlKey || e.metaKey) parts.push("Ctrl");
  if (e.altKey) parts.push("Alt");
  if (e.shiftKey) parts.push("Shift");
  let key = e.key;
  if (["Control", "Shift", "Alt", "Meta"].includes(key)) return null;
  if (key === " ") key = "Space";
  if (key.length === 1) key = key.toUpperCase();
  parts.push(key);
  return parts.join("+");
}

export function matchShortcut(e, spec) {
  return !!spec && eventToShortcut(e) === spec;
}

export function isTyping(target) {
  return target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT" || target.isContentEditable);
}

// -- Palette -----------------------------------------------------------------------
let paletteEl = null;

export function openPalette({ initial = "", onRun } = {}) {
  if (paletteEl) { paletteEl.querySelector("input").focus(); return; }
  const previous = document.activeElement;
  const scrim = html(`<div class="palette-scrim"><div class="palette" role="dialog" aria-label="Commandes rapides">
    <div class="palette-input">${icon("command", 17)}<input placeholder="Rechercher une commande…" aria-label="Rechercher une commande"
      autocomplete="off" spellcheck="false"><kbd>Échap</kbd></div>
    <div class="palette-list scroll" role="listbox"></div>
    <div class="palette-foot"><span><kbd>↑</kbd> <kbd>↓</kbd> naviguer</span><span><kbd>Entrée</kbd> exécuter</span><span>Filtrage local, sans réseau</span></div>
  </div></div>`);
  const input = scrim.querySelector("input");
  const list = scrim.querySelector(".palette-list");
  let results = [];
  let active = 0;

  const render = () => {
    const all = allCommands().filter((c) => c.palette !== false);
    const q = input.value.trim();
    results = q ? filterCommands(q, all).slice(0, 60) : all.filter((c) => !c.dynamic).map((cmd) => ({ cmd, positions: [] }));
    active = Math.min(active, Math.max(0, results.length - 1));
    list.innerHTML = "";
    if (!results.length) {
      list.append(html(`<div class="empty" style="padding:28px">Aucune commande ne correspond à « ${esc(q)} ».</div>`));
      return;
    }
    let group = null;
    results.forEach(({ cmd, positions }, i) => {
      if (!q && cmd.group !== group) {
        group = cmd.group;
        list.append(html(`<div class="palette-group">${esc(group)}</div>`));
      }
      const avail = availability(cmd);
      const item = html(`<div class="palette-item ${i === active ? "active" : ""} ${avail === true ? "" : "disabled"}" role="option"
        aria-selected="${i === active}" aria-disabled="${avail !== true}">
        ${icon(cmd.icon || "zap", 16)}<span class="pi-label">${highlightLabel(cmd.title, positions)}</span>
        ${avail === true ? (cmd.hint ? `<kbd>${esc(cmd.hint)}</kbd>` : "") : `<span class="pi-reason">${esc(avail)}</span>`}</div>`);
      item.onmouseenter = () => { active = i; mark(); };
      item.onclick = () => run(i);
      list.append(item);
    });
  };
  const mark = () => {
    list.querySelectorAll(".palette-item").forEach((el, i) => {
      el.classList.toggle("active", i === active);
      el.setAttribute("aria-selected", i === active);
    });
    list.querySelectorAll(".palette-item")[active]?.scrollIntoView({ block: "nearest" });
  };
  const close = () => {
    scrim.remove();
    paletteEl = null;
    previous?.focus?.();
  };
  const run = (i) => {
    const r = results[i];
    if (!r) return;
    if (availability(r.cmd) !== true) return;
    close();
    onRun ? onRun(r.cmd) : r.cmd.run();
  };
  input.addEventListener("input", () => { active = 0; render(); });
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") { e.preventDefault(); active = Math.min(results.length - 1, active + 1); mark(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); active = Math.max(0, active - 1); mark(); }
    else if (e.key === "Enter") { e.preventDefault(); run(active); }
    else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); }
  });
  scrim.addEventListener("mousedown", (e) => { if (e.target === scrim) close(); });
  document.body.append(scrim);
  paletteEl = scrim;
  input.value = initial;
  render();
  input.focus();
}

export function paletteOpen() { return !!paletteEl; }
