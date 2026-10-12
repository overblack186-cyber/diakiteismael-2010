// Vue « Conversation » : messages, réponse progressive, zone de saisie, pièces jointes, dictée.
import { api } from "../api.js";
import * as chat from "../chat-controller.js";
import { createCompanion } from "../companion.js";
import { icon } from "../icons.js";
import { deleteConversation, MODE_INFO, renameConversation, syncNav } from "../main.js";
import { renderMarkdown } from "../markdown.js";
import { on, setSystem, state } from "../store.js";
import { confirmDialog, copyText, esc, formatSize, html, menu, modal, promptDialog, toast } from "../ui.js";
import { voice } from "../voice.js";

const STARTERS = [
  { icon: "brain", title: "Expliquer un concept", text: "Explique-moi simplement, avec un exemple concret : " },
  { icon: "code-xml", title: "Déboguer du code", text: "Voici mon code et l'erreur obtenue. Aide-moi à trouver la cause :\n\n```\n\n```" },
  { icon: "pencil", title: "Rédiger ou corriger", text: "Corrige l'orthographe et améliore le style de ce texte, sans changer le sens :\n\n" },
  { icon: "file-text", title: "Résumer un document", text: "Résume ce document en 5 points clés. (Joignez le fichier avec le trombone.)" },
];

const ACTION_STATUS = {
  proposed: ["Proposée", "zap"], pending: ["En attente de votre confirmation", "shield-check"], running: ["En cours", "loader-circle"],
  done: ["Terminée", "circle-check"], failed: ["Échec", "circle-x"], denied: ["Refusée", "circle-x"], cancelled: ["Annulée", "circle-x"],
};

