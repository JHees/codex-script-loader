# Example UI Plugin

The development composer example is off by default. Enable it in this plugin's
settings to show an **Example context** button on a supported existing local task.
Clicking it adds a visible instruction to the draft; it never sends the message.
Disabling the example removes an unchanged owned instruction. If you edited the
instruction yourself, remove that text manually. New-task draft binding and live
submission acceptance are not implemented by this example.

This Loader-owned package is a deliberately small reference implementation for
Codex Script Loader. It demonstrates:

- renderer-only manifest metadata and permissions;
- a deterministic global `stop()` lifecycle for reload and disable;
- a plugin-declared settings page;
- Loader-scoped local storage;
- reversible DOM and style contributions.

The optional status badge is disabled by default. The example has no dependency
on any external plugin repository and is versioned only with this package.

Third-party plugins should be developed, tested, released, and installed from
their own repositories. They must not be copied into this directory.
