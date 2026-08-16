# Contributing

Contributions should preserve one shared image core and two supported distribution shapes: the Standalone Skill and the Codex Plugin.

## Before changing code

Classify the change as `shared`, `standalone`, `plugin`, or a combination:

| Scope | Typical paths | Required checks |
| --- | --- | --- |
| `shared` | `scripts/` shared runtime | Standalone and Plugin adapter tests |
| `standalone` | root `SKILL.md`, `agents/`, Standalone CLI | Python tests and Standalone release checks |
| `plugin` | `mcp/`, `web/`, bundled Plugin Skill | Node tests, build, plugin check, Codex App acceptance |

Read [the architecture guide](docs/arch.md) before changing module boundaries. Use the [documentation index](docs/README.md) to find affected public guides.

## Development setup

Requirements:

- Node.js 20 or later
- npm
- Python 3.12

```bash
npm ci
npm run build
npm test
npm run check
python -m compileall -q scripts
```

Use focused tests while iterating:

```bash
node --test tests/<file>.mjs
python -m unittest tests.<module>
```

## Pull requests

- Keep the change limited to one stated outcome.
- Add a failing behavior test before implementing a feature or fix.
- Update `dist/` with `npm run build` when Plugin runtime or widget sources change.
- Include user-visible changes in `CHANGELOG.md` under `Unreleased`.
- Update affected public docs for behavior, configuration, installation, or release changes.
- Never include credentials, private provider URLs, generated images, caches, or test output.

## Release candidates

The `Build release artifacts` workflow is manually triggered for an exact commit or tag and uses the protected `release` environment. It builds and uploads the two archives, shared-core evidence, and `SHA256SUMS`; it does not create tags or GitHub Releases.

## Commit format

Use `<type>: <English summary>` with one of `feat`, `fix`, `docs`, `chore`, `refactor`, `build`, `style`, `perf`, `test`, or `ci`.
