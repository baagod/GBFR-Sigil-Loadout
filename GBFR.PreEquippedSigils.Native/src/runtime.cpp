#include "../native_internal.h"

#include <format>

namespace gbfr::native
{
void Initialize()
{
   const uint64_t initialization_started = BeginStartupPhase("native-initialize");
   const auto finish_initialization = [initialization_started](bool succeeded) {
      CompleteStartupPhase("native-initialize", initialization_started, succeeded);
   };

   g_image_base = reinterpret_cast<uintptr_t>(GetModuleHandleW(nullptr));
   std::vector<wchar_t> module_path(32768, L'\0');
   const DWORD module_length = GetModuleFileNameW(
      g_module, module_path.data(), static_cast<DWORD>(module_path.size()));
   if (module_length == 0 || module_length >= module_path.size())
   {
      SetRuntimeMessage("Could not resolve the native core directory.");
      finish_initialization(false);
      return;
   }

   const std::filesystem::path module_directory =
      std::filesystem::path(module_path.data()).parent_path();
   // Character restrictions live in the merged tool table (gem.json):
   // exclusive rows carry a "character" field; scanned via the stable contract.
   // Keep the file name in sync with managed LoadoutConfig.cs (_sigilsPath).
   const std::filesystem::path sigils_path = module_directory / L"gem.json";

   const uint64_t executable_started = BeginStartupPhase("executable-validation");
   std::vector<wchar_t> executable_path(32768, L'\0');
   const DWORD executable_length = GetModuleFileNameW(
      nullptr, executable_path.data(), static_cast<DWORD>(executable_path.size()));
   if (executable_length == 0 || executable_length >= executable_path.size())
   {
      CompleteStartupPhase("executable-validation", executable_started, false);
      SetRuntimeMessage("Could not resolve the game executable path.");
      finish_initialization(false);
      return;
   }

   const std::filesystem::path executable(executable_path.data());
   if (_wcsicmp(executable.filename().c_str(), L"granblue_fantasy_relink.exe") != 0)
   {
      CompleteStartupPhase("executable-validation", executable_started, false);
      SetRuntimeMessage("This native core only supports granblue_fantasy_relink.exe.");
      finish_initialization(false);
      return;
   }
   CompleteStartupPhase("executable-validation", executable_started, true);

   const uint64_t restrictions_started = BeginStartupPhase("character-restrictions");
   const bool restrictions_loaded = LoadCharacterRestrictions(sigils_path);
   CompleteStartupPhase(
      "character-restrictions", restrictions_started, restrictions_loaded);
   if (!restrictions_loaded)
   {
      SetRuntimeMessage(
         "Character restrictions (gem.json) are missing or incomplete; gameplay hooks were not installed.");
      finish_initialization(false);
      return;
   }

   const uint64_t layout_started = BeginStartupPhase("semantic-layout-resolution");
   const bool layout_ready = ResolveGameLayout();
   CompleteStartupPhase("semantic-layout-resolution", layout_started, layout_ready);
   if (!layout_ready)
   {
      finish_initialization(false);
      return;
   }

   const uint64_t activation_started =
      BeginStartupPhase("template-selection-install");
   InitializeRuntimeTemplates();
   InstallDefaultTemplateSelections();
   CompleteStartupPhase(
      "template-selection-install", activation_started, true);

   const uint64_t hooks_started = BeginStartupPhase("native-hook-install");
   const bool hooks_installed = InstallHooks();
   CompleteStartupPhase("native-hook-install", hooks_started, hooks_installed);
   finish_initialization(hooks_installed);
}

void EnsureInitialized()
{
   std::call_once(g_initialize_once, &Initialize);
}

void ConsumeApplyResult()
{
   const int result = g_apply_result.exchange(ApplyResultNone, std::memory_order_acq_rel);
   if (result == ApplyResultNone)
      return;
   const uint64_t generation = g_last_apply_generation.load(std::memory_order_acquire);
   const uint32_t character_hash =
      g_last_apply_character_hash.load(std::memory_order_acquire);
   const uint32_t expected = g_last_apply_expected_count.load(std::memory_order_acquire);
   const uint32_t injected = g_last_apply_injected_count.load(std::memory_order_acquire);
   const std::string prefix =
      std::format("Generation {} for 0x{:08X}: ", generation, character_hash);
   // Each case fills only the message body; the generation prefix is applied once
   // below so no branch has to repeat it.
   std::string body;
   switch (result)
   {
   case ApplyResultAppliedDuringNativeRebuild:
      body = std::format(
         "equipment/test rebuild copied {}/{} selected virtual sigils. Combat reads the same "
         "saved selection directly from the native Trait loop.",
         injected,
         expected);
      break;
   case ApplyResultSavedNoStatus:
      body = "no valid equipment-selected character was available.";
      break;
   case ApplyResultVirtualCopyFailed:
      body = std::format(
         "native trait build ran, but only {}/{} sigils were valid, unequipped, and copied.",
         injected,
         expected);
      break;
   case ApplyResultStatusLookupFailed:
      body = "the native character status map had no matching status.";
      break;
   case ApplyResultNativeRebuildFailed:
      body = "the synchronous native status rebuild failed.";
      break;
   case ApplyResultNativeTraitLoopMissing:
      body = std::format(
         "the native status rebuild returned without completing virtual trait slots 13 through {}.",
         GetExpandedInternalSlotCount() - 1);
      break;
   case ApplyResultNotifierFailed:
      body = "traits rebuilt, but the post-rebuild native UI notifier failed.";
      break;
   default:
      break;
   }
   if (!body.empty())
      SetRuntimeMessage(prefix + body);
}
}
