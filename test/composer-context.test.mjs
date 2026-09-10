import test from "node:test";
import assert from "node:assert/strict";
import { createSubmissionContext } from "../src/composer-host.mjs";

function fixture() {
  let identity = { taskId: "task-a", hostId: "local" };
  const paragraphs = ["User draft", "An attachment remains untouched"];
  let edits = 0;
  const adapter = {
    identity: () => identity,
    count: text => paragraphs.filter(p => p === text).length,
    hasPrefix: prefix => paragraphs.some(p => p.startsWith(prefix)),
    insert: text => { paragraphs.push(text); edits++; },
    remove: text => { paragraphs.splice(paragraphs.indexOf(text), 1); edits++; },
    replace: (before, after) => { paragraphs.splice(paragraphs.indexOf(before), 1, after); edits++; },
  };
  return { context: createSubmissionContext(adapter, "example.workflow"), paragraphs,
    get edits() { return edits; }, navigate: value => { identity = value; } };
}
const request = { taskId: "task-a", hostId: "local", revision: "r1", text: "Use the installed example workflow." };

test("optional summary is presentation metadata, never an extra submitted instruction", () => {
  const f = fixture();
  assert.equal(f.context.prepare({...request,summary:"Example · Show more"}).display,"unsupported");
  assert.equal(f.paragraphs[2].includes("Example · Show more"),false);
  assert.ok(f.paragraphs[2].includes(request.text));
  assert.throws(()=>fixture().context.prepare({...request,summary:"x".repeat(257)}),{code:"INVALID_CONTEXT"});
  f.context.clear();assert.equal(f.paragraphs.length,2);
});

test("preparing visible context appends without replacing the user draft", () => {
  const f = fixture();
  assert.deepEqual(f.context.prepare(request), { state: "prepared", taskId: "task-a", hostId: "local", revision: "r1" });
  assert.deepEqual(f.paragraphs.slice(0, 2), ["User draft", "An attachment remains untouched"]);
  assert.match(f.paragraphs[2], /example\.workflow/);
  assert.match(f.paragraphs[2], /Use the installed example workflow/);
  f.context.prepare(request);
  assert.equal(f.edits, 1, "same revision must not append twice");
});

test("one revision cannot be changed and replacement preserves unrelated input", () => {
  const f = fixture();
  f.context.prepare(request);
  assert.throws(() => f.context.prepare({ ...request, text: "Changed" }), { code: "CONTEXT_CONFLICT" });
  f.context.prepare({ ...request, revision: "r2", text: "Revised instruction" });
  assert.equal(f.paragraphs.length, 3);
  assert.equal(f.context.status().revision, "r2");
});

test("user-edited and duplicate annotations are not removed or overwritten", () => {
  const f = fixture();
  f.context.prepare(request);
  f.paragraphs[2] += " user edit";
  assert.equal(f.context.status().state, "missing-or-edited");
  assert.throws(() => f.context.prepare({ ...request, revision: "r2" }), { code: "CONTEXT_EDITED" });
  f.context.clear();
  assert.equal(f.paragraphs.length, 3);
  const other = fixture();
  other.context.prepare(request);
  other.paragraphs.push(other.paragraphs[2]);
  assert.equal(other.context.status().state, "ambiguous");
  other.context.clear();
  assert.equal(other.paragraphs.length, 4);
});

test("navigation and host mismatch reject preparation without touching another draft", () => {
  const f = fixture();
  assert.throws(() => f.context.prepare({ ...request, hostId: "other" }), { code: "TASK_MISMATCH" });
  f.context.prepare(request);
  f.navigate({ taskId: "task-b", hostId: "local" });
  assert.equal(f.context.status().state, "task-changed");
  f.context.clear();
  assert.equal(f.paragraphs.length, 3);
});

test("missing stable task identity never produces a bound annotation", () => {
  const f = fixture();
  f.navigate(null);
  assert.throws(() => f.context.prepare(request), { code: "COMPOSER_UNAVAILABLE" });
  assert.equal(f.edits, 0);
});

test("clear and stop are idempotent and remove only an exact owned annotation", () => {
  const f = fixture();
  f.context.prepare(request);
  f.context.clear();
  f.context.clear();
  assert.equal(f.edits, 2);
  assert.equal(f.paragraphs.length, 2);
  f.context.stop();
  f.context.stop();
  assert.throws(() => f.context.prepare(request), { code: "COMPOSER_STOPPED" });
});

test("context limits use UTF-8 bytes and reject unknown fields before edits", () => {
  const f = fixture();
  for (const value of [{ ...request, text: "中".repeat(3000) }, { ...request, script: "unexpected" }, { ...request, revision: "bad revision" }, { ...request, text: " " }]) {
    assert.throws(() => f.context.prepare(value), { code: "INVALID_CONTEXT" });
  }
  assert.equal(f.edits, 0);
});

