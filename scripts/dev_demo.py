"""Lance NexaAI avec un faux Ollama (démonstration / tests d'interface, sans modèle réel).

    python scripts/dev_demo.py [--port 8765]

Les données sont stockées dans un dossier temporaire distinct (NEXAAI_HOME).
"""
import argparse
import os
import sys
import tempfile
import threading
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

parser = argparse.ArgumentParser()
parser.add_argument("--port", type=int, default=8765)
parser.add_argument("--home", default="")
args = parser.parse_args()
os.environ["NEXAAI_HOME"] = args.home or tempfile.mkdtemp(prefix="nexaai-demo-")

from tests.py.fakes import FakeOllamaHandler, FakeOpenAIHandler, start  # noqa: E402
from nexaai.logs import setup_logging  # noqa: E402
from nexaai.server import App, make_server  # noqa: E402

fake, _ = start(FakeOllamaHandler)
remote, _ = start(FakeOpenAIHandler)
setup_logging()
app = App()
app.settings.update({"providers": {"ollama": {"base_url": f"http://127.0.0.1:{fake.server_address[1]}", "enabled": True}}})
server = make_server(app, args.port)
print(f"DEMO_URL=http://127.0.0.1:{app.port}/", flush=True)
print(f"FAKE_REMOTE=http://127.0.0.1:{remote.server_address[1]}/v1 key={FakeOpenAIHandler.key}", flush=True)
print(f"NEXAAI_HOME={os.environ['NEXAAI_HOME']}", flush=True)
threading.Thread(target=server.serve_forever, daemon=True).start()
app.shutdown_requested.wait()
