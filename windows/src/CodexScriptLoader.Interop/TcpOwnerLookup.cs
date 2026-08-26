using System.ComponentModel;
using System.Net;
using System.Net.Sockets;
using System.Runtime.InteropServices;

namespace CodexScriptLoader.Interop;

public static class TcpOwnerLookup
{
    private const int ErrorInsufficientBuffer = 122;
    private const int AfInet = 2;
    private const int MibTcpStateListen = 2;
    private const int OwnerPidAll = 5;
    private const int RowSize = 24;

    public static IReadOnlyList<TcpOwner> GetIPv4LoopbackListeners(int port)
    {
        ArgumentOutOfRangeException.ThrowIfLessThan(port, 1);
        ArgumentOutOfRangeException.ThrowIfGreaterThan(port, ushort.MaxValue);

        var length = 0;
        var result = GetExtendedTcpTable(IntPtr.Zero, ref length, false, AfInet, OwnerPidAll, 0);
        if (result != ErrorInsufficientBuffer)
        {
            throw new Win32Exception(checked((int)result), "GetExtendedTcpTable size query failed.");
        }

        var table = Marshal.AllocHGlobal(length);
        try
        {
            result = GetExtendedTcpTable(table, ref length, false, AfInet, OwnerPidAll, 0);
            if (result != 0)
            {
                throw new Win32Exception(checked((int)result), "GetExtendedTcpTable failed.");
            }

            var count = Marshal.ReadInt32(table);
            var listeners = new List<TcpOwner>();
            for (var index = 0; index < count; index++)
            {
                var row = IntPtr.Add(table, sizeof(int) + (index * RowSize));
                var state = Marshal.ReadInt32(row);
                var addressValue = unchecked((uint)Marshal.ReadInt32(row, 4));
                var rawPort = unchecked((uint)Marshal.ReadInt32(row, 8));
                var localPort = unchecked((ushort)IPAddress.NetworkToHostOrder(unchecked((short)(rawPort & 0xffff))));
                var processId = Marshal.ReadInt32(row, 20);
                var address = new IPAddress(addressValue);
                if (state == MibTcpStateListen && localPort == port && IPAddress.IsLoopback(address))
                {
                    listeners.Add(new TcpOwner(address.ToString(), localPort, processId));
                }
            }

            return listeners;
        }
        finally
        {
            Marshal.FreeHGlobal(table);
        }
    }

    [DllImport("iphlpapi.dll", SetLastError = true)]
    private static extern uint GetExtendedTcpTable(
        IntPtr tcpTable,
        ref int size,
        [MarshalAs(UnmanagedType.Bool)] bool order,
        int addressFamily,
        int tableClass,
        uint reserved);
}
