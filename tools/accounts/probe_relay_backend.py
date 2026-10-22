"""Exercise two isolated official app-servers against one configured relay."""

import argparse
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
import os
from pathlib import Path
import queue
import subprocess
import tempfile
import threading
import time

from probe_relay import read_provider


class RpcError(Exception):
    def __init__(self, code, detail=""):
        self.code = code
        self.detail = detail
        super().__init__(f"RPC {code}")


class Backend:
    def __init__(self, cli, root, work, model, url, key, unload_delay=None):
        self.home = root / "home"
        self.cwd = work
        self.home.mkdir(parents=True)
        self.cwd.mkdir()
        config = (
            f"model = {json.dumps(model)}\n"
            'model_provider = "relay_probe"\n'
            'model_reasoning_effort = "low"\n'
            'cli_auth_credentials_store = "file"\n'
            'mcp_oauth_credentials_store = "file"\n'
            'sandbox_mode = "read-only"\n'
            'approval_policy = "on-request"\n'
            'web_search = "disabled"\n'
            "project_doc_max_bytes = 0\n"
            "[model_providers.relay_probe]\n"
            'name = "Isolated relay probe"\n'
            f"base_url = {json.dumps(url.removesuffix('/responses'))}\n"
            'wire_api = "responses"\n'
            'env_key = "ACCOUNT_SWITCHER_RELAY_KEY"\n'
            "requires_openai_auth = false\n"
        )
        if unload_delay is not None:
            config = f"thread_unload_delay_secs = {int(unload_delay)}\n" + config
        (self.home / "config.toml").write_text(config, encoding="utf-8")
        env = os.environ.copy()
        for name in ("OPENAI_API_KEY", "CODEX_API_KEY", "CODEX_LOADER_TRANSPORT_PROBE_CONFIG",
                     "CODEX_APP_SERVER_WS_URL"):
            env.pop(name, None)
        env.update(CODEX_HOME=str(self.home), CODEX_SQLITE_HOME=str(self.home / "sqlite"),
                   ACCOUNT_SWITCHER_RELAY_KEY=key)
        self.process = subprocess.Popen(
            [cli, "app-server"], cwd=self.cwd, env=env,
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            text=True, encoding="utf-8", creationflags=subprocess.CREATE_NO_WINDOW,
        )
        self.frames = queue.Queue()
        self.notifications = []
        self.next_id = 0
        self.rejected_requests = 0
        self.reader = threading.Thread(target=self._read, daemon=True)
        self.reader.start()

    def _read(self):
        try:
            for line in self.process.stdout:
                self.frames.put(json.loads(line))
        except (ValueError, OSError):
            pass
        finally:
            self.frames.put(None)

    def send(self, frame):
        self.process.stdin.write(json.dumps(frame) + "\n")
        self.process.stdin.flush()

    def receive(self, deadline):
        frame = self.frames.get(timeout=max(0.01, deadline - time.monotonic()))
        if frame is None:
            raise EOFError("Official backend exited")
        method = frame.get("method")
        if method:
            if "id" in frame:
                # This probe never authorizes file changes or arbitrary commands.
                self.rejected_requests += 1
                if method == "item/commandExecution/requestApproval":
                    self.send({"id": frame["id"], "result": {"decision": "decline"}})
                elif method == "item/fileChange/requestApproval":
                    self.send({"id": frame["id"], "result": {"decision": "decline"}})
                else:
                    self.send({"id": frame["id"], "error": {"code": -32601, "message": "Unsupported in relay probe"}})
            else:
                self.notifications.append(frame)
        return frame

    def request(self, method, params):
        self.next_id += 1
        request_id = self.next_id
        self.send({"id": request_id, "method": method, "params": params})
        deadline = time.monotonic() + 45
        while time.monotonic() < deadline:
            frame = self.receive(deadline)
            if frame.get("id") == request_id and "method" not in frame:
                if "error" in frame:
                    raise RpcError(frame["error"]["code"], frame["error"].get("message", ""))
                return frame.get("result")
        raise TimeoutError("RPC timeout")

    def setup(self, ephemeral=True):
        self.request("initialize", {"clientInfo": {"name": "account_switcher_probe", "version": "0.0.0"},
                                    "capabilities": {"experimentalApi": True}})
        self.send({"method": "initialized"})
        # Disable discovered skills only in this temporary CODEX_HOME before any model request.
        skills = self.request("skills/list", {"cwds": [str(self.cwd)]})
        disabled = 0
        for entry in skills["data"]:
            for skill in entry["skills"]:
                if skill["enabled"]:
                    self.request("skills/config/write", {"path": skill["path"], "enabled": False})
                    disabled += 1
        checked = self.request("skills/list", {"cwds": [str(self.cwd)], "forceReload": True})
        assert not any(s["enabled"] for e in checked["data"] for s in e["skills"]), "Skills must be disabled"
        result = self.request("thread/start", {
            "cwd": str(self.cwd), "ephemeral": ephemeral, "sandbox": "read-only", "approvalPolicy": "on-request",
            "baseInstructions": "You are testing a synthetic conversation. Follow the user's exact output request. Never use tools or access files.",
        })
        self.thread_id = result["thread"]["id"]
        assert result["modelProvider"] == "relay_probe", "Wrong backend provider"
        return {"initialized": True, "disabledSkills": disabled, "isolatedProvider": True}

    def start_turn(self, prompt):
        result = self.request("turn/start", {"threadId": self.thread_id, "effort": "low",
                              "input": [{"type": "text", "text": prompt, "text_elements": []}]})
        return result["turn"]["id"]

    def finish_turn(self, turn_id):
        deadline = time.monotonic() + 90
        chunks, final = [], ""
        while time.monotonic() < deadline:
            if not self.notifications:
                self.receive(deadline)
                continue
            frame = self.notifications.pop(0)
            params = frame.get("params", {})
            if frame["method"] not in ("item/agentMessage/delta", "item/completed", "turn/completed"):
                continue
            assert params.get("threadId") == self.thread_id, "Notification crossed thread boundary"
            if params.get("turnId") != turn_id and params.get("turn", {}).get("id") != turn_id:
                continue
            if frame["method"] == "item/agentMessage/delta":
                chunks.append(params["delta"])
            elif frame["method"] == "item/completed" and params["item"]["type"] == "agentMessage":
                final = params["item"]["text"]
            elif frame["method"] == "turn/completed":
                return {"status": params["turn"]["status"], "text": final or "".join(chunks),
                        "streamChunks": len(chunks), "hasError": params["turn"].get("error") is not None}
        raise TimeoutError("Turn timeout")

    def close(self):
        self.process.stdin.close()
        try:
            self.process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            self.process.kill()
            self.process.wait(timeout=5)
        self.reader.join(timeout=2)
        self.process.stdout.close()


