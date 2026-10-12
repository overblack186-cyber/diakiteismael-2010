// Caméra et détection des mains (100 % locale).
//
// * La caméra est éteinte au démarrage ; elle ne s'allume que sur action explicite.
// * Aucune image n'est enregistrée ni envoyée : seules les coordonnées des repères
//   de la main sont calculées, et seuls les exemples de gestes enregistrés par
//   l'utilisateur (63 nombres chacun) sont conservés.
// * Le traitement est limité en fréquence (réglage vision.max_fps) et suspendu
//   quand la fenêtre est masquée.
import { api } from "../api.js";
import { state, setSystem } from "../store.js";
import { buildModel, classify, GestureEngine, normalize } from "./classifier.js";

const HAND_CONNECTIONS = [[0, 1], [1, 2], [2, 3], [3, 4], [0, 5], [5, 6], [6, 7], [7, 8], [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16], [13, 17], [17, 18], [18, 19], [19, 20], [0, 17]];

class VisionService extends EventTarget {
  constructor() {
    super();
    this.stream = null;
    this.video = document.createElement("video");
    this.video.muted = true;
    this.video.playsInline = true;
    this.landmarker = null;
    this.landmarkerLoading = null;
    this.delegate = "";
    this.detecting = false;
    this.raf = 0;
    this.lastProcessed = 0;
    this.fps = 0;
    this.frames = [];
    this.last = null;           // dernier résultat {landmarks, handedness, vector, result}
    this.model = { classes: [] };
    this.gestures = [];
    this.engine = new GestureEngine();
    this.canvas = null;
    this.testLog = [];
    this.onVisibility = () => { if (document.hidden) this.pauseLoop(); else if (this.detecting) this.loop(); };
    document.addEventListener("visibilitychange", this.onVisibility);
  }

  get cameraOn() { return !!this.stream; }

  async listCameras() {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.filter((d) => d.kind === "videoinput");
  }

