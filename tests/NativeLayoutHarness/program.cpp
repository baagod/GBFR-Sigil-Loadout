// 离线跑一遍生产代码的布局解析，不需要开游戏：
//   ① ResolveGameLayout() 必须成功——真实 exe 里那些锚点还认得出来；
//   ② RevalidateGameLayout() 必须过——解析结果在字节上自证；
//   ③ 把一个 hook 点上的字节翻一位 ⇒ RevalidateGameLayout() 必须失败——证明 fail-closed 真的会拒。
//
// 刻意**不**硬编码任何期望地址：游戏一更新就能直接跑（硬编码的话每次更新都要改数字）。真正保护
// "锚点跑偏"的是 ②：它比的是那些位置上的实际字节。
#include "../../GBFR.SigilLoadout.Native/native_internal.h"

#include <cstring>
#include <fstream>
#include <iostream>
#include <stdexcept>
#include <vector>

namespace gbfr::native {
// 生产代码用到的那几个外部符号（见 layout_resolver.cpp / safe_game_access.cpp）；其余 extern 声明
// 没被引用就不用给定义。
uintptr_t g_image_base = 0;
std::atomic_bool g_layout_ready{false};
std::atomic_bool g_hooks_ready{false};
ResolvedGameLayout g_game_layout{};
void Log(const std::string& message) noexcept { std::cout << message << '\n'; }
void SetRuntimeMessage(std::string message) { std::cout << message << '\n'; }
}

namespace {

// 把 PE32+ exe 按段映射进一块 SizeOfImage 大小的缓冲：解析器看到的就是"加载后"的样子。
std::vector<uint8_t> MapImage(const wchar_t* path) {
   std::ifstream stream(path, std::ios::binary | std::ios::ate);
   if (!stream)
      throw std::runtime_error("打不开这个 exe");

   std::vector<uint8_t> file(static_cast<size_t>(stream.tellg()));
   stream.seekg(0);
   if (!stream.read(reinterpret_cast<char*>(file.data()), static_cast<std::streamsize>(file.size())))
      throw std::runtime_error("读这个 exe 失败");

   const auto* dos = reinterpret_cast<const IMAGE_DOS_HEADER*>(file.data());
   if (dos->e_magic != IMAGE_DOS_SIGNATURE || dos->e_lfanew <= 0)
      throw std::runtime_error("不是有效的 PE");
   const auto* nt = reinterpret_cast<const IMAGE_NT_HEADERS64*>(file.data() + dos->e_lfanew);
   if (nt->Signature != IMAGE_NT_SIGNATURE ||
       nt->OptionalHeader.Magic != IMAGE_NT_OPTIONAL_HDR64_MAGIC)
      throw std::runtime_error("不是 PE32+");

   std::vector<uint8_t> image(nt->OptionalHeader.SizeOfImage);
   std::memcpy(image.data(), file.data(), nt->OptionalHeader.SizeOfHeaders);
   const auto* section = IMAGE_FIRST_SECTION(nt);
   for (WORD index = 0; index < nt->FileHeader.NumberOfSections; ++index) {
      std::memcpy(image.data() + section[index].VirtualAddress,
         file.data() + section[index].PointerToRawData, section[index].SizeOfRawData);
   }
   return image;
}

void Require(bool ok, const char* why) {
   if (!ok)
      throw std::runtime_error(why);
}

void CheckLayout(const wchar_t* path) {
   auto image = MapImage(path);
   gbfr::native::g_image_base = reinterpret_cast<uintptr_t>(image.data());

   Require(gbfr::native::ResolveGameLayout(),
      "生产解析器拒绝了这个 exe：锚点对不上（游戏更新了，需要重导）");
   Require(gbfr::native::RevalidateGameLayout(), "解析结果没过逐字节复验");

   image[gbfr::native::g_game_layout.skill_fetch_path_rva] ^= 0x01;
   Require(!gbfr::native::RevalidateGameLayout(),
      "改坏一个字节后仍然通过——fail-closed 没生效");
   gbfr::native::ResetGameLayout();

   std::cout << "NATIVE_LAYOUT=PASS\nNATIVE_LAYOUT_FAIL_CLOSED=PASS\n";
}

}

int wmain(int argc, wchar_t** argv) {
   try {
      if (argc < 2) {
         std::cout << "NATIVE_LAYOUT=SKIP (未给游戏 exe 路径)\n";
         return 0;
      }
      CheckLayout(argv[1]);
      return 0;
   }
   catch (const std::exception& error) {
      std::cerr << "NATIVE_LAYOUT=FAIL: " << error.what() << '\n';
      return 1;
   }
}
