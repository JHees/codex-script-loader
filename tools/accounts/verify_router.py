"""Run the production router and two desktop CLI clients against isolated test profiles."""

import argparse
from concurrent.futures import ThreadPoolExecutor
import json
import os
from pathlib import Path
import queue
import subprocess
import tempfile
import threading
import time
import uuid
import re
from contextlib import nullcontext

from probe_relay import read_provider
from probe_relay_backend import Backend
from router_fixture_server import FixtureServer


class Client(Backend):
    def __init__(self, command, env, cwd, secret):
        self.cwd = cwd
        self.process = subprocess.Popen(command, cwd=cwd, env=env, stdin=subprocess.PIPE,
                                        stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                        text=True, encoding="utf-8", creationflags=subprocess.CREATE_NO_WINDOW)
        self.frames = queue.Queue()
        self.notifications = []
        self.next_id = 0
        self.rejected_requests = 0
        self.secret = secret
        self.method_counts = {}
        self.error_kinds = []
        self.shutdown_seconds = None
        def read_errors():
            for line in self.process.stderr:
                for kind in re.findall(r"\b(?:System\.)?([A-Za-z]+Exception)\b", line):
                    if kind not in self.error_kinds:
                        self.error_kinds.append(kind)
        self.stderr_reader = threading.Thread(target=read_errors, daemon=True)
        self.stderr_reader.start()
        self.reader = threading.Thread(target=self._read, daemon=True)
        self.reader.start()

    def close(self):
        if self.process.stdin.closed:
            return
        started = time.monotonic()
        self.process.stdin.close()
        try:
            self.process.wait(timeout=15)
        except subprocess.TimeoutExpired:
            self.process.kill()
            self.process.wait(timeout=5)
        self.shutdown_seconds = round(time.monotonic() - started, 3)
        self.reader.join(timeout=2)
        self.stderr_reader.join(timeout=2)
        self.process.stdout.close()
        self.process.stderr.close()

    def _read(self):
        try:
            for line in self.process.stdout:
                if self.secret in line:
                    self.frames.put(None)
                    return
                frame = json.loads(line)
                if "method" in frame:
                    self.method_counts[frame["method"]] = self.method_counts.get(frame["method"], 0) + 1
                self.frames.put(frame)
        finally:
            self.frames.put(None)

    def initialize(self):
        self.request("initialize", {"clientInfo": {"name": "account_router_verification", "version": "0.1.0"},
                                    "capabilities": {"experimentalApi": True}})
        self.send({"method": "initialized"})

    def create(self):
        result = self.request("thread/start", {
            "cwd": str(self.cwd), "ephemeral": False, "sandbox": "read-only", "approvalPolicy": "on-request",
            "baseInstructions": "This is an isolated synthetic conversation. Follow exact reply requests. Never access files or tools.",
        })
        self.thread_id = result["thread"]["id"]
        return result["modelProvider"]


