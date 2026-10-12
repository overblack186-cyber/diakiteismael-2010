// Vue « Mémoire » : informations explicitement mémorisées, consultables et modifiables.
import { api } from "../api.js";
import { icon } from "../icons.js";
import { state } from "../store.js";
import { confirmDialog, esc, formatDate, html, modal, switchHtml, toast } from "../ui.js";

const KINDS = {
  preference: { label: "Préférences", one: "préférence", icon: "sliders-horizontal", help: "Comment vous aimez que NexaAI réponde (ton, langue, niveau de détail…). Toujours fournies au modèle." },
  fact: { label: "Faits", one: "fait", icon: "bookmark", help: "Informations à retenir. Fournies au modèle quand elles concernent votre demande (mots communs)." },
  project_note: { label: "Notes de projet", one: "note de projet", icon: "folder-kanban", help: "Rattachées à un projet ; fournies uniquement dans les conversations de ce projet." },
};
const SOURCES = { manual: "ajoutée manuellement", conversation: "depuis une conversation", agent: "demandée à NexaAI (confirmée)" };

export async function render(container, params, ctx) {
  let tab = params.id && KINDS[params.id] ? params.id : "preference";
  container.innerHTML = `
    <header class="topbar"><span class="topbar-title">Mémoire de NexaAI</span><span class="spacer"></span>
      <button class="btn sm primary" data-add>${icon("plus", 15)}Ajouter</button></header>
    <div class="page scroll"><div class="page-inner">
      <div class="setting-group"><div class="setting">
        <div class="setting-text"><div class="setting-title">Mémoire activée</div>
          <div class="setting-desc">NexaAI ne mémorise rien automatiquement. Une information n'est conservée que si vous l'ajoutez ici,
          depuis un message (« Mémoriser »), ou si vous demandez explicitement à NexaAI de la retenir — avec votre confirmation.
          Tout est stocké uniquement sur cet ordinateur.</div></div>
        <div class="setting-control">${switchHtml(state.settings.memory.enabled, 'data-enabled aria-label="Activer la mémoire"')}</div></div>
      <div class="setting">
        <div class="setting-text"><div class="setting-title">Fournir la mémoire aux modèles</div>
          <div class="setting-desc">Désactivé : les informations restent enregistrées mais ne sont plus transmises dans les conversations.</div></div>
        <div class="setting-control">${switchHtml(state.settings.memory.inject, 'data-inject aria-label="Fournir la mémoire aux modèles"')}</div></div></div>
      <div class="tabs mt-16" role="tablist">${Object.entries(KINDS).map(([k, v]) => `<button class="tab" data-tab="${k}" role="tab">${v.label}<span class="count" data-count="${k}"></span></button>`).join("")}</div>
      <div class="muted small mb-8" data-help></div>
      <div class="list" data-list></div>
      <div class="section"><button class="btn sm ghost danger" data-clear>${icon("trash-2", 14)}Tout effacer…</button></div>
    </div></div>`;
  const $ = (s) => container.querySelector(s);
  let items = [];
  let projects = [];

  async function load() {
    [items, projects] = await Promise.all([api.get("/api/memory").then((r) => r.items), api.get("/api/projects").then((r) => r.items)]);
    draw();
  }

  function draw() {
    container.querySelectorAll("[data-tab]").forEach((t) => t.classList.toggle("active", t.dataset.tab === tab));
    for (const k of Object.keys(KINDS)) $(`[data-count="${k}"]`).textContent = items.filter((i) => i.kind === k).length || "";
    $("[data-help]").textContent = KINDS[tab].help;
    $("[data-clear]").disabled = !items.length;
    const list = $("[data-list]");
    list.innerHTML = "";
    const shown = items.filter((i) => i.kind === tab);
    if (!shown.length) {
      list.innerHTML = `<div class="empty">${icon(KINDS[tab].icon, 28)}<h3>Aucune ${KINDS[tab].one}</h3><p>Ajoutez-en une avec le bouton « Ajouter », ou depuis le menu d'un message.</p></div>`;
      return;
    }
    for (const m of shown) {
      const project = m.project_id ? projects.find((p) => p.id === m.project_id) : null;
      const el = html(`<div class="list-item" style="${m.enabled ? "" : "opacity:.55"}">
        <div class="li-main"><div style="white-space:pre-wrap">${esc(m.content)}</div>
          <div class="li-sub">${esc(SOURCES[m.source] || m.source)} · ${formatDate(m.updated_at)}${project ? ` · projet « ${esc(project.name)} »` : ""}${m.enabled ? "" : " · désactivée"}</div></div>
        <div class="row">${switchHtml(m.enabled, `data-toggle aria-label="Utiliser cette information" title="Utiliser cette information"`)}
          <button class="icon-btn sm" data-edit title="Modifier" aria-label="Modifier">${icon("pencil", 15)}</button>
          <button class="icon-btn sm" data-del title="Supprimer" aria-label="Supprimer">${icon("trash-2", 15)}</button></div></div>`);
      el.querySelector("[data-toggle]").onchange = async (e) => { await api.patch(`/api/memory/${m.id}`, { enabled: e.target.checked }); load(); };
      el.querySelector("[data-edit]").onclick = () => editor(m);
      el.querySelector("[data-del]").onclick = async () => {
        const ok = await confirmDialog({ title: "Supprimer cette information ?", message: m.content.slice(0, 200), confirm: "Supprimer", danger: true });
        if (!ok) return;
        await api.del(`/api/memory/${m.id}`);
        toast("Information supprimée.", { kind: "ok" });
        load();
      };
      list.append(el);
    }
  }

  function editor(existing = null) {
    const kind = existing?.kind || tab;
    modal({
      title: existing ? "Modifier l'information" : "Mémoriser une information",
      body: `<div class="field"><label>Type</label><select class="select" data-kind>${Object.entries(KINDS).map(([k, v]) => `<option value="${k}" ${k === kind ? "selected" : ""}>${v.label}</option>`).join("")}</select></div>
        <div class="field ${kind === "project_note" ? "" : "hidden"}" data-projwrap><label>Projet</label><select class="select" data-project>${projects.map((p) => `<option value="${p.id}" ${existing?.project_id === p.id ? "selected" : ""}>${esc(p.name)}</option>`).join("") || '<option value="">Aucun projet</option>'}</select></div>
        <div class="field"><label>Information</label><textarea class="textarea" rows="4" data-content placeholder="Ex. : Je préfère des réponses courtes avec des exemples.">${esc(existing?.content || "")}</textarea>
        <div class="help">N'enregistrez pas de mots de passe ni d'informations sensibles inutiles.</div></div>`,
      actions: [{ label: "Annuler" }, { label: "Enregistrer", kind: "primary", run: async (body) => {
        const content = body.querySelector("[data-content]").value.trim();
        const k = body.querySelector("[data-kind]").value;
        if (!content) { body.querySelector("[data-content]").focus(); return false; }
        try {
          if (existing) {
            if (k !== existing.kind && k === "project_note") throw new Error("Pour créer une note de projet, ajoutez une nouvelle information.");
            await api.patch(`/api/memory/${existing.id}`, { content, kind: k });
          } else {
            await api.post("/api/memory", { kind: k, content, project_id: k === "project_note" ? body.querySelector("[data-project]").value : null });
          }
          tab = k;
          toast("Mémoire enregistrée.", { kind: "ok" });
          load();
        } catch (err) { toast(err.message, { kind: "err" }); return false; }
      } }],
    });
    const sel = document.querySelector(".modal [data-kind]");
    sel.onchange = () => document.querySelector(".modal [data-projwrap]").classList.toggle("hidden", sel.value !== "project_note");
  }

  $("[data-add]").onclick = () => editor();
  $("[data-enabled]").onchange = async (e) => {
    await ctx.updateSettings({ memory: { enabled: e.target.checked } });
    toast(e.target.checked ? "Mémoire activée." : "Mémoire désactivée : rien n'est transmis ni ajouté.", { kind: "ok" });
  };
  $("[data-inject]").onchange = (e) => ctx.updateSettings({ memory: { inject: e.target.checked } });
  $("[data-clear]").onclick = () => modal({
    title: "Effacer toute la mémoire ?",
    body: `<p>Toutes les informations mémorisées (préférences, faits, notes de projet) seront définitivement supprimées. Les conversations ne sont pas touchées.</p>
      <div class="field"><label>Tapez EFFACER pour confirmer</label><input class="input" data-confirm></div>`,
    actions: [{ label: "Annuler" }, { label: "Tout effacer", kind: "danger solid", run: async (body) => {
      const v = body.querySelector("[data-confirm]").value.trim();
      if (v !== "EFFACER") { body.querySelector("[data-confirm]").focus(); return false; }
      const r = await api.post("/api/memory/clear", { confirm: "EFFACER" });
      toast(`${r.deleted} information(s) effacée(s).`, { kind: "ok" });
      load();
    } }],
  });
  container.querySelectorAll("[data-tab]").forEach((t) => t.onclick = () => { tab = t.dataset.tab; draw(); });
  await load();
}
