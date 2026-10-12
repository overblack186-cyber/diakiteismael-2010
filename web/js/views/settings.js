// Vue « Paramètres » : chaque réglage affiché est enregistré et réellement appliqué.
import { api } from "../api.js";
import * as chat from "../chat-controller.js";
import { eventToShortcut } from "../commands.js";
import { icon } from "../icons.js";
import { MODE_INFO } from "../main.js";
import { state } from "../store.js";
import { confirmDialog, copyText, esc, formatSize, html, modal, switchHtml, toast } from "../ui.js";

const SECTIONS = [
  ["general", "Général", "sliders-horizontal"], ["ai", "Intelligence artificielle", "cpu"], ["voice", "Voix", "audio-lines"],
  ["vision", "Vision", "scan-eye"], ["memory", "Mémoire", "brain"], ["privacy", "Confidentialité", "lock"],
  ["shortcuts", "Raccourcis", "keyboard"], ["system", "Système", "server"],
];

const DEFAULT_SHORTCUTS = { palette: "Ctrl+K", new_chat: "Ctrl+Shift+O", toggle_sidebar: "Ctrl+B", search: "Ctrl+Shift+F", stop: "Escape" };
const SHORTCUT_LABELS = { palette: "Ouvrir les commandes rapides", new_chat: "Nouvelle conversation", toggle_sidebar: "Afficher / réduire la barre latérale",
  search: "Rechercher dans les conversations", stop: "Interrompre la génération, la lecture ou l'écoute" };

function setting(title, desc, control) {
  return `<div class="setting"><div class="setting-text"><div class="setting-title">${title}</div>${desc ? `<div class="setting-desc">${desc}</div>` : ""}</div>
    <div class="setting-control">${control}</div></div>`;
}
const select = (attr, options, value) => `<select class="select" ${attr}>${options.map(([v, l]) => `<option value="${esc(v)}" ${v === value ? "selected" : ""}>${esc(l)}</option>`).join("")}</select>`;

export async function render(container, params, ctx) {
  const section = SECTIONS.some(([k]) => k === params.id) ? params.id : "general";
  container.innerHTML = `
    <header class="topbar"><span class="topbar-title">Paramètres</span></header>
    <div class="settings-layout">
      <nav class="settings-nav">${SECTIONS.map(([k, l, ic]) => `<button class="nav-item ${k === section ? "active" : ""}" data-s="${k}">${icon(ic, 17)}<span class="label" style="display:inline">${l}</span></button>`).join("")}</nav>
      <div class="settings-body scroll"><div class="page-inner" style="max-width:820px" data-body></div></div>
    </div>`;
  container.querySelectorAll("[data-s]").forEach((b) => b.onclick = () => ctx.navigate(`#/settings/${b.dataset.s}`));
  const body = container.querySelector("[data-body]");
  const renderers = { general, ai, voice: voiceSection, vision: visionSection, memory, privacy, shortcuts, system };
  return renderers[section](body, ctx);
}

// -- Général ------------------------------------------------------------------------
function general(body, ctx) {
  const g = state.settings.general;
  body.innerHTML = `<h1 style="font-size:20px" class="mb-8">Général</h1>
    ${setting("Thème", "Sombre (par défaut) ou clair.", `<div class="segmented"><button data-theme="dark" class="${g.theme === "dark" ? "active" : ""}">${icon("moon", 14)}Sombre</button><button data-theme="light" class="${g.theme === "light" ? "active" : ""}">${icon("sun", 14)}Clair</button></div>`)}
    ${setting("Langue des réponses", "Langue imposée au modèle (vous pouvez toujours demander une autre langue dans un message).",
      select("data-lang", [["fr", "Français"], ["en", "Anglais"], ["es", "Espagnol"], ["de", "Allemand"], ["auto", "Comme la question"]], g.reply_language))}
    ${setting("Au démarrage", "Conversation affichée à l'ouverture de NexaAI.", select("data-startup", [["last", "Reprendre la dernière conversation"], ["new", "Nouvelle conversation"]], g.startup))}
    ${setting("Fenêtre", "Mode d'ouverture au prochain lancement. « Application » : fenêtre dédiée Edge/Chrome sans barre d'adresse.",
      select("data-window", [["app", "Fenêtre d'application"], ["browser", "Onglet du navigateur par défaut"], ["none", "Ne rien ouvrir (serveur seul)"]], g.window))}
    ${setting("Notifications", "Notification système quand une réponse se termine alors que NexaAI est en arrière-plan.", switchHtml(g.notifications, "data-notif"))}
    ${setting("Animations réduites", "Désactive les animations (compagnon, transitions). Respecte aussi le réglage d'accessibilité de Windows.", switchHtml(g.reduced_motion, "data-motion"))}
    ${setting("Panneau contextuel", "Afficher le panneau de contexte à droite des conversations.", switchHtml(g.context_panel, "data-ctxpanel"))}`;
  const up = (patch) => ctx.updateSettings({ general: patch }).then(() => toast("Réglage enregistré.", { kind: "ok", duration: 1500 }));
  body.querySelectorAll("[data-theme]").forEach((b) => b.onclick = async () => {
    await up({ theme: b.dataset.theme });
    body.querySelectorAll("[data-theme]").forEach((x) => x.classList.toggle("active", x === b));
  });
  body.querySelector("[data-lang]").onchange = (e) => up({ reply_language: e.target.value });
  body.querySelector("[data-startup]").onchange = (e) => up({ startup: e.target.value });
  body.querySelector("[data-window]").onchange = (e) => up({ window: e.target.value });
  body.querySelector("[data-motion]").onchange = (e) => up({ reduced_motion: e.target.checked });
  body.querySelector("[data-ctxpanel]").onchange = (e) => up({ context_panel: e.target.checked });
  body.querySelector("[data-notif]").onchange = async (e) => {
    if (e.target.checked && "Notification" in window && Notification.permission !== "granted") {
      const p = await Notification.requestPermission();
      if (p !== "granted") { e.target.checked = false; toast("Notifications refusées par le navigateur.", { kind: "err" }); return; }
    }
    up({ notifications: e.target.checked });
  };
}

