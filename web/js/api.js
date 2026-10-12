// Client de l'API locale. Chaque requête porte le jeton de session.
const TOKEN = document.querySelector('meta[name="nexaai-token"]').content;

export class ApiError extends Error {
  constructor(message, status, kind) {
    super(message);
    this.status = status;
    this.kind = kind;
  }
}

async function request(method, path, body, opts = {}) {
  const headers = { "X-NexaAI-Token": TOKEN };
  let payload;
  if (body instanceof Blob || body instanceof ArrayBuffer) {
    payload = body;
    headers["Content-Type"] = "application/octet-stream";
  } else if (body !== undefined) {
    payload = JSON.stringify(body);
    headers["Content-Type"] = "application/json";
  }
  let res;
  try {
    res = await fetch(path, { method, headers, body: payload, signal: opts.signal });
  } catch (err) {
    if (err.name === "AbortError") throw err;
    throw new ApiError("NexaAI ne répond plus. Le programme a peut-être été fermé : relancez start_nexaai.bat.", 0, "offline");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(data.error || `Erreur ${res.status}`, res.status, data.kind);
  return data;
}

export const api = {
  token: TOKEN,
  get: (p, o) => request("GET", p, undefined, o),
  post: (p, b = {}, o) => request("POST", p, b, o),
  patch: (p, b = {}) => request("PATCH", p, b),
  del: (p) => request("DELETE", p),
  upload: (p, blob) => request("POST", p, blob),
  /** URL directe (images) : le jeton passe en paramètre car <img> ne peut pas envoyer d'en-tête. */
  rawUrl: (p) => `${p}${p.includes("?") ? "&" : "?"}t=${encodeURIComponent(TOKEN)}`,

  /**
   * Requête dont la réponse est un flux NDJSON. onEvent est appelé pour chaque ligne.
   * Renvoie une promesse résolue à la fin du flux.
   */
  async stream(method, path, body, onEvent, signal) {
    let res;
    try {
      res = await fetch(path, {
        method, signal,
        headers: { "X-NexaAI-Token": TOKEN, "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (err) {
      if (err.name === "AbortError") throw err;
      throw new ApiError("NexaAI ne répond plus.", 0, "offline");
    }
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new ApiError(data.error || `Erreur ${res.status}`, res.status, data.kind);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (line) onEvent(JSON.parse(line));
      }
    }
    if (buffer.trim()) onEvent(JSON.parse(buffer));
  },
};
