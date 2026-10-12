// Vue « Projets » : création, description, conversations et fichiers associés, notes.
import { api } from "../api.js";
import { icon } from "../icons.js";
import { state } from "../store.js";
import { confirmDialog, esc, formatDate, html, menu, modal, toast } from "../ui.js";
import { pickPath } from "./files.js";

async function refreshProjectsCache() {
  try { state.projects = (await api.get("/api/projects")).items; } catch { /* cache facultatif */ }
}

export async function render(container, params, ctx) {
  if (params.id) return renderDetail(container, params.id, ctx);
  container.innerHTML = `
    <header class="topbar"><span class="topbar-title">Projets</span><span class="spacer"></span>
      <button class="btn sm primary" data-create>${icon("plus", 15)}Nouveau projet</button></header>
    <div class="page scroll"><div class="page-inner">
      <div class="page-head"><div><h1>Bibliothèque de projets</h1>
        <p>Regroupez conversations, fichiers et notes. Le nom, la description et les notes d'un projet sont fournis à NexaAI dans ses conversations.</p></div></div>
      <div class="list" data-list></div></div></div>`;
  container.querySelector("[data-create]").onclick = () => createProject(ctx);
  const list = container.querySelector("[data-list]");
  const { items } = await api.get("/api/projects");
  state.projects = items;
  if (!items.length) {
    list.innerHTML = `<div class="empty">${icon("folder-kanban", 30)}<h3>Aucun projet</h3><p>Créez un projet pour organiser vos conversations et fichiers autour d'un même sujet.</p>
      <button class="btn primary" data-create2>${icon("plus", 15)}Créer un projet</button></div>`;
    list.querySelector("[data-create2]").onclick = () => createProject(ctx);
    return;
  }
  for (const p of items) {
    const el = html(`<div class="list-item clickable" tabindex="0"><span class="li-icon">${icon("folder-kanban", 18)}</span>
      <div class="li-main"><div class="li-title">${esc(p.name)}</div>
      <div class="li-sub">${esc(p.description || "Sans description")} · ${p.conversation_count} conversation(s) · ${p.file_count} fichier(s) · modifié ${formatDate(p.updated_at)}</div></div>
      ${icon("chevron-right", 16)}</div>`);
    el.onclick = () => ctx.navigate(`#/projects/${p.id}`);
    el.onkeydown = (e) => { if (e.key === "Enter") ctx.navigate(`#/projects/${p.id}`); };
    list.append(el);
  }
}

function createProject(ctx) {
  modal({
    title: "Nouveau projet",
    body: `<div class="field"><label>Nom</label><input class="input" data-name placeholder="Ex. : Site du club de robotique"></div>
      <div class="field"><label>Description</label><textarea class="textarea" rows="3" data-desc placeholder="Objectif, contexte, contraintes…"></textarea>
      <div class="help">Cette description est fournie à NexaAI dans les conversations du projet.</div></div>`,
    actions: [{ label: "Annuler" }, { label: "Créer", kind: "primary", run: async (body) => {
      const name = body.querySelector("[data-name]").value.trim();
      if (!name) { body.querySelector("[data-name]").focus(); return false; }
      try {
        const p = await api.post("/api/projects", { name, description: body.querySelector("[data-desc]").value });
        await refreshProjectsCache();
        toast("Projet créé.", { kind: "ok" });
        ctx.navigate(`#/projects/${p.id}`);
      } catch (err) { toast(err.message, { kind: "err" }); return false; }
    } }],
  });
}

