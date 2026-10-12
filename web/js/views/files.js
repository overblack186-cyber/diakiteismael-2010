// Vue « Fichiers » : dossiers autorisés, navigation, informations et actions compatibles.
import { api } from "../api.js";
import { icon } from "../icons.js";
import { state } from "../store.js";
import { confirmDialog, esc, formatDate, formatSize, html, menu, modal, toast } from "../ui.js";

const KIND_ICON = { folder: "folder", text: "file-text", image: "file-image", unsupported: "file" };

/** Demande un chemin : saisie manuelle ou sélecteur natif de Windows (si disponible). */
export function pickPath(kind, title, help = "") {
  return new Promise((resolve) => {
    let result = null;
    const native = !!state.tk;
    const m = modal({
      title,
      body: `<div class="field"><label>${kind === "folder" ? "Chemin du dossier" : "Chemin du fichier"}</label>
        <div class="row"><input class="input grow" data-path placeholder="${kind === "folder" ? "C:\\Users\\vous\\Documents\\Projet" : "C:\\Users\\vous\\Documents\\notes.txt"}">
        <button class="btn" data-browse ${native ? "" : 'disabled title="Sélecteur natif indisponible (Tkinter absent) : saisissez le chemin."'}>${icon("folder-open", 15)}Parcourir…</button></div>
        ${help ? `<div class="help">${esc(help)}</div>` : ""}</div>`,
      actions: [{ label: "Annuler" }, { label: "Valider", kind: "primary", run: (body) => {
        const v = body.querySelector("[data-path]").value.trim().replace(/^"|"$/g, "");
        if (!v) { body.querySelector("[data-path]").focus(); return false; }
        result = v;
      } }],
      onClose: () => resolve(result),
    });
    m.body.querySelector("[data-browse]").onclick = async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      try {
        const { path } = await api.post("/api/system/pick", { kind });
        if (path) m.body.querySelector("[data-path]").value = path;
      } catch (err) { toast(err.message, { kind: "err" }); }
      btn.disabled = false;
    };
  });
}

