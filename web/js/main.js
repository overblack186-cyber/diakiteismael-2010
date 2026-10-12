// Point d'entrée de l'interface : structure, navigation, commandes et raccourcis.
import { api } from "./api.js";
import * as chat from "./chat-controller.js";
import { getCommand, isTyping, matchShortcut, openPalette, paletteOpen, register, registerProvider } from "./commands.js";
import { createCompanion, setCompanionActions } from "./companion.js";
import { icon } from "./icons.js";
import { emit, on, set, setSystem, state } from "./store.js";
import { closePopover, confirmDialog, esc, html, menu, popover, toast } from "./ui.js";
import { vision } from "./vision/hands.js";
import { voice } from "./voice.js";

const views = {
  chat: () => import("./views/chat.js"),
  search: () => import("./views/search.js"),
  history: () => import("./views/history.js"),
  projects: () => import("./views/projects.js"),
  memory: () => import("./views/memory.js"),
  files: () => import("./views/files.js"),
  studio: () => import("./views/studio.js"),
  vision: () => import("./views/vision.js"),
  voice: () => import("./views/voice.js"),
  pc: () => import("./views/pc.js"),
  settings: () => import("./views/settings.js"),
};

const NAV = [
  { group: null, items: [
    { id: "new", label: "Nouvelle conversation", icon: "square-pen", run: () => newChat(), shortcut: "new_chat" },
    { id: "search", label: "Rechercher", icon: "search", route: "#/search", shortcut: "search" },
    { id: "history", label: "Historique", icon: "history", route: "#/history" },
  ] },
  { group: "Espace de travail", items: [
    { id: "projects", label: "Projets", icon: "folder-kanban", route: "#/projects" },
    { id: "memory", label: "Mémoire", icon: "brain", route: "#/memory" },
    { id: "files", label: "Fichiers", icon: "folder", route: "#/files" },
    { id: "studio", label: "Création et code", icon: "code-xml", route: "#/studio" },
  ] },
  { group: "Perception et système", items: [
    { id: "vision", label: "Vision et gestes", icon: "scan-eye", route: "#/vision" },
    { id: "voice", label: "Voix", icon: "audio-lines", route: "#/voice" },
    { id: "pc", label: "Contrôle du PC", icon: "monitor-cog", route: "#/pc" },
  ] },
];

const root = document.getElementById("app");
let currentView = null;   // {name, cleanup}
let contextRenderer = null;
let viewToken = 0;

// -- Contexte partagé avec les vues --------------------------------------------
export const ctx = {
  navigate(hash) { if (location.hash === hash) route(); else location.hash = hash; },
  async updateSettings(patch) {
    const settings = await api.patch("/api/settings", patch);
    set("settings", settings);
    applyAppearance();
    return settings;
  },
  async refreshCatalog(refresh = false) {
    try {
      const catalog = await api.get(`/api/models${refresh ? "?refresh=1" : ""}`);
      state.catalogError = null;
      set("catalog", catalog);
    } catch (err) {
      state.catalogError = err.message;
      set("catalog", { providers: [] });
    }
    return state.catalog;
  },
  setContext(renderer) {
    contextRenderer = renderer;
    renderContext();
  },
  toggleContext(force) {
    const open = force ?? !state.settings.general.context_panel;
    ctx.updateSettings({ general: { context_panel: open } }).then(renderContext);
  },
  renderContext: () => renderContext(),
  chooseModel: (anchor, opts) => chooseModel(anchor, opts),
  newChat: (projectId) => newChat(projectId),
};

// -- Apparence ---------------------------------------------------------------------
function applyAppearance() {
  const g = state.settings.general;
  document.documentElement.dataset.theme = g.theme;
  document.documentElement.dataset.motion = g.reduced_motion ? "reduced" : "full";
  root.classList.toggle("sidebar-collapsed", g.sidebar_collapsed);
}

