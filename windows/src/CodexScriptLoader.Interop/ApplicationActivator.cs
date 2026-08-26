using System.Runtime.InteropServices;

namespace CodexScriptLoader.Interop;

[Flags]
public enum ActivateOptions
{
    None = 0,
    DesignMode = 0x1,
    NoErrorUi = 0x2,
    NoSplashScreen = 0x4,
}

public static class ApplicationActivator
{
    private static readonly Guid ActivationManagerClassId = new("45BA127D-10A8-46EA-8AB7-56EA9078943C");

    public static int Activate(CodexPackageIdentity package, IReadOnlyList<string> arguments)
    {
        ArgumentNullException.ThrowIfNull(package);
        ArgumentNullException.ThrowIfNull(arguments);
        if (arguments.Any(argument => argument is null || argument.IndexOfAny(['\0', '\r', '\n']) >= 0))
        {
            throw new ArgumentException("Activation arguments contain invalid control characters.", nameof(arguments));
        }

        var type = Type.GetTypeFromCLSID(ActivationManagerClassId, throwOnError: true)
            ?? throw new InvalidOperationException("Application Activation Manager is unavailable.");
        var instance = Activator.CreateInstance(type)
            ?? throw new InvalidOperationException("Application Activation Manager could not be created.");
        try
        {
            var manager = (IApplicationActivationManager)instance;
            _ = CoAllowSetForegroundWindow(instance, IntPtr.Zero);
            var commandLine = string.Join(' ', arguments.Select(QuoteArgument));
            var hresult = manager.ActivateApplication(
                package.AppUserModelId,
                commandLine,
                ActivateOptions.NoErrorUi,
                out var processId);
            Marshal.ThrowExceptionForHR(hresult);
            if (processId == 0)
            {
                throw new InvalidOperationException("Application activation returned an invalid process id.");
            }

            return checked((int)processId);
        }
        finally
        {
            if (Marshal.IsComObject(instance))
            {
                _ = Marshal.FinalReleaseComObject(instance);
            }
        }
    }

    private static string QuoteArgument(string value)
    {
        if (value.Length > 0 && value.All(character => !char.IsWhiteSpace(character) && character != '"'))
        {
            return value;
        }

        return $"\"{value.Replace("\\", "\\\\", StringComparison.Ordinal).Replace("\"", "\\\"", StringComparison.Ordinal)}\"";
    }

    [DllImport("ole32.dll")]
    private static extern int CoAllowSetForegroundWindow([MarshalAs(UnmanagedType.IUnknown)] object unknown, IntPtr reserved);

    [ComImport]
    [Guid("2E941141-7F97-4756-BA1D-9DECDE894A3D")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IApplicationActivationManager
    {
        [PreserveSig]
        int ActivateApplication(
            [MarshalAs(UnmanagedType.LPWStr)] string appUserModelId,
            [MarshalAs(UnmanagedType.LPWStr)] string arguments,
            ActivateOptions options,
            out uint processId);

        [PreserveSig]
        int ActivateForFile(IntPtr appUserModelId, IntPtr itemArray, IntPtr verb, out uint processId);

        [PreserveSig]
        int ActivateForProtocol(IntPtr appUserModelId, IntPtr itemArray, out uint processId);
    }
}
