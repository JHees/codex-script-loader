import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { buildComposerHostSource } from "../src/composer-host.mjs";

// Small local App stand-in: exercises the real host, including its editor adapter.
// No browser, native App, message sender, or third-party plugin is used.
function fixture() {
  const paragraph = content => {
    const parts = Array.isArray(content) ? content : [content];
    const text = parts.map(p => typeof p === "string" ? p : "\n").join("");
    return { type: { name: "paragraph" }, parts, textContent: text, textBetween: () => text, content: { size: text.length }, nodeSize: text.length + 2 };
  };
  const nodes = [paragraph("User text")];
  const doc = () => ({ content: { size: nodes.reduce((sum, node) => sum + node.nodeSize, 0) }, forEach(fn) { let offset = 0; for (const node of nodes) { fn(node, offset); offset += node.nodeSize; } } });
  const row = { children: [], before: null, appendChild(child) { this.children.push(child); child.isConnected = true; child.parentElement = this; }, insertBefore(child, before) { this.before = before; this.appendChild(child); } };
  const anchor = { parentElement: row };
  const editor = { isConnected: true, getClientRects: () => [{}], closest: () => ({ querySelector: () => anchor }) };
  let edits = 0, maps = 0, observations = 0, disconnects = 0, nextId = 0, refresh;
  const view = { dom: editor, composing: false, dispatch(tr) { tr.apply(); edits++; } };
  Object.defineProperty(view, "state", { get() { return {
    doc: doc(), schema: { text: text => text, nodes: { paragraph: { create: (_, text) => paragraph(text) }, hard_break: { create: () => ({ type: { name: "hard_break" } }) } } },
    selection: { map: () => { maps++; return "preserved-selection"; } },
    tr: { mapping: {}, doc: doc(), apply() {},
      replaceWith(from, to, node) { this.apply = () => { let offset = 0, index = nodes.length; for (let i = 0; i < nodes.length; i++) { if (offset === from) { index = i; break; } offset += nodes[i].nodeSize; } nodes.splice(index, to === from ? 0 : 1, node); }; return this; },
      delete(from, to) { this.replaceWith(from, to, null); const apply = this.apply; this.apply = () => { apply(); const index = nodes.indexOf(null); if (index >= 0) nodes.splice(index, 1); }; return this; },
      setSelection(selection) { assert.equal(selection, "preserved-selection"); return this; },
    },
  }; } });
  const taskProps = { conversationId: "task-a", hostId: "local" };
  editor.parentElement = { __reactFiber$test: { memoizedProps: { composerController: { view, getText: () => nodes.map(n => n.textContent.replaceAll('_', '\\_')).join('\n') } }, return: { memoizedProps: taskProps } } };
  const listeners = new Map();
  const context = vm.createContext({ TextEncoder, location: { href: "app://-/index.html" },
    document: { documentElement: {}, querySelectorAll: () => [editor], createElement: () => ({ dataset: {}, style: {}, isConnected: false, remove() { this.isConnected = false; const i = row.children.indexOf(this); if (i >= 0) row.children.splice(i, 1); } }) },
    MutationObserver: class { constructor(callback) { refresh = callback; } observe() { observations++; } disconnect() { disconnects++; } },
    setTimeout, clearTimeout, getComputedStyle: element => ({ display: element === row ? "flex" : "contents" }), crypto: { randomUUID: () => `test-receipt-${++nextId}` }, __codexScriptLoader: {},
    addEventListener(type, callback) { listeners.set(type, callback); },
    removeEventListener(type) { listeners.delete(type); },
  });
  vm.runInContext(buildComposerHostSource(), context);
  return { host: context.__codexScriptLoader.composerHost, context, nodes, taskProps, view, row, anchor, listeners,
    refresh: async () => { refresh(); await new Promise(resolve => setTimeout(resolve, 5)); },
    counts: () => ({ edits, maps, observations, disconnects }) };
}

test("actual renderer host binds one accessory and edits via a selection-preserving transaction", () => {
  const f = fixture();
  let identity;
  const handle = f.host.register("example.context", { id: "control", render(root, task) { identity = task; assert.equal(root.isConnected, true); } });
  assert.equal(identity.taskId, "task-a");
  assert.equal(f.row.children.length, 1);
  assert.equal(f.row.before, f.anchor);
  const input = { ...identity, revision: "one", text: "A visible instruction" };
  handle.prepareContext(input);
  handle.prepareContext(input);
  assert.equal(f.nodes[0].textContent, "User text");
  assert.equal(f.nodes.length, 2);
  assert.equal(f.counts().edits, 1);
  assert.equal(f.counts().maps, 1);
  handle.unregister();
  assert.equal(f.nodes.length, 1);
  assert.equal(f.row.children.length, 0);
  assert.equal(f.counts().disconnects, 1);
});

test("visible context uses native line breaks that survive normal draft editing", () => {
  const f = fixture();
  const handle = f.host.register("example.context", { id: "control", render() {} });
  handle.prepareSubmission({ taskId: "task-a", hostId: "local", revision: "config-1", text: "First line\nSecond line" });
  const block = f.nodes[1];
  assert.equal(block.parts.filter(p => p?.type?.name === "hard_break").length, 3);
  assert.ok(block.parts.filter(p => typeof p === "string").every(p => !p.includes("\n")));
  assert.equal(handle.getStatus().context.state, "prepared");
  handle.clearContext();
  assert.equal(f.nodes.length, 1);
});

