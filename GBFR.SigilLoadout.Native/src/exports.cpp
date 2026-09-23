#include "../native_internal.h"

#include <format>

using namespace gbfr::native;

// ABI 边界：异常绝不能跨出 extern "C"——契约（native_api.h）里没有这一项，抛出去就是 std::terminate
// 带走游戏。可能抛的导出都从这里走：throw 变成"拒绝值 + 一行原因"。Log 自己是 noexcept，所以在这里
// 记录原因是安全的；GetAbiVersion / SetLogCallback 证得了不会抛，不走这条。
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
   // EnsureInitialized 会分配、加锁，所以整条走守卫：抛了就是"没初始化成功"（0）。
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
   // 一个调用带两张调用方持有的表，守卫都在这里：关机中拒绝、计数越界拒绝、然后懒初始化并
   // 要求钩子已装；任一条不成立都以 0 报告失败。
   //
   // 上界不是形式：下面按调用方的计数逐个读那两块内存，而专属开关没有自己的容器大小可依——
   // 一个凭空来的计数会一路读到调用方数组之外。上界取"专属表角色数 × 每角色三个专属槽"。
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
   // 与原生 TemplateGemSlot 布局一致（pack 1、字段顺序一致、0x18 字节）；
   // 只读，从不修改。
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
   // 上一次报出来的拒绝码；同一种拒写只报一次：
   //
   // 拒写每 5 秒重试一次，而游戏把那张表读进内存之前**必然**一直是 -3——这条消息于是逐字
   // 相同，实测 3 行只差时间戳。这里只说一次"为什么没写进去"，真正的结论由托管侧那句
   // SUCCESS / 拒写承担。拒绝码换了（或中间成功过一次）才再报。
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
   // 守卫里的兜底取 -7：它是"写之后"的码，语义上最保守（表可能只更新了一部分）。
   return GuardAbi("GBFR20_WriteSkillStatusTable", GBFR20_TABLE_WRITE_FAILED, [&] {
      return WriteSkillStatusTableEntry(table, length);
   });
}
