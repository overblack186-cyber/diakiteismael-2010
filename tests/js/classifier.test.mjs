// Tests du classificateur de gestes : node --test tests/js
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildModel, checkSamples, classify, GestureEngine, normalize } from "../../web/js/vision/classifier.js";

// Main synthétique : poignet + 5 doigts (4 points chacun). `curl` replie certains doigts.
function hand({ curl = [0, 0, 0, 0, 0], dx = 0.5, dy = 0.7, scale = 0.25, angle = 0, mirror = false, noise = 0, seed = 1 }) {
  let s = seed;
  const rnd = () => { s = (s * 16807) % 2147483647; return (s / 2147483647 - 0.5) * 2 * noise; };
  const pts = [[0, 0]];
  const bases = [[-0.35, -0.25], [-0.18, -0.95], [0, -1], [0.18, -0.95], [0.33, -0.85]];
  bases.forEach(([bx, by], f) => {
    const c = curl[f];
    for (let k = 1; k <= 4; k++) {
      const t = k / 4;
      const len = f === 0 ? 0.6 : 0.85;
      const x = bx * (0.6 + t * 0.6) + (f === 0 ? -0.25 * t : 0);
      const y = by * 0.6 + (-len * t) * (1 - c) + (c ? 0.25 * t * c : 0);
      pts.push([x, y]);
    }
  });
  const ca = Math.cos(angle), sa = Math.sin(angle);
  return pts.map(([x, y]) => {
    const rx = x * ca - y * sa, ry = x * sa + y * ca;
    return { x: dx + (mirror ? -rx : rx) * scale + rnd(), y: dy + ry * scale + rnd(), z: rnd() * 0.1 };
  });
}

const OPEN = [0, 0, 0, 0, 0];
const FIST = [1, 1, 1, 1, 1];
const PEACE = [1, 0, 0, 1, 1];
const samples = (curl, n, base = 10) => Array.from({ length: n }, (_, i) => ({ vector: normalize(hand({ curl, noise: 0.004, seed: base + i, dx: 0.4 + i * 0.01, scale: 0.2 + i * 0.005 })) }));

test("normalisation invariante à la position, l'échelle, la rotation et la main", () => {
  const ref = normalize(hand({ curl: PEACE }));
  const moved = normalize(hand({ curl: PEACE, dx: 0.2, dy: 0.3, scale: 0.4, angle: 0.6 }));
  const left = normalize(hand({ curl: PEACE, mirror: true }), "Left");
  for (const v of [moved, left]) ref.forEach((x, i) => assert.ok(Math.abs(x - v[i]) < 1e-6));
  assert.equal(ref.length, 63);
  assert.throws(() => normalize([{ x: 0, y: 0 }]));
});

const gestures = [
  { id: "open", name: "Main ouverte", samples: samples(OPEN, 8, 1) },
  { id: "fist", name: "Poing", samples: samples(FIST, 8, 100) },
  { id: "peace", name: "Deux doigts", samples: samples(PEACE, 8, 200) },
];

test("reconnaît les gestes enregistrés avec une confiance élevée", () => {
  const model = buildModel(gestures);
  assert.equal(model.classes.length, 3);
  for (const [curl, id] of [[OPEN, "open"], [FIST, "fist"], [PEACE, "peace"]]) {
    const r = classify(model, normalize(hand({ curl, noise: 0.004, seed: 999, angle: 0.3, scale: 0.3 })));
    assert.equal(r.id, id);
    assert.ok(r.confidence >= 0.8, `confiance ${r.confidence} pour ${id}`);
  }
});

test("un geste inconnu obtient une confiance faible (rejet)", () => {
  const model = buildModel(gestures);
  const r = classify(model, normalize(hand({ curl: [0, 1, 1, 1, 0] })));   // « appel » : pouce + auriculaire
  assert.ok(r.confidence < 0.8, `confiance trop haute : ${r.confidence}`);
});

test("gestes désactivés ou avec trop peu d'exemples ignorés ; sensibilité appliquée", () => {
  const model = buildModel([{ ...gestures[0], enabled: false }, { id: "x", name: "x", samples: samples(FIST, 2) }]);
  assert.equal(model.classes.length, 0);
  assert.equal(classify(model, normalize(hand({}))), null);
  const strict = buildModel([{ ...gestures[2], sensitivity: 0.5 }]).classes[0].radius;
  const loose = buildModel([{ ...gestures[2], sensitivity: 2 }]).classes[0].radius;
  assert.ok(loose > strict);
});

test("vérification de cohérence : incohérences et ressemblances détectées", () => {
  const good = samples(PEACE, 8, 300).map((s) => s.vector);
  assert.equal(checkSamples(good).ok, true);
  const withOutlier = [...good, normalize(hand({ curl: FIST }))];
  const r = checkSamples(withOutlier);
  assert.equal(r.ok, false);
  assert.deepEqual(r.outliers, [8]);
  const existing = buildModel([gestures[2]]);
  assert.equal(checkSamples(good, existing).similarTo, "Deux doigts");
  assert.equal(checkSamples(good.slice(0, 2)).ok, false);
});

test("moteur : seuil, stabilité, anti-répétition et relâchement", () => {
  const e = new GestureEngine({ threshold: 0.8, stabilityMs: 500, cooldownMs: 2000 });
  const ok = { id: "a", name: "A", confidence: 0.9 };
  const weak = { id: "a", name: "A", confidence: 0.5 };
  assert.equal(e.update(weak, 0).fire, false, "sous le seuil : rien");
  assert.equal(e.update(ok, 100).fire, false);
  assert.equal(e.update(ok, 400).fire, false, "pas encore stable");
  assert.equal(e.update(ok, 650).fire, true, "stable depuis 550 ms : déclenche");
  assert.equal(e.update(ok, 1500).fire, false, "geste maintenu : pas de répétition");
  e.update(null, 1600);                                 // relâché
  assert.equal(e.update(ok, 1700).fire, false);
  assert.equal(e.update(ok, 2300).fire, false, "anti-répétition (2 s) pas encore écoulée");
  assert.equal(e.update(ok, 2700).fire, true, "après relâchement et délai : nouveau déclenchement");
  assert.equal(e.update({ id: "b", name: "B", confidence: 0.95 }, 2800).progress, 0, "un autre geste repart de zéro");
});
