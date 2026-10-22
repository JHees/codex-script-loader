"""Deterministic loopback Responses fixture for the real official app-server."""

from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import re
import threading
import time
import uuid


class FixtureServer:
    def __init__(self):
        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, *_):
                pass

            def do_POST(self):
                payload = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                serialized = json.dumps(payload, ensure_ascii=False)
                inputs = [item for item in payload.get("input", []) if isinstance(item, dict) and item.get("role") == "user"]
                latest = json.dumps(inputs[-1] if inputs else {}, ensure_ascii=False)
                long = "10000" in latest
                markers = set(re.findall(r"ROUTER_(?:ALPHA|BETA)_\d+", serialized))
                text = next(iter(markers)) if len(markers) == 1 else "CROSSED_HISTORY"
                response_id, message_id = "resp_" + uuid.uuid4().hex, "msg_" + uuid.uuid4().hex
                message = {"id": message_id, "type": "message", "role": "assistant", "status": "in_progress", "content": []}
                response = {"id": response_id, "object": "response", "created_at": int(time.time()),
                            "model": payload.get("model"), "status": "in_progress", "output": []}
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.send_header("Connection", "close")
                self.end_headers()
                def event(kind, **values):
                    body = json.dumps({"type": kind, **values})
                    self.wfile.write(f"event: {kind}\ndata: {body}\n\n".encode())
                    self.wfile.flush()
                try:
                    event("response.created", response=response)
                    event("response.output_item.added", output_index=0, item=message)
                    event("response.content_part.added", item_id=message_id, output_index=0, content_index=0,
                          part={"type": "output_text", "text": "", "annotations": []})
                    if long:
                        for index in range(10000):
                            event("response.output_text.delta", item_id=message_id, output_index=0, content_index=0, delta=f"{index}\n")
                            time.sleep(0.01)
                    else:
                        event("response.output_text.delta", item_id=message_id, output_index=0, content_index=0, delta=text)
                    event("response.output_text.done", item_id=message_id, output_index=0, content_index=0, text=text)
                    message.update(status="completed", content=[{"type": "output_text", "text": text, "annotations": []}])
                    event("response.output_item.done", output_index=0, item=message)
                    response.update(status="completed", output=[message], usage={"input_tokens": 1, "output_tokens": 1, "total_tokens": 2})
                    event("response.completed", response=response)
                except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
                    pass
                self.close_connection = True

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.server.daemon_threads = True
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.url = f"http://127.0.0.1:{self.server.server_port}/v1/responses"

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)