// -- Intelligence artificielle ---------------------------------------------------------------
async function ai(body, ctx) {
  const draw = async (refresh = false) => {
    const s = state.settings.ai;
    const catalog = await ctx.refreshCatalog(refresh);
    const oll = catalog.providers.find((p) => p.id === "ollama");
    const remote = state.settings.providers.remote;
    const localModels = catalog.providers.filter((p) => p.is_local && p.ok).flatMap((p) => p.models);
    const remoteModels = catalog.providers.filter((p) => !p.is_local && p.ok).flatMap((p) => p.models);
    const ocfg = state.settings.providers.ollama;
    body.innerHTML = `<h1 style="font-size:20px" class="mb-8">Intelligence artificielle</h1>
      <div class="section-title">Mode d'utilisation</div>
      <div class="segmented mb-8">${Object.entries(MODE_INFO).map(([k, v]) => `<button data-mode="${k}" class="${k === s.mode ? "active" : ""}">${icon(v.icon, 14)}${v.label}</button>`).join("")}</div>
      <div class="muted small mb-8">${esc(MODE_INFO[s.mode].desc)}</div>
      ${setting("Le mode automatique peut utiliser un service distant", "Si aucun modèle local adapté n'est disponible (ou en cas de panne locale), bascule vers le modèle distant par défaut. Toujours indiqué dans la réponse.", switchHtml(s.auto_allow_remote, "data-autoremote"))}

      <div class="section"><div class="section-title">${icon("hard-drive", 15)}Ollama (modèles locaux)</div>
        <div class="provider-card"><div class="pc-head"><span class="dot ${oll?.ok ? "ok" : "err"}"></span><span class="pc-name">Ollama</span>
          ${switchHtml(ocfg.enabled, 'data-ollama-enabled title="Activer Ollama"')}</div>
          <div class="muted small mt-8">${oll ? (oll.ok ? `${oll.models.length} modèle(s) de conversation installé(s).` : esc(oll.error)) : "Désactivé."}</div>
          <div class="row mt-8"><input class="input grow mono" data-ollama-url value="${esc(ocfg.base_url)}" aria-label="Adresse d'Ollama">
            <button class="btn" data-ollama-save>Enregistrer</button><button class="btn" data-ollama-test>${icon("activity", 14)}Tester</button></div>
          <div class="small mt-8" data-ollama-result></div>
          ${oll?.ok ? `<table class="model-table">${oll.models.map((m) => `<tr><td class="mname">${esc(m.name)}</td>
            <td><div class="capset">${m.capabilities.filter((c) => !["text", "streaming"].includes(c)).map((c) => `<span class="badge">${{ vision: "images", tools: "outils", code: "code", thinking: "raisonnement" }[c] || c}</span>`).join("")}</div></td>
            <td class="muted small">${m.context_length ? `${Math.round(m.context_length / 1024)}k contexte` : ""}</td><td class="muted small">${formatSize(m.size_bytes)}</td></tr>`).join("")}</table>` : ""}
          ${oll && !oll.ok ? `<div class="notice info mt-8">${icon("info", 16)}<div>Installez Ollama depuis <b>ollama.com</b>, lancez-le, puis cliquez sur « Tester ». NexaAI fonctionne sans clé API en mode local.</div></div>` : ""}
          <div class="field mt-16"><label>Télécharger un modèle (nom Ollama)</label>
            <div class="row"><input class="input grow mono" data-pull placeholder="llama3.2, qwen2.5-coder, gemma3, llava…"><button class="btn" data-pullbtn ${oll?.ok ? "" : 'disabled title="Ollama doit être lancé"'}>${icon("download", 14)}Télécharger</button></div>
            <div class="help">Taille indicative : 2 à 8 Go. Choisissez un modèle adapté à votre mémoire (8 Go de RAM : modèles de 3 à 4 milliards de paramètres).</div>
            <div data-pullprogress></div></div>
        </div>
        ${setting("Modèle local par défaut", "Utilisé en mode local et en priorité en mode automatique.", select("data-localmodel", [["", "Premier modèle disponible"], ...localModels.map((m) => [m.ref, m.name])], s.local_model))}
      </div>

      <div class="section"><div class="section-title">${icon("cloud", 15)}Fournisseurs compatibles OpenAI<span class="spacer"></span><button class="btn sm" data-addprov>${icon("plus", 14)}Ajouter</button></div>
        <div class="muted small mb-8">Services distants (OpenAI, Mistral, Groq, OpenRouter…) ou serveurs locaux de modèles ouverts (LM Studio, llama.cpp). Les clés sont chiffrées avec votre session Windows et ne sont jamais affichées.</div>
        <div data-remote></div>
        ${setting("Modèle distant par défaut", "Utilisé en mode distant.", select("data-remotemodel", [["", "Aucun"], ...remoteModels.map((m) => [m.ref, `${m.name} — ${catalog.providers.find((p) => p.id === m.provider_id)?.name}`])], s.remote_model))}
      </div>

      <div class="section"><div class="section-title">${icon("sliders-horizontal", 15)}Paramètres de génération</div>
        <div class="field"><label>Température : <span data-tv>${s.temperature.toFixed(1).replace(".", ",")}</span></label>
          <input type="range" min="0" max="1.5" step="0.1" value="${s.temperature}" data-temp style="max-width:360px">
          <div class="help">Basse : réponses plus précises et constantes. Haute : plus créatives.</div></div>
        <div class="field"><label>Taille du contexte (jetons, 0 = valeur du modèle)</label><input class="input" type="number" min="0" step="1024" value="${s.num_ctx}" data-ctx style="max-width:200px">
          <div class="help">Plus de contexte = meilleure mémoire de la conversation mais plus de mémoire vive utilisée (Ollama).</div></div>
        <div class="field"><label>Consignes supplémentaires pour NexaAI</label><textarea class="textarea" rows="3" data-extra placeholder="Ex. : Tutoie-moi. Donne des exemples en Python.">${esc(s.system_prompt_extra)}</textarea></div>
        ${setting("Outils de l'agent", "Proposer les outils (fichiers autorisés, applications, mémoire) aux modèles qui les prennent en charge.", switchHtml(s.agent_tools, "data-agent"))}
      </div>`;

    // fournisseurs distants
    const box = body.querySelector("[data-remote]");
    if (!remote.length) box.innerHTML = '<div class="muted small" style="padding:4px 0 10px">Aucun fournisseur configuré.</div>';
    for (const cfg of remote) {
      const info = catalog.providers.find((p) => p.id === cfg.id);
      const card = html(`<div class="provider-card"><div class="pc-head"><span class="dot ${!cfg.enabled ? "" : info?.ok ? "ok" : "err"}"></span>
        <span class="pc-name">${esc(cfg.name)}</span><span class="badge ${cfg.is_local ? "" : "warning"}">${cfg.is_local ? "local" : "distant"}</span>
        ${switchHtml(cfg.enabled, 'data-en title="Activer ce fournisseur"')}</div>
        <div class="muted small mono mt-8">${esc(cfg.base_url)}</div>
        <div class="small mt-8">${!cfg.enabled ? "Désactivé." : info?.ok ? `${info.models.length} modèle(s) accessible(s).` : esc(info?.error || "")}</div>
        <div class="row wrap mt-8">
          <span class="badge ${info?.key?.configured ? "success" : cfg.is_local ? "" : "danger"}">${icon("key-round", 12)}${info?.key?.configured ? `Clé ${esc(info.key.hint)}${info.key.source === "env" ? " (variable d'environnement)" : ""}` : cfg.is_local ? "Sans clé" : "Clé manquante"}</span>
          <span class="spacer" style="flex:1"></span>
          <label class="small muted row">Limite / jour <input class="input" type="number" min="0" value="${cfg.daily_limit || 0}" data-limit style="width:80px;height:28px" title="0 = aucune limite"></label>
          <button class="btn sm" data-key>${icon("key-round", 13)}Clé…</button><button class="btn sm" data-test>${icon("activity", 13)}Tester</button>
          <button class="btn sm ghost danger" data-del>${icon("trash-2", 13)}</button></div>
        <div class="small mt-8" data-result></div></div>`);
      const patch = (p) => api.patch(`/api/providers/${cfg.id}`, p).then(async () => { state.settings = await api.get("/api/settings"); });
      card.querySelector("[data-en]").onchange = async (e) => { await patch({ enabled: e.target.checked }); draw(true); };
      card.querySelector("[data-limit]").onchange = async (e) => { await patch({ daily_limit: Math.max(0, +e.target.value || 0) }); toast("Limite enregistrée.", { kind: "ok" }); };
      card.querySelector("[data-test]").onclick = async (e) => {
        const btn = e.currentTarget;
        btn.disabled = true;
        const r = await api.post(`/api/providers/${cfg.id}/test`);
        card.querySelector("[data-result]").innerHTML = `<span class="dot ${r.ok ? "ok" : "err"}"></span> ${esc(r.detail)}${r.latency_ms ? ` (${r.latency_ms} ms)` : ""}`;
        btn.disabled = false;
      };
      card.querySelector("[data-key]").onclick = () => modal({
        title: `Clé API — ${cfg.name}`,
        body: `<div class="field"><label>Nouvelle clé</label><input class="input mono" type="password" data-k autocomplete="off" placeholder="Collez la clé ici"></div>
          <div class="help">La clé est chiffrée localement (DPAPI sous Windows) et n'est jamais réaffichée, journalisée ni envoyée ailleurs qu'à ce fournisseur.</div>`,
        actions: [
          ...(info?.key?.configured && info.key.source !== "env" ? [{ label: "Supprimer la clé", kind: "danger", run: async () => { await patch({ delete_key: true }); toast("Clé supprimée.", { kind: "ok" }); draw(true); } }] : []),
          { label: "Annuler" },
          { label: "Enregistrer", kind: "primary", run: async (b) => {
            const k = b.querySelector("[data-k]").value.trim();
            if (!k) return false;
            await patch({ api_key: k });
            toast("Clé enregistrée.", { kind: "ok" });
            draw(true);
          } }],
      });
      card.querySelector("[data-del]").onclick = async () => {
        if (!(await confirmDialog({ title: "Retirer ce fournisseur ?", message: `${cfg.name} et sa clé seront supprimés de NexaAI.`, confirm: "Retirer", danger: true }))) return;
        await api.del(`/api/providers/${cfg.id}`);
        state.settings = await api.get("/api/settings");
        draw(true);
      };
      box.append(card);
    }

    const up = (patch) => ctx.updateSettings({ ai: patch });
    body.querySelectorAll("[data-mode]").forEach((b) => b.onclick = async () => { await up({ mode: b.dataset.mode }); draw(); });
    body.querySelector("[data-autoremote]").onchange = (e) => up({ auto_allow_remote: e.target.checked });
    body.querySelector("[data-localmodel]").onchange = (e) => up({ local_model: e.target.value });
    body.querySelector("[data-remotemodel]").onchange = (e) => up({ remote_model: e.target.value });
    body.querySelector("[data-temp]").oninput = (e) => { body.querySelector("[data-tv]").textContent = (+e.target.value).toFixed(1).replace(".", ","); };
    body.querySelector("[data-temp]").onchange = (e) => up({ temperature: +e.target.value });
    body.querySelector("[data-ctx]").onchange = (e) => up({ num_ctx: Math.max(0, parseInt(e.target.value, 10) || 0) }).catch((err) => toast(err.message, { kind: "err" }));
    body.querySelector("[data-extra]").onchange = (e) => up({ system_prompt_extra: e.target.value }).then(() => toast("Consignes enregistrées.", { kind: "ok" }));
    body.querySelector("[data-agent]").onchange = (e) => up({ agent_tools: e.target.checked });
    body.querySelector("[data-ollama-enabled]").onchange = async (e) => {
      await api.patch("/api/providers/ollama", { enabled: e.target.checked });
      state.settings = await api.get("/api/settings");
      draw(true);
    };
    body.querySelector("[data-ollama-save]").onclick = async () => {
      try {
        await api.patch("/api/providers/ollama", { base_url: body.querySelector("[data-ollama-url]").value });
        state.settings = await api.get("/api/settings");
        toast("Adresse enregistrée.", { kind: "ok" });
        draw(true);
      } catch (err) { toast(err.message, { kind: "err" }); }
    };
    body.querySelector("[data-ollama-test]").onclick = async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      const r = await api.post("/api/providers/ollama/test");
      body.querySelector("[data-ollama-result]").innerHTML = `<span class="dot ${r.ok ? "ok" : "err"}"></span> ${esc(r.detail)}${r.version ? ` Version ${esc(r.version)}.` : ""}${r.latency_ms != null ? ` (${r.latency_ms} ms)` : ""}`;
      btn.disabled = false;
      if (r.ok) ctx.refreshCatalog(true);
    };
    body.querySelector("[data-pullbtn]").onclick = () => pull(body, draw);
    body.querySelector("[data-addprov]").onclick = () => addProvider(draw);
  };
  await draw();
}

