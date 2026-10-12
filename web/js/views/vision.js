// Vue « Vision et gestes » : caméra, détection locale des mains, bibliothèque et apprentissage des gestes.
import { api } from "../api.js";
import { staticCommands } from "../commands.js";
import { icon } from "../icons.js";
import { state } from "../store.js";
import { confirmDialog, esc, formatDate, html, menu, promptDialog, switchHtml, toast } from "../ui.js";
import { buildModel, checkSamples, classify } from "../vision/classifier.js";
import { vision } from "../vision/hands.js";

const TABS = [["", "Caméra et détection"], ["gestures", "Bibliothèque des gestes"], ["diagnostics", "Diagnostics"]];

function gestureActions() {
  return staticCommands().filter((c) => c.gesture !== false).sort((a, b) => a.group.localeCompare(b.group) || a.title.localeCompare(b.title));
}
function actionTitle(id) {
  return id ? (staticCommands().find((c) => c.id === id)?.title || `Commande inconnue (${id})`) : "Aucune action";
}

export async function render(container, params, ctx) {
  const tab = TABS.some(([k]) => k === (params.id || "")) ? params.id || "" : "";
  container.innerHTML = `
    <header class="topbar"><span class="topbar-title">Vision et gestes</span><span class="spacer"></span>
      <span class="badge cyan ${state.system.cameraOn ? "" : "hidden"}" data-camstate>${icon("camera", 12)}Caméra active</span></header>
    <div class="page scroll"><div class="page-inner" style="max-width:1120px">
      <div class="tabs">${TABS.map(([k, l]) => `<button class="tab ${k === tab ? "active" : ""}" data-tab="${k}">${l}</button>`).join("")}</div>
      <div data-body></div></div></div>`;
  container.querySelectorAll("[data-tab]").forEach((b) => b.onclick = () => ctx.navigate(`#/vision${b.dataset.tab ? `/${b.dataset.tab}` : ""}`));
  const body = container.querySelector("[data-body]");
  const cleanups = [];
  const onChange = () => container.querySelector("[data-camstate]")?.classList.toggle("hidden", !state.system.cameraOn);
  vision.addEventListener("change", onChange);
  cleanups.push(() => vision.removeEventListener("change", onChange));

  if (tab === "gestures") cleanups.push(await renderLibrary(body, params, ctx));
  else if (tab === "diagnostics") cleanups.push(await renderDiagnostics(body));
  else cleanups.push(await renderCamera(body, ctx));
  return () => cleanups.forEach((c) => c?.());
}

// -- Moteur de détection : installation -------------------------------------------------
async function engineBlock(onReady) {
  const box = html('<div></div>');
  const draw = async () => {
    const st = await api.get("/api/vision/status");
    if (st.installed) { box.innerHTML = ""; onReady?.(); return; }
    box.innerHTML = `<div class="notice ${st.error ? "err" : "info"} mb-8">${icon(st.error ? "circle-alert" : "download", 16)}<div class="grow">
      <b>Moteur de détection des mains à installer</b>
      <div class="small mt-8">Détection 100 % locale (MediaPipe, Apache 2.0). Téléchargement unique de 27 Mo avec vérification d'intégrité ; aucune image n'est envoyée.</div>
      ${st.error ? `<div class="small mt-8"><b>Échec :</b> ${esc(st.error)}</div>` : ""}
      ${st.running ? `<div class="progress mt-8"><div style="width:${Math.round(st.progress * 100)}%"></div></div><div class="small muted mt-8">${esc(st.step)}…</div>`
        : `<button class="btn sm primary mt-8" data-install>${icon("download", 14)}${st.error ? "Réessayer" : "Installer"}</button>`}</div></div>`;
    box.querySelector("[data-install]")?.addEventListener("click", async () => { await api.post("/api/vision/install"); draw(); });
    if (st.running) setTimeout(() => { if (box.isConnected) draw(); }, 700);
  };
  await draw();
  return box;
}