def run(args):
    cli = Path(args.cli)
    assert hashlib.sha256(cli.read_bytes()).hexdigest().lower() == args.sha256.lower(), "CLI baseline changed"
    name, model, url, key = read_provider(args.database, args.provider, args.base_url)
    result = {"provider": name, "model": model, "endpoint": url, "sameCredentialInTwoIsolatedBackends": True, "passed": False}
    clients = []
    state_root = Path(args.output).resolve().parent
    state_root.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="relay-backend-", dir=state_root) as temporary, \
            tempfile.TemporaryDirectory(prefix="codex-relay-work-") as work:
        try:
            for label in ("a", "b"):
                clients.append(Backend(str(cli), Path(temporary) / label, Path(work) / label, model, url, key))
            result["backends"] = [client.setup() for client in clients]
            assert clients[0].thread_id != clients[1].thread_id, "Threads must be distinct"
            markers = ["RELAY_ALPHA_731", "RELAY_BETA_942"]
            turns = [client.start_turn(f"Remember {marker}. Reply with exactly {marker}.")
                     for client, marker in zip(clients, markers)]
            with ThreadPoolExecutor(max_workers=2) as pool:
                futures = [pool.submit(client.finish_turn, turn) for client, turn in zip(clients, turns)]
                responses = [future.result() for future in futures]
            result["parallelTurns"] = [
                {"completed": response["status"] == "completed", "expectedReply": response["text"].strip() == marker,
                 "streamChunks": response["streamChunks"], "hasError": response["hasError"]}
                for response, marker in zip(responses, markers)]
            assert all(r["completed"] and r["expectedReply"] for r in result["parallelTurns"]), "Parallel turn failed"
            cancelled = clients[1].start_turn("Write the numbers from 1 to 10000, one per line.")
            followup = clients[0].start_turn("Reply with exactly the marker I asked you to remember in the previous turn.")
            clients[1].request("turn/interrupt", {"threadId": clients[1].thread_id, "turnId": cancelled})
            interrupted = clients[1].finish_turn(cancelled)
            continued = clients[0].finish_turn(followup)
            result["cancelledStatus"] = interrupted["status"]
            result["otherBackendContinuedWithHistory"] = continued["status"] == "completed" and continued["text"].strip() == markers[0]
            result["serverRequestsDeclined"] = sum(client.rejected_requests for client in clients)
            assert result["cancelledStatus"] == "interrupted", "Cancellation was not observed"
            assert result["otherBackendContinuedWithHistory"], "Other backend lost its conversation"
            assert result["serverRequestsDeclined"] == 0, "Unexpected interactive request"
            result["passed"] = True
        except Exception as error:
            result["errorType"] = type(error).__name__
            if isinstance(error, RpcError):
                result["rpcCode"] = error.code
        finally:
            for client in clients:
                client.close()
    return result


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    for option in ("database", "provider", "cli", "sha256", "output"):
        parser.add_argument("--" + option, required=True)
    parser.add_argument("--base-url")
    args = parser.parse_args()
    try:
        result = run(args)
    except Exception as error:
        result = {"passed": False, "errorType": type(error).__name__}
    Path(args.output).write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(result, ensure_ascii=False))
    raise SystemExit(0 if result["passed"] else 2)
