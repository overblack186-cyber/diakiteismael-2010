"""Persistance locale (SQLite) : conversations, messages, projets, mémoire,
gestes, journal des actions, pièces jointes et consommation des fournisseurs.

Une seule connexion protégée par un verrou : simple, sûr entre threads, et
largement suffisant pour un usage personnel.
"""
from __future__ import annotations

import json
import sqlite3
import threading
import time
import uuid
from pathlib import Path
from typing import Any, Iterable

from .paths import data_dir

SCHEMA_VERSION = 1

SCHEMA = """
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
    notes TEXT NOT NULL DEFAULT '', created_at REAL NOT NULL, updated_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS conversations (
    id TEXT PRIMARY KEY, title TEXT NOT NULL, project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
    model_pref TEXT NOT NULL DEFAULT '', archived INTEGER NOT NULL DEFAULT 0,
    created_at REAL NOT NULL, updated_at REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_conv_updated ON conversations(updated_at DESC);
CREATE TABLE IF NOT EXISTS messages (
    seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    role TEXT NOT NULL, content TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'ok',
    provider TEXT NOT NULL DEFAULT '', model TEXT NOT NULL DEFAULT '',
    meta TEXT NOT NULL DEFAULT '{}', created_at REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_msg_conv ON messages(conversation_id, seq);
CREATE TABLE IF NOT EXISTS project_files (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    path TEXT NOT NULL, added_at REAL NOT NULL, UNIQUE(project_id, path)
);
CREATE TABLE IF NOT EXISTS memory (
    id TEXT PRIMARY KEY, kind TEXT NOT NULL, content TEXT NOT NULL,
    project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
    source TEXT NOT NULL DEFAULT 'manual', enabled INTEGER NOT NULL DEFAULT 1,
    created_at REAL NOT NULL, updated_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS gestures (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, action TEXT NOT NULL DEFAULT '',
    sensitivity REAL NOT NULL DEFAULT 1.0, enabled INTEGER NOT NULL DEFAULT 1,
    created_at REAL NOT NULL, updated_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS gesture_samples (
    id TEXT PRIMARY KEY, gesture_id TEXT NOT NULL REFERENCES gestures(id) ON DELETE CASCADE,
    vector TEXT NOT NULL, created_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS action_log (
    id TEXT PRIMARY KEY, tool TEXT NOT NULL, args TEXT NOT NULL, origin TEXT NOT NULL,
    status TEXT NOT NULL, summary TEXT NOT NULL DEFAULT '', result TEXT NOT NULL DEFAULT '',
    conversation_id TEXT, created_at REAL NOT NULL, finished_at REAL
);
CREATE INDEX IF NOT EXISTS idx_action_created ON action_log(created_at DESC);
CREATE TABLE IF NOT EXISTS attachments (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL,
    kind TEXT NOT NULL, path TEXT NOT NULL, created_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS usage (
    provider_id TEXT NOT NULL, day TEXT NOT NULL, requests INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY(provider_id, day)
);
"""

MEMORY_KINDS = ("preference", "fact", "project_note")


def new_id() -> str:
    return uuid.uuid4().hex


class NotFound(KeyError):
    pass