// -- Onglet caméra -------------------------------------------------------------------------
async function renderCamera(body, ctx) {
  const v = state.settings.vision;
  body.innerHTML = `<div class="vision-layout">
    <div>
      <div class="stage" data-stage>
        <div class="stage-empty" data-empty>${icon("camera-off", 30)}<div><b style="color:#d6d6d6">Caméra désactivée</b><br>
          <span class="small">Elle reste éteinte tant que vous ne l'activez pas. Aucune image n'est enregistrée.</span></div></div>
        <span class="stage-badge hidden" data-live><span class="dot"></span>En direct</span>
        <div class="stage-gesture hidden" data-gesture><span data-gname>—</span><div class="meter"><div data-gconf></div></div><span class="small" data-gpct></span></div>
      </div>
      <div class="row wrap mt-16">
        <button class="btn primary" data-cam>${icon("camera", 15)}Activer la caméra</button>
        <select class="select" style="width:auto;max-width:260px" data-device aria-label="Caméra"><option value="">Caméra par défaut</option></select>
        <span class="spacer" style="flex:1"></span>
        <button class="btn" data-detect>${icon("hand", 15)}Détecter les gestes</button>
      </div>
      <div class="muted small mt-8" data-camstatus></div>
    </div>
    <div>
      <div data-engine></div>
      <div class="section-title">Reconnaissance</div>
      <div class="setting" style="padding-top:4px"><div class="setting-text"><div class="setting-title">Mode test</div><div class="setting-desc">Affiche le geste reconnu sans exécuter son action.</div></div>
        <div class="setting-control">${switchHtml(v.test_mode, "data-test")}</div></div>
      <div class="setting"><div class="setting-text"><div class="setting-title">Afficher les repères</div><div class="setting-desc">Squelette de la main sur l'aperçu.</div></div>
        <div class="setting-control">${switchHtml(v.show_landmarks, "data-landmarks")}</div></div>
      <div class="field mt-16"><label>Seuil de confiance : <span data-v="confidence">${Math.round(v.confidence * 100)} %</span></label>
        <input type="range" min="0.5" max="0.98" step="0.01" value="${v.confidence}" data-s="confidence"></div>
      <div class="field"><label>Durée de stabilité : <span data-v="stability_ms">${v.stability_ms} ms</span></label>
        <input type="range" min="0" max="2000" step="50" value="${v.stability_ms}" data-s="stability_ms">
        <div class="help">Le geste doit être maintenu ce temps avant de déclencher son action.</div></div>
      <div class="field"><label>Anti-répétition : <span data-v="cooldown_ms">${v.cooldown_ms} ms</span></label>
        <input type="range" min="500" max="10000" step="250" value="${v.cooldown_ms}" data-s="cooldown_ms">
        <div class="help">Délai minimal entre deux déclenchements ; il faut aussi relâcher le geste.</div></div>
      <div class="section-title mt-16">Derniers gestes reconnus<span class="spacer"></span><button class="btn sm ghost" data-clearlog>Effacer</button></div>
      <div class="list" data-log></div>
      <div class="muted small mt-8">Historique conservé uniquement pendant cette session, en mémoire.</div>
    </div></div>`;
  const $ = (s) => body.querySelector(s);
  const stage = $("[data-stage]");
  const canvas = document.createElement("canvas");
  stage.prepend(vision.video, canvas);
  vision.attachCanvas(canvas);
  $("[data-engine]").append(await engineBlock(() => drawState()));

  async function fillDevices() {
    try {
      const cams = await vision.listCameras();
      const sel = $("[data-device]");
      sel.innerHTML = '<option value="">Caméra par défaut</option>' + cams.map((c, i) => `<option value="${esc(c.deviceId)}" ${c.deviceId === state.settings.vision.camera_device ? "selected" : ""}>${esc(c.label || `Caméra ${i + 1}`)}</option>`).join("");
    } catch { /* liste facultative */ }
  }

  function drawState() {
    const on = vision.cameraOn;
    $("[data-empty]").classList.toggle("hidden", on);
    $("[data-live]").classList.toggle("hidden", !on);
    $("[data-cam]").innerHTML = on ? `${icon("camera-off", 15)}Désactiver la caméra` : `${icon("camera", 15)}Activer la caméra`;
    $("[data-cam]").classList.toggle("primary", !on);
    $("[data-detect]").innerHTML = vision.detecting ? `${icon("hand", 15)}Suspendre la détection` : `${icon("hand", 15)}Détecter les gestes`;
    $("[data-detect]").classList.toggle("primary", vision.detecting);
    $("[data-gesture]").classList.toggle("hidden", !vision.detecting);
    const info = vision.settingsInfo();
    $("[data-camstatus]").textContent = on
      ? `${info?.label || "Caméra"} · ${info?.width || "?"}×${info?.height || "?"}${vision.detecting ? ` · détection ${vision.delegate} · ${vision.fps} images/s analysées · ${vision.model.classes.length} geste(s) actif(s)` : ""}`
      : "";
  }

  $("[data-cam]").onclick = async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    try {
      if (vision.cameraOn) vision.stopCamera();
      else { await vision.startCamera($("[data-device]").value); fillDevices(); }
    } catch (err) { toast(err.message, { kind: "err" }); }
    btn.disabled = false;
    drawState();
  };
  $("[data-device]").onchange = async (e) => {
    await ctx.updateSettings({ vision: { camera_device: e.target.value } });
    if (vision.cameraOn) { try { await vision.startCamera(e.target.value); } catch (err) { toast(err.message, { kind: "err" }); } }
    drawState();
  };
  $("[data-detect]").onclick = async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    try {
      if (vision.detecting) vision.stopDetection();
      else {
        await vision.startDetection();
        if (!vision.model.classes.length) toast("Aucun geste enregistré : créez-en un dans la bibliothèque des gestes.");
      }
    } catch (err) { toast(err.message, { kind: "err" }); }
    btn.disabled = false;
    drawState();
  };
  $("[data-test]").onchange = (e) => ctx.updateSettings({ vision: { test_mode: e.target.checked } });
  $("[data-landmarks]").onchange = async (e) => { await ctx.updateSettings({ vision: { show_landmarks: e.target.checked } }); vision.drawOverlay(); };
  body.querySelectorAll("[data-s]").forEach((r) => {
    const key = r.dataset.s;
    const fmt = (x) => (key === "confidence" ? `${Math.round(x * 100)} %` : `${x} ms`);
    r.oninput = () => { body.querySelector(`[data-v="${key}"]`).textContent = fmt(+r.value); };
    r.onchange = async () => { await ctx.updateSettings({ vision: { [key]: +r.value } }); vision.configureEngine(); };
  });

  const log = $("[data-log]");
  const drawLog = () => {
    log.innerHTML = vision.testLog.length ? "" : '<div class="muted small" style="padding:10px 4px">Aucun geste reconnu pour l\'instant.</div>';
    for (const l of vision.testLog.slice(0, 8)) {
      log.append(html(`<div class="list-item" style="padding:8px 4px"><div class="li-main"><div class="li-title">${esc(l.name)} <span class="muted small">${Math.round(l.confidence * 100)} %</span></div>
        <div class="li-sub">${new Date(l.at).toLocaleTimeString("fr-FR")} · ${esc(l.outcome)}</div></div></div>`));
    }
  };
  $("[data-clearlog]").onclick = () => { vision.testLog.length = 0; drawLog(); };
  drawLog();

  let frames = 0;
  const onFrame = (e) => {
    const { frame, decision } = e.detail;
    const r = frame?.result;
    $("[data-gname]").textContent = !frame ? "Aucune main détectée" : r ? r.name : "Main détectée — aucun geste enregistré";
    const conf = r?.confidence || 0;
    $("[data-gconf]").style.width = `${Math.round(conf * 100)}%`;
    $("[data-gpct]").textContent = r ? `${Math.round(conf * 100)} %${decision.id ? ` · ${Math.round(decision.progress * 100)} % stable` : ""}` : "";
    if (++frames % 15 === 0) drawState();
  };
  const onGesture = (e) => {
    const g = vision.gestures.find((x) => x.id === e.detail.id);
    vision.testLog.unshift({ ...e.detail, at: Date.now(), outcome: state.settings.vision.test_mode ? `mode test : ${actionTitle(g?.action)} non exécuté` : actionTitle(g?.action) });
    vision.testLog.length = Math.min(vision.testLog.length, 30);
    drawLog();
  };
  const onChange = () => drawState();
  vision.addEventListener("frame", onFrame);
  vision.addEventListener("gesture", onGesture);
  vision.addEventListener("change", onChange);
  drawState();
  fillDevices();
  return () => {
    vision.removeEventListener("frame", onFrame);
    vision.removeEventListener("gesture", onGesture);
    vision.removeEventListener("change", onChange);
    vision.attachCanvas(null);
    vision.video.remove();
    canvas.remove();
  };
}

