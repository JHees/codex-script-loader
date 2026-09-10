// Public seam: task-bound visible context, never a send/permission interception API.
function createSubmissionContext(adapter, pluginId) {
  let current = null;
  let stopped = false;
  let presentation = null;
  let display = "text";
  let restored = null;
  let observed = null;
  const notify = (action, entry = current ?? restored) => {
    if (!stopped && entry) adapter.notify?.({ target: "context", action, revision: entry.revision });
  };
  const removed = () => {
    const entry = current ?? restored;
    if (!entry || adapter.count(entry.block) !== 1) fail("CONTEXT_EDITED");
    clear(true); notify("removed", entry);
  };
  const disclosure = expanded => notify(expanded ? "expanded" : "collapsed");
  const fail = (code) => { throw Object.assign(new Error(code), { code }); };
  const sameTask = identity => identity && identity.taskId === current?.taskId && identity.hostId === current?.hostId && identity.draftId === current?.draftId;
  function status() {
    if (stopped) return { state: "stopped" };
    if (!current) return { state: "idle" };
    const count = sameTask(adapter.identity()) ? adapter.count(current.block) : -1;
    return { state: count < 0 ? "task-changed" : count === 1 ? "prepared" : count === 0 ? "missing-or-edited" : "ambiguous",
      ...(current.draftId ? { draftId: current.draftId } : { taskId: current.taskId, hostId: current.hostId }), revision: current.revision, ...(current.summary !== undefined ? {display} : {}) };
  }
  function clear(includeRestored = false) {
    // A restored fold is presentation only, not an adopted editable context.
    if (!current && !(includeRestored && restored)) return;
    if (!current) {
      if (adapter.count(restored.block) !== 1) fail("CONTEXT_EDITED");
      adapter.remove(restored.block);
    }
    if (current && sameTask(adapter.identity()) && adapter.count(current.block) === 1) adapter.remove(current.block);
    current = null;
    restored = null; observed = null;
    presentation?.stop(); presentation = null; display = "text";
  }
  return Object.freeze({
    status,
    userEdit() {
      const entry = current ?? restored;
      if (stopped || !entry) return;
      const prefix = `[Loader context: ${pluginId} / ${entry.revision}]`;
      const text = JSON.stringify((adapter.paragraphs?.() ?? []).filter(p => p.startsWith(prefix)));
      if (text === observed) return;
      observed = text; notify("edited", entry);
    },
    refreshPresentation() {
      if (stopped || current || presentation || typeof adapter.fold !== "function") return;
      const prefix = `[Loader context: ${pluginId} / `;
      const candidates = (adapter.paragraphs?.() ?? []).filter(text => text.startsWith(prefix));
      if (candidates.length !== 1) return;
      const block = candidates[0];
      const match = block.slice(prefix.length).match(/^([A-Za-z0-9._:-]{1,128})\]\n([\s\S]+)\n\[\/Loader context\]$/);
      if (!match || match[2].includes("[Loader context:") || match[2].includes("[/Loader context]")
        || match[2].includes("\0") || new TextEncoder().encode(match[2]).length > 8192) return;
      // Never manufacture a preparation or receipt from persisted draft text.
      restored = { block, revision: match[1] };
      observed = JSON.stringify([block]);
      presentation = adapter.fold(block, adapter.restoredSummary ?? "Saved plugin instructions", removed, disclosure) ?? null;
    },
    prepare(input) {
      if (stopped) fail("COMPOSER_STOPPED");
      const fields = input?.draftId !== undefined ? ["draftId", "revision", "text"] : ["taskId", "hostId", "revision", "text"];
      if (input?.summary !== undefined) fields.push("summary");
      if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length !== fields.length || fields.some(k => typeof input[k] !== "string" || !input[k].trim())) fail("INVALID_CONTEXT");
      if (!/^[A-Za-z0-9._:-]{1,128}$/.test(input.revision) || fields.filter(k => k !== "text").some(k => input[k].length > 256) || new TextEncoder().encode(input.text).length > 8192 || input.text.includes("\0")) fail("INVALID_CONTEXT");
      const identity = adapter.identity();
      if (!identity) fail("COMPOSER_UNAVAILABLE");
      if (identity.taskId !== input.taskId || identity.hostId !== input.hostId || identity.draftId !== input.draftId) fail("TASK_MISMATCH");
      if (current) {
        if (!sameTask(identity)) fail("TASK_MISMATCH");
        if (current.revision === input.revision && current.text !== input.text) fail("CONTEXT_CONFLICT");
        if (status().state !== "prepared") fail("CONTEXT_EDITED");
        if (current.revision === input.revision) return status();
      }
      const next = { ...input, block: `[Loader context: ${pluginId} / ${input.revision}]\n${input.text}\n[/Loader context]` };
      if (!current && adapter.hasPrefix(`[Loader context: ${pluginId} / `)) fail("CONTEXT_EXISTS");
      if (current) adapter.replace(current.block, next.block);
      else adapter.insert(next.block);
      current = next;
      restored = null; observed = JSON.stringify([next.block]);
      presentation?.stop(); presentation = null;
      if (input.summary !== undefined) {
        presentation = adapter.fold?.(next.block, input.summary, removed, disclosure) ?? null;
        display = presentation ? "collapsed" : "unsupported";
      } else display = "text";
      return status();
    },
    clear,
    stop() { if (!stopped) { try { clear(); } finally { stopped = true; presentation?.stop(); presentation = null; } } },
  });
}

