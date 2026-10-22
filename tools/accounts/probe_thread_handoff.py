"""Verify same-ID history handoff using disposable official backend profiles."""

import argparse
import hashlib
import json
from pathlib import Path
import tempfile
import time
import shutil

from probe_relay import read_provider
from probe_relay_backend import Backend, RpcError


def run(args):
    cli = Path(args.cli)
    assert hashlib.sha256(cli.read_bytes()).hexdigest().lower() == args.sha256.lower()
    _, model, url, key = read_provider(args.database, args.provider, args.base_url)
    result = {"passed": False, "sameRelayCredential": True}
    clients = []
    state_root = Path(args.output).resolve().parent
    with tempfile.TemporaryDirectory(prefix="handoff-", dir=state_root) as temporary, \
            tempfile.TemporaryDirectory(prefix="codex-handoff-work-") as work:
        try:
            for label in ("a", "b"):
                clients.append(Backend(str(cli), Path(temporary) / label, Path(work) / label, model, url, key, unload_delay=1))
            source, target = clients
            source.setup(ephemeral=False)
            target.setup()
            marker = "HANDOFF_HISTORY_5937"
            turn = source.start_turn(f"Remember {marker}. Reply with exactly {marker}.")
            response = source.finish_turn(turn)
            assert response["status"] == "completed" and response["text"].strip() == marker
            thread_id = source.thread_id
            thread = source.request("thread/read", {"threadId": thread_id, "includeTurns": False})["thread"]
            result["sourceHasPath"] = bool(thread.get("path"))
            assert thread.get("path")
            source.request("thread/unsubscribe", {"threadId": thread_id})
            deadline = time.monotonic() + 15
            while time.monotonic() < deadline:
                if thread_id not in source.request("thread/loaded/list", {}).get("data", []):
                    break
                time.sleep(0.25)
            else:
                raise TimeoutError("Source writer did not release")
            result["sourceReleased"] = True
            source_path = Path(thread["path"]).resolve()
            relative = source_path.relative_to(source.home.resolve())
            assert relative.parts[0] == "sessions"
            target_path = target.home / relative
            target_path.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source_path, target_path)
            result["isolatedRolloutCopy"] = True
            resumed = target.request("thread/resume", {
                "threadId": thread_id, "cwd": str(source.cwd),
                "modelProvider": "relay_probe", "model": model,
                "sandbox": "read-only", "approvalPolicy": "on-request",
            })
            assert resumed["thread"]["id"] == thread_id
            target.thread_id = thread_id
            result["sameThreadId"] = True
            turn = target.start_turn("Reply with exactly the marker I asked you to remember.")
            response = target.finish_turn(turn)
            result["historyPreserved"] = response["status"] == "completed" and response["text"].strip() == marker
            assert result["historyPreserved"]
            result["passed"] = True
        except Exception as error:
            result["errorType"] = type(error).__name__
            if isinstance(error, RpcError):
                result["rpcCode"] = error.code
                result["failureCategory"] = next((word for word in (
                    "no rollout", "not found", "unknown field", "writer", "path", "provider",
                ) if word in error.detail.lower()), "unclassified")
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
    result = run(args)
    Path(args.output).write_text(json.dumps(result, indent=2), encoding="utf-8")
    print(json.dumps(result))
    raise SystemExit(0 if result["passed"] else 2)
