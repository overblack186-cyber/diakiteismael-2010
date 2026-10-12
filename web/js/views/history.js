// Vue « Historique » : conversations enregistrées (ouvrir, renommer, archiver, supprimer).
import { api } from "../api.js";
import { icon } from "../icons.js";
import { conversationMenu, deleteConversation, renameConversation } from "../main.js";
import { esc, formatDate, html } from "../ui.js";

const PAGE = 40;

export async function render(container, params, ctx) {
  let archived = params.archived === "1";
  container.innerHTML = `
    <header class="topbar"><span class="topbar-title">Historique</span><span class="spacer"></span>
      <button class="btn sm primary" data-new>${icon("square-pen", 15)}Nouvelle conversation</button></header>
    <div class="page scroll"><div class="page-inner">
      <div class="tabs" role="tablist">
        <button class="tab" data-tab="0" role="tab">Conversations</button>
        <button class="tab" data-tab="1" role="tab">Archivées</button>
      </div>
      <div class="list" data-list></div>
      <div class="row mt-16" style="justify-content:center"><button class="btn hidden" data-more>Afficher plus</button></div>
    </div></div>`;
  const list = container.querySelector("[data-list]");
  const more = container.querySelector("[data-more]");
  container.querySelector("[data-new]").onclick = () => ctx.newChat();
  let offset = 0;

  async function load(reset = true) {
    if (reset) { offset = 0; list.innerHTML = ""; }
    container.querySelectorAll("[data-tab]").forEach((t) => {
      t.classList.toggle("active", (t.dataset.tab === "1") === archived);
      t.setAttribute("aria-selected", (t.dataset.tab === "1") === archived);
    });
    const { items } = await api.get(`/api/conversations?archived=${archived ? 1 : 0}&limit=${PAGE}&offset=${offset}`);
    const visible = items.filter((c) => c.message_count > 0 || archived);
    offset += items.length;
    more.classList.toggle("hidden", items.length < PAGE);
    if (reset && !visible.length) {
      list.innerHTML = `<div class="empty">${icon(archived ? "archive" : "history", 30)}<h3>${archived ? "Aucune conversation archivée" : "Aucune conversation"}</h3>
        <p>${archived ? "Les conversations archivées sont conservées ici, hors de la barre latérale." : "Vos conversations apparaîtront ici et resteront disponibles après le redémarrage."}</p></div>`;
      return;
    }
    for (const c of visible) {
      const el = html(`<div class="list-item clickable" tabindex="0">
        <span class="li-icon">${icon("message-square", 17)}</span>
        <div class="li-main"><div class="li-title">${esc(c.title)}</div>
          <div class="li-sub">${formatDate(c.updated_at)} · ${c.message_count} message${c.message_count > 1 ? "s" : ""}${c.project_id ? " · dans un projet" : ""}</div></div>
        <div class="li-actions">
          <button class="icon-btn sm" data-a="rename" title="Renommer" aria-label="Renommer">${icon("pencil", 15)}</button>
          <button class="icon-btn sm" data-a="archive" title="${c.archived ? "Désarchiver" : "Archiver"}" aria-label="${c.archived ? "Désarchiver" : "Archiver"}">${icon(c.archived ? "archive-restore" : "archive", 15)}</button>
          <button class="icon-btn sm" data-a="delete" title="Supprimer" aria-label="Supprimer">${icon("trash-2", 15)}</button>
        </div></div>`);
      el.onclick = async (e) => {
        const a = e.target.closest("[data-a]")?.dataset.a;
        if (!a) return ctx.navigate(`#/chat/${c.id}`);
        e.stopPropagation();
        if (a === "rename") renameConversation(c, () => load());
        if (a === "delete") deleteConversation(c, () => load());
        if (a === "archive") {
          await api.patch(`/api/conversations/${c.id}`, { archived: !c.archived });
          const { refreshRecents } = await import("../chat-controller.js");
          refreshRecents();
          load();
        }
      };
      el.onkeydown = (e) => { if (e.key === "Enter" && e.target === el) ctx.navigate(`#/chat/${c.id}`); };
      el.oncontextmenu = (e) => { e.preventDefault(); conversationMenu({ x: e.clientX, y: e.clientY }, c, { onChange: () => load() }); };
      list.append(el);
    }
  }

  container.querySelectorAll("[data-tab]").forEach((t) => t.onclick = () => { archived = t.dataset.tab === "1"; load(); });
  more.onclick = () => load(false);
  await load();
}