async function pull(body, redraw) {
  const name = body.querySelector("[data-pull]").value.trim();
  if (!name) { body.querySelector("[data-pull]").focus(); return; }
  const box = body.querySelector("[data-pullprogress]");
  const ctrl = new AbortController();
  box.innerHTML = `<div class="row mt-8"><div class="progress grow"><div style="width:0%"></div></div><span class="small muted" data-st>Démarrage…</span>
    <button class="btn sm ghost" data-cancel>Annuler</button></div>`;
  box.querySelector("[data-cancel]").onclick = () => ctrl.abort();
  try {
    let failed = null;
    await api.stream("POST", "/api/ollama/pull", { model: name }, (ev) => {
      if (ev.type === "progress") {
        const pct = ev.total ? Math.round((ev.completed || 0) / ev.total * 100) : null;
        if (pct != null) box.querySelector(".progress > div").style.width = `${pct}%`;
        box.querySelector("[data-st]").textContent = `${ev.status}${pct != null ? ` — ${pct} %` : ""}`;
      }
      if (ev.type === "error") failed = ev.error;
    }, ctrl.signal);
    if (failed) throw new Error(failed);
    toast(`Modèle « ${name} » installé.`, { kind: "ok" });
    redraw(true);
  } catch (err) {
    box.innerHTML = err.name === "AbortError" ? '<div class="small muted mt-8">Téléchargement annulé.</div>' : `<div class="notice err mt-8">${icon("circle-alert", 16)}<div>${esc(err.message)}</div></div>`;
  }
}