test("a plugin can read its accepted native submission after the draft disappears", () => {
  const f = fixture();
  const handle = f.host.register("example.context", { id: "control", render() {} });
  const prepared = handle.prepareSubmission({ taskId: "task-a", hostId: "local", revision: "config-1", text: "Use example_workflow" });
  assert.equal(prepared.state, "prepared");
  const serialized = f.nodes.map(n => n.textContent.replaceAll('_', '\\_')).join('\n');
  const event = { type: "mcp-request", hostId: "local", request: { id: "request-1", method: "turn/start", params: { threadId: "task-a", input: [{ type: "text", text: serialized }] } } };
  f.listeners.get("codex-message-from-view")({ detail: event, __codexForwardedViaBridge: true });
  f.nodes.length = 0;
  f.listeners.get("message")({ source: null, data: { type: "mcp-response", hostId: "local", message: { id: "request-1", result: { turn: { id: "turn-1" } } } } });
  assert.equal(handle.getSubmission(prepared.bindingId).state, "accepted");
  assert.equal(handle.getSubmission(prepared.bindingId).turnId, "turn-1");
  handle.unregister();
  assert.equal(f.listeners.size, 0);
});

test("composition, task changes, duplicate registrations and reload are safe", () => {
  const f = fixture();
  const handle = f.host.register("example.context", { id: "control", render() {} });
  assert.throws(() => f.host.register("example.context", { id: "control", render() {} }), { code: "ACCESSORY_EXISTS" });
  const input = { taskId: "task-a", hostId: "local", revision: "one", text: "Example" };
  f.view.composing = true;
  assert.throws(() => handle.prepareContext(input), { code: "COMPOSER_COMPOSING" });
  assert.equal(f.counts().edits, 0);
  f.view.composing = false;
  vm.runInContext(buildComposerHostSource(), f.context);
  assert.equal(f.row.children.length, 1);
  f.taskProps.conversationId = "task-b";
  assert.equal(handle.getStatus().available, false);
  assert.throws(() => handle.prepareContext(input), { code: "COMPOSER_UNAVAILABLE" });
  handle.unregister();
});

test("render failure is isolated and does not leave a mounted node", () => {
  const f = fixture();
  const handle = f.host.register("example.context", { id: "control", render() { throw Error("example failure"); } });
  assert.equal(handle.getStatus().reason, "ACCESSORY_RENDER_FAILED");
  assert.equal(f.row.children.length, 0);
  f.host.stop();
  assert.equal(handle.getStatus().reason, "COMPOSER_STOPPED");
});

test("a new draft can prepare visible context but remains unbound until native acceptance", () => {
  const f = fixture();
  delete f.taskProps.conversationId;
  let rendered = false;
  const handle = f.host.register("example.context", { id: "control", render() { rendered = true; } });
  assert.equal(handle.getStatus().available, true);
  assert.equal(rendered, true);
  const status = handle.getStatus();
  assert.equal(status.taskId, undefined);
  assert.match(status.draftId, /^draft-/);
  const prepared = handle.prepareSubmission({ draftId: status.draftId, revision: "config-1", text: "Visible example" });
  assert.equal(handle.getSubmission(prepared.bindingId).state, "prepared");
  assert.equal(handle.getSubmission(prepared.bindingId).taskId, undefined);
  handle.unregister();
});

test("switching tasks releases the editable preparation without discarding an in-flight receipt", async () => {
  const f = fixture();
  const handle = f.host.register("example.context", { id: "control", render() {} });
  const first = handle.prepareSubmission({ hostId: "local", taskId: "task-a", revision: "one", text: "First task" });
  const serialized = f.nodes.map(n => n.textContent.replaceAll('_', '\\_')).join('\n');
  f.listeners.get("codex-message-from-view")({ __codexForwardedViaBridge: true, detail: { type: "mcp-request", hostId: "local", request: { id: "request-a", method: "turn/start", params: { threadId: "task-a", input: [{ type: "text", text: serialized }] } } } });
  f.taskProps.conversationId = "task-b";
  f.nodes.splice(1);
  await f.refresh();
  handle.prepareSubmission({ hostId: "local", taskId: "task-b", revision: "two", text: "Second task" });
  f.listeners.get("message")({ source: null, data: { type: "mcp-response", hostId: "local", message: { id: "request-a", result: { turn: { id: "turn-a" } } } } });
  assert.equal(handle.getSubmission(first.bindingId).state, "accepted");
  handle.unregister();
});

test("an unsent preparation in another task does not block the new task", async () => {
  const f = fixture();
  const handle = f.host.register("example.context", { id: "control", render() {} });
  handle.prepareSubmission({ hostId: "local", taskId: "task-a", revision: "one", text: "First task" });
  f.taskProps.conversationId = "task-b";
  f.nodes.splice(1);
  await f.refresh();
  assert.doesNotThrow(() => handle.prepareSubmission({ hostId: "local", taskId: "task-b", revision: "two", text: "Second task" }));
  handle.unregister();
});
