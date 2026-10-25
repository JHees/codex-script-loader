"""Check native OpenAI provider transport against a loopback-only Responses fixture."""

import argparse
import json
import os
from pathlib import Path
import tempfile

from router_fixture_server import FixtureServer
from verify_router import Client


def run(cli, directory):
    with tempfile.TemporaryDirectory(prefix="native-gateway-", dir=directory) as temporary, FixtureServer() as fixture:
        paths = []
        def reject_websocket(handler):
            paths.append(("GET", handler.path))
            handler.send_response(426)
            handler.send_header("Content-Length", "0")
            handler.send_header("Connection", "close")
            handler.end_headers()
            handler.close_connection = True
        fixture.server.RequestHandlerClass.do_GET = reject_websocket
        original_post = fixture.server.RequestHandlerClass.do_POST
        def post(handler):
            paths.append(("POST", handler.path))
            return original_post(handler)
        fixture.server.RequestHandlerClass.do_POST = post
        root = Path(temporary)
        home, work = root / "home", root / "work"
        home.mkdir()
        work.mkdir()
        env = os.environ.copy()
        for key in ("OPENAI_API_KEY", "CODEX_API_KEY", "OPENAI_BASE_URL", "CODEX_APP_SERVER_WS_URL",
                    "CODEX_SCRIPT_LOADER_ACCOUNTS", "CODEX_SCRIPT_LOADER_CLI_DESCRIPTOR"):
            env.pop(key, None)
        env.update(CODEX_HOME=str(home), CODEX_SQLITE_HOME=str(home), OPENAI_API_KEY="fixture-only")
        command = [str(cli), "-c", 'model_provider="openai"',
                   "-c", 'model="gpt-5.6-sol"', "-c", 'web_search="disabled"',
                   "-c", "features.plugins=false", "-c", 'cli_auth_credentials_store="file"',
                   "-c", "openai_base_url=" + json.dumps(fixture.url.removesuffix("/responses")),
                   "app-server"]
        client = Client(command, env, work, "fixture-only")
        failures = []
        receive = client.receive
        def record(deadline):
            frame = receive(deadline)
            if frame.get("method") == "error":
                failures.append(frame.get("params", {}))
            return frame
        client.receive = record
        try:
            client.initialize()
            config = client.request("config/read", {"includeLayers": False})
            assert config["config"]["openai_base_url"] == fixture.url.removesuffix("/responses")
            provider = client.create()
            assert provider == "openai", provider
            client.request("account/login/start", {"type": "apiKey", "apiKey": "fixture-only"})
            turn = client.start_turn("Reply with ROUTER_ALPHA_123 only. Do not call tools.")
            try:
                completed = client.finish_turn(turn)
            except Exception:
                print(json.dumps({"paths": paths, "methods": client.method_counts,
                                  "errors": failures}), flush=True)
                raise
            assert completed["status"] == "completed", completed
            assert completed["text"] == "ROUTER_ALPHA_123", completed
            metadata = client.request("thread/read", {"threadId": client.thread_id, "includeTurns": False})
            assert metadata["thread"]["modelProvider"] == "openai", metadata["thread"].get("modelProvider")
            return {"nativeProvider": provider, "completed": True, "notifications": sorted(client.method_counts)}
        finally:
            client.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--cli", type=Path, required=True)
    parser.add_argument("--directory", type=Path, required=True)
    options = parser.parse_args()
    print(json.dumps(run(options.cli, options.directory), ensure_ascii=False))
