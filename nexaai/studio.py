"""Espace « Création et code » : propositions de modification vérifiables.

Le modèle propose une nouvelle version complète du fichier ; NexaAI calcule la
différence ligne à ligne pour que l'utilisateur la vérifie. Rien n'est écrit
sur le disque sans action explicite (bouton Enregistrer), et chaque écriture
sauvegarde la version précédente (voir files.Files.write_text).
"""
from __future__ import annotations

import difflib
import re

STUDIO_PROMPT = """Tu es l'assistant de programmation de NexaAI.
On te donne un fichier et une consigne. Renvoie UNIQUEMENT :
1. une phrase courte résumant la modification ;
2. puis la NOUVELLE VERSION COMPLÈTE du fichier dans un unique bloc de code délimité par ```.
N'omets aucune partie du fichier (pas de « ... reste inchangé »)."""


def build_messages(filename: str, content: str, instruction: str) -> list[dict]:
    return [
        {"role": "system", "content": STUDIO_PROMPT},
        {"role": "user", "content": f"Fichier : {filename or 'sans nom'}\n```\n{content}\n```\n\nConsigne : {instruction}"},
    ]


CODE_BLOCK = re.compile(r"```[^\n`]*\n(.*?)```", re.S)


def extract_code(answer: str) -> str | None:
    blocks = CODE_BLOCK.findall(answer)
    if not blocks:
        # bloc non refermé (réponse interrompue) : on refuse plutôt que d'appliquer un fichier tronqué
        return None
    return max(blocks, key=len).rstrip("\n") + "\n"


def diff_lines(old: str, new: str, context: int = 3) -> dict:
    """Différence structurée : [{type: ctx|add|del|hunk, text, old_no, new_no}]."""
    old_lines = old.splitlines()
    new_lines = new.splitlines()
    out = []
    added = removed = 0
    matcher = difflib.SequenceMatcher(a=old_lines, b=new_lines, autojunk=False)
    for group in matcher.get_grouped_opcodes(context):
        first, last = group[0], group[-1]
        out.append({"type": "hunk", "text": f"@@ -{first[1] + 1},{last[2] - first[1]} +{first[3] + 1},{last[4] - first[3]} @@"})
        for tag, i1, i2, j1, j2 in group:
            if tag == "equal":
                for k in range(i2 - i1):
                    out.append({"type": "ctx", "text": old_lines[i1 + k], "old_no": i1 + k + 1, "new_no": j1 + k + 1})
                continue
            if tag in ("replace", "delete"):
                for k in range(i1, i2):
                    out.append({"type": "del", "text": old_lines[k], "old_no": k + 1})
                    removed += 1
            if tag in ("replace", "insert"):
                for k in range(j1, j2):
                    out.append({"type": "add", "text": new_lines[k], "new_no": k + 1})
                    added += 1
    return {"lines": out, "added": added, "removed": removed, "identical": added == 0 and removed == 0}
