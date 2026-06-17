# Ambient Bridge

Ambient Bridge is the standalone desktop bridge for Ambient. It owns WorkOS sign-in, local Ambient client pairing, diagnostics, and encrypted inference egress to the Ambient server and Tinfoil.

## Development

Requirements:

- Node.js 22 or newer
- pnpm 10

Install dependencies:

```sh
pnpm install
```

Run the development app:

```sh
pnpm dev
```

Run checks:

```sh
pnpm typecheck
pnpm test
```

Build a macOS directory package:

```sh
pnpm build
```

## Configuration

By default, Bridge talks to `https://api.alexandria.so`. For local development, set:

```sh
AMBIENT_SERVER_URL=http://127.0.0.1:3000
```

Release publishing uses Alexandria-managed infrastructure and requires release environment variables such as `RELEASE_ADMIN_TOKEN` and release bucket credentials.

## Security

Bridge should not log plaintext prompts, audio, transcripts, completions, screenshots, or decrypted inference payloads. The network log UI may display bounded encrypted EHBP/HPKE request and response bodies for local transparency, but never plaintext bodies.