// -- Onglet bibliothèque -------------------------------------------------------------------
async function renderLibrary(body, params, ctx) {
  let cleanupWizard = null;
  async function draw() {
    cleanupWizard?.();
    cleanupWizard = null;
    const items = await vision.reloadGestures();
    body.innerHTML = `<div class="page-head"><div><h1 style="font-size:18px">Bibliothèque des gestes</h1>
      <p>Chaque geste est appris à partir de vos propres exemples (positions des 21 points de la main). Seuls ces nombres sont enregistrés, jamais d'image.</p></div>
      <span class="spacer"></span><button class="btn primary" data-new>${icon("plus", 15)}Nouveau geste</button></div>
      <div class="list" data-list></div>`;
    body.querySelector("[data-new]").onclick = () => { cleanupWizard = wizard(body, ctx, draw); };
    const list = body.querySelector("[data-list]");
    if (!items.length) {
      list.innerHTML = `<div class="empty">${icon("hand", 30)}<h3>Aucun geste enregistré</h3>
        <p>Créez un geste : nommez-le, enregistrez une dizaine d'exemples devant la caméra, testez-le puis associez-lui une action.</p></div>`;
    }
    for (const g of items) {
      const el = html(`<div class="list-item" style="${g.enabled ? "" : "opacity:.6"}"><span class="li-icon">${icon("hand", 18)}</span>
        <div class="li-main"><div class="li-title">${esc(g.name)}</div>
        <div class="li-sub">${g.sample_count} exemple(s) · ${esc(actionTitle(g.action))} · sensibilité ${String(g.sensitivity).replace(".", ",")} · ${formatDate(g.updated_at)}${g.sample_count < 3 ? " · inactif (3 exemples minimum)" : ""}</div></div>
        ${switchHtml(g.enabled, `data-toggle aria-label="Activer ce geste" title="${g.enabled ? "Désactiver" : "Activer"} ce geste"`)}
        <button class="icon-btn sm" data-more title="Options" aria-label="Options">${icon("ellipsis", 16)}</button></div>`);
      el.querySelector("[data-toggle]").onchange = async (e) => { await api.patch(`/api/gestures/${g.id}`, { enabled: e.target.checked }); draw(); };
      el.querySelector("[data-more]").onclick = (e) => menu(e.currentTarget, [
        { label: "Renommer", icon: "pencil", run: async () => {
          const name = await promptDialog({ title: "Renommer le geste", label: "Nom", value: g.name });
          if (name) { await api.patch(`/api/gestures/${g.id}`, { name }); draw(); }
        } },
        { label: "Ajouter des exemples", icon: "plus", run: () => { cleanupWizard = wizard(body, ctx, draw, g); } },
        { label: "Changer l'action", icon: "zap", run: () => chooseAction(e.currentTarget, g.action, async (action) => { await api.patch(`/api/gestures/${g.id}`, { action }); draw(); }) },
        { label: "Sensibilité…", icon: "sliders-horizontal", run: async () => {
          const val = await promptDialog({ title: "Sensibilité", label: "Valeur entre 0,5 (strict) et 2 (tolérant)", value: String(g.sensitivity).replace(".", ","),
            help: "Une valeur élevée reconnaît le geste plus facilement mais augmente les confusions." });
          if (val == null) return;
          try { await api.patch(`/api/gestures/${g.id}`, { sensitivity: parseFloat(val.replace(",", ".")) }); draw(); } catch (err) { toast(err.message, { kind: "err" }); }
        } },
        "sep",
        { label: "Supprimer…", icon: "trash-2", danger: true, run: async () => {
          if (!(await confirmDialog({ title: "Supprimer ce geste ?", message: `« ${g.name} » et ses ${g.sample_count} exemples seront supprimés.`, confirm: "Supprimer", danger: true }))) return;
          await api.del(`/api/gestures/${g.id}`);
          toast("Geste supprimé.", { kind: "ok" });
          draw();
        } },
      ], { align: "end" });
      list.append(el);
    }
  }
  await draw();
  if (params.new) cleanupWizard = wizard(body, ctx, draw);
  return () => cleanupWizard?.();
}

