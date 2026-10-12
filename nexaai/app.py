"""Point d'entrée : démarre le serveur local puis ouvre la fenêtre de NexaAI.

Fenêtre : Microsoft Edge ou Google Chrome en mode « application » (fenêtre
sans barre d'adresse, profil dédié dans le dossier de données). À défaut, le
navigateur par défaut est utilisé. Quand la fenêtre d'application est fermée,
NexaAI s'arrête proprement (générations annulées, base de données fermée).
"""
from __future__ import annotations

import argparse
import http.client
import json
import logging
import os
import shutil
import signal
import subprocess
import sys
import threading
import time
import webbrowser
from pathlib import Path

from . import __version__
from .logs import setup_logging
from .paths import data_dir, sub_dir
from .server import App, make_server

log = logging.getLogger("nexaai")
HEARTBEAT_TIMEOUT = 120  # secondes sans signe de vie de la page avant arrêt (mode navigateur)


def find_app_browser() -> str | None:
    candidates = []
    if sys.platform == "win32":
        for env in ("PROGRAMFILES(X86)", "PROGRAMFILES", "LOCALAPPDATA"):
            base = os.environ.get(env)
            if base:
                candidates += [Path(base) / "Microsoft/Edge/Application/msedge.exe",
                               Path(base) / "Google/Chrome/Application/chrome.exe"]
    elif sys.platform == "darwin":
        candidates += [Path("/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"),
                       Path("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")]
    for c in candidates:
        if c.exists():
            return str(c)
    for name in ("microsoft-edge", "google-chrome", "chromium", "chromium-browser"):
        found = shutil.which(name)
        if found:
            return found
    return None


def open_window(url: str, mode: str) -> subprocess.Popen | None:
    if mode == "none":
        return None
    if mode == "app":
        browser = find_app_browser()
        if browser:
            profile = sub_dir("browser-profile")
            args = [browser, f"--app={url}", f"--user-data-dir={profile}", "--window-size=1360,880",
                    "--no-first-run", "--no-default-browser-check", "--disable-features=Translate"]
            log.info("Ouverture de la fenêtre d'application (%s)", Path(browser).name)
            return subprocess.Popen(args)
        log.info("Ni Edge ni Chrome trouvés : ouverture dans le navigateur par défaut.")
    webbrowser.open(url)
    return None


def existing_instance() -> str | None:
    """Si NexaAI tourne déjà, renvoie son adresse (une seule instance à la fois)."""
    lock = data_dir() / "instance.json"
    if not lock.exists():
        return None
    try:
        info = json.loads(lock.read_text())
        port = int(info["port"])
        # http.client direct : jamais de proxy système pour une adresse locale
        conn = http.client.HTTPConnection("127.0.0.1", port, timeout=1.5)
        conn.request("GET", "/")
        resp = conn.getresponse()
        is_nexaai = resp.status == 200 and resp.getheader("Server", "").startswith("NexaAI")
        conn.close()
        return f"http://127.0.0.1:{port}/" if is_nexaai else None
    except Exception:
        return None


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="nexaai", description="NexaAI — assistant personnel")
    parser.add_argument("--port", type=int, default=int(os.environ.get("NEXAAI_PORT", 8765)))
    parser.add_argument("--window", choices=["app", "browser", "none"], help="mode d'ouverture de la fenêtre")
    parser.add_argument("--version", action="version", version=f"NexaAI {__version__}")
    args = parser.parse_args(argv)

    setup_logging()
    running = existing_instance()
    if running:
        log.info("NexaAI est déjà lancé : ouverture de la fenêtre existante.")
        app_settings_window = args.window or "app"
        open_window(running, app_settings_window)
        return 0

    app = App()
    server = make_server(app, args.port)
    url = f"http://127.0.0.1:{app.port}/"
    (data_dir() / "instance.json").write_text(json.dumps({"port": app.port, "pid": os.getpid()}))
    threading.Thread(target=server.serve_forever, name="http", daemon=True).start()
    app.last_heartbeat = time.time() + 60  # délai de grâce pour l'ouverture de la page
    log.info("NexaAI %s démarré sur %s (données : %s)", __version__, url, data_dir())

    mode = args.window or app.settings.get("general", "window")
    window = open_window(url, mode)

    stop = threading.Event()
    signal.signal(signal.SIGINT, lambda *_: stop.set())
    if hasattr(signal, "SIGTERM"):
        signal.signal(signal.SIGTERM, lambda *_: stop.set())
    launched_at = time.time()
    try:
        while not stop.is_set() and not app.shutdown_requested.is_set():
            if window is not None and window.poll() is not None:
                if time.time() - launched_at > 5:
                    log.info("Fenêtre fermée.")
                    break
                # Le navigateur a confié la fenêtre à une instance existante :
                # on surveille alors les signes de vie envoyés par la page.
                window = None
            if window is None and mode != "none" and time.time() - app.last_heartbeat > HEARTBEAT_TIMEOUT:
                log.info("Plus aucune fenêtre NexaAI ouverte depuis %ss.", HEARTBEAT_TIMEOUT)
                break
            stop.wait(0.5)
    finally:
        log.info("Arrêt de NexaAI…")
        app.chat.cancel_all()
        app.chat.wait_all(timeout=5)
        server.shutdown()
        server.server_close()
        app.storage.close()
        try:
            (data_dir() / "instance.json").unlink()
        except OSError:
            pass
        if window is not None and window.poll() is None and app.shutdown_requested.is_set():
            window.terminate()
        log.info("NexaAI arrêté proprement.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