// Fold presentation and caret routing; instruction text is never rewritten.
function mountContextFold(view, block, summary, remove, changed) {
  if (typeof view?.setProps !== "function" || !view.props || view.nodeViews?.paragraph || view.composing) return null;
  const document = view.dom.ownerDocument;
  const zh = /^zh/i.test(document.documentElement.lang);
  const matches = node => node.type.name === "paragraph" && node.textBetween(0, node.content.size, "", "\n") === block;
  let stopped = false;
  const factory = (node, _view, getPos) => {
    if (stopped || !matches(node)) return undefined;
    const dom = document.createElement("div"), bar = document.createElement("div"), contentDOM = document.createElement("p");
    dom.dataset.loaderContextFold = "true";
    dom.style.cssText = "margin:6px 0;border:1px solid var(--color-token-border,ButtonBorder);border-radius:10px;padding:6px 8px;";
    bar.contentEditable = "false";
    bar.style.cssText = "display:flex;align-items:center;gap:8px;font-size:12px;";
    const title = document.createElement("span"), toggle = document.createElement("button"), erase = document.createElement("button");
    title.textContent = summary; title.style.cssText = "flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap";
    title.title = summary;
    for (const button of [toggle, erase]) { button.type = "button"; button.style.cssText = "font:inherit;color:inherit;background:transparent;border:0;padding:2px 4px;cursor:pointer;white-space:nowrap"; }
    erase.textContent = zh ? "移除" : "Remove";
    let expanded = false;
    const show = value => { expanded = value; contentDOM.hidden = !value; toggle.textContent = value ? (zh ? "收起" : "Show less") : (zh ? "显示更多" : "Show more"); toggle.setAttribute("aria-expanded", String(value)); };
    toggle.onclick = () => { toggle.focus(); show(!expanded); changed?.(expanded); };
    erase.onclick = () => { try { remove(); } catch (error) { title.textContent = /^[A-Z_]+$/.test(error?.code) ? error.code : "CONTEXT_EDITED"; show(true); } };
    const redirectCaret = () => {
      if (expanded || stopped || view.isDestroyed || view.composing) return;
      const pos = getPos();
      const { selection } = view.state;
      if (typeof pos !== "number" || selection.from <= pos || selection.to >= pos + node.nodeSize) return;
      const tr = view.state.tr;
      let target = selection.constructor.findFrom(tr.doc.resolve(pos), -1, true);
      if (!target) {
        // A context-only draft needs a normal text paragraph, never input in metadata.
        tr.insert(pos, view.state.schema.nodes.paragraph.create());
        target = selection.constructor.findFrom(tr.doc.resolve(pos), 1, true);
      }
      view.dispatch(tr.setSelection(target).setMeta("addToHistory", false));
    };
    document.addEventListener("selectionchange", redirectCaret);
    for (const event of ["focus", "beforeinput", "compositionstart"]) view.dom.addEventListener(event, redirectCaret, true);
    bar.append(title, toggle, erase); dom.append(bar, contentDOM); show(false);
    return {
      dom, contentDOM,
      update(next) { if (!matches(next)) return false; node = next; return true; },
      stopEvent: event => bar.contains(event.target),
      ignoreMutation: mutation => mutation.type !== "selection" && (bar.contains(mutation.target) || (mutation.type === "attributes" && mutation.target === contentDOM)),
      destroy() {
        document.removeEventListener("selectionchange", redirectCaret);
        for (const event of ["focus", "beforeinput", "compositionstart"]) view.dom.removeEventListener(event, redirectCaret, true);
      },
    };
  };
  view.setProps({nodeViews:{...view.props.nodeViews,paragraph:factory}});
  return { stop() {
    if (stopped) return; stopped = true;
    if (!view.isDestroyed && view.props.nodeViews?.paragraph === factory) {
      const next = {...view.props.nodeViews}; delete next.paragraph; view.setProps({nodeViews:next});
    }
  }};
}

