// Compagnon visuel de NexaAI : une tête de robot minimaliste à visière.
// Son état reflète UNIQUEMENT l'état réel du système (store.state.system) :
//   veille · écoute (micro réellement actif, barres = niveau sonore mesuré)
//   réflexion (génération en cours) · parole (synthèse en cours, synchronisée aux mots)
//   vision (caméra réellement active) · erreur (dernière opération en échec)
import { icon } from "./icons.js";
import { on, state } from "./store.js";
import { esc, html, popover, closePopover } from "./ui.js";
import { voice } from "./voice.js";

const SVG = `<svg viewBox="0 0 100 100" aria-hidden="true">
  <g class="c-body">
    <line class="c-ant" x1="50" y1="21" x2="50" y2="11"/>
    <circle class="c-tip" cx="50" cy="9" r="3.2"/>
    <circle class="c-ear" cx="11.5" cy="50" r="4"/>
    <circle class="c-ear" cx="88.5" cy="50" r="4"/>
    <rect class="c-head" x="14" y="21" width="72" height="62" rx="23"/>
    <rect class="c-visor" x="22" y="37" width="56" height="26" rx="13"/>
    <rect class="c-eye" x="34.5" y="43.5" width="7" height="13" rx="3.5"/>
    <rect class="c-eye" x="58.5" y="43.5" width="7" height="13" rx="3.5"/>
    <g class="c-bars">
      <rect x="35" y="41" width="4" height="18" rx="2"/><rect x="41.5" y="41" width="4" height="18" rx="2"/>
      <rect x="48" y="41" width="4" height="18" rx="2"/><rect x="54.5" y="41" width="4" height="18" rx="2"/>
      <rect x="61" y="41" width="4" height="18" rx="2"/>
    </g>
    <rect class="c-scan" x="30" y="45" width="10" height="10" rx="5"/>
    <circle class="c-ring" cx="50" cy="50" r="16"/>
    <line class="c-mouth" x1="42" y1="72" x2="58" y2="72"/>
  </g>
</svg>`;

const LABELS = {
  idle: ["Disponible", "NexaAI attend votre demande."],
  listening: ["Écoute", "Le microphone est actif."],
  thinking: ["Génération en cours", "Le modèle rédige sa réponse."],
  speaking: ["Lecture vocale", "NexaAI lit la réponse à voix haute."],
  vision: ["Caméra active", "La vision est en cours d'utilisation."],
  error: ["Erreur", "La dernière opération a échoué."],
};

const instances = new Set();
let actions = {};

export function companionState(sys = state.system) {
  if (sys.speaking) return "speaking";
  if (sys.listening) return "listening";
  if (sys.generating) return "thinking";
  if (sys.error) return "error";
  if (sys.cameraOn) return "vision";
  return "idle";
}

function apply(el) {
  const s = companionState();
  if (el.dataset.state !== s) el.dataset.state = s;
  el.style.setProperty("--level", state.system.micLevel.toFixed(3));
  const [label, desc] = LABELS[s];
  el.setAttribute("aria-label", `NexaAI — ${label}. ${el.dataset.interactive ? "Ouvrir les commandes rapides du compagnon." : ""}`);
  el.title = el.dataset.interactive ? `${label} — cliquer pour les actions rapides, clic droit pour plus d'options` : `${label} — ${desc}`;
  const badge = el.querySelector(".companion-badge");
  if (badge) badge.className = `companion-badge ${s === "error" ? "err" : state.system.cameraOn ? "cam" : ""}`;
}

on("system", () => {
  for (const el of instances) {
    if (el.isConnected) apply(el);
    else if (el.dataset.mounted) instances.delete(el);  // retiré du document : on l'oublie
  }
});
voice.addEventListener("word", () => {
  for (const el of instances) {
    el.classList.remove("word");
    void el.offsetWidth; // relance l'animation
    el.classList.add("word");
  }
});