// -- Structure -----------------------------------------------------------------------
function buildShell() {
  root.innerHTML = "";
  const side = html(`<aside class="sidebar" aria-label="Navigation principale">
    <div class="side-head">
      <span class="companion-slot"></span>
      <div class="side-brand-text"><div class="side-brand-name">NexaAI</div><div class="side-brand-status" id="engine-status"><span class="dot"></span><span>Connexion…</span></div></div>
    </div>
    <nav class="side-nav" id="side-nav"></nav>
    <div class="side-recents scroll" id="side-recents"></div>
    <div class="camera-indicator hidden" id="camera-indicator" role="status">
      <button class="ci-main" title="La caméra est active — ouvrir la vision"><span class="dot"></span><span class="ci-text label">Caméra active</span></button>
      <button class="icon-btn sm ci-stop" title="Éteindre la caméra" aria-label="Éteindre la caméra">${icon("camera-off", 15)}</button>
    </div>
    <div class="side-foot">
      <button class="nav-item" data-nav="settings" title="Paramètres">${icon("settings", 18)}<span class="label">Paramètres</span></button>
      <button class="nav-item collapse-btn" id="collapse-btn" title="Réduire la barre latérale (${state.settings.shortcuts.toggle_sidebar})">${icon("panel-left", 18)}<span class="label">Réduire</span></button>
    </div>
  </aside>`);
  side.querySelector(".companion-slot").append(createCompanion(38, { badge: true }));
  const nav = side.querySelector("#side-nav");
  for (const group of NAV) {
    const g = html('<div class="side-group"></div>');
    if (group.group) g.append(html(`<div class="side-group-label">${esc(group.group)}</div>`));
    for (const item of group.items) {
      const hint = item.shortcut ? state.settings.shortcuts[item.shortcut] : "";
      const b = html(`<button class="nav-item" data-nav="${item.id}" title="${esc(item.label)}${hint ? ` (${hint})` : ""}">${icon(item.icon, 18)}
        <span class="label">${esc(item.label)}</span>${item.id === "vision" ? '<span class="live-dot hidden" id="cam-dot" title="Caméra active"></span>' : ""}
</button>`);
      b.onclick = () => (item.run ? item.run() : ctx.navigate(item.route));
      g.append(b);
    }
    nav.append(g);
  }
  side.querySelector('[data-nav="settings"]').onclick = () => ctx.navigate("#/settings");
  side.querySelector("#collapse-btn").onclick = () => toggleSidebar();
  side.querySelector(".ci-main").onclick = () => ctx.navigate("#/vision");
  side.querySelector(".ci-stop").onclick = () => { vision.stopCamera(); toast("Caméra désactivée.", { kind: "ok" }); };
  const main = html('<main class="main" id="main"><div class="view" id="view"></div></main>');
  const context = html('<aside class="context hidden" id="context" aria-label="Panneau contextuel"></aside>');
  root.append(side, main, context);
  root.removeAttribute("aria-busy");
  renderRecents();
  renderEngineStatus();
  renderCameraIndicator();
}

function toggleSidebar() {
  ctx.updateSettings({ general: { sidebar_collapsed: !state.settings.general.sidebar_collapsed } });
}

function renderRecents() {
  const box = document.getElementById("side-recents");
  if (!box) return;
  const current = state.route.name === "chat" ? state.route.params.id : null;
  const items = state.conversations.filter((c) => c.message_count > 0 || c.id === current).slice(0, 30);
  box.innerHTML = '<div class="side-group-label">Récentes</div>';
  if (!items.length) {
    box.append(html('<div class="side-empty">Aucune conversation pour l\'instant.</div>'));
    return;
  }
  for (const c of items) {
    const generating = chat.getConv(c.id)?.streaming;
    const b = html(`<button class="recent-item ${c.id === current ? "active" : ""}" title="${esc(c.title)}">${generating ? '<span class="gen"></span>' : ""}${esc(c.title)}</button>`);
    b.onclick = () => ctx.navigate(`#/chat/${c.id}`);
    b.oncontextmenu = (e) => { e.preventDefault(); conversationMenu({ x: e.clientX, y: e.clientY }, c); };
    box.append(b);
  }
}

export function conversationMenu(anchor, conv, { onChange } = {}) {
  menu(anchor, [
    { label: "Ouvrir", icon: "message-square", run: () => ctx.navigate(`#/chat/${conv.id}`) },
    { label: "Renommer", icon: "pencil", run: () => renameConversation(conv, onChange) },
    { label: conv.archived ? "Désarchiver" : "Archiver", icon: conv.archived ? "archive-restore" : "archive", run: async () => {
      await api.patch(`/api/conversations/${conv.id}`, { archived: !conv.archived });
      toast(conv.archived ? "Conversation désarchivée." : "Conversation archivée.", { kind: "ok" });
      await chat.refreshRecents();
      onChange?.();
    } },
    "sep",
    { label: "Supprimer…", icon: "trash-2", danger: true, run: () => deleteConversation(conv, onChange) },
  ]);
}

