// Reconnaissance de gestes personnalisés à partir des 21 repères de la main
// fournis par MediaPipe Hand Landmarker. Module pur (sans DOM) : testé dans
// tests/js/classifier.test.mjs.
//
// Méthode (adaptée à quelques exemples par geste, sans entraînement lourd) :
//  1. normalisation : origine au poignet, rotation pour que l'axe poignet → base
//     du majeur pointe vers le haut, mise à l'échelle par la taille de la paume,
//     main gauche symétrisée (un geste appris d'une main fonctionne avec l'autre) ;
//  2. classification par plus proches voisins (k-NN pondéré) ;
//  3. rejet des gestes inconnus : chaque geste a un « rayon » calculé à partir de
//     la dispersion de ses propres exemples ; au-delà, la confiance chute.

export const LANDMARKS = 21;
const WRIST = 0, MIDDLE_MCP = 9;
const MIN_RADIUS = 0.12;

/** landmarks : [{x, y, z}] × 21 (coordonnées normalisées de l'image). Renvoie 63 nombres. */
export function normalize(landmarks, handedness = "Right") {
  if (!landmarks || landmarks.length !== LANDMARKS) throw new Error("21 repères attendus");
  const mirror = handedness === "Left" ? -1 : 1;
  const w = landmarks[WRIST];
  const pts = landmarks.map((p) => [(p.x - w.x) * mirror, p.y - w.y, (p.z ?? 0) - (w.z ?? 0)]);
  const [mx, my] = pts[MIDDLE_MCP];
  const size = Math.hypot(mx, my) || 1e-6;
  // rotation : amener (mx, my) sur (0, -1)
  const angle = -Math.atan2(mx, -my);
  const c = Math.cos(angle), s = Math.sin(angle);
  const out = [];
  for (const [x, y, z] of pts) {
    out.push((x * c - y * s) / size, (x * s + y * c) / size, z / size);
  }
  return out;
}

/** Distance moyenne par repère (RMS) entre deux vecteurs normalisés. */
export function distance(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i++) { const d = a[i] - b[i]; sum += d * d; }
  return Math.sqrt(sum / LANDMARKS);
}

function nearestIntraDistances(samples) {
  return samples.map((s, i) => {
    let best = Infinity;
    samples.forEach((o, j) => { if (i !== j) best = Math.min(best, distance(s, o)); });
    return best;
  }).filter(Number.isFinite);
}

const mean = (xs) => xs.reduce((a, b) => a + b, 0) / (xs.length || 1);
const std = (xs) => { const m = mean(xs); return Math.sqrt(mean(xs.map((x) => (x - m) ** 2))); };

/**
 * Construit le modèle. gestures : [{id, name, sensitivity, enabled, samples: [{vector}]}].
 * Seuls les gestes actifs avec au moins 3 exemples sont utilisés.
 */
export function buildModel(gestures) {
  const classes = [];
  for (const g of gestures) {
    if (g.enabled === false) continue;
    const vectors = (g.samples || []).map((s) => s.vector || s);
    if (vectors.length < 3) continue;
    const nn = nearestIntraDistances(vectors);
    const radius = Math.max(MIN_RADIUS, mean(nn) + 2 * std(nn)) * (g.sensitivity || 1);
    classes.push({ id: g.id, name: g.name, vectors, radius });
  }
  return { classes };
}