export async function render(container, params, ctx) {
  let cid = params.id || null;
  let entry = null;
  const attachments = [];   // {id, name, kind, mime, size, uploading, error}
  let streamEl = null;
  let deltaQueued = false;
  let stickToBottom = true;

  if (cid) {
    try {
      entry = await chat.loadConversation(cid);
    } catch (err) {
      container.innerHTML = `<div class="page"><div class="page-inner"><div class="empty">${icon("message-square", 32)}
        <h3>Conversation introuvable</h3><p>${esc(err.message)}</p><button class="btn primary" data-new>Nouvelle conversation</button></div></div></div>`;
      container.querySelector("[data-new]").onclick = () => ctx.newChat();
      return;
    }
  }

  container.innerHTML = `
    <header class="topbar">
      <button class="topbar-title editable" data-title title="Renommer"></button>
      <button class="model-chip" data-model title="Choisir le modèle"></button>
      <span class="spacer"></span>
      <button class="icon-btn" data-ctx title="Panneau contextuel" aria-label="Panneau contextuel">${icon("panel-right", 18)}</button>
      <button class="icon-btn" data-opts title="Options de la conversation" aria-label="Options de la conversation">${icon("ellipsis", 18)}</button>
      <button class="icon-btn" data-new title="Nouvelle conversation (${esc(state.settings.shortcuts.new_chat)})" aria-label="Nouvelle conversation">${icon("square-pen", 18)}</button>
    </header>
    <div class="chat">
      <div class="messages scroll" data-scroll><div class="messages-inner" data-list></div></div>
      <div class="composer-wrap">
        <div class="composer" data-composer>
          <div class="listening-bar hidden" data-listening>${icon("mic", 14)}<span data-listen-text>Écoute en cours…</span><div class="meter"><div data-meter></div></div>
            <button class="btn sm ghost" data-listen-stop>Arrêter</button></div>
          <div class="chips hidden" data-atts></div>
          <textarea rows="1" placeholder="Écrivez à NexaAI…" aria-label="Message" data-input></textarea>
          <div class="composer-bar">
            <button class="icon-btn" data-attach title="Joindre un fichier" aria-label="Joindre un fichier">${icon("paperclip", 18)}</button>
            <button class="mode-btn" data-mode title="Mode d'utilisation"></button>
            <span class="spacer"></span>
            <button class="icon-btn" data-mic aria-label="Dicter"></button>
            <button class="send-btn" data-send aria-label="Envoyer"></button>
          </div>
        </div>
        <div class="composer-hint" data-hint></div>
        <input type="file" multiple hidden data-file>
      </div>
    </div>`;

  const $ = (s) => container.querySelector(s);
  const list = $("[data-list]");
  const scroller = $("[data-scroll]");
  const input = $("[data-input]");
  const sendBtn = $("[data-send]");
  const micBtn = $("[data-mic]");

  // -- En-tête -------------------------------------------------------------------
  function renderHeader() {
    const conv = entry?.conv;
    const titleBtn = $("[data-title]");
    titleBtn.textContent = conv ? conv.title : "Nouvelle conversation";
    titleBtn.disabled = !conv;
    $("[data-opts]").disabled = !conv;
    $("[data-ctx]").classList.toggle("on", !!state.settings.general.context_panel);
    const mode = state.settings.ai.mode;
    const pref = conv?.model_pref;
    const fallback = mode === "remote" ? state.settings.ai.remote_model : mode === "local" ? state.settings.ai.local_model : "";
    let ref = pref || fallback;
    let suffix = "";
    if (!ref && mode === "local") {
      // aucun modèle choisi : le premier modèle local disponible sera utilisé
      const first = state.catalog?.providers.find((p) => p.is_local && p.ok && p.models.length)?.models[0];
      if (first) { ref = first.ref; suffix = " · par défaut"; }
    }
    const name = ref ? ref.split(":").slice(1).join(":") + suffix : mode === "auto" ? "Automatique" : "Aucun modèle";
    const provider = state.catalog?.providers.find((p) => ref && ref.startsWith(p.id + ":"));
    const isLocal = provider ? provider.is_local : mode !== "remote";
    $("[data-model]").innerHTML = `${icon(isLocal ? "hard-drive" : "cloud", 15)}<span class="name">${esc(name)}</span>${icon("chevron-down", 14)}`;
    $("[data-model]").title = `Modèle : ${name} (${isLocal ? "local" : "distant"}) — cliquer pour changer`;
    const info = MODE_INFO[mode];
    $("[data-mode]").innerHTML = `${icon(info.icon, 15)}<span>${info.label}</span>`;
    $("[data-mode]").title = info.desc;
    renderHint();
  }

  function renderHint() {
    const mode = state.settings.ai.mode;
    const remoteRef = state.settings.ai.remote_model;
    const providerName = state.catalog?.providers.find((p) => remoteRef && remoteRef.startsWith(p.id + ":"))?.name;
    let remote = "";
    if (mode === "remote") remote = `<span class="remote">${icon("cloud", 13)}Mode distant : vos messages sont envoyés à ${esc(providerName || "un fournisseur distant")}.</span>`;
    else if (mode === "auto" && state.settings.ai.auto_allow_remote) remote = `<span class="remote">${icon("cloud", 13)}Le mode automatique peut utiliser un service distant.</span>`;
    $("[data-hint]").innerHTML = `${remote}<span>NexaAI peut se tromper : vérifiez les informations importantes.</span>`;
  }

  $("[data-title]").onclick = () => entry && renameConversation(entry.conv, refresh);
  $("[data-model]").onclick = (e) => ctx.chooseModel(e.currentTarget, { conversationId: cid });
  $("[data-ctx]").onclick = () => ctx.toggleContext();
  $("[data-new]").onclick = () => ctx.newChat();
  $("[data-opts]").onclick = (e) => {
    if (!entry) return;
    menu(e.currentTarget, [
      { label: "Renommer", icon: "pencil", run: () => renameConversation(entry.conv, refresh) },
      { label: "Associer à un projet…", icon: "folder-kanban", run: chooseProject },
      { label: "Exporter en Markdown", icon: "download", run: exportMarkdown, disabled: entry.messages.length ? "" : "Conversation vide" },
      { label: entry.conv.archived ? "Désarchiver" : "Archiver", icon: entry.conv.archived ? "archive-restore" : "archive", run: async () => {
        chat.patchConvLocal(await api.patch(`/api/conversations/${cid}`, { archived: !entry.conv.archived }));
        await chat.refreshRecents();
        toast(entry.conv.archived ? "Conversation archivée." : "Conversation désarchivée.", { kind: "ok" });
      } },
      "sep",
      { label: "Supprimer…", icon: "trash-2", danger: true, run: () => deleteConversation(entry.conv) },
    ], { align: "end" });
  };
  $("[data-mode]").onclick = (e) => menu(e.currentTarget, Object.entries(MODE_INFO).map(([k, v]) => ({
    label: v.label, icon: v.icon, checked: state.settings.ai.mode === k, title: v.desc,
    run: () => ctx.updateSettings({ ai: { mode: k } }),
  })).concat(["sep", { note: MODE_INFO[state.settings.ai.mode].desc }]), { placement: "top" });

  async function chooseProject() {
    const { items } = await api.get("/api/projects");
    menu($("[data-opts]"), [
      { head: "Associer à un projet" },
      ...items.map((p) => ({ label: p.name, icon: "folder-kanban", checked: entry.conv.project_id === p.id, run: async () => {
        chat.patchConvLocal(await api.patch(`/api/conversations/${cid}`, { project_id: p.id }));
        toast(`Conversation associée à « ${p.name} ».`, { kind: "ok" });
      } })),
      items.length ? "sep" : { note: "Aucun projet : créez-en un dans Projets." },
      entry.conv.project_id ? { label: "Retirer du projet", icon: "unlink", run: async () => {
        chat.patchConvLocal(await api.patch(`/api/conversations/${cid}`, { project_id: "" }));
      } } : null,
    ], { align: "end" });
  }

  function exportMarkdown() {
    const md = [`# ${entry.conv.title}`, ""].concat(entry.messages.map((m) =>
      `## ${m.role === "user" ? "Vous" : `NexaAI${m.model ? ` (${m.model})` : ""}`}\n\n${m.content}\n`)).join("\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([md], { type: "text/markdown" }));
    a.download = `${entry.conv.title.replace(/[\\/:*?"<>|]/g, "_").slice(0, 60) || "conversation"}.md`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  // -- Messages ----------------------------------------------------------------------
  function renderWelcome() {
    const w = html(`<div class="welcome">
      <span data-hero></span>
      <h1>Bonjour. Que puis-je faire pour vous ?</h1>
      <p>Posez une question, joignez un fichier ou dictez votre demande.</p>
      <div class="status-line" data-status></div>
      <div class="starters"></div></div>`);
    w.querySelector("[data-hero]").append(createCompanion(112, { interactive: true }));
    const status = w.querySelector("[data-status]");
    const providers = state.catalog?.providers || [];
    const local = providers.filter((p) => p.is_local);
    const okLocal = local.some((p) => p.ok && p.models.length);
    if (!state.catalog) status.innerHTML = `<span class="spinner"></span><span>Recherche des modèles…</span>`;
    else if (state.settings.ai.mode !== "remote" && !okLocal) {
      const err = local.find((p) => !p.ok)?.error;
      status.innerHTML = `<span class="dot err"></span><span>${esc(err ? "Moteur local indisponible" : "Aucun modèle local installé")}</span>
        <a href="#/settings/ai">Configurer</a>`;
    } else {
      const total = providers.reduce((n, p) => n + (p.ok ? p.models.length : 0), 0);
      status.innerHTML = `<span class="dot ok"></span><span>${esc(MODE_INFO[state.settings.ai.mode].label)} · ${total} modèle${total > 1 ? "s" : ""} disponible${total > 1 ? "s" : ""}</span>`;
    }
    const starters = w.querySelector(".starters");
    for (const s of STARTERS) {
      const b = html(`<button class="starter">${icon(s.icon, 17)}<div><b>${esc(s.title)}</b></div></button>`);
      b.onclick = () => { input.value = s.text; autoGrow(); input.focus(); input.setSelectionRange(input.value.length, input.value.length); };
      starters.append(b);
    }
    return w;
  }

  function renderAll() {
    renderHeader();
    const msgs = entry?.messages || [];
    const hasContent = msgs.length || entry?.streaming;
    $(".chat").classList.toggle("is-empty", !hasContent);
    list.innerHTML = "";
    streamEl = null;
    if (!hasContent) {
      list.parentElement.classList.add("hidden");
      if (!$(".welcome")) $(".chat").insertBefore(renderWelcome(), $(".composer-wrap"));
      updateComposer();
      return;
    }
    $(".welcome")?.remove();
    list.parentElement.classList.remove("hidden");
    const lastAssistant = [...msgs].reverse().find((m) => m.role === "assistant");
    msgs.forEach((m) => list.append(m.role === "user" ? userMessage(m) : assistantMessage(m, m === lastAssistant && !entry.streaming)));
    if (entry.streaming) {
      streamEl = streamingMessage(entry.streaming);
      list.append(streamEl);
    }
    updateComposer();
    if (stickToBottom) scrollToBottom();
  }

  function attachmentChips(atts) {
    return atts.map((a) => a.kind === "image"
      ? `<span class="chip" title="${esc(a.name)}"><img src="${api.rawUrl(`/api/attachments/${a.id}/raw`)}" alt=""><span>${esc(a.name)}</span></span>`
      : `<span class="chip ${a.kind === "unsupported" ? "warn" : ""}" title="${esc(a.name)}">${icon(a.kind === "text" ? "file-text" : "file", 14)}<span>${esc(a.name)}</span></span>`).join("");
  }

  function userMessage(m) {
    const el = html(`<div class="msg msg-user" data-id="${m.id}">
      ${m.meta?.attachments?.length ? `<div class="atts">${attachmentChips(m.meta.attachments)}</div>` : ""}
      <div class="bubble">${esc(m.content)}</div>
      <div class="msg-actions">
        ${m.meta?.edited ? '<span class="muted small" style="align-self:center;margin-right:6px">modifié</span>' : ""}
        <button class="icon-btn sm" data-copy title="Copier" aria-label="Copier">${icon("copy", 15)}</button>
        <button class="icon-btn sm" data-edit title="Modifier et renvoyer" aria-label="Modifier">${icon("pencil", 15)}</button>
        <button class="icon-btn sm" data-more title="Plus d'actions" aria-label="Plus d'actions">${icon("ellipsis", 15)}</button>
      </div></div>`);
    el.querySelector("[data-copy]").onclick = (e) => copyText(m.content, e.currentTarget);
    el.querySelector("[data-edit]").onclick = () => editInline(el, m);
    el.querySelector("[data-edit]").disabled = !!entry.streaming;
    el.querySelector("[data-more]").onclick = (e) => menu(e.currentTarget, [
      { label: "Copier", icon: "copy", run: () => copyText(m.content) },
      { label: "Modifier et renvoyer", icon: "pencil", run: () => editInline(el, m), disabled: entry.streaming ? "Génération en cours" : "" },
      { label: "Mémoriser ce message…", icon: "bookmark", run: () => rememberText(m.content) },
      "sep",
      { label: "Supprimer le message", icon: "trash-2", danger: true, run: () => removeMessage(m), disabled: entry.streaming ? "Génération en cours" : "" },
    ], { align: "end" });
    return el;
  }

  function editInline(el, m) {
    const bubble = el.querySelector(".bubble");
    const idx = entry.messages.indexOf(m);
    const following = entry.messages.length - idx - 1;
    const box = html(`<div style="min-width:min(560px,70vw)">
      <textarea class="textarea" rows="3">${esc(m.content)}</textarea>
      ${following ? `<div class="help muted small mt-8">Les ${following} message(s) suivant(s) seront remplacés par une nouvelle réponse.</div>` : ""}
      <div class="row mt-8" style="justify-content:flex-end"><button class="btn sm ghost" data-cancel>Annuler</button><button class="btn sm primary" data-ok>Envoyer</button></div></div>`);
    bubble.replaceWith(box);
    el.querySelector(".msg-actions").classList.add("hidden");
    const ta = box.querySelector("textarea");
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
    box.querySelector("[data-cancel]").onclick = () => renderAll();
    const submit = async () => {
      const content = ta.value.trim();
      if (!content) return;
      try { await chat.editMessage(cid, m.id, content); } catch (err) { toast(err.message, { kind: "err" }); }
    };
    box.querySelector("[data-ok]").onclick = submit;
    ta.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); }
      if (e.key === "Escape") { e.stopPropagation(); renderAll(); }
    });
  }

  async function removeMessage(m) {
    const ok = await confirmDialog({ title: "Supprimer ce message ?", message: "Le message sera définitivement supprimé de la conversation.", confirm: "Supprimer", danger: true });
    if (!ok) return;
    try { await chat.deleteMessage(cid, m.id); } catch (err) { toast(err.message, { kind: "err" }); }
  }

  async function rememberText(text) {
    if (!state.settings.memory.enabled) { toast("La mémoire est désactivée (Mémoire › Activer).", { kind: "err" }); return; }
    const content = await promptDialog({ title: "Mémoriser une information", label: "Information à retenir (modifiable)", value: text.slice(0, 600), multiline: true,
      help: "Elle sera fournie à NexaAI dans les prochaines conversations. Consultable et supprimable dans Mémoire." });
    if (!content) return;
    await api.post("/api/memory", { kind: "fact", content, source: "conversation" });
    toast("Information mémorisée.", { kind: "ok", action: { label: "Voir", run: () => ctx.navigate("#/memory") } });
  }

  function resolutionLine(r, stats) {
    if (!r) return "";
    const parts = [`<span class="badge ${r.is_local ? "" : "warning"}" title="${esc(r.reason || "")}">${icon(r.is_local ? "hard-drive" : "cloud", 12)}${esc(r.is_local ? "local" : "distant")}</span>`,
      `<span class="mono" title="${esc(r.provider_name)}">${esc(r.model)}</span>`];
    if (stats?.output_tokens) parts.push(`<span>${stats.output_tokens} jetons</span>`);
    if (stats?.tokens_per_second) parts.push(`<span>${String(stats.tokens_per_second).replace(".", ",")} jetons/s</span>`);
    return parts.join("");
  }

  function actionCard(a) {
    const [label, ic] = ACTION_STATUS[a.status] || [a.status, "zap"];
    const card = html(`<div class="action-card ${a.status}">
      <div class="ac-icon">${a.status === "running" ? '<span class="spinner"></span>' : icon(ic, 16)}</div>
      <div class="ac-main"><div class="ac-title">${esc(a.summary || a.tool)}</div>
        <div class="ac-sub">${esc(label)}${a.result ? ` — ${esc(a.result.slice(0, 300))}` : ""}</div></div></div>`);
    if (a.status === "pending") {
      const row = html(`<div class="row"><button class="btn sm" data-deny>Refuser</button><button class="btn sm primary" data-approve>Autoriser</button></div>`);
      row.querySelector("[data-deny]").onclick = () => chat.decideAction(a.id, false).catch((e) => toast(e.message, { kind: "err" }));
      row.querySelector("[data-approve]").onclick = () => chat.decideAction(a.id, true).catch((e) => toast(e.message, { kind: "err" }));
      card.append(row);
    }
    return card;
  }

  function assistantMessage(m, isLast) {
    const meta = m.meta || {};
    const r = meta.resolution;
    const el = html(`<div class="msg msg-assistant ${isLast ? "last" : ""}" data-id="${m.id}">
      <div class="msg-meta"><span class="who">NexaAI</span>${resolutionLine(r, meta.stats)}</div>
      <div data-thinking></div><div data-actions></div>
      <div class="md">${renderMarkdown(m.content)}</div>
      <div data-status></div>
      <div class="msg-foot" data-foot></div>
      <div class="msg-actions"></div></div>`);
    if (meta.thinking) {
      el.querySelector("[data-thinking]").append(html(`<details class="thinking"><summary>${icon("chevron-right", 13)}Raisonnement fourni par le modèle</summary>
        <div class="thinking-box">${esc(meta.thinking)}</div></details>`));
    }
    for (const a of meta.action_details || []) el.querySelector("[data-actions]").append(actionCard(a));
    const status = el.querySelector("[data-status]");
    if (m.status === "error") {
      const remoteFiles = meta.error_kind === "remote_files";
      const n = html(`<div class="msg-error"><div class="notice ${remoteFiles ? "warn" : "err"}">${icon(remoteFiles ? "cloud" : "circle-alert", 16)}
        <div class="grow">${esc(meta.error || "La réponse a échoué.")}</div></div></div>`);
      const box = n.querySelector(".notice");
      if (remoteFiles) {
        const b = html(`<button class="btn sm primary">Envoyer quand même</button>`);
        b.onclick = () => retry(true);
        box.append(b);
      } else if (meta.retryable !== false || meta.error_kind === "not_found" || meta.error_kind === "capability") {
        if (meta.retryable !== false) {
          const b = html(`<button class="btn sm">${icon("rotate-ccw", 14)}Réessayer</button>`);
          b.onclick = () => retry(false);
          box.append(b);
        }
        if (["not_found", "unreachable", "capability", "auth"].includes(meta.error_kind)) {
          const s = html(`<button class="btn sm ghost">Paramètres</button>`);
          s.onclick = () => ctx.navigate("#/settings/ai");
          box.append(s);
        }
      }
      status.append(n);
    } else if (m.status === "stopped") {
      status.append(html(`<div class="msg-foot">${icon("circle-stop", 13)}<span>Réponse interrompue${m.content ? "" : " avant le premier mot"}.</span></div>`));
    }
    const foot = el.querySelector("[data-foot]");
    const notes = [...(r?.notes || [])];
    if (meta.memories?.length) {
      const chip = html(`<button class="chip accent" title="Informations mémorisées fournies au modèle">${icon("brain", 13)}<span>Mémoire fournie (${meta.memories.length})</span></button>`);
      chip.onclick = (e) => menu(e.currentTarget, [{ head: "Informations fournies au modèle" },
        ...meta.memories.map((x) => ({ label: x.content, icon: "bookmark", run: () => ctx.navigate("#/memory") }))]);
      foot.append(chip);
    }
    for (const note of notes) foot.append(html(`<span class="chip" title="${esc(note)}">${icon("info", 13)}<span>${esc(note)}</span></span>`));
    if (meta.reported) foot.append(html(`<span class="chip warn">${icon("flag", 13)}<span>Signalée</span></span>`));
    const actions = el.querySelector(".msg-actions");
    const add = (ic, title, fn, disabled = "") => {
      const b = html(`<button class="icon-btn sm" title="${esc(disabled || title)}" aria-label="${esc(title)}" ${disabled ? "disabled" : ""}>${icon(ic, 15)}</button>`);
      b.onclick = (e) => fn(e.currentTarget);
      actions.append(b);
    };
    if (m.content) add("copy", "Copier", (b) => copyText(m.content, b));
    if (isLast && m.status !== "error") add("refresh-cw", "Régénérer la réponse", () => retry(false), entry.streaming ? "Génération en cours" : "");
    if (m.content && voice.ttsAvailable) add("volume-2", "Lire à voix haute", () => { try { voice.speak(m.content); } catch (err) { toast(err.message, { kind: "err" }); } });
    add("ellipsis", "Plus d'actions", (b) => menu(b, [
      { label: "Informations sur le modèle", icon: "info", run: () => modelInfo(m) },
      m.content ? { label: "Mémoriser un extrait…", icon: "bookmark", run: () => rememberText(m.content) } : null,
      { label: meta.reported ? "Déjà signalée" : "Signaler une réponse incorrecte…", icon: "flag", disabled: meta.reported ? "Déjà signalée" : "", run: () => report(m) },
      "sep",
      { label: "Supprimer la réponse", icon: "trash-2", danger: true, run: () => removeMessage(m), disabled: entry.streaming ? "Génération en cours" : "" },
    ], { align: "start" }));
    el.querySelectorAll("[data-copy-code]").forEach(wireCodeCopy);
    return el;
  }

  function wireCodeCopy(btn) {
    btn.innerHTML = icon("copy", 14);
    btn.onclick = () => copyText(btn.closest(".codeblock").querySelector("code").textContent, btn);
  }

  function modelInfo(m) {
    const r = m.meta?.resolution;
    const s = m.meta?.stats || {};
    const rows = r ? [
      ["Fournisseur", `${r.provider_name} (${r.is_local ? "local, sur cet ordinateur" : "distant"})`], ["Modèle", r.model],
      ["Choix", r.reason], ["Capacités", (r.capabilities || []).join(", ")],
      ["Jetons générés", s.output_tokens ?? "—"], ["Jetons en entrée", s.input_tokens ?? "—"],
      ["Vitesse", s.tokens_per_second ? `${s.tokens_per_second} jetons/s` : "—"], ["Chargement du modèle", s.load_seconds != null ? `${s.load_seconds} s` : "—"],
      ["Durée totale", m.meta?.duration != null ? `${m.meta.duration} s` : "—"], ["Date", new Date(m.created_at * 1000).toLocaleString("fr-FR")],
    ] : [["Information", "Aucune information de modèle (réponse en échec avant sélection)."]];
    modal({ title: "Informations sur la réponse", body: `<dl class="kv">${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("")}</dl>
      ${r?.notes?.length ? `<div class="notice info mt-16">${icon("info", 16)}<div>${r.notes.map(esc).join("<br>")}</div></div>` : ""}`,
    actions: [{ label: "Fermer", kind: "primary" }] });
  }

  async function report(m) {
    const reason = await promptDialog({ title: "Signaler une réponse incorrecte", label: "Qu'est-ce qui ne va pas ?", multiline: true,
      placeholder: "Ex. : information fausse, code qui ne fonctionne pas…", confirm: "Signaler",
      help: "Le signalement est enregistré localement (journal et conversation). Il n'est envoyé à personne." });
    if (!reason) return;
    const updated = await api.post(`/api/messages/${m.id}/report`, { reason });
    Object.assign(m, updated);
    renderAll();
    toast("Signalement enregistré localement.", { kind: "ok" });
  }

  async function retry(allowRemoteFiles) {
    try { await chat.regenerate(cid, { allowRemoteFiles }); } catch (err) { toast(err.message, { kind: "err" }); }
  }

  // -- Message en cours de génération ------------------------------------------------
  function streamingMessage(s) {
    const el = html(`<div class="msg msg-assistant" data-streaming>
      <div class="msg-meta"><span class="who">NexaAI</span><span data-res></span></div>
      <div data-notices></div><div data-thinking></div><div data-actions></div>
      <div class="md" data-md></div>
      <div class="waiting" data-wait><span class="spinner"></span><span data-wait-text>Préparation…</span>
        <button class="btn sm ghost" data-stop>${icon("square", 12)}Arrêter</button></div></div>`);
    el.querySelector("[data-stop]").onclick = () => chat.stop(cid);
    updateStreaming(el, s, true);
    return el;
  }

  function updateStreaming(el, s, full = false) {
    if (full) {
      el.querySelector("[data-res]").innerHTML = s.resolution ? resolutionLine(s.resolution) : "";
      el.querySelector("[data-notices]").innerHTML = s.notices.map((n) => `<div class="notice info mb-8">${icon("info", 16)}<div>${esc(n)}</div></div>`).join("");
      const acts = el.querySelector("[data-actions]");
      acts.innerHTML = "";
      for (const a of s.actions.values()) acts.append(actionCard(a));
    }
    if (s.thinking) {
      let box = el.querySelector(".thinking-box");
      if (!box) {
        el.querySelector("[data-thinking]").append(html(`<details class="thinking" open><summary>${icon("chevron-right", 13)}Raisonnement fourni par le modèle</summary><div class="thinking-box"></div></details>`));
        box = el.querySelector(".thinking-box");
      }
      box.textContent = s.thinking;
    }
    const md = el.querySelector("[data-md]");
    md.innerHTML = renderMarkdown(s.content);
    md.classList.toggle("cursor-blink", !!s.content);
    md.querySelectorAll("[data-copy-code]").forEach(wireCodeCopy);
    const waitText = el.querySelector("[data-wait-text]");
    const pending = [...s.actions.values()].some((a) => a.status === "pending");
    const elapsed = ((Date.now() - s.started) / 1000).toFixed(1).replace(".", ",");
    if (pending) waitText.textContent = "En attente de votre confirmation…";
    else if (!s.resolution) waitText.textContent = "Sélection du modèle…";
    else if (!s.content && !s.thinking) waitText.textContent = `Le modèle ${s.resolution.model} prépare sa réponse… ${elapsed} s`;
    else waitText.textContent = `Génération… ${elapsed} s`;
  }

  let timer = null;
  function startTicker() {
    stopTicker();
    timer = setInterval(() => { if (streamEl && entry?.streaming) updateStreaming(streamEl, entry.streaming); }, 500);
  }
  function stopTicker() { clearInterval(timer); timer = null; }

  // -- Défilement ---------------------------------------------------------------------
  function scrollToBottom() { scroller.scrollTop = scroller.scrollHeight; }
  scroller.addEventListener("scroll", () => {
    stickToBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 140;
  }, { passive: true });

  // -- Zone de saisie ------------------------------------------------------------------
  function autoGrow() {
    input.style.height = "auto";
    input.style.height = `${Math.min(input.scrollHeight, innerHeight * 0.38)}px`;
    updateComposer();
  }

  function updateComposer() {
    const streaming = !!entry?.streaming;
    const uploading = attachments.some((a) => a.uploading);
    const hasText = input.value.trim().length > 0 || attachments.some((a) => !a.error && !a.uploading);
    sendBtn.classList.toggle("stop", streaming);
    sendBtn.innerHTML = streaming ? icon("square", 14) : icon("arrow-up", 18);
    sendBtn.title = streaming ? `Arrêter la génération (${state.settings.shortcuts.stop})` : uploading ? "Envoi des pièces jointes en cours…" : "Envoyer (Entrée)";
    sendBtn.setAttribute("aria-label", streaming ? "Arrêter" : "Envoyer");
    sendBtn.disabled = !streaming && (!hasText || uploading);
    const listening = state.system.listening;
    micBtn.innerHTML = icon(listening ? "mic-off" : "mic", 18);
    micBtn.classList.toggle("rec", listening);
    micBtn.disabled = !voice.sttAvailable;
    micBtn.title = !voice.sttAvailable ? voice.sttUnavailableReason() : listening ? "Arrêter la dictée" : "Dicter (reconnaissance vocale du navigateur, en ligne)";
    $("[data-listening]").classList.toggle("hidden", !listening);
  }

  function renderAttachments() {
    const box = $("[data-atts]");
    box.classList.toggle("hidden", !attachments.length);
    box.innerHTML = "";
    attachments.forEach((a, i) => {
      const warn = a.error || a.kind === "unsupported";
      const chip = html(`<span class="chip ${warn ? "warn" : ""}" title="${esc(a.error || (a.kind === "unsupported" ? "Format non lisible par NexaAI : le contenu ne sera pas transmis." : `${a.name} — ${formatSize(a.size)}`))}">
        ${a.uploading ? '<span class="spinner" style="width:12px;height:12px"></span>' : a.kind === "image" && a.id ? `<img src="${api.rawUrl(`/api/attachments/${a.id}/raw`)}" alt="">` : icon(warn ? "triangle-alert" : "file-text", 14)}
        <span>${esc(a.name)}</span><button aria-label="Retirer ${esc(a.name)}" title="Retirer">${icon("x", 13)}</button></span>`);
      chip.querySelector("button").onclick = () => { attachments.splice(i, 1); renderAttachments(); };
      box.append(chip);
    });
    updateComposer();
  }

  async function addFiles(files) {
    for (const file of files) {
      const a = { name: file.name, size: file.size, uploading: true };
      if (file.size > 20 * 1024 * 1024) { a.uploading = false; a.error = "Fichier trop volumineux (20 Mo maximum)."; attachments.push(a); continue; }
      attachments.push(a);
      renderAttachments();
      try {
        const saved = await api.upload(`/api/attachments?name=${encodeURIComponent(file.name)}`, file);
        Object.assign(a, saved, { uploading: false });
        if (saved.kind === "unsupported") a.error = `Format « ${file.name.split(".").pop()} » non lisible par NexaAI : retirez-le ou convertissez-le en texte.`;
      } catch (err) {
        a.uploading = false;
        a.error = err.message;
      }
      renderAttachments();
    }
  }

  async function ensureConversation() {
    if (cid) return;
    const conv = await chat.createConversation();
    cid = conv.id;
    entry = chat.getConv(cid);
    history.replaceState(null, "", `#/chat/${cid}`);
    state.route.params.id = cid;
    syncNav();
  }

  async function send() {
    if (entry?.streaming) { chat.stop(cid); return; }
    const content = input.value.trim();
    const ready = attachments.filter((a) => a.id && !a.error);
    if (!content && !ready.length) return;
    if (attachments.some((a) => a.uploading)) return;
    if (attachments.some((a) => a.error)) {
      const ok = await confirmDialog({ title: "Pièces jointes ignorées", message: "Certains fichiers ne peuvent pas être lus et ne seront pas transmis. Envoyer quand même ?", confirm: "Envoyer" });
      if (!ok) return;
    }
    let allowRemoteFiles = false;
    if (ready.length) {
      const res = await api.post("/api/models/resolve", { model_pref: entry?.conv?.model_pref || "", need: ready.some((a) => a.kind === "image") ? ["vision"] : [], text: content });
      if (res.ok && !res.is_local) {
        allowRemoteFiles = await confirmDialog({ title: "Envoyer des fichiers à un service distant ?",
          message: `${ready.length} fichier(s) seront transmis à ${res.provider_name} (${res.model}), un service distant. Continuer ?`, confirm: "Envoyer" });
        if (!allowRemoteFiles) return;
      }
    }
    try {
      await ensureConversation();
    } catch (err) {
      toast(err.message, { kind: "err" });
      return;
    }
    input.value = "";
    attachments.length = 0;
    renderAttachments();
    autoGrow();
    stickToBottom = true;
    try {
      await chat.sendMessage(cid, content, ready, { allowRemoteFiles });
    } catch (err) {
      if (err.name !== "AbortError") {
        // le texte n'est pas perdu : remis dans la zone de saisie si le serveur ne l'a pas enregistré
        if (!entry?.messages.some((m) => m.role === "user" && m.content === content)) input.value = content;
        autoGrow();
        toast(err.message, { kind: "err" });
      }
    }
  }

  input.addEventListener("input", autoGrow);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); if (!entry?.streaming) send(); }
  });
  input.addEventListener("paste", (e) => {
    const files = [...(e.clipboardData?.files || [])];
    if (files.length) { e.preventDefault(); addFiles(files); }
  });
  sendBtn.onclick = send;
  $("[data-attach]").onclick = () => $("[data-file]").click();
  $("[data-file]").onchange = (e) => { addFiles([...e.target.files]); e.target.value = ""; };
  const composer = $("[data-composer]");
  composer.addEventListener("dragover", (e) => { e.preventDefault(); composer.classList.add("dragging"); });
  composer.addEventListener("dragleave", () => composer.classList.remove("dragging"));
  composer.addEventListener("drop", (e) => { e.preventDefault(); composer.classList.remove("dragging"); addFiles([...e.dataTransfer.files]); });

  // -- Dictée ---------------------------------------------------------------------------
  // Conversation vocale continue (option explicite) : dictée → envoi → lecture → nouvelle écoute.
  let voiceSession = false;
  async function dictate() {
    if (voice.listening) { voiceSession = false; voice.stopListening(); return; }
    const before = input.value ? input.value.replace(/\s*$/, " ") : "";
    voiceSession = state.settings.voice.continuous;
    try {
      const text = await voice.listen({
        onText: (t) => { input.value = before + t; $("[data-listen-text]").textContent = t ? "Transcription…" : "Écoute en cours…"; autoGrow(); },
      });
      input.focus();
      if (voiceSession && text) send();
      else voiceSession = false;   // rien entendu : la session vocale s'arrête
    } catch (err) {
      voiceSession = false;
      toast(err.message, { kind: "err" });
      setSystem({ error: { message: err.message } });
    }
  }
  micBtn.onclick = dictate;
  $("[data-listen-stop]").onclick = () => { voiceSession = false; voice.stopListening(); };
  const onDictateRequest = () => dictate();
  const onSpeechDone = (e) => {
    if (voiceSession && e.detail.cid === cid && state.settings.voice.continuous && !voice.listening) dictate();
  };
  const onStopAll = () => { voiceSession = false; };
  document.addEventListener("nexaai:dictate", onDictateRequest);
  document.addEventListener("nexaai:speech-done", onSpeechDone);
  document.addEventListener("nexaai:stop-all", onStopAll);

  // -- Abonnements -----------------------------------------------------------------------
  function refresh() { if (cid) { entry = chat.getConv(cid); renderAll(); } }

  const onUpdate = (e) => {
    if (e.detail.cid !== cid) { return; }
    entry = chat.getConv(cid);
    if (e.detail.kind === "meta") { renderHeader(); return; }
    if (e.detail.kind === "delta" && streamEl && entry.streaming) {
      if (deltaQueued) return;
      deltaQueued = true;
      requestAnimationFrame(() => {
        deltaQueued = false;
        if (streamEl && entry.streaming) {
          updateStreaming(streamEl, entry.streaming);
          if (stickToBottom) scrollToBottom();
        }
      });
      return;
    }
    renderAll();
    if (entry.streaming) startTicker(); else stopTicker();
    ctx.renderContext();
  };
  chat.chatEvents.addEventListener("update", onUpdate);
  const offSystem = on("system", () => {
    updateComposer();
    const meter = $("[data-meter]");
    if (meter) meter.style.width = `${Math.round(state.system.micLevel * 100)}%`;
  });
  const offSettings = on("settings", renderHeader);
  const offCatalog = on("catalog", () => { renderHeader(); if (!entry?.messages.length) { $(".welcome")?.remove(); renderAll(); } });

  // -- Panneau contextuel --------------------------------------------------------------------
  ctx.setContext((body) => {
    if (!entry) {
      body.innerHTML = `<div class="muted small">Le contexte apparaîtra ici après le premier message : modèle utilisé, mémoire fournie, actions et pièces jointes.</div>`;
      return;
    }
    const msgs = entry.messages;
    const lastA = [...msgs].reverse().find((m) => m.role === "assistant" && m.meta?.resolution);
    const r = entry.streaming?.resolution || lastA?.meta.resolution;
    const allActions = msgs.flatMap((m) => m.meta?.action_details || []);
    const atts = msgs.flatMap((m) => m.meta?.attachments || []);
    body.innerHTML = `
      <div class="ctx-section"><div class="ctx-title">Conversation</div><dl class="kv">
        <dt>Créée</dt><dd>${esc(new Date(entry.conv.created_at * 1000).toLocaleString("fr-FR"))}</dd>
        <dt>Messages</dt><dd>${msgs.length}</dd>
        <dt>Projet</dt><dd>${entry.conv.project_id ? `<a href="#/projects/${entry.conv.project_id}">Ouvrir le projet</a>` : "Aucun"}</dd>
        <dt>Modèle</dt><dd>${esc(entry.conv.model_pref ? entry.conv.model_pref.split(":").slice(1).join(":") : "Réglage par défaut")}</dd></dl></div>
      <div class="ctx-section"><div class="ctx-title">Dernière réponse</div>${r ? `<dl class="kv">
        <dt>Modèle</dt><dd class="mono">${esc(r.model)}</dd><dt>Fournisseur</dt><dd>${esc(r.provider_name)} · ${r.is_local ? "local" : "distant"}</dd>
        <dt>Choix</dt><dd>${esc(r.reason)}</dd><dt>Capacités</dt><dd>${esc((r.capabilities || []).join(", "))}</dd></dl>
        ${(r.notes || []).map((n) => `<div class="ctx-item">${esc(n)}</div>`).join("")}` : '<div class="muted small">Aucune réponse pour l\'instant.</div>'}</div>
      <div class="ctx-section"><div class="ctx-title">Mémoire fournie</div>${lastA?.meta.memories?.length
        ? lastA.meta.memories.map((x) => `<div class="ctx-item">${esc(x.content)}</div>`).join("")
        : `<div class="muted small">${state.settings.memory.enabled ? "Aucune information mémorisée n'a été utilisée." : "Mémoire désactivée."}</div>`}</div>
      <div class="ctx-section"><div class="ctx-title">Actions (${allActions.length})</div>${allActions.length
        ? allActions.map((a) => `<div class="ctx-item"><b>${esc(a.summary || a.tool)}</b><br><span class="muted">${esc((ACTION_STATUS[a.status] || [a.status])[0])}</span></div>`).join("")
        : '<div class="muted small">Aucune action exécutée dans cette conversation.</div>'}</div>
      <div class="ctx-section"><div class="ctx-title">Pièces jointes (${atts.length})</div>${atts.length
        ? atts.map((a) => `<div class="ctx-item ctx-preview">${a.kind === "image" ? `<img src="${api.rawUrl(`/api/attachments/${a.id}/raw`)}" alt="${esc(a.name)}">` : ""}<div>${esc(a.name)} <span class="muted">· ${formatSize(a.size)}</span></div></div>`).join("")
        : '<div class="muted small">Aucune.</div>'}</div>`;
  });

  // -- Initialisation ----------------------------------------------------------------------
  renderAll();
  if (entry?.streaming) startTicker();
  if (params.m) {
    requestAnimationFrame(() => {
      const target = list.querySelector(`[data-id="${CSS.escape(params.m)}"]`);
      if (target) { stickToBottom = false; target.scrollIntoView({ block: "center" }); target.classList.add("flash"); }
    });
  }
  input.focus();
  if (state.pendingAttachment) {
    // fichier joint depuis la page Fichiers
    attachments.push(state.pendingAttachment);
    state.pendingAttachment = null;
    renderAttachments();
  }
  if (state.pendingDictation) { state.pendingDictation = false; dictate(); }

  return () => {
    stopTicker();
    chat.chatEvents.removeEventListener("update", onUpdate);
    document.removeEventListener("nexaai:dictate", onDictateRequest);
    document.removeEventListener("nexaai:speech-done", onSpeechDone);
    document.removeEventListener("nexaai:stop-all", onStopAll);
    offSystem(); offSettings(); offCatalog();
  };
}

