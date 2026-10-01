#include "../native_internal.h"

#include <format>

using namespace gbfr::native;

// ABI 边界：异常绝不能跨出 extern "C"（契约里没有这一项，抛出去就是 std::terminate 带走游戏）。
// 可能抛的导出都从这里走：throw 变成"拒绝值 + 一行原因"。
template <typename Fn, typename T>
T GuardAbi(const char* what, T refusal, Fn&& body) noexcept {
    try {
        return body();
    }
    catch (...) {
        Log(std::format("{}: threw; reported as a refusal.", what));
        return refusal;
    }
}

uint32_t GBFR20_CALL GBFR20_GetAbiVersion() {
    return GBFR20_ABI_VERSION;
}

void GBFR20_CALL GBFR20_SetLogCallback(GBFR20_LogCallback callback) {
    g_log_callback.store(callback, std::memory_order_release);
}

int32_t GBFR20_CALL GBFR20_Initialize() {
    // EnsureInitialized 会分配、加锁，抛了就是"没初始化成功"（0）。
    return GuardAbi("GBFR20_Initialize", int32_t{0}, [] {
        if (g_shutting_down.load(std::memory_order_acquire))
            return int32_t{0};
        EnsureInitialized();
        return g_hooks_ready.load(std::memory_order_acquire) ? int32_t{1} : int32_t{0};
    });
}

void GBFR20_CALL GBFR20_Shutdown() {
    GuardAbi("GBFR20_Shutdown", 0, [] {
        if (!g_shutdown_complete.exchange(true, std::memory_order_acq_rel))
            ShutdownHooks();
        return 0;
    });
}

uint32_t GBFR20_CALL GBFR20_CopyRuntimeMessage(char* buffer, uint32_t buffer_size) {
    // std::string 的拷贝会分配；抛了就当作"没有消息"（0）——这份消息本身只是诊断信息。
    return GuardAbi("GBFR20_CopyRuntimeMessage", uint32_t{0}, [&] {
        std::string message; {
            std::scoped_lock lock(g_message_mutex);
            message = g_runtime_message;
        }
        const size_t required_size = message.size() + 1;
        if (buffer != nullptr && buffer_size != 0) {
            const size_t copy_size = std::min<size_t>(message.size(), buffer_size - 1);
            std::memcpy(buffer, message.data(), copy_size);
            buffer[copy_size] = '\0';
        }
        return required_size > UINT32_MAX ? UINT32_MAX : static_cast<uint32_t>(required_size);
    });
}

// 内部实现可抛（Log/format/分配），所以导出只负责把它包进 ABI 守卫。
static int32_t ApplyLoadoutEntry(
    const GBFR20_TemplateSlot* slots, uint32_t slot_count,
    const GBFR20_ExclusiveOverride* overrides, uint32_t override_count) {
    // 一个调用带两张调用方持有的表，所以两道边界检查都在这里：任一条不成立都以 0 报告失败。
    //
    // 上界不是形式：下面按调用方的计数逐个读那两块内存，而专属开关没有自己的容器大小可依——
    // 一个凭空来的计数会一路读到调用方数组之外。
    constexpr int32_t kMaxTemplateSlots = static_cast<int32_t>(kVirtualSlotCapacity);
    constexpr int32_t kMaxExclusiveOverrides =
        static_cast<int32_t>(kRuntimeTemplateCapacity) * 3;
    if (slot_count > kMaxTemplateSlots || override_count > kMaxExclusiveOverrides) {
        Log(std::format(
            "ApplyLoadout: counts out of range (slots {} > {}, overrides {} > {}); rejected.",
            slot_count, kMaxTemplateSlots, override_count, kMaxExclusiveOverrides));
        return 0;
    }
    if (g_shutting_down.load(std::memory_order_acquire))
        return 0;
    EnsureInitialized();
    if (!g_hooks_ready.load(std::memory_order_acquire))
        return 0;
    // 与原生 TemplateGemSlot 布局一致（见 native_internal.h）；只读，从不修改。
    const bool applied = ApplyLoadout(
        reinterpret_cast<const TemplateGemSlot*>(slots),
        static_cast<int32_t>(slot_count),
        overrides,
        static_cast<int32_t>(override_count));
    return applied ? 1 : 0;
}