test("cleared input is not described as successfully submitted", () => {
  const f = fixture();
  f.context.prepare(request);
  f.paragraphs.length = 0;
  assert.equal(f.context.status().state, "missing-or-edited");
  assert.equal("submitted" in f.context.status(), false);
});

test("a leftover annotation is not adopted or duplicated by a new registration", () => {
  const f = fixture();
  f.paragraphs.push("[Loader context: example.workflow / old]\nA user-edited leftover");
  assert.throws(() => f.context.prepare(request), { code: "CONTEXT_EXISTS" });
  assert.equal(f.edits, 0);
});

test("saved context presentation is read-only until its own Remove button is used", () => {
  const block = "[Loader context: example.workflow / saved]\nAn existing instruction\n[/Loader context]";
  const paragraphs = ["User text", block];
  let remove, stops = 0, folds = 0;
  const context = createSubmissionContext({
    paragraphs: () => paragraphs,
    count: text => paragraphs.filter(p => p === text).length,
    remove: text => paragraphs.splice(paragraphs.indexOf(text), 1),
    fold(text, summary, erase) { assert.equal(text, block); assert.ok(summary); remove = erase; folds++; return { stop() { stops++; } }; },
  }, "example.workflow");
  context.refreshPresentation(); context.refreshPresentation();
  assert.equal(folds, 1);
  assert.deepEqual(context.status(), { state: "idle" });
  context.clear();
  assert.equal(stops, 0, "clearing an unowned context does not discard the presentation");
  assert.deepEqual(paragraphs, ["User text", block]);
  remove();
  assert.deepEqual(paragraphs, ["User text"]); assert.equal(stops, 1);
  context.stop(); context.refreshPresentation(); assert.equal(folds, 1);
});

test("restored folds ignore incomplete, mixed, duplicate and other-plugin annotations", () => {
  const block = "[Loader context: example.workflow / saved]\nInstructions\n[/Loader context]";
  for (const paragraphs of [[block + " User text"], ["User text " + block], [block.replace("[/Loader context]", "")],
    [block, block], [block.replace("example.workflow", "another.plugin")], [block + "\n" + block]]) {
    let folds = 0;
    const context = createSubmissionContext({ paragraphs: () => paragraphs, fold() { folds++; } }, "example.workflow");
    context.refreshPresentation();
    assert.equal(folds, 0);
    context.stop();
  }
});

test("managed context actions notify once, while API changes and teardown stay silent", () => {
  const paragraphs = ["User draft"], events = [];
  let erase, disclosure;
  const context = createSubmissionContext({
    identity: () => ({ taskId: "task-a", hostId: "local" }),
    paragraphs: () => paragraphs,
    count: text => paragraphs.filter(p => p === text).length,
    hasPrefix: prefix => paragraphs.some(p => p.startsWith(prefix)),
    insert: text => paragraphs.push(text),
    remove: text => paragraphs.splice(paragraphs.indexOf(text), 1),
    notify: event => events.push(event),
    fold(_text, _summary, remove, changed) { erase = remove; disclosure = changed; return { stop() {} }; },
  }, "example.workflow");
  context.prepare({ ...request, summary: "Workflow" });
  assert.equal(events.length, 0);
  disclosure(true); disclosure(false);
  paragraphs[1] = paragraphs[1].replace("installed", "selected");
  context.userEdit(); context.userEdit();
  paragraphs[0] += " normal typing"; context.userEdit();
  assert.deepEqual(events.map(event => event.action), ["expanded", "collapsed", "edited"]);
  assert.ok(events.every(event => event.target === "context" && event.revision === "r1"));
  context.clear(); // Edited text is not silently deleted.
  paragraphs.splice(1);
  context.prepare({ ...request, summary: "Workflow" }); erase();
  assert.equal(events.at(-1).action, "removed");
  assert.deepEqual(paragraphs, ["User draft normal typing"]);
  context.prepare({ ...request, summary: "Workflow" }); context.clear(); context.stop();
  assert.equal(events.length, 4);
});

test("explicit API clear can remove a restored exact context without notification or adoption", () => {
  const block = "[Loader context: example.workflow / saved]\nSaved instructions\n[/Loader context]";
  const paragraphs = ["User text", block], events = [];
  const context = createSubmissionContext({
    paragraphs: () => paragraphs, count: text => paragraphs.filter(p => p === text).length,
    remove: text => paragraphs.splice(paragraphs.indexOf(text), 1),
    notify: event => events.push(event), fold() { return { stop() {} }; },
  }, "example.workflow");
  context.refreshPresentation();
  assert.equal(context.status().state, "idle");
  context.clear(true);
  assert.deepEqual(paragraphs, ["User text"]); assert.deepEqual(events, []);
});