function createSubmissionReceipts() {
  const records = new Map();
  const fail = code => { throw Object.assign(new Error(code), { code }); };
  const text = value => typeof value === "string" && value.length > 0 && value.length <= 256;
  function get(bindingId) {
    const record = records.get(bindingId);
    if (!record) return { state: "unknown", bindingId };
    return { ...record.receipt };
  }
  return Object.freeze({
    get,
    register({ bindingId, owner, serializedContext }) {
      const task = owner && Object.keys(owner).length === 2 && text(owner.hostId) && text(owner.taskId);
      const draft = owner && Object.keys(owner).length === 1 && text(owner.draftId);
      if (!/^[A-Za-z0-9-]{1,128}$/.test(bindingId) || !(task || draft)
        || typeof serializedContext !== "string" || !serializedContext.includes(bindingId)
        || new TextEncoder().encode(serializedContext).length > 8192) fail("INVALID_SUBMISSION_CONTEXT");
      if (records.has(bindingId)) fail("SUBMISSION_EXISTS");
      if (records.size >= 128) fail("SUBMISSION_LIMIT");
      records.set(bindingId, { owner: { ...owner }, serializedContext, receipt: { state: "prepared", bindingId } });
      return get(bindingId);
    },
    outgoing(event, forwarded) {
      const request = event?.request;
      if (!forwarded || event?.type !== "mcp-request" || !["turn/start", "turn/steer"].includes(request?.method)) return;
      if (!text(request.id) || !text(event.hostId) || !text(request.params?.threadId) || !Array.isArray(request.params.input)) return;
      const inputs = request.params.input.filter(part => part?.type === "text" && typeof part.text === "string");
      for (const record of records.values()) {
        const previous = record.receipt;
        if (!inputs.some(part => part.text.includes(previous.bindingId))) continue;
        let count = 0;
        for (const part of inputs) {
          let offset = -1;
          while ((offset = part.text.indexOf(record.serializedContext, offset + 1)) !== -1 && count < 2) count++;
        }
        if (count !== 1 || (!record.owner.draftId && (record.owner.taskId !== request.params.threadId || record.owner.hostId !== event.hostId))) {
          record.receipt = { ...previous, state: "context-mismatch" }; continue;
        }
        if (previous.requestId === request.id) continue;
        if (previous.state !== "prepared" && previous.state !== "rejected") {
          record.receipt = { ...previous, state: "ambiguous" }; continue;
        }
        record.receipt = { state: "dispatched", bindingId: previous.bindingId, hostId: event.hostId, taskId: request.params.threadId,
          requestId: request.id, clientUserMessageId: request.params.clientUserMessageId };
      }
    },
    incoming(event) {
      if (event?.type !== "mcp-response") return;
      for (const record of records.values()) {
        const receipt = record.receipt;
        if (receipt.state !== "dispatched" || receipt.requestId !== event.message?.id || receipt.hostId !== event.hostId) continue;
        if (event.message.error) record.receipt = { ...receipt, state: "rejected" };
        else {
          const result = event.message.result;
          const turnId = result?.turn?.id ?? result?.turnId;
          record.receipt = text(turnId) ? { ...receipt, state: "accepted", turnId } : { ...receipt, state: "unrecognized-response" };
        }
      }
    },
    clear(bindingId) { records.delete(bindingId); },
    stop() { records.clear(); },
  });
}

