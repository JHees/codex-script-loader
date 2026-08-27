# Bennett UI Improvements

Bennett UI Improvements is the bundled reference plugin for Codex Script Loader. It adds project-aware sidebar styling, quota display, Markdown preview enhancements, local thread actions, and a dedicated settings page without modifying the official Codex installation.

The plugin exposes a deterministic `start`/`stop` lifecycle. Script Loader implements enable, disable, and reload by starting or stopping that lifecycle, and keeps the plugin's local settings across reloads.

Open **Codex Settings → Script-Loader → Interface enhancements** to configure individual features. The canonical source, full documentation, compatibility notes, and release history live in the adjacent `better-ui-improvements-for-codex` repository.

Codex++ compatibility ended with Bennett `1.2.4`. The bundled `1.4.10` package targets Codex Script Loader only.