/** Classe un vecteur normalisé. Renvoie {id, name, confidence, distance} ou null. */
export function classify(model, vector, k = 5) {
  if (!model.classes.length) return null;
  const all = [];
  for (const c of model.classes) for (const v of c.vectors) all.push({ c, d: distance(vector, v) });
  all.sort((a, b) => a.d - b.d);
  const top = all.slice(0, Math.min(k, all.length));
  const votes = new Map();
  let total = 0;
  for (const { c, d } of top) {
    const w = 1 / (d + 0.02);
    votes.set(c, (votes.get(c) || 0) + w);
    total += w;
  }
  let best = null, bestVote = -1;
  for (const [c, v] of votes) if (v > bestVote) { best = c; bestVote = v; }
  const dMin = Math.min(...all.filter((x) => x.c === best).map((x) => x.d));
  const share = bestVote / total;
  const proximity = dMin <= best.radius ? 1 : Math.exp(-(((dMin - best.radius) / (0.5 * best.radius)) ** 2));
  return { id: best.id, name: best.name, confidence: +(share * proximity).toFixed(3), distance: +dMin.toFixed(4) };
}

/**
 * Vérifie la cohérence des exemples d'un nouveau geste et sa distinction avec les gestes existants.
 * Renvoie {ok, outliers: [indices], spread, similarTo: nom|null}.
 */
export function checkSamples(vectors, existingModel = { classes: [] }) {
  if (vectors.length < 3) return { ok: false, outliers: [], spread: 0, similarTo: null, reason: "Au moins 3 exemples sont nécessaires." };
  const dim = vectors[0].length;
  const centroid = Array.from({ length: dim }, (_, i) => mean(vectors.map((v) => v[i])));
  const dists = vectors.map((v) => distance(v, centroid));
  const med = [...dists].sort((a, b) => a - b)[Math.floor(dists.length / 2)];
  const outliers = dists.map((d, i) => (d > Math.max(med * 2.5, 0.2) ? i : -1)).filter((i) => i >= 0);
  let similarTo = null;
  for (const c of existingModel.classes) {
    const close = vectors.filter((v) => c.vectors.some((o) => distance(v, o) < c.radius)).length;
    if (close / vectors.length > 0.5) { similarTo = c.name; break; }
  }
  const ok = outliers.length === 0 && !similarTo;
  const reason = outliers.length ? `${outliers.length} exemple(s) très différent(s) des autres : refaites-les ou retirez-les.`
    : similarTo ? `Ce geste ressemble trop à « ${similarTo} » : la reconnaissance risque de les confondre.` : "";
  return { ok, outliers, spread: +mean(dists).toFixed(4), similarTo, reason };
}

/**
 * Moteur de déclenchement : ne déclenche une action que si le même geste est reconnu
 * avec une confiance suffisante pendant `stabilityMs`, puis impose une période
 * anti-répétition (`cooldownMs`) ET le relâchement du geste avant un nouveau déclenchement.
 */
export class GestureEngine {
  constructor({ threshold = 0.8, stabilityMs = 600, cooldownMs = 1500 } = {}) {
    this.configure({ threshold, stabilityMs, cooldownMs });
    this.reset();
  }

  configure({ threshold, stabilityMs, cooldownMs }) {
    if (threshold != null) this.threshold = threshold;
    if (stabilityMs != null) this.stabilityMs = stabilityMs;
    if (cooldownMs != null) this.cooldownMs = cooldownMs;
  }

  reset() {
    this.candidate = null;
    this.since = 0;
    this.lastFired = new Map();
    this.armed = true;
  }

  /** result : sortie de classify() ou null. Renvoie {fire: bool, id, name, progress}. */
  update(result, now) {
    const ok = result && result.confidence >= this.threshold;
    const id = ok ? result.id : null;
    if (id !== this.candidate) {
      this.candidate = id;
      this.since = now;
      this.armed = true;  // le geste a changé : relâchement constaté
    }
    if (!id) return { fire: false, id: null, progress: 0 };
    const held = now - this.since;
    const progress = this.stabilityMs ? Math.min(1, held / this.stabilityMs) : 1;
    const last = this.lastFired.get(id) ?? -Infinity;
    if (progress >= 1 && this.armed && now - last >= this.cooldownMs) {
      this.lastFired.set(id, now);
      this.armed = false;
      return { fire: true, id, name: result.name, progress: 1 };
    }
    return { fire: false, id, name: result.name, progress };
  }
}
