namespace CodexScriptLoader.Windows;

internal static class ManagedCodexLifecycleObserver
{
    // Observe the desktop update entry point without changing the installed app.
    internal const string Source = """
    ((client, loadModule) => {
      if (!client?.connected) return;
      let disposed = false;
      let restore = () => {};
      const report = intent => client.request("codex_lifecycle_intent", { intent }).catch(() => {});
      const attach = async () => {
        const url = Array.from(document.querySelectorAll('link[rel="modulepreload"]'))
          .map(link => link.href).find(url => /^app:\/\/-\/assets\/app-shared-[^/]+\.js$/.test(url));
        if (!url) return;
        try {
          const exports = await loadModule(url);
          if (disposed) return;
          const services = Object.values(exports).find(value => value && typeof value === "object" &&
            Object.prototype.hasOwnProperty.call(value, "appUpdates"));
          if (!services) return;
          const original = services.appUpdates;
          const install = original?.installUpdate;
          if (typeof install !== "function") return;
          const wrapped = new Proxy(original, {
            get(target, property) {
              if (property !== "installUpdate") return Reflect.get(target, property);
              return async (...args) => {
                // Let the host acknowledge intent before the native RPC can close this renderer.
                await Promise.race([report("restart"), new Promise(resolve => setTimeout(resolve, 250))]);
                try { return await Reflect.apply(install, original, args); }
                catch (error) { void report("cancel-restart"); throw error; }
              };
            }
          });
          services.appUpdates = wrapped;
          restore = () => { if (services.appUpdates === wrapped) services.appUpdates = original; };
          client.lifecycleObserver = "attached";
        } catch { client.lifecycleObserver = "unavailable"; }
      };
      client.stopLifecycleObserver = () => {
        disposed = true;
        document.removeEventListener("DOMContentLoaded", attach);
        restore();
      };
      if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", attach, { once: true });
      else void attach();
    })(globalThis.__codexScriptLoaderHostBridge, url => import(url));
    """;
}