export async function renameConversation(conv, onChange) {
  const { promptDialog } = await import("./ui.js");
  const title = await promptDialog({ title: "Renommer la conversation", label: "Titre", value: conv.title });
  if (!title) return;
  const updated = await api.patch(`/api/conversations/${conv.id}`, { title });
  chat.patchConvLocal(updated);
  await chat.refreshRecents();
  onChange?.();
}

export async function deleteConversation(conv, onChange) {
  const ok = await confirmDialog({ title: "Supprimer la conversation ?", message: `« ${conv.title} » et tous ses messages seront définitivement supprimés.`, confirm: "Supprimer", danger: true });
  if (!ok) return;
  await api.del(`/api/conversations/${conv.id}`);
  chat.forget(conv.id);
  await chat.refreshRecents();
  toast("Conversation supprimée.", { kind: "ok" });
  if (state.route.name === "chat" && state.route.params.id === conv.id) ctx.navigate("#/chat");
  onChange?.();
}

function renderEngineStatus() {
  const el = document.getElementById("engine-status");
  if (!el) return;
  const mode = state.settings.ai.mode;
  const providers = state.catalog?.providers || [];
  const local = providers.filter((p) => p.is_local);
  const models = providers.flatMap((p) => (p.ok ? p.models : []));
  let dot = "", text;
  if (!state.catalog) text = "Connexion…";
  else if (mode === "remote") {
    const remote = providers.filter((p) => !p.is_local && p.ok);
    dot = remote.length ? "ok" : "err";
    text = remote.length ? `Distant · ${remote[0].name}` : "Aucun fournisseur distant";
  } else {
    const ok = local.some((p) => p.ok);
    const localModels = local.flatMap((p) => (p.ok ? p.models : []));
    dot = ok && localModels.length ? "ok" : ok ? "warn" : "err";
    text = !ok ? "Moteur local hors ligne" : localModels.length ? `${mode === "auto" ? "Auto" : "Local"} · ${localModels.length} modèle${localModels.length > 1 ? "s" : ""}` : "Aucun modèle local";
  }
  el.innerHTML = `<span class="dot ${dot}"></span><span>${esc(text)}</span>`;
  el.title = models.length ? models.map((m) => m.name).join(", ") : (state.catalogError || "");
}

// -- Panneau contextuel ------------------------------------------------------------
function renderContext() {
  const panel = document.getElementById("context");
  if (!panel) return;
  const open = state.settings.general.context_panel && !!contextRenderer;
  panel.classList.toggle("hidden", !open);
  if (!open) { panel.innerHTML = ""; return; }
  panel.innerHTML = `<div class="context-head"><span>Contexte</span><span class="spacer"></span>
    <button class="icon-btn sm" title="Fermer le panneau" aria-label="Fermer le panneau">${icon("x", 16)}</button></div>
    <div class="context-body scroll"></div>`;
  panel.querySelector(".icon-btn").onclick = () => ctx.toggleContext(false);
  contextRenderer(panel.querySelector(".context-body"));
}

/** Met en évidence la destination active et la conversation ouverte. */
export function syncNav() {
  const r = state.route;
  document.querySelectorAll(".nav-item[data-nav]").forEach((b) => {
    const id = b.dataset.nav;
    b.classList.toggle("active", id === r.name || (id === "new" && r.name === "chat" && !r.params.id));
  });
  renderRecents();
}

