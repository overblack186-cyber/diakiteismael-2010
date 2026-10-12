// État global minimal et observable. Chaque clé peut être observée séparément.
const listeners = new Map();

export const state = {
  version: "",
  settings: null,
  presets: {},
  tools: [],
  catalog: null,          // {providers: [...]} : modèles réellement accessibles
  catalogError: null,
  conversations: [],      // conversations récentes (barre latérale)
  route: { name: "chat", params: {} },
  // État réel du système : le compagnon et les indicateurs ne lisent QUE ceci.
  system: {
    generating: false,    // une génération est en cours (conversation affichée ou non)
    listening: false,     // le micro capture réellement
    micLevel: 0,
    speaking: false,      // la synthèse vocale lit réellement
    cameraOn: false,      // la caméra est réellement active
    gestures: false,      // la détection des gestes tourne
    error: null,          // {message, retry?}
  },
};

export function on(key, fn) {
  if (!listeners.has(key)) listeners.set(key, new Set());
  listeners.get(key).add(fn);
  return () => listeners.get(key).delete(fn);
}

export function emit(key) {
  for (const fn of listeners.get(key) || []) {
    try { fn(state[key]); } catch (err) { console.error(err); }
  }
}

export function set(key, value) {
  state[key] = value;
  emit(key);
}

let systemQueued = false;
/** Met à jour l'état système ; les notifications sont regroupées par image (performances). */
export function setSystem(patch) {
  Object.assign(state.system, patch);
  if (systemQueued) return;
  systemQueued = true;
  requestAnimationFrame(() => { systemQueued = false; emit("system"); });
}
