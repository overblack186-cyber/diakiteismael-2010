// Contrôleur des conversations : chargement, envoi, flux de réponse, arrêt.
// Indépendant de l'affichage : une génération continue si l'utilisateur change de page.
import { api, ApiError } from "./api.js";
import { set, setSystem, state } from "./store.js";
import { toast } from "./ui.js";
import { voice } from "./voice.js";

export const chatEvents = new EventTarget();
const convs = new Map();          // id -> {conv, messages, streaming|null, jobId, abort}

function notify(cid, kind = "full") {
  chatEvents.dispatchEvent(new CustomEvent("update", { detail: { cid, kind } }));
}

function updateGenerating() {
  const generating = [...convs.values()].some((c) => c.streaming);
  setSystem({ generating });
}

export function getConv(cid) { return convs.get(cid); }

export async function refreshRecents() {
  try {
    const { items } = await api.get("/api/conversations?limit=40");
    // garde les métadonnées locales à jour (titre généré par le serveur, etc.)
    for (const c of items) {
      const entry = convs.get(c.id);
      if (entry && (entry.conv.title !== c.title || entry.conv.updated_at !== c.updated_at)) {
        entry.conv = { ...entry.conv, ...c };
        notify(c.id, "meta");
      }
    }
    set("conversations", items);
  } catch { /* barre latérale : erreur non bloquante */ }
}

export async function createConversation(projectId = null) {
  const conv = await api.post("/api/conversations", projectId ? { project_id: projectId } : {});
  convs.set(conv.id, { conv, messages: [], streaming: null });
  await refreshRecents();
  return conv;
}

export async function loadConversation(cid, { force = false } = {}) {
  const existing = convs.get(cid);
  if (existing && !force && (existing.streaming || existing.loaded)) return existing;
  const data = await api.get(`/api/conversations/${cid}`);
  const { messages, active_job: job, ...conv } = data;
  const entry = existing || { streaming: null };
  Object.assign(entry, { conv, messages, loaded: true });
  convs.set(cid, entry);
  if (job && !entry.streaming) attachJob(cid, job);
  return entry;
}

export function patchConvLocal(conv) {
  const entry = convs.get(conv.id);
  if (entry) { entry.conv = { ...entry.conv, ...conv }; notify(conv.id); }
}

function newStreaming(jobId) {
  return { id: `pending-${jobId || Date.now()}`, role: "assistant", status: "streaming", content: "", thinking: "",
    actions: new Map(), resolution: null, notices: [], started: Date.now(), firstToken: null, meta: {} };
}

function handleEvent(cid, entry, ev) {
  const s = entry.streaming;
  switch (ev.type) {
    case "accepted":
      entry.jobId = ev.job_id;
      if (ev.user_message) entry.messages.push(ev.user_message);
      entry.streaming = newStreaming(ev.job_id);
      notify(cid);
      updateGenerating();
      refreshRecents();
      break;
    case "attached":
      entry.jobId = ev.job_id;
      break;
    case "start":
      if (!s) break;
      s.resolution = ev.resolution;
      s.meta.memories = ev.memories;
      notify(cid);
      break;
    case "notice":
      if (!s) break;
      s.notices.push(ev.text);
      if (ev.resolution) s.resolution = ev.resolution;
      notify(cid);
      break;
    case "delta":
      if (!s) break;
      if (!s.firstToken) s.firstToken = Date.now();
      s.content += ev.text;
      notify(cid, "delta");
      break;
    case "thinking":
      if (!s) break;
      s.thinking += ev.text;
      notify(cid, "delta");
      break;
    case "action":
      if (!s) break;
      s.actions.set(ev.action.id, ev.action);
      notify(cid);
      break;
    case "done":
    case "error":
    case "stopped":
      entry.streaming = null;
      entry.jobId = null;
      if (ev.message) entry.messages.push(ev.message);
      notify(cid);
      updateGenerating();
      refreshRecents();
      finished(cid, ev);
      break;
    default:
      break;
  }
}

