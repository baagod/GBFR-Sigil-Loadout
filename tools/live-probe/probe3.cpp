// 运行中探针 v3（只读）。在 v2 基础上加两件事：
//   1) peek=0xADDR,0x200      → 十六进制 dump 指定地址（多行可写多个）
//   2) find                   → 遍历已提交可读内存，按 probe-hashes.txt 里的 u32 值搜索，
//                               报告每个值的出现地址（用来找"同一个角色的另一份 status"）
// 命令文件： probe3-command.txt    输出： probe3-status.txt / probe3-peek.txt / probe3-find.txt
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <cstdio>
#include <cstdint>
#include <cstring>
#include <string>
#include <vector>
#include <map>
#include <fstream>
#include <sstream>

namespace
{
// 命令/输出文件就放在本 DLL 旁边（DllMain 里按模块路径算出来）：换目录、换机器都不用改代码。
std::string g_dir;
// 要探的那个"全局槽"的 RVA。默认值是本次实测的 UiManager 全局——**它随游戏构建变化**，
// 所以真正要用时用 `rva=0x...` 命令传进来，别指望这个默认值长期有效。
uintptr_t g_slot_rva = 0x7C49640;
uintptr_t g_configured_offset = 0;
uintptr_t g_scan_window = 0x2000;
std::string g_tag = "probe3";
volatile bool g_stop = false;
volatile bool g_find_requested = false;
std::vector<uintptr_t> g_peeks;

std::string Path(const char* suffix)
{
   return g_dir + g_tag + suffix;
}

std::string Timestamp()
{
   SYSTEMTIME st{};
   GetLocalTime(&st);
   char buffer[64]{};
   sprintf_s(buffer, "%02d:%02d:%02d.%03d", st.wHour, st.wMinute, st.wSecond, st.wMilliseconds);
   return buffer;
}

void LogLine(const std::string& text)
{
   std::ofstream out(Path("-probe.log"), std::ios::app);
   out << "[" << Timestamp() << "] " << text << "\n";
}

bool ReadAll(const std::string& path, std::string& out)
{
   std::ifstream in(path, std::ios::binary);
   if (!in)
      return false;
   std::ostringstream buffer;
   buffer << in.rdbuf();
   out = buffer.str();
   return true;
}

std::vector<uint32_t> LoadHashes()
{
   std::vector<uint32_t> hashes;
   std::string text;
   if (!ReadAll(g_dir + "probe-hashes.txt", text))
      return hashes;
   std::istringstream stream(text);
   std::string token;
   while (stream >> token)
      if (!token.empty() && token[0] != '#')
         hashes.push_back(static_cast<uint32_t>(strtoul(token.c_str(), nullptr, 16)));
   return hashes;
}

bool ReadU32(uintptr_t address, uint32_t& value)
{
   __try
   {
      value = *reinterpret_cast<volatile uint32_t*>(address);
      return true;
   }
   __except (EXCEPTION_EXECUTE_HANDLER)
   {
      value = 0;
      return false;
   }
}

bool ReadU64(uintptr_t address, uint64_t& value)
{
   __try
   {
      value = *reinterpret_cast<volatile uint64_t*>(address);
      return true;
   }
   __except (EXCEPTION_EXECUTE_HANDLER)
   {
      value = 0;
      return false;
   }
}

// 整块读取（SEH 包一次），扫描要比逐 dword 快得多。
bool ReadBlock(uintptr_t address, void* buffer, size_t bytes)
{
   __try
   {
      memcpy(buffer, reinterpret_cast<const void*>(address), bytes);
      return true;
   }
   __except (EXCEPTION_EXECUTE_HANDLER)
   {
      return false;
   }
}

void WriteStatus()
{
   const uintptr_t base = reinterpret_cast<uintptr_t>(GetModuleHandleW(nullptr));
   const uintptr_t slot = base + g_slot_rva;
   std::ostringstream out;
   out << "time=" << Timestamp() << "\n";
   out << "base=0x" << std::hex << base << " rva=0x" << g_slot_rva << "\n";
   uint64_t manager = 0;
   const bool ok = ReadU64(slot, manager);
   out << "slot=0x" << slot << " ok=" << (ok ? 1 : 0)
       << " slot_value=0x" << manager << "\n";
   if (ok && manager != 0)
   {
      uint32_t value = 0;
      if (g_configured_offset != 0 && ReadU32(static_cast<uintptr_t>(manager + g_configured_offset), value))
         out << "offset_value=0x" << value << " (offset=0x" << g_configured_offset << ")\n";
      out << "candidates:\n";
      const std::vector<uint32_t> hashes = LoadHashes();
      for (uintptr_t offset = 0; offset < g_scan_window; offset += 4)
      {
         uint32_t candidate = 0;
         if (!ReadU32(static_cast<uintptr_t>(manager + offset), candidate))
            break;
         for (uint32_t hash : hashes)
            if (candidate == hash)
               out << "  0x" << offset << " = 0x" << candidate << "\n";
      }
   }
   std::ofstream file(Path("-status.txt"), std::ios::trunc);
   file << out.str();
}

void WritePeeks()
{
   std::ofstream out(Path("-peek.txt"), std::ios::trunc);
   for (uintptr_t address : g_peeks)
   {
      out << "=== 0x" << std::hex << address << " ===\n";
      const size_t chunk = 0x100;
      for (size_t done = 0; done < 0x200; done += chunk)
      {
         unsigned char buffer[0x100];
         if (!ReadBlock(address + done, buffer, chunk))
         {
            out << "  unreadable at +0x" << done << "\n";
            break;
         }
         for (size_t row = 0; row < chunk; row += 16)
         {
            char line[128];
            int written = sprintf_s(line, "%04zX  ", done + row);
            for (size_t i = 0; i < 16; ++i)
               written += sprintf_s(line + written, sizeof(line) - written, "%02X ", buffer[row + i]);
            written += sprintf_s(line + written, sizeof(line) - written, " ");
            for (size_t i = 0; i < 16; ++i)
            {
               const unsigned char ch = buffer[row + i];
               line[written++] = (ch >= 32 && ch < 127) ? static_cast<char>(ch) : '.';
            }
            line[written] = 0;
            out << line << "\n";
         }
      }
   }
}

void RunFind()
{
   const std::vector<uint32_t> hashes = LoadHashes();
   std::map<uint32_t, std::vector<uintptr_t>> hits;
   for (uint32_t hash : hashes)
      hits[hash];

   SYSTEM_INFO info{};
   GetSystemInfo(&info);
   uintptr_t address = reinterpret_cast<uintptr_t>(info.lpMinimumApplicationAddress);
   const uintptr_t maxAddress = reinterpret_cast<uintptr_t>(info.lpMaximumApplicationAddress);
   const size_t budget = 2ull << 30; // 最多扫 2 GB，避免久留
   size_t scanned = 0;
   size_t regions = 0;
   const uint64_t started = GetTickCount64();
   std::vector<unsigned char> buffer(64 * 1024);

   MEMORY_BASIC_INFORMATION mbi{};
   while (address < maxAddress &&
          VirtualQuery(reinterpret_cast<LPCVOID>(address), &mbi, sizeof(mbi)) == sizeof(mbi))
   {
      const uintptr_t base = reinterpret_cast<uintptr_t>(mbi.BaseAddress);
      const size_t size = mbi.RegionSize;
      const DWORD readable = PAGE_READONLY | PAGE_READWRITE | PAGE_EXECUTE_READ | PAGE_EXECUTE_READWRITE;
      if (mbi.State == MEM_COMMIT && (mbi.Protect & readable) != 0 &&
          (mbi.Protect & PAGE_GUARD) == 0 && size <= (128ull << 20) &&
          base >= 0x10000000000ull && scanned < budget)
      {
         ++regions;
         for (uintptr_t offset = 0; offset + 4 <= size; offset += buffer.size())
         {
            const size_t chunk = (size - offset) < buffer.size() ? (size - offset) : buffer.size();
            if (!ReadBlock(base + offset, buffer.data(), chunk))
               break;
            scanned += chunk;
            for (size_t i = 0; i + 4 <= chunk; i += 4)
            {
               uint32_t value = 0;
               memcpy(&value, buffer.data() + i, 4);
               auto iterator = hits.find(value);
               if (iterator != hits.end() && iterator->second.size() < 64)
                  iterator->second.push_back(base + offset + i);
            }
            if (scanned >= budget)
               break;
         }
      }
      address = base + size;
   }

   std::ofstream out(Path("-find.txt"), std::ios::trunc);
   out << "scanned_mb=" << (scanned >> 20) << " regions=" << regions
       << " elapsed_ms=" << (GetTickCount64() - started) << "\n";
   for (auto& [hash, addresses] : hits)
   {
      out << "0x" << std::hex << hash << " hits=" << std::dec << addresses.size() << "\n";
      for (uintptr_t found : addresses)
         out << "  0x" << std::hex << found << "\n";
   }
   LogLine("find done");
}

DWORD WINAPI ProbeThread(void*)
{
   LogLine("probe v3 thread started (read-only)");
   std::string last_command;
   while (!g_stop)
   {
      std::string command;
      if (ReadAll(Path("-command.txt"), command) && command != last_command)
      {
         last_command = command;
         g_peeks.clear();
         std::istringstream stream(command);
         std::string line;
         while (std::getline(stream, line))
         {
            if (line.rfind("rva=", 0) == 0)
               g_slot_rva = static_cast<uintptr_t>(strtoull(line.c_str() + 4, nullptr, 0));
            else if (line.rfind("offset=", 0) == 0)
               g_configured_offset = static_cast<uintptr_t>(strtoull(line.c_str() + 7, nullptr, 0));
            else if (line.rfind("scan=", 0) == 0)
               g_scan_window = static_cast<uintptr_t>(strtoull(line.c_str() + 5, nullptr, 0));
            else if (line.rfind("peek=", 0) == 0)
               g_peeks.push_back(static_cast<uintptr_t>(strtoull(line.c_str() + 5, nullptr, 0)));
            else if (line.rfind("find", 0) == 0)
               g_find_requested = true;
            else if (line.rfind("stop", 0) == 0)
               g_stop = true;
         }
         WriteStatus();
         if (!g_peeks.empty())
            WritePeeks();
         if (g_find_requested)
         {
            g_find_requested = false;
            RunFind();
         }
      }
      WriteStatus();
      Sleep(500);
   }
   LogLine("probe v3 thread stopped");
   return 0;
}
} // namespace

