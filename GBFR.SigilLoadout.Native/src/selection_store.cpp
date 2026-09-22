#include "../native_internal.h"

namespace gbfr::native
{
std::shared_mutex g_selection_mutex;
std::unordered_map<uint32_t, std::array<uint32_t, kVirtualSlotCapacity>> g_character_selections;

namespace
{
// 每个角色 **最近一次** context-1 构建用的 status 对象，以及它属于哪一轮队伍装配；这张表
// 同时就是 "见过哪些角色" 的名单（键集），没有第二份。换人/切场景时游戏会重装队伍：被移出的
// 人那份对象会被拆掉——所以 "最近观察到的对象" 必须连同 "它属于哪一轮" 一起记。
std::mutex g_party_mutex;
struct Context1Record
{
   uintptr_t status = 0;
   uint32_t pass_id = 0;
};
std::unordered_map<uint32_t, Context1Record> g_latest_context1_status;
// 当前轮次号。游戏自己的人一轮装配是**连续**建出来的（实测同一轮内相邻不到 1 ms），所以用
// "距离上一次游戏构建的空档"切轮：空档够大 = 新的一轮。我们自己的重建调用不切轮，只把目标
// 角色留在当前轮里。
std::atomic_uint32_t g_context1_pass_id{0};
std::atomic_uint64_t g_last_game_context1_ms{0};
inline constexpr uint64_t kAssemblyWindowMs = 1000;
// 配装改动后"直接重建"的节流与闸门。
std::atomic_uint64_t g_hot_rebuild_not_before_ms{0};
std::atomic_uint64_t g_party_changed_ms{0};
// 游戏最近一次自己建状态的时间（detour 里记）。热重建只在"游戏此刻没在建"时动手：我们的调用
// 和游戏自己的构建同时碰一份 status 就是竞态（崩溃前的 ok=0 都出在这种重叠里）。窗口必须短——
// 游戏建状态时是**连续**调 detour 的，250 ms 足以识别"正在建"，而"最近 5 秒建过"会挡掉界面上
// 几乎每一次改动（2026-09-21 实测：4/5 次被跳过）。
std::atomic_uint64_t g_last_game_build_ms{0};
inline constexpr uint64_t kGameBuildQuietMs = 250;
// 一旦有一次重建没能正常完成（ok=0），冷却 60 秒：那次调用已经把对象留在可疑状态，而崩溃都
// 跟在 ok=0 之后 30~60 秒。冷却期过了再允许（不是整场报废——那会让人以为功能坏了）。
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
   bool unchanged = false;
   size_t known_characters = 0;
   uintptr_t previous_status = 0;
   {
      std::scoped_lock lock(g_party_mutex);
      Context1Record& record = g_latest_context1_status[character_hash];
      previous_status = record.status;
      // 同一个对象、同一轮 = 这次进来没带来新信息（见下面日志那段）。
      unchanged = record.status == status && record.pass_id == pass_id;
      record.status = status;
      record.pass_id = pass_id;
      learned_party_member = previous_status == 0;
      known_characters = g_latest_context1_status.size();
   }
   // 记录两次都要做，**日志只说一遍**：一次构建会被 apply 与 category 两条循环各问一次扩展槽，
   // 于是这个函数对同一次构建连着进来两次、参数完全相同——原来每个构建刷两行一模一样的
   // "ctx1 build"，实测占整份日志的 43%。所以说一行的条件是"这一份记录真的变了"。
   if (!unchanged)
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

/*
   热重建的闸门：这一拍能不能动手。**只放判据**——四个时间戳原子量留在文件作用域，因为它们
   同时被 RememberGameBuild / RememberContext1Status 写，收进一个对象只是多一层间接。

   名字叫 TryClaim 而不是 Can：它**有副作用**，而且那个副作用就是节流本身——过了前两条之后
   它用 CAS 把"下一次最早什么时候"推掉 500ms；调用方别把它当纯谓词。

   返回 true = 可以动手（节流窗口已认领）；false = 这一拍不动手，原因已进日志。"游戏正在建"与
   CAS 这两条**刻意静默**：每个 tick 都可能命中，写日志只会把真正有信息量的跳过淹掉。
   "钩子/布局就绪"**不在这里**：那是 RebuildPartyStatusesOnce 的前置条件，不是闸门的一条理由。
*/
bool TryClaimRebuildNow(uint64_t now)
{
   if (now < g_hot_rebuild_cooldown_until_ms.load(std::memory_order_acquire))
   {
      Log("hot rebuild: skipped (cooling down after a failed rebuild)");
      return false;
   }
   // 跳过只是"这次不实时"：改动仍会在游戏下一次自然构建时落地（菜单里实测十几秒）。
   if (now - g_last_game_build_ms.load(std::memory_order_acquire) < kGameBuildQuietMs)
   {
      Log("hot rebuild: skipped (game is building)");
      return false;
   }
   uint64_t expected = g_hot_rebuild_not_before_ms.load(std::memory_order_acquire);
   if (now < expected ||
       !g_hot_rebuild_not_before_ms.compare_exchange_strong(
          expected, now + 500, std::memory_order_acq_rel))
      return false;

   // 这条排在节流之后：所以"队伍还没认出来"同样会推掉那 500ms。
   {
      std::scoped_lock lock(g_party_mutex);
      if (g_latest_context1_status.empty())
      {
         Log("hot rebuild: no party known yet; skipped");
         return false;
      }
   }
   if (now - g_party_changed_ms.load(std::memory_order_acquire) < 2000)
   {
      Log("hot rebuild: skipped (party changed just now)");
      return false;
   }
   return true;
}

void RebuildPartyStatusesOnce()
{
   // 前置条件：钩子与语义布局都要在位。
   if (!g_hooks_ready.load(std::memory_order_acquire) ||
       !g_layout_ready.load(std::memory_order_acquire))
      return;
   if (!TryClaimRebuildNow(GetTickCount64()))
      return;

   std::vector<uint32_t> party;
   {
      std::scoped_lock lock(g_party_mutex);
      party.reserve(g_latest_context1_status.size());
      for (const auto& [character_hash, record] : g_latest_context1_status)
         party.push_back(character_hash);
   }

   // 只重建**当前这轮队伍装配里建出来的对象**：没有记录 = 从没被观察到在场上；记录的轮次 ≠
   // 当前轮 = 游戏已重装队伍、这个人不在新队伍里，那份 status 已被游戏拆掉——身份残留还在、
   // 身份校验照样通过，重建它就是戳内存垃圾（2026-09-21：移出队友后仍拿旧指针重建，ok=0，28 秒后崩）。
   //
   // 这条路必须有：**战斗里游戏自己不会重建角色状态**（实测带满队友进真实副本、整场不改配置，
   // 4 分 09 秒零次构建；进副本前在城里那 90 秒玩家自己被重建 6 次），所以"等下一场战斗"在
   // 战斗中永远等不到。它也是本项目唯一会去动游戏活对象的地方。
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
         // 这一份对象已经不可信（多半正在被游戏重建/替换）：冷却 60 秒，这段时间不再补刀。
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
