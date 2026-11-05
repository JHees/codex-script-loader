#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <shellapi.h>
#include <strsafe.h>

static void RegisterManagedRestart(unsigned port) noexcept {
    wchar_t current[RESTART_MAX_CMD_LINE + 1] = {};
    DWORD length = ARRAYSIZE(current), flags = 0;
    if (FAILED(GetApplicationRestartSettings(GetCurrentProcess(), current, &length, &flags))) return;

    wchar_t address[] = L"--remote-debugging-address=127.0.0.1";
    wchar_t portArgument[64] = {}, origin[96] = {};
    StringCchPrintfW(portArgument, ARRAYSIZE(portArgument), L"--remote-debugging-port=%u", port);
    StringCchPrintfW(origin, ARRAYSIZE(origin), L"--remote-allow-origins=http://127.0.0.1:%u", port);
    const wchar_t* expected[] = { address, portArgument, origin };
    const wchar_t* names[] = { L"--remote-debugging-address", L"--remote-debugging-port", L"--remote-allow-origins" };
    bool present[3] = {};
    wchar_t command[RESTART_MAX_CMD_LINE + 16] = L"codex ";
    if (FAILED(StringCchCatW(command, ARRAYSIZE(command), current))) return;
    int count = 0;
    auto arguments = CommandLineToArgvW(command, &count);
    if (!arguments) return;
    bool valid = true;
    for (int i = 1; i < count; ++i) {
        for (int key = 0; key < 3; ++key) {
            size_t size = lstrlenW(names[key]);
            if (wcsncmp(arguments[i], names[key], size) == 0 && (arguments[i][size] == 0 || arguments[i][size] == L'=')) {
                if (present[key] || wcscmp(arguments[i], expected[key]) != 0) valid = false;
                present[key] = true;
            }
        }
    }
    LocalFree(arguments);
    if (!valid) return;
    // Preserve every existing argument and restart flag; only append missing managed switches.
    for (int key = 0; key < 3; ++key) {
        if (present[key]) continue;
        if (current[0] && FAILED(StringCchCatW(current, ARRAYSIZE(current), L" "))) return;
        if (FAILED(StringCchCatW(current, ARRAYSIZE(current), expected[key]))) return;
    }
    RegisterApplicationRestart(current, flags);
}

extern "C" __declspec(dllexport) LRESULT CALLBACK RestartRegistrationHook(int code, WPARAM wp, LPARAM lp) {
    if (code >= 0) {
        auto message = reinterpret_cast<CWPSTRUCT*>(lp);
        if (message && message->message == RegisterWindowMessageW(L"CodexScriptLoader.RegisterManagedRestart.v1") &&
            message->wParam == GetCurrentProcessId() && message->lParam >= 1024 && message->lParam <= 65535)
            RegisterManagedRestart(static_cast<unsigned>(message->lParam));
    }
    return CallNextHookEx(nullptr, code, wp, lp);
}
