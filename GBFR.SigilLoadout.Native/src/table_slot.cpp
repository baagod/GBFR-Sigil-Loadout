#include "../native_internal.h"

#include <format>

namespace gbfr::native {
namespace {
// **不要再加"全内存扫描"兜底**：它证明不了唯一重要的事——"这块缓冲区就是游戏在用的那块"
// 静态证不出来；而拒写的代价只是这一局内存不变（编辑在游戏下一次解析或重启后照样生效），
// 扫描却是 5~6 秒的慢路径。
//
// 定位分两步，靠语义而不是靠地址常量。这个文件覆盖**两张**活表：
//   * skill_status（因子技能）：8 字节头 + 52 字节行，有发布指令（槽首那条）可交叉验证；
//   * limit_bonus_param（能力强化数值）：8 字节头 + 84 字节行，**没有**那条发布指令，
//     身份改由运行期的"Key 在整张表里恰好一次"承担（见 SetLimitBonusLevels）。
//
// 第一步，行循环锚点：skill_status 那张表按"8 字节行数头 + 52 字节行"读出来，行尾 = rows + rowCount*52：
//   48 6B FE 34        imul rdi, rsi, 0x34        ; end = count*52
//   48 01 DF           add  rdi, rbx              ; + rows
//   C4 41 38 57 C0     vxorps xmm8, xmm8, xmm8
// 这 12 字节里没有 rel32、没有 rip 位移，所以它是纯语义锚点：换版本只要这张表还是
// 52 字节行，这段指令序列就还在。
inline constexpr std::array<uint8_t, 12> kRowLoopSetup = {
    0x48, 0x6B, 0xFE, 0x34, 0x48, 0x01, 0xDF, 0xC4, 0x41, 0x38, 0x57, 0xC0};

// 第二步，锚点前 0x800 字节窗口里必须各恰好出现一次的两条发布指令（两张活表共用这段
// 模式：缓冲区指针加载两张都有，槽发布只有 skill_status 有）。两条的 rip 位移都是
// 通配（0 = 通配），解出来的目标才是地址：
//   48 8B 1D disp32    mov  rbx, [rip+disp32]    ; 缓冲区指针字段（槽 +8）
//   48 8B 33           mov  rsi, [rbx]           ; rowCount
//   48 83 C3 08        add  rbx, 8               ; 首行
inline constexpr std::array<uint8_t, 14> kBufferPointerLoad = {
    0x48, 0x8B, 0x1D, 0, 0, 0, 0, 0x48, 0x8B, 0x33, 0x48, 0x83, 0xC3, 0x08};
//   48 89 0D disp32    mov     [rip+disp32], rcx  ; 槽首（24 字节槽）
//   C5 F8 10 45 F0     vmovups xmm0, [rbp-0x10]  ; 刚从文件解析出的表头
//   C5 F8 11 05 disp32 vmovups [rip+disp32], xmm0; 槽 +8：缓冲区指针
inline constexpr std::array<uint8_t, 20> kSlotBaseStore = {
    0x48, 0x89, 0x0D, 0, 0, 0, 0,
    0xC5, 0xF8, 0x10, 0x45, 0xF0,
    0xC5, 0xF8, 0x11, 0x05, 0, 0, 0, 0};

// 为什么锚点要配一个窗口：这两条发布指令同一个函数里每一张表都有一份，只有落在行循环锚点
// 前面的那一对属于 skill_status。窗口取 0x800：对真实距离有充裕余量，又刚好把隔壁那张表
// 挡出去。
inline constexpr size_t kAnchorWindowBytes = 0x800;

// skill_status.tbl 的文件头大小与行步长必须与托管侧解析同一份归档的实现一致
//（见 GBFR.SigilLoadout/SigilEditorFeature.cs）。
inline constexpr uint64_t kTableHeaderBytes = 8;
inline constexpr uint64_t kTableRowBytes = 52;
// 行里 Key 的位置（相对行首）：编辑只碰 LevelValue1..10 与 Level，从不碰 Key，
// 所以 Key 序列是这张表的**身份**，可以逐行比对且与编辑无关。
inline constexpr uint64_t kRowKeyOffset = 40;

// 解析成功后要记住的全部东西：槽首的 RVA（0 = 还没解析出来）。缓冲区指针字段就是槽 +8，
// 不必另存一份；单写者、读者只 load，所以一个原子量就够，不需要锁。
std::atomic_uintptr_t g_slot_rva{0};

// 取到返回 0，否则返回 native_api.h 里的拒绝码（负数）。
//
// 每次问都重新读指针，不缓存地址——游戏换掉那份表（重新解析、发布新缓冲区）时下一个
// 调用就跟上了，所以这里不存在"缓存失效"这个概念。
int32_t TryGetLiveTableBuffer(uintptr_t& buffer) noexcept {
    const uintptr_t slot_rva = g_slot_rva.load(std::memory_order_acquire);
    if (slot_rva == 0)
        return GBFR20_TABLE_SLOT_UNRESOLVED;
    const uintptr_t pointer_address = g_image_base + slot_rva + 8;
    if (!IsGameRange(pointer_address, sizeof(uintptr_t), kReadableProtect))
        return GBFR20_TABLE_BUFFER_UNREADABLE;
    uint64_t pointer = 0;
    if (!SafeReadUint64(pointer_address, pointer) || pointer == 0)
        return GBFR20_TABLE_BUFFER_UNREADABLE;
    buffer = static_cast<uintptr_t>(pointer);
    return 0;
}

/*
    这里扫字节用的是"0 = 通配"这一套约定（另一套是显式 mask 字符串，见 layout_resolver.cpp）。

    这个约定的成立有个**前提**：pattern 里每个 0 字节都必须落在"该通配"的位置上。它不是自动成立
    的——加新 pattern 时若有一个 0 是想精确匹配的 0，匹配会静默变宽，而变宽的后果是"命中数 != 1"，
    于是 fail-closed（游戏照常启动、hook 不装、只有日志说得出原因）。所以改这三条 pattern 时
    **逐个数字对一遍**，别只改个数。
*/
template <size_t Size>
size_t CountMatches(
    const uint8_t* base,
    size_t size,
    const std::array<uint8_t, Size>& pattern,
    uintptr_t base_rva,
    uintptr_t& first_rva) noexcept {
    size_t matches = 0;
    for (size_t offset = 0; offset + Size <= size; ++offset) {
        bool matched = true;
        for (size_t index = 0; index < Size; ++index) {
            const uint8_t expected = pattern[index];
            if (expected != 0 && base[offset + index] != expected) {
                matched = false;
                break;
            }
        }
        if (!matched)
            continue;
        if (matches == 0)
            first_rva = base_rva + offset;
        ++matches;
    }
    return matches;
}

struct AnchorSearch {
    size_t row_loop_matches = 0;
    uintptr_t row_loop_rva = 0;
    size_t buffer_load_matches = 0;
    uintptr_t buffer_load_rva = 0;
    size_t slot_store_matches = 0;
    uintptr_t slot_store_rva = 0;
    // 实际扫过的窗口宽度：失败日志要报它而不是那个常量，否则锚点靠段首时会报一个从没扫过的
    // 宽度，排查时会被引到错的方向。
    size_t window_bytes = 0;
};

// .text 扫描单独一个函数：它必须待在 SEH 帧里，而 SEH 帧不能和"需要栈展开的对象"同处
// 一个函数（MSVC C2712），所以构造消息、拼字符串那些都留在调用方。三个计数各自都要恰好
// 1，任何一处不是 1 都由调用方 fail closed。
// 行循环锚点的形状由调用方给（两张表的行步长不同）；窗口里那两条发布指令是共享模式，
// 所以在这里一律数出来——要不要拿哪一条当门，由调用方决定。
template <size_t RowLoopSize>
AnchorSearch SearchAnchorWindow(
    uintptr_t code_rva,
    size_t code_size,
    const std::array<uint8_t, RowLoopSize>& row_loop_pattern) noexcept {
    AnchorSearch result{};
    __try {
        const uint8_t* code = reinterpret_cast<const uint8_t*>(g_image_base + code_rva);
        result.row_loop_matches =
            CountMatches(code, code_size, row_loop_pattern, code_rva, result.row_loop_rva);
        if (result.row_loop_matches != 1)
            return result;

        const size_t offset_of_anchor = static_cast<size_t>(result.row_loop_rva - code_rva);
        const size_t window_size = std::min(kAnchorWindowBytes, offset_of_anchor);
        if (window_size < kSlotBaseStore.size())
            return result;
        result.window_bytes = window_size;
        const uintptr_t window_rva = result.row_loop_rva - window_size;
        const uint8_t* window = code + (window_rva - code_rva);
        result.buffer_load_matches = CountMatches(
            window, window_size, kBufferPointerLoad, window_rva, result.buffer_load_rva);
        result.slot_store_matches = CountMatches(
            window, window_size, kSlotBaseStore, window_rva, result.slot_store_rva);
    }
    __except (EXCEPTION_EXECUTE_HANDLER) {
        return AnchorSearch{};
    }
    return result;
}

// 逐行 Key 比对：这一关既是"确实是同一张表"的实证，又不会随编辑变化——每次应用都过得去。
// 另开一个函数：SEH 帧里只许有平凡类型，而且不能和"要栈展开的对象"同处一个函数。
bool SameRowIdentity(const uint8_t* live, const uint8_t* table, uint64_t row_count) noexcept {
    __try {
        for (uint64_t row = 0; row < row_count; ++row) {
            const size_t offset =
                static_cast<size_t>(kTableHeaderBytes + kTableRowBytes * row + kRowKeyOffset);
            if (std::memcmp(live + offset, table + offset, sizeof(uint32_t)) != 0)
                return false;
        }
    }
    __except (EXCEPTION_EXECUTE_HANDLER) {
        return false;
    }
    return true;
}

// 逐行写：只碰真的变了的那几行，游戏任何时刻撞上"半更新的一行"的窗口就小得多。
int32_t WriteChangedRows(uint8_t* live, const uint8_t* table, uint64_t row_count) noexcept {
    int32_t written = 0;
    __try {
        for (uint64_t row = 0; row < row_count; ++row) {
            const size_t offset = static_cast<size_t>(kTableHeaderBytes + kTableRowBytes * row);
            if (std::memcmp(live + offset, table + offset, kTableRowBytes) == 0)
                continue;
            std::memcpy(live + offset, table + offset, kTableRowBytes);
            ++written;
        }
    }
    __except (EXCEPTION_EXECUTE_HANDLER) {
        return GBFR20_TABLE_WRITE_FAILED;
    }
    return written;
}

// ---------------------------------------------------------------------------
// 第二张活表：limit_bonus_param（能力强化数值）
// ---------------------------------------------------------------------------
// 行循环锚点：这张表按"8 字节行数头 + 84 字节行"读出来，行尾 = rows + rowCount*84：
//   4C 6B F6 54     imul r14, rsi, 0x54       ; end = count*84
//   49 01 DE        add  r14, rbx             ; + rows
// 这 7 字节里同样没有 rel32、没有 rip 位移；实测在全 .text 里只出现一次。
inline constexpr std::array<uint8_t, 7> kLimitBonusRowLoopSetup = {
    0x4C, 0x6B, 0xF6, 0x54, 0x49, 0x01, 0xDE};

inline constexpr uint64_t kLimitBonusHeaderBytes = 8;
inline constexpr uint64_t kLimitBonusRowBytes = 84;
// 行里 Key 的位置（相对行首）。写的是 Lv 值、从不碰 Key，所以 Key 是这张表的身份。
inline constexpr uint64_t kLimitBonusKeyOffset = 52;
// Lv1..Lv10 是行内 +12 起的 10 个 float；调用方按"这个能力强化有几档"给前 N 个。
inline constexpr uint64_t kLimitBonusLevelOffset = 12;
inline constexpr uint64_t kLimitBonusMaxLevels = 10;
// 行数的合理上界，用来挡"指针字段被别的东西改写、指到一段随便可读的内存"。真机 1123 行，
// 1<<20 是充裕余量，又足以让"指到别处"几乎撞不进来。
inline constexpr uint64_t kLimitBonusMaxPlausibleRows = 1u << 20;

// 解析成功后记住**指针字段**（槽 +8）的 RVA（0 = 还没解析出来）。这张表不另存槽首：它没有
// skill_status 那条发布指令可以交叉验证"槽首 = 指针字段 - 8"，身份改由运行期的 Key 唯一性承担。
std::atomic_uintptr_t g_limit_bonus_pointer_rva{0};

// 取到返回 0，否则返回 native_api.h 里的拒绝码（负数）。每次问都重新读指针，理由同 skill_status。
int32_t TryGetLiveLimitBonusBuffer(uintptr_t& buffer) noexcept {
    const uintptr_t pointer_rva = g_limit_bonus_pointer_rva.load(std::memory_order_acquire);
    if (pointer_rva == 0)
        return GBFR20_TABLE_SLOT_UNRESOLVED;
    const uintptr_t pointer_address = g_image_base + pointer_rva;
    if (!IsGameRange(pointer_address, sizeof(uintptr_t), kReadableProtect))
        return GBFR20_TABLE_BUFFER_UNREADABLE;
    uint64_t pointer = 0;
    if (!SafeReadUint64(pointer_address, pointer) || pointer == 0)
        return GBFR20_TABLE_BUFFER_UNREADABLE;
    buffer = static_cast<uintptr_t>(pointer);
    return 0;
}

// 逐行找 Key、只写那一行的前 level_count 个 Lv 槽。SEH 帧里只许有平凡类型，所以它单独一个函数。
int32_t WriteLimitBonusRow(
    uintptr_t buffer,
    uint64_t row_count,
    uint32_t key_hash,
    const float* levels,
    uint32_t level_count) noexcept {
    __try {
        auto* live = reinterpret_cast<uint8_t*>(buffer);
        uint8_t* target = nullptr;
        for (uint64_t row = 0; row < row_count; ++row) {
            uint8_t* candidate = live + kLimitBonusHeaderBytes + kLimitBonusRowBytes * row;
            uint32_t key = 0;
            std::memcpy(&key, candidate + kLimitBonusKeyOffset, sizeof(key));
            if (key != key_hash)
                continue;
            // 同一个 Key 出现两次就不是这张表（Key 是行的身份）。发现重复立刻拒写，而不是覆盖
            // 第一个——那会把"指错了一段内存"变成一次静默的半成功。
            if (target != nullptr)
                return GBFR20_LIMIT_BONUS_KEY_NOT_UNIQUE;
            target = candidate;
        }
        if (target == nullptr)
            return GBFR20_LIMIT_BONUS_KEY_NOT_FOUND;

        const size_t bytes = static_cast<size_t>(level_count) * sizeof(float);
        if (std::memcmp(target + kLimitBonusLevelOffset, levels, bytes) == 0)
            return 0;
        std::memcpy(target + kLimitBonusLevelOffset, levels, bytes);
    }
    __except (EXCEPTION_EXECUTE_HANDLER) {
        return GBFR20_TABLE_WRITE_FAILED;
    }
    return 1;
}
}

void ResolveTableSlot() {
    if (g_slot_rva.load(std::memory_order_acquire) != 0 || g_image_base == 0)
        return;

    CodeSectionView code{};
    if (!TryGetCodeSection(code)) {
        Log("Table slot: the game image's code section could not be resolved; nothing resolved.");
        return;
    }

    const AnchorSearch anchor =
        SearchAnchorWindow(code.rva, code.size, kRowLoopSetup);
    if (anchor.row_loop_matches != 1 || anchor.buffer_load_matches != 1 ||
         anchor.slot_store_matches != 1) {
        Log(std::format(
            "Table slot: in the code section the skill_status anchor matches are row_loop={}, "
            "buffer_load={}, slot_store={} (window {} bytes before the anchor); expected exactly one "
            "of each. This game build is not the one the mod was written for; no slot was resolved.",
            anchor.row_loop_matches,
            anchor.buffer_load_matches,
            anchor.slot_store_matches,
            anchor.window_bytes));
        return;
    }

    // 两处 RIP 相对位移都解出来再验：槽首那条 mov [rip+d],rcx 与缓冲区指针那条 mov rbx,[rip+d]
    // 必须正好差 8（槽是 handle@+0 / buffer@+8 / ?@+0x10 三档）。两条锚点都是 `mov r,[rip+d]` /
    // `mov [rip+d],r`：位移都在指令 +3，指令都长 7 字节；解不出这一对就不认。
    uintptr_t slot_rva = 0;
    uintptr_t buffer_pointer_rva = 0;
    if (!DecodeRipTarget(
             g_image_base, code.image_size, anchor.slot_store_rva, 3, 7, slot_rva) ||
         !DecodeRipTarget(
             g_image_base, code.image_size, anchor.buffer_load_rva, 3, 7, buffer_pointer_rva) ||
         buffer_pointer_rva != slot_rva + 8) {
        Log("Table slot: the publish anchors' displacements do not decode to a slot and its +8 "
             "pointer field; nothing resolved.");
        return;
    }
    if (!IsInWritableImageSection(slot_rva, 24) ||
         !IsInWritableImageSection(buffer_pointer_rva, sizeof(uintptr_t))) {
        Log("Table slot: the decoded slot does not lie in a writable image section; nothing "
             "resolved.");
        return;
    }

    g_slot_rva.store(slot_rva, std::memory_order_release);
    Log(std::format("Table slot: resolved slot=0x{:X}.", slot_rva));
}

int32_t WriteSkillStatusTable(const uint8_t* table, size_t length) noexcept {
    // 表的形状由**调用方**给的那张表定义（它来自归档，是权威），原生只检查游戏那份与它一致。
    if (table == nullptr || length <= kTableHeaderBytes ||
         (length - kTableHeaderBytes) % kTableRowBytes != 0)
        return GBFR20_TABLE_LENGTH_UNEXPECTED;
    const uint64_t supplied_rows = (length - kTableHeaderBytes) / kTableRowBytes;

    uintptr_t buffer = 0;
    const int32_t refusal = TryGetLiveTableBuffer(buffer);
    if (refusal != 0)
        return refusal;

    // 三道闸全在写之前：任何一条不成立都是一个字节都不写。
    if (!IsGameRange(buffer, length, kWritableProtect))
        return GBFR20_TABLE_BUFFER_UNREADABLE;

    uint64_t row_count = 0;
    if (!SafeReadUint64(buffer, row_count) || row_count != supplied_rows)
        return GBFR20_TABLE_ROW_COUNT_INCONSISTENT;

    auto* live = reinterpret_cast<uint8_t*>(buffer);
    if (!SameRowIdentity(live, table, row_count))
        return GBFR20_TABLE_IDENTITY_MISMATCH;

    return WriteChangedRows(live, table, row_count);
}

void ResolveLimitBonusParamPointer() {
    if (g_limit_bonus_pointer_rva.load(std::memory_order_acquire) != 0 || g_image_base == 0)
        return;

    CodeSectionView code{};
    if (!TryGetCodeSection(code)) {
        Log("Limit bonus table: the game image's code section could not be resolved; nothing "
             "resolved.");
        return;
    }

    const AnchorSearch anchor =
        SearchAnchorWindow(code.rva, code.size, kLimitBonusRowLoopSetup);
    // 只要求这两条各恰好一次。槽发布那条**不**参与：这张表的发布指令与 skill_status 的形状
    // 不同，实测在这个窗口里 0 命中，拿它当门等于永远拒写。
    if (anchor.row_loop_matches != 1 || anchor.buffer_load_matches != 1) {
        Log(std::format(
            "Limit bonus table: the row-loop anchor matches are row_loop={}, buffer_load={} "
            "(window {} bytes before the anchor), slot_store={} (deliberately not required); "
            "expected exactly one of the first two. This game build is not the one the mod was "
            "written for; no pointer field was resolved.",
            anchor.row_loop_matches,
            anchor.buffer_load_matches,
            anchor.window_bytes,
            anchor.slot_store_matches));
        return;
    }

    uintptr_t pointer_rva = 0;
    if (!DecodeRipTarget(
            g_image_base, code.image_size, anchor.buffer_load_rva, 3, 7, pointer_rva)) {
        Log("Limit bonus table: the buffer-load anchor's displacement does not decode to a pointer "
             "field; nothing resolved.");
        return;
    }
    if (!IsInWritableImageSection(pointer_rva, sizeof(uintptr_t))) {
        Log("Limit bonus table: the decoded pointer field does not lie in a writable image "
             "section; nothing resolved.");
        return;
    }

    g_limit_bonus_pointer_rva.store(pointer_rva, std::memory_order_release);
    Log(std::format("Limit bonus table: resolved pointer field=0x{:X}.", pointer_rva));
}

int32_t SetLimitBonusLevels(
    uint32_t key_hash,
    const float* levels,
    uint32_t level_count) noexcept {
    if (levels == nullptr || level_count == 0 || level_count > kLimitBonusMaxLevels)
        return GBFR20_LIMIT_BONUS_LEVEL_COUNT_UNEXPECTED;

    uintptr_t buffer = 0;
    const int32_t refusal = TryGetLiveLimitBonusBuffer(buffer);
    if (refusal != 0)
        return refusal;

    // 三道门全在写之前：行数落在合理区间（后面按它算长度才有意义）→ 整段（头 + 全部行）可写
    // → 目标 Key 在整张表里恰好一次。
    uint64_t row_count = 0;
    if (!SafeReadUint64(buffer, row_count) || row_count == 0 ||
        row_count > kLimitBonusMaxPlausibleRows) {
        return GBFR20_LIMIT_BONUS_ROW_COUNT_IMPLAUSIBLE;
    }
    const uint64_t length = kLimitBonusHeaderBytes + kLimitBonusRowBytes * row_count;
    if (!IsGameRange(buffer, static_cast<size_t>(length), kWritableProtect))
        return GBFR20_TABLE_BUFFER_UNREADABLE;

    return WriteLimitBonusRow(buffer, row_count, key_hash, levels, level_count);
}
}
