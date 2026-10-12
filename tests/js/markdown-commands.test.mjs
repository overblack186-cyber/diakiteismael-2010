// Tests du rendu Markdown (sécurité) et de la recherche de la palette de commandes.
import assert from "node:assert/strict";
import { test } from "node:test";
import { filterCommands, fuzzyMatch } from "../../web/js/commands.js";
import { renderMarkdown, toSpeech } from "../../web/js/markdown.js";

test("aucune injection HTML ou script possible", () => {
  const out = renderMarkdown('<img src=x onerror=alert(1)> <script>x</script> [a](javascript:alert(1)) **<b>**\n```html\n<script>alert(2)</script>\n```');
  assert.ok(!out.includes("<img"), out);
  assert.ok(!out.includes("<script"), out);
  assert.ok(!out.includes('href="javascript'), out);
  assert.ok(out.includes("&lt;script&gt;"));
});

test("éléments Markdown courants", () => {
  const out = renderMarkdown("# Titre\n\n- a\n- b\n\n1. un\n2. deux\n\n> cite\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n`code` et **gras** et [lien](https://exemple.fr)");
  for (const frag of ["<h1>Titre</h1>", "<ul><li>a</li><li>b</li></ul>", "<ol><li>un</li><li>deux</li></ol>", "<blockquote>",
    "<table>", "<code>code</code>", "<strong>gras</strong>", 'href="https://exemple.fr"', 'rel="noopener noreferrer"']) {
    assert.ok(out.includes(frag), `${frag} absent de ${out}`);
  }
});

test("bloc de code non refermé pendant le streaming", () => {
  const out = renderMarkdown("Voici :\n```python\ndef f():\n    return 1");
  assert.ok(out.includes('data-closed="false"'));
  assert.ok(out.includes("def"));
});

test("texte pour la synthèse vocale sans syntaxe", () => {
  assert.equal(toSpeech("## Titre\n**Gras** et `x`.\n```js\ncode\n```\nFin"), "Titre Gras et x. (bloc de code) Fin");
});

test("palette : correspondances pertinentes uniquement, insensibles aux accents", () => {
  assert.ok(fuzzyMatch("camera", "Activer la caméra"));
  assert.equal(fuzzyMatch("cam", "Changer de modèle"), null, "lettres dispersées refusées");
  assert.ok(fuzzyMatch("nouv conv", "Nouvelle conversation"));
  const cmds = [{ title: "Activer la caméra" }, { title: "Désactiver la caméra" }, { title: "Ouvrir la vision", keywords: "caméra" }, { title: "Changer de modèle" }];
  const res = filterCommands("cam", cmds).map((r) => r.cmd.title);
  assert.deepEqual(res.slice(0, 2).sort(), ["Activer la caméra", "Désactiver la caméra"]);
  assert.ok(res.includes("Ouvrir la vision"), "recherche aussi dans les mots-clés");
  assert.ok(!res.includes("Changer de modèle"));
});