function addProvider(redraw) {
  const presets = state.presets;
  const m = modal({
    title: "Ajouter un fournisseur",
    body: `<div class="field"><label>Type</label><select class="select" data-preset>${Object.entries(presets).map(([k, p]) => `<option value="${k}">${esc(p.name)}</option>`).join("")}</select></div>
      <div class="field"><label>Nom affiché</label><input class="input" data-name></div>
      <div class="field"><label>Adresse de l'API</label><input class="input mono" data-url></div>
      <div class="field" data-keywrap><label>Clé API</label><input class="input mono" type="password" data-key autocomplete="off">
        <div class="help">Obligatoire pour un service distant. Stockée chiffrée sur cet ordinateur.</div></div>
      <label class="row mb-8 hidden" data-localwrap><input type="checkbox" data-local> Ce serveur fonctionne sur cet ordinateur (aucune donnée ne sort)</label>
      <div class="field"><label>Limite de requêtes par jour (0 = aucune)</label><input class="input" type="number" min="0" value="0" data-limit></div>
      <div class="notice warn" data-remotewarn>${icon("cloud", 16)}<div>Avec un fournisseur distant, vos messages (et les fichiers que vous confirmez) sont transmis à ce service, selon ses conditions et tarifs. Les offres gratuites peuvent être limitées ou modifiées par le fournisseur.</div></div>`,
    actions: [{ label: "Annuler" }, { label: "Ajouter", kind: "primary", run: async (b) => {
      try {
        await api.post("/api/providers", { preset: b.querySelector("[data-preset]").value, name: b.querySelector("[data-name]").value,
          base_url: b.querySelector("[data-url]").value, api_key: b.querySelector("[data-key]").value, daily_limit: +b.querySelector("[data-limit]").value || 0,
          is_local: b.querySelector("[data-local]").checked });
        state.settings = await api.get("/api/settings");
        toast("Fournisseur ajouté.", { kind: "ok" });
        redraw(true);
      } catch (err) { toast(err.message, { kind: "err" }); return false; }
    } }],
  });
  const custom = () => m.body.querySelector("[data-preset]").value === "custom";
  const isLocal = () => (custom() ? m.body.querySelector("[data-local]").checked : presets[m.body.querySelector("[data-preset]").value].is_local);
  const sync = () => {
    const p = presets[m.body.querySelector("[data-preset]").value];
    m.body.querySelector("[data-name]").value = p.name;
    m.body.querySelector("[data-url]").value = p.base_url;
    m.body.querySelector("[data-localwrap]").classList.toggle("hidden", !custom());
    m.body.querySelector("[data-local]").checked = false;
    m.body.querySelector("[data-remotewarn]").classList.toggle("hidden", isLocal());
  };
  m.body.querySelector("[data-preset]").onchange = sync;
  m.body.querySelector("[data-local]").onchange = () => m.body.querySelector("[data-remotewarn]").classList.toggle("hidden", isLocal());
  sync();
}