int32_t GBFR20_CALL GBFR20_ApplyLoadout(
    const GBFR20_TemplateSlot* slots, uint32_t slot_count,
    const GBFR20_ExclusiveOverride* overrides, uint32_t override_count) {
    return GuardAbi("GBFR20_ApplyLoadout", int32_t{0}, [&] {
        return ApplyLoadoutEntry(slots, slot_count, overrides, override_count);
    });
}

// 拒绝码的人话解释只有这一处：托管层那边只记"被拒 + 码"。每一个码都要在这里有一句，
// 否则 default 会把一个具体的失败说成另一件事。
static const char* SkillStatusRefusalReason(int32_t code) {
    switch (code) {
    case GBFR20_TABLE_NOT_READY:
        return "the native core is not initialized yet, or is shutting down.";
    case GBFR20_TABLE_SLOT_UNRESOLVED:
        return "the skill_status slot was not resolved from its anchor at startup.";
    case GBFR20_TABLE_BUFFER_UNREADABLE:
        return "the slot holds no pointer, or the table's memory is not writable.";
    case GBFR20_TABLE_ROW_COUNT_INCONSISTENT:
        return "the buffer's row count does not match the supplied table's; this is not the table this mod patches.";
    case GBFR20_TABLE_LENGTH_UNEXPECTED:
        return "the supplied table is not a whole number of 52-byte rows after its 8-byte header.";
    case GBFR20_TABLE_IDENTITY_MISMATCH:
        return "the buffer's row keys do not match the supplied table; not the same table.";
    case GBFR20_TABLE_WRITE_FAILED:
        return "the row writes faulted after every gate passed; the table may be partially updated.";
    default:
        return "unknown refusal code; see native_api.h for the list.";
    }
}

static int32_t WriteSkillStatusTableEntry(const uint8_t* table, uint32_t length) {
    if (g_shutting_down.load(std::memory_order_acquire))
        return GBFR20_TABLE_NOT_READY;
    // 刻意**不**要求 g_hooks_ready：写的是数据管理器供给的那张表，与钩子装没装成无关，而
    // ResolveTableSlot 本来就排在装钩子之前。槽没解析出来时下面返回 SLOT_UNRESOLVED：拒写、
    // 一个字节都不动——编辑没丢（表已经重新注册过），只是要等游戏下一次解析或重启。
    EnsureInitialized();
    // 上一次报出来的拒绝码。同一种拒写只报一次：拒写每 5 秒重试一次，而游戏把那张表读进内存
    // 之前**必然**一直是 -3——这条消息于是逐字相同。这里只说一次"为什么没写进去"，真正的结论
    // 由托管侧那句 SUCCESS / 拒写承担。拒绝码换了（或中间成功过一次）才再报。
    static std::atomic_int32_t last_refusal{std::numeric_limits<int32_t>::min()};

    const int32_t result = WriteSkillStatusTable(table, length);
    if (result < 0) {
        if (last_refusal.exchange(result, std::memory_order_acq_rel) != result)
            Log(std::format(
                "WriteSkillStatusTable: refused ({}): {}",
                result,
                SkillStatusRefusalReason(result)));
    }
    else {
        // 成功过就把"上次报过的码"清掉：下一次拒写（比如换了一份编辑）值得再报一次。
        last_refusal.store(std::numeric_limits<int32_t>::min(), std::memory_order_release);
    }
    return result;
}

int32_t GBFR20_CALL GBFR20_WriteSkillStatusTable(const uint8_t* table, uint32_t length) {
    // 兜底取 -7：它是"写之后"的码，最保守（表可能只更新了一部分）。
    return GuardAbi("GBFR20_WriteSkillStatusTable", GBFR20_TABLE_WRITE_FAILED, [&] {
        return WriteSkillStatusTableEntry(table, length);
    });
}

