// Service vocal : reconnaissance (dictée), synthèse (lecture) et niveau du micro.
//
// Honnêteté sur les moteurs :
// * Reconnaissance : API Web Speech du navigateur. Dans Edge et Chrome, l'audio est
//   transcrit par un service en ligne de l'éditeur du navigateur (Microsoft / Google).
//   Elle ne démarre JAMAIS sans action explicite de l'utilisateur.
// * Synthèse : voix installées sur l'ordinateur (Windows : voix SAPI locales) ;
//   certaines voix « Online » d'Edge passent par Internet et sont signalées comme telles.
// * Le niveau du micro (animation du compagnon, test) est mesuré localement.
import { state, setSystem } from "./store.js";
import { toSpeech } from "./markdown.js";

const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;

class VoiceService extends EventTarget {
  constructor() {
    super();
    this.recognition = null;
    this.meter = null;
    this.utterance = null;
    this.voices = [];
    this.sttAvailable = !!Recognition;
    this.ttsAvailable = "speechSynthesis" in window;
    if (this.ttsAvailable) {
      const load = () => { this.voices = speechSynthesis.getVoices(); this.dispatchEvent(new Event("voices")); };
      load();
      speechSynthesis.addEventListener?.("voiceschanged", load);
    }
  }

  sttUnavailableReason() {
    if (this.sttAvailable) return "";
    return "La reconnaissance vocale n'est pas prise en charge par ce navigateur. Utilisez Microsoft Edge ou Google Chrome.";
  }

  // -- Niveau du micro -----------------------------------------------------------
  async startMeter(deviceId = state.settings?.voice?.mic_device) {
    this.stopMeter();
    const stream = await navigator.mediaDevices.getUserMedia({ audio: deviceId ? { deviceId: { exact: deviceId } } : true });
    const ctx = new AudioContext();
    const src = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    src.connect(analyser);
    const data = new Uint8Array(analyser.fftSize);
    const meter = { stream, ctx, raf: 0, level: 0 };
    const tick = () => {
      analyser.getByteTimeDomainData(data);
      let sum = 0;
      for (const v of data) { const x = (v - 128) / 128; sum += x * x; }
      const rms = Math.sqrt(sum / data.length);
      meter.level = Math.min(1, rms * 4.5);
      setSystem({ micLevel: meter.level });
      this.dispatchEvent(new CustomEvent("level", { detail: meter.level }));
      meter.raf = requestAnimationFrame(tick);
    };
    tick();
    this.meter = meter;
    return stream;
  }

  stopMeter() {
    if (!this.meter) return;
    cancelAnimationFrame(this.meter.raf);
    this.meter.stream.getTracks().forEach((t) => t.stop());
    this.meter.ctx.close().catch(() => {});
    this.meter = null;
    setSystem({ micLevel: 0 });
  }

  // -- Dictée ------------------------------------------------------------------------
  get listening() { return !!this.recognition; }

  /**
   * Démarre la dictée. onText(texte, final) reçoit la transcription au fil de l'eau.
   * Renvoie une promesse résolue à l'arrêt avec le texte final.
   */
  listen({ onText } = {}) {
    if (!this.sttAvailable) return Promise.reject(new Error(this.sttUnavailableReason()));
    this.stopListening();
    const rec = new Recognition();
    rec.lang = state.settings?.voice?.stt_lang || "fr-FR";
    rec.interimResults = true;
    rec.continuous = false;   // une phrase par dictée ; la fin du silence arrête la capture
    rec.maxAlternatives = 1;
    let finalText = "";
    this.recognition = rec;
    return new Promise((resolve, reject) => {
      let failed = null;
      rec.onstart = () => {
        setSystem({ listening: true });
        this.dispatchEvent(new Event("change"));
        this.startMeter().catch(() => {}); // niveau sonore : facultatif
      };
      rec.onresult = (e) => {
        let interim = "";
        for (let i = e.resultIndex; i < e.results.length; i++) {
          const r = e.results[i];
          if (r.isFinal) finalText += r[0].transcript;
          else interim += r[0].transcript;
        }
        onText?.((finalText + interim).trim(), !interim);
      };
      rec.onerror = (e) => {
        const reasons = {
          "not-allowed": "L'accès au microphone a été refusé. Autorisez-le dans la fenêtre du navigateur (icône à gauche de l'adresse) puis réessayez.",
          "service-not-allowed": "Le service de reconnaissance vocale du navigateur est indisponible.",
          "audio-capture": "Aucun microphone n'a été détecté.",
          network: "La reconnaissance vocale du navigateur nécessite une connexion Internet.",
          "no-speech": "",
          aborted: "",
        };
        const msg = reasons[e.error] ?? `Erreur de reconnaissance vocale (${e.error}).`;
        if (msg) failed = new Error(msg);
      };
      rec.onend = () => {
        if (this.recognition === rec) this.recognition = null;
        this.stopMeter();
        setSystem({ listening: false });
        this.dispatchEvent(new Event("change"));
        failed ? reject(failed) : resolve(finalText.trim());
      };
      try { rec.start(); } catch (err) { this.recognition = null; reject(err); }
    });
  }

  stopListening() {
    if (this.recognition) {
      try { this.recognition.stop(); } catch { /* déjà arrêtée */ }
    }
  }

  abortListening() {
    if (this.recognition) {
      try { this.recognition.abort(); } catch { /* déjà arrêtée */ }
    }
  }

  // -- Synthèse ------------------------------------------------------------------------
  pickVoice() {
    const wanted = state.settings?.voice?.tts_voice;
    if (wanted) {
      const v = this.voices.find((x) => x.voiceURI === wanted);
      if (v) return v;
    }
    const lang = (state.settings?.voice?.stt_lang || "fr-FR").slice(0, 2);
    return this.voices.find((v) => v.lang?.startsWith(lang) && v.localService) || this.voices.find((v) => v.lang?.startsWith(lang)) || null;
  }

  speak(markdownText, { onEnd } = {}) {
    if (!this.ttsAvailable) throw new Error("La synthèse vocale n'est pas disponible dans ce navigateur.");
    this.stopSpeaking();
    const text = toSpeech(markdownText);
    if (!text) return;
    const u = new SpeechSynthesisUtterance(text);
    const voice = this.pickVoice();
    if (voice) { u.voice = voice; u.lang = voice.lang; }
    u.rate = state.settings?.voice?.tts_rate ?? 1;
    u.volume = state.settings?.voice?.tts_volume ?? 1;
    u.onstart = () => { setSystem({ speaking: true }); this.dispatchEvent(new Event("change")); };
    u.onboundary = () => this.dispatchEvent(new Event("word"));
    const finish = (completed) => {
      if (this.utterance !== u) return;
      this.utterance = null;
      setSystem({ speaking: false });
      this.dispatchEvent(new Event("change"));
      if (completed) onEnd?.();   // pas de rappel si la lecture a été interrompue
    };
    u.onend = () => finish(true);
    u.onerror = () => finish(false);
    this.utterance = u;
    speechSynthesis.speak(u);
  }

  stopSpeaking() {
    if (!this.ttsAvailable) return;
    const had = this.utterance;
    this.utterance = null;
    speechSynthesis.cancel();
    if (had) { setSystem({ speaking: false }); this.dispatchEvent(new Event("change")); }
  }

  stopAll() {
    this.abortListening();
    this.stopSpeaking();
    this.stopMeter();
  }
}

export const voice = new VoiceService();
