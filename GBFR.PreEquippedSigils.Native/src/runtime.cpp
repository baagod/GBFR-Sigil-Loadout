#include "../native_internal.h"

#include <format>

namespace gbfr::native
{
void Initialize()
{
   const uint64_t initialization_started = GetTickCount64();
   const auto finish_initialization = [initialization_started](bool succeeded) {
      CompleteStartupPhase("native-initialize", initialization_started, succeeded);
   };

   g_image_base = reinterpret_cast<uintptr_t>(GetModuleHandleW(nullptr));

   const uint64_t executable_started = GetTickCount64();
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

   const uint64_t layout_started = GetTickCount64();
   const bool layout_ready = ResolveGameLayout();
   CompleteStartupPhase("semantic-layout-resolution", layout_started, layout_ready);
   if (!layout_ready)
   {
      finish_initialization(false);
      return;
   }

   const uint64_t activation_started = GetTickCount64();
   InitializeRuntimeTemplates();
   // 钩子还没装好，所以这一步只发布选择、不排重建（PublishTemplateSelections 自己判）。
   PublishTemplateSelections();
   CompleteStartupPhase(
      "template-selection-install", activation_started, true);

   // 热应用要用的那个槽必须在 InstallHooks() 之前解析——我们自己装的 safetyhook 会改写
   // .text，锚点要在没被改写的字节上匹配。它与钩子装没装成也无关，所以不拿 hooks_installed
   // 当门。
   ResolveTableSlot();

   const uint64_t hooks_started = GetTickCount64();
   const bool hooks_installed = InstallHooks();
   CompleteStartupPhase("native-hook-install", hooks_started, hooks_installed);
   finish_initialization(hooks_installed);
}

void EnsureInitialized()
{
   std::call_once(g_initialize_once, &Initialize);
}
}
