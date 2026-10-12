// Primitives d'interface : échappement, création d'éléments, menus, modales, notifications.
import { icon } from "./icons.js";

export function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

/** Crée un élément à partir de HTML (le HTML fourni doit déjà être échappé). */
export function html(markup) {
  const t = document.createElement("template");
  t.innerHTML = markup.trim();
  return t.content.firstElementChild;
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function formatDate(ts) {
  const d = new Date(ts * 1000);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return d.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
  const diff = (now - d) / 86400000;
  if (diff < 6) return d.toLocaleDateString("fr-FR", { weekday: "long" });
  return d.toLocaleDateString("fr-FR", { day: "numeric", month: "short", year: d.getFullYear() !== now.getFullYear() ? "numeric" : undefined });
}

export function formatSize(bytes) {
  if (bytes == null) return "";
  if (bytes < 1024) return `${bytes} o`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(0)} Ko`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} Mo`;
  return `${(bytes / 1024 ** 3).toFixed(1)} Go`;
}

export function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

// -- Notifications ------------------------------------------------------------
export function toast(message, { kind = "info", action, duration = 4200 } = {}) {
  const ic = kind === "err" ? "circle-alert" : kind === "ok" ? "circle-check" : "info";
  const el = html(`<div class="toast ${kind}">${icon(ic, 16)}<span>${esc(message)}</span></div>`);
  if (action) {
    const b = html(`<button class="btn sm">${esc(action.label)}</button>`);
    b.onclick = () => { action.run(); el.remove(); };
    el.append(b);
  }
  document.getElementById("toasts").append(el);
  setTimeout(() => el.remove(), action ? duration * 2 : duration);
}

// -- Popovers / menus -------------------------------------------------------------
let openPopover = null;

export function closePopover() {
  if (openPopover) {
    const p = openPopover;
    openPopover = null;
    p.cleanup();
  }
}

/**
 * Affiche un popover ancré à un élément ou à une position {x, y}.
 * Fermeture : clic extérieur, Échap, ou appel à closePopover().
 */
export function popover(anchor, content, { align = "start", className = "", placement = "bottom" } = {}) {
  closePopover();
  const el = document.createElement("div");
  el.className = `popover ${className}`;
  el.setAttribute("role", "menu");
  el.append(content);
  document.body.append(el);
  const r = anchor instanceof Element ? anchor.getBoundingClientRect() : { left: anchor.x, right: anchor.x, top: anchor.y, bottom: anchor.y, width: 0 };
  const w = el.offsetWidth, h = el.offsetHeight;
  let x = align === "end" ? r.right - w : align === "center" ? r.left + r.width / 2 - w / 2 : r.left;
  let y = placement === "top" ? r.top - h - 6 : r.bottom + 6;
  if (y + h > innerHeight - 8) y = Math.max(8, r.top - h - 6);
  if (y < 8) y = 8;
  x = Math.min(Math.max(8, x), innerWidth - w - 8);
  el.style.left = `${x}px`;
  el.style.top = `${y}px`;
  const onDown = (e) => { if (!el.contains(e.target) && !(anchor instanceof Element && anchor.contains(e.target))) closePopover(); };
  const onKey = (e) => {
    if (e.key === "Escape") { e.stopPropagation(); closePopover(); if (anchor instanceof Element) anchor.focus?.(); }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      const items = [...el.querySelectorAll("button:not(:disabled)")];
      if (!items.length) return;
      e.preventDefault();
      const i = items.indexOf(document.activeElement);
      items[(i + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length].focus();
    }
  };
  setTimeout(() => document.addEventListener("mousedown", onDown), 0);
  document.addEventListener("keydown", onKey, true);
  openPopover = { el, cleanup: () => { el.remove(); document.removeEventListener("mousedown", onDown); document.removeEventListener("keydown", onKey, true); } };
  return el;
}

/**
 * Menu d'actions. items : [{label, icon, run, disabled (bool|string raison), danger, hint, checked} | "sep" | {head}]
 * Un élément désactivé affiche sa raison en infobulle.
 */
export function menu(anchor, items, opts = {}) {
  const box = document.createElement("div");
  for (const item of items) {
    if (!item) continue;
    if (item === "sep") { box.append(html('<div class="menu-sep"></div>')); continue; }
    if (item.head) { box.append(html(`<div class="menu-head">${esc(item.head)}</div>`)); continue; }
    if (item.note) { box.append(html(`<div class="menu-note">${esc(item.note)}</div>`)); continue; }
    const disabled = !!item.disabled;
    const b = html(`<button class="menu-item ${item.danger ? "danger" : ""} ${item.checked ? "checked" : ""}" role="menuitem" ${disabled ? "disabled" : ""}
      title="${esc(typeof item.disabled === "string" ? item.disabled : item.title || "")}">
      ${item.icon ? icon(item.icon, 16) : ""}<span class="mi-label">${esc(item.label)}</span>
      ${item.checked ? `<span class="mi-check">${icon("check", 15)}</span>` : ""}
      ${item.hint ? `<span class="mi-hint">${esc(item.hint)}</span>` : ""}</button>`);
    b.onclick = () => { closePopover(); item.run?.(); };
    box.append(b);
  }
  const el = popover(anchor, box, opts);
  el.querySelector("button:not(:disabled)")?.focus();
  return el;
}

