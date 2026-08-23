import path from "node:path";
import process from "node:process";
import { mkdir, writeFile } from "node:fs/promises";
import { connectCdpSession, listTargets, pickCodexTargets } from "../src/cdp.mjs";

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  return index < 0 ? fallback : process.argv[index + 1];
}

const port = Number(option("--port", "9229"));
const outputDirectory = path.resolve(option("--output", ".runtime/qa"));
const target = pickCodexTargets(await listTargets(port)).find(item => item.url === "app://-/index.html");
if (!target) throw new Error("no exact Codex renderer target found");
await mkdir(outputDirectory, { recursive: true });
const session = await connectCdpSession(target.webSocketDebuggerUrl);
await session.sendCommand("Runtime.enable", {});
await session.sendCommand("Page.enable", {});
const evaluate = async expression => {
  const reply = await session.sendCommand("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (reply.exceptionDetails) throw new Error(reply.exceptionDetails.exception?.description || reply.exceptionDetails.text);
  return reply.result?.value;
};
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const clickAt = async rect => {
  await session.sendCommand("Input.dispatchMouseEvent", { type: "mousePressed", x: rect.x, y: rect.y, button: "left", clickCount: 1 });
  await session.sendCommand("Input.dispatchMouseEvent", { type: "mouseReleased", x: rect.x, y: rect.y, button: "left", clickCount: 1 });
};
const rectFor = async expression => evaluate(`(() => { const target = ${expression}; if (!target) return null; const rect = target.getBoundingClientRect(); return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }; })()`);
const capture = async name => {
  const shot = await session.sendCommand("Page.captureScreenshot", { format: "png", captureBeyondViewport: false, fromSurface: true });
  const file = path.join(outputDirectory, name);
  await writeFile(file, Buffer.from(shot.data, "base64"));
  return file;
};

try {
  const settingsOpen = await evaluate(`Boolean(document.querySelector("nav[aria-label='设置'], nav[aria-label='Settings']"))`);
  if (!settingsOpen) {
    const profile = await rectFor(`[...document.querySelectorAll("button")].find(node => /^(open profile menu|打开个人资料菜单)$/iu.test(String(node.getAttribute("aria-label") || "").trim()))`);
    if (!profile) throw new Error("profile menu button not found");
    await clickAt(profile);
    await wait(300);
    const settings = await rectFor(`[...document.querySelectorAll("[role='menuitem'], [role='menu'] button")].find(node => /(settings|preferences|设置|偏好)/iu.test(String(node.innerText || node.getAttribute("aria-label") || "").trim()) && node.getBoundingClientRect().width > 0)`);
    if (!settings) throw new Error("settings menu item not found");
    await clickAt(settings);
    await wait(900);
  }
  const general = await rectFor(`[...document.querySelectorAll("nav[aria-label='设置'] button, nav[aria-label='Settings'] button")].find(node => /^(general|常规|通用)$/iu.test(String(node.innerText || node.getAttribute("aria-label") || "").trim()))`);
  if (general) {
    await clickAt(general);
    await wait(500);
  }
  const nativeFile = await capture("native-settings-reference.png");
  const nativeMetrics = await evaluate(`(() => {
    const nav = document.querySelector("nav[aria-label='设置'], nav[aria-label='Settings']");
    const aside = nav?.closest("aside");
    const content = aside?.parentElement ? [...aside.parentElement.children].find(node => node !== aside && node instanceof HTMLElement) : null;
    const rows = content ? [...content.querySelectorAll("button, label, [role='switch']")].filter(node => { const r = node.getBoundingClientRect(); return r.width > 240 && r.height >= 32; }).slice(0, 8) : [];
    const metric = node => { const style = getComputedStyle(node); const rect = node.getBoundingClientRect(); return { tag: node.tagName, className: String(node.className || ""), text: String(node.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 160), rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }, color: style.color, background: style.backgroundColor, border: style.border, borderRadius: style.borderRadius, padding: style.padding, fontSize: style.fontSize, fontWeight: style.fontWeight }; };
    return { viewport: { width: innerWidth, height: innerHeight }, content: content ? metric(content) : null, headings: content ? [...content.querySelectorAll("h1,h2,h3")].map(metric) : [], rows: rows.map(metric) };
  })()`);
  const bennett = await rectFor(`document.querySelector('[data-codex-loader-settings="nav:co.bennett.ui-improvements:main"]')`);
  if (!bennett) throw new Error("Bennett settings navigation entry not found");
  await clickAt(bennett);
  await wait(500);
  const bennettFile = await capture("bennett-settings-before.png");
  console.log(JSON.stringify({ nativeFile, bennettFile, nativeMetrics }, null, 2));
} finally {
  await session.close();
}