// -- Voix / Vision (raccourcis vers les espaces dédiés) --------------------------------------
function voiceSection(body, ctx) {
  const v = state.settings.voice;
  body.innerHTML = `<h1 style="font-size:20px" class="mb-8">Voix</h1>
    ${setting("Lecture automatique des réponses", "", switchHtml(v.auto_read, "data-autoread"))}
    ${setting("Conversation vocale continue", "Envoi automatique après la dictée et lecture de la réponse.", switchHtml(v.continuous, "data-continuous"))}
    ${setting("Langue de dictée", "", `<span class="mono">${esc(v.stt_lang)}</span>`)}
    ${setting("Microphone, voix, vitesse, volume et tests", "Réglages détaillés et tests dans l'espace Voix.", `<button class="btn" data-open>${icon("audio-lines", 15)}Ouvrir l'espace Voix</button>`)}`;
  body.querySelector("[data-autoread]").onchange = (e) => ctx.updateSettings({ voice: { auto_read: e.target.checked } });
  body.querySelector("[data-continuous]").onchange = (e) => ctx.updateSettings({ voice: { continuous: e.target.checked } });
  body.querySelector("[data-open]").onclick = () => ctx.navigate("#/voice");
}

function visionSection(body, ctx) {
  const v = state.settings.vision;
  body.innerHTML = `<h1 style="font-size:20px" class="mb-8">Vision</h1>
    <div class="notice info mb-8">${icon("camera-off", 16)}<div>La caméra est toujours éteinte au démarrage. Aucune image n'est enregistrée ni envoyée.</div></div>
    ${setting("Mode test des gestes", "Reconnaître sans exécuter d'action.", switchHtml(v.test_mode, "data-test"))}
    ${setting("Afficher les repères de la main", "", switchHtml(v.show_landmarks, "data-lm"))}
    ${setting(`Fréquence d'analyse maximale : <span data-fv>${v.max_fps}</span> images/s`, "Réduisez-la sur un ordinateur peu puissant.", `<input type="range" min="5" max="30" step="1" value="${v.max_fps}" data-fps style="width:200px">`)}
    ${setting("Seuil, stabilité, anti-répétition, caméra et bibliothèque des gestes", "", `<button class="btn" data-open>${icon("scan-eye", 15)}Ouvrir Vision et gestes</button>`)}`;
  body.querySelector("[data-test]").onchange = (e) => ctx.updateSettings({ vision: { test_mode: e.target.checked } });
  body.querySelector("[data-lm]").onchange = (e) => ctx.updateSettings({ vision: { show_landmarks: e.target.checked } });
  body.querySelector("[data-fps]").oninput = (e) => { body.querySelector("[data-fv]").textContent = e.target.value; };
  body.querySelector("[data-fps]").onchange = (e) => ctx.updateSettings({ vision: { max_fps: +e.target.value } });
  body.querySelector("[data-open]").onclick = () => ctx.navigate("#/vision");
}

function memory(body, ctx) {
  const m = state.settings.memory;
  body.innerHTML = `<h1 style="font-size:20px" class="mb-8">Mémoire</h1>
    ${setting("Mémoire activée", "Désactivée : rien n'est ajouté ni transmis aux modèles.", switchHtml(m.enabled, "data-en"))}
    ${setting("Fournir la mémoire aux modèles", "", switchHtml(m.inject, "data-inj"))}
    ${setting("Consulter, modifier ou supprimer les informations", "", `<button class="btn" data-open>${icon("brain", 15)}Ouvrir la mémoire</button>`)}`;
  body.querySelector("[data-en]").onchange = (e) => ctx.updateSettings({ memory: { enabled: e.target.checked } });
  body.querySelector("[data-inj]").onchange = (e) => ctx.updateSettings({ memory: { inject: e.target.checked } });
  body.querySelector("[data-open]").onclick = () => ctx.navigate("#/memory");
}

// -- Confidentialité -----------------------------------------------------------------------
async function privacy(body, ctx) {
  const info = await api.get("/api/system/info");
  const cat = state.catalog || (await ctx.refreshCatalog());
  const remote = cat.providers.filter((p) => !p.is_local);
  const st = info.stats;
  body.innerHTML = `<h1 style="font-size:20px" class="mb-8">Confidentialité</h1>
    <div class="section-title">${icon("hard-drive", 15)}Données conservées sur cet ordinateur</div>
    <div class="muted small mb-8">Dossier : <span class="mono">${esc(info.data_dir)}</span></div>
    <dl class="kv mb-8"><dt>Conversations</dt><dd>${st.conversations} (${st.messages} messages)</dd><dt>Projets</dt><dd>${st.projects}</dd>
      <dt>Mémoire</dt><dd>${st.memory} information(s)</dd><dt>Gestes</dt><dd>${st.gestures} (${st.gesture_samples} exemples, sans image)</dd>
      <dt>Journal des actions</dt><dd>${st.action_log} entrée(s)</dd><dt>Pièces jointes</dt><dd>${st.attachments} fichier(s) copié(s)</dd></dl>
    <div class="row"><button class="btn" data-export>${icon("download", 15)}Exporter mes données (JSON)</button></div>

    <div class="section-title mt-16">${icon("cloud", 15)}Données envoyées à des services</div>
    <div class="list">
      <div class="list-item"><div class="li-main"><div class="li-title">Mode local (Ollama, serveurs locaux)</div><div class="li-sub">Rien ne quitte l'ordinateur.</div></div></div>
      <div class="list-item"><div class="li-main"><div class="li-title">Mode distant ou bascule automatique autorisée</div>
        <div class="li-sub">Messages, contexte (mémoire fournie, notes de projet) et fichiers confirmés sont envoyés au fournisseur choisi. ${remote.length ? `Configurés : ${remote.map((p) => esc(p.name)).join(", ")}.` : "Aucun fournisseur distant configuré."}</div></div></div>
      <div class="list-item"><div class="li-main"><div class="li-title">Dictée vocale</div><div class="li-sub">Service de reconnaissance en ligne du navigateur (Microsoft pour Edge, Google pour Chrome), uniquement quand vous dictez.</div></div></div>
      <div class="list-item"><div class="li-main"><div class="li-title">Vision et gestes</div><div class="li-sub">Traitement 100 % local. Le moteur est téléchargé une seule fois, sur demande.</div></div></div>
    </div>

    <div class="section-title mt-16">${icon("key-round", 15)}Clés API</div>
    <div class="list">${remote.length ? remote.map((p) => `<div class="list-item"><div class="li-main"><div class="li-title">${esc(p.name)}</div>
      <div class="li-sub">${p.key?.configured ? `Clé ${esc(p.key.hint)} — ${p.key.source === "env" ? "variable d'environnement" : p.key.encrypted ? "chiffrée (DPAPI Windows)" : "fichier protégé (droits utilisateur)"}` : "Aucune clé"}</div></div></div>`).join("")
      : '<div class="muted small" style="padding:8px 4px">Aucune clé enregistrée.</div>'}</div>
    <div class="muted small mt-8">Gestion des clés : Paramètres › Intelligence artificielle.</div>

    <div class="section-title mt-16">${icon("shield-check", 15)}Permissions</div>
    <dl class="kv"><dt>Dossiers autorisés</dt><dd>${(await api.get("/api/files/folders")).items.length} — <a href="#/files">gérer</a></dd>
      <dt>Applications autorisées</dt><dd>${(await api.get("/api/pc/apps")).items.length} — <a href="#/pc">gérer</a></dd>
      <dt>Caméra / micro</dt><dd>Accordés au navigateur de NexaAI, utilisés seulement sur votre action.</dd></dl>`;
  body.querySelector("[data-export]").onclick = async () => {
    const data = await api.get("/api/system/export");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
    a.download = `nexaai-export-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  };
}

