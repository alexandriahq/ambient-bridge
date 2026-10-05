# Third-party notices

Ambient Bridge's renderer bundles the following fonts through Fontsource packages:

- Inter — Copyright 2016 The Inter Project Authors. Licensed under the SIL Open Font License 1.1. Source: <https://github.com/rsms/inter>.
- STIX Two Text — Copyright 2001–2021 The STIX Fonts Project Authors. Licensed under the SIL Open Font License 1.1. Source: <https://github.com/stipub/stixfonts>.
- JetBrains Mono — Licensed under the SIL Open Font License 1.1. Source: <https://github.com/JetBrains/JetBrainsMono>.

The complete OFL 1.1 text and font-specific copyright statements are copied from the Fontsource packages into the installed application's `Resources/licenses` directory on macOS, or `resources/licenses` on Windows and Linux: `inter.txt`, `stix-two-text.txt`, and `jetbrains-mono.txt`.

Bundled JavaScript dependency notices are included inside `app.asar` at `dist/renderer/THIRD_PARTY_LICENSES.md`, `dist/electron/MAIN_THIRD_PARTY_LICENSES.md`, and `dist/electron/PRELOAD_THIRD_PARTY_LICENSES.md`. External runtime dependencies retain their license files in the packaged `node_modules` tree. They remain under their respective licenses; the repository's MIT license does not relicense third-party work.
