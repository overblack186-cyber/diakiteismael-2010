"""Génère web/js/icons.js à partir du paquet npm « lucide-static » (licence ISC).

Usage (développeurs uniquement) :
    npm pack lucide-static && tar xzf lucide-static-*.tgz
    python scripts/build_icons.py package/icons

L'application n'a pas besoin de ce script pour fonctionner : icons.js est versionné.
"""
import re
import sys
from pathlib import Path

NAMES = """plus square-pen search history folder-kanban brain folder code-xml scan-eye hand
audio-lines monitor-cog settings arrow-up square mic mic-off paperclip x copy check refresh-cw
pencil trash-2 info flag ellipsis chevron-down chevron-right chevron-left panel-left panel-right
archive archive-restore command camera camera-off volume-2 volume-x play file file-text file-image
file-code folder-open external-link cpu cloud shield-check key-round globe terminal app-window
triangle-alert circle-alert loader-circle download eye eye-off bookmark sliders-horizontal keyboard
power sun moon arrow-left git-compare save undo-2 layers link unlink zap hard-drive server activity
rotate-ccw circle-check circle-x clock message-square user circle-stop list-checks database lock""".split()

FOOTER = '''
/** Retourne le balisage SVG d'une icône (taille en px). */
export function icon(name, size = 18, extraClass = "") {
  const body = ICONS[name];
  if (!body) throw new Error(`Icône inconnue : ${name}`);
  return `<svg class="ico ${extraClass}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
}
'''


def main(icon_dir: str, out: str = "web/js/icons.js") -> None:
    lines = [
        "// Icônes vectorielles issues de Lucide (licence ISC, voir web/vendor/LICENSE-lucide.txt).",
        "// Généré par scripts/build_icons.py — ne pas modifier à la main.",
        "export const ICONS = {",
    ]
    for name in NAMES:
        svg = (Path(icon_dir) / f"{name}.svg").read_text(encoding="utf-8")
        inner = re.search(r"<svg[^>]*>(.*)</svg>", svg, re.S).group(1)
        inner = re.sub(r"\s*\n\s*", "", inner).replace(" />", "/>").replace('"', "'")
        lines.append(f'  "{name}": "{inner}",')
    lines.append("};")
    Path(out).write_text("\n".join(lines) + "\n" + FOOTER, encoding="utf-8")


if __name__ == "__main__":
    main(*sys.argv[1:])