// -- Raccourcis ------------------------------------------------------------------------------
function shortcuts(body, ctx) {
  const draw = () => {
    const sc = state.settings.shortcuts;
    body.innerHTML = `<h1 style="font-size:20px" class="mb-8">Raccourcis clavier</h1>
      <div class="muted small mb-8">Les raccourcis sans touche Ctrl ou Alt ne s'activent pas pendant la saisie de texte. Échap ferme d'abord les menus et fenêtres.</div>
      ${Object.keys(DEFAULT_SHORTCUTS).map((k) => setting(SHORTCUT_LABELS[k], "", `<kbd style="font-size:12.5px;padding:2px 8px" data-kbd="${k}">${esc(sc[k])}</kbd>
        <button class="btn sm" data-edit="${k}">Modifier</button>`)).join("")}
      <div class="row mt-16"><button class="btn" data-reset>${icon("rotate-ccw", 14)}Rétablir les valeurs par défaut</button></div>`;
    body.querySelectorAll("[data-edit]").forEach((b) => b.onclick = () => capture(b.dataset.edit));
    body.querySelector("[data-reset]").onclick = async () => { await ctx.updateSettings({ shortcuts: { ...DEFAULT_SHORTCUTS } }); draw(); toast("Raccourcis rétablis.", { kind: "ok" }); };
  };
  const capture = (key) => {
    const kbd = body.querySelector(`[data-kbd="${key}"]`);
    kbd.textContent = "Appuyez sur la combinaison…";
    const handler = async (e) => {
      e.preventDefault();
      e.stopPropagation();
      const combo = eventToShortcut(e);
      if (!combo) return;
      document.removeEventListener("keydown", handler, true);
      if (combo === "Escape" && key !== "stop") { draw(); return; }
      const clash = Object.entries(state.settings.shortcuts).find(([k, v]) => v === combo && k !== key);
      if (clash) { toast(`Déjà utilisé pour « ${SHORTCUT_LABELS[clash[0]]} ».`, { kind: "err" }); draw(); return; }
      if (!/^(Ctrl|Alt)/.test(combo) && !["Escape", "F1", "F2", "F3", "F4", "F6", "F7", "F8", "F9", "F10"].includes(combo)) {
        toast("Utilisez Ctrl ou Alt (ou une touche de fonction) pour ne pas gêner la saisie.", { kind: "err" }); draw(); return;
      }
      await ctx.updateSettings({ shortcuts: { [key]: combo } });
      toast(`Raccourci enregistré : ${combo}`, { kind: "ok" });
      draw();
    };
    document.addEventListener("keydown", handler, true);
  };
  draw();
}

