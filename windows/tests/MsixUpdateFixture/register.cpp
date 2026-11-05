#define WIN32_LEAN_AND_MEAN
#include <windows.h>
// Stable Node-API initialization ABI; this test addon only initializes Windows restart registration.
extern "C" __declspec(dllexport) int node_api_module_get_api_version_v1() { return 8; }
extern "C" __declspec(dllexport) void* napi_register_module_v1(void*, void* exports) {
    RegisterApplicationRestart(L"", RESTART_NO_CRASH | RESTART_NO_HANG | RESTART_NO_REBOOT);
    return exports;
}
