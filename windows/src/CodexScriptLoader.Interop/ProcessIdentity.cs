using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

namespace CodexScriptLoader.Interop;

public static class ProcessIdentity
{
    private const uint ProcessQueryLimitedInformation = 0x1000;
    private const uint Th32csSnapProcess = 0x00000002;
    private const int AppModelErrorNoPackage = 15700;
    private static readonly IntPtr InvalidHandleValue = new(-1);

    public static string? TryGetPackageFamilyName(int processId)
    {
        var process = OpenProcess(ProcessQueryLimitedInformation, false, checked((uint)processId));
        if (process == IntPtr.Zero)
        {
            return null;
        }

        try
        {
            uint length = 0;
            var result = GetPackageFamilyName(process, ref length, null);
            if (result == AppModelErrorNoPackage)
            {
                return null;
            }

            if (result != 122)
            {
                return null;
            }

            var builder = new StringBuilder(checked((int)length));
            result = GetPackageFamilyName(process, ref length, builder);
            return result == 0 ? builder.ToString() : null;
        }
        finally
        {
            CloseHandle(process);
        }
    }

    public static IReadOnlyList<int> FindProcessesByPackageFamily(string packageFamilyName)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(packageFamilyName);
        var snapshot = CreateToolhelp32Snapshot(Th32csSnapProcess, 0);
        if (snapshot == InvalidHandleValue)
        {
            throw new Win32Exception(Marshal.GetLastWin32Error(), "Process snapshot failed.");
        }

        try
        {
            var entry = new ProcessEntry32 { Size = checked((uint)Marshal.SizeOf<ProcessEntry32>()) };
            var results = new List<int>();
            if (!Process32First(snapshot, ref entry))
            {
                return results;
            }

            do
            {
                var processId = checked((int)entry.ProcessId);
                if (string.Equals(TryGetPackageFamilyName(processId), packageFamilyName, StringComparison.OrdinalIgnoreCase))
                {
                    results.Add(processId);
                }

                entry.Size = checked((uint)Marshal.SizeOf<ProcessEntry32>());
            }
            while (Process32Next(snapshot, ref entry));

            return results;
        }
        finally
        {
            CloseHandle(snapshot);
        }
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct ProcessEntry32
    {
        public uint Size;
        public uint Usage;
        public uint ProcessId;
        public IntPtr DefaultHeapId;
        public uint ModuleId;
        public uint Threads;
        public uint ParentProcessId;
        public int PriorityClassBase;
        public uint Flags;

        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)]
        public string ExecutableFile;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr OpenProcess(uint access, bool inheritHandle, uint processId);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetPackageFamilyName(IntPtr process, ref uint packageFamilyNameLength, StringBuilder? packageFamilyName);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint processId);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool Process32First(IntPtr snapshot, ref ProcessEntry32 processEntry);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool Process32Next(IntPtr snapshot, ref ProcessEntry32 processEntry);

    [DllImport("kernel32.dll")]
    private static extern bool CloseHandle(IntPtr handle);
}