function chooseAction(anchor, current, onPick) {
  const items = [{ label: "Aucune action (test uniquement)", icon: "x", checked: !current, run: () => onPick("") }, "sep"];
  let group = null;
  for (const c of gestureActions()) {
    if (c.group !== group) { group = c.group; items.push({ head: group }); }
    items.push({ label: c.title + (c.sensitive ? " (confirmation)" : ""), icon: c.icon, checked: c.id === current, run: () => onPick(c.id) });
  }
  const pop = menu(anchor, items, { align: "end" });
  pop.style.maxHeight = "420px";
  pop.style.overflowY = "auto";
}

/**
 * Assistant d'apprentissage d'un geste (ou d'ajout d'exemples à un geste existant).
 * Étapes : nom → nombre d'exemples → capture → vérification → test → action → enregistrement.
 */
function wizard(body, ctx, onDone, existing = null) {
  const steps = existing ? ["capture", "check", "test", "save"] : ["name", "count", "capture", "check", "test", "action", "save"];
  const data = { name: existing?.name || "", count: 12, samples: [], action: existing?.action || "", sensitivity: existing?.sensitivity || 1 };
  let step = 0;
  let captureTimer = null;
  let countdownTimer = null;
  let testHandler = null;
  vision.suppress = true;   // aucune action de geste pendant l'apprentissage

  const panel = html(`<div class="provider-card" style="padding:20px"><div class="row mb-8"><b data-title></b><span class="spacer" style="flex:1"></span>
    <button class="icon-btn sm" data-cancel aria-label="Annuler">${icon("x", 16)}</button></div><div class="steps" data-steps></div><div data-content></div></div>`);
  body.prepend(panel);
  panel.querySelector("[data-cancel]").onclick = () => { cleanup(); onDone(); };

  function cleanup() {
    clearInterval(captureTimer);
    clearInterval(countdownTimer);
    if (testHandler) vision.removeEventListener("frame", testHandler);
    vision.suppress = false;
    vision.attachCanvas(null);
    vision.video.remove();
    panel.remove();
  }

  async function ensureDetection() {
    if (!vision.detecting) await vision.startDetection();
  }

  function stage() {
    const st = html('<div class="stage mb-8" style="max-width:460px"></div>');
    const canvas = document.createElement("canvas");
    st.append(vision.video, canvas);
    vision.attachCanvas(canvas);
    return st;
  }

  function next() { step++; draw(); }

  async function draw() {
    const name = steps[step];
    panel.querySelector("[data-title]").textContent = existing ? `Ajouter des exemples à « ${existing.name} »` : "Nouveau geste";
    panel.querySelector("[data-steps]").innerHTML = steps.map((_, i) => `<span class="${i <= step ? "done" : ""}"></span>`).join("");
    const c = panel.querySelector("[data-content]");
    clearInterval(captureTimer);
    clearInterval(countdownTimer);
    if (testHandler) { vision.removeEventListener("frame", testHandler); testHandler = null; }

    if (name === "name") {
      c.innerHTML = `<div class="field"><label>Nom du geste</label><input class="input" data-name placeholder="Ex. : Main ouverte, Pouce levé, Deux doigts" value="${esc(data.name)}"></div>
        <div class="row" style="justify-content:flex-end"><button class="btn primary" data-next>Continuer</button></div>`;
      const input = c.querySelector("[data-name]");
      input.focus();
      const go = () => { if (!input.value.trim()) return input.focus(); data.name = input.value.trim(); next(); };
      c.querySelector("[data-next]").onclick = go;
      input.onkeydown = (e) => { if (e.key === "Enter") go(); };
    } else if (name === "count") {
      c.innerHTML = `<div class="field"><label>Nombre d'exemples à enregistrer : <b data-cv>${data.count}</b></label>
        <input type="range" min="5" max="30" step="1" value="${data.count}" data-count>
        <div class="help">Plus d'exemples = reconnaissance plus fiable. Variez légèrement l'angle et la distance, en gardant la même forme de main.</div></div>
        <div class="row" style="justify-content:flex-end"><button class="btn primary" data-next>Continuer</button></div>`;
      c.querySelector("[data-count]").oninput = (e) => { data.count = +e.target.value; c.querySelector("[data-cv]").textContent = data.count; };
      c.querySelector("[data-next]").onclick = next;
    } else if (name === "capture") {
      if (existing && !data.countSet) { data.count = 8; data.countSet = true; }
      c.innerHTML = '<div class="row"><span class="spinner"></span><span>Préparation de la caméra et du moteur…</span></div>';
      try { await ensureDetection(); } catch (err) {
        c.innerHTML = `<div class="notice err">${icon("circle-alert", 16)}<div>${esc(err.message)}<br>Installez le moteur et vérifiez la caméra dans l'onglet « Caméra et détection ».</div></div>`;
        return;
      }
      data.samples = [];
      c.innerHTML = `<div class="vision-layout" style="grid-template-columns:minmax(0,460px) 1fr"><div data-stage></div>
        <div><div class="big-count" data-n>0 / ${data.count}</div>
        <p class="muted" data-instr>Placez votre main devant la caméra en faisant le geste « ${esc(data.name)} ». La capture démarre après un compte à rebours de 3 secondes, puis un exemple est pris toutes les 0,4 s quand une main est détectée.</p>
        <div class="progress mb-8"><div data-p style="width:0%"></div></div>
        <div class="row"><button class="btn primary" data-start>${icon("play", 14)}Commencer la capture</button></div></div></div>`;
      c.querySelector("[data-stage]").append(stage());
      const n = c.querySelector("[data-n]");
      const instr = c.querySelector("[data-instr]");
      c.querySelector("[data-start]").onclick = (e) => {
        e.currentTarget.disabled = true;
        let countdown = 3;
        instr.textContent = `Préparez le geste… ${countdown}`;
        countdownTimer = setInterval(() => {
          countdown--;
          if (countdown > 0) { instr.textContent = `Préparez le geste… ${countdown}`; return; }
          clearInterval(countdownTimer);
          instr.textContent = "Capture en cours : gardez le geste, bougez légèrement la main.";
          captureTimer = setInterval(() => {
            const vec = vision.currentVector();
            if (!vec) { instr.textContent = "Aucune main détectée : placez la main bien visible dans le cadre."; return; }
            instr.textContent = "Capture en cours : gardez le geste, bougez légèrement la main.";
            data.samples.push(vec);
            n.textContent = `${data.samples.length} / ${data.count}`;
            c.querySelector("[data-p]").style.width = `${(data.samples.length / data.count) * 100}%`;
            if (data.samples.length >= data.count) { clearInterval(captureTimer); next(); }
          }, 400);
        }, 1000);
      };
    } else if (name === "check") {
      const others = buildModel(vision.gestures.filter((g) => g.id !== existing?.id));
      const all = existing ? [...(vision.gestures.find((g) => g.id === existing.id)?.samples || []).map((s) => s.vector), ...data.samples] : data.samples;
      const r = checkSamples(all, others);
      c.innerHTML = `<div class="notice ${r.ok ? "info" : "warn"} mb-8">${icon(r.ok ? "circle-check" : "triangle-alert", 16)}<div>
        ${r.ok ? `Les ${all.length} exemples sont cohérents (dispersion moyenne ${r.spread}) et distincts des autres gestes.` : esc(r.reason)}</div></div>
        <div class="row" style="justify-content:flex-end">
          <button class="btn" data-redo>${icon("rotate-ccw", 14)}Recommencer la capture</button>
          ${r.outliers.length ? '<button class="btn" data-drop>Retirer les exemples incohérents</button>' : ""}
          <button class="btn primary" data-next ${all.length < 3 ? "disabled" : ""}>Continuer</button></div>`;
      c.querySelector("[data-redo]").onclick = () => { step = steps.indexOf("capture"); draw(); };
      c.querySelector("[data-drop]")?.addEventListener("click", () => {
        const offset = all.length - data.samples.length;
        data.samples = data.samples.filter((_, i) => !r.outliers.includes(i + offset));
        draw();
      });
      c.querySelector("[data-next]").onclick = next;
    } else if (name === "test") {
      const temp = vision.gestures.filter((g) => g.id !== existing?.id && g.enabled);
      const mine = { id: "__new__", name: data.name, sensitivity: data.sensitivity, samples: [...(existing ? vision.gestures.find((g) => g.id === existing.id)?.samples || [] : []), ...data.samples.map((v) => ({ vector: v }))] };
      const model = buildModel([...temp, mine]);
      c.innerHTML = `<div class="vision-layout" style="grid-template-columns:minmax(0,460px) 1fr"><div data-stage></div><div>
        <p class="muted">Testez : faites le geste, puis d'autres positions de main. Rien n'est exécuté pendant ce test.</p>
        <div class="big-count" data-res style="font-size:22px">—</div>
        <div class="meter mt-8"><div data-conf></div></div><div class="small muted mt-8" data-detail></div>
        <div class="field mt-16"><label>Sensibilité : <span data-sv>${data.sensitivity}</span></label>
          <input type="range" min="0.5" max="2" step="0.1" value="${data.sensitivity}" data-sens></div>
        <div class="row" style="justify-content:flex-end"><button class="btn primary" data-next>Continuer</button></div></div></div>`;
      c.querySelector("[data-stage]").append(stage());
      let currentModel = model;
      c.querySelector("[data-sens]").oninput = (e) => {
        data.sensitivity = +e.target.value;
        c.querySelector("[data-sv]").textContent = data.sensitivity;
        mine.sensitivity = data.sensitivity;
        currentModel = buildModel([...temp, mine]);
      };
      testHandler = (e) => {
        const f = e.detail.frame;
        const r = f ? classify(currentModel, f.vector) : null;
        const ok = r && r.confidence >= state.settings.vision.confidence;
        c.querySelector("[data-res]").textContent = !f ? "Aucune main" : ok ? r.name : "Non reconnu";
        c.querySelector("[data-res]").style.color = ok && r.id === "__new__" ? "var(--success)" : "";
        c.querySelector("[data-conf]").style.width = `${Math.round((r?.confidence || 0) * 100)}%`;
        c.querySelector("[data-detail]").textContent = r ? `Plus proche : ${r.name} — confiance ${Math.round(r.confidence * 100)} % (seuil ${Math.round(state.settings.vision.confidence * 100)} %)` : "";
      };
      vision.addEventListener("frame", testHandler);
      c.querySelector("[data-next]").onclick = next;
    } else if (name === "action") {
      c.innerHTML = `<p>Que doit faire NexaAI quand ce geste est reconnu ?</p>
        <div class="row"><button class="btn" data-pick>${icon("zap", 14)}<span data-label>${esc(actionTitle(data.action))}</span>${icon("chevron-down", 14)}</button></div>
        <div class="help muted small mt-8">Les actions sensibles demandent toujours une confirmation. En mode test, aucune action n'est exécutée.</div>
        <div class="row" style="justify-content:flex-end"><button class="btn primary" data-next>Continuer</button></div>`;
      c.querySelector("[data-pick]").onclick = (e) => chooseAction(e.currentTarget, data.action, (a) => { data.action = a; c.querySelector("[data-label]").textContent = actionTitle(a); });
      c.querySelector("[data-next]").onclick = next;
    } else if (name === "save") {
      c.innerHTML = `<dl class="kv mb-8"><dt>Geste</dt><dd>${esc(data.name)}</dd><dt>Nouveaux exemples</dt><dd>${data.samples.length}</dd>
        <dt>Action</dt><dd>${esc(actionTitle(data.action))}</dd><dt>Sensibilité</dt><dd>${data.sensitivity}</dd></dl>
        <div class="row" style="justify-content:flex-end"><button class="btn primary" data-save>${icon("save", 14)}Enregistrer le geste</button></div>`;
      c.querySelector("[data-save]").onclick = async () => {
        try {
          if (existing) {
            await api.post(`/api/gestures/${existing.id}/samples`, { samples: data.samples });
            await api.patch(`/api/gestures/${existing.id}`, { sensitivity: data.sensitivity });
          } else {
            await api.post("/api/gestures", { name: data.name, action: data.action, sensitivity: data.sensitivity, samples: data.samples });
          }
          await vision.reloadGestures();
          toast(existing ? "Exemples ajoutés." : `Geste « ${data.name} » enregistré.`, { kind: "ok" });
          cleanup();
          onDone();
        } catch (err) { toast(err.message, { kind: "err" }); }
      };
    }
  }
  draw();
  return cleanup;
}