/** Crée un compagnon. interactive : clic = actions rapides, clic droit = options. */
export function createCompanion(size = 40, { interactive = true, badge = false } = {}) {
  const el = html(`<button class="companion" type="button" style="width:${size}px;height:${size}px">${SVG}${badge ? '<span class="companion-badge"></span>' : ""}</button>`);
  if (interactive) {
    el.dataset.interactive = "1";
    el.addEventListener("click", (e) => { e.stopPropagation(); openCompanionMenu(el); });
    el.addEventListener("contextmenu", (e) => { e.preventDefault(); actions.contextMenu?.(e); });
  } else {
    el.tabIndex = -1;
    el.style.cursor = "default";
  }
  instances.add(el);
  apply(el);
  requestAnimationFrame(() => { el.dataset.mounted = "1"; });
  return el;
}

export function setCompanionActions(a) { actions = a; }

/** Panneau compact d'actions rapides : uniquement des actions réellement disponibles. */
export function openCompanionMenu(anchor) {
  const s = companionState();
  const [label, desc] = LABELS[s];
  const sys = state.system;
  const box = document.createElement("div");
  box.className = "companion-pop-inner";
  box.append(html(`<div class="cp-head"><div class="cp-avatar"></div><div><div class="cp-state">${esc(label)}</div>
    <div class="cp-sub">${esc(actions.statusLine?.() || desc)}</div></div></div>`));
  box.querySelector(".cp-avatar").append(createCompanion(40, { interactive: false }));
  if (s === "error" && sys.error) {
    const n = html(`<div class="notice err" style="margin:0 4px 6px">${icon("circle-alert", 16)}<div class="grow"><div>${esc(sys.error.message)}</div>
      <div class="row mt-8"><button class="btn sm" data-dismiss>Ignorer</button>${sys.error.retry ? '<button class="btn sm primary" data-retry>Réessayer</button>' : ""}</div></div></div>`);
    n.querySelector("[data-dismiss]").onclick = () => { closePopover(); actions.dismissError?.(); };
    n.querySelector("[data-retry]")?.addEventListener("click", () => { closePopover(); sys.error.retry(); });
    box.append(n);
  }
  const grid = html('<div class="cp-grid"></div>');
  const busy = sys.generating || sys.speaking || sys.listening;
  const items = [
    { icon: "square-pen", label: "Nouvelle conversation", run: actions.newChat },
    { icon: sys.listening ? "mic-off" : "mic", label: sys.listening ? "Arrêter l'écoute" : "Dicter", run: actions.toggleDictation,
      disabled: voice.sttAvailable ? "" : voice.sttUnavailableReason(), on: sys.listening },
    { icon: "scan-eye", label: sys.cameraOn ? "Vision (caméra active)" : "Ouvrir la vision", run: actions.openVision, on: sys.cameraOn },
    { icon: "hand", label: "Gestes", run: actions.openGestures },
    { icon: "cpu", label: "Choisir un modèle", run: () => actions.chooseModel?.(anchor) },
    { icon: "command", label: "Commandes rapides", run: actions.openPalette },
    { icon: state.settings?.voice?.auto_read ? "volume-2" : "volume-x", label: "Lecture auto des réponses",
      run: actions.toggleAutoRead, on: state.settings?.voice?.auto_read, disabled: voice.ttsAvailable ? "" : "Synthèse vocale indisponible dans ce navigateur" },
    { icon: "circle-stop", label: "Interrompre", run: actions.stopAll, disabled: busy ? "" : "Aucune tâche en cours", stop: true },
  ];
  for (const it of items) {
    const b = html(`<button class="cp-action ${it.on ? "on" : ""} ${it.stop ? "stop" : ""}" ${it.disabled ? "disabled" : ""}
      title="${esc(it.disabled || "")}">${icon(it.icon, 17)}<span>${esc(it.label)}</span></button>`);
    b.onclick = () => { closePopover(); it.run?.(); };
    grid.append(b);
  }
  box.append(grid);
  const back = html(`<button class="menu-item" style="margin-top:4px">${icon("message-square", 16)}<span class="mi-label">Revenir à la conversation</span></button>`);
  back.onclick = () => { closePopover(); actions.backToChat?.(); };
  box.append(back);
  const el = popover(anchor, box, { className: "companion-pop" });
  el.querySelector(".cp-action:not(:disabled)")?.focus();
}
