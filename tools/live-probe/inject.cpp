// 把 probe.dll 注入到运行中的游戏进程（CreateRemoteThread + LoadLibraryW）。
// 用法： inject.exe granblue_fantasy_relink.exe "D:\...\probe.dll"
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <tlhelp32.h>
#include <cstdio>

static DWORD FindProcessId(const wchar_t* name)
{
   HANDLE snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
   if (snapshot == INVALID_HANDLE_VALUE)
      return 0;
   PROCESSENTRY32W entry{};
   entry.dwSize = sizeof(entry);
   DWORD pid = 0;
   if (Process32FirstW(snapshot, &entry))
   {
      do
      {
         if (_wcsicmp(entry.szExeFile, name) == 0)
         {
            pid = entry.th32ProcessID;
            break;
         }
      } while (Process32NextW(snapshot, &entry));
   }
   CloseHandle(snapshot);
   return pid;
}

int wmain(int argc, wchar_t** argv)
{
   if (argc < 3)
   {
      wprintf(L"usage: inject.exe <process.exe> <probe.dll full path>\n");
      return 2;
   }
   const DWORD pid = FindProcessId(argv[1]);
   if (pid == 0)
   {
      wprintf(L"process not found: %s\n", argv[1]);
      return 3;
   }

   const size_t bytes = (wcslen(argv[2]) + 1) * sizeof(wchar_t);
   HANDLE process = OpenProcess(
      PROCESS_CREATE_THREAD | PROCESS_QUERY_INFORMATION | PROCESS_VM_OPERATION |
         PROCESS_VM_WRITE | PROCESS_VM_READ,
      FALSE, pid);
   if (process == nullptr)
   {
      wprintf(L"OpenProcess failed: %lu\n", GetLastError());
      return 4;
   }

   void* remote = VirtualAllocEx(process, nullptr, bytes, MEM_COMMIT | MEM_RESERVE, PAGE_READWRITE);
   if (remote == nullptr)
   {
      wprintf(L"VirtualAllocEx failed: %lu\n", GetLastError());
      CloseHandle(process);
      return 5;
   }
   if (!WriteProcessMemory(process, remote, argv[2], bytes, nullptr))
   {
      wprintf(L"WriteProcessMemory failed: %lu\n", GetLastError());
      CloseHandle(process);
      return 6;
   }

   HMODULE kernel32 = GetModuleHandleW(L"kernel32.dll");
   const auto loadLibrary =
      reinterpret_cast<LPTHREAD_START_ROUTINE>(GetProcAddress(kernel32, "LoadLibraryW"));
   HANDLE thread = CreateRemoteThread(process, nullptr, 0, loadLibrary, remote, 0, nullptr);
   if (thread == nullptr)
   {
      wprintf(L"CreateRemoteThread failed: %lu\n", GetLastError());
      CloseHandle(process);
      return 7;
   }

   WaitForSingleObject(thread, 10000);
   DWORD exit_code = 0;
   GetExitCodeThread(thread, &exit_code);
   wprintf(L"injected into pid %lu (LoadLibraryW returned 0x%lX)\n", pid, exit_code);
   CloseHandle(thread);
   CloseHandle(process);
   return exit_code == 0 ? 8 : 0;
}
