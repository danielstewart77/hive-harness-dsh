# dsh — an agent harness

`dsh` is a plugin-based agent harness. It uses an architecture where
**everything is a plugin**, powered by a vendored copy of
[Cordis](https://github.com/cordiverse/cordis).

## Provenance

This repository began as DeepSeek's `deepseek-harness` developer preview,
which was published under the MIT license. It is **maintained independently
and has no upstream**: there is no remote to sync from, no pull requests go
back, and the two codebases have diverged. The original copyright and license
are preserved in [LICENSE](LICENSE) and
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md), and the full commit history —
including every original author — is intact in this repository's git log.

Anything under `.agents/notes/` dated before October 2026 is an upstream design
note, kept as a historical record of why the code looks the way it does. Those
documents describe DeepSeek's decisions at the time of writing and are not
statements about this repository's current direction.

## Run from source

This harness is run from a checkout, not from `npm`.

```sh
git clone https://github.com/danielstewart77/hive-harness-dsh.git
cd hive-harness-dsh
pnpm install
pnpm run build
pnpm dsh web
```

The `web` command starts the Web UI, served at `http://127.0.0.1:3080` by
default. See the [Web UI guide](docs/user/guide/index.md).

## Hive integration

This harness is one of the harnesses a
[hive-mind](https://github.com/danielstewart77/hive-mind) edge mind can be
built on. The integration lives under `hive/`, as workspace members rather
than patches:

- **[`hive/dsh-headless-resumable`](hive/dsh-headless-resumable/README.md)** —
  a one-shot surface that runs a turn in a conversation it did not mint. The
  hive's invariant is that the gateway mints the conversation id and hands it
  to every spawn (`--session-id` for a conversation's first process, `--resume`
  for every process after it); a mind handed no id raises rather than inventing
  one. The upstream headless surface mints its own id and cannot continue
  anything, so this surface exists to expose the `create`/`resume` pair the
  agent package already had. It reports the turn as one line of JSON, never
  compacts, and stops a goal run when the hive says rotate.
- **[`hive/skills`](hive/skills/README.md)** — the skills a mind on this
  harness loads.

## Architecture

Read [docs/architecture.md](docs/architecture.md) before changing anything
under `packages/`. `vendor/` holds the vendored Cordis source; its manifest and
sync procedure are in [vendor/README.md](vendor/README.md).

## Developer preview

This harness is pre-release and iterating. **THERE WILL BE
COMPATIBILITY-BREAKING CHANGES.** On-disk formats carry no compatibility
promise: backends reject old formats outright rather than migrating them.

## Contributing and support

See [CONTRIBUTING.md](CONTRIBUTING.md). Issues and discussion belong on
[this repository's issue tracker](https://github.com/danielstewart77/hive-harness-dsh/issues) —
not DeepSeek's, which tracks a different codebase.

## License

MIT. See [LICENSE](LICENSE).
