#include "../native_internal.h"

#include <format>
#include <limits>

namespace gbfr::native
{
namespace
{
struct PatternView
{
   const uint8_t* bytes = nullptr;
   const char* mask = nullptr;
   size_t size = 0;
};

template <size_t ByteCount, size_t MaskCount>
constexpr PatternView MakePattern(
   const uint8_t (&bytes)[ByteCount],
   const char (&mask)[MaskCount]) noexcept
{
   static_assert(ByteCount + 1 == MaskCount);
   return {bytes, mask, ByteCount};
}

// 布局预检字节表：解析出的每个 RVA 都必须以这些字节开头，否则整套 gameplay hook 不装
// （fail-closed，见 §7）。只有本文件用它们，所以它们住在这里而不是共享内部头。
inline constexpr std::array<uint8_t, 16> kSkillApplyLoopPreflight = {
   0xFF, 0xC7, 0x83, 0xFF, 0x0D, 0x0F, 0x84, 0xB7,
   0x00, 0x00, 0x00, 0xC5, 0xF8, 0x11, 0x75, 0xF0};
inline constexpr std::array<uint8_t, 12> kSkillApplyGetterReturnPreflight = {
   0x84, 0xC0, 0x74, 0xD3, 0xF6, 0x45, 0x00, 0x10, 0x75, 0xCD, 0x44, 0x8B};
inline constexpr std::array<uint8_t, 13> kSkillCategoryLoopPreflight = {
   0x49, 0xFF, 0xC5, 0x49, 0x83, 0xFD, 0x0D, 0x0F, 0x84, 0xE4, 0x00, 0x00, 0x00};
inline constexpr std::array<uint8_t, 11> kSkillFetchPreflight = {
   0x84, 0xDB, 0x74, 0x3E, 0x49, 0x8B, 0x87, 0x80, 0x5E, 0x00, 0x00};
inline constexpr std::array<uint8_t, 14> kSkillFetchCallPathPreflight = {
   0x4C, 0x89, 0xF9, 0x44, 0x89, 0xEA, 0x4D, 0x89, 0xE0, 0xE8, 0x12, 0x65, 0x00, 0x00};
inline constexpr std::array<uint8_t, 12> kSkillCategoryGetterReturnPreflight = {
   0x84, 0xC0, 0x74, 0x8E, 0xF6, 0x45, 0xD8, 0x10, 0x75, 0x88, 0x8B, 0x55};
inline constexpr std::array<uint8_t, 12> kGetterPreflight = {
   0x55, 0x41, 0x57, 0x41, 0x56, 0x56, 0x57, 0x53, 0x48, 0x83, 0xEC, 0x28};
inline constexpr std::array<uint8_t, 12> kStatusRebuildPreflight = {
   0x55, 0x56, 0x57, 0x48, 0x83, 0xEC, 0x50, 0x48, 0x8D, 0x6C, 0x24, 0x50};
inline constexpr std::array<uint8_t, 12> kStatusNotifierPreflight = {
   0x41, 0x56, 0x56, 0x57, 0x53, 0x48, 0x83, 0xEC, 0x38, 0x44, 0x89, 0xC6};
inline constexpr std::array<uint8_t, 24> kStatusOwnerTickPreflight = {
   0x55, 0x41, 0x57, 0x41, 0x56, 0x41, 0x55, 0x41,
   0x54, 0x56, 0x57, 0x53, 0x48, 0x81, 0xEC, 0x98,
   0x05, 0x00, 0x00, 0x48, 0x8D, 0xAC, 0x24, 0x80};

constexpr uint8_t kApplyLoopBytes[] = {
   0xFF, 0xC7, 0x83, 0xFF, 0x0D, 0x0F, 0x84, 0, 0, 0, 0,
   0xC5, 0xF8, 0x11, 0x75, 0xF0};
constexpr auto kApplyLoopPattern =
   MakePattern(kApplyLoopBytes, "xxxxxxx????xxxxx");

constexpr uint8_t kCategoryLoopBytes[] = {
   0x49, 0xFF, 0xC5, 0x49, 0x83, 0xFD, 0x0D, 0x0F, 0x84, 0, 0, 0, 0};
constexpr auto kCategoryLoopPattern =
   MakePattern(kCategoryLoopBytes, "xxxxxxxxx????");

constexpr uint8_t kUiModePairBytes[] = {
   0x48, 0x8B, 0x05, 0, 0, 0, 0,
   0x48, 0x8B, 0x0D, 0, 0, 0, 0,
   0x8B, 0x50, 0x34,
   0x89, 0x91, 0x14, 0x0B, 0x00, 0x00,
   0xC6, 0x40, 0x2C, 0x01};
constexpr auto kUiModePairPattern =
   MakePattern(kUiModePairBytes, "xxx????xxx????xxxxxxxxxxxxx");

constexpr uint8_t kUiCharacterBytes[] = {
   0x4C, 0x8B, 0x05, 0, 0, 0, 0,
   0x48, 0x63, 0x86, 0xDC, 0x00, 0x00, 0x00,
   0x48, 0x8B, 0x8E, 0xE0, 0x00, 0x00, 0x00,
   0x44, 0x8B, 0x3C, 0x81,
   0x45, 0x8B, 0xA0, 0, 0, 0, 0,
   0x45, 0x39, 0xFC,
   0x0F, 0x84, 0, 0, 0, 0,
   0x45, 0x89, 0xB8, 0, 0, 0, 0};
constexpr auto kUiCharacterPattern = MakePattern(
   kUiCharacterBytes,
   "xxx????xxxxxxxxxxxxxxxxxxxxx????xxxxx????xxx????");

constexpr uint8_t kNotifierBytes[] = {
   0x41, 0x56, 0x56, 0x57, 0x53, 0x48, 0x83, 0xEC, 0x38,
   0x44, 0x89, 0xC6, 0x89, 0xD3, 0x48, 0x89, 0xCF,
   0x4C, 0x8B, 0x35, 0, 0, 0, 0,
   0xC6, 0x44, 0x24, 0x30, 0x00,
   0xC6, 0x44, 0x24, 0x28, 0x00,
   0xC6, 0x44, 0x24, 0x20, 0x00,
   0x4C, 0x89, 0xF1, 0x31, 0xD2,
   0x45, 0x31, 0xC0, 0x45, 0x31, 0xC9,
   0xE8, 0, 0, 0, 0,
   0x80, 0xB8, 0xBC, 0x5E, 0x00, 0x00, 0x00,
   0xB9, 0xB0, 0xE0, 0x7A, 0x88, 0x74, 0x06,
   0x8B, 0x88, 0xA8, 0x5E, 0x00, 0x00,
   0x39, 0xD9};
constexpr auto kNotifierPattern = MakePattern(
   kNotifierBytes,
   "xxxxxxxxxxxxxxxxxxxx"
   "????"
   "xxxxxxxxxxxxxxxxxxxxxxxxxxx"
   "????"
   "xxxxxxxxxxxxxxxxxxxxxx");

constexpr uint8_t kOwnerLoopBytes[] = {
   0x48, 0x8B, 0x73, 0x20, 0x48, 0x8B, 0x7B, 0x28,
   0x48, 0x39, 0xFE, 0x0F, 0x84, 0, 0, 0, 0,
   0x4C, 0x8D, 0xB3, 0x30, 0x32, 0x00, 0x00};
constexpr auto kOwnerLoopPattern =
   MakePattern(kOwnerLoopBytes, "xxxxxxxxxxxxx????xxxxxxx");

constexpr uint8_t kSystemDataBytes[] = {
   0x48, 0x8B, 0x3D, 0, 0, 0, 0,
   0x48, 0x8D, 0x8F, 0, 0, 0, 0,
   0x48, 0x8B, 0x87, 0, 0, 0, 0,
   0xFF, 0x50, 0x18};
constexpr auto kSystemDataPattern =
   MakePattern(kSystemDataBytes, "xxx????xxx????xxx????xxx");

constexpr uint8_t kStatusManagerBytes[] = {
   0x4C, 0x8B, 0x25, 0, 0, 0, 0,
   0x48, 0x8B, 0x05, 0, 0, 0, 0,
   0x48, 0x89, 0x45, 0xC0,
   0x41, 0x0F, 0xB6, 0x87, 0xC0, 0x5E, 0x00, 0x00};
constexpr auto kStatusManagerPattern =
   MakePattern(kStatusManagerBytes, "xxx????xxx????xxxxxxxxxxxx");

constexpr uint8_t kStatusMapBytes[] = {
   0x44, 0x8B, 0x83, 0, 0, 0, 0,
   0x41, 0x21, 0xD0,
   0x48, 0x8B, 0x83, 0, 0, 0, 0,
   0x4C, 0x8B, 0x93, 0, 0, 0, 0,
   0x4C, 0x89, 0xC1, 0x48, 0xC1, 0xE1, 0x04,
   0x49, 0x8B, 0x4C, 0x0A, 0x08};
constexpr auto kStatusMapPattern =
   MakePattern(kStatusMapBytes, "xxx????xxxxxx????xxx????xxxxxxxxxxxx");

struct ImageView
{
   uintptr_t base = 0;
   uintptr_t size = 0;
   uintptr_t code_rva = 0;
   size_t code_size = 0;
   const IMAGE_NT_HEADERS64* nt = nullptr;
   const IMAGE_SECTION_HEADER* sections = nullptr;
   uint16_t section_count = 0;
   const IMAGE_RUNTIME_FUNCTION_ENTRY* runtime_functions = nullptr;
   size_t runtime_function_count = 0;
};

struct FunctionRange
{
   uintptr_t begin = 0;
   uintptr_t end = 0;
   size_t index = 0;
};

bool RangeInsideImage(const ImageView& image, uintptr_t rva, size_t size) noexcept
{
   return rva <= image.size && size <= image.size - rva;
}

template <typename T>
bool ReadValue(const ImageView& image, uintptr_t rva, T& value) noexcept
{
   if (!RangeInsideImage(image, rva, sizeof(T)))
      return false;
   std::memcpy(&value, reinterpret_cast<const void*>(image.base + rva), sizeof(T));
   return true;
}

bool TryBuildImageView(ImageView& image) noexcept
{
   image = {};
   if (g_image_base == 0)
      return false;

   const auto* dos = reinterpret_cast<const IMAGE_DOS_HEADER*>(g_image_base);
   if (dos->e_magic != IMAGE_DOS_SIGNATURE ||
       dos->e_lfanew < static_cast<LONG>(sizeof(IMAGE_DOS_HEADER)) ||
       dos->e_lfanew >
          static_cast<LONG>(0x100000 - sizeof(IMAGE_NT_HEADERS64)))
      return false;
   const auto* nt = reinterpret_cast<const IMAGE_NT_HEADERS64*>(
      g_image_base + static_cast<uintptr_t>(dos->e_lfanew));
   // Sanity-limit SizeOfImage: both reads above stay inside the mapped image
   // header region, so a malformed e_lfanew can never point into unmapped
   // memory (a crash would violate the fail-closed contract).
   if (nt->Signature != IMAGE_NT_SIGNATURE ||
       nt->OptionalHeader.Magic != IMAGE_NT_OPTIONAL_HDR64_MAGIC ||
       nt->OptionalHeader.SizeOfImage < 0x1000 ||
       nt->OptionalHeader.SizeOfImage > 0x20000000)
      return false;

   image.base = g_image_base;
   image.size = nt->OptionalHeader.SizeOfImage;
   image.nt = nt;
   image.sections = IMAGE_FIRST_SECTION(nt);
   image.section_count = nt->FileHeader.NumberOfSections;

   const IMAGE_SECTION_HEADER* fallback_code = nullptr;
   for (uint16_t index = 0; index < image.section_count; ++index)
   {
      const IMAGE_SECTION_HEADER& section = image.sections[index];
      if ((section.Characteristics & IMAGE_SCN_MEM_EXECUTE) == 0)
         continue;
      if (fallback_code == nullptr ||
          section.Misc.VirtualSize > fallback_code->Misc.VirtualSize)
         fallback_code = &section;
      if (std::memcmp(section.Name, ".text", 5) == 0)
      {
         fallback_code = &section;
         break;
      }
   }
   if (fallback_code == nullptr || fallback_code->Misc.VirtualSize == 0 ||
       !RangeInsideImage(
          image, fallback_code->VirtualAddress, fallback_code->Misc.VirtualSize))
      return false;
   image.code_rva = fallback_code->VirtualAddress;
   image.code_size = fallback_code->Misc.VirtualSize;

   const IMAGE_DATA_DIRECTORY& exception_directory =
      nt->OptionalHeader.DataDirectory[IMAGE_DIRECTORY_ENTRY_EXCEPTION];
   if (exception_directory.VirtualAddress == 0 ||
       exception_directory.Size < sizeof(IMAGE_RUNTIME_FUNCTION_ENTRY) ||
       !RangeInsideImage(
          image, exception_directory.VirtualAddress, exception_directory.Size))
      return false;
   image.runtime_functions =
      reinterpret_cast<const IMAGE_RUNTIME_FUNCTION_ENTRY*>(
         image.base + exception_directory.VirtualAddress);
   image.runtime_function_count =
      exception_directory.Size / sizeof(IMAGE_RUNTIME_FUNCTION_ENTRY);
   return image.runtime_function_count != 0;
}

bool IsRvaInSection(
   const ImageView& image,
   uintptr_t rva,
   size_t size,
   DWORD required,
   DWORD forbidden = 0) noexcept
{
   for (uint16_t index = 0; index < image.section_count; ++index)
   {
      const IMAGE_SECTION_HEADER& section = image.sections[index];
      const uintptr_t section_begin = section.VirtualAddress;
      const uintptr_t section_size = std::max<uintptr_t>(
         section.Misc.VirtualSize, section.SizeOfRawData);
      if ((section.Characteristics & required) != required ||
          (section.Characteristics & forbidden) != 0 || rva < section_begin ||
          rva - section_begin > section_size || size > section_size - (rva - section_begin))
         continue;
      return true;
   }
   return false;
}

template <size_t Size>
bool MatchesBytesAtRva(
   const ImageView& image,
   uintptr_t rva,
   const std::array<uint8_t, Size>& expected) noexcept
{
   return IsRvaInSection(
             image,
             rva,
             expected.size(),
             IMAGE_SCN_MEM_READ | IMAGE_SCN_MEM_EXECUTE) &&
      MatchesBytes(image.base + rva, expected);
}

bool IsReasonableObjectOffset(uintptr_t offset, size_t alignment) noexcept
{
   constexpr uintptr_t kMaximumDecodedObjectOffset = 0x200000;
   return offset != 0 && offset <= kMaximumDecodedObjectOffset &&
      alignment != 0 && (offset % alignment) == 0;
}

size_t FindPatternMatches(
   const ImageView& image,
   uintptr_t begin,
   size_t size,
   PatternView pattern,
   uintptr_t* matches,
   size_t match_capacity) noexcept
{
   if (pattern.size == 0 || size < pattern.size ||
       !RangeInsideImage(image, begin, size))
      return 0;
   size_t anchor = 0;
   while (anchor < pattern.size && pattern.mask[anchor] != 'x')
      ++anchor;
   if (anchor == pattern.size)
      return 0;

   const auto* source = reinterpret_cast<const uint8_t*>(image.base + begin);
   size_t count = 0;
   for (size_t offset = 0; offset <= size - pattern.size; ++offset)
   {
      if (source[offset + anchor] != pattern.bytes[anchor])
         continue;
      bool matched = true;
      for (size_t index = 0; index < pattern.size; ++index)
      {
         if (pattern.mask[index] == 'x' &&
             source[offset + index] != pattern.bytes[index])
         {
            matched = false;
            break;
         }
      }
      if (!matched)
         continue;
      if (count < match_capacity)
         matches[count] = begin + offset;
      ++count;
   }
   return count;
}

bool FindUniquePattern(
   const ImageView& image,
   uintptr_t begin,
   size_t size,
   PatternView pattern,
   uintptr_t& match) noexcept
{
   match = 0;
   uintptr_t candidates[2]{};
   const size_t count = FindPatternMatches(
      image, begin, size, pattern, candidates, std::size(candidates));
   if (count != 1)
      return false;
   match = candidates[0];
   return true;
}

bool DecodeRel32Call(
   const ImageView& image,
   uintptr_t call_rva,
   uintptr_t& target_rva) noexcept
{
   target_rva = 0;
   if (!RangeInsideImage(image, call_rva, 5))
      return false;
   uint8_t opcode = 0;
   int32_t displacement = 0;
   if (!ReadValue(image, call_rva, opcode) || opcode != 0xE8 ||
       !ReadValue(image, call_rva + 1, displacement))
      return false;
   const int64_t target = static_cast<int64_t>(call_rva + 5) + displacement;
   if (target < 0 || static_cast<uint64_t>(target) >= image.size)
      return false;
   target_rva = static_cast<uintptr_t>(target);
   return true;
}

bool DecodeRipTarget(
   const ImageView& image,
   uintptr_t instruction_rva,
   size_t displacement_offset,
   size_t instruction_size,
   uintptr_t& target_rva) noexcept
{
   target_rva = 0;
   if (instruction_size == 0 || displacement_offset > instruction_size ||
       sizeof(int32_t) > instruction_size - displacement_offset ||
       !RangeInsideImage(image, instruction_rva, instruction_size))
      return false;
   int32_t displacement = 0;
   if (!ReadValue(image, instruction_rva + displacement_offset, displacement))
      return false;
   const int64_t target =
      static_cast<int64_t>(instruction_rva + instruction_size) + displacement;
   if (target < 0 || static_cast<uint64_t>(target) >= image.size)
      return false;
   target_rva = static_cast<uintptr_t>(target);
   return true;
}

bool FindRuntimeFunction(
   const ImageView& image,
   uintptr_t rva,
   FunctionRange& function) noexcept
{
   function = {};
   for (size_t index = 0; index < image.runtime_function_count; ++index)
   {
      const IMAGE_RUNTIME_FUNCTION_ENTRY& candidate = image.runtime_functions[index];
      if (candidate.BeginAddress <= rva && rva < candidate.EndAddress)
      {
         function = {candidate.BeginAddress, candidate.EndAddress, index};
         return candidate.BeginAddress < candidate.EndAddress &&
            RangeInsideImage(
               image,
               candidate.BeginAddress,
               candidate.EndAddress - candidate.BeginAddress);
      }
   }
   return false;
}

size_t CountCallsTo(
   const ImageView& image,
   const FunctionRange& function,
   uintptr_t target_rva) noexcept
{
   size_t count = 0;
   for (uintptr_t cursor = function.begin;
        cursor + 5 <= function.end;
        ++cursor)
   {
      uintptr_t target = 0;
      if (DecodeRel32Call(image, cursor, target) && target == target_rva)
         ++count;
   }
   return count;
}

bool FindStatusRebuild(
   const ImageView& image,
   const FunctionRange& apply_helper,
   uintptr_t& status_rebuild_rva) noexcept
{
   status_rebuild_rva = 0;
   const size_t first = apply_helper.index > 16 ? apply_helper.index - 16 : 0;
   size_t candidate_count = 0;
   for (size_t index = first; index < apply_helper.index; ++index)
   {
      const IMAGE_RUNTIME_FUNCTION_ENTRY& entry = image.runtime_functions[index];
      FunctionRange candidate{entry.BeginAddress, entry.EndAddress, index};
      if (candidate.begin >= candidate.end ||
          !MatchesBytesAtRva(image, candidate.begin, kStatusRebuildPreflight) ||
          CountCallsTo(image, candidate, apply_helper.begin) < 2)
         continue;
      status_rebuild_rva = candidate.begin;
      ++candidate_count;
   }
   return candidate_count == 1;
}

bool ResolveMapOffsets(
   const ImageView& image,
   const FunctionRange& owner_function,
   ResolvedGameLayout& layout) noexcept
{
   uintptr_t status_map = 0;
   if (!FindUniquePattern(
          image,
          owner_function.begin,
          owner_function.end - owner_function.begin,
          kStatusMapPattern,
          status_map))
      return false;
   uint32_t status_mask = 0;
   uint32_t status_sentinel = 0;
   uint32_t status_buckets = 0;
   if (!ReadValue(image, status_map + 3, status_mask) ||
       !ReadValue(image, status_map + 13, status_sentinel) ||
       !ReadValue(image, status_map + 20, status_buckets))
      return false;

   if (!IsReasonableObjectOffset(status_sentinel, alignof(uintptr_t)) ||
       !IsReasonableObjectOffset(status_buckets, alignof(uintptr_t)) ||
       !IsReasonableObjectOffset(status_mask, alignof(uint32_t)))
      return false;
   layout.status_map_sentinel_offset = status_sentinel;
   layout.status_map_buckets_offset = status_buckets;
   layout.status_map_mask_offset = status_mask;
   return true;
}

bool ValidateResolvedGameLayout(
   const ImageView& image,
   const ResolvedGameLayout& layout) noexcept
{
   if (layout.skill_apply_loop_limit_immediate_rva < 4 ||
       layout.skill_category_loop_limit_immediate_rva < 6 ||
       !MatchesBytesAtRva(
          image,
          layout.skill_apply_loop_limit_immediate_rva - 4,
          kSkillApplyLoopPreflight) ||
       !MatchesBytesAtRva(
          image,
          layout.skill_apply_getter_return_rva,
          kSkillApplyGetterReturnPreflight) ||
       !MatchesBytesAtRva(
          image,
          layout.skill_category_loop_limit_immediate_rva - 6,
          kSkillCategoryLoopPreflight) ||
       !MatchesBytesAtRva(image, layout.skill_fetch_path_rva, kSkillFetchPreflight) ||
       !MatchesBytesAtRva(
          image,
          layout.skill_fetch_call_path_rva,
          kSkillFetchCallPathPreflight) ||
       !MatchesBytesAtRva(
          image,
          layout.skill_category_getter_return_rva,
          kSkillCategoryGetterReturnPreflight) ||
       !MatchesBytesAtRva(
          image,
          layout.get_gem_data_by_index_rva,
          kGetterPreflight) ||
       !MatchesBytesAtRva(image, layout.status_rebuild_rva, kStatusRebuildPreflight) ||
       !MatchesBytesAtRva(image, layout.status_notifier_rva, kStatusNotifierPreflight))
      return false;

   const uintptr_t writable_globals[] = {
      layout.system_data_global_rva,
      layout.status_manager_global_rva,
      layout.ui_manager_global_rva,
      layout.ui_state_source_global_rva};
   for (const uintptr_t global : writable_globals)
   {
      if (!IsRvaInSection(
             image,
             global,
             sizeof(uintptr_t),
             IMAGE_SCN_MEM_READ | IMAGE_SCN_MEM_WRITE,
             IMAGE_SCN_MEM_EXECUTE))
         return false;
   }

   if (!IsReasonableObjectOffset(
          layout.ui_selected_character_hash_offset, alignof(uint32_t)) ||
       !IsReasonableObjectOffset(layout.ui_mode_offset, alignof(uint32_t)) ||
       !IsReasonableObjectOffset(
          layout.ui_state_source_mode_offset, alignof(uint32_t)) ||
       !IsReasonableObjectOffset(
          layout.status_character_hash_offset, alignof(uint32_t)) ||
       !IsReasonableObjectOffset(
          layout.status_context_mode_offset, alignof(uint32_t)) ||
       !IsReasonableObjectOffset(
          layout.status_map_sentinel_offset, alignof(uintptr_t)) ||
       !IsReasonableObjectOffset(
          layout.status_map_buckets_offset, alignof(uintptr_t)) ||
       !IsReasonableObjectOffset(layout.status_map_mask_offset, alignof(uint32_t)))
      return false;

   uint8_t apply_limit = 0;
   uint8_t category_limit = 0;
   return ReadValue(
             image,
             layout.skill_apply_loop_limit_immediate_rva,
             apply_limit) &&
      ReadValue(
         image,
         layout.skill_category_loop_limit_immediate_rva,
         category_limit) &&
      apply_limit == layout.skill_apply_original_limit &&
      category_limit == layout.skill_category_original_limit;
}

bool FailResolution(std::string_view stage)
{
   ResetGameLayout();
   SetRuntimeMessage(std::format(
      "Game layout resolution failed at {}; gameplay hooks were not installed and persisted "
      "sigil selections were left unchanged.",
      stage));
   return false;
}
}

bool IsInWritableImageSection(uintptr_t rva, size_t size) noexcept
{
   if (g_image_base == 0 || size == 0)
      return false;
   ImageView image{};
   return TryBuildImageView(image) &&
      IsRvaInSection(
         image,
         rva,
         size,
         IMAGE_SCN_MEM_READ | IMAGE_SCN_MEM_WRITE,
         IMAGE_SCN_MEM_EXECUTE);
}

bool TryGetCodeSection(CodeSectionView& view) noexcept
{
   view = {};
   ImageView image{};
   if (!TryBuildImageView(image) || image.code_rva == 0 || image.code_size == 0 ||
       image.nt == nullptr)
      return false;
   view.rva = image.code_rva;
   view.size = image.code_size;
   view.image_size = image.size;
   view.timestamp = image.nt->FileHeader.TimeDateStamp;
   return true;
}

void ResetGameLayout() noexcept
{
   // Initialization is process-wide and guarded by g_initialize_once. Once a
   // layout is published it therefore stays immutable for the remainder of the
   // process. Revoking readiness is enough; clearing the plain struct here could
   // race a reader that acquired the previous true state immediately before a
   // shutdown or failed-install rollback.
   g_layout_ready.store(false, std::memory_order_release);
}

bool ResolveGameLayout()
{
   ResetGameLayout();
   ImageView image{};
   if (!TryBuildImageView(image))
      return FailResolution("PE image validation");

   ResolvedGameLayout layout{};

   uintptr_t apply_loop = 0;
   uintptr_t category_loop = 0;
   uintptr_t notifier = 0;
   uintptr_t owner_loop = 0;
   uintptr_t ui_mode_pair = 0;
   uintptr_t ui_character = 0;
   if (!FindUniquePattern(
          image, image.code_rva, image.code_size, kApplyLoopPattern, apply_loop) ||
       !FindUniquePattern(
          image, image.code_rva, image.code_size, kCategoryLoopPattern, category_loop) ||
       !FindUniquePattern(
          image, image.code_rva, image.code_size, kNotifierPattern, notifier) ||
       !FindUniquePattern(
          image, image.code_rva, image.code_size, kOwnerLoopPattern, owner_loop) ||
       !FindUniquePattern(
          image, image.code_rva, image.code_size, kUiModePairPattern, ui_mode_pair) ||
       !FindUniquePattern(
          image, image.code_rva, image.code_size, kUiCharacterPattern, ui_character))
      return FailResolution("unique semantic anchors");

   layout.skill_apply_loop_limit_immediate_rva = apply_loop + 4;
   layout.skill_apply_getter_return_rva = apply_loop + 0x29;
   layout.skill_category_loop_limit_immediate_rva = category_loop + 6;
   layout.skill_fetch_path_rva = category_loop + 0x1E;
   layout.skill_fetch_call_path_rva = category_loop + 0x60;
   layout.skill_category_getter_return_rva = category_loop + 0x6E;
   layout.status_notifier_rva = notifier;

   uint8_t apply_limit = 0;
   uint8_t category_limit = 0;
   uintptr_t apply_getter = 0;
   uintptr_t category_getter = 0;
   if (!ReadValue(
          image, layout.skill_apply_loop_limit_immediate_rva, apply_limit) ||
       !ReadValue(
          image, layout.skill_category_loop_limit_immediate_rva, category_limit) ||
       apply_limit != kNativeInternalSlotCount || category_limit != apply_limit ||
       !DecodeRel32Call(image, apply_loop + 0x24, apply_getter) ||
       !DecodeRel32Call(image, category_loop + 0x69, category_getter) ||
       apply_getter != category_getter)
      return FailResolution("skill loop/getter contract");
   layout.skill_apply_original_limit = apply_limit;
   layout.skill_category_original_limit = category_limit;
   layout.get_gem_data_by_index_rva = apply_getter;

   FunctionRange getter_function{};
   FunctionRange apply_helper{};
   FunctionRange owner_function{};
   if (!FindRuntimeFunction(image, apply_getter, getter_function) ||
       getter_function.begin != apply_getter ||
       !MatchesBytesAtRva(image, apply_getter, kGetterPreflight) ||
       !IsRvaInSection(
          image,
          apply_getter,
          1,
          IMAGE_SCN_MEM_READ | IMAGE_SCN_MEM_EXECUTE) ||
       !FindRuntimeFunction(image, apply_loop, apply_helper) ||
       !FindRuntimeFunction(image, owner_loop, owner_function) ||
       owner_function.begin > owner_loop ||
       !MatchesBytesAtRva(
          image, owner_function.begin, kStatusOwnerTickPreflight))
      return FailResolution("runtime-function boundaries");
   if (!FindStatusRebuild(image, apply_helper, layout.status_rebuild_rva))
      return FailResolution("status rebuild call graph");

   uintptr_t system_pattern = 0;
   if (!FindUniquePattern(
          image,
          getter_function.begin,
          getter_function.end - getter_function.begin,
          kSystemDataPattern,
          system_pattern))
      return FailResolution("SystemData getter anchor");
   uintptr_t system_data_global = 0;
   uint32_t gem_container_offset = 0;
   uint32_t repeated_gem_container_offset = 0;
   if (!DecodeRipTarget(image, system_pattern, 3, 7, system_data_global) ||
       !ReadValue(image, system_pattern + 10, gem_container_offset) ||
       !ReadValue(image, system_pattern + 17, repeated_gem_container_offset) ||
       gem_container_offset != repeated_gem_container_offset ||
       !IsReasonableObjectOffset(gem_container_offset, alignof(uintptr_t)) ||
       gem_container_offset > std::numeric_limits<uint32_t>::max() - sizeof(uintptr_t))
      return FailResolution("SystemData/global-array decoding");
   layout.system_data_global_rva = system_data_global;

   uintptr_t manager_pattern = 0;
   if (!FindUniquePattern(
          image,
          apply_helper.begin,
          apply_helper.end - apply_helper.begin,
          kStatusManagerPattern,
          manager_pattern) ||
       !DecodeRipTarget(
          image, manager_pattern, 3, 7, layout.status_manager_global_rva))
      return FailResolution("StatusManager anchor");

   if (!DecodeRipTarget(
          image, ui_mode_pair, 3, 7, layout.ui_state_source_global_rva) ||
       !DecodeRipTarget(
          image, ui_mode_pair + 7, 3, 7, layout.ui_manager_global_rva))
      return FailResolution("UI global decoding");
   uint32_t ui_mode_offset = 0;
   uint8_t source_mode_offset = 0;
   if (!ReadValue(image, ui_mode_pair + 16, source_mode_offset) ||
       !ReadValue(image, ui_mode_pair + 19, ui_mode_offset))
      return FailResolution("UI mode offsets");
   layout.ui_state_source_mode_offset = source_mode_offset;
   layout.ui_mode_offset = ui_mode_offset;
   if (!IsReasonableObjectOffset(
          layout.ui_state_source_mode_offset, alignof(uint32_t)) ||
       !IsReasonableObjectOffset(layout.ui_mode_offset, alignof(uint32_t)))
      return FailResolution("UI mode offset ranges");

   uintptr_t ui_character_global = 0;
   uint32_t selected_character_offset = 0;
   uint32_t repeated_selected_character_offset = 0;
   if (!DecodeRipTarget(image, ui_character, 3, 7, ui_character_global) ||
       ui_character_global != layout.ui_manager_global_rva ||
       !ReadValue(image, ui_character + 28, selected_character_offset) ||
       !ReadValue(
          image, ui_character + 44, repeated_selected_character_offset) ||
       selected_character_offset != repeated_selected_character_offset)
      return FailResolution("UI selected-character contract");
   layout.ui_selected_character_hash_offset = selected_character_offset;
   if (!IsReasonableObjectOffset(
          layout.ui_selected_character_hash_offset, alignof(uint32_t)))
      return FailResolution("UI selected-character offset range");

   uint32_t status_context_offset = 0;
   uint32_t status_character_offset = 0;
   uint16_t getter_context_opcode = 0;
   uint16_t notifier_character_opcode = 0;
   if (!ReadValue(image, apply_getter + 0x1F, getter_context_opcode) ||
       getter_context_opcode != 0x818B ||
       !ReadValue(image, apply_getter + 0x21, status_context_offset) ||
       !ReadValue(image, notifier + 0x45, notifier_character_opcode) ||
       notifier_character_opcode != 0x888B ||
       !ReadValue(image, notifier + 0x47, status_character_offset))
      return FailResolution("status identity offsets");
   layout.status_context_mode_offset = status_context_offset;
   layout.status_character_hash_offset = status_character_offset;
   if (!IsReasonableObjectOffset(
          layout.status_context_mode_offset, alignof(uint32_t)) ||
       !IsReasonableObjectOffset(
          layout.status_character_hash_offset, alignof(uint32_t)))
      return FailResolution("status identity offset ranges");

   if (!ResolveMapOffsets(image, owner_function, layout))
      return FailResolution("status/character map offsets");

   // Remaining map/object offsets are validated by ValidateResolvedGameLayout.

   if (!ValidateResolvedGameLayout(image, layout))
      return FailResolution("resolved layout final validation");

   g_game_layout = layout;
   g_layout_ready.store(true, std::memory_order_release);
   // 成功这一行只报"解析出来了"和"是哪个游戏构建"；四个 RVA 另起一行——只有查疑难
   // session（钩子落到了别处）时才需要，平时扫日志不该被这串地址堵住眼睛。
   Log(std::format(
      "Layout resolved and validated from semantic anchors (PE 0x{:X}).",
      image.nt->FileHeader.TimeDateStamp));
   Log(std::format(
      "  getter=0x{:X} SystemData=0x{:X} StatusManager=0x{:X} UiManager=0x{:X}",
      layout.get_gem_data_by_index_rva,
      layout.system_data_global_rva,
      layout.status_manager_global_rva,
      layout.ui_manager_global_rva));
   return true;
}

bool RevalidateGameLayout()
{
   if (!g_layout_ready.load(std::memory_order_acquire) || g_image_base == 0)
      return false;
   ImageView image{};
   return TryBuildImageView(image) &&
      ValidateResolvedGameLayout(image, g_game_layout);
}
}
