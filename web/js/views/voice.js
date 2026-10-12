// Vue « Voix » : reconnaissance, synthèse, périphériques, tests et conversation vocale continue.
import { icon } from "../icons.js";
import { on, state } from "../store.js";
import { esc, html, switchHtml, toast } from "../ui.js";
import { voice } from "../voice.js";

const LANGS = [["fr-FR", "Français (France)"], ["fr-CA", "Français (Canada)"], ["fr-BE", "Français (Belgique)"], ["en-US", "Anglais (États-Unis)"],
  ["en-GB", "Anglais (Royaume-Uni)"], ["es-ES", "Espagnol"], ["de-DE", "Allemand"], ["it-IT", "Italien"], ["ar-SA", "Arabe"]];

export async function render(container, params, ctx) {
  const v = state.settings.voice;
  container.innerHTML = `
    <header class="topbar"><span class="topbar-title">Voix</span><span class="spacer"></span>
      <span class="badge danger ${state.system.listening ? "" : "hidden"}" data-livebadge>${icon("mic", 12)}Micro actif</span></header>
    <div class="page scroll"><div class="page-inner">
      <div class="page-head"><div><h1>Voix</h1><p>Dictée, lecture des réponses et conversation vocale. Le micro ne s'active jamais sans action de votre part.</p></div></div>

      <div class="section-title">${icon("mic", 15)}Reconnaissance vocale (dictée)</div>
      <div data-stt-notice></div>
      <div class="setting"><div class="setting-text"><div class="setting-title">Langue de dictée</div></div>
        <div class="setting-control"><select class="select" data-lang>${LANGS.map(([k, l]) => `<option value="${k}" ${k === v.stt_lang ? "selected" : ""}>${l}</option>`).join("")}</select></div></div>
      <div class="setting"><div class="setting-text"><div class="setting-title">Microphone</div>
        <div class="setting-desc">Utilisé pour le test et l'indicateur de niveau. La dictée du navigateur utilise le micro par défaut de Windows.</div></div>
        <div class="setting-control"><select class="select" data-mic><option value="">Micro par défaut</option></select></div></div>
      <div class="setting"><div class="setting-text"><div class="setting-title">Tester le microphone</div>
        <div class="setting-desc">Mesure le niveau sonore localement pendant 10 secondes. Rien n'est enregistré.</div>
        <div class="meter mt-8" style="max-width:320px"><div data-level></div></div></div>
        <div class="setting-control"><button class="btn" data-mictest>${icon("activity", 15)}Tester</button></div></div>
      <div class="setting"><div class="setting-text"><div class="setting-title">Tester la dictée</div>
        <div class="setting-desc" data-transcript>Cliquez puis parlez : la transcription s'affiche ici.</div></div>
        <div class="setting-control"><button class="btn" data-dictest>${icon("mic", 15)}Dicter</button></div></div>
      <div class="setting"><div class="setting-text"><div class="setting-title">Conversation vocale continue</div>
        <div class="setting-desc">Option explicite : après chaque dictée, le message est envoyé automatiquement, la réponse est lue, puis l'écoute reprend. Échap ou le bouton Arrêter terminent la session vocale ; aucune phrase entendue l'arrête aussi.</div></div>
        <div class="setting-control">${switchHtml(v.continuous, "data-continuous")}</div></div>

      <div class="section-title mt-16">${icon("volume-2", 15)}Synthèse vocale (lecture)</div>
      <div data-tts-notice></div>
      <div class="setting"><div class="setting-text"><div class="setting-title">Voix</div><div class="setting-desc" data-voicedesc></div></div>
        <div class="setting-control"><select class="select" data-voice></select></div></div>
      <div class="setting"><div class="setting-text"><div class="setting-title">Vitesse : <span data-ratev>${v.tts_rate.toFixed(1).replace(".", ",")}×</span></div></div>
        <div class="setting-control"><input type="range" min="0.5" max="2" step="0.1" value="${v.tts_rate}" data-rate style="width:240px"></div></div>
      <div class="setting"><div class="setting-text"><div class="setting-title">Volume : <span data-volv>${Math.round(v.tts_volume * 100)} %</span></div></div>
        <div class="setting-control"><input type="range" min="0" max="1" step="0.05" value="${v.tts_volume}" data-volume style="width:240px"></div></div>
      <div class="setting"><div class="setting-text"><div class="setting-title">Haut-parleurs</div>
        <div class="setting-desc">La synthèse du navigateur utilise la sortie audio par défaut de Windows : le choix du périphérique se fait dans les paramètres son de Windows.</div></div>
        <div class="setting-control"><select class="select" disabled title="Non pris en charge par la synthèse vocale du navigateur"><option>Sortie par défaut de Windows</option></select></div></div>
      <div class="setting"><div class="setting-text"><div class="setting-title">Lire automatiquement les réponses</div></div>
        <div class="setting-control">${switchHtml(v.auto_read, "data-autoread")}</div></div>
      <div class="setting"><div class="setting-text"><div class="setting-title">Tester la synthèse vocale</div>
        <div class="setting-desc">Vous pouvez interrompre la lecture à tout moment.</div></div>
        <div class="setting-control"><button class="btn" data-ttstest>${icon("play", 15)}Écouter</button><button class="btn" data-ttsstop>${icon("square", 13)}Arrêter</button></div></div>
    </div></div>`;
  const $ = (s) => container.querySelector(s);

  if (!voice.sttAvailable) {
    $("[data-stt-notice]").append(html(`<div class="notice warn mb-8">${icon("triangle-alert", 16)}<div>${esc(voice.sttUnavailableReason())} La saisie au clavier reste disponible.</div></div>`));
    $("[data-dictest]").disabled = true;
  } else {
    $("[data-stt-notice]").append(html(`<div class="notice info mb-8">${icon("cloud", 16)}<div>La dictée utilise la reconnaissance vocale intégrée au navigateur : dans Microsoft Edge et Google Chrome,
      l'audio est transcrit par un service en ligne de l'éditeur du navigateur (Microsoft ou Google). Une connexion Internet est nécessaire. Les réponses de NexaAI, elles, restent locales en mode local.</div></div>`));
  }
  if (!voice.ttsAvailable) {
    $("[data-tts-notice]").append(html(`<div class="notice warn mb-8">${icon("triangle-alert", 16)}<div>La synthèse vocale n'est pas disponible dans ce navigateur. Les réponses restent lisibles à l'écran.</div></div>`));
    container.querySelectorAll("[data-ttstest],[data-ttsstop],[data-voice],[data-autoread]").forEach((x) => { x.disabled = true; });
  }

  // -- périphériques -----------------------------------------------------------
  async function fillMics() {
    try {
      const devs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "audioinput");
      $("[data-mic]").innerHTML = '<option value="">Micro par défaut</option>' + devs.filter((d) => d.deviceId !== "default")
        .map((d, i) => `<option value="${esc(d.deviceId)}" ${d.deviceId === state.settings.voice.mic_device ? "selected" : ""}>${esc(d.label || `Microphone ${i + 1} (nom visible après autorisation)`)}</option>`).join("");
    } catch { /* liste facultative */ }
  }
  function fillVoices() {
    const sel = $("[data-voice]");
    const lang = state.settings.voice.stt_lang.slice(0, 2);
    const voices = [...voice.voices].sort((a, b) => (b.lang.startsWith(lang) - a.lang.startsWith(lang)) || a.name.localeCompare(b.name));
    sel.innerHTML = '<option value="">Automatique (voix locale de la langue)</option>' + voices.map((x) =>
      `<option value="${esc(x.voiceURI)}" ${x.voiceURI === state.settings.voice.tts_voice ? "selected" : ""}>${esc(x.name)} — ${esc(x.lang)}${x.localService ? "" : " (en ligne)"}</option>`).join("");
    const picked = voice.pickVoice();
    $("[data-voicedesc]").textContent = !voices.length ? "Aucune voix installée détectée." : picked
      ? `Voix utilisée : ${picked.name}${picked.localService ? " (locale, hors ligne)" : " (en ligne : le texte est envoyé au service de l'éditeur du navigateur)"}.`
      : "Aucune voix ne correspond à la langue : la voix par défaut du système sera utilisée.";
  }
  voice.addEventListener("voices", fillVoices);
  fillVoices();
  fillMics();

  // -- réglages --------------------------------------------------------------------
  const save = (patch) => ctx.updateSettings({ voice: patch }).then(fillVoices);
  $("[data-lang]").onchange = (e) => save({ stt_lang: e.target.value });
  $("[data-mic]").onchange = (e) => save({ mic_device: e.target.value });
  $("[data-voice]").onchange = (e) => save({ tts_voice: e.target.value });
  $("[data-rate]").oninput = (e) => { $("[data-ratev]").textContent = `${(+e.target.value).toFixed(1).replace(".", ",")}×`; };
  $("[data-rate]").onchange = (e) => save({ tts_rate: +e.target.value });
  $("[data-volume]").oninput = (e) => { $("[data-volv]").textContent = `${Math.round(e.target.value * 100)} %`; };
  $("[data-volume]").onchange = (e) => save({ tts_volume: +e.target.value });
  $("[data-autoread]").onchange = (e) => save({ auto_read: e.target.checked });
  $("[data-continuous]").onchange = async (e) => {
    await save({ continuous: e.target.checked, ...(e.target.checked ? { auto_read: true } : {}) });
    if (e.target.checked) { $("[data-autoread]").checked = true; toast("Conversation vocale continue activée : utilisez le micro de la conversation pour commencer.", { kind: "ok" }); }
  };

  // -- tests --------------------------------------------------------------------------------
  let micTimer = null;
  $("[data-mictest]").onclick = async (e) => {
    const btn = e.currentTarget;
    if (voice.meter) { stopMicTest(); return; }
    try {
      await voice.startMeter($("[data-mic]").value);
      fillMics();
      btn.innerHTML = `${icon("square", 13)}Arrêter`;
      micTimer = setTimeout(stopMicTest, 10000);
    } catch (err) {
      toast(err.name === "NotAllowedError" ? "Accès au microphone refusé." : err.name === "NotFoundError" ? "Aucun microphone détecté." : `Microphone indisponible (${err.name || err.message}).`, { kind: "err" });
    }
  };
  function stopMicTest() {
    clearTimeout(micTimer);
    voice.stopMeter();
    const b = $("[data-mictest]");
    if (b) b.innerHTML = `${icon("activity", 15)}Tester`;
    const l = $("[data-level]");
    if (l) l.style.width = "0%";
  }
  const onLevel = (e) => { const l = $("[data-level]"); if (l) l.style.width = `${Math.round(e.detail * 100)}%`; };
  voice.addEventListener("level", onLevel);

  $("[data-dictest]").onclick = async (e) => {
    if (voice.listening) { voice.stopListening(); return; }
    const out = $("[data-transcript]");
    out.textContent = "Parlez maintenant…";
    try {
      const text = await voice.listen({ onText: (t) => { out.textContent = t || "Parlez maintenant…"; } });
      out.textContent = text ? `Transcription : « ${text} »` : "Aucune parole détectée.";
    } catch (err) { out.textContent = err.message; }
  };
  $("[data-ttstest]").onclick = () => {
    try { voice.speak("Bonjour, je suis NexaAI. Voici un test de la synthèse vocale, avec la vitesse et le volume choisis."); }
    catch (err) { toast(err.message, { kind: "err" }); }
  };
  $("[data-ttsstop]").onclick = () => voice.stopSpeaking();

  const off = on("system", () => {
    $("[data-livebadge]")?.classList.toggle("hidden", !state.system.listening);
    const d = $("[data-dictest]");
    if (d) d.innerHTML = state.system.listening ? `${icon("mic-off", 15)}Arrêter` : `${icon("mic", 15)}Dicter`;
  });
  return () => {
    stopMicTest();
    voice.removeEventListener("level", onLevel);
    voice.removeEventListener("voices", fillVoices);
    off();
  };
}
