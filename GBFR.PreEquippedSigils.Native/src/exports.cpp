#include "../native_internal.h"

#include <format>

using namespace gbfr::native;

uint32_t GBFR20_CALL GBFR20_GetAbiVersion()
{
   return GBFR20_ABI_VERSION;
}

void GBFR20_CALL GBFR20_SetLogCallback(GBFR20_LogCallback callback)
{
   g_log_callback.store(callback, std::memory_order_release);
}

int32_t GBFR20_CALL GBFR20_Initialize()
{
   if (g_shutting_down.load(std::memory_order_acquire))
      return 0;
   EnsureInitialized();
   return g_hooks_ready.load(std::memory_order_acquire) ? 1 : 0;
}

void GBFR20_CALL GBFR20_Tick()
{
   if (g_shutting_down.load(std::memory_order_acquire))
      return;
   EnsureInitialized();
   if (!g_hooks_ready.load(std::memory_order_acquire) ||
       !g_layout_ready.load(std::memory_order_acquire))
      return;
   UpdateEditSessionState();
   ValidateAuthorizedStatuses();
   ScheduleSelectedStatusRebind();
   ProcessPendingHotApply();
   ConsumeApplyResult();
}

void GBFR20_CALL GBFR20_Shutdown()
{
   if (g_shutdown_complete.exchange(true, std::memory_order_acq_rel))
      return;
   ShutdownHooks();
}

uint32_t GBFR20_CALL GBFR20_CopyRuntimeMessage(char* buffer, uint32_t buffer_size)
{
   std::string message;
   {
      std::scoped_lock lock(g_message_mutex);
      message = g_runtime_message;
   }
   const size_t required_size = message.size() + 1;
   if (buffer != nullptr && buffer_size != 0)
   {
      const size_t copy_size = std::min<size_t>(message.size(), buffer_size - 1);
      std::memcpy(buffer, message.data(), copy_size);
      buffer[copy_size] = '\0';
   }
   return required_size > UINT32_MAX ? UINT32_MAX : static_cast<uint32_t>(required_size);
}

int32_t GBFR20_CALL GBFR20_ApplyLoadout(
   const GBFR20_TemplateSlot* slots, uint32_t slot_count,
   const GBFR20_ExclusiveOverride* overrides, uint32_t override_count)
{
   // 一个调用带两张调用方持有的表，所以守卫在这里：关机中拒绝、计数放不进 int32_t
   // 拒绝、然后懒初始化并要求钩子已装。任一条不成立都以 0 报告失败。
   if (slot_count > INT32_MAX || override_count > INT32_MAX)
   {
      Log("ApplyLoadout: count exceeds INT32_MAX; rejected.");
      return 0;
   }
   if (g_shutting_down.load(std::memory_order_acquire))
      return 0;
   EnsureInitialized();
   if (!g_hooks_ready.load(std::memory_order_acquire))
      return 0;
   // GBFR20_TemplateSlot is layout-identical to the native TemplateGemSlot
   // (packed 1, same field order, 0x18 bytes); only read, never modified.
   const bool applied = ApplyLoadout(
      reinterpret_cast<const TemplateGemSlot*>(slots),
      static_cast<int32_t>(slot_count),
      overrides,
      static_cast<int32_t>(override_count));
   return applied ? 1 : 0;
}

// 拒绝码的人话解释只有这一处：托管层那边只记"被拒 + 码"。
static const char* SkillStatusRefusalReason(int32_t code)
{
   switch (code)
   {
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
   default:
      return "writing the rows faulted.";
   }
}

int32_t GBFR20_CALL GBFR20_WriteSkillStatusTable(const uint8_t* table, uint32_t length)
{
   if (g_shutting_down.load(std::memory_order_acquire))
      return GBFR20_TABLE_NOT_READY;
   // 刻意**不**要求 g_hooks_ready：写的是数据管理器供给的那张表，和钩子装没装成无关，而槽的
   // 解析（ResolveTableSlot）本来就排在装钩子之前、只要语义布局解析成功就会跑。槽没解析出来
   // 时下面返回 SLOT_UNRESOLVED，调用方落回自己的扫描。
   EnsureInitialized();
   const int32_t result = WriteSkillStatusTable(table, length);
   if (result < 0)
      Log(std::format(
         "WriteSkillStatusTable: refused ({}); nothing was written. {}",
         result,
         SkillStatusRefusalReason(result)));
   return result;
}
