# Troubleshooting

> Parent: [User guides](./README.md)

Language: [简体中文](./troubleshooting.zh-CN.md)

Identify the failing layer before changing configuration. The project does not switch providers, models, endpoints, authentication, protocols, or install routes automatically.

## Installation problems

| Symptom | Check | Action |
| --- | --- | --- |
| Marketplace cannot be added | Git is installed and GitHub is reachable | Run `codex plugin marketplace list --json`, then retry only after resolving the Git error |
| Marketplace snapshot is stale | The configured Git source and ref are correct | Run `codex plugin marketplace upgrade openai-compatible-imagegen --json`, then inspect the reported errors |
| Plugin is not listed | Marketplace name and snapshot are present | Run `codex plugin list --available --json`, then restart Codex App or start a new CLI session |
| Plugin removal is incomplete | The installed Plugin and marketplace names are correct | Run `codex plugin remove openai-compatible-imagegen@openai-compatible-imagegen --json` before `codex plugin marketplace remove openai-compatible-imagegen --json` |
| MCP server cannot start | `node --version` is 20 or later | Install or select a supported Node runtime outside the Plugin |
| Python helper cannot start | The mapped command reports Python 3.12 or newer | On Windows check `python --version`; on macOS/Linux check `python3 --version`. Set `OPENAI_COMPATIBLE_IMAGEGEN_PYTHON` for one explicit executable. The Plugin stops on a failed preflight and does not switch commands. |
| Standalone Skill is not detected | `SKILL.md` is at the installed package root | Fix the extraction level and start a new session |
| Skills CLI update finds no project Skill | The install source in `skills-lock.json` is a local extracted directory | Keep the current install and use a new versioned ZIP directory; local copied installs are not updated by `skills update` |
| Skills CLI removal remains listed | `skills remove` reported success for a copied local Skill | Treat the CLI route as first-install only; preserve `auth.json` and use the versioned ZIP rollback flow |

## Configuration problems

| Symptom | Check | Action |
| --- | --- | --- |
| User configuration missing | Plugin user config path exists | Ask the Agent to call `initialize_image_config`, or create it from the bundled example |
| Plugin reports a missing `dist/auth.json` | A Standalone command-line entry point may have been used | Ask Codex to check configuration with the Plugin's `inspect_image_config` tool; the Plugin does not use `auth.json` in its installation directory |
| Credential missing | Configured environment variable exists in the Codex process | Set the variable without pasting its value into chat |
| Project override rejected | Project file changes only four allowed fields | Remove provider, model, endpoint, auth, timeout, concurrency, and route fields |
| Output directory rejected | Value is a safe project-relative directory | Use a relative child such as `output/imagegen/` |
| Local ignore protection rejected | The target configuration or output directory has a `.gitignore` containing only `*` | Review the existing rule; the Plugin does not overwrite incompatible local ignore files |
| Model not listed | Model exists in the active profile catalog | Add a supported model declaration; do not force an undeclared capability |

## Runtime problems

| Symptom | Meaning | Action |
| --- | --- | --- |
| An image card says the read is slow and still waiting | Reading the saved image has taken over 8 seconds; this is not a generation failure | Keep the card open. It will display the image when the original read completes, or report the actual read error. No new generation is needed |
| Provider rejects the request | The configured service returned an API error | Review the safe error code and provider logs; do not switch route automatically |
| An image tool wait times out | The wait ended but generation may continue | Query the original `jobId`; recover a lost submission reply with the original key instead of creating a duplicate. See [job recovery](./image-jobs.md) |
| Result card reports invalid data | Artifact metadata or bytes failed validation | Keep the original error and verify the installed Plugin version and build identity |
| Canvas cannot open | The artifact, binding, or editor session is unavailable | Return to the conversation and reopen the canvas from the same result. If it still fails, ask Codex to inspect the binding and error; after a Plugin update, completely quit and restart Codex |
| Canvas or image preview opens blank, then appears after resizing the panel | The panel may not have refreshed in Codex App; see the [related issue report](https://github.com/openai/codex/issues/42694) | Drag the right panel divider slightly to change its width. This only restores the display temporarily; include your Codex App version and reproduction steps when reporting the problem |
| Side panel shows the result card after switching tasks | Codex restored the inline result instead of the open canvas | Select **Continue editing** on the same card; the Plugin restores the preserved unsent draft |
| Transparency is unmet | The original succeeded but transparency checks failed | Keep the original and inspect the reported route. See [transparency settings](./configuration.md#transparency-settings) for native behavior and local-processing limits |
| Delivery is not ready | A transform or QA requirement failed | Inspect the delivery receipt; do not regenerate unless a new API request is intended |

Generation success and delivery readiness are separate. Standalone reports `delivery_ready`; the Plugin reports `deliveryReady`. A false delivery status preserves any complete API original and identifies the unmet transform, transparency, or QA condition.

## What to include in a report

- Plugin or Standalone version
- Operating system, Node version, and Python version
- Safe error code and short message
- Whether the issue occurs during install, configuration, generation, delivery, result display, or canvas editing
- Reproduction steps without credentials, signed URLs, local private paths, or user images

Use the repository's private vulnerability reporting for security issues. Use a normal issue for non-sensitive defects.