def run(args):
    fixture = FixtureServer() if args.fixture else None
    name, model, url, key = ("loopback-fixture", "gpt-5.6-sol", fixture.url, "fixture-key-only") if fixture else read_provider(args.database, args.provider, args.base_url)
    result = {"passed": False, "provider": name, "sameRelayCredential": True, "stage": "service"}
    clients = []
    service = None
    dotnet = str(Path(args.dotnet).resolve())
    assembly = str(Path(args.assembly).resolve())
    state_root = Path(args.output).resolve().parent
    with tempfile.TemporaryDirectory(prefix="router-test-", dir=state_root) as temporary, \
            tempfile.TemporaryDirectory(prefix="codex-router-work-") as work, (fixture or nullcontext()):
        base, cwd = Path(temporary), Path(work)
        home, store = base / "primary", base / "store"
        home.mkdir()
        config = (
            f'model={json.dumps(model)}\nmodel_provider="primary_probe"\n'
            'model_reasoning_effort="low"\nsandbox_mode="read-only"\napproval_policy="on-request"\n'
            'cli_auth_credentials_store="file"\nmcp_oauth_credentials_store="file"\n'
            'project_doc_max_bytes=0\nweb_search="disabled"\nthread_unload_delay_secs=1\n'
            '[model_providers.primary_probe]\nname="Isolated primary fixture"\nwire_api="responses"\n'
            f'base_url={json.dumps(url.removesuffix("/responses"))}\n'
            'env_key="ACCOUNT_SWITCHER_TEST_KEY"\nrequires_openai_auth=false\n'
        )
        (home / "config.toml").write_text(config, encoding="utf-8")
        env = os.environ.copy()
        for value in ("OPENAI_API_KEY", "CODEX_API_KEY", "CODEX_SCRIPT_LOADER_CLI_DESCRIPTOR", "CODEX_LOADER_TRANSPORT_PROBE_CONFIG"):
            env.pop(value, None)
        env.update(CODEX_HOME=str(home), CODEX_SQLITE_HOME=str(home / "sqlite"),
                   ACCOUNT_SWITCHER_TEST_KEY=key, DOTNET_ROOT=str(Path(dotnet).parent))
        try:
            service = Client([dotnet, assembly, "--loader-backend"], env, cwd, key)
            service.request("initialize", {"protocolVersion": 1, "pluginId": "test.router", "dataDirectory": str(store)})
            def invoke(operation, payload=None):
                response = service.request("invoke", {"operation": operation, "payload": payload or {}})
                assert response["ok"], response.get("errorCode", "Unknown operation failure")
                return response["data"]
            accounts = []
            for label in ("A", "B"):
                account_id = uuid.uuid4().hex
                profile = store / "accounts" / account_id
                account_home = profile / "home"
                account_home.mkdir(parents=True)
                (account_home / "credential.json").write_text(json.dumps({"apiKey": key}), encoding="utf-8")
                (profile / "account.json").write_text(json.dumps({
                    "id": account_id, "name": label, "status": "ready", "kind": "relay",
                    "baseUrl": url.removesuffix("/responses"), "model": model,
                }), encoding="utf-8")
                accounts.append(account_id)
            for _ in range(2):
                result["stage"] = "desktop-clients"
                client = Client([dotnet, assembly, "--desktop-cli", str(store), "enabled", "app-server"], env, cwd, key)
                clients.append(client)
                client.initialize()
            skills = clients[0].request("skills/list", {"cwds": [str(cwd)]})
            for entry in skills["data"]:
                for skill in entry["skills"]:
                    if skill["enabled"]:
                        clients[0].request("skills/config/write", {"path": skill["path"], "enabled": False})
            for client, account_id in zip(clients, accounts):
                result["stage"] = "thread-creation"
                invoke("set_default", {"accountId": account_id})
                assert client.create() == "account_relay"
            result["twoDesktopClientsConnected"] = invoke("status")["routingAvailable"]
            markers = ["ROUTER_ALPHA_174", "ROUTER_BETA_286"]
            turns = [client.start_turn(f"Remember {marker}. Reply with exactly {marker}.")
                     for client, marker in zip(clients, markers)]
            result["busyProtectsReplacement"] = service.request("prepare_stop", {})["canStop"] is False
            result["stage"] = "parallel-turns"
            with ThreadPoolExecutor(max_workers=2) as pool:
                responses = list(pool.map(lambda pair: pair[0].finish_turn(pair[1]), zip(clients, turns)))
            result["parallelHistory"] = all(response["status"] == "completed" and response["text"].strip() == marker
                                           for response, marker in zip(responses, markers))
            assert result["parallelHistory"]
            background = clients[1].start_turn("Write the numbers 1 through 10000, one per line.")
            result["stage"] = "global-switch-with-other-turn-running"
            invoke("set_default", {"accountId": accounts[0]})
            deadline = time.monotonic() + 60
            while time.monotonic() < deadline:
                if invoke("thread_status", {"threadId": clients[0].thread_id})["accountId"] == accounts[0]:
                    break
                time.sleep(0.2)
            active_thread = invoke("thread_status", {"threadId": clients[1].thread_id})
            result["globalSwitchDeferredBusyThread"] = active_thread["accountId"] == accounts[1] and active_thread["busy"]
            assert result["globalSwitchDeferredBusyThread"]
            clients[1].request("turn/interrupt", {"threadId": clients[1].thread_id, "turnId": background})
            result["switchPreservedOtherTurn"] = clients[1].finish_turn(background)["status"] == "interrupted"
            deadline = time.monotonic() + 60
            while time.monotonic() < deadline:
                if invoke("list_accounts")["globalAccount"]["pendingThreads"] == 0:
                    break
                time.sleep(0.2)
            result["sameIdSwitched"] = all(invoke("thread_status", {"threadId": client.thread_id})["accountId"] == accounts[0] for client in clients)
            result["stage"] = "history-after-switch"
            continued = clients[0].finish_turn(clients[0].start_turn("Reply with exactly the marker I asked you to remember."))
            result["switchedHistoryPreserved"] = continued["status"] == "completed" and continued["text"].strip() == markers[0]
            cancelled = clients[1].start_turn("Write the numbers 1 through 10000, one per line.")
            result["stage"] = "parallel-cancellation"
            followup = clients[0].start_turn("Reply with exactly the marker I asked you to remember.")
            clients[1].request("turn/interrupt", {"threadId": clients[1].thread_id, "turnId": cancelled})
            interrupted = clients[1].finish_turn(cancelled)
            continued = clients[0].finish_turn(followup)
            result["isolatedCancellation"] = interrupted["status"] == "interrupted" and continued["text"].strip() == markers[0]
            result["idleAllowsReplacement"] = service.request("prepare_stop", {})["canStop"]
            for client in clients:
                client.close()
            service.close()
            result["stage"] = "disabled-primary-path"
            disabled = Client([dotnet, assembly, "--desktop-cli", str(store), "disabled", "app-server"], env, cwd, key)
            clients.append(disabled)
            disabled.initialize()
            assert disabled.create() == "primary_probe"
            try:
                disabled.request("thread/read", {"threadId": clients[0].thread_id})
                raise AssertionError("Disabled secondary thread was routed to the primary account")
            except Exception as error:
                from probe_relay_backend import RpcError
                if not isinstance(error, RpcError):
                    raise
            result["disabledPrimaryPath"] = True
            result["passed"] = all(result.get(item) is True for item in (
                "twoDesktopClientsConnected", "busyProtectsReplacement", "parallelHistory",
                "sameIdSwitched", "switchedHistoryPreserved", "globalSwitchDeferredBusyThread", "switchPreservedOtherTurn", "isolatedCancellation", "idleAllowsReplacement", "disabledPrimaryPath"))
            result["stage"] = "complete"
        except Exception as error:
            result["errorType"] = type(error).__name__
            if args.fixture:
                result["fixtureError"] = getattr(error, "detail", "")
            result["clientMethods"] = [client.method_counts for client in clients]
            try:
                result["threadStates"] = [invoke("thread_status", {"threadId": client.thread_id})
                                          for client in clients if hasattr(client, "thread_id")]
            except Exception:
                pass
        finally:
            for client in clients:
                client.close()
            if service:
                service.close()
                result["serviceExitedCleanly"] = service.process.returncode == 0
                result["shutdownSeconds"] = service.shutdown_seconds
                result["serviceExitCode"] = service.process.returncode
                result["serviceErrorKinds"] = service.error_kinds
                result["passed"] = result["passed"] and result["serviceExitedCleanly"] and service.shutdown_seconds < 10
    return result


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    for option in ("database", "provider", "dotnet", "assembly", "output"):
        parser.add_argument("--" + option, required=True)
    parser.add_argument("--base-url")
    parser.add_argument("--fixture", action="store_true")
    args = parser.parse_args()
    result = run(args)
    Path(args.output).write_text(json.dumps(result, indent=2), encoding="utf-8")
    print(json.dumps(result))
    raise SystemExit(0 if result["passed"] else 2)
