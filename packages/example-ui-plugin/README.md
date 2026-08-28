# Example UI Plugin

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
