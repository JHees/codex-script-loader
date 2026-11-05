#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <stdio.h>

static LRESULT CALLBACK Window(HWND window, UINT message, WPARAM wp, LPARAM lp) {
    if (message == WM_APP + 1) { RegisterApplicationRestart(L"", RESTART_NO_CRASH | RESTART_NO_HANG | RESTART_NO_REBOOT); return 0; }
    if (message == WM_CLOSE) { DestroyWindow(window); return 0; }
    if (message == WM_DESTROY) { PostQuitMessage(0); return 0; }
    return DefWindowProcW(window, message, wp, lp);
}

int wmain(int argc, wchar_t** argv) {
    if (argc != 2) return 2;
    if (FAILED(RegisterApplicationRestart(argv[1], RESTART_NO_CRASH | RESTART_NO_HANG | RESTART_NO_REBOOT))) return 3;
    WNDCLASSW type = {};
    type.lpfnWndProc = Window;
    type.hInstance = GetModuleHandleW(nullptr);
    type.lpszClassName = L"CodexScriptLoader.RestartFixture";
    RegisterClassW(&type);
    auto window = CreateWindowW(type.lpszClassName, L"Restart fixture", 0, 0, 0, 10, 10, nullptr, nullptr, type.hInstance, nullptr);
    if (!window) return 4;
    printf("%llu\n", static_cast<unsigned long long>(reinterpret_cast<ULONG_PTR>(window)));
    fflush(stdout);
    MSG message;
    while (GetMessageW(&message, nullptr, 0, 0) > 0) { TranslateMessage(&message); DispatchMessageW(&message); }
    return 0;
}