// -- Modales ------------------------------------------------------------------
export function modal({ title, body, actions = [], wide = false, onClose }) {
  const scrim = html(`<div class="modal-scrim"><div class="modal ${wide ? "wide" : ""}" role="dialog" aria-modal="true" aria-label="${esc(title)}">
    <div class="modal-head"><h2>${esc(title)}</h2><button class="icon-btn sm" data-close aria-label="Fermer">${icon("x", 16)}</button></div>
    <div class="modal-body"></div><div class="modal-foot"></div></div></div>`);
  const bodyEl = scrim.querySelector(".modal-body");
  if (typeof body === "string") bodyEl.innerHTML = body; else if (body) bodyEl.append(body);
  const foot = scrim.querySelector(".modal-foot");
  const previous = document.activeElement;
  const close = (value) => {
    scrim.remove();
    document.removeEventListener("keydown", onKey, true);
    previous?.focus?.();
    onClose?.(value);
  };
  for (const a of actions) {
    const b = html(`<button class="btn ${a.kind || ""}">${esc(a.label)}</button>`);
    b.onclick = async () => {
      if (a.run) {
        const keep = await a.run(bodyEl, b);
        if (keep === false) return;
      }
      close(a.value);
    };
    foot.append(b);
  }
  if (!actions.length) foot.remove();
  const onKey = (e) => {
    if (e.key === "Escape") { e.stopPropagation(); close(undefined); }
    if (e.key === "Enter" && !e.shiftKey && e.target.tagName === "INPUT") {
      e.preventDefault();
      foot.querySelector(".btn.primary, .btn.danger.solid")?.click();
    }
    if (e.key === "Tab") {
      const f = [...scrim.querySelectorAll("button, input, select, textarea, [tabindex]")].filter((x) => !x.disabled);
      if (!f.length) return;
      if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f.at(-1).focus(); }
      else if (!e.shiftKey && document.activeElement === f.at(-1)) { e.preventDefault(); f[0].focus(); }
    }
  };
  document.addEventListener("keydown", onKey, true);
  scrim.querySelector("[data-close]").onclick = () => close(undefined);
  scrim.addEventListener("mousedown", (e) => { if (e.target === scrim) close(undefined); });
  document.body.append(scrim);
  (scrim.querySelector("input, textarea, select") || foot.querySelector(".primary, .solid") || scrim.querySelector("[data-close]"))?.focus();
  return { el: scrim, body: bodyEl, close };
}

export function confirmDialog({ title, message, confirm = "Confirmer", danger = false }) {
  return new Promise((resolve) => {
    modal({
      title, body: `<p>${esc(message)}</p>`,
      actions: [{ label: "Annuler", value: false }, { label: confirm, kind: danger ? "danger solid" : "primary", value: true }],
      onClose: (v) => resolve(!!v),
    });
  });
}

export function promptDialog({ title, label, value = "", placeholder = "", confirm = "Enregistrer", multiline = false, help = "" }) {
  return new Promise((resolve) => {
    const field = multiline
      ? `<textarea class="textarea" rows="5" placeholder="${esc(placeholder)}">${esc(value)}</textarea>`
      : `<input class="input" value="${esc(value)}" placeholder="${esc(placeholder)}">`;
    let result = null;
    modal({
      title,
      body: `<div class="field"><label>${esc(label)}</label>${field}${help ? `<div class="help">${esc(help)}</div>` : ""}</div>`,
      actions: [
        { label: "Annuler" },
        { label: confirm, kind: "primary", run: (body) => {
          const v = body.querySelector("input, textarea").value.trim();
          if (!v) { body.querySelector("input, textarea").focus(); return false; }
          result = v;
        } },
      ],
      onClose: () => resolve(result),
    });
    const input = document.querySelector(".modal input, .modal textarea");
    input?.select?.();
  });
}

export function switchHtml(checked, attrs = "") {
  return `<label class="switch"><input type="checkbox" ${checked ? "checked" : ""} ${attrs}><span class="track"></span></label>`;
}

/** Copie dans le presse-papiers avec retour visuel. */
export async function copyText(text, btn) {
  try {
    await navigator.clipboard.writeText(text);
    if (btn) {
      const prev = btn.innerHTML;
      btn.innerHTML = icon("check", 15);
      setTimeout(() => { btn.innerHTML = prev; }, 1200);
    } else toast("Copié dans le presse-papiers", { kind: "ok" });
  } catch {
    toast("Impossible d'accéder au presse-papiers.", { kind: "err" });
  }
}
