using System.Text;
using System.Text.Json;

namespace CodexScriptLoader.Core;

public static class InjectionSourceBuilder
{
    public static string Build(IReadOnlyList<ScriptDescriptor> descriptors, string settingsHostModule, bool force)
    {
        var forceIds = force
            ? descriptors.Select(descriptor => descriptor.Id).ToHashSet(StringComparer.Ordinal)
            : new HashSet<string>(StringComparer.Ordinal);
        return Build(descriptors, settingsHostModule, forceIds);
    }

    public static string Build(IReadOnlyList<ScriptDescriptor> descriptors, string settingsHostModule, IReadOnlySet<string> forceIds)
    {
        var builder = new StringBuilder();
        builder.AppendLine(BootstrapSource);
        builder.AppendLine(ExtractSettingsHost(settingsHostModule));
        builder.AppendLine(BuildLifecycleSync(descriptors));
        foreach (var descriptor in descriptors)
        {
            builder.AppendLine(WrapScript(descriptor, forceIds.Contains(descriptor.Id)));
        }

        builder.AppendLine(SnapshotSource);
        return builder.ToString();
    }

    private static string ExtractSettingsHost(string module)
    {
        const string startMarker = "function installSettingsHost(version) {";
        const string endMarker = "\nexport function buildSettingsHostSource()";
        var start = module.IndexOf(startMarker, StringComparison.Ordinal);
        var end = module.IndexOf(endMarker, StringComparison.Ordinal);
        if (start < 0 || end <= start)
        {
            throw new InvalidDataException("Bundled settings host module has an unsupported shape.");
        }

        var versionStart = module.IndexOf('"');
        var versionEnd = versionStart >= 0 ? module.IndexOf('"', versionStart + 1) : -1;
        if (versionStart < 0 || versionEnd <= versionStart)
        {
            throw new InvalidDataException("Bundled settings host version is missing.");
        }

        var version = module[(versionStart + 1)..versionEnd];
        return $"({module[start..end]})({JsonSerializer.Serialize(version)});";
    }

    private static string BuildLifecycleSync(IReadOnlyList<ScriptDescriptor> descriptors)
    {
        var ids = JsonSerializer.Serialize(descriptors.Select(descriptor => descriptor.Id));
        return $$"""
        (() => {
          const runtime = globalThis.__codexScriptLoader;
          if (!runtime || !runtime.scripts) return;
          const active = new Set({{ids}});
          for (const id of Object.keys(runtime.scripts)) {
            if (active.has(id)) continue;
            const record = runtime.scripts[id];
            if (record && typeof record.stop === "function") {
              try { record.stop({ reason: "disable" }); } catch (error) { runtime.recordError({ id, phase: "stop", error: String(error) }); }
            }
            delete runtime.scripts[id];
          }
        })();
        """;
    }