// -- Routage ---------------------------------------------------------------------------
function parseRoute() {
  const raw = location.hash.replace(/^#\/?/, "");
  const [path, query = ""] = raw.split("?");
  const parts = path.split("/").filter(Boolean);
  const name = views[parts[0]] ? parts[0] : "chat";
  const params = Object.fromEntries(new URLSearchParams(query));
  if (parts[1]) params.id = decodeURIComponent(parts[1]);
  if (parts[2]) params.sub = decodeURIComponent(parts[2]);
  return { name, params };
}

async function route() {
  const r = parseRoute();
  const token = ++viewToken;
  closePopover();
  if (currentView?.cleanup) { try { currentView.cleanup(); } catch (err) { console.error(err); } }
  currentView = null;
  contextRenderer = null;
  set("route", r);
  syncNav();
  const container = document.getElementById("view");
  container.innerHTML = '<div class="page" style="display:grid;place-items:center"><div class="spinner"></div></div>';
  try {
    const mod = await views[r.name]();
    if (token !== viewToken) return;
    container.innerHTML = "";
    const cleanup = await mod.render(container, r.params, ctx);
    if (token !== viewToken) { cleanup?.(); return; }
    currentView = { name: r.name, cleanup };
  } catch (err) {
    console.error(err);
    if (token !== viewToken) return;
    container.innerHTML = `<div class="page"><div class="page-inner"><div class="notice err">${icon("circle-alert", 16)}<div>
      Impossible d'afficher cette page : ${esc(err.message)}</div></div></div></div>`;
  }
  renderContext();
}

// -- Actions principales -----------------------------------------------------------------
async function newChat(projectId = null) {
  const cur = state.route.name === "chat" && state.route.params.id ? chat.getConv(state.route.params.id) : null;
  if (cur && !cur.messages.length && !cur.streaming && !projectId) {
    document.querySelector(".composer textarea")?.focus();
    return;
  }
  try {
    const conv = await chat.createConversation(projectId);
    ctx.navigate(`#/chat/${conv.id}`);
  } catch (err) {
    toast(err.message, { kind: "err" });
  }
}

const MODE_INFO = {
  local: { label: "Local", icon: "hard-drive", desc: "Modèles exécutés sur cet ordinateur. Aucun envoi sur Internet." },
  remote: { label: "Distant", icon: "cloud", desc: "Le fournisseur choisi reçoit vos messages. Peut être payant." },
  auto: { label: "Automatique", icon: "zap", desc: "Choisit le modèle selon la tâche ; local privilégié." },
};
export { MODE_INFO };

function capsBadges(m) {
  const names = { vision: "images", tools: "outils", code: "code", thinking: "raisonnement" };
  return m.capabilities.filter((c) => names[c]).map((c) => `<span class="badge">${names[c]}</span>`).join("");
}

/** Sélecteur de modèle : ne propose que les modèles réellement accessibles dans le mode actif. */
async function chooseModel(anchor, { conversationId = null } = {}) {
  if (!state.catalog) await ctx.refreshCatalog();
  const mode = state.settings.ai.mode;
  const conv = conversationId ? chat.getConv(conversationId)?.conv : null;
  const current = conv?.model_pref || (mode === "remote" ? state.settings.ai.remote_model : state.settings.ai.local_model);
  const box = document.createElement("div");
  box.style.width = "360px";
  const seg = html(`<div style="padding:6px 6px 8px"><div class="segmented" style="width:100%">${Object.entries(MODE_INFO).map(([k, v]) =>
    `<button data-mode="${k}" class="${k === mode ? "active" : ""}" style="flex:1;justify-content:center">${icon(v.icon, 14)}${v.label}</button>`).join("")}</div>
    <div class="menu-note" style="padding:8px 4px 0">${esc(MODE_INFO[mode].desc)}</div></div>`);
  seg.querySelectorAll("[data-mode]").forEach((b) => b.onclick = async () => {
    await ctx.updateSettings({ ai: { mode: b.dataset.mode } });
    chooseModel(anchor, { conversationId });
  });
  box.append(seg, html('<div class="menu-sep"></div>'));
  const providers = (state.catalog?.providers || []).filter((p) => mode === "auto"
    ? (p.is_local || state.settings.ai.auto_allow_remote) : mode === "local" ? p.is_local : !p.is_local);
  const list = html('<div class="scroll" style="max-height:340px"></div>');
  if (mode === "auto" && conv) {
    const b = html(`<button class="menu-item ${!conv.model_pref ? "checked" : ""}">${icon("zap", 16)}<span class="mi-label">Automatique (selon la tâche)</span>${!conv.model_pref ? `<span class="mi-check">${icon("check", 15)}</span>` : ""}</button>`);
    b.onclick = () => pick("");
    list.append(b);
  }
  for (const p of providers) {
    list.append(html(`<div class="menu-head">${esc(p.name)} · ${p.is_local ? "local" : "distant"}</div>`));
    if (!p.ok) { list.append(html(`<div class="menu-note">${esc(p.error)}</div>`)); continue; }
    if (!p.models.length) { list.append(html('<div class="menu-note">Aucun modèle installé.</div>')); continue; }
    for (const m of p.models) {
      const checked = m.ref === current;
      const b = html(`<button class="menu-item ${checked ? "checked" : ""}" style="height:auto;min-height:34px;padding-top:6px;padding-bottom:6px" title="${esc(m.ref)}">
        ${icon(p.is_local ? "hard-drive" : "cloud", 16)}<span class="mi-label"><span class="mono" style="font-size:12.5px">${esc(m.name)}</span>
        <span class="capset" style="margin-top:3px">${capsBadges(m)}${m.capability_source === "estimated" ? '<span class="badge" title="Capacités déduites du nom du modèle">estimé</span>' : ""}</span></span>
        ${checked ? `<span class="mi-check">${icon("check", 15)}</span>` : ""}</button>`);
      b.onclick = () => pick(m.ref);
      list.append(b);
    }
  }
  if (!providers.length) list.append(html(`<div class="menu-note">${mode === "remote" ? "Aucun fournisseur distant configuré." : mode === "auto" ? "Aucun fournisseur disponible." : "Ollama n'est pas configuré."}</div>`));
  box.append(list, html('<div class="menu-sep"></div>'));
  const manage = html(`<button class="menu-item">${icon("sliders-horizontal", 16)}<span class="mi-label">Gérer les fournisseurs et modèles…</span></button>`);
  manage.onclick = () => { closePopover(); ctx.navigate("#/settings/ai"); };
  const refresh = html(`<button class="menu-item">${icon("refresh-cw", 16)}<span class="mi-label">Actualiser la liste</span></button>`);
  refresh.onclick = async () => { await ctx.refreshCatalog(true); chooseModel(anchor, { conversationId }); };
  box.append(refresh, manage);
  popover(anchor, box, { align: "start" });

  async function pick(ref) {
    closePopover();
    if (conv) {
      const updated = await api.patch(`/api/conversations/${conv.id}`, { model_pref: ref });
      chat.patchConvLocal(updated);
    }
    if (ref && !conv) {
      const isLocal = providers.find((p) => ref.startsWith(p.id + ":"))?.is_local;
      await ctx.updateSettings({ ai: isLocal ? { local_model: ref } : { remote_model: ref } });
    }
    emit("settings");
    toast(ref ? `Modèle sélectionné : ${ref.split(":").slice(1).join(":")}` : "Sélection automatique du modèle.", { kind: "ok" });
  }
}

async function toggleDictation() {
  if (voice.listening) { voice.stopListening(); return; }
  if (state.route.name !== "chat") {
    state.pendingDictation = true;   // la vue conversation démarrera la dictée à l'affichage
    ctx.navigate("#/chat");
    return;
  }
  document.dispatchEvent(new CustomEvent("nexaai:dictate"));
}

async function stopAll() {
  document.dispatchEvent(new CustomEvent("nexaai:stop-all"));
  voice.stopAll();
  const stopped = await chat.stop();
  toast(stopped ? "Tâche interrompue." : "Lecture et écoute arrêtées.", { kind: "ok" });
}

async function quitApp() {
  const ok = await confirmDialog({ title: "Quitter NexaAI ?", message: "Les générations en cours seront interrompues et le serveur local arrêté.", confirm: "Quitter", danger: true });
  if (!ok) return;
  vision.stopCamera();
  voice.stopAll();
  await api.post("/api/system/shutdown").catch(() => {});
  document.body.innerHTML = `<div style="height:100vh;display:grid;place-items:center;color:var(--text-2);font-family:var(--font)">
    <div style="text-align:center"><h2 style="color:var(--text);margin-bottom:8px">NexaAI est arrêté.</h2><p>Vous pouvez fermer cette fenêtre. Relancez avec start_nexaai.bat.</p></div></div>`;
  setTimeout(() => window.close(), 400);
}

// -- Commandes --------------------------------------------------------------------------
function registerCommands() {
  const nav = (id, title, iconName, hash, keywords = "", group = "Navigation") =>
    register({ id, title, icon: iconName, group, keywords, run: () => ctx.navigate(hash) });
  register({ id: "chat.new", title: "Nouvelle conversation", icon: "square-pen", group: "Conversation", keywords: "nouveau chat", shortcut: "new_chat", run: () => newChat() });
  nav("nav.search", "Rechercher une conversation", "search", "#/search", "trouver historique", "Conversation");
  nav("nav.history", "Ouvrir l'historique", "history", "#/history", "conversations anciennes", "Conversation");
  register({ id: "task.stop", title: "Interrompre la tâche en cours", icon: "circle-stop", group: "Conversation", keywords: "arrêter stop annuler",
    enabled: () => (state.system.generating || state.system.speaking || state.system.listening) || "Aucune tâche en cours", run: stopAll });
  register({ id: "model.choose", title: "Changer de modèle", icon: "cpu", group: "Intelligence artificielle", keywords: "modèle llm ollama",
    run: () => chooseModel(document.querySelector(".model-chip") || document.querySelector(".companion"), { conversationId: state.route.name === "chat" ? state.route.params.id : null }) });
  for (const [mode, info] of Object.entries(MODE_INFO)) {
    register({ id: `mode.${mode}`, title: `Passer en mode ${info.label.toLowerCase()}`, icon: info.icon, group: "Intelligence artificielle",
      enabled: () => state.settings.ai.mode !== mode || "Déjà actif", run: async () => { await ctx.updateSettings({ ai: { mode } }); toast(`Mode ${info.label.toLowerCase()} activé.`, { kind: "ok" }); } });
  }
  nav("nav.projects", "Ouvrir les projets", "folder-kanban", "#/projects", "bibliothèque", "Espace de travail");
  nav("nav.memory", "Afficher la mémoire", "brain", "#/memory", "souvenirs préférences", "Espace de travail");
  nav("nav.files", "Ouvrir les fichiers", "folder", "#/files", "dossiers documents", "Espace de travail");
  nav("nav.studio", "Ouvrir Création et code", "code-xml", "#/studio", "éditeur programmation", "Espace de travail");
  nav("nav.vision", "Ouvrir la vision", "scan-eye", "#/vision", "caméra", "Vision et voix");
  register({ id: "vision.camera.on", title: "Activer la caméra", icon: "camera", group: "Vision et voix", keywords: "webcam vision",
    enabled: () => !state.system.cameraOn || "La caméra est déjà active", run: async () => {
      ctx.navigate("#/vision");
      try { await vision.startCamera(); } catch (err) { toast(err.message, { kind: "err" }); }
    } });
  register({ id: "vision.camera.off", title: "Désactiver la caméra", icon: "camera-off", group: "Vision et voix", keywords: "webcam couper",
    enabled: () => state.system.cameraOn || "La caméra est déjà éteinte", run: () => { vision.stopCamera(); toast("Caméra désactivée.", { kind: "ok" }); } });
  register({ id: "vision.gestures.pause", title: "Suspendre la détection des gestes", icon: "hand", group: "Vision et voix", keywords: "pause gestes",
    enabled: () => state.system.gestures || "La détection n'est pas active", gesture: false, run: () => { vision.stopDetection(); toast("Détection des gestes suspendue.", { kind: "ok" }); } });
  nav("nav.gestures", "Ouvrir la bibliothèque des gestes", "hand", "#/vision/gestures", "geste apprentissage", "Vision et voix");
  nav("nav.voice", "Ouvrir les réglages de la voix", "audio-lines", "#/voice", "micro synthèse", "Vision et voix");
  register({ id: "voice.dictate", title: "Dicter un message", icon: "mic", group: "Vision et voix", keywords: "micro parler",
    enabled: () => voice.sttAvailable || voice.sttUnavailableReason(), run: toggleDictation });
  register({ id: "voice.test", title: "Commencer un test vocal", icon: "volume-2", group: "Vision et voix", keywords: "tester voix synthèse",
    enabled: () => voice.ttsAvailable || "Synthèse vocale indisponible", run: () => { ctx.navigate("#/voice"); voice.speak("Bonjour, je suis NexaAI. La synthèse vocale fonctionne."); } });
  register({ id: "voice.stop", title: "Arrêter la lecture vocale", icon: "volume-x", group: "Vision et voix",
    enabled: () => state.system.speaking || "Aucune lecture en cours", run: () => voice.stopSpeaking() });
  nav("nav.pc", "Ouvrir le contrôle du PC", "monitor-cog", "#/pc", "applications actions", "Système");
  nav("nav.settings", "Ouvrir les paramètres", "settings", "#/settings", "réglages préférences", "Système");
  register({ id: "ui.sidebar", title: "Afficher / réduire la barre latérale", icon: "panel-left", group: "Affichage", shortcut: "toggle_sidebar", run: toggleSidebar });
  register({ id: "ui.context", title: "Afficher / masquer le panneau contextuel", icon: "panel-right", group: "Affichage", run: () => ctx.toggleContext() });
  register({ id: "ui.theme", title: "Basculer thème clair / sombre", icon: "sun", group: "Affichage", keywords: "thème couleur",
    run: () => ctx.updateSettings({ general: { theme: state.settings.general.theme === "dark" ? "light" : "dark" } }) });
  register({ id: "app.quit", title: "Quitter NexaAI", icon: "power", group: "Système", sensitive: true, gesture: false, run: quitApp });

  // Commandes dynamiques (non proposées sans recherche)
  registerProvider(() => state.conversations.filter((c) => c.message_count > 0).slice(0, 25).map((c) => ({
    id: `conv.open.${c.id}`, title: `Conversation : ${c.title}`, icon: "message-square", group: "Conversations", dynamic: true, gesture: false,
    run: () => ctx.navigate(`#/chat/${c.id}`) })));
  registerProvider(() => (state.projects || []).map((p) => ({
    id: `project.open.${p.id}`, title: `Ouvrir le projet ${p.name}`, icon: "folder-kanban", group: "Projets", dynamic: true,
    run: () => ctx.navigate(`#/projects/${p.id}`) })));
  registerProvider(() => (state.catalog?.providers || []).filter((p) => p.ok).flatMap((p) => p.models.map((m) => ({
    id: `model.use.${m.ref}`, title: `Utiliser le modèle ${m.name}`, icon: p.is_local ? "hard-drive" : "cloud", group: "Modèles", dynamic: true, gesture: false,
    keywords: p.name, run: async () => {
      await ctx.updateSettings({ ai: p.is_local ? { local_model: m.ref, mode: state.settings.ai.mode === "remote" ? "local" : state.settings.ai.mode } : { remote_model: m.ref, mode: "remote" } });
      if (state.route.name === "chat" && state.route.params.id) {
        chat.patchConvLocal(await api.patch(`/api/conversations/${state.route.params.id}`, { model_pref: m.ref }));
      }
      toast(`Modèle : ${m.name}`, { kind: "ok" });
    } }))));
  registerProvider(() => (state.apps || []).map((a) => ({
    id: `pc.launch.${a.id}`, title: `Lancer ${a.name}`, icon: "app-window", group: "Applications", dynamic: true, sensitive: true,
    run: async () => {
      const action = await api.post(`/api/pc/apps/${a.id}/launch`, { origin: "user" });
      toast(action.status === "done" ? action.result : `${action.result}`, { kind: action.status === "done" ? "ok" : "err" });
    } })));
}

// -- Raccourcis clavier ------------------------------------------------------------------
function onKeydown(e) {
  const sc = state.settings.shortcuts;
  if (document.querySelector(".modal-scrim")) return;
  if (matchShortcut(e, sc.palette)) { e.preventDefault(); openPalette(); return; }
  if (paletteOpen()) return;
  // Les autres raccourcis avec modificateur fonctionnent partout ; sans modificateur, jamais pendant la saisie.
  const hasModifier = e.ctrlKey || e.metaKey || e.altKey;
  if (matchShortcut(e, sc.stop) && (state.system.generating || state.system.speaking || state.system.listening)) {
    if (document.querySelector(".popover")) return;
    e.preventDefault();
    stopAll();
    return;
  }
  if (!hasModifier && isTyping(e.target)) return;
  if (matchShortcut(e, sc.new_chat)) { e.preventDefault(); newChat(); }
  else if (matchShortcut(e, sc.toggle_sidebar)) { e.preventDefault(); toggleSidebar(); }
  else if (matchShortcut(e, sc.search)) { e.preventDefault(); ctx.navigate("#/search"); }
}

// -- Gestes → actions ---------------------------------------------------------------------
async function onGesture(e) {
  const { id, name, confidence } = e.detail;
  if (vision.suppress) return;   // apprentissage en cours : aucune action
  const g = vision.gestures.find((x) => x.id === id);
  const cmd = g?.action ? getCommand(g.action) : null;
  const pct = Math.round(confidence * 100);
  if (state.settings.vision.test_mode) {
    toast(`Geste « ${name} » reconnu (${pct} %) — mode test : ${cmd ? `« ${cmd.title} » non exécuté` : "aucune action associée"}.`);
    return;
  }
  if (!cmd) { toast(`Geste « ${name} » reconnu (${pct} %) — aucune action associée.`); return; }
  const avail = cmd.enabled ? cmd.enabled() : true;
  if (avail !== true) { toast(`Geste « ${name} » : ${cmd.title} impossible (${avail}).`, { kind: "err" }); return; }
  if (cmd.sensitive) {
    const ok = await confirmDialog({ title: "Confirmer l'action du geste", message: `Le geste « ${name} » demande : ${cmd.title}. Exécuter ?`, confirm: "Exécuter" });
    if (!ok) return;
  }
  toast(`Geste « ${name} » → ${cmd.title}`, { kind: "ok" });
  cmd.run();
}

function renderCameraIndicator() {
  const el = document.getElementById("camera-indicator");
  const show = state.system.cameraOn;
  document.getElementById("cam-dot")?.classList.toggle("hidden", !show);
  if (!el) return;
  el.classList.toggle("hidden", !show);
  el.querySelector(".ci-text").textContent = state.system.gestures ? "Caméra active · gestes" : "Caméra active";
}

// -- Démarrage -----------------------------------------------------------------------------
async function boot() {
  let boot;
  try {
    boot = await api.get("/api/bootstrap");
  } catch (err) {
    root.innerHTML = `<div style="height:100vh;display:grid;place-items:center;padding:24px"><div class="notice err" style="max-width:520px">${icon("circle-alert", 16)}
      <div><b>Impossible de joindre NexaAI.</b><br>${esc(err.message)}</div></div></div>`;
    return;
  }
  state.version = boot.version;
  state.presets = boot.presets;
  state.tools = boot.tools;
  state.tk = boot.tk;
  state.settings = boot.settings;
  applyAppearance();
  setCompanionActions({
    newChat: () => newChat(),
    toggleDictation,
    openVision: () => ctx.navigate("#/vision"),
    openGestures: () => ctx.navigate("#/vision/gestures"),
    chooseModel: (anchor) => chooseModel(anchor, { conversationId: state.route.name === "chat" ? state.route.params.id : null }),
    openPalette: () => openPalette(),
    toggleAutoRead: async () => {
      const v = !state.settings.voice.auto_read;
      if (!v) voice.stopSpeaking();
      await ctx.updateSettings({ voice: { auto_read: v } });
      toast(v ? "Les réponses seront lues à voix haute." : "Lecture automatique désactivée.", { kind: "ok" });
    },
    stopAll,
    dismissError: () => setSystem({ error: null }),
    backToChat: () => ctx.navigate(state.route.name === "chat" ? location.hash || "#/chat" : (state.conversations[0] ? `#/chat/${state.conversations[0].id}` : "#/chat")),
    statusLine: () => {
      const s = state.settings.ai;
      const model = (s.mode === "remote" ? s.remote_model : s.local_model).split(":").slice(1).join(":");
      return `${MODE_INFO[s.mode].label}${model ? ` · ${model}` : ""}`;
    },
    contextMenu: (e) => menu({ x: e.clientX, y: e.clientY }, [
      { head: "NexaAI" },
      { label: "Paramètres", icon: "settings", run: () => ctx.navigate("#/settings") },
      { label: "Voix", icon: "audio-lines", run: () => ctx.navigate("#/voice") },
      { label: "Animations réduites", icon: "activity", checked: state.settings.general.reduced_motion,
        run: () => ctx.updateSettings({ general: { reduced_motion: !state.settings.general.reduced_motion } }) },
      { label: state.settings.general.theme === "dark" ? "Thème clair" : "Thème sombre", icon: state.settings.general.theme === "dark" ? "sun" : "moon",
        run: () => ctx.updateSettings({ general: { theme: state.settings.general.theme === "dark" ? "light" : "dark" } }) },
      "sep",
      { label: "Quitter NexaAI", icon: "power", danger: true, run: quitApp },
    ]),
  });
  registerCommands();
  buildShell();
  on("conversations", renderRecents);
  on("catalog", renderEngineStatus);
  on("settings", renderEngineStatus);
  on("system", () => { renderCameraIndicator(); });
  vision.addEventListener("gesture", onGesture);
  document.addEventListener("keydown", onKeydown);
  window.addEventListener("hashchange", route);
  await chat.refreshRecents();
  ctx.refreshCatalog();
  api.get("/api/projects").then(({ items }) => { state.projects = items; }).catch(() => {});
  api.get("/api/pc/apps").then(({ items }) => { state.apps = items; }).catch(() => {});
  if (!location.hash || location.hash === "#" || location.hash === "#/") {
    const last = state.conversations.find((c) => c.message_count > 0);
    location.replace(state.settings.general.startup === "last" && last ? `#/chat/${last.id}` : "#/chat");
  }
  await route();
  // Signe de vie : permet au serveur de s'arrêter quand plus aucune fenêtre n'est ouverte.
  setInterval(() => api.post("/api/system/heartbeat").catch(() => {}), 20000);
  api.post("/api/system/heartbeat").catch(() => {});
  window.addEventListener("beforeunload", () => { vision.stopCamera(); voice.stopAll(); });
  window.addEventListener("focus", () => ctx.refreshCatalog());
}

boot();
