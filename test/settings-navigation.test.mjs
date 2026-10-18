import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

// Execute the production navigation routine against a bounded native-settings DOM stand-in.
// No third-party plugin, private App router or native message sender is involved.
const source = await readFile(new URL("../src/settings-host.mjs", import.meta.url), "utf8");
const routine = source.slice(source.indexOf("  function openRegisteredPage(entry)"), source.indexOf("\n  const host = {"));

test("leaving settings clears selection, including a detached panel before the next sidebar mounts", () => {
  for (const sidebar of [null, {}]) {
    let restores = 0;
    const context = vm.createContext({
      stopped: false, sidebarRoot: null, unmountSettingsUi() { restores++; context.activeId = null; },
      activeId: "loader:runtime", pendingActiveId: "loader:runtime", panelHost: { isConnected: false },
      findSidebar: () => sidebar, restoreNative() { restores++; context.activeId = null; },
      pluginEntries() { throw new Error("selection checked before rendering"); },
    });
    vm.runInContext(source.slice(source.indexOf("  function sync()"), source.indexOf("  function applyActive()")), context);
    try { context.sync(); } catch (error) { assert.match(error.message, /selection checked/); }
    assert.equal(restores, 1);
    assert.equal(context.activeId, null);
    assert.equal(context.pendingActiveId, null);
  }
});

test("split navigation rail resolves the native settings main and separate header/body scroller", () => {
  class Element { constructor(className = "") { this.className = className; this.classList = { contains: value => className.split(" ").includes(value) }; this.dataset = {}; this.children = []; } }
  const page = new Element("group/settings mx-auto px-panel pb-panel pt-panel");
  const heading = new Element();
  const surface = new Element("flex-1 scrollbar-stable overflow-y-auto");
  surface.children = [heading, page]; page.parentElement = surface;
  surface.querySelector = selector => selector === "h1" ? heading : null;
  const main = new Element();
  main.querySelector = () => page;
  main.querySelectorAll = () => [surface, page];
  const aside = new Element();
  aside.parentElement = { children: [new Element(), aside, main], querySelector: () => main };
  const sidebar = { closest: selector => selector === "aside" ? aside : null };
  const context = vm.createContext({ HTMLElement: Element, panelSurface: null, visibleBox: () => true });
  vm.runInContext(source.slice(source.indexOf("  function findContentArea("), source.indexOf("  function pageIcon(")), context);
  assert.equal(context.findContentArea(sidebar), main);
  assert.equal(context.findNativePageSurface(main), surface);
  assert.equal(context.findNativePageTemplate(surface), page);
});

test("plugin settings survive a temporary bridge failure and reconcile after recovery", async () => {
  let fail = false;
  let plugins = [{ id: "local.example", enabled: true }];
  const context = vm.createContext({ managedPlugins: [], scheduleSync() {}, async requestBridge() {
    if (fail) throw new Error("Loader request timed out");
    return plugins;
  } });
  vm.runInContext(source.slice(source.indexOf("  async function refreshManagedPlugins()"), source.indexOf("\n  function loaderLabels()")), context);
  await context.refreshManagedPlugins();
  assert.equal(context.managedPlugins.length, 1);
  fail = true;
  await context.refreshManagedPlugins();
  assert.equal(context.managedPlugins.length, 1, "a timeout must not remove plugin settings entries");
  fail = false;
  plugins = [];
  await context.refreshManagedPlugins();
  assert.equal(context.managedPlugins.length, 0, "a successful empty list removes stale entries");
});
function fixture(initial = "main") {
  let phase = initial, clock = 0, clicks = 0, pointers = 0, activations = 0;
  const callbacks = new Map(); let timer = 0;
  const entry = { id: "example.settings:main" };
  const item = { textContent: "设置Ctrl+,", getAttribute: () => null, closest: () => null, click() { clicks++; phase = "settings"; } };
  const profile = { getAttribute: () => "false", closest: () => null, dispatchEvent(event) { pointers++; if (event.type === "pointerdown") phase = "menu"; } };
  const pages = new Map([[entry.id, entry]]);
  const context = vm.createContext({ pages, stopped: false, openingPage: null, activeId: null, panelHost: null,
    Date: { now: () => clock }, PointerEvent: class { constructor(type) { this.type = type; } },
    document: { querySelectorAll: selector => selector.includes('[role="menuitem"]') ? (phase === "ambiguous" ? [item,item] : phase === "menu" ? [item] : []) : phase === "main" ? [profile] : [] },
    visibleBox: () => true, compact: value => String(value || "").replace(/\s+/g," ").trim(),
    findSidebar: () => phase === "settings", sync() {}, activate(id) { activations++; context.activeId = id; context.panelHost = { isConnected: true }; },
    setTimeout(fn) { callbacks.set(++timer,fn); return timer; }, clearTimeout(id) { callbacks.delete(id); },
  });
  vm.runInContext(routine + "\nglobalThis.openPage = openRegisteredPage;", context);
  return { entry, pages, context, open: () => context.openPage(entry), counts: () => ({ clicks,pointers,activations }),
    advance(ms=80) { clock += ms; for (const [id,fn] of [...callbacks]) { callbacks.delete(id); fn(); } },
    phase(value) { phase = value; } };
}

test("page open navigates through one native profile/settings action and resolves only when mounted", async () => {
  const f = fixture(); const pending = f.open();
  assert.equal(f.open(), pending, "duplicate open shares the same navigation");
  assert.deepEqual(f.counts(), {clicks:0,pointers:2,activations:0});
  f.advance(); f.advance(); await pending;
  assert.deepEqual(f.counts(), {clicks:1,pointers:2,activations:1});
  assert.equal(f.context.activeId, f.entry.id);
});
test("an existing settings shell activates without profile or menu clicks", async () => {
  const f=fixture("settings"); await f.open();
  assert.deepEqual(f.counts(), {clicks:0,pointers:0,activations:1});
});
test("missing and ambiguous native settings controls fail without guessed clicks", async () => {
  for (const [phase,code] of [["missing","SETTINGS_NAVIGATION_UNAVAILABLE"],["ambiguous","SETTINGS_NAVIGATION_AMBIGUOUS"]]) {
    const f=fixture(phase); await assert.rejects(f.open(), {code}); assert.equal(f.counts().clicks,0);
  }
});
test("retained or pending page handles cannot navigate after unregister", async () => {
  const f=fixture(); const pending=f.open(); f.pages.clear(); f.advance();
  await assert.rejects(pending,{code:"SETTINGS_PAGE_UNREGISTERED"});
  await assert.rejects(f.open(),{code:"SETTINGS_PAGE_UNREGISTERED"});
  assert.equal(f.counts().activations,0);
});
test("another page cannot take over a pending navigation and timeout clears it", async () => {
  const f=fixture(); const pending=f.open();
  const other={id:"another.page:main"}; f.pages.set(other.id,other);
  await assert.rejects(f.context.openPage(other),{code:"SETTINGS_NAVIGATION_BUSY"});
  f.phase("waiting"); f.advance(6000);
  await assert.rejects(pending,{code:"SETTINGS_NAVIGATION_TIMEOUT"});
  assert.equal(f.context.openingPage,null);
});
