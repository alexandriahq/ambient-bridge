# Build and Release Verification

Ambient Bridge publishes checksums for the files users download. For desktop apps, hash the distributable artifact:

- macOS: the `.dmg` and auto-update `.zip`
- Windows: the installer `.exe`
- updater metadata: `.blockmap` and `*.yml` files

Do not hash a raw `.app` directory directly. A directory has filesystem metadata and no single canonical byte stream. If you want a hashable macOS app bundle, use the generated `.zip` or `.dmg`.

## Build locally

Install dependencies:

```sh
pnpm install --frozen-lockfile
```

Build macOS artifacts:

```sh
CSC_IDENTITY_AUTO_DISCOVERY=false pnpm release:bundle:mac
```

Build Windows artifacts on Windows:

```sh
pnpm release:bundle:win
```

The checksum script writes:

- `dist-packaged/SHA256SUMS`
- `dist-packaged/SHA512SUMS`
- `dist-packaged/artifact-manifest.json`

Verify files against a `SHA256SUMS` file:

```sh
pnpm release:checksums -- --verify --file=dist-packaged/SHA256SUMS
```

## What should match?

The downloaded file's SHA-256 should match the published `SHA256SUMS` entry for that exact version and file name.

A self-built artifact can only have the same hash as the published download if it was built with the same source commit, lockfile, operating system, Electron builder version, signing inputs, notarization behavior, and packaging environment. Signed and notarized macOS artifacts, and signed Windows installers, will not hash-match an unsigned local build.

For public verification, compare:

1. The release tag and commit in `artifact-manifest.json`.
2. The `pnpm-lock.yaml` SHA-256 in `artifact-manifest.json`.
3. The SHA-256 of the downloaded `.dmg`, `.zip`, or `.exe` against `SHA256SUMS`.
4. A local unsigned build against its own generated `SHA256SUMS` to verify your build output has not changed after packaging.

The release pipeline should generate the files users download and the checksum files in the same job, then publish them together.