  async startCamera(deviceId = state.settings?.vision?.camera_device) {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error("Ce navigateur ne permet pas d'accéder à la caméra.");
    this.stopCamera();
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        video: { ...(deviceId ? { deviceId: { exact: deviceId } } : {}), width: { ideal: 640 }, height: { ideal: 480 } },
        audio: false,
      });
    } catch (err) {
      const reasons = {
        NotAllowedError: "L'accès à la caméra a été refusé. Autorisez-le dans la fenêtre du navigateur puis réessayez.",
        NotFoundError: "Aucune caméra n'a été détectée sur cet ordinateur.",
        NotReadableError: "La caméra est déjà utilisée par une autre application.",
        OverconstrainedError: "La caméra sélectionnée n'est plus disponible. Choisissez-en une autre.",
      };
      throw new Error(reasons[err.name] || `Impossible d'activer la caméra (${err.name}).`);
    }
    this.video.srcObject = this.stream;
    await this.video.play().catch(() => {});
    const track = this.stream.getVideoTracks()[0];
    track.addEventListener("ended", () => this.stopCamera());
    setSystem({ cameraOn: true });
    this.dispatchEvent(new Event("change"));
  }

  stopCamera() {
    this.stopDetection();
    if (this.stream) {
      this.stream.getTracks().forEach((t) => t.stop());   // libère réellement le périphérique
      this.stream = null;
    }
    this.video.srcObject = null;
    setSystem({ cameraOn: false });
    this.dispatchEvent(new Event("change"));
  }

  settingsInfo() {
    const t = this.stream?.getVideoTracks()[0];
    return t ? { label: t.label, ...t.getSettings() } : null;
  }

  // -- Moteur MediaPipe ------------------------------------------------------------
  async loadLandmarker() {
    if (this.landmarker) return this.landmarker;
    if (this.landmarkerLoading) return this.landmarkerLoading;
    this.landmarkerLoading = (async () => {
      const status = await api.get("/api/vision/status");
      if (!status.installed) throw new Error("Le moteur de détection des mains n'est pas installé.");
      const { FilesetResolver, HandLandmarker } = await import("/vision-assets/vision_bundle.mjs");
      const fileset = await FilesetResolver.forVisionTasks("/vision-assets/wasm");
      const create = (delegate) => HandLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: "/vision-assets/hand_landmarker.task", delegate },
        runningMode: "VIDEO", numHands: 1,
        minHandDetectionConfidence: 0.6, minHandPresenceConfidence: 0.6, minTrackingConfidence: 0.5,
      });
      try {
        this.landmarker = await create("GPU");
        this.delegate = "GPU";
      } catch {
        this.landmarker = await create("CPU");
        this.delegate = "CPU";
      }
      return this.landmarker;
    })();
    try {
      return await this.landmarkerLoading;
    } finally {
      this.landmarkerLoading = null;
    }
  }

  // -- Gestes ------------------------------------------------------------------------
  async reloadGestures() {
    const { items } = await api.get("/api/gestures?samples=1");
    this.gestures = items;
    this.model = buildModel(items);
    this.dispatchEvent(new Event("gestures"));
    return items;
  }

  configureEngine() {
    const v = state.settings.vision;
    this.engine.configure({ threshold: v.confidence, stabilityMs: v.stability_ms, cooldownMs: v.cooldown_ms });
  }

  async startDetection() {
    if (!this.cameraOn) await this.startCamera();
    await this.loadLandmarker();
    await this.reloadGestures();
    this.configureEngine();
    this.engine.reset();
    this.detecting = true;
    setSystem({ gestures: true });
    this.dispatchEvent(new Event("change"));
    this.loop();
  }

  stopDetection() {
    this.detecting = false;
    this.pauseLoop();
    this.last = null;
    setSystem({ gestures: false });
    this.dispatchEvent(new Event("change"));
    this.drawOverlay();
  }

  pauseLoop() {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  loop() {
    this.pauseLoop();
    const step = (now) => {
      if (!this.detecting) return;
      this.raf = requestAnimationFrame(step);
      const minGap = 1000 / (state.settings?.vision?.max_fps || 15);
      if (now - this.lastProcessed < minGap || this.video.readyState < 2) return;
      this.lastProcessed = now;
      this.frames.push(now);
      while (this.frames.length && now - this.frames[0] > 1000) this.frames.shift();
      this.fps = this.frames.length;
      this.process(now);
    };
    this.raf = requestAnimationFrame(step);
  }

  process(now) {
    let res;
    try {
      res = this.landmarker.detectForVideo(this.video, now);
    } catch (err) {
      console.error(err);
      return;
    }
    const lm = res.landmarks?.[0];
    let frame = null;
    if (lm) {
      const handedness = res.handednesses?.[0]?.[0]?.categoryName || res.handedness?.[0]?.[0]?.categoryName || "Right";
      const vector = normalize(lm, handedness);
      const result = classify(this.model, vector);
      frame = { landmarks: lm, handedness, vector, result };
    }
    this.last = frame;
    const decision = this.engine.update(frame?.result || null, now);
    this.drawOverlay();
    this.dispatchEvent(new CustomEvent("frame", { detail: { frame, decision } }));
    if (decision.fire) this.dispatchEvent(new CustomEvent("gesture", { detail: { id: decision.id, name: decision.name, confidence: frame.result.confidence } }));
  }

  attachCanvas(canvas) {
    this.canvas = canvas;
    this.drawOverlay();
  }

  drawOverlay() {
    const c = this.canvas;
    if (!c) return;
    const w = this.video.videoWidth || 640, h = this.video.videoHeight || 480;
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    const ctx = c.getContext("2d");
    ctx.clearRect(0, 0, w, h);
    if (!this.last || !state.settings?.vision?.show_landmarks) return;
    const pts = this.last.landmarks.map((p) => [p.x * w, p.y * h]);
    ctx.lineWidth = 2;
    ctx.strokeStyle = "rgba(111, 211, 230, 0.85)";
    ctx.beginPath();
    for (const [a, b] of HAND_CONNECTIONS) { ctx.moveTo(...pts[a]); ctx.lineTo(...pts[b]); }
    ctx.stroke();
    ctx.fillStyle = "#ffffff";
    for (const [x, y] of pts) { ctx.beginPath(); ctx.arc(x, y, 3, 0, Math.PI * 2); ctx.fill(); }
  }

  /** Capture l'exemple courant (vecteur normalisé) — utilisé par l'assistant d'apprentissage. */
  currentVector() {
    return this.last?.vector ? [...this.last.vector] : null;
  }
}

export const vision = new VisionService();