function finished(cid, ev) {
  if (ev.type === "error" && ev.error_kind !== "remote_files") setSystem({ error: { message: ev.error } });
  else if (ev.type === "done") setSystem({ error: null });
  if (ev.type === "done" && document.hidden && state.settings?.general?.notifications && "Notification" in window
      && Notification.permission === "granted") {
    new Notification("NexaAI a répondu", { body: (ev.message?.content || "").slice(0, 120), silent: true });
  }
  if (ev.type === "done" && state.settings?.voice?.auto_read && voice.ttsAvailable) {
    try {
      voice.speak(ev.message.content, { onEnd: () => document.dispatchEvent(new CustomEvent("nexaai:speech-done", { detail: { cid } })) });
    } catch { /* lecture facultative */ }
  }
  chatEvents.dispatchEvent(new CustomEvent("finished", { detail: { cid, ev } }));
}

async function runStream(cid, method, path, body) {
  const entry = convs.get(cid) || (await loadConversation(cid));
  const controller = new AbortController();
  entry.abort = controller;
  try {
    await api.stream(method, path, body, (ev) => handleEvent(cid, entry, ev), controller.signal);
  } catch (err) {
    if (err.name === "AbortError") return;
    // Le message de l'utilisateur n'est jamais perdu : on recharge l'état réel du serveur.
    entry.streaming = null;
    updateGenerating();
    await loadConversation(cid, { force: true }).catch(() => {});
    notify(cid);
    if (!(err instanceof ApiError && err.status === 409)) setSystem({ error: { message: err.message } });
    throw err;
  } finally {
    entry.abort = null;
    if (entry.streaming) {
      // flux coupé sans fin explicite (serveur arrêté) : on resynchronise
      entry.streaming = null;
      updateGenerating();
      await loadConversation(cid, { force: true }).catch(() => {});
      notify(cid);
    }
  }
}

function attachJob(cid, job) {
  const entry = convs.get(cid);
  // Le flux est rejoué depuis le début : le texte se reconstruit à partir des événements.
  entry.streaming = newStreaming(job.job_id);
  entry.jobId = job.job_id;
  updateGenerating();
  runStream(cid, "GET", `/api/jobs/${job.job_id}/stream`).catch(() => {});
}

export async function sendMessage(cid, content, attachments = [], { allowRemoteFiles = false } = {}) {
  setSystem({ error: null });
  await runStream(cid, "POST", `/api/conversations/${cid}/messages`, {
    content, attachments: attachments.map((a) => a.id), allow_remote_files: allowRemoteFiles,
  });
}

export async function regenerate(cid, { allowRemoteFiles = false } = {}) {
  const entry = convs.get(cid);
  // Retire localement la dernière réponse : le serveur fait de même.
  const lastUser = entry.messages.map((m) => m.role).lastIndexOf("user");
  if (lastUser >= 0) entry.messages = entry.messages.slice(0, lastUser + 1);
  notify(cid);
  setSystem({ error: null });
  await runStream(cid, "POST", `/api/conversations/${cid}/regenerate`, { allow_remote_files: allowRemoteFiles });
}

export async function editMessage(cid, messageId, content) {
  const entry = convs.get(cid);
  const idx = entry.messages.findIndex((m) => m.id === messageId);
  if (idx >= 0) {
    entry.messages = entry.messages.slice(0, idx + 1);
    entry.messages[idx] = { ...entry.messages[idx], content, meta: { ...entry.messages[idx].meta, edited: true } };
  }
  notify(cid);
  await runStream(cid, "POST", `/api/messages/${messageId}/edit`, { content });
}

export async function deleteMessage(cid, messageId) {
  await api.del(`/api/messages/${messageId}`);
  const entry = convs.get(cid);
  entry.messages = entry.messages.filter((m) => m.id !== messageId);
  notify(cid);
}

/** Arrête la génération de la conversation (ou toutes), et la lecture vocale. */
export async function stop(cid = null) {
  voice.stopSpeaking();
  const targets = cid ? [convs.get(cid)] : [...convs.values()];
  let stopped = false;
  for (const entry of targets) {
    if (entry?.jobId) {
      stopped = true;
      try { await api.post(`/api/jobs/${entry.jobId}/cancel`); } catch (err) { toast(err.message, { kind: "err" }); }
    }
  }
  return stopped;
}

export function forget(cid) {
  convs.delete(cid);
  updateGenerating();
}

export async function decideAction(actionId, approve) {
  await api.post(`/api/actions/${actionId}/decide`, { approve });
}
