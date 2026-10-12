// Vue « Contrôle du PC » : applications autorisées, actions, outils et journal des actions.
import { api } from "../api.js";
import { icon } from "../icons.js";
import { state } from "../store.js";
import { confirmDialog, esc, formatDate, html, modal, switchHtml, toast } from "../ui.js";
import { pickPath } from "./files.js";

const STATUS = { proposed: ["Proposée", ""], pending: ["En attente", "accent"], running: ["En cours", "accent"], done: ["Terminée", "success"],
  failed: ["Échec", "danger"], denied: ["Refusée", "danger"], cancelled: ["Annulée", "danger"] };
const ORIGIN = { user: "vous", agent: "NexaAI (agent)", gesture: "geste" };
const RISK = { low: ["Lecture", ""], medium: ["Confirmation selon réglage", "warning"], high: ["Confirmation obligatoire", "danger"] };

export async function render(container, params, ctx) {
  container.innerHTML = `
    <header class="topbar"><span class="topbar-title">Contrôle du PC</span><span class="spacer"></span>
      <button class="btn sm" data-addapp>${icon("plus", 15)}Autoriser une application</button></header>
    <div class="page scroll"><div class="page-inner" style="max-width:1000px">
      <div class="page-head"><div><h1>Contrôle du PC</h1><p>NexaAI n'agit sur l'ordinateur qu'à travers des actions précises, vérifiées et journalisées. Aucune commande système arbitraire n'est possible.</p></div></div>
      <div data-pending></div>
      <div class="section-title">${icon("app-window", 15)}Applications autorisées</div><div class="list" data-apps></div>
      <div class="section"><div class="section-title">${icon("folder", 15)}Dossiers accessibles<span class="spacer"></span><a href="#/files" class="small">Gérer dans Fichiers</a></div><div class="list" data-folders></div></div>
      <div class="section"><div class="section-title">${icon("shield-check", 15)}Sécurité des actions de l'agent</div>
        <div class="setting"><div class="setting-text"><div class="setting-title">Confirmer les actions à risque moyen</div>
          <div class="setting-desc">Ouvrir un fichier, lancer une application. Les écritures de fichiers et la mémorisation demandent toujours votre confirmation.</div></div>
          <div class="setting-control">${switchHtml(state.settings.pc.confirm_actions, "data-confirm")}</div></div>
        <div class="setting"><div class="setting-text"><div class="setting-title">Outils proposés aux modèles compatibles</div>
          <div class="setting-desc">Désactivé : les modèles répondent uniquement par du texte.</div></div>
          <div class="setting-control">${switchHtml(state.settings.ai.agent_tools, "data-tools")}</div></div>
        <table class="model-table" data-toolstable></table></div>
      <div class="section"><div class="section-title">${icon("list-checks", 15)}Historique des actions<span class="spacer"></span>
        <button class="btn sm ghost" data-refresh>${icon("refresh-cw", 14)}Actualiser</button></div><div data-log></div></div>
    </div></div>`;
  const $ = (s) => container.querySelector(s);

  async function loadApps() {
    const { items } = await api.get("/api/pc/apps");
    state.apps = items;
    const box = $("[data-apps]");
    box.innerHTML = items.length ? "" : `<div class="empty" style="padding:24px">${icon("app-window", 26)}<h3>Aucune application autorisée</h3>
      <p>Ajoutez les programmes que NexaAI pourra lancer (par exemple le Bloc-notes : C:\\Windows\\notepad.exe).</p></div>`;
    for (const a of items) {
      const el = html(`<div class="list-item"><span class="li-icon">${icon("app-window", 17)}</span><div class="li-main"><div class="li-title">${esc(a.name)}</div>
        <div class="li-sub mono">${esc(a.path)}${a.args ? ` ${esc(a.args)}` : ""}</div></div>
        <button class="btn sm" data-launch>${icon("play", 13)}Lancer</button>
        <button class="icon-btn sm" data-remove title="Retirer l'autorisation" aria-label="Retirer">${icon("x", 15)}</button></div>`);
      el.querySelector("[data-launch]").onclick = async (e) => {
        const btn = e.currentTarget;
        btn.disabled = true;
        const r = await api.post(`/api/pc/apps/${a.id}/launch`, { origin: "user" });
        toast(r.result, { kind: r.status === "done" ? "ok" : "err" });
        btn.disabled = false;
        loadLog();
      };
      el.querySelector("[data-remove]").onclick = async () => {
        if (!(await confirmDialog({ title: "Retirer cette application ?", message: `NexaAI ne pourra plus lancer « ${a.name} ».`, confirm: "Retirer" }))) return;
        await api.del(`/api/pc/apps/${a.id}`);
        loadApps();
      };
      box.append(el);
    }
  }

  async function loadFolders() {
    const { items } = await api.get("/api/files/folders");
    const box = $("[data-folders]");
    box.innerHTML = items.length ? "" : '<div class="muted small" style="padding:10px 4px">Aucun dossier autorisé.</div>';
    for (const f of items) {
      const el = html(`<div class="list-item"><span class="li-icon">${icon("folder", 17)}</span><div class="li-main"><div class="li-title mono" style="font-size:13px">${esc(f.path)}</div>
        <div class="li-sub">${f.access === "read_write" ? "lecture et écriture" : "lecture seule"}</div></div>
        <button class="btn sm" data-open>${icon("folder-open", 13)}Ouvrir dans l'Explorateur</button></div>`);
      el.querySelector("[data-open]").onclick = async () => {
        const r = await api.post("/api/files/open", { path: f.path });
        toast(r.result, { kind: r.status === "done" ? "ok" : "err" });
        loadLog();
      };
      box.append(el);
    }
  }

  async function loadTools() {
    const { items } = await api.get("/api/tools");
    $("[data-toolstable]").innerHTML = `<tr><td class="muted small" colspan="3">Outils disponibles pour l'agent</td></tr>` + items.map((t) =>
      `<tr><td class="mname">${esc(t.name)}</td><td>${esc(t.description)}</td><td><span class="badge ${RISK[t.risk][1]}">${t.needs_confirmation ? "Confirmation demandée" : RISK[t.risk][0]}</span></td></tr>`).join("");
  }

  async function loadLog() {
    const { items, pending } = await api.get("/api/actions?limit=60");
    const pend = $("[data-pending]");
    pend.innerHTML = "";
    for (const a of items.filter((x) => pending.includes(x.id))) {
      const n = html(`<div class="action-card pending mb-8"><div class="ac-icon">${icon("shield-check", 16)}</div><div class="ac-main">
        <div class="ac-title">${esc(a.summary)}</div><div class="ac-sub">Demandée par ${esc(ORIGIN[a.origin] || a.origin)} — en attente de votre décision</div></div>
        <button class="btn sm" data-deny>Refuser</button><button class="btn sm primary" data-ok>Autoriser</button></div>`);
      n.querySelector("[data-deny]").onclick = async () => { await api.post(`/api/actions/${a.id}/decide`, { approve: false }); setTimeout(loadLog, 300); };
      n.querySelector("[data-ok]").onclick = async () => { await api.post(`/api/actions/${a.id}/decide`, { approve: true }); setTimeout(loadLog, 300); };
      pend.append(n);
    }
    const box = $("[data-log]");
    if (!items.length) { box.innerHTML = '<div class="muted small" style="padding:10px 4px">Aucune action enregistrée.</div>'; return; }
    box.innerHTML = `<table class="model-table">${items.map((a) => `<tr><td style="width:120px" class="muted small">${formatDate(a.created_at)}</td>
      <td><div>${esc(a.summary || a.tool)}</div><div class="muted small" style="white-space:pre-wrap;max-height:60px;overflow:hidden">${esc(a.result || "")}</div></td>
      <td class="small muted" style="width:120px">${esc(ORIGIN[a.origin] || a.origin)}</td>
      <td style="width:110px"><span class="badge ${STATUS[a.status]?.[1] || ""}">${esc(STATUS[a.status]?.[0] || a.status)}</span></td></tr>`).join("")}</table>`;
  }

  $("[data-addapp]").onclick = () => {
    const m = modal({
      title: "Autoriser une application",
      body: `<div class="field"><label>Nom</label><input class="input" data-name placeholder="Ex. : Bloc-notes"></div>
        <div class="field"><label>Programme</label><div class="row"><input class="input grow" data-path placeholder="C:\\Windows\\notepad.exe">
          <button class="btn" data-browse>${icon("folder-open", 14)}Parcourir…</button></div>
          <div class="help">Exécutable (.exe), raccourci (.lnk) ou fichier à ouvrir. Lancé sans interpréteur de commandes.</div></div>
        <div class="field"><label>Arguments (facultatif)</label><input class="input" data-args placeholder="Ex. : --new-window"></div>`,
      actions: [{ label: "Annuler" }, { label: "Autoriser", kind: "primary", run: async (body) => {
        try {
          await api.post("/api/pc/apps", { name: body.querySelector("[data-name]").value, path: body.querySelector("[data-path]").value, args: body.querySelector("[data-args]").value });
          toast("Application autorisée.", { kind: "ok" });
          loadApps();
        } catch (err) { toast(err.message, { kind: "err" }); return false; }
      } }],
    });
    m.body.querySelector("[data-browse]").onclick = async () => {
      const p = await pickPath("file", "Choisir le programme");
      if (p) m.body.querySelector("[data-path]").value = p;
    };
  };
  $("[data-confirm]").onchange = async (e) => { await ctx.updateSettings({ pc: { confirm_actions: e.target.checked } }); loadTools(); };
  $("[data-tools]").onchange = (e) => ctx.updateSettings({ ai: { agent_tools: e.target.checked } });
  $("[data-refresh]").onclick = loadLog;
  await Promise.all([loadApps(), loadFolders(), loadTools(), loadLog()]);
  const timer = setInterval(() => { if (!document.hidden) loadLog(); }, 5000);
  return () => clearInterval(timer);
}
