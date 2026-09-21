#include "../native_internal.h"

namespace gbfr::native
{
std::shared_mutex g_selection_mutex;
std::unordered_map<uint32_t, std::array<uint32_t, kVirtualSlotCapacity>> g_character_selections;
std::shared_mutex g_authorization_mutex;
std::unordered_map<uintptr_t, AuthorizedStatus> g_authorized_statuses;

namespace
{
// 每个角色 **最近一次** context-1 构建用的 status 对象，以及它属于哪一轮队伍装配。
// 这张表同时就是 "见过哪些角色" 的名单（键集），没有第二份名单。
// 换人/切场景时游戏会重装队伍：它把在场成员的状态重新建一遍（新对象），
// 被移出的人不再建 —— 那一份对象就被拆掉了。所以 "最近观察到的对象" 必须连同 "它属于哪一轮" 一起记：
// 只有当前轮的对象才敢拿去重建（旧轮的对象可能是内存垃圾，2026-09-21 的崩溃就是这么来的）。
std::mutex g_party_mutex;
struct Context1Record
{
   uintptr_t status = 0;
   uint32_t pass_id = 0;
};
std::unordered_map<uint32_t, Context1Record> g_latest_context1_status;
// 当前轮次号。游戏自己的人一轮装配是**连续**建出来的（实测同一轮内相邻不到 1 ms），
// 所以用"距离上一次游戏构建的空档"切轮：空档够大 = 新的一轮。我们自己的重建调用
// （g_tls_hot_rebuild_build）不切轮，只把目标角色留在当前轮里。
std::atomic_uint32_t g_context1_pass_id{0};
std::atomic_uint64_t g_last_game_context1_ms{0};
inline constexpr uint64_t kAssemblyWindowMs = 1000;
// 配装改动后"直接重建"的节流与闸门。
std::atomic_uint64_t g_hot_rebuild_not_before_ms{0};
std::atomic_uint64_t g_party_changed_ms{0};
// 游戏最近一次自己建状态的时间（detour 里记）。热重建只在"游戏此刻没有在建"时动手：
// 我们的调用和游戏自己的构建同时碰一份 status 就是竞态（今天 3 次崩溃前的 ok=0 都是这个）。
// 注意窗口必须很短：游戏在建状态时是**连续**调用 detour 的，所以 250 ms 足以识别"正在建"，
// 而"最近 5 秒建过"会把界面上几乎每一次改动都挡掉（2026-09-21 实测：4/5 次被跳过）。
std::atomic_uint64_t g_last_game_build_ms{0};
inline constexpr uint64_t kGameBuildQuietMs = 250;
// 一旦有一次重建没能正常完成（ok=0），冷却 60 秒：那次调用已经把对象留在可疑状态，
// 而崩溃都跟在 ok=0 之后 30~60 秒。冷却期过了再允许（不是整场报废——那会让人以为功能坏了）。
std::atomic_uint64_t g_hot_rebuild_cooldown_until_ms{0};
inline constexpr uint64_t kHotRebuildCooldownMs = 60000;

} // namespace

void RememberGameBuild()
{
   g_last_game_build_ms.store(GetTickCount64(), std::memory_order_release);
}

void RememberContext1Status(uint32_t character_hash, uintptr_t status)
{
   if (character_hash == 0 || status == 0)
      return;

   const uint64_t now = GetTickCount64();
   const bool ours = g_tls_hot_rebuild_build;
   uint32_t pass_id = g_context1_pass_id.load(std::memory_order_acquire);
   if (!ours && now - g_last_game_context1_ms.load(std::memory_order_acquire) > kAssemblyWindowMs)
      pass_id = g_context1_pass_id.fetch_add(1, std::memory_order_acq_rel) + 1;
   if (!ours)
      g_last_game_context1_ms.store(now, std::memory_order_release);

   bool learned_party_member = false;
   size_t known_characters = 0;
   uintptr_t previous_status = 0;
   {
      std::scoped_lock lock(g_party_mutex);
      Context1Record& record = g_latest_context1_status[character_hash];
      previous_status = record.status;
      record.status = status;
      record.pass_id = pass_id;
      learned_party_member = previous_status == 0;
      known_characters = g_latest_context1_status.size();
   }
   // 每一次 context-1 构建都记一行：谁、哪个对象、第几轮装配。这是唯一能看出
   // "游戏在什么时候重建了谁"的证据（`(via our rebuild)` 是我们自己那次调用引发的）。
   Log(std::format(
      "ctx1 build: char=0x{:08X} status=0x{:X} pass={}{}{}{}",
      character_hash, status, pass_id,
      previous_status != 0 && previous_status != status ? " (new object)" : "",
      ours ? " (via our rebuild)" : "",
      learned_party_member ? " (new party member)" : ""));
   if (learned_party_member)
   {
      Log(std::format("party+ char=0x{:08X} ({} known)", character_hash, known_characters));
      // 队伍刚变过：接下来两秒内不许热重建（2026-09-21 三次崩溃都发生在换队友/切场景之后）。
      g_party_changed_ms.store(now, std::memory_order_release);
   }
}

bool LatestContext1Status(uint32_t character_hash, uintptr_t& status, uint32_t& pass_id)
{
   std::scoped_lock lock(g_party_mutex);
   const auto iterator = g_latest_context1_status.find(character_hash);
   if (iterator == g_latest_context1_status.end())
      return false;
   status = iterator->second.status;
   pass_id = iterator->second.pass_id;
   return true;
}

void RebuildPartyStatusesOnce()
{
   if (!g_hooks_ready.load(std::memory_order_acquire) ||
       !g_layout_ready.load(std::memory_order_acquire))
      return;
   const uint64_t now = GetTickCount64();
   if (now < g_hot_rebuild_cooldown_until_ms.load(std::memory_order_acquire))
   {
      Log("hot rebuild: skipped (cooling down after a failed rebuild)");
      return;
   }
   // 游戏此刻正在建状态就不动手：两条线程同时碰一份 status 就是竞态（ok=0 都出在这种重叠里）。
   // 跳过的代价只是"这次不实时"，改动仍会在游戏下一次自然构建时落地（菜单里实测十几秒）。
   if (now - g_last_game_build_ms.load(std::memory_order_acquire) < kGameBuildQuietMs)
   {
      Log("hot rebuild: skipped (game is building)");
      return;
   }
   uint64_t expected = g_hot_rebuild_not_before_ms.load(std::memory_order_acquire);
   if (now < expected)
      return;
   if (!g_hot_rebuild_not_before_ms.compare_exchange_strong(
          expected, now + 500, std::memory_order_acq_rel))
      return;

   std::vector<uint32_t> party;
   {
      std::scoped_lock lock(g_party_mutex);
      party.reserve(g_latest_context1_status.size());
      for (const auto& [character_hash, record] : g_latest_context1_status)
         party.push_back(character_hash);
   }
   if (party.empty())
   {
      Log("hot rebuild: no party known yet; skipped");
      return;
   }
   if (now - g_party_changed_ms.load(std::memory_order_acquire) < 2000)
   {
      Log("hot rebuild: skipped (party changed just now)");
      return;
   }

   // 只重建**当前这轮队伍装配里建出来的对象**：
   //   - 没有记录 = 这个人从没被观察到在场上；
   // - 记录的轮次 ≠ 当前轮 = 游戏已经重装过队伍，而这个人不在新队伍里（被移出/换掉），
   //   那一份 status 已经被游戏拆掉了——身份残留还在，身份校验照样通过，去重建它就是在
   //   戳内存垃圾（2026-09-21：移出队友后仍拿旧指针调游戏重建，ok=0，28 秒后崩）。
   const uint32_t current_pass = g_context1_pass_id.load(std::memory_order_acquire);
   for (const uint32_t character_hash : party)
   {
      uintptr_t latest_status = 0;
      uint32_t record_pass = 0;
      if (!LatestContext1Status(character_hash, latest_status, record_pass))
      {
         Log(std::format(
            "hot rebuild: char=0x{:08X} skipped (no context-1 status seen)", character_hash));
         continue;
      }
      if (record_pass != current_pass)
      {
         Log(std::format(
            "hot rebuild: char=0x{:08X} skipped (left the party: assembly {} < {})",
            character_hash,
            record_pass,
            current_pass));
         // 这条授权指向的对象已经不在场上了：留着它只会在指针被复用时被 detour 误当成有效选择。
         EraseAuthorizedStatus(latest_status);
         continue;
      }
      const bool rebuilt = SafeInvokeStatusRebuild(latest_status, character_hash);
      Log(std::format(
         "hot rebuild: char=0x{:08X} status=0x{:X} pass={} ok={}",
         character_hash,
         latest_status,
         record_pass,
         rebuilt ? 1 : 0));
      if (!rebuilt)
      {
         // 这一份对象已经不可信（多半正在被游戏重建/替换）：丢掉授权，并冷却 60 秒——
         // 三次崩溃都跟在这样一个 ok=0 之后 30~60 秒，这段时间不再补刀。
         EraseAuthorizedStatus(latest_status);
         g_hot_rebuild_cooldown_until_ms.store(
            GetTickCount64() + kHotRebuildCooldownMs, std::memory_order_release);
         Log("hot rebuild: cooling down 60s (a rebuild failed)");
      }
      Sleep(50);
   }
}


std::array<uint32_t, kVirtualSlotCapacity> GetSelection(uint32_t character_hash)
{
   std::shared_lock lock(g_selection_mutex);
   const auto iterator = g_character_selections.find(character_hash);
   return iterator == g_character_selections.end()
      ? std::array<uint32_t, kVirtualSlotCapacity>{}
      : iterator->second;
}
}
