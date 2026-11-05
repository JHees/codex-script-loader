namespace CodexScriptLoader.Windows;

internal static class ManagedCodexLifecycleObserver
{
    internal const string Source = """
    ((client, loadModule) => {
      if (!client?.connected) return;
      let disposed = false, timer, attempts = 0, services, original, wrapped, serviceExports, pending;
      const restore = () => { if (services && services.appUpdates === wrapped) services.appUpdates = original; };
      const attach = async () => {
        try {
          if (wrapped && serviceExports?.appServices === services && services.appUpdates === wrapped) return;
          const urls = Array.from(document.querySelectorAll('script[type="module"][src]'))
            .map(script => script.src).filter(url => /^app:\/\/-\/assets\/[^/?]+\.js$/.test(url));
          for (const url of urls) {
            const runtime = (await loadModule(url)).__webpack_require__;
            if (disposed) return;
            if (typeof runtime !== "function" || !runtime.c) continue;
            for (const entry of Object.values(runtime.c)) {
              const next = entry?.exports?.appServices;
              if (!next?.appUpdates || typeof next.appUpdates.installUpdate !== "function") continue;
              restore();
              serviceExports = entry.exports;
              services = next;
              original = services.appUpdates;
              const target = original;
              const install = target.installUpdate;
              const update = async args => {
                try {
                  const result = await client.request("codex_lifecycle_intent", {intent: "restart"});
                  if (!result?.restartRegistrationVerified) throw new Error("Restart registration was not verified.");
                } catch (error) {
                  globalThis.alert?.("Loader 未能确认更新后的连接参数，本次尚未开始更新。请重试或查看 Loader 诊断。\nLoader could not verify restart arguments. The update has not started.");
                  throw error;
                }
                try { return await Reflect.apply(install, target, args); }
                catch (error) {
                  void client.request("codex_lifecycle_intent", {intent: "cancel-restart"}).catch(() => {});
                  throw error;
                }
              };
              const methods = new Map();
              wrapped = new Proxy(target, {
                get(object, key) {
                  if (key !== "installUpdate") {
                    const value = Reflect.get(object, key, object);
                    if (typeof value !== "function") return value;
                    if (!methods.has(value)) methods.set(value, value.bind(object));
                    return methods.get(value);
                  }
                  return (...args) => pending ??= update(args).finally(() => { pending = null; });
                }
              });
              services.appUpdates = wrapped;
              client.lifecycleObserver = "attached";
              void client.request("codex_lifecycle_observer_status", {state: "attached"}).catch(() => {});
              return;
            }
          }
        } catch (error) { client.lifecycleObserverError = String(error?.message ?? error); }
        if (++attempts === 30) {
          client.lifecycleObserver = "unavailable";
          void client.request("codex_lifecycle_observer_status", {state: "unavailable"}).catch(() => {});
        }
      };
      const tick = async () => { await attach(); if (!disposed) timer = setTimeout(tick, 1000); };
      client.stopLifecycleObserver = () => { disposed = true; clearTimeout(timer); restore(); };
      void tick();
    })(globalThis.__codexScriptLoaderHostBridge, url => import(url));
    """;
}
