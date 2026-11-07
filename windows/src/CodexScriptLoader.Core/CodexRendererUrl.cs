namespace CodexScriptLoader.Core;

public static class CodexRendererUrl
{
    public static bool IsAllowed(string value)
    {
        if (!Uri.TryCreate(value, UriKind.Absolute, out var uri) || uri.Scheme != "app" || uri.Host != "-" ||
            uri.UserInfo.Length != 0 || !uri.IsDefaultPort || uri.Fragment.Length != 0 ||
            uri.AbsolutePath is not ("/index.html" or "/detached-window.html")) return false;
        if (uri.Query.Length == 0) return true;
        if (!uri.Query.StartsWith("?initialRoute=", StringComparison.Ordinal) || uri.Query.Contains('&')) return false;
        var route = Uri.UnescapeDataString(uri.Query[14..]).Replace('+', ' ');
        if (!route.StartsWith('/') || route.StartsWith("//") || route.Contains('\\')) return false;
        var path = route.Split('?', '#')[0];
        return uri.AbsolutePath == "/index.html" ? path == "/" : path == "/detached-window";
    }
}