class Storage:
    def __init__(self, path: Path | None = None):
        self.path = path or (data_dir() / "nexaai.db")
        self._lock = threading.RLock()
        self._db = sqlite3.connect(str(self.path), check_same_thread=False)
        self._db.row_factory = sqlite3.Row
        self._db.execute("PRAGMA foreign_keys = ON")
        self._db.execute("PRAGMA journal_mode = WAL")
        self._db.executescript(SCHEMA)
        self._db.execute("INSERT OR IGNORE INTO meta(key, value) VALUES('schema_version', ?)", (str(SCHEMA_VERSION),))
        self._db.commit()

    def close(self) -> None:
        with self._lock:
            self._db.close()

    # -- utilitaires ------------------------------------------------------
    def _q(self, sql: str, params: Iterable[Any] = ()) -> list[dict]:
        with self._lock:
            return [dict(r) for r in self._db.execute(sql, tuple(params)).fetchall()]

    def _one(self, sql: str, params: Iterable[Any] = ()) -> dict | None:
        rows = self._q(sql, params)
        return rows[0] if rows else None

    def _exec(self, sql: str, params: Iterable[Any] = ()) -> int:
        with self._lock:
            cur = self._db.execute(sql, tuple(params))
            self._db.commit()
            return cur.rowcount

    # -- conversations ----------------------------------------------------
    def create_conversation(self, title: str = "Nouvelle conversation", project_id: str | None = None,
                            model_pref: str = "") -> dict:
        now = time.time()
        cid = new_id()
        if project_id:
            self.get_project(project_id)
        self._exec("INSERT INTO conversations(id, title, project_id, model_pref, created_at, updated_at) "
                   "VALUES(?,?,?,?,?,?)", (cid, title, project_id, model_pref, now, now))
        return self.get_conversation(cid)

    def get_conversation(self, cid: str) -> dict:
        row = self._one("SELECT c.*, (SELECT COUNT(*) FROM messages m WHERE m.conversation_id=c.id) AS message_count "
                        "FROM conversations c WHERE c.id=?", (cid,))
        if not row:
            raise NotFound(f"Conversation introuvable : {cid}")
        row["archived"] = bool(row["archived"])
        return row

    def list_conversations(self, archived: bool | None = False, limit: int = 50, offset: int = 0,
                           project_id: str | None = None) -> list[dict]:
        where, params = [], []
        if archived is not None:
            where.append("c.archived=?")
            params.append(1 if archived else 0)
        if project_id:
            where.append("c.project_id=?")
            params.append(project_id)
        sql = ("SELECT c.*, (SELECT COUNT(*) FROM messages m WHERE m.conversation_id=c.id) AS message_count "
               "FROM conversations c")
        if where:
            sql += " WHERE " + " AND ".join(where)
        sql += " ORDER BY c.updated_at DESC LIMIT ? OFFSET ?"
        rows = self._q(sql, params + [limit, offset])
        for r in rows:
            r["archived"] = bool(r["archived"])
        return rows

    def update_conversation(self, cid: str, **fields: Any) -> dict:
        self.get_conversation(cid)
        allowed = {"title", "project_id", "model_pref", "archived"}
        sets, params = [], []
        for key, value in fields.items():
            if key not in allowed:
                raise ValueError(f"Champ non modifiable : {key}")
            if key == "title":
                value = (value or "").strip()[:200] or "Sans titre"
            if key == "archived":
                value = 1 if value else 0
            if key == "project_id" and value:
                self.get_project(value)
            sets.append(f"{key}=?")
            params.append(value or None if key == "project_id" else value)
        if sets:
            sets.append("updated_at=?")
            params.append(time.time())
            self._exec(f"UPDATE conversations SET {', '.join(sets)} WHERE id=?", params + [cid])
        return self.get_conversation(cid)

    def touch_conversation(self, cid: str) -> None:
        self._exec("UPDATE conversations SET updated_at=? WHERE id=?", (time.time(), cid))

    def purge_empty_conversations(self, older_than: float = 86400) -> int:
        """Supprime les conversations restées vides (créées sans message) depuis plus d'un jour."""
        return self._exec("DELETE FROM conversations WHERE updated_at < ? AND NOT EXISTS "
                          "(SELECT 1 FROM messages m WHERE m.conversation_id = conversations.id)",
                          (time.time() - older_than,))

    def delete_conversation(self, cid: str) -> None:
        if not self._exec("DELETE FROM conversations WHERE id=?", (cid,)):
            raise NotFound(f"Conversation introuvable : {cid}")

    # -- messages ---------------------------------------------------------
    def add_message(self, cid: str, role: str, content: str, status: str = "ok", provider: str = "",
                    model: str = "", meta: dict | None = None) -> dict:
        self.get_conversation(cid)
        mid = new_id()
        now = time.time()
        self._exec("INSERT INTO messages(id, conversation_id, role, content, status, provider, model, meta, created_at) "
                   "VALUES(?,?,?,?,?,?,?,?,?)",
                   (mid, cid, role, content, status, provider, model, json.dumps(meta or {}), now))
        self.touch_conversation(cid)
        return self.get_message(mid)

    @staticmethod
    def _msg(row: dict) -> dict:
        row["meta"] = json.loads(row["meta"] or "{}")
        return row

    def get_message(self, mid: str) -> dict:
        row = self._one("SELECT * FROM messages WHERE id=?", (mid,))
        if not row:
            raise NotFound(f"Message introuvable : {mid}")
        return self._msg(row)

    def list_messages(self, cid: str) -> list[dict]:
        return [self._msg(r) for r in self._q("SELECT * FROM messages WHERE conversation_id=? ORDER BY seq", (cid,))]

    def update_message(self, mid: str, **fields: Any) -> dict:
        msg = self.get_message(mid)
        sets, params = [], []
        for key, value in fields.items():
            if key not in {"content", "status", "provider", "model", "meta"}:
                raise ValueError(f"Champ non modifiable : {key}")
            if key == "meta":
                merged = dict(msg["meta"])
                merged.update(value)
                value = json.dumps(merged)
            sets.append(f"{key}=?")
            params.append(value)
        if sets:
            self._exec(f"UPDATE messages SET {', '.join(sets)} WHERE id=?", params + [mid])
        return self.get_message(mid)

    def delete_message(self, mid: str) -> None:
        if not self._exec("DELETE FROM messages WHERE id=?", (mid,)):
            raise NotFound(f"Message introuvable : {mid}")

    def delete_messages_after(self, mid: str, inclusive: bool = False) -> int:
        msg = self.get_message(mid)
        op = ">=" if inclusive else ">"
        row = self._one("SELECT seq FROM messages WHERE id=?", (mid,))
        return self._exec(f"DELETE FROM messages WHERE conversation_id=? AND seq {op} ?",
                          (msg["conversation_id"], row["seq"]))

    def search(self, query: str, limit: int = 60) -> list[dict]:
        """Recherche dans les titres et les messages réellement enregistrés."""
        query = query.strip()
        if not query:
            return []
        like = "%" + query.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"
        results: dict[str, dict] = {}
        for conv in self._q("SELECT id, title, updated_at, archived FROM conversations WHERE title LIKE ? ESCAPE '\\' "
                            "ORDER BY updated_at DESC LIMIT ?", (like, limit)):
            results[conv["id"]] = {**conv, "archived": bool(conv["archived"]), "title_match": True, "matches": []}
        rows = self._q("SELECT m.id, m.conversation_id, m.role, m.content, m.created_at, c.title, c.updated_at, c.archived "
                       "FROM messages m JOIN conversations c ON c.id=m.conversation_id "
                       "WHERE m.content LIKE ? ESCAPE '\\' AND m.role IN ('user','assistant') "
                       "ORDER BY c.updated_at DESC, m.seq LIMIT ?", (like, limit * 4))
        lowered = query.lower()
        for r in rows:
            entry = results.setdefault(r["conversation_id"], {
                "id": r["conversation_id"], "title": r["title"], "updated_at": r["updated_at"],
                "archived": bool(r["archived"]), "title_match": False, "matches": []})
            if len(entry["matches"]) >= 3:
                continue
            text = r["content"]
            pos = text.lower().find(lowered)
            start = max(0, pos - 60)
            snippet = ("…" if start else "") + text[start:pos + len(query) + 90].replace("\n", " ")
            if pos + len(query) + 90 < len(text):
                snippet += "…"
            entry["matches"].append({"message_id": r["id"], "role": r["role"], "snippet": snippet})
        return sorted(results.values(), key=lambda e: e["updated_at"], reverse=True)[:limit]

    # -- projets ----------------------------------------------------------
    def create_project(self, name: str, description: str = "") -> dict:
        name = name.strip()
        if not name:
            raise ValueError("Le nom du projet est obligatoire")
        now = time.time()
        pid = new_id()
        self._exec("INSERT INTO projects(id, name, description, created_at, updated_at) VALUES(?,?,?,?,?)",
                   (pid, name[:120], description.strip(), now, now))
        return self.get_project(pid)

    def get_project(self, pid: str) -> dict:
        row = self._one("SELECT * FROM projects WHERE id=?", (pid,))
        if not row:
            raise NotFound(f"Projet introuvable : {pid}")
        row["conversation_count"] = self._one("SELECT COUNT(*) n FROM conversations WHERE project_id=?", (pid,))["n"]
        row["file_count"] = self._one("SELECT COUNT(*) n FROM project_files WHERE project_id=?", (pid,))["n"]
        return row

    def list_projects(self) -> list[dict]:
        return [self.get_project(r["id"]) for r in self._q("SELECT id FROM projects ORDER BY updated_at DESC")]

    def update_project(self, pid: str, **fields: Any) -> dict:
        self.get_project(pid)
        sets, params = [], []
        for key, value in fields.items():
            if key not in {"name", "description", "notes"}:
                raise ValueError(f"Champ non modifiable : {key}")
            if key == "name" and not str(value).strip():
                raise ValueError("Le nom du projet est obligatoire")
            sets.append(f"{key}=?")
            params.append(str(value).strip())
        if sets:
            sets.append("updated_at=?")
            params.append(time.time())
            self._exec(f"UPDATE projects SET {', '.join(sets)} WHERE id=?", params + [pid])
        return self.get_project(pid)

    def delete_project(self, pid: str) -> None:
        if not self._exec("DELETE FROM projects WHERE id=?", (pid,)):
            raise NotFound(f"Projet introuvable : {pid}")

    def add_project_file(self, pid: str, path: str) -> dict:
        self.get_project(pid)
        fid = new_id()
        self._exec("INSERT OR IGNORE INTO project_files(id, project_id, path, added_at) VALUES(?,?,?,?)",
                   (fid, pid, path, time.time()))
        return self._one("SELECT * FROM project_files WHERE project_id=? AND path=?", (pid, path))

    def list_project_files(self, pid: str) -> list[dict]:
        return self._q("SELECT * FROM project_files WHERE project_id=? ORDER BY path", (pid,))

    def remove_project_file(self, pid: str, file_id: str) -> None:
        if not self._exec("DELETE FROM project_files WHERE project_id=? AND id=?", (pid, file_id)):
            raise NotFound("Fichier non associé à ce projet")

    # -- mémoire ----------------------------------------------------------
    def add_memory(self, kind: str, content: str, project_id: str | None = None, source: str = "manual") -> dict:
        if kind not in MEMORY_KINDS:
            raise ValueError(f"Type de mémoire inconnu : {kind}")
        content = content.strip()
        if not content:
            raise ValueError("Le contenu est vide")
        if kind == "project_note":
            if not project_id:
                raise ValueError("Une note de projet doit être rattachée à un projet")
            self.get_project(project_id)
        now = time.time()
        mid = new_id()
        self._exec("INSERT INTO memory(id, kind, content, project_id, source, created_at, updated_at) "
                   "VALUES(?,?,?,?,?,?,?)", (mid, kind, content[:2000], project_id, source, now, now))
        return self.get_memory(mid)

    def get_memory(self, mid: str) -> dict:
        row = self._one("SELECT * FROM memory WHERE id=?", (mid,))
        if not row:
            raise NotFound(f"Élément de mémoire introuvable : {mid}")
        row["enabled"] = bool(row["enabled"])
        return row

    def list_memory(self, kind: str | None = None, enabled_only: bool = False, project_id: str | None = None) -> list[dict]:
        where, params = [], []
        if kind:
            where.append("kind=?")
            params.append(kind)
        if enabled_only:
            where.append("enabled=1")
        if project_id:
            where.append("project_id=?")
            params.append(project_id)
        sql = "SELECT * FROM memory" + (" WHERE " + " AND ".join(where) if where else "") + " ORDER BY updated_at DESC"
        rows = self._q(sql, params)
        for r in rows:
            r["enabled"] = bool(r["enabled"])
        return rows

    def update_memory(self, mid: str, **fields: Any) -> dict:
        self.get_memory(mid)
        sets, params = [], []
        for key, value in fields.items():
            if key == "content":
                value = str(value).strip()
                if not value:
                    raise ValueError("Le contenu est vide")
            elif key == "enabled":
                value = 1 if value else 0
            elif key == "kind":
                if value not in MEMORY_KINDS:
                    raise ValueError("Type de mémoire inconnu")
            else:
                raise ValueError(f"Champ non modifiable : {key}")
            sets.append(f"{key}=?")
            params.append(value)
        if sets:
            sets.append("updated_at=?")
            params.append(time.time())
            self._exec(f"UPDATE memory SET {', '.join(sets)} WHERE id=?", params + [mid])
        return self.get_memory(mid)

    def delete_memory(self, mid: str) -> None:
        if not self._exec("DELETE FROM memory WHERE id=?", (mid,)):
            raise NotFound(f"Élément de mémoire introuvable : {mid}")

    def clear_memory(self) -> int:
        return self._exec("DELETE FROM memory")

    # -- gestes -----------------------------------------------------------
    def create_gesture(self, name: str, action: str = "", sensitivity: float = 1.0) -> dict:
        name = name.strip()
        if not name:
            raise ValueError("Le nom du geste est obligatoire")
        now = time.time()
        gid = new_id()
        self._exec("INSERT INTO gestures(id, name, action, sensitivity, created_at, updated_at) VALUES(?,?,?,?,?,?)",
                   (gid, name[:60], action, float(sensitivity), now, now))
        return self.get_gesture(gid)

    def get_gesture(self, gid: str, with_samples: bool = False) -> dict:
        row = self._one("SELECT * FROM gestures WHERE id=?", (gid,))
        if not row:
            raise NotFound(f"Geste introuvable : {gid}")
        row["enabled"] = bool(row["enabled"])
        samples = self._q("SELECT id, vector FROM gesture_samples WHERE gesture_id=? ORDER BY created_at", (gid,))
        row["sample_count"] = len(samples)
        if with_samples:
            row["samples"] = [{"id": s["id"], "vector": json.loads(s["vector"])} for s in samples]
        return row

    def list_gestures(self, with_samples: bool = False) -> list[dict]:
        return [self.get_gesture(r["id"], with_samples) for r in self._q("SELECT id FROM gestures ORDER BY created_at")]

    def update_gesture(self, gid: str, **fields: Any) -> dict:
        self.get_gesture(gid)
        sets, params = [], []
        for key, value in fields.items():
            if key == "name":
                value = str(value).strip()[:60]
                if not value:
                    raise ValueError("Le nom du geste est obligatoire")
            elif key == "enabled":
                value = 1 if value else 0
            elif key == "sensitivity":
                value = float(value)
                if not 0.5 <= value <= 2.0:
                    raise ValueError("La sensibilité doit être comprise entre 0,5 et 2")
            elif key != "action":
                raise ValueError(f"Champ non modifiable : {key}")
            sets.append(f"{key}=?")
            params.append(value)
        if sets:
            sets.append("updated_at=?")
            params.append(time.time())
            self._exec(f"UPDATE gestures SET {', '.join(sets)} WHERE id=?", params + [gid])
        return self.get_gesture(gid)

    def add_gesture_samples(self, gid: str, vectors: list[list[float]]) -> dict:
        self.get_gesture(gid)
        now = time.time()
        for i, vec in enumerate(vectors):
            if not isinstance(vec, list) or len(vec) != 63 or not all(isinstance(v, (int, float)) for v in vec):
                raise ValueError("Chaque exemple doit contenir 63 valeurs numériques (21 repères × 3)")
            self._exec("INSERT INTO gesture_samples(id, gesture_id, vector, created_at) VALUES(?,?,?,?)",
                       (new_id(), gid, json.dumps([round(float(v), 5) for v in vec]), now + i * 1e-6))
        return self.get_gesture(gid)

    def delete_gesture_sample(self, gid: str, sample_id: str) -> None:
        if not self._exec("DELETE FROM gesture_samples WHERE gesture_id=? AND id=?", (gid, sample_id)):
            raise NotFound("Exemple introuvable")

    def delete_gesture(self, gid: str) -> None:
        if not self._exec("DELETE FROM gestures WHERE id=?", (gid,)):
            raise NotFound(f"Geste introuvable : {gid}")

    # -- journal des actions ---------------------------------------------
    def log_action(self, tool: str, args: dict, origin: str, status: str, summary: str = "",
                   conversation_id: str | None = None) -> dict:
        aid = new_id()
        self._exec("INSERT INTO action_log(id, tool, args, origin, status, summary, conversation_id, created_at) "
                   "VALUES(?,?,?,?,?,?,?,?)", (aid, tool, json.dumps(args, ensure_ascii=False), origin, status,
                                               summary, conversation_id, time.time()))
        return self.get_action(aid)

    def update_action(self, aid: str, status: str, result: str = "") -> dict:
        finished = time.time() if status in {"done", "failed", "denied", "cancelled"} else None
        self._exec("UPDATE action_log SET status=?, result=?, finished_at=COALESCE(?, finished_at) WHERE id=?",
                   (status, result[:4000], finished, aid))
        return self.get_action(aid)

    def get_action(self, aid: str) -> dict:
        row = self._one("SELECT * FROM action_log WHERE id=?", (aid,))
        if not row:
            raise NotFound("Action introuvable")
        row["args"] = json.loads(row["args"])
        return row

    def list_actions(self, limit: int = 100) -> list[dict]:
        rows = self._q("SELECT * FROM action_log ORDER BY created_at DESC LIMIT ?", (limit,))
        for r in rows:
            r["args"] = json.loads(r["args"])
        return rows

    # -- pièces jointes ---------------------------------------------------
    def add_attachment(self, name: str, mime: str, size: int, kind: str, path: str) -> dict:
        aid = new_id()
        self._exec("INSERT INTO attachments(id, name, mime, size, kind, path, created_at) VALUES(?,?,?,?,?,?,?)",
                   (aid, name, mime, size, kind, path, time.time()))
        return self.get_attachment(aid)

    def get_attachment(self, aid: str) -> dict:
        row = self._one("SELECT * FROM attachments WHERE id=?", (aid,))
        if not row:
            raise NotFound("Pièce jointe introuvable")
        return row

    # -- consommation -----------------------------------------------------
    def usage_today(self, provider_id: str) -> int:
        row = self._one("SELECT requests FROM usage WHERE provider_id=? AND day=?", (provider_id, time.strftime("%Y-%m-%d")))
        return row["requests"] if row else 0

    def count_request(self, provider_id: str) -> None:
        self._exec("INSERT INTO usage(provider_id, day, requests) VALUES(?,?,1) "
                   "ON CONFLICT(provider_id, day) DO UPDATE SET requests=requests+1",
                   (provider_id, time.strftime("%Y-%m-%d")))

    # -- statistiques / export -------------------------------------------
    def stats(self) -> dict:
        tables = ["conversations", "messages", "projects", "memory", "gestures", "gesture_samples", "action_log", "attachments"]
        return {t: self._one(f"SELECT COUNT(*) n FROM {t}")["n"] for t in tables}

    def export_all(self) -> dict:
        out = {"conversations": self.list_conversations(archived=None, limit=100000)}
        for conv in out["conversations"]:
            conv["messages"] = self.list_messages(conv["id"])
        out["projects"] = self.list_projects()
        out["memory"] = self.list_memory()
        out["gestures"] = [{k: v for k, v in g.items() if k != "samples"} for g in self.list_gestures()]
        out["actions"] = self.list_actions(limit=100000)
        return out
