using System.Runtime.InteropServices;

namespace GBFR.SigilLoadout;

internal static unsafe partial class NativeCore {
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
    internal struct TemplateSlotNative {
        public uint GemId;
        public uint Skill1;
        public int Skill1Level;
        public uint Skill2;
        public int Skill2Level;
        public int SigilLevel;
    }

    [StructLayout(LayoutKind.Sequential, Pack = 1)]
    internal struct ExclusiveOverrideNative {
        public uint CharacterHash;
        /// <summary>
        /// 被切换的技能 hash；**身份就是槽位**——原生拿它去专属表里认 T1、T2 还是战气，托管侧
        /// 不必知道这个映射，也不必读 sigils.chara.json。
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
    /// 把整张编辑后的表交给原生，写进**游戏自己已经解析好的那一份**；地址由原生从语义锚点解析出来
    /// （src/table_slot.cpp），托管侧既不持有地址、也不扫内存。
    ///
    /// 返回 >= 0 是真正改写的 52 字节行数（0 = 内存里已经一样）；< 0 是拒绝码，一个字节都没写，原因
    /// 由原生落一行日志（码的含义在 native_api.h / exports.cpp）。
    /// </summary>
    [DllImport(LibraryName, CallingConvention = CallingConvention.Cdecl, ExactSpelling = true)]
    private static extern int GBFR20_WriteSkillStatusTable(byte* table, uint length);

    internal static int WriteSkillStatusTable(byte[] table) {
        fixed (byte* pointer = table)
            return GBFR20_WriteSkillStatusTable(pointer, (uint)table.Length);
    }

    /// <summary>
    /// 托管侧的 ABI 布局自检，与 native_api.h 的 static_assert 一一对应。
    ///
    /// 版本号只挡得住"加载到旧 DLL"，挡不住"两边被同时改错"——而后者才是结构体错位最可能发生的
    /// 方式。尺寸不符与版本不符同样处理：抛异常 → 整套 hook 不装（fail-closed）。用 Marshal.SizeOf
    /// 而不是 sizeof：要验证的是**封送器实际会写多少字节**，那才是跨过 ABI 的东西。
    /// </summary>
    internal static void EnsureAbiLayout() {
        AssertSize("TemplateSlot", 0x18, Marshal.SizeOf<TemplateSlotNative>());
        AssertSize("ExclusiveOverride", 0x0C, Marshal.SizeOf<ExclusiveOverrideNative>());

        // 尺寸挡不住字段互换：六个 32 位字段里 gem_id 与 skill1 对调之后照样是 0x18，而"字段按
        // 这个次序对应"才是这份 ABI 的全部内容，所以偏移量也得对拍（native_api.h 是同样的次序 +
        // #pragma pack(1)）。字段名用 nameof：改名时这里跟着改，不会变成"这个字段不存在"。
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

    private static void AssertSize(string name, int expected, int actual) {
        if (actual != expected)
            throw new InvalidOperationException(
                $"ABI layout mismatch: {name} marshals as {actual} bytes but native_api.h "
                + $"declares {expected}."
            );
    }

    private static void AssertOffset<T>(string field, int expected) {
        int actual = (int)Marshal.OffsetOf<T>(field);
        if (actual != expected)
            throw new InvalidOperationException(
                $"ABI layout mismatch: {typeof(T).Name}.{field} sits at +0x{actual:X} but "
                + $"native_api.h declares +0x{expected:X}."
            );
    }
}