// 两张活表的拒绝码人话解释（GBFR20_SetLimitBonusLevels 与 GBFR20_SetSkillboardValues 共用）。
// 与上面那个 SkillStatusRefusalReason 分开：这里的 -2 指的是"活表的指针字段还没解析出来"，
// 而 skill_status 那张表有自己的槽锚点，"没解析出来"是另一回事。
//
// 文案里**不点表名**：调用方那句日志开头已经写了是哪张表（"SetLimitBonusLevels: refused ..."），
// 而这两条路共用一个格式化器——早先这里写死了 limit_bonus_param，于是专精那边的 -2 会报出一句
// 指错表的话。
static const char* TableRefusalReason(int32_t code) {
    switch (code) {
    case GBFR20_TABLE_NOT_READY:
        return "the native core is not initialized yet, or is shutting down.";
    case GBFR20_TABLE_SLOT_UNRESOLVED:
        return "the live table's pointer field was not resolved from its anchor at startup.";
    case GBFR20_TABLE_BUFFER_UNREADABLE:
        return "the pointer field is unreadable, or the table's memory is not writable.";
    case GBFR20_SLOT_MASK_UNEXPECTED:
        return "the slot mask selects nothing, or reaches past the tenth slot.";
    case GBFR20_TABLE_ROW_COUNT_IMPLAUSIBLE:
        return "the buffer's row count is outside the plausible range; the pointer field points at something else.";
    case GBFR20_TABLE_KEY_NOT_UNIQUE:
        return "the rows matching this key disagree on the values being written, or there are more of them than expected; this is not the table this mod patches.";
    case GBFR20_TABLE_KEY_NOT_FOUND:
        return "the key is not in the buffer; either this is not the table this mod patches, or that entry has no row.";
    case GBFR20_TABLE_WRITE_FAILED:
        return "the row write faulted after every gate passed; the row may be partially updated.";
    default:
        return "unknown refusal code; see native_api.h for the list.";
    }
}

static int32_t SetLimitBonusLevelsEntry(
    uint32_t key_hash,
    uint32_t level_mask,
    const float* values) {
    if (g_shutting_down.load(std::memory_order_acquire))
        return GBFR20_TABLE_NOT_READY;
    // 与 WriteSkillStatusTable 同：刻意**不**要求 g_hooks_ready——写的是数据表，与钩子装没装成
    // 无关。锚点没解析出来时下面返回 SLOT_UNRESOLVED：拒写、一个字节都不动，编辑不丢。
    EnsureInitialized();
    // 同一种拒写只报一次：调用方每个能力各调一次，逐条报会把日志刷满，而原因逐字相同。
    static std::atomic_int32_t last_refusal{std::numeric_limits<int32_t>::min()};

    const int32_t result = SetLimitBonusLevels(key_hash, level_mask, values);
    if (result < 0) {
        if (last_refusal.exchange(result, std::memory_order_acq_rel) != result)
            Log(std::format(
                "SetLimitBonusLevels: refused ({}): {}",
                result,
                TableRefusalReason(result)));
    }
    else {
        // 成功过就把"上次报过的码"清掉：下一次拒写值得再报一次。
        last_refusal.store(std::numeric_limits<int32_t>::min(), std::memory_order_release);
    }
    return result;
}

int32_t GBFR20_CALL GBFR20_SetLimitBonusLevels(
    uint32_t key_hash,
    uint32_t level_mask,
    const float* values) {
    return GuardAbi("GBFR20_SetLimitBonusLevels", GBFR20_TABLE_WRITE_FAILED, [&] {
        return SetLimitBonusLevelsEntry(key_hash, level_mask, values);
    });
}

// 「专精技能」那一页：同一套门（掩码合法 -> 行数合理 -> 整段可写 -> 命中行的被选中格一致），
// 不同的只有"表指针从哪来"——见 src/table_slot.cpp 的 ResolveSkillboardPointer。拒绝码沿用同一组
// （含义逐条相同），所以原因文案也复用 TableRefusalReason。
static int32_t SetSkillboardValuesEntry(
    uint32_t key_hash,
    uint32_t value_mask,
    const float* values) {
    if (g_shutting_down.load(std::memory_order_acquire))
        return GBFR20_TABLE_NOT_READY;
    EnsureInitialized();
    static std::atomic_int32_t last_refusal{std::numeric_limits<int32_t>::min()};

    const int32_t result = SetSkillboardValues(key_hash, value_mask, values);
    if (result < 0) {
        if (last_refusal.exchange(result, std::memory_order_acq_rel) != result)
            Log(std::format(
                "SetSkillboardValues: refused ({}): {}",
                result,
                TableRefusalReason(result)));
    }
    else {
        last_refusal.store(std::numeric_limits<int32_t>::min(), std::memory_order_release);
    }
    return result;
}

int32_t GBFR20_CALL GBFR20_SetSkillboardValues(
    uint32_t key_hash,
    uint32_t value_mask,
    const float* values) {
    return GuardAbi("GBFR20_SetSkillboardValues", GBFR20_TABLE_WRITE_FAILED, [&] {
        return SetSkillboardValuesEntry(key_hash, value_mask, values);
    });
}