    private static string WrapScript(ScriptDescriptor descriptor, bool force)
    {
        var id = JsonSerializer.Serialize(descriptor.Id);
        var version = JsonSerializer.Serialize(descriptor.Version);
        var fingerprint = JsonSerializer.Serialize(descriptor.Fingerprint);
        var integrity = JsonSerializer.Serialize($"sha256-{descriptor.Fingerprint}");
        var lifecycle = descriptor.LifecycleGlobal is null ? "null" : JsonSerializer.Serialize(descriptor.LifecycleGlobal);
        var permissions = JsonSerializer.Serialize(descriptor.Permissions);
        var manifest = JsonSerializer.Serialize(new
        {
            id = descriptor.Id,
            name = descriptor.Name,
            version = descriptor.Version,
            description = descriptor.Description,
            author = descriptor.Author,
            permissions = descriptor.Permissions,
            scope = descriptor.Scope,
            documentation = descriptor.Documentation,
            settings = descriptor.SettingsMode == "legacy" ? null : new
            {
                mode = descriptor.SettingsMode,
                pageId = descriptor.SettingsPageId,
                title = descriptor.SettingsPageTitle,
            },
        });
        var forceValue = force ? "true" : "false";
        return $$"""
        (() => {
          const runtime = globalThis.__codexScriptLoader || (globalThis.__codexScriptLoader = { scripts: Object.create(null), errors: [] });
          const previous = runtime.scripts[{{id}}];
          if (!{{forceValue}} && previous && previous.fingerprint === {{fingerprint}} && previous.status === "running") return;
          if (previous && typeof previous.stop === "function") {
            try { previous.stop({ reason: "reload" }); } catch (error) { runtime.recordError({ id: {{id}}, phase: "stop", error: String(error) }); }
          }
          const record = { id: {{id}}, version: {{version}}, fingerprint: {{fingerprint}}, integrity: {{integrity}}, status: "loading", stop: null };
          runtime.scripts[{{id}}] = record;
          try {
            const permissionSet = new Set({{permissions}});
            const settingsPrefix = "codex-script-loader:{{descriptor.Id}}:";
            const disposers = [];
            const manifest = Object.freeze({{manifest}});
            const requirePermission = (permission) => { if (!permissionSet.has(permission)) throw new Error(permission + " permission is required"); };
            const storage = Object.freeze({
              get: (key, fallback = null) => { requirePermission("local-storage"); try { const raw = localStorage.getItem(settingsPrefix + String(key)); return raw === null ? fallback : JSON.parse(raw); } catch { return fallback; } },
              set: (key, value) => { requirePermission("local-storage"); localStorage.setItem(settingsPrefix + String(key), JSON.stringify(value)); return value; },
              delete: (key) => { requirePermission("local-storage"); localStorage.removeItem(settingsPrefix + String(key)); }
            });
            const settings = permissionSet.has("settings") ? Object.freeze({
              register: (section) => { const handle = runtime.settingsHost.registerSection({{id}}, manifest, section); disposers.push(() => handle.unregister()); return handle; },
              registerPage: (page) => { const handle = runtime.settingsHost.registerPage({{id}}, manifest, page); disposers.push(() => handle.unregister()); return handle; }
            }) : undefined;
            const api = Object.freeze({
              id: {{id}}, version: {{version}}, manifest, process: "renderer", permissions: Object.freeze([...permissionSet]),
              log: Object.freeze({ info: (...args) => console.info("[{{descriptor.Id}}]", ...args), warn: (...args) => console.warn("[{{descriptor.Id}}]", ...args), error: (...args) => console.error("[{{descriptor.Id}}]", ...args) }),
              storage, settings,
              dom: Object.freeze({
                ready: () => document.readyState === "loading" ? new Promise(resolve => document.addEventListener("DOMContentLoaded", resolve, { once: true })) : Promise.resolve(),
                observe: (target, callback, options = { childList: true, subtree: true }) => { requirePermission("dom"); const observer = new MutationObserver(callback); observer.observe(target, options); disposers.push(() => observer.disconnect()); return () => observer.disconnect(); }
              }),
              events: Object.freeze({ on: (target, type, listener, options) => { target.addEventListener(type, listener, options); const dispose = () => target.removeEventListener(type, listener, options); disposers.push(dispose); return dispose; } })
            });
            const module = { exports: {} };
            runtime.activeApi = api;
            try {
              ((module, exports, api) => {
        {{descriptor.Source}}
        //# sourceURL=codex-script-loader/{{descriptor.Id}}.js
              })(module, module.exports, api);
            } finally { if (runtime.activeApi === api) delete runtime.activeApi; }
            const moduleValue = module.exports;
            let startResult = null;
            if (moduleValue && typeof moduleValue.start === "function") startResult = moduleValue.start(api, { reason: previous ? "reload" : "enable" });
            const exportedStop = moduleValue && typeof moduleValue.stop === "function" ? (context) => moduleValue.stop(context) : typeof startResult === "function" ? startResult : startResult && typeof startResult.stop === "function" ? (context) => startResult.stop(context) : null;
            const lifecycleValue = {{lifecycle}} ? globalThis[{{lifecycle}}] : null;
            const lifecycleStop = !exportedStop && lifecycleValue && typeof lifecycleValue.stop === "function" ? () => { try { lifecycleValue.stop(); } finally { if (globalThis[{{lifecycle}}] === lifecycleValue) delete globalThis[{{lifecycle}}]; } } : null;
            if (exportedStop || lifecycleStop || disposers.length) record.stop = (context = { reason: "cleanup" }) => { try { if (exportedStop) exportedStop(context); else if (lifecycleStop) lifecycleStop(); } finally { for (const dispose of disposers.splice(0).reverse()) { try { dispose(); } catch {} } } };
            record.status = "running";
          } catch (error) {
            record.status = "failed";
            record.error = String(error && (error.stack || error.message) || error);
            if ({{lifecycle}}) {
              const failedLifecycle = globalThis[{{lifecycle}}];
              if (failedLifecycle && typeof failedLifecycle.stop === "function") { try { failedLifecycle.stop({ reason: "failed-start" }); } catch (stopError) { runtime.recordError({ id: {{id}}, phase: "failed-start-stop", error: String(stopError) }); } }
              if (globalThis[{{lifecycle}}] === failedLifecycle) delete globalThis[{{lifecycle}}];
            }
            runtime.recordError({ id: {{id}}, phase: "start", error: record.error });
          }
        })();
        """;
    }

    private const string BootstrapSource = """
    (() => {
      const existing = globalThis.__codexScriptLoader;
      const runtime = existing && typeof existing === "object" ? existing : {};
      runtime.runtimeVersion = "0.5.3";
      runtime.documentId = runtime.documentId || Math.random().toString(36).slice(2);
      runtime.scripts = runtime.scripts || Object.create(null);
      runtime.errors = Array.isArray(runtime.errors) ? runtime.errors.slice(-100) : [];
      runtime.recordError = (entry) => { runtime.errors.push(entry); if (runtime.errors.length > 100) runtime.errors.splice(0, runtime.errors.length - 100); };
      globalThis.__codexScriptLoader = runtime;
    })();
    """;

    private const string SnapshotSource = """
    (() => {
      const scripts = globalThis.__codexScriptLoader?.scripts || {};
      return Object.values(scripts).map((record) => ({ id: String(record?.id || ""), version: String(record?.version || ""), status: new Set(["loading", "running", "failed"]).has(record?.status) ? record.status : "failed" }));
    })()
    """;
}
