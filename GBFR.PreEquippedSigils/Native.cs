using System;
using System.Runtime.InteropServices;

namespace GBFR.PreEquippedSigils;

/// <summary>
/// The handful of kernel32 memory calls the hot apply needs.
///
/// Every call goes through the current process's pseudo-handle: this mod runs
/// inside the game, so "another process" here is only ever ourselves.
///
/// Reads deliberately go through ReadProcessMemory rather than raw pointers.
/// The locator walks the whole address space while the game is live, and a
/// region it reported a moment ago can be freed before the read lands. A raw
/// read then raises an access violation, which .NET does not let you catch -
/// that would take the game down. ReadProcessMemory simply returns false, so
/// a lost race costs one skipped region.
/// </summary>
internal static class Native
{
    public const uint MEM_COMMIT = 0x1000;
    public const uint MEM_PRIVATE = 0x20000;

    public const uint PAGE_NOACCESS = 0x01;
    public const uint PAGE_READWRITE = 0x04;
    public const uint PAGE_EXECUTE_READWRITE = 0x40;
    public const uint PAGE_GUARD = 0x100;

    [StructLayout(LayoutKind.Sequential)]
    public struct MemoryBasicInformation
    {
        public IntPtr BaseAddress;
        public IntPtr AllocationBase;
        public uint AllocationProtect;
        public IntPtr RegionSize;
        public uint State;
        public uint Protect;
        public uint Type;
    }

    /// <summary>
    /// The pseudo-handle (-1) stands for "this process" and never needs closing.
    /// </summary>
    public static IntPtr ProcessHandle { get; } = GetCurrentProcess();

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr GetCurrentProcess();

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern int VirtualQueryEx(IntPtr process, IntPtr address, out MemoryBasicInformation buffer, int length);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool ReadProcessMemory(IntPtr process, IntPtr address, byte[] buffer, IntPtr size, out IntPtr read);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool WriteProcessMemory(IntPtr process, IntPtr address, byte[] buffer, IntPtr size, out IntPtr written);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool VirtualProtectEx(IntPtr process, IntPtr address, IntPtr size, uint newProtect, out uint oldProtect);
}
