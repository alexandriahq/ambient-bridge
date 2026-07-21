# Contributing

Thank you for helping improve Ambient Bridge.

This repository is an automatically generated public mirror. Issues, review, and proposed patches are welcome here, but maintainers must port accepted source changes into the private Alexandria Ambient monorepo and publish a new snapshot. Direct changes that exist only in this repository will be overwritten by the next synchronization.

Before proposing a change, run:

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm exec vite build
```

Never include credentials, real session data, prompts, completions, recordings, screenshots, or user-identifying logs in an issue, patch, or fixture. Report suspected vulnerabilities through the private process in [SECURITY.md](SECURITY.md).