function installComposerHost() {
  const runtime = globalThis.__codexScriptLoader;
  if (!runtime) return;
  const revision = "composer-native-submission-10";
  if (runtime.composerHost?.revision === revision) return;
  runtime.composerHost?.stop();
  const registrations = new Map();
  const draftIds = new WeakMap();
  let observer = null, timer = null;
  let listening = false;
  const fail = code => { throw Object.assign(new Error(code), { code }); };
  const sameIdentity = (a, b) => !!a && !!b && a.taskId === b.taskId && a.hostId === b.hostId && a.draftId === b.draftId;
  const outgoing = event => { for (const record of registrations.values()) record.receipts.outgoing(event.detail, event.__codexForwardedViaBridge === true); };
  const incoming = event => {
    if (event.source !== null && event.source !== globalThis) return;
    if (event.source === globalThis && location.origin && location.origin !== "null" && event.origin !== location.origin) return;
    // Do not decode or acknowledge App chunks a second time. Unrecognized responses never bind a task.
    for (const record of registrations.values()) record.receipts.incoming(event.data);
  };
  function stopListening() {
    if (!listening) return;
    globalThis.removeEventListener("codex-message-from-view", outgoing);
    globalThis.removeEventListener("message", incoming);
    listening = false;
  }
  function locate() {
    if (typeof document === "undefined" || globalThis.location?.href !== "app://-/index.html") return null;
    const editors = [...document.querySelectorAll('[data-codex-composer][contenteditable="true"]')].filter(e => e.isConnected && e.getClientRects().length > 0);
    if (editors.length !== 1) return null;
    const editor = editors[0], parent = editor.parentElement;
    const key = Object.getOwnPropertyNames(parent || {}).find(k => k.startsWith("__reactFiber$"));
    let fiber = parent?.[key], controller = null, identity = null, hasTask = false;
    for (let depth = 0; fiber && depth < 60; depth++, fiber = fiber.return) {
      const props = fiber.memoizedProps;
      const candidate = props?.composerController;
      if (typeof props?.conversationId === "string" && props.conversationId) hasTask = true;
      if (candidate?.view?.dom === editor) {
        if (controller && controller !== candidate) return null;
        controller = candidate;
      }
      if (typeof props?.conversationId === "string" && typeof props?.hostId === "string") {
        const next = { taskId: props.conversationId, hostId: props.hostId };
        if (identity && (identity.taskId !== next.taskId || identity.hostId !== next.hostId)) return null;
        identity = next;
      }
    }
    const footer = editor.closest("[data-composer-footer-responsive]");
    let anchor = footer?.querySelector("[data-codex-intelligence-trigger]");
    if (!controller || !anchor || typeof controller.view.dispatch !== "function" || !controller.view.state?.schema?.nodes?.paragraph) return null;
    // Skip the model control's tooltip wrappers. Insert in its native flex row,
    // immediately before that control (after the context indicator when present).
    let layoutFound = false;
    for (let depth = 0; anchor?.parentElement && depth < 4; depth++) {
      const parent = anchor.parentElement;
      if (parent === footer || parent.contains?.(editor)) break;
      if (["flex", "inline-flex"].includes(getComputedStyle(parent).display)) { layoutFound = true; break; }
      anchor = parent;
    }
    if (!layoutFound) return null;
    if (!identity) {
      if (hasTask || typeof globalThis.crypto?.randomUUID !== "function") return null;
      if (!draftIds.has(controller)) draftIds.set(controller, "draft-" + globalThis.crypto.randomUUID());
      identity = { draftId: draftIds.get(controller) };
    }
    return { editor, controller, identity, anchor };
  }
  function adapterFor(binding, notify) {
    const paragraphText = node => node.textBetween(0, node.content.size, "", "\n");
    function positions(text) {
      const matches = [];
      binding.controller.view.state.doc.forEach((node, offset) => {
        if (node.type.name === "paragraph" && paragraphText(node) === text) matches.push({ from: offset, to: offset + node.nodeSize });
      });
      return matches;
    }
    function write(before, after) {
      const active = locate();
      if (!active || active.editor !== binding.editor || active.controller !== binding.controller || !sameIdentity(active.identity, binding.identity)) fail("TASK_MISMATCH");
      const view = binding.controller.view;
      if (view.composing) fail("COMPOSER_COMPOSING");
      const { state } = view;
      const matches = before === null ? [] : positions(before);
      if (before !== null && matches.length !== 1) fail("CONTEXT_EDITED");
      const from = before === null ? state.doc.content.size : matches[0].from;
      const to = before === null ? from : matches[0].to;
      const tr = state.tr;
      if (after === null) tr.delete(from, to);
      else {
        const hardBreak = state.schema.nodes.hard_break;
        if (!hardBreak) fail("SUBMISSION_UNSUPPORTED");
        // Literal newlines in text nodes collapse during the editor's DOM round-trip.
        // Native break nodes preserve both visible text and its captured serialization.
        const parts = [];
        after.split("\n").forEach((line, index) => {
          if (index) parts.push(hardBreak.create());
          if (line) parts.push(state.schema.text(line));
        });
        tr.replaceWith(from, to, state.schema.nodes.paragraph.create(null, parts));
      }
      // Keep the user's selection and focus; do not call appendText(), focus(), or submit().
      tr.setSelection(state.selection.map(tr.doc, tr.mapping));
      view.dispatch(tr);
    }
    return {
      notify,
      identity() { const active = locate(); return active?.editor === binding.editor && active.controller === binding.controller ? active.identity : null; },
      paragraphs() { const texts = []; binding.controller.view.state.doc.forEach(node => { if (node.type.name === "paragraph") texts.push(paragraphText(node)); }); return texts; },
      restoredSummary: /^zh/i.test(document.documentElement.lang) ? "插件说明（已有草稿）" : "Saved plugin instructions",
      count: text => positions(text).length,
      hasPrefix(prefix) { let found = false; binding.controller.view.state.doc.forEach(node => { if (node.type.name === "paragraph" && node.textContent.startsWith(prefix)) found = true; }); return found; },
      insert: text => write(null, text),
      remove: text => write(text, null),
      replace: (before, after) => write(before, after),
      fold: (block, summary, remove, changed) => mountContextFold(binding.controller.view, block, summary, remove, changed),
    };
  }
  function unmount(record) {
    record.stopInput?.(); record.stopInput = null;
    try { record.cleanup?.(); } catch { /* Plugin cleanup must not prevent host cleanup. */ }
    try { record.context?.stop(); } catch { /* An edited draft stays untouched. */ }
    record.root?.remove();
    record.root = record.binding = record.context = record.cleanup = null;
    // Editable context belongs to this mount. Native receipts may complete after navigation.
    record.prepared = null;
  }
  function snapshot(record) {
    if (record.closed) return { available: false, reason: "COMPOSER_STOPPED" };
    if (record.failed) return { available: false, reason: "ACCESSORY_RENDER_FAILED" };
    const active = locate();
    if (!active || active.editor !== record.binding?.editor || !sameIdentity(active.identity, record.binding.identity)) return { available: false, reason: "COMPOSER_UNAVAILABLE" };
    return { available: true, ...active.identity, placement: "native-controls", contextDisplay: "collapsed-v1", notifications: "managed-v1", context: record.context.status() };
  }
  function refresh() {
    const active = locate();
    for (const record of registrations.values()) {
      if (record.failed) continue;
      if (!active || active.editor !== record.binding?.editor || active.controller !== record.binding.controller || !sameIdentity(active.identity, record.binding.identity) || !record.root?.isConnected) {
        unmount(record);
        if (!active || record.closed || registrations.get(record.pluginId + ":" + record.id) !== record) continue;
        record.binding = active;
        record.context = createSubmissionContext(adapterFor(active, change => {
          if (!snapshot(record).available) return;
          if (change.action === "removed" && record.prepared) {
            if (record.receipts.get(record.prepared.bindingId).state === "prepared") record.receipts.clear(record.prepared.bindingId);
            record.prepared = null;
          }
          try { Promise.resolve(record.onChange?.(Object.freeze({ ...change, identity: Object.freeze({ ...active.identity }) }))).catch(() => {}); }
          catch { /* A plugin callback must not break the native control. */ }
        }), record.pluginId);
        let inputTimer = null;
        const input = () => {
          if (inputTimer !== null) return;
          inputTimer = setTimeout(() => {
            inputTimer = null;
            if (!snapshot(record).available || active.controller.view.composing) return;
            if (record.prepared && !["prepared", "rejected"].includes(record.receipts.get(record.prepared.bindingId).state)) return;
            record.context?.userEdit();
          }, 0);
        };
        active.editor.addEventListener("input", input);
        active.editor.addEventListener("compositionend", input);
        record.stopInput = () => {
          active.editor.removeEventListener("input", input); active.editor.removeEventListener("compositionend", input);
          if (inputTimer !== null) clearTimeout(inputTimer);
        };
        const root = document.createElement("span");
        root.dataset.loaderComposerAccessory = record.pluginId + ":" + record.id;
        root.style.display = "inline-flex";
        root.style.alignItems = "center";
        root.style.minWidth = "0";
        root.style.maxWidth = "min(16rem, 30vw)";
        active.anchor.parentElement.insertBefore(root, active.anchor);
        record.root = root;
        try { record.cleanup = record.render(root, Object.freeze({ ...active.identity })); }
        catch { unmount(record); record.failed = true; }
      }
      record.context?.refreshPresentation();
    }
  }
  function schedule() {
    if (timer !== null || registrations.size === 0) return;
    timer = setTimeout(() => { timer = null; refresh(); }, 0);
  }
  function start() {
    if (!listening && typeof globalThis.addEventListener === "function") {
      globalThis.addEventListener("codex-message-from-view", outgoing);
      globalThis.addEventListener("message", incoming);
      listening = true;
    }
    if (observer || typeof document === "undefined" || !document.documentElement || typeof MutationObserver === "undefined") return;
    observer = new MutationObserver(schedule);
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }
  runtime.composerHost = Object.freeze({
    revision,
    register(pluginId, spec) {
      if (!spec || !/^[a-zA-Z0-9._-]{1,64}$/.test(spec.id) || typeof spec.render !== "function" || (spec.onChange !== undefined && typeof spec.onChange !== "function")) fail("INVALID_ACCESSORY");
      const key = pluginId + ":" + spec.id;
      if (registrations.has(key)) fail("ACCESSORY_EXISTS");
      if (registrations.size >= 16) fail("ACCESSORY_LIMIT");
      const record = { pluginId, id: spec.id, render: spec.render, onChange: spec.onChange, root: null, binding: null, context: null, cleanup: null, closed: false, receipts: createSubmissionReceipts(), prepared: null };
      registrations.set(key, record);
      start(); refresh();
      return Object.freeze({
        getStatus: () => snapshot(record),
        getSubmission: bindingId => record.closed ? { state: "stopped", bindingId } : record.receipts.get(bindingId),
        prepareSubmission(input) {
          if (record.closed) fail("COMPOSER_STOPPED");
          if (!snapshot(record).available) fail("COMPOSER_UNAVAILABLE");
          const json = JSON.stringify(input);
          const previous = record.prepared;
          if (previous && record.receipts.get(previous.bindingId).state === "prepared") {
            if (previous.json !== json) fail("CONTEXT_CONFLICT");
            if (record.context.status().state !== "prepared") fail("CONTEXT_EDITED");
            return record.receipts.get(previous.bindingId);
          }
          const bindingId = "submission-" + globalThis.crypto.randomUUID();
          if (typeof input?.text !== "string" || input.text.includes("[/Loader context]")) fail("INVALID_CONTEXT");
          if (typeof input.revision !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(input.revision)) fail("INVALID_CONTEXT");
          const controller = record.binding.controller;
          if (typeof controller.getText !== "function") fail("SUBMISSION_UNSUPPORTED");
          if (previous) record.context.clear();
          try {
            record.context.prepare({ ...input, revision: bindingId });
            // Capture the native serializer's output rather than duplicating Markdown escaping rules.
            const documentText = controller.getText();
            const marker = documentText.indexOf(bindingId);
            if (marker < 0 || documentText.indexOf(bindingId, marker + 1) >= 0) fail("SUBMISSION_AMBIGUOUS");
            const start = documentText.lastIndexOf("\n", marker) + 1;
            const end = documentText.indexOf("[/Loader context]", marker);
            if (end < marker) fail("SUBMISSION_UNSUPPORTED");
            const serializedContext = documentText.slice(start, end + "[/Loader context]".length);
            const result = record.receipts.register({ bindingId, owner: record.binding.identity, serializedContext });
            record.prepared = { bindingId, json };
            return result;
          } catch (error) { record.context.clear(); throw error; }
        },
        prepareContext: input => { if (record.closed) fail("COMPOSER_STOPPED"); if (!snapshot(record).available) fail("COMPOSER_UNAVAILABLE"); return record.context.prepare(input); },
        clearContext: () => {
          if (record.closed) return;
          if (!snapshot(record).available) fail("COMPOSER_UNAVAILABLE");
          record.context?.refreshPresentation();
          record.context?.clear(true);
          if (record.prepared && record.receipts.get(record.prepared.bindingId).state === "prepared") record.receipts.clear(record.prepared.bindingId);
          record.prepared = null;
        },
        unregister() {
          if (record.closed) return;
          record.closed = true;
          registrations.delete(key); unmount(record); record.receipts.stop();
          if (registrations.size === 0) { stopListening(); observer?.disconnect(); observer = null; if (timer !== null) clearTimeout(timer); timer = null; }
        },
      });
    },
    stop() {
      stopListening();
      observer?.disconnect(); observer = null;
      if (timer !== null) clearTimeout(timer); timer = null;
      for (const record of registrations.values()) { record.closed = true; unmount(record); record.receipts.stop(); }
      registrations.clear();
    },
  });
}

export function buildComposerHostSource() {
  return `(() => { ${mountContextFold.toString()}\n${createSubmissionContext.toString()}\n${createSubmissionReceipts.toString()}\n${installComposerHost.toString()}\ninstallComposerHost(); })();`;
}

export { createSubmissionContext, createSubmissionReceipts, mountContextFold };
