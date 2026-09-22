using System.Runtime.InteropServices;

namespace GBFR.SigilLoadout;

internal static unsafe partial class NativeCore
{
    [DllImport(LibraryName, CallingConvention = CallingConvention.Cdecl, ExactSpelling = true)]
    private static extern uint GBFR20_GetAbiVersion();

    [DllImport(LibraryName, CallingConvention = CallingConvention.Cdecl, ExactSpelling = true)]
    private static extern void GBFR20_SetLogCallback(IntPtr callback);

    [DllImport(LibraryName, CallingConvention = CallingConvention.Cdecl, ExactSpelling = true)]
    private static extern int GBFR20_Initialize();

    [DllImport(LibraryName, CallingConvention = CallingConvention.Cdecl, ExactSpelling = true)]
    private static extern void GBFR20_Shutdown();

    [DllImport(LibraryName, CallingConvention = CallingConvention.Cdecl, ExactSpelling = true)]
    private static extern uint GBFR20_CopyRuntimeMessage(sbyte* buffer, uint bufferSize);

    [StructLayout(LayoutKind.Sequential, Pack = 1)]
    internal struct TemplateSlotNative
    {
        public uint GemId;
        public uint Skill1;
        public int Skill1Level;
        public uint Skill2;
        public int Skill2Level;
        public int SigilLevel;
    }

    [StructLayout(LayoutKind.Sequential, Pack = 1)]
    internal struct ExclusiveOverrideNative
    {
        public uint CharacterHash;
        /// <summary>
        /// 被切换的那个技能 hash。它的**身份**就是槽位：原生侧拿它去专属表里认这是
        /// T1、T2 还是战气，所以托管侧不必知道这个映射，也不必读 sigils.chara.json。
        /// </summary>
        public uint SkillHash;
        public byte Disabled;
        // 3 个保留字节把步长补到 4 的倍数（native_api.h 的 static_assert 是 0x0C）。
        public byte Reserved0;
        public byte Reserved1;
        public byte Reserved2;
    }

    [DllImport(LibraryName, CallingConvention = CallingConvention.Cdecl, ExactSpelling = true)]
    private static extern int GBFR20_ApplyLoadout(
        TemplateSlotNative[]? slots,
        uint slotCount,
        ExclusiveOverrideNative[]? overrides,
        uint overrideCount);

    /// <summary>
    /// 把整张编辑后的表交给原生，写进**游戏自己已经解析好的那一份**。那一份的地址由原生从语义
    /// 锚点解析出来（见原生 src/table_slot.cpp），托管侧既不持有地址、也不扫描内存——这就是
    /// "唯一那张表、零扫描"。
    ///
    /// 返回 >= 0 是这次真正改写的 52 字节行数（0 = 内存里已经是一样的）；< 0 是拒绝码，且一个
    /// 字节都没写，原因由原生落一行日志（码的含义与那行日志都在 native_api.h / exports.cpp）。
    /// </summary>
    [DllImport(LibraryName, CallingConvention = CallingConvention.Cdecl, ExactSpelling = true)]
    private static extern int GBFR20_WriteSkillStatusTable(byte* table, uint length);

    internal static int WriteSkillStatusTable(byte[] table)
    {
        fixed (byte* pointer = table)
            return GBFR20_WriteSkillStatusTable(pointer, (uint)table.Length);
    }

    /// <summary>
    /// 托管侧的 ABI 布局自检，与 native_api.h 的 static_assert 一一对应。
    ///
    /// 版本号只挡得住"加载到旧 DLL"，挡不住"两边被同时改错"——而后者才是结构体错位最
    /// 可能发生的方式（native_api.h 一直有 static_assert，C# 这边此前只有版本号）。
    /// 尺寸不符与版本不符同样处理：抛异常 → 整套 hook 不装（fail-closed）。
    ///
    /// 用 Marshal.SizeOf 而不是 sizeof：这里要验证的是**封送器实际会写多少字节**，
    /// 那正是跨过 ABI 的东西。
    /// </summary>
    internal static void EnsureAbiLayout()
    {
        AssertSize("TemplateSlot", 0x18, Marshal.SizeOf<TemplateSlotNative>());
        AssertSize("ExclusiveOverride", 0x0C, Marshal.SizeOf<ExclusiveOverrideNative>());

        // 尺寸挡不住字段互换：TemplateSlot 是六个 32 位字段，gem_id 与 skill1 对调之后
        // 照样是 0x18。而"字段按这个次序对应"才是这份 ABI 的全部内容，所以偏移量也得对拍
        // （native_api.h 那边是同样的字段次序 + #pragma pack(1)）。字段名用 nameof：改名的
        // 时候这里跟着改，不会变成一句"这个字段不存在"的 ArgumentException。
        AssertOffset<TemplateSlotNative>(nameof(TemplateSlotNative.GemId), 0x00);
        AssertOffset<TemplateSlotNative>(nameof(TemplateSlotNative.Skill1), 0x04);
        AssertOffset<TemplateSlotNative>(nameof(TemplateSlotNative.Skill1Level), 0x08);
        AssertOffset<TemplateSlotNative>(nameof(TemplateSlotNative.Skill2), 0x0C);
        AssertOffset<TemplateSlotNative>(nameof(TemplateSlotNative.Skill2Level), 0x10);
        AssertOffset<TemplateSlotNative>(nameof(TemplateSlotNative.SigilLevel), 0x14);
        AssertOffset<ExclusiveOverrideNative>(nameof(ExclusiveOverrideNative.CharacterHash), 0x00);
        AssertOffset<ExclusiveOverrideNative>(nameof(ExclusiveOverrideNative.SkillHash), 0x04);
        AssertOffset<ExclusiveOverrideNative>(nameof(ExclusiveOverrideNative.Disabled), 0x08);
    }

    private static void AssertSize(string name, int expected, int actual)
    {
        if (actual != expected)
            throw new InvalidOperationException(
                $"ABI layout mismatch: {name} marshals as {actual} bytes but native_api.h "
                + $"declares {expected}."
            );
    }

    private static void AssertOffset<T>(string field, int expected)
    {
        int actual = (int)Marshal.OffsetOf<T>(field);
        if (actual != expected)
            throw new InvalidOperationException(
                $"ABI layout mismatch: {typeof(T).Name}.{field} sits at +0x{actual:X} but "
                + $"native_api.h declares +0x{expected:X}."
            );
    }
}