// -- Onglet diagnostics ------------------------------------------------------------------------
async function renderDiagnostics(body) {
  const rows = [];
  const add = (k, v, ok = null) => rows.push(`<div class="setting"><div class="setting-text"><div class="setting-title">${esc(k)}</div><div class="setting-desc">${esc(v)}</div></div>
    ${ok == null ? "" : `<span class="dot ${ok ? "ok" : "err"}"></span>`}</div>`);
  add("Accès caméra du navigateur", navigator.mediaDevices?.getUserMedia ? "Disponible (contexte sécurisé localhost)" : "Indisponible dans ce navigateur", !!navigator.mediaDevices?.getUserMedia);
  try {
    const perm = await navigator.permissions.query({ name: "camera" });
    add("Permission caméra", { granted: "Accordée", denied: "Refusée — modifiez-la dans les réglages du site", prompt: "Sera demandée à l'activation" }[perm.state] || perm.state, perm.state !== "denied");
  } catch { add("Permission caméra", "Non consultable dans ce navigateur"); }
  try {
    const cams = await vision.listCameras();
    add("Caméras détectées", cams.length ? cams.map((c, i) => c.label || `Caméra ${i + 1} (nom visible après autorisation)`).join(" · ") : "Aucune", cams.length > 0);
  } catch (err) { add("Caméras détectées", err.message, false); }
  const st = await api.get("/api/vision/status");
  add("Moteur de détection des mains", st.installed ? `MediaPipe ${st.version} installé dans ${st.dir}` : "Non installé", st.installed);
  add("Accélération", vision.delegate ? `${vision.delegate === "GPU" ? "Carte graphique (WebGL)" : "Processeur"}` : "Déterminée au premier lancement de la détection");
  add("État actuel", `${vision.cameraOn ? "Caméra active" : "Caméra éteinte"} · ${vision.detecting ? `détection active (${vision.fps} images/s)` : "détection arrêtée"}`);
  add("Fréquence d'analyse maximale", `${state.settings.vision.max_fps} images/s (réglage Paramètres › Vision)`);
  add("Gestes enregistrés", `${vision.gestures.length || (await api.get("/api/gestures")).items.length}`);
  add("Confidentialité", "Aucune image n'est enregistrée ni transmise. Seuls les exemples de gestes (63 nombres chacun) sont stockés localement.");
  body.innerHTML = `<div class="list">${rows.join("")}</div>`;
}
