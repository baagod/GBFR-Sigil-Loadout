#include "../native_internal.h"

#include <format>

namespace gbfr::native
{
uintptr_t g_image_base = 0;

std::once_flag g_initialize_once;
std::atomic_bool g_hooks_ready{false};
std::atomic_bool g_layout_ready{false};
ResolvedGameLayout g_game_layout{};
std::atomic_bool g_shutting_down{false};
std::atomic_bool g_shutdown_complete{false};
std::atomic<GBFR20_LogCallback> g_log_callback{nullptr};
std::mutex g_message_mutex;
std::string g_runtime_message = "Waiting for initialization.";

std::atomic<int32_t> g_virtual_slot_count{kBuiltinExclusiveSlotCount};

int GetVirtualSlotCount() noexcept
{
   return g_virtual_slot_count.load(std::memory_order_acquire);
}

int GetExpandedInternalSlotCount() noexcept
{
   return kNativeInternalSlotCount + GetVirtualSlotCount();
}

void Log(const std::string& message)
{
   SYSTEMTIME time{};
   GetLocalTime(&time);
   const std::string line = std::format(
      "[{:02}:{:02}:{:02}.{:03}] [GBFR Pre-Equipped Sigils Native] {}\n",
      time.wHour,
      time.wMinute,
      time.wSecond,
      time.wMilliseconds,
      message);
   OutputDebugStringA(line.c_str());
   if (const GBFR20_LogCallback callback = g_log_callback.load(std::memory_order_acquire);
       callback != nullptr)
   {
      callback(message.c_str());
   }
}

void CompleteStartupPhase(
   std::string_view phase,
   uint64_t started_at_ms,
   bool succeeded)
{
   const uint64_t elapsed_ms = GetTickCount64() - started_at_ms;
   Log(std::format(
      "Startup phase={} state={} elapsed_ms={}.",
      phase,
      succeeded ? "complete" : "failed",
      elapsed_ms));
}

void SetRuntimeMessage(std::string message)
{
   // Log the message before storing it so the log line can never race another
   // thread's store (the stored copy below stays under the mutex).
   Log(message);
   std::scoped_lock lock(g_message_mutex);
   g_runtime_message = std::move(message);
}
}
