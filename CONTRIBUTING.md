# Contributing

`dsh` is maintained independently by the owner of this repository. It descends
from DeepSeek's MIT-licensed `deepseek-harness` developer preview and has no
upstream — see [Provenance](README.md#provenance).

## Reporting issues

Open them on
[this repository's issue tracker](https://github.com/danielstewart77/hive-harness-dsh/issues).
Do not report them to DeepSeek: their tracker and discussions cover a different
codebase, and the two have diverged.

## Pull requests

This repository is pre-release and has no external consumers, so the stance is
foundation over blast radius: rename or repackage freely and update every
reference in the same change. On-disk formats carry no compatibility promise.

Before changing anything under `packages/`, read
[docs/architecture.md](docs/architecture.md). Before touching the hive
integration under `hive/`, read
[hive/dsh-headless-resumable/README.md](hive/dsh-headless-resumable/README.md) —
the conversation-id invariant it documents is the reason that surface exists,
and breaking it breaks every mind built on this harness.

Tests land with code changes.

```sh
pnpm install
pnpm run build
pnpm vitest
```

## Continuous integration

There is none, by choice. GitHub Actions is disabled on this repository and the
workflow definitions have been removed. Validation is local: run the build and
the test suites above before pushing.
