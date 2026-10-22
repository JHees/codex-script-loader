"""Verify management-worker replacement while real Codex CLI conversations remain connected."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time

from verify_router import Client
from router_fixture_server import FixtureServer


def package(path, assembly, ui, corrupt=False):
    path.mkdir()
    dll = b"invalid assembly fixture" if corrupt else assembly.read_bytes()
    (path / "CodexScriptLoader.Accounts.dll").write_bytes(dll)
    (path / "accounts-ui.js").write_text(ui, encoding="utf-8")
    assembly_hash = hashlib.sha256(dll).hexdigest()
    ui_hash = hashlib.sha256(ui.encode()).hexdigest()
    revision = hashlib.sha256((assembly_hash + "\n" + ui_hash).encode()).hexdigest()
    (path / "manifest.json").write_text(json.dumps(dict(schemaVersion=1, workerProtocol=1, storeSchema=1,
        version="0.6.0-alpha", revision=revision, assemblySha256=assembly_hash, uiSha256=ui_hash)), encoding="utf-8")
    return revision


def run(args):
    executable = Path(args.host).resolve()
    assembly = executable.parent / "CodexScriptLoader.Accounts.dll"
    output = Path(args.output).resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    result = {"passed": False}
    clients = []; service = None
    with tempfile.TemporaryDirectory(prefix="hot-update-", dir=output.parent) as directory, FixtureServer() as fixture:
        base = Path(directory).resolve()
        assert base.is_relative_to(output.parent)
        home, work, store = base / "primary", base / "work", base / "store"
        home.mkdir(); work.mkdir()
        ui = base / "accounts-ui.js"; ui.write_text("/* old fixture UI */", encoding="utf-8")
        (home / "config.toml").write_text(
            'model="gpt-5.6-sol"\nmodel_provider="primary_probe"\nmodel_reasoning_effort="low"\n'
            'sandbox_mode="read-only"\napproval_policy="on-request"\nproject_doc_max_bytes=0\nweb_search="disabled"\n'
            '[features]\nplugins=false\ncode_mode_host=false\n'
            '[model_providers.primary_probe]\nname="Fixture"\nwire_api="responses"\n'
            f'base_url={json.dumps(fixture.url.removesuffix("/responses"))}\n'
            'env_key="ACCOUNT_SWITCHER_TEST_KEY"\nrequires_openai_auth=false\n', encoding="utf-8")
        env = os.environ.copy()
        for name in ("OPENAI_API_KEY", "CODEX_API_KEY", "CODEX_SCRIPT_LOADER_ACCOUNTS", "CODEX_ACCOUNT_WORKER_ASSEMBLY", "CODEX_ACCOUNT_BACKEND_COMMAND"):
            env.pop(name, None)
        env.update(CODEX_HOME=str(home), CODEX_SQLITE_HOME=str(home / "sqlite"), ACCOUNT_SWITCHER_TEST_KEY="fixture-key-only")
        env["DOTNET_ROOT"] = str(Path(args.dotnet).resolve().parent)
        try:
            service = Client([str(executable), "--accounts-test-host", str(ui)], env, work, "fixture-key-only")
            service.request("initialize", {"protocolVersion": 1, "dataDirectory": str(store)})
            def invoke(operation, payload=None):
                body = {"operation": "status", "payload": {} if operation == "status" else
                    {"accountCommand": {"protocol": 2, "operation": operation, "payload": payload or {}}}}
                reply = service.request("invoke", body)
                assert reply["ok"], reply.get("errorCode")
                return reply["data"]
            def update(path, success):
                child_env = {**env, "CODEX_ACCOUNT_BACKEND_COMMAND": "update"}
                completed = subprocess.run([str(executable), "--accounts-backend"], input=json.dumps({"dataDirectory": str(store),
                    "packageDirectory": str(path), "wait": True})+"\n", env=child_env, cwd=work, capture_output=True,
                    text=True, encoding="utf-8", timeout=30, creationflags=subprocess.CREATE_NO_WINDOW)
                assert (completed.returncode == 0) is success, "Updater exit mismatch: " + completed.stdout[-600:] + completed.stderr[-600:]
                return [json.loads(line) for line in completed.stdout.splitlines() if line.startswith("{")][-1]
            for _ in range(2):
                client = Client([str(executable), "--desktop-cli", str(store), "enabled", "app-server"], env, work, "fixture-key-only")
                clients.append(client); client.initialize()
            skills = clients[0].request("skills/list", {"cwds": [str(work)]})
            for entry in skills["data"]:
                for skill in entry["skills"]:
                    if skill["enabled"]: clients[0].request("skills/config/write", {"path": skill["path"], "enabled": False})
            for client in clients: assert client.create() == "primary_probe"
            for client, marker in zip(clients, ["ROUTER_ALPHA_174", "ROUTER_BETA_286"]):
                assert client.finish_turn(client.start_turn(f"Remember {marker}. Reply with exactly {marker}."))["text"].strip() == marker
            usage = invoke("refresh_accounts")
            while usage["state"] == "running":
                time.sleep(.02); usage = invoke("operation_status", {"operationId": usage["id"]})
            assert usage["state"] == "completed"
            original = invoke("status")["backendUpdate"]
            endpoint = (store / "router-connection.json").read_bytes()
            held = clients[0].start_turn("Write the numbers 1 through 10000, one per line.")
            assert service.request("prepare_stop", {})["canStop"] is False
            good = base / "good"; revision = package(good, assembly, "/* updated fixture UI */")
            changed = update(good, True)
            result["workerReplaced"] = changed["workerProcessId"] != original["workerProcessId"] and changed["revision"] == revision
            result["routerUnchanged"] = changed["routerProcessId"] == original["routerProcessId"] and endpoint == (store / "router-connection.json").read_bytes()
            result["ongoingTurnPreserved"] = invoke("thread_status", {"threadId": clients[0].thread_id})["busy"]
            result["completedOperationPreserved"] = invoke("operation_status", {"operationId": usage["id"]})["state"] == "completed"
            result["uiUpdated"] = ui.read_text(encoding="utf-8") == "/* updated fixture UI */"
            result["otherClientWorks"] = clients[1].finish_turn(clients[1].start_turn("Reply with exactly the marker I asked you to remember."))["text"].strip() == "ROUTER_BETA_286"
            bad = base / "bad"; package(bad, assembly, "/* invalid candidate UI */", corrupt=True)
            rejected = update(bad, False)
            result["failedCandidateKeepsWorker"] = rejected["state"] == "failed" and rejected["workerProcessId"] == changed["workerProcessId"]
            result["failedCandidateKeepsPointer"] = json.loads((store / "runtime/active.json").read_text())["revision"] == revision
            result["failedCandidateKeepsUi"] = ui.read_text(encoding="utf-8") == "/* updated fixture UI */"
            clients[0].request("turn/interrupt", {"threadId": clients[0].thread_id, "turnId": held})
            result["cancellationWorks"] = clients[0].finish_turn(held)["status"] == "interrupted"
            result["historyPreserved"] = clients[0].finish_turn(clients[0].start_turn("Reply with exactly the marker I asked you to remember."))["text"].strip() == "ROUTER_ALPHA_174"
            result["passed"] = all(value is True for key, value in result.items() if key != "passed")
        except Exception as error:
            result["errorType"] = type(error).__name__
            result["detail"] = getattr(error, "detail", str(error))[:400]
        finally:
            for client in clients: client.close()
            if service:
                service.close(); result["cleanShutdown"] = service.process.returncode == 0
                result["passed"] = result["passed"] and result["cleanShutdown"]
    output.write_text(json.dumps(result, indent=2), encoding="utf-8")
    return result


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    for option in ("host", "dotnet", "output"): parser.add_argument("--" + option, required=True)
    report = run(parser.parse_args()); print(json.dumps(report)); raise SystemExit(0 if report["passed"] else 1)
