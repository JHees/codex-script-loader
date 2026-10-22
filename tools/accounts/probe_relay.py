"""Send one synthetic Responses request using a read-only CC Switch provider."""

import argparse
from contextlib import closing
import json
from pathlib import Path
import re
import sqlite3
import tempfile
import time
import tomllib
import urllib.error
import urllib.parse
import urllib.request


def read_provider(database, provider_id, base_url=None):
    with closing(sqlite3.connect(Path(database).resolve().as_uri() + "?mode=ro", uri=True)) as db:
        row = db.execute(
            "SELECT name,settings_config FROM providers WHERE app_type='codex' AND id=?",
            (provider_id,),
        ).fetchone()
    if row is None:
        raise ValueError("Provider not found")
    settings = json.loads(row[1])
    config = tomllib.loads(settings["config"])
    provider = config["model_providers"][config["model_provider"]]
    if provider.get("wire_api") != "responses":
        raise ValueError("This probe requires an existing Responses provider")
    if base_url and urllib.parse.urlsplit(base_url).netloc != urllib.parse.urlsplit(provider["base_url"]).netloc:
        raise ValueError("An endpoint override must stay on the configured origin")
    url = (base_url or provider["base_url"]).rstrip("/") + "/responses"
    parsed = urllib.parse.urlsplit(url)
    if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise ValueError("Expected a configured HTTPS endpoint without embedded credentials")
    key = provider.get("experimental_bearer_token") or settings.get("auth", {}).get("OPENAI_API_KEY")
    if not isinstance(key, str) or not key.strip():
        raise ValueError("No API credential in this provider record")
    return row[0], config["model"], url, key


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def summarize_events(lines):
    counts, text, statuses = {}, "", []
    errors = []
    for line in lines:
        line = line.strip()
        if not line.startswith("data:") or line[5:].strip() == "[DONE]":
            continue
        event = json.loads(line[5:])
        kind = event.get("type", "")
        counts[kind] = counts.get(kind, 0) + 1
        if kind == "response.output_text.delta":
            text += event.get("delta", "")
        if kind in ("response.completed", "response.failed", "response.incomplete"):
            response = event.get("response", {})
            statuses.append(response.get("status"))
            for item in response.get("output", []):
                for content in item.get("content", []):
                    if content.get("type") == "output_text" and not text:
                        text = content.get("text", "")
            error = response.get("error")
            if isinstance(error, dict):
                errors.append(safe_error_code(error.get("code")))
        if kind == "error":
            errors.append(safe_error_code(event.get("code")))
    return {
        "eventCounts": {k: v for k, v in counts.items() if re.fullmatch(r"[a-z_.]+", k)},
        "responseStatuses": [s for s in statuses if s in ("completed", "failed", "incomplete")],
        "expectedReply": text.strip() == "RELAY_OK",
        "completed": "completed" in statuses,
        "errorCodes": errors,
    }


def safe_error_code(value):
    allowed = {"invalid_api_key", "insufficient_quota", "rate_limit_exceeded", "model_not_found",
               "invalid_request_error", "server_error", "authentication_error", "permission_denied"}
    return value if value in allowed else "unclassified"


def probe(database, provider_id, base_url=None):
    name, model, url, key = read_provider(database, provider_id, base_url)
    payload = json.dumps({
        "model": model,
        "input": [{"role": "user", "content": [{"type": "input_text", "text": "Reply with exactly RELAY_OK. Do not use tools."}]}],
        "max_output_tokens": 64,
        "stream": True,
        "store": False,
    }).encode()
    request = urllib.request.Request(url, data=payload, headers={
        "Authorization": "Bearer " + key, "Content-Type": "application/json", "Accept": "text/event-stream",
    })
    result = {"provider": name, "model": model, "endpoint": url}
    started = time.monotonic()
    try:
        with urllib.request.build_opener(NoRedirect()).open(request, timeout=60) as response:
            result["httpStatus"] = response.status
            # Bound the diagnostic response; no response content or credential is persisted.
            raw = response.read(1_048_577)
            if len(raw) > 1_048_576:
                raise ValueError("Diagnostic response too large")
            result.update(summarize_events(raw.decode("utf-8").splitlines()))
    except urllib.error.HTTPError as error:
        result["httpStatus"] = error.code
        body = error.read(65_536)
        try:
            value = json.loads(body).get("error", {})
            result["errorCode"] = safe_error_code(value.get("code") if isinstance(value, dict) else None)
        except (ValueError, AttributeError):
            result["errorCode"] = "unclassified"
    except (urllib.error.URLError, TimeoutError) as error:
        result["transportError"] = type(error).__name__
    result["elapsedSeconds"] = round(time.monotonic() - started, 2)
    result["passed"] = result.get("httpStatus") == 200 and result.get("completed") is True and result.get("expectedReply") is True
    return result


def self_test():
    lines = [
        'data: {"type":"response.output_text.delta","delta":"RELAY_"}',
        'data: {"type":"response.output_text.delta","delta":"OK"}',
        'data: {"type":"response.completed","response":{"status":"completed"}}',
        "data: [DONE]",
    ]
    result = summarize_events(lines)
    assert result["completed"] and result["expectedReply"]
    assert not summarize_events(lines[:2])["completed"]
    assert safe_error_code("secret-token") == "unclassified"
    assert NoRedirect().redirect_request(None, None, 302, "", {}, "https://other.invalid") is None
    with tempfile.TemporaryDirectory(prefix="relay-probe-test-") as directory:
        database = Path(directory) / "test.db"
        config = 'model = "test"\nmodel_provider = "custom"\n[model_providers.custom]\nbase_url = "https://example.invalid"\nwire_api = "responses"\n'
        with closing(sqlite3.connect(database)) as db:
            db.execute("CREATE TABLE providers (id TEXT, app_type TEXT, name TEXT, settings_config TEXT)")
            db.execute("INSERT INTO providers VALUES (?,?,?,?)",
                       ("test", "codex", "Test", json.dumps({"config": config, "auth": {"OPENAI_API_KEY": "fake-key"}})))
            db.commit()
        before = database.read_bytes()
        assert read_provider(database, "test")[2] == "https://example.invalid/responses"
        assert read_provider(database, "test", "https://example.invalid/v1")[2] == "https://example.invalid/v1/responses"
        for url in ("https://other.invalid/v1", "http://example.invalid/v1", "https://example.invalid/v1?key=unsafe"):
            try:
                read_provider(database, "test", url)
            except ValueError:
                pass
            else:
                raise AssertionError("Unsafe endpoint override accepted")
        assert database.read_bytes() == before
    print("PASS: relay probe self-check")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--database")
    parser.add_argument("--provider")
    parser.add_argument("--output")
    parser.add_argument("--base-url")
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()
    if args.self_test:
        self_test()
    else:
        if not args.database or not args.provider or not args.output:
            parser.error("--database, --provider and --output are required")
        try:
            result = probe(args.database, args.provider, args.base_url)
        except Exception as error:
            result = {"passed": False, "errorType": type(error).__name__}
        output = Path(args.output)
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
        print(json.dumps(result, ensure_ascii=False))
        raise SystemExit(0 if result["passed"] else 2)
