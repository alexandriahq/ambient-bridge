# Ambient Bridge

Ambient Bridge is the open-source desktop bridge for Ambient. It owns browser-based sign-in, local client pairing, diagnostics, and attestation-backed encrypted inference egress between Ambient and the Alexandria service.

This repository is a standalone, buildable export of the Bridge source of truth in the Alexandria Ambient monorepo. The exact upstream commit for every snapshot is recorded in [`.ambient-source.json`](.ambient-source.json). Changes are made upstream and synchronized here; direct edits to generated source in this repository may be overwritten by the next sync.

## Development

Requirements:

- Node.js 22 or newer
- pnpm 10

Install dependencies and run the app:

```sh
pnpm install --frozen-lockfile
pnpm dev
```

Public packages preserve the production-compatible application name, local IPC location, and sign-in callback so the built source can interoperate with Ambient. Do not run an unsigned public package at the same time as an installed production Bridge, and back up local Bridge state before replacing an installed build. Public packages carry the local-QA marker, which disables auto-updates, and are verification artifacts rather than Alexandria-supported releases.

Run the standalone checks:

```sh
pnpm typecheck
pnpm test
```

Build a local macOS directory package:

```sh
pnpm build
```

The default build talks to `https://api.alexandria.so`. To deliberately bake a different server into a local build, set `AMBIENT_BRIDGE_BUILD_SERVER_URL` before running the build. There is no runtime server override in a packaged Bridge.

## Release artifact verification

Public workflows produce unsigned, inspectable build artifacts. Alexandria's production artifacts use separate managed signing and notarization infrastructure. Build local release artifacts and checksums with:

```sh
CSC_IDENTITY_AUTO_DISCOVERY=false pnpm release:bundle:mac
```

See [Build and Release Verification](docs/build-verification.md) for the checksum format and the limits of byte-for-byte reproducibility across signing environments.

## Security

Bridge must not log plaintext prompts, audio, transcripts, completions, screenshots, session tokens, or decrypted inference payloads. Its transparency UI may display bounded encrypted EHBP/HPKE request and response bodies locally, never plaintext bodies.

Please follow [SECURITY.md](SECURITY.md) when reporting a vulnerability.

Bridge stores its signed-in session using an AES-256-GCM local vault protected by a per-installation key file with owner-only permissions; it does not currently use the OS keychain. It keeps bounded local audit and crash-marker files. Launch/error telemetry is metadata-only and enabled by default when signed in; set `AMBIENT_BRIDGE_TELEMETRY=0` (also accepts `false`, `off`, or `no`) before launch to disable Bridge-originated telemetry. A previous-crash report is only sent after the next-launch consent prompt.

Bundled font notices are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## License

Ambient Bridge is available under the [MIT License](LICENSE).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). The public repository is generated, so maintainers must port accepted source changes into the monorepo before they can survive the next synchronization.