BOOL APIENTRY DllMain(HMODULE module, DWORD reason, LPVOID)
{
   if (reason == DLL_PROCESS_ATTACH)
   {
      DisableThreadLibraryCalls(module);
      wchar_t path[MAX_PATH]{};
      GetModuleFileNameW(module, path, MAX_PATH);
      std::wstring name(path);
      const size_t slash = name.find_last_of(L"\\/");
      const size_t dot = name.find_last_of(L'.');
      const size_t begin = slash == std::wstring::npos ? 0 : slash + 1;
      std::wstring stem = name.substr(begin, (dot == std::wstring::npos ? name.size() : dot) - begin);
      std::string tag;
      for (wchar_t ch : stem)
         tag.push_back(static_cast<char>(ch));
      if (!tag.empty())
         g_tag = tag;
      // 目录 = 本 DLL 所在目录（含结尾反斜杠）：命令与输出都落在这儿。
      if (slash != std::wstring::npos)
      {
         std::string dir;
         for (size_t index = 0; index <= slash; ++index)
            dir.push_back(static_cast<char>(name[index]));
         g_dir = dir;
      }
      HANDLE thread = CreateThread(nullptr, 0, &ProbeThread, nullptr, 0, nullptr);
      if (thread != nullptr)
         CloseHandle(thread);
   }
   return TRUE;
}
