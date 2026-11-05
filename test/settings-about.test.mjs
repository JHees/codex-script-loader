import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const source = await readFile(new URL("../src/settings-host.mjs", import.meta.url), "utf8");
class Node {
  constructor(tag) { this.tag = tag; this.children = []; this.dataset = {}; this.style = {}; }
  append(...nodes) { this.children.push(...nodes); }
  appendChild(node) { this.append(node); return node; }
  replaceChildren(...nodes) { this.children = nodes; }
  setAttribute(name, value) { this[name] = value; }
}
const flatten = node => [node, ...node.children.flatMap(flatten)];

test("project introduction stays inside settings with bilingual copy and accessible external links", () => {
  for (const lang of ["zh-CN", "en"]) {
    const document = { documentElement: { lang }, createElement: tag => new Node(tag) };
    const context = vm.createContext({ document, version: "0.6.1",
      loaderIcon() {}, helpIcon() {}, renderLoaderPage() {}, pluginEntries: () => [{ id: "example:main" }],
    });
    vm.runInContext(source.slice(source.indexOf("  function loaderLabels()"), source.indexOf("  function settingsCard()")), context);
    vm.runInContext(source.slice(source.indexOf("  function createProjectFooter("), source.indexOf("  function sync()")), context);
    const entries = context.combinedEntries();
    assert.deepEqual(Array.from(entries, entry => entry.id), ["loader:runtime", "example:main"]);
    const root = context.createProjectFooter();
    assert.equal(root.dataset.codexLoaderSettings, "project-footer");
    assert.ok(flatten(root).some(node => node.textContent === (lang === "zh-CN" ? "源码与文档" : "Source & docs")));
    const links = flatten(root).filter(node => node.tag === "a");
    assert.equal(links.length, 5);
    assert.equal(new Set(links.map(link => link.href)).size, 4);
    for (const link of links) {
      assert.equal(new URL(link.href).origin, "https://github.com");
      assert.equal(link.target, "_blank");
      assert.equal(link.rel, "noopener noreferrer");
      assert.ok(link["aria-label"] || link.textContent);
    }
    assert.ok(flatten(root).some(node => /Star/.test(node.textContent)));
    assert.match(source, /root\.append\(updateSection, pluginsSection, diagnosticsSection, createProjectFooter\(\)\)/);
  }
});
