// Vue « Création et code » : éditeur, propositions vérifiables de NexaAI, versions, aperçu isolé.
import { api } from "../api.js";
import { icon } from "../icons.js";
import { state } from "../store.js";
import { confirmDialog, esc, html, menu, toast } from "../ui.js";
import { pickPath } from "./files.js";

const session = { recent: [], project: "" };   // conservé entre deux visites de la page

export async function render(container, params, ctx) {
  let file = null;          // {path, content, writable}
  let original = "";
  let previewOn = false;
  let allowScripts = false;
  let aiOpen = false;
  let proposal = null;
  let abort = null;
  if (params.project) session.project = params.project;

  container.innerHTML = `
    <header class="topbar"><span class="topbar-title">Création et code</span><span class="spacer"></span>
      <button class="btn sm" data-open>${icon("folder-open", 15)}Ouvrir un fichier</button>
      <button class="btn sm" data-ai>${icon("message-square", 15)}Demander à NexaAI</button></header>
    <div class="studio" data-studio>
      <aside class="studio-files scroll">
        <div class="field" style="padding:0 4px"><label>Projet</label><select class="select" data-project><option value="">Aucun projet</option></select></div>
        <div data-list></div>
      </aside>
      <section class="studio-main" data-main></section>
    </div>`;
  const $ = (s) => container.querySelector(s);
  const main = $("[data-main]");

  // -- liste des fichiers -----------------------------------------------------------
  const { items: projects } = await api.get("/api/projects");
  $("[data-project]").innerHTML += projects.map((p) => `<option value="${p.id}" ${p.id === session.project ? "selected" : ""}>${esc(p.name)}</option>`).join("");
  $("[data-project]").onchange = (e) => { session.project = e.target.value; renderList(); };

  async function renderList() {
    const list = $("[data-list]");
    list.innerHTML = "";
    let paths = [];
    if (session.project) {
      try {
        const p = await api.get(`/api/projects/${session.project}`);
        paths = p.files.filter((f) => f.kind === "text" && f.exists).map((f) => f.path);
        if (!paths.length) list.append(html('<div class="side-empty">Aucun fichier texte associé à ce projet.</div>'));
        list.prepend(html('<div class="side-group-label" style="padding-left:8px">Fichiers du projet</div>'));
      } catch { session.project = ""; }
    }
    const recent = session.recent.filter((p) => !paths.includes(p));
    const add = (path) => {
      const b = html(`<button class="studio-file ${file?.path === path ? "active" : ""}" title="${esc(path)}">${icon("file-code", 15)}<span>${esc(path.split(/[\\/]/).pop())}</span></button>`);
      b.onclick = () => load(path);
      list.append(b);
    };
    paths.forEach(add);
    if (recent.length) {
      list.append(html('<div class="side-group-label" style="padding-left:8px">Récents</div>'));
      recent.forEach(add);
    }
    if (!paths.length && !recent.length && !session.project) list.append(html('<div class="side-empty">Ouvrez un fichier texte situé dans un dossier autorisé.</div>'));
  }

  // -- éditeur -----------------------------------------------------------------------
  const dirty = () => file && editorValue() !== original;
  const editorValue = () => main.querySelector("[data-editor]")?.value ?? file?.content ?? "";

  function renderMain() {
    $("[data-studio]").classList.toggle("with-ai", aiOpen);
    $("[data-ai]").classList.toggle("primary", aiOpen);
    if (!file) {
      main.innerHTML = `<div class="empty" style="margin:auto">${icon("code-xml", 32)}<h3>Espace de création</h3>
        <p>Ouvrez un fichier texte ou code d'un dossier autorisé. NexaAI peut proposer des modifications : vous vérifiez la différence avant de l'appliquer, et chaque enregistrement conserve la version précédente.</p>
        <button class="btn primary" data-open2>${icon("folder-open", 15)}Ouvrir un fichier</button></div>`;
      main.querySelector("[data-open2]").onclick = openFile;
      renderAi();
      return;
    }
    const isHtml = /\.html?$/i.test(file.path);
    main.innerHTML = `<div class="editor-bar"><span class="path" title="${esc(file.path)}">${esc(file.path)}</span><span class="badge hidden" data-dirty>modifié</span>
      ${file.writable ? "" : '<span class="badge" title="Dossier autorisé en lecture seule">lecture seule</span>'}
      ${isHtml ? `<button class="btn sm ${previewOn ? "primary" : ""}" data-preview>${icon("eye", 14)}Aperçu</button>` : ""}
      <button class="btn sm" data-versions>${icon("history", 14)}Versions</button>
      <button class="btn sm primary" data-save ${file.writable ? "" : 'disabled title="Ce dossier est autorisé en lecture seule."'}>${icon("save", 14)}Enregistrer</button></div>
      <div class="editor ${previewOn ? "hidden" : ""}"><div class="gutter" data-gutter></div><textarea data-editor spellcheck="false" aria-label="Contenu du fichier"></textarea></div>
      ${previewOn ? `<div class="notice ${allowScripts ? "warn" : "info"}" style="border-radius:0">${icon(allowScripts ? "triangle-alert" : "shield-check", 16)}
        <div class="grow">${allowScripts ? "Scripts autorisés dans l'aperçu isolé (aucun accès à NexaAI ni au réseau)." : "Aperçu isolé : scripts désactivés, aucun accès au réseau. Les ressources externes (images, CSS liés) ne sont pas chargées."}</div>
        <label class="row small"><input type="checkbox" data-scripts ${allowScripts ? "checked" : ""}> Autoriser les scripts</label></div>
        <iframe class="preview-frame" data-frame sandbox="${allowScripts ? "allow-scripts" : ""}" title="Aperçu"></iframe>` : ""}`;
    const ta = main.querySelector("[data-editor]");
    ta.value = file.content;
    const gutter = main.querySelector("[data-gutter]");
    const syncGutter = () => {
      const n = ta.value.split("\n").length;
      gutter.innerHTML = Array.from({ length: n }, (_, i) => i + 1).join("<br>");
      main.querySelector("[data-dirty]").classList.toggle("hidden", !dirty());
      const saveBtn = main.querySelector("[data-save]");
      if (file.writable) {
        saveBtn.disabled = !dirty();
        saveBtn.title = dirty() ? "Enregistrer (Ctrl+S)" : "Aucune modification à enregistrer";
      }
    };
    ta.addEventListener("input", () => { file.content = ta.value; syncGutter(); });
    ta.addEventListener("scroll", () => { gutter.scrollTop = ta.scrollTop; }, { passive: true });
    ta.addEventListener("keydown", (e) => {
      if (e.key === "Tab" && !e.shiftKey && !e.ctrlKey) {
        e.preventDefault();
        const { selectionStart: s, selectionEnd: en } = ta;
        ta.setRangeText("    ", s, en, "end");
        ta.dispatchEvent(new Event("input"));
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") { e.preventDefault(); save(); }
    });
    syncGutter();
    main.querySelector("[data-save]").onclick = save;
    main.querySelector("[data-versions]").onclick = (e) => versions(e.currentTarget);
    main.querySelector("[data-preview]")?.addEventListener("click", () => { previewOn = !previewOn; renderMain(); });
    main.querySelector("[data-scripts]")?.addEventListener("change", (e) => { allowScripts = e.target.checked; renderMain(); });
    if (previewOn) loadPreview();
    renderAi();
  }

  async function loadPreview() {
    const { url } = await api.post("/api/studio/preview", { html: file.content, allow_scripts: allowScripts });
    const frame = main.querySelector("[data-frame]");
    if (frame) frame.src = url;
  }

  async function load(path) {
    if (dirty() && !(await confirmDialog({ title: "Modifications non enregistrées", message: "Ouvrir un autre fichier fera perdre les modifications en cours. Continuer ?", confirm: "Continuer", danger: true }))) return;
    try {
      const data = await api.get(`/api/files/read?path=${encodeURIComponent(path)}`);
      file = { path: data.path, content: data.content, writable: data.writable };
      original = data.content;
      proposal = null;
      previewOn = false;
      if (data.truncated) toast("Fichier très volumineux : seule une partie est affichée, l'enregistrement est désactivé.", { kind: "err" });
      if (data.truncated) file.writable = false;
      session.recent = [data.path, ...session.recent.filter((p) => p !== data.path)].slice(0, 8);
      renderMain();
      renderList();
    } catch (err) { toast(err.message, { kind: "err" }); }
  }

  async function openFile() {
    const path = await pickPath("file", "Ouvrir un fichier", "Fichier texte ou code situé dans un dossier autorisé.");
    if (path) load(path);
  }

  async function save() {
    if (!file?.writable) return;
    if (!dirty()) { toast("Aucune modification à enregistrer."); return; }
    const ok = await confirmDialog({ title: "Enregistrer le fichier ?", message: `${file.path} sera remplacé. La version actuelle sur le disque sera sauvegardée (bouton Versions pour revenir en arrière).`, confirm: "Enregistrer" });
    if (!ok) return;
    try {
      const r = await api.post("/api/files/write", { path: file.path, content: editorValue() });
      original = editorValue();
      main.querySelector("[data-dirty]")?.classList.add("hidden");
      toast(`Enregistré (${r.size} octets).${r.backup ? " Version précédente sauvegardée." : ""}`, { kind: "ok" });
    } catch (err) { toast(err.message, { kind: "err" }); }
  }

  async function versions(anchor) {
    const { items } = await api.get(`/api/files/backups?path=${encodeURIComponent(file.path)}`);
    menu(anchor, items.length ? [{ head: "Versions sauvegardées" }, ...items.slice(0, 15).map((b) => ({
      label: new Date(b.created * 1000).toLocaleString("fr-FR"), icon: "undo-2", hint: `${b.size} o`,
      disabled: file.writable ? "" : "Lecture seule",
      run: async () => {
        const ok = await confirmDialog({ title: "Restaurer cette version ?", message: "Le fichier sur le disque sera remplacé par cette version. La version actuelle sera elle-même sauvegardée.", confirm: "Restaurer" });
        if (!ok) return;
        await api.post("/api/files/restore", { path: file.path, backup_id: b.id });
        original = "";
        file.content = "";
        await load(file.path);
        toast("Version restaurée.", { kind: "ok" });
      },
    }))] : [{ note: "Aucune version sauvegardée : une sauvegarde est créée à chaque enregistrement." }], { align: "end" });
  }

  // -- assistant de modification ---------------------------------------------------------
  function renderAi() {
    let panel = $("[data-aipanel]");
    if (!aiOpen) { panel?.remove(); return; }
    if (!panel) {
      panel = html(`<aside class="studio-ai" data-aipanel><div class="context-head"><span>Demander à NexaAI</span><span class="spacer"></span>
        <button class="icon-btn sm" data-close aria-label="Fermer">${icon("x", 16)}</button></div><div class="studio-ai-body scroll"></div></aside>`);
      panel.querySelector("[data-close]").onclick = () => { aiOpen = false; abort?.abort(); renderMain(); };
      $("[data-studio]").append(panel);
    }
    const body = panel.querySelector(".studio-ai-body");
    if (!file) {
      body.innerHTML = '<div class="muted small">Ouvrez un fichier pour demander une modification.</div>';
      return;
    }
    if (proposal?.diff) {
      const d = proposal.diff;
      body.innerHTML = `<div class="row mb-8"><b>Modification proposée</b><span class="spacer" style="flex:1"></span>
        <span class="badge success">+${d.added}</span><span class="badge danger">−${d.removed}</span></div>
        <div class="muted small mb-8">${esc(proposal.model || "")}</div>
        ${d.identical ? '<div class="notice info">Aucune différence avec le fichier actuel.</div>' : '<div class="diff" data-diff></div>'}
        <div class="row mt-16" style="justify-content:flex-end"><button class="btn sm" data-discard>Ignorer</button>
        <button class="btn sm primary" data-apply ${d.identical ? "disabled" : ""}>Appliquer dans l'éditeur</button></div>
        <div class="help muted small mt-8">« Appliquer » modifie l'éditeur uniquement. Le fichier n'est écrit qu'avec « Enregistrer ».</div>`;
      const box = body.querySelector("[data-diff]");
      if (box) {
        for (const l of d.lines) {
          const no = l.type === "del" ? l.old_no : l.new_no;
          box.append(html(`<div class="diff-line ${l.type}"><span class="no">${l.type === "hunk" ? "" : no ?? ""}</span><span class="tx">${esc(l.text)}</span></div>`));
        }
      }
      body.querySelector("[data-discard]").onclick = () => { proposal = null; renderAi(); };
      body.querySelector("[data-apply]")?.addEventListener("click", () => {
        file.content = proposal.code;
        proposal = null;
        renderMain();
        main.querySelector("[data-dirty]").classList.remove("hidden");
        toast("Modification appliquée dans l'éditeur. Vérifiez puis enregistrez.", { kind: "ok" });
      });
      return;
    }
    body.innerHTML = `<div class="field"><label>Modification souhaitée</label>
      <textarea class="textarea" rows="5" data-instr placeholder="Ex. : ajoute la validation du formulaire et commente les fonctions."></textarea>
      <div class="help">Le contenu du fichier ouvert est envoyé au modèle actif (${esc(state.settings.ai.mode === "remote" ? "distant" : "local de préférence")}).</div></div>
      <div class="row" style="justify-content:flex-end"><button class="btn sm primary" data-go>${icon("git-compare", 14)}Proposer une modification</button></div>
      <div data-progress class="mt-16"></div>`;
    const go = body.querySelector("[data-go]");
    go.onclick = () => propose(body, false);
    body.querySelector("[data-instr]").addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) propose(body, false); });
  }

  async function propose(body, allowRemote) {
    const instruction = body.querySelector("[data-instr]").value.trim();
    if (!instruction) { body.querySelector("[data-instr]").focus(); return; }
    const progress = body.querySelector("[data-progress]");
    const go = body.querySelector("[data-go]");
    go.disabled = true;
    abort = new AbortController();
    let chars = 0;
    let model = "";
    progress.innerHTML = `<div class="waiting"><span class="spinner"></span><span data-t>Envoi au modèle…</span><button class="btn sm ghost" data-stop>Arrêter</button></div>`;
    progress.querySelector("[data-stop]").onclick = () => abort.abort();
    const label = progress.querySelector("[data-t]");
    try {
      await api.stream("POST", "/api/studio/propose", {
        filename: file.path.split(/[\\/]/).pop(), content: editorValue(), instruction, allow_remote: allowRemote,
      }, (ev) => {
        if (ev.type === "start") { model = `${ev.resolution.model} (${ev.resolution.is_local ? "local" : "distant"})`; label.textContent = `${model} rédige la proposition…`; }
        if (ev.type === "delta") { chars += ev.text.length; label.textContent = `${model} — ${chars} caractères reçus…`; }
        if (ev.type === "error") throw new Error(ev.error);
        if (ev.type === "proposal") proposal = { code: ev.code, diff: ev.diff, model };
      }, abort.signal);
      renderAi();
    } catch (err) {
      if (err.name === "AbortError") { progress.innerHTML = '<div class="muted small">Proposition annulée.</div>'; }
      else if (err.kind === "remote_files") {
        const ok = await confirmDialog({ title: "Envoyer le fichier à un service distant ?", message: err.message, confirm: "Envoyer" });
        if (ok) return propose(body, true);
        progress.innerHTML = "";
      } else progress.innerHTML = `<div class="notice err">${icon("circle-alert", 16)}<div>${esc(err.message)}</div></div>`;
    } finally {
      go.disabled = false;
      abort = null;
    }
  }

  $("[data-open]").onclick = openFile;
  $("[data-ai]").onclick = () => { aiOpen = !aiOpen; renderMain(); };
  renderList();
  if (params.path) await load(params.path); else renderMain();

  const beforeUnload = (e) => { if (dirty()) { e.preventDefault(); e.returnValue = ""; } };
  window.addEventListener("beforeunload", beforeUnload);
  return () => {
    abort?.abort();
    window.removeEventListener("beforeunload", beforeUnload);
    if (dirty()) toast("Modifications non enregistrées abandonnées dans Création et code.", { kind: "err" });
  };
}
