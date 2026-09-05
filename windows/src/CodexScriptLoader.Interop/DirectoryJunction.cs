using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;

namespace CodexScriptLoader.Interop;

/// <summary>A per-user directory junction; no shell, elevation, or developer mode is required.</summary>
public static class DirectoryJunction
{
    public static void Create(string linkPath, string targetPath)
    {
        var link = Path.GetFullPath(linkPath);
        var target = Path.GetFullPath(targetPath);
        if (target.StartsWith(@"\\", StringComparison.Ordinal)) throw new IOException("Skill junctions require a local target.");
        if (Path.Exists(link) || new DirectoryInfo(link).LinkTarget is not null) throw new IOException("Skill destination already exists.");
        // The caller owns the parent. CreateDirectoryW fails atomically if another writer won.
        if (!CreateDirectory(link, IntPtr.Zero)) throw JunctionError();
        try
        {
            var substitute = Encoding.Unicode.GetBytes(@"\??\" + target);
            var printable = Encoding.Unicode.GetBytes(target);
            var data = new byte[16 + substitute.Length + 2 + printable.Length + 2];
            BitConverter.GetBytes(0xA0000003u).CopyTo(data, 0); // IO_REPARSE_TAG_MOUNT_POINT
            BitConverter.GetBytes(checked((ushort)(data.Length - 8))).CopyTo(data, 4);
            BitConverter.GetBytes(checked((ushort)substitute.Length)).CopyTo(data, 10);
            BitConverter.GetBytes(checked((ushort)(substitute.Length + 2))).CopyTo(data, 12);
            BitConverter.GetBytes(checked((ushort)printable.Length)).CopyTo(data, 14);
            substitute.CopyTo(data, 16);
            printable.CopyTo(data, 18 + substitute.Length);
            using var handle = CreateFile(link, 0x40000000, 7, IntPtr.Zero, 3, 0x02200000, IntPtr.Zero);
            if (handle.IsInvalid || !DeviceIoControl(handle, 0x000900A4, data, data.Length, IntPtr.Zero, 0, out _, IntPtr.Zero))
                throw JunctionError();
        }
        catch
        {
            Directory.Delete(link, recursive: false);
            throw;
        }
    }

    private static IOException JunctionError() => new("Unable to create the managed skill entry on this filesystem.", new Win32Exception(Marshal.GetLastWin32Error()));

    [DllImport("kernel32.dll", EntryPoint = "CreateDirectoryW", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CreateDirectory(string path, IntPtr attributes);
    [DllImport("kernel32.dll", EntryPoint = "CreateFileW", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern SafeFileHandle CreateFile(string name, uint access, uint share, IntPtr attributes, uint creation, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool DeviceIoControl(SafeFileHandle handle, uint code, byte[] input, int inputSize, IntPtr output, int outputSize, out int returned, IntPtr overlapped);
}