async function renderDetail(container, pid, ctx) {
  let p;
  try { p = await api.get(`/api/projects/${pid}`); } catch (err) {
    container.innerHTML = `<div class="page"><div class="page-inner"><div class="notice err">${icon("circle-alert", 16)}<div>${esc(err.message)}</div></div></div></div>`;
    return;
  }
  container.innerHTML = `
    <header class="topbar"><button class="icon-btn" data-back title="Retour aux projets" aria-label="Retour">${icon("arrow-left", 18)}</button>
      <span class="topbar-title">${esc(p.name)}</span><span class="spacer"></span>
      <button class="btn sm" data-chat>${icon("square-pen", 15)}Conversation dans ce projet</button>
      <button class="icon-btn" data-more title="Options du projet" aria-label="Options">${icon("ellipsis", 18)}</button></header>
    <div class="page scroll"><div class="page-inner">
      <div class="grid-2">
        <div class="field"><label>Nom</label><input class="input" data-f="name" value="${esc(p.name)}"></div>
        <div class="field"><label>Créé le</label><input class="input" disabled value="${esc(new Date(p.created_at * 1000).toLocaleDateString("fr-FR"))}"></div>
      </div>
      <div class="field"><label>Description</label><textarea class="textarea" rows="2" data-f="description">${esc(p.description)}</textarea></div>
      <div class="field"><label>Contexte et notes du projet</label><textarea class="textarea" rows="4" data-f="notes" placeholder="Décisions, conventions, informations utiles…">${esc(p.notes)}</textarea>
        <div class="help">Enregistré automatiquement. Fourni à NexaAI dans les conversations de ce projet.</div></div>

      <div class="section"><div class="section-title">${icon("message-square", 15)}Conversations <span class="muted">${p.conversations.length}</span><span class="spacer"></span>
        <button class="btn sm ghost" data-link>${icon("link", 14)}Associer une conversation</button></div><div class="list" data-convs></div></div>

      <div class="section"><div class="section-title">${icon("file", 15)}Fichiers associés <span class="muted">${p.files.length}</span><span class="spacer"></span>
        <button class="btn sm ghost" data-addfile>${icon("plus", 14)}Ajouter un fichier</button></div>
        <div class="notice info mb-8">${icon("info", 16)}<div>Les fichiers associés ne sont pas analysés automatiquement : seuls leurs noms sont indiqués à NexaAI. Ouvrez-les dans Création et code, ou joignez-les à un message pour que leur contenu soit lu.</div></div>
        <div class="list" data-files></div></div>
    </div></div>`;
  const $ = (s) => container.querySelector(s);
  $("[data-back]").onclick = () => ctx.navigate("#/projects");
  $("[data-chat]").onclick = () => ctx.newChat(pid);
  container.querySelectorAll("[data-f]").forEach((f) => f.addEventListener("change", async () => {
    try {
      p = { ...p, ...(await api.patch(`/api/projects/${pid}`, { [f.dataset.f]: f.value })) };
      if (f.dataset.f === "name") container.querySelector(".topbar-title").textContent = p.name;
      await refreshProjectsCache();
      toast("Projet enregistré.", { kind: "ok", duration: 1500 });
    } catch (err) { toast(err.message, { kind: "err" }); }
  }));
  $("[data-more]").onclick = (e) => menu(e.currentTarget, [
    { label: "Supprimer le projet…", icon: "trash-2", danger: true, run: async () => {
      const ok = await confirmDialog({ title: "Supprimer le projet ?", message: `« ${p.name} » sera supprimé. Ses conversations sont conservées (elles ne seront plus associées) ; les fichiers sur le disque ne sont pas touchés.`, confirm: "Supprimer", danger: true });
      if (!ok) return;
      await api.del(`/api/projects/${pid}`);
      await refreshProjectsCache();
      toast("Projet supprimé.", { kind: "ok" });
      ctx.navigate("#/projects");
    } },
  ], { align: "end" });

  const convs = $("[data-convs]");
  if (!p.conversations.length) convs.innerHTML = '<div class="muted small" style="padding:10px 6px">Aucune conversation associée.</div>';
  for (const c of p.conversations) {
    const el = html(`<div class="list-item clickable"><span class="li-icon">${icon("message-square", 16)}</span><div class="li-main"><div class="li-title">${esc(c.title)}</div>
      <div class="li-sub">${formatDate(c.updated_at)} · ${c.message_count} message(s)</div></div>
      <div class="li-actions"><button class="icon-btn sm" title="Retirer du projet" aria-label="Retirer du projet">${icon("unlink", 15)}</button></div></div>`);
    el.onclick = async (e) => {
      if (e.target.closest("button")) {
        await api.patch(`/api/conversations/${c.id}`, { project_id: "" });
        return renderDetail(container, pid, ctx);
      }
      ctx.navigate(`#/chat/${c.id}`);
    };
    convs.append(el);
  }
  $("[data-link]").onclick = async (e) => {
    const { items } = await api.get("/api/conversations?limit=50");
    const candidates = items.filter((c) => c.project_id !== pid && c.message_count > 0);
    menu(e.currentTarget, candidates.length ? candidates.slice(0, 20).map((c) => ({ label: c.title, icon: "message-square", run: async () => {
      await api.patch(`/api/conversations/${c.id}`, { project_id: pid });
      renderDetail(container, pid, ctx);
    } })) : [{ note: "Aucune autre conversation disponible." }], { align: "end" });
  };

  const files = $("[data-files]");
  if (!p.files.length) files.innerHTML = '<div class="muted small" style="padding:10px 6px">Aucun fichier associé.</div>';
  for (const f of p.files) {
    const el = html(`<div class="list-item"><span class="li-icon">${icon(f.kind === "text" ? "file-code" : f.kind === "image" ? "file-image" : "file", 16)}</span>
      <div class="li-main"><div class="li-title">${esc(f.path.split(/[\\/]/).pop())}</div><div class="li-sub mono">${esc(f.path)}${f.exists ? "" : " — introuvable sur le disque"}</div></div>
      <div class="li-actions">${f.kind === "text" && f.exists ? `<button class="icon-btn sm" data-a="studio" title="Ouvrir dans Création et code" aria-label="Ouvrir dans Création et code">${icon("code-xml", 15)}</button>` : ""}
        ${f.exists ? `<button class="icon-btn sm" data-a="open" title="Ouvrir avec l'application par défaut" aria-label="Ouvrir">${icon("external-link", 15)}</button>` : ""}
        <button class="icon-btn sm" data-a="remove" title="Retirer du projet" aria-label="Retirer">${icon("x", 15)}</button></div></div>`);
    el.onclick = async (e) => {
      const a = e.target.closest("[data-a]")?.dataset.a;
      if (a === "studio") ctx.navigate(`#/studio?project=${pid}&path=${encodeURIComponent(f.path)}`);
      if (a === "open") {
        const r = await api.post("/api/files/open", { path: f.path });
        toast(r.result, { kind: r.status === "done" ? "ok" : "err" });
      }
      if (a === "remove") { await api.del(`/api/projects/${pid}/files/${f.id}`); renderDetail(container, pid, ctx); }
    };
    files.append(el);
  }
  $("[data-addfile]").onclick = async () => {
    const path = await pickPath("file", "Ajouter un fichier au projet", "Le fichier doit se trouver dans un dossier autorisé (Fichiers › Dossiers autorisés).");
    if (!path) return;
    try {
      await api.post(`/api/projects/${pid}/files`, { path });
      renderDetail(container, pid, ctx);
    } catch (err) { toast(err.message, { kind: "err" }); }
  };
}

