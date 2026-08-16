<!-- updated: 2026-08-16 -->

# Troubleshooting

Identify the failing layer before changing configuration. The project does not switch providers, models, endpoints, authentication, protocols, or install routes automatically.

## Installation problems

| Symptom | Check | Action |
| --- | --- | --- |
| Marketplace cannot be added | Git is installed and GitHub is reachable | Run `codex plugin marketplace list --json`, then retry only after resolving the Git error |
| Marketplace snapshot is stale | The configured Git source and ref are correct | Run `codex plugin marketplace upgrade openai-compatible-imagegen --json`, then inspect the reported errors |
| Plugin is not listed | Marketplace name and snapshot are present | Run `codex plugin list --available --json`, then restart Codex App or start a new CLI session |
| Plugin removal is incomplete | The installed Plugin and marketplace names are correct | Run `codex plugin remove openai-compatible-imagegen@openai-compatible-imagegen --json` before `codex plugin marketplace remove openai-compatible-imagegen --json` |
| MCP server cannot start | `node --version` is 20 or later | Install or select a supported Node runtime outside the Plugin |
| Python helper cannot start | `python --version` reports 3.12 | Install or select Python 3.12 outside the Plugin |
| Standalone Skill is not detected | `SKILL.md` is at the installed package root | Fix the extraction level and start a new session |

## Configuration problems

| Symptom | Check | Action |
| --- | --- | --- |
| User configuration missing | Plugin user config path exists | Create it from the bundled example |
| Credential missing | Configured environment variable exists in the Codex process | Set the variable without pasting its value into chat |
| Project override rejected | Project file changes only four allowed fields | Remove provider, model, endpoint, auth, timeout, concurrency, and route fields |
| Output directory rejected | Value is a safe project-relative directory | Use a relative child such as `output/imagegen/` |
| Model not listed | Model exists in the active profile catalog | Add a supported model declaration; do not force an undeclared capability |

## Runtime problems

| Symptom | Meaning | Action |
| --- | --- | --- |
| Provider rejects the request | The configured service returned an API error | Review the safe error code and provider logs; do not switch route automatically |
| Result card reports invalid data | Artifact metadata or bytes failed validation | Keep the original error and verify the installed Plugin version and build identity |
| Canvas cannot open | The artifact, binding, or editor session is unavailable | Reopen from the same result in a new task only after checking runtime status |
| Transparency is unmet | The original succeeded but the selected delivery route did not meet its contract | Keep the original and choose a valid controlled plate or trusted mask |
| Delivery is not ready | A transform or QA requirement failed | Inspect the delivery receipt; do not regenerate unless a new API request is intended |

Generation success and delivery readiness are separate. Standalone reports `delivery_ready`; the Plugin reports `deliveryReady`. A false delivery status preserves any complete API original and identifies the unmet transform, transparency, or QA condition.

## What to include in a report

- Plugin or Standalone version
- Operating system, Node version, and Python version
- Safe error code and short message
- Whether the issue occurs during install, configuration, generation, delivery, result display, or canvas editing
- Reproduction steps without credentials, signed URLs, local private paths, or user images

Use the repository's private vulnerability reporting for security issues. Use a normal issue for non-sensitive defects.