// -- Système ----------------------------------------------------------------------------------
async function system(body, ctx) {
  const draw = async () => {
    const info = await api.get("/api/system/info");
    body.innerHTML = `<h1 style="font-size:20px" class="mb-8">Système</h1>
      <dl class="kv mb-8"><dt>Version</dt><dd>NexaAI ${esc(info.version)}</dd><dt>Python</dt><dd>${esc(info.python)}</dd><dt>Système</dt><dd>${esc(info.platform)}</dd>
        <dt>Adresse locale</dt><dd class="mono">${esc(info.url)}</dd><dt>Données</dt><dd class="mono">${esc(info.data_dir)}</dd>
        <dt>Lancement</dt><dd class="mono">${esc(info.launch_command)}</dd></dl>
      <div class="section-title mt-16">${icon("activity", 15)}Diagnostics<span class="spacer"></span><button class="btn sm" data-diag>${icon("refresh-cw", 14)}Relancer</button></div>
      <div class="list">${info.dependencies.map((d) => `<div class="list-item"><span class="dot ${d.ok ? "ok" : "err"}"></span><div class="li-main"><div class="li-title">${esc(d.name)}</div><div class="li-sub">${esc(d.detail || "")}</div></div></div>`).join("")}
        <div class="list-item"><span class="dot ${"speechSynthesis" in window ? "ok" : "err"}"></span><div class="li-main"><div class="li-title">Synthèse vocale du navigateur</div><div class="li-sub">${"speechSynthesis" in window ? "disponible" : "indisponible"}</div></div></div>
        <div class="list-item"><span class="dot ${(window.SpeechRecognition || window.webkitSpeechRecognition) ? "ok" : "err"}"></span><div class="li-main"><div class="li-title">Reconnaissance vocale du navigateur</div><div class="li-sub">${(window.SpeechRecognition || window.webkitSpeechRecognition) ? "disponible (service en ligne du navigateur)" : "indisponible — utilisez Edge ou Chrome"}</div></div></div></div>
      <div class="section-title mt-16">${icon("file-text", 15)}Journal<span class="spacer"></span><button class="btn sm ghost" data-copylog>${icon("copy", 14)}Copier</button><button class="btn sm ghost" data-reload>${icon("refresh-cw", 14)}Actualiser</button></div>
      <div class="muted small mb-8 mono">${esc(info.log_file)} — les clés API sont masquées.</div>
      <div class="log-lines" data-log>Chargement…</div>
      <div class="section-title mt-16">${icon("power", 15)}Application</div>
      ${setting("Quitter NexaAI", "Interrompt les générations en cours, ferme la base de données et arrête le serveur local.", `<button class="btn danger" data-quit>${icon("power", 14)}Quitter</button>`)}`;
    const logs = async () => {
      const { lines } = await api.get("/api/system/logs?lines=200");
      const el = body.querySelector("[data-log]");
      el.textContent = lines.join("\n") || "Journal vide.";
      el.scrollTop = el.scrollHeight;
      return lines;
    };
    const lines = await logs();
    body.querySelector("[data-reload]").onclick = logs;
    body.querySelector("[data-copylog]").onclick = (e) => copyText(lines.join("\n"), e.currentTarget);
    body.querySelector("[data-diag]").onclick = async () => { await ctx.refreshCatalog(true); draw(); };
    body.querySelector("[data-quit]").onclick = () => import("../commands.js").then((c) => c.getCommand("app.quit").run());
  };
  await draw();
  chat.refreshRecents();
}
