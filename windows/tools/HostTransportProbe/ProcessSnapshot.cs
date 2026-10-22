using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using Microsoft.Win32.SafeHandles;

namespace CodexScriptLoader.HostTransportProbe;

internal sealed record ProcessSnapshot(int ParentId, string[] Arguments, Dictionary<string, string?> Environment)
{
    // Only the reviewed x64 layout is used; this diagnostic never writes process memory.
    internal static ProcessSnapshot Read(int pid, IReadOnlyList<string> keys)
    {
        if (RuntimeInformation.ProcessArchitecture != Architecture.X64) throw new PlatformNotSupportedException("The probe requires x64.");
        using var handle = OpenProcess(0x1010, false, pid);
        if (handle.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error());
        if (!IsWow64Process(handle, out var wow64) || wow64) throw new PlatformNotSupportedException("The target must be a native x64 process.");
        var status = NtQueryInformationProcess(handle, 0, out var basic, Marshal.SizeOf<BasicInformation>(), out _);
        if (status != 0) throw new InvalidOperationException($"Process information failed: {status:X8}");
        var parameters = ReadPointer(handle, basic.Peb + 0x20);
        var command = ReadBytes(handle, parameters + 0x70, 16);
        var commandBytes = ReadBytes(handle, new IntPtr(BitConverter.ToInt64(command, 8)), BitConverter.ToUInt16(command));
        string[] arguments;
        try { arguments = SplitCommandLine(Encoding.Unicode.GetString(commandBytes)); }
        finally { CryptographicOperations.ZeroMemory(commandBytes); }
        var environment = ReadEnvironment(handle, ReadPointer(handle, parameters + 0x80), keys);
        return new(checked((int)basic.ParentId), arguments, environment);
    }

    private static Dictionary<string, string?> ReadEnvironment(SafeProcessHandle handle, IntPtr address, IReadOnlyList<string> keys)
    {
        var result = keys.ToDictionary(key => key, _ => (string?)null, StringComparer.OrdinalIgnoreCase);
        var line = new StringBuilder();
        for (var total = 0; total < 1024 * 1024;)
        {
            var length = 4096 - (int)((address.ToInt64() + total) % 4096);
            var bytes = ReadBytes(handle, address + total, length);
            total += length;
            try
            {
                for (var index = 0; index < bytes.Length; index += 2)
                {
                    var character = (char)BitConverter.ToUInt16(bytes, index);
                    if (character != '\0') { line.Append(character); continue; }
                    if (line.Length == 0) return result;
                    var separator = -1;
                    for (var i = 0; i < line.Length; i++) if (line[i] == '=') { separator = i; break; }
                    if (separator > 0 && result.ContainsKey(line.ToString(0, separator)))
                        result[line.ToString(0, separator)] = line.ToString(separator + 1, line.Length - separator - 1);
                    line.Clear();
                }
            }
            finally { CryptographicOperations.ZeroMemory(bytes); }
        }
        throw new InvalidOperationException("Environment block is too large or unterminated.");
    }

    internal static string[] SplitCommandLine(string text)
    {
        var values = CommandLineToArgvW(text, out var count);
        if (values == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
        try { return Enumerable.Range(0, count).Select(i => Marshal.PtrToStringUni(Marshal.ReadIntPtr(values, i * IntPtr.Size))!).ToArray(); }
        finally { LocalFree(values); }
    }

    internal static string PackageFullName(int pid)
    {
        using var process = OpenProcess(0x1000, false, pid);
        if (process.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error());
        uint length = 0;
        if (GetPackageFullName(process, ref length, null) != 122) throw new InvalidOperationException("Target has no package identity.");
        var value = new StringBuilder(checked((int)length));
        var error = GetPackageFullName(process, ref length, value);
        if (error != 0) throw new Win32Exception(error);
        return value.ToString();
    }

    private static IntPtr ReadPointer(SafeProcessHandle handle, IntPtr address) => new(BitConverter.ToInt64(ReadBytes(handle, address, 8)));
    private static byte[] ReadBytes(SafeProcessHandle handle, IntPtr address, int length)
    {
        var bytes = new byte[length];
        if (!ReadProcessMemory(handle, address, bytes, length, out var read) || read.ToInt64() != length)
            throw new Win32Exception(Marshal.GetLastWin32Error(), "Unable to read the selected process.");
        return bytes;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct BasicInformation { internal IntPtr ExitStatus, Peb, Affinity, Priority, ProcessId, ParentId; }
    [DllImport("kernel32.dll", SetLastError = true)] private static extern SafeProcessHandle OpenProcess(uint access, bool inherit, int pid);
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool ReadProcessMemory(SafeProcessHandle process, IntPtr address, byte[] buffer, int size, out IntPtr read);
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool IsWow64Process(SafeProcessHandle process, [MarshalAs(UnmanagedType.Bool)] out bool wow64);
    [DllImport("ntdll.dll")] private static extern int NtQueryInformationProcess(SafeProcessHandle process, int type, out BasicInformation info, int size, out int length);
    [DllImport("shell32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern IntPtr CommandLineToArgvW(string commandLine, out int count);
    [DllImport("kernel32.dll")] private static extern IntPtr LocalFree(IntPtr memory);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] private static extern int GetPackageFullName(SafeProcessHandle process, ref uint length, StringBuilder? value);
}
