#include "../native_internal.h"

#include <format>

namespace gbfr::native
{
namespace
{
// 这里曾是唯一一处"全内存扫描"兜底（TableLocator，279 行）：锚点失效时扫过全部内存、
// 把所有内容相同的表都写一遍。已删——它在这套机制上线后一次都没跑过（日志里从没出现
// `located … copy/copies`），而且它证明不了唯一重要的那件事："这块缓冲区就是游戏在用的
// 那块"静态证不出来。**不要再加回来**：拒写的代价是这一局内存不变（表此前已重新注册，
// 编辑在游戏下一次解析或重启后照样生效），而扫描的代价是 5~6 秒的慢路径。
//
// 定位分两步，靠语义而不是靠地址常量。
//
// 第一步，行循环锚点：skill_status 那张表按"8 字节行数头 + 52 字节行"读出来，
// 行尾就是 rows + rowCount*52：
//   48 6B FE 34        imul rdi, rsi, 0x34        ; end = count*52
//   48 01 DF           add  rdi, rbx              ; + rows
//   C4 41 38 57 C0     vxorps xmm8, xmm8, xmm8
// 这 12 字节里没有 rel32、没有 rip 位移，所以它是纯语义锚点：换版本只要这张表还是
// 52 字节行，这段指令序列就还在。实测 2.0.6 的 77,257,728 字节 .text 里恰好 1 处。
inline constexpr std::array<uint8_t, 12> kRowLoopSetup = {
   0x48, 0x6B, 0xFE, 0x34, 0x48, 0x01, 0xDF, 0xC4, 0x41, 0x38, 0x57, 0xC0};

// 第二步，锚点前 0x800 字节窗口里必须各恰好出现一次的两条发布指令。两条的 rip 位移都是
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

// 为什么锚点要配一个窗口：这两条发布指令在 2.0.6 里全段分别出现 37 处和 23 处（同一个函数
// 里每一张表都有一份），只有落在行循环锚点前面的那一对属于 skill_status。实测：真正的
// 距离是 0xCA（load）和 0xFE（store）；隔壁 skill.tbl 的那一对在 0x836 和 0x86E，正好在
// 窗口外。窗口取 0x800：真实距离有 8 倍余量，又刚好把隔壁那张表挡出去。
inline constexpr size_t kAnchorWindowBytes = 0x800;

// File header size and row stride of skill_status.tbl: 8-byte row count, then
// 52-byte rows (see GBFR.SigilLoadout/SigilEditorFeature.cs, same numbers).
inline constexpr uint64_t kTableHeaderBytes = 8;
inline constexpr uint64_t kTableRowBytes = 52;
// 行里 Key 的位置（相对行首）：编辑只碰 LevelValue1..10 与 Level，从不碰 Key，
// 所以 Key 序列是这张表的**身份**，可以逐行比对且与编辑无关。
inline constexpr uint64_t kRowKeyOffset = 40;

// 解析成功后要记住的全部东西：槽首的 RVA（0 = 还没解析出来）。缓冲区指针字段就是槽 +8，
// 不必另存一份；单写者、读者只 load，所以一个原子量就够，不需要锁和那个结构体。
std::atomic_uintptr_t g_slot_rva{0};

// 从槽里取出游戏那份活表的缓冲区地址：0 表示取到了，负数表示拒绝码。
//
// 每次问都重新读指针，不缓存地址——游戏换掉那份表（重新解析、发布新缓冲区）时下一个
// 调用就跟上了，所以这里不存在"缓存失效"这个概念。
int32_t TryGetLiveTableBuffer(uintptr_t& buffer) noexcept
{
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

// 在一个范围内数一个模式的全部命中，并记下第一处。0 字节当通配。
template <size_t Size>
size_t CountMatches(
   const uint8_t* base,
   size_t size,
   const std::array<uint8_t, Size>& pattern,
   uintptr_t base_rva,
   uintptr_t& first_rva) noexcept
{
   size_t matches = 0;
   for (size_t offset = 0; offset + Size <= size; ++offset)
   {
      bool matched = true;
      for (size_t index = 0; index < Size; ++index)
      {
         const uint8_t expected = pattern[index];
         if (expected != 0 && base[offset + index] != expected)
         {
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

struct AnchorSearch
{
   size_t row_loop_matches = 0;
   uintptr_t row_loop_rva = 0;
   size_t buffer_load_matches = 0;
   uintptr_t buffer_load_rva = 0;
   size_t slot_store_matches = 0;
   uintptr_t slot_store_rva = 0;
   // 实际扫过的窗口：min(kAnchorWindowBytes, 锚点之前的字节数)。失败日志要报它而不是那个常量，
   // 否则锚点靠段首时会报一个从没扫过的宽度，排查时会被引到错的方向。
   size_t window_bytes = 0;
};

// .text 扫描单独一个函数：它必须待在 SEH 帧里，而 SEH 帧不能和"需要栈展开的对象"同处
// 一个函数（MSVC C2712），所以构造消息、拼字符串那些都留在调用方，这里只回报原始结果。
// 三个计数各自都要恰好 1，任何一处不是 1 都由调用方 fail closed。
AnchorSearch SearchAnchorWindow(uintptr_t code_rva, size_t code_size) noexcept
{
   AnchorSearch result{};
   __try
   {
      const uint8_t* code = reinterpret_cast<const uint8_t*>(g_image_base + code_rva);
      result.row_loop_matches =
         CountMatches(code, code_size, kRowLoopSetup, code_rva, result.row_loop_rva);
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
   __except (EXCEPTION_EXECUTE_HANDLER)
   {
      return AnchorSearch{};
   }
   return result;
}

// 逐行 Key 比对：Key 是这张表的**身份**（编辑只动 LevelValue1..10 与 Level，从不碰 Key），
// 所以这一关既是"确实是同一张表"的实证，又不会随编辑变化——每次应用都过得去。
// 另开一个函数：SEH 帧里只许有平凡类型，而且不能和"要栈展开的对象"同处一个函数。
bool SameRowIdentity(const uint8_t* live, const uint8_t* table, uint64_t row_count) noexcept
{
   __try
   {
      for (uint64_t row = 0; row < row_count; ++row)
      {
         const size_t offset =
            static_cast<size_t>(kTableHeaderBytes + kTableRowBytes * row + kRowKeyOffset);
         if (std::memcmp(live + offset, table + offset, sizeof(uint32_t)) != 0)
            return false;
      }
   }
   __except (EXCEPTION_EXECUTE_HANDLER)
   {
      return false;
   }
   return true;
}

// 逐行写：只写内容真的不一样的行。那 6 条编辑就是 6 行，写窗口于是是 312 字节而不是
// 328,648 字节——游戏任何时刻撞上"半更新的一行"的窗口小两个数量级。
int32_t WriteChangedRows(uint8_t* live, const uint8_t* table, uint64_t row_count) noexcept
{
   int32_t written = 0;
   __try
   {
      for (uint64_t row = 0; row < row_count; ++row)
      {
         const size_t offset = static_cast<size_t>(kTableHeaderBytes + kTableRowBytes * row);
         if (std::memcmp(live + offset, table + offset, kTableRowBytes) == 0)
            continue;
         std::memcpy(live + offset, table + offset, kTableRowBytes);
         ++written;
      }
   }
   __except (EXCEPTION_EXECUTE_HANDLER)
   {
      return GBFR20_TABLE_WRITE_FAILED;
   }
   return written;
}
}

void ResolveTableSlot()
{
   if (g_slot_rva.load(std::memory_order_acquire) != 0 || g_image_base == 0)
      return;

   // 代码段来自 layout_resolver 的 PE 视图——它才是"映像里哪一段是代码"的唯一持有者
   // （先按名字找 `.text`，找不到才取最大的可执行段）。这里不再自己解析一遍 PE 头。
   CodeSectionView code{};
   if (!TryGetCodeSection(code))
   {
      Log("Table slot: the game image's code section could not be resolved; nothing resolved.");
      return;
   }

   const AnchorSearch anchor = SearchAnchorWindow(code.rva, code.size);
   if (anchor.row_loop_matches != 1 || anchor.buffer_load_matches != 1 ||
       anchor.slot_store_matches != 1)
   {
      Log(std::format(
         "Table slot: in the code section the skill_status row-loop anchor matched {} time(s) and, "
         "in the {} bytes before it, the buffer-pointer load matched {} time(s) while the slot store "
         "matched {} time(s); expected exactly one of each. This game build is not the one the "
         "mod was written for; no slot was resolved.",
         anchor.row_loop_matches,
         anchor.window_bytes,
         anchor.buffer_load_matches,
         anchor.slot_store_matches));
      return;
   }

   // 两处 RIP 相对位移都解出来再验：槽首那条 mov [rip+d],rcx 与缓冲区指针那条
   // mov rbx,[rip+d] 必须正好差 8（槽是 handle@+0 / buffer@+8 / ?@+0x10 三档）。解不出这一
   // 对就不认。
   // 两个锚点都是 `mov r,[rip+d]` / `mov [rip+d],r`：位移都在指令 +3，指令都长 7 字节。
   uintptr_t slot_rva = 0;
   uintptr_t buffer_pointer_rva = 0;
   if (!DecodeRipTarget(
          g_image_base, code.image_size, anchor.slot_store_rva, 3, 7, slot_rva) ||
       !DecodeRipTarget(
          g_image_base, code.image_size, anchor.buffer_load_rva, 3, 7, buffer_pointer_rva) ||
       buffer_pointer_rva != slot_rva + 8)
   {
      Log("Table slot: the publish anchors' displacements do not decode to a slot and its +8 "
          "pointer field; nothing resolved.");
      return;
   }
   if (!IsInWritableImageSection(slot_rva, 24) ||
       !IsInWritableImageSection(buffer_pointer_rva, sizeof(uintptr_t)))
   {
      Log("Table slot: the decoded slot does not lie in a writable image section; nothing "
          "resolved.");
      return;
   }

   g_slot_rva.store(slot_rva, std::memory_order_release);
   Log(std::format(
      "Table slot: row-loop anchor at RVA 0x{:X}, publish anchors at 0x{:X} / 0x{:X} "
      "(PE 0x{:X}) resolve slot=0x{:X} (loaded 0x{:X}), buffer pointer=0x{:X} (loaded 0x{:X}).",
      anchor.row_loop_rva,
      anchor.slot_store_rva,
      anchor.buffer_load_rva,
      code.timestamp,
      slot_rva,
      g_image_base + slot_rva,
      buffer_pointer_rva,
      g_image_base + buffer_pointer_rva));
}

int32_t WriteSkillStatusTable(const uint8_t* table, size_t length) noexcept
{
   // 表的形状由**调用方**给的那张表定义（它来自归档，是权威），原生只检查游戏那份与它一致。
   // 所以这里没有"6320"这种把游戏版本写死的常量：行的列布局变一次，只要 52 字节/行的关系还
   // 成立，这条路就照样走；行数变了也不用改一个字。
   if (table == nullptr || length <= kTableHeaderBytes ||
       (length - kTableHeaderBytes) % kTableRowBytes != 0)
      return GBFR20_TABLE_LENGTH_UNEXPECTED;
   const uint64_t supplied_rows = (length - kTableHeaderBytes) / kTableRowBytes;

   uintptr_t buffer = 0;
   const int32_t refusal = TryGetLiveTableBuffer(buffer);
   if (refusal != 0)
      return refusal;

   // 三道闸全在写之前，任何一条不成立都是一个字节都不写。
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
}