export async function render(container, params, ctx) {
  let current = params.path || null;
  container.innerHTML = `
    <header class="topbar"><span class="topbar-title">Fichiers</span><span class="spacer"></span>
      <button class="btn sm" data-addfolder>${icon("plus", 15)}Autoriser un dossier</button></header>
    <div class="page scroll"><div class="page-inner" style="max-width:1100px">
      <div class="section-title">${icon("shield-check", 15)}Dossiers autorisés</div>
      <div class="muted small mb-8">NexaAI ne peut lire (et modifier, si vous l'autorisez) que ces dossiers et leur contenu. Aucun accès au reste du disque.</div>
      <div class="list" data-folders></div>
      <div class="section split" data-browser></div>
    </div></div>`;
  const $ = (s) => container.querySelector(s);

  async function loadFolders() {
    const { items } = await api.get("/api/files/folders");
    const box = $("[data-folders]");
    box.innerHTML = "";
    if (!items.length) {
      box.innerHTML = `<div class="empty" style="padding:28px">${icon("folder", 28)}<h3>Aucun dossier autorisé</h3>
        <p>Autorisez un dossier (par exemple Documents\\NexaAI) pour parcourir vos fichiers, les joindre aux conversations ou les modifier dans Création et code.</p>
        <button class="btn primary" data-add2>${icon("plus", 15)}Autoriser un dossier</button></div>`;
      box.querySelector("[data-add2]").onclick = addFolder;
      $("[data-browser]").innerHTML = "";
      return items;
    }
    for (const f of items) {
      const el = html(`<div class="list-item clickable ${current && current.startsWith(f.path) ? "" : ""}"><span class="li-icon">${icon("folder", 17)}</span>
        <div class="li-main"><div class="li-title mono" style="font-size:13px">${esc(f.path)}</div></div>
        <span class="badge ${f.access === "read_write" ? "warning" : ""}">${f.access === "read_write" ? "lecture et écriture" : "lecture seule"}</span>
        <div class="li-actions"><button class="icon-btn sm" data-remove title="Retirer l'autorisation" aria-label="Retirer l'autorisation">${icon("x", 15)}</button></div></div>`);
      el.onclick = async (e) => {
        if (e.target.closest("[data-remove]")) {
          const ok = await confirmDialog({ title: "Retirer l'autorisation ?", message: `NexaAI n'aura plus accès à ${f.path}. Les fichiers ne sont pas supprimés.`, confirm: "Retirer" });
          if (!ok) return;
          await api.post("/api/files/folders/remove", { path: f.path });
          if (current?.startsWith(f.path)) current = null;
          return init();
        }
        open(f.path);
      };
      box.append(el);
    }
    return items;
  }

  async function addFolder() {
    const path = await pickPath("folder", "Autoriser un dossier", "Choisissez un dossier précis (pas un disque entier).");
    if (!path) return;
    modal({
      title: "Niveau d'accès",
      body: `<p>Que peut faire NexaAI dans <span class="mono">${esc(path)}</span> ?</p>
        <label class="row mb-8"><input type="radio" name="acc" value="read" checked> Lecture seule (recommandé)</label>
        <label class="row"><input type="radio" name="acc" value="read_write"> Lecture et écriture — chaque écriture sauvegarde la version précédente et demande une confirmation.</label>`,
      actions: [{ label: "Annuler" }, { label: "Autoriser", kind: "primary", run: async (body) => {
        try {
          await api.post("/api/files/folders", { path, access: body.querySelector("input[name=acc]:checked").value });
          toast("Dossier autorisé.", { kind: "ok" });
          current = null;
          init();
        } catch (err) { toast(err.message, { kind: "err" }); return false; }
      } }],
    });
  }

  async function open(path) {
    current = path;
    const browser = $("[data-browser]");
    browser.innerHTML = '<div class="spinner"></div>';
    let data;
    try { data = await api.get(`/api/files/list?path=${encodeURIComponent(path)}`); } catch (err) {
      browser.innerHTML = `<div class="notice err">${icon("circle-alert", 16)}<div>${esc(err.message)}</div></div>`;
      return;
    }
    const folders = (await api.get("/api/files/folders")).items;
    const root = folders.find((f) => data.path.startsWith(f.path))?.path || data.path;
    const rel = data.path.slice(root.length).split(/[\\/]/).filter(Boolean);
    const sep = data.path.includes("\\") ? "\\" : "/";
    browser.innerHTML = `<div><div class="row mb-8"><div class="crumbs" data-crumbs></div></div><div data-entries></div></div>
      <div class="preview-pane" data-preview><div class="muted small">Sélectionnez un fichier pour voir ses informations et les actions possibles.</div></div>`;
    const crumbs = browser.querySelector("[data-crumbs]");
    const parts = [{ label: root.split(/[\\/]/).filter(Boolean).pop() || root, path: root }];
    rel.forEach((r, i) => parts.push({ label: r, path: root + sep + rel.slice(0, i + 1).join(sep) }));
    parts.forEach((p, i) => {
      if (i) crumbs.append(html(`<span>${icon("chevron-right", 13)}</span>`));
      const b = html(`<button title="${esc(p.path)}">${esc(p.label)}</button>`);
      b.onclick = () => open(p.path);
      crumbs.append(b);
    });
    const entries = browser.querySelector("[data-entries]");
    if (!data.entries.length) entries.innerHTML = '<div class="muted small" style="padding:12px 8px">Dossier vide.</div>';
    for (const e of data.entries) {
      const row = html(`<div class="file-row ${e.is_dir ? "folder" : ""}" tabindex="0">${icon(KIND_ICON[e.kind] || "file", 17)}
        <span class="fname">${esc(e.name)}</span><span class="fmeta">${e.is_dir ? "" : formatSize(e.size)}</span><span class="fmeta">${formatDate(e.modified)}</span></div>`);
      const act = () => (e.is_dir ? open(e.path) : select(e, row));
      row.onclick = act;
      row.ondblclick = () => { if (!e.is_dir) openDefault(e.path); };
      row.onkeydown = (ev) => { if (ev.key === "Enter") act(); };
      entries.append(row);
    }
    if (data.truncated) entries.append(html('<div class="muted small" style="padding:8px">Affichage limité aux 500 premiers éléments.</div>'));
  }

  async function openDefault(path) {
    const r = await api.post("/api/files/open", { path });
    toast(r.status === "done" ? r.result : r.result, { kind: r.status === "done" ? "ok" : "err" });
  }

  async function select(entry, row) {
    container.querySelectorAll(".file-row").forEach((r) => r.classList.toggle("active", r === row));
    const pane = $("[data-preview]");
    const info = await api.get(`/api/files/info?path=${encodeURIComponent(entry.path)}`);
    const kindLabel = { text: "Texte / code", image: "Image", unsupported: "Format non pris en charge par NexaAI" }[info.kind];
    pane.innerHTML = `<div class="section-title" style="margin-bottom:6px">${icon(KIND_ICON[info.kind], 15)}<span style="overflow:hidden;text-overflow:ellipsis">${esc(info.name)}</span></div>
      <dl class="kv mb-8"><dt>Type</dt><dd>${esc(kindLabel)}</dd><dt>Taille</dt><dd>${formatSize(info.size)}</dd>
        <dt>Modifié</dt><dd>${esc(new Date(info.modified * 1000).toLocaleString("fr-FR"))}</dd><dt>Accès</dt><dd>${info.writable ? "lecture et écriture" : "lecture seule"}</dd></dl>
      <div class="row wrap mb-8" data-actions></div><div data-view></div>`;
    const actions = pane.querySelector("[data-actions]");
    const btn = (label, ic, fn, disabled = "") => {
      const b = html(`<button class="btn sm" ${disabled ? `disabled title="${esc(disabled)}"` : ""}>${icon(ic, 14)}${esc(label)}</button>`);
      b.onclick = fn;
      actions.append(b);
    };
    btn("Ouvrir", "external-link", () => openDefault(info.path));
    btn("Joindre à une conversation", "paperclip", () => attach(info), info.kind === "unsupported" ? "Format non lisible par NexaAI" : "");
    btn("Ajouter à un projet", "folder-kanban", (e) => addToProject(info, e.currentTarget));
    if (info.kind === "text") btn("Modifier", "code-xml", () => ctx.navigate(`#/studio?path=${encodeURIComponent(info.path)}`));
    const view = pane.querySelector("[data-view]");
    if (info.kind === "image") view.innerHTML = `<img src="${api.rawUrl(`/api/files/raw?path=${encodeURIComponent(info.path)}`)}" alt="" style="max-width:100%;border-radius:8px;border:1px solid var(--border)">`;
    else if (info.kind === "text") {
      try {
        const t = await api.get(`/api/files/read?path=${encodeURIComponent(info.path)}`);
        view.innerHTML = `<div class="preview-text">${esc(t.content.split("\n").slice(0, 200).join("\n"))}</div>`;
      } catch (err) { view.innerHTML = `<div class="muted small">${esc(err.message)}</div>`; }
    } else view.innerHTML = '<div class="muted small">Aperçu non disponible : NexaAI ne sait pas lire ce format (seuls le texte, le code et les images sont pris en charge).</div>';
  }

  async function attach(info) {
    try {
      const att = await api.post("/api/files/attach", { path: info.path });
      const conv = await api.post("/api/conversations", {});
      const chat = await import("../chat-controller.js");
      await chat.refreshRecents();
      state.pendingAttachment = att;
      ctx.navigate(`#/chat/${conv.id}`);
    } catch (err) { toast(err.message, { kind: "err" }); }
  }

  async function addToProject(info, anchor) {
    const { items } = await api.get("/api/projects");
    menu(anchor, items.length ? items.map((p) => ({ label: p.name, icon: "folder-kanban", run: async () => {
      try { await api.post(`/api/projects/${p.id}/files`, { path: info.path }); toast(`Ajouté au projet « ${p.name} ».`, { kind: "ok" }); }
      catch (err) { toast(err.message, { kind: "err" }); }
    } })) : [{ note: "Aucun projet : créez-en un dans Projets." }]);
  }

  async function init() {
    const folders = await loadFolders();
    if (folders.length) open(current || folders[0].path);
  }

  $("[data-addfolder]").onclick = addFolder;
  await init();
}
