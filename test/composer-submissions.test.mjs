import test from "node:test";
import assert from "node:assert/strict";
import { createSubmissionReceipts } from "../src/composer-host.mjs";

const block = "[Loader context: example.workflow / receipt-123]\nUse the example\\_workflow.\n[/Loader context]";
const outgoing = (id = "native-1", taskId = "task-a") => ({ type: "mcp-request", hostId: "local", request: { id, method: "turn/start", params: { threadId: taskId, clientUserMessageId: "user-1", input: [{ type: "text", text: "User draft\n" + block }] } } });
const incoming = (id = "native-1") => ({ type: "mcp-response", hostId: "local", message: { id, result: { turn: { id: "turn-a", status: "inProgress", items: [] } } } });

test("a visible context binds to the accepted native request, not editor clearing or navigation", () => {
  const receipts = createSubmissionReceipts();
  receipts.register({ bindingId: "receipt-123", owner: { hostId: "local", taskId: "task-a" }, serializedContext: block });
  assert.equal(receipts.get("receipt-123").state, "prepared");
  receipts.outgoing(outgoing(), true);
  assert.equal(receipts.get("receipt-123").state, "dispatched");
  receipts.incoming(incoming());
  assert.deepEqual(receipts.get("receipt-123"), { state: "accepted", bindingId: "receipt-123", hostId: "local", taskId: "task-a", requestId: "native-1", turnId: "turn-a", clientUserMessageId: "user-1" });
  receipts.incoming(incoming());
  assert.equal(receipts.get("receipt-123").state, "accepted");
});

test("a temporary draft has no task identity until its own native request is accepted", () => {
  const receipts = createSubmissionReceipts();
  receipts.register({ bindingId: "receipt-123", owner: { draftId: "draft-1" }, serializedContext: block });
  assert.equal(receipts.get("receipt-123").taskId, undefined);
  receipts.outgoing(outgoing("native-1", "new-task"), true);
  receipts.incoming({ ...incoming(), hostId: "other-host" });
  assert.equal(receipts.get("receipt-123").state, "dispatched");
  receipts.incoming(incoming());
  assert.equal(receipts.get("receipt-123").taskId, "new-task");
  assert.equal(receipts.get("receipt-123").state, "accepted");
});

test("a duplicate native dispatch cannot reuse one binding for two accepted turns", () => {
  const receipts = createSubmissionReceipts();
  receipts.register({ bindingId: "receipt-123", owner: { hostId: "local", taskId: "task-a" }, serializedContext: block });
  receipts.outgoing(outgoing(), true);
  receipts.incoming(incoming());
  receipts.outgoing(outgoing("native-2"), true);
  assert.equal(receipts.get("receipt-123").state, "ambiguous");
  receipts.incoming(incoming("native-2"));
  assert.equal(receipts.get("receipt-123").state, "ambiguous");
});

test("edited context, duplicate context and another task cannot acquire the binding", () => {
  for (const request of [outgoing("native-1", "task-b"), { ...outgoing(), request: { ...outgoing().request, params: { ...outgoing().request.params, input: [{ type: "text", text: block + block }] } } }, { ...outgoing(), request: { ...outgoing().request, params: { ...outgoing().request.params, input: [{ type: "text", text: block.replace("Use", "Ignore") }] } } }]) {
    const receipts = createSubmissionReceipts();
    receipts.register({ bindingId: "receipt-123", owner: { hostId: "local", taskId: "task-a" }, serializedContext: block });
    receipts.outgoing(request, true);
    receipts.incoming(incoming());
    assert.equal(receipts.get("receipt-123").state, "context-mismatch");
  }
});

test("definite rejection permits a user retry but a bare event or unknown response never confirms submission", () => {
  const receipts = createSubmissionReceipts();
  receipts.register({ bindingId: "receipt-123", owner: { hostId: "local", taskId: "task-a" }, serializedContext: block });
  receipts.outgoing(outgoing(), false);
  assert.equal(receipts.get("receipt-123").state, "prepared");
  receipts.outgoing(outgoing(), true);
  receipts.incoming({ ...incoming(), message: { id: "native-1", error: { code: "REJECTED" } } });
  assert.equal(receipts.get("receipt-123").state, "rejected");
  receipts.outgoing(outgoing("native-2"), true);
  receipts.incoming(incoming("native-2"));
  assert.equal(receipts.get("receipt-123").state, "accepted");
  receipts.stop();
  assert.equal(receipts.get("receipt-123").state, "unknown");
});
