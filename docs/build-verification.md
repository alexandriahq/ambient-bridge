# Build and Release Verification

Ambient Bridge generates checksums for the files users download. Hash the distributable artifact rather than a raw application directory:

- macOS: `.dmg` and auto-update `.zip`
- Windows: installer `.exe`
- updater metadata: `.blockmap` and `*.yml`

## Build locally

Install the locked dependencies:

```sh
pnpm install --frozen-lockfile
```

Build unsigned macOS artifacts and checksums:

```sh
CSC_IDENTITY_AUTO_DISCOVERY=false pnpm release:bundle:mac
```

Build unsigned Windows artifacts and checksums on Windows:

```sh
pnpm release:bundle:win
```

The checksum script writes `dist-packaged/SHA256SUMS`, `dist-packaged/SHA512SUMS`, and `dist-packaged/artifact-manifest.json`. Verify an existing SHA-256 file with:

```sh
pnpm release:checksums -- --verify --file=dist-packaged/SHA256SUMS
```

## What should match?

The downloaded file's SHA-256 should match the entry for that exact version and filename. A self-built artifact can only have the same hash as a published artifact when the source commit, lockfile, operating system, builder version, signing inputs, notarization behavior, and packaging environment are also identical.

Signed and notarized macOS artifacts and signed Windows installers will not hash-match unsigned local builds. Use `.ambient-source.json` to identify the upstream source snapshot, then compare the release commit, lockfile hash, and distributable checksum recorded in `artifact-manifest.json`.
