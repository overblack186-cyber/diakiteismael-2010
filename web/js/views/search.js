// Vue « Rechercher » : recherche dans les titres et messages réellement enregistrés.
import { api } from "../api.js";
import { icon } from "../icons.js";
import { debounce, esc, formatDate, html } from "../ui.js";

let lastQuery = "";   // conservée pour « revenir aux résultats »

function highlight(text, q) {
  const safe = esc(text);
  if (!q) return safe;
  const pattern = new RegExp(esc(q).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
  return safe.replace(pattern, (m) => `<mark class="hl">${m}</mark>`);
}

export async function render(container, params, ctx) {
  const initial = params.q ?? lastQuery;
  container.innerHTML = `
    <header class="topbar"><span class="topbar-title">Rechercher</span></header>
    <div class="page scroll"><div class="page-inner">
      <label class="search-box">${icon("search", 18)}<input type="search" placeholder="Rechercher dans les titres et les messages…"
        aria-label="Rechercher dans les conversations" value="${esc(initial)}"><span class="spinner hidden" data-spin></span></label>
      <div class="muted small mt-8" data-count></div>
      <div class="mt-16" data-results></div>
    </div></div>`;
  const input = container.querySelector("input");
  const results = container.querySelector("[data-results]");
  const count = container.querySelector("[data-count]");
  const spin = container.querySelector("[data-spin]");
  let seq = 0;

  async function run() {
    const q = input.value.trim();
    lastQuery = q;
    history.replaceState(null, "", q ? `#/search?q=${encodeURIComponent(q)}` : "#/search");
    const my = ++seq;
    if (!q) {
      results.innerHTML = `<div class="empty">${icon("search", 30)}<h3>Retrouvez une conversation</h3>
        <p>La recherche porte sur les titres et le contenu de tous vos messages enregistrés, y compris archivés.</p></div>`;
      count.textContent = "";
      return;
    }
    spin.classList.remove("hidden");
    try {
      const data = await api.get(`/api/search?q=${encodeURIComponent(q)}`);
      if (my !== seq) return;
      results.innerHTML = "";
      count.textContent = data.results.length ? `${data.results.length} conversation${data.results.length > 1 ? "s" : ""}` : "";
      if (!data.results.length) {
        results.innerHTML = `<div class="empty"><h3>Aucun résultat</h3><p>Aucun titre ni message ne contient « ${esc(q)} ».</p></div>`;
        return;
      }
      // affichage progressif : les premiers résultats d'abord
      const render = (start) => {
        for (const r of data.results.slice(start, start + 20)) {
          const el = html(`<div class="result" tabindex="0" role="link">
            <div class="result-title">${icon("message-square", 15)}<span>${highlight(r.title, q)}</span>
              ${r.archived ? '<span class="badge">archivée</span>' : ""}<span class="spacer" style="flex:1"></span><span class="muted small">${formatDate(r.updated_at)}</span></div>
            ${r.matches.map((m) => `<div class="result-snippet" data-mid="${m.message_id}"><span class="role">${m.role === "user" ? "Vous" : "NexaAI"}</span><span>${highlight(m.snippet, q)}</span></div>`).join("")}
          </div>`);
          const open = (mid) => ctx.navigate(`#/chat/${r.id}${mid ? `?m=${mid}` : ""}`);
          el.onclick = (e) => open(e.target.closest("[data-mid]")?.dataset.mid || r.matches[0]?.message_id);
          el.onkeydown = (e) => { if (e.key === "Enter") open(r.matches[0]?.message_id); };
          results.append(el);
        }
        if (start + 20 < data.results.length) requestAnimationFrame(() => render(start + 20));
      };
      render(0);
    } catch (err) {
      if (my === seq) results.innerHTML = `<div class="notice err">${icon("circle-alert", 16)}<div>${esc(err.message)}</div></div>`;
    } finally {
      if (my === seq) spin.classList.add("hidden");
    }
  }

  input.addEventListener("input", debounce(run, 180));
  input.focus();
  input.select();
  run();
}
