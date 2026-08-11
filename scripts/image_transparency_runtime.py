"""Host-facing transparency request planning for generate and edit commands."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from image_transparency import (
    TransparencyContext,
    TransparencyPlan,
    TransparencyPolicy,
    parse_option_assignments,
    resolve_plan,
)


def resolve_request(
    prompt: str,
    mode: str,
    params: dict[str, Any],
    args: Any,
    postprocess_config: dict[str, Any],
    policy: TransparencyPolicy,
    task: dict[str, Any],
    reference_paths: list[Path] | None = None,
) -> TransparencyPlan:
    explicit_postprocess = get_value("postprocess", args, task, None)
    postprocess_allowed = (
        bool(postprocess_config.get("enabled"))
        if explicit_postprocess is None
        else bool(explicit_postprocess)
    )
    mask_value = get_value("transparency_mask", args, task, None)
    options_value = task.get("transparency_options")
    if options_value is None:
        option_values = task.get("transparency_param")
        if option_values is None:
            option_values = getattr(args, "transparency_param", None)
        options_value = parse_option_assignments(option_values)
    context = TransparencyContext(
        requested=transparent_intent(args, task),
        prompt=prompt,
        model=str(params["model"]),
        mode=mode,
        size=str(params["size"]),
        postprocess_allowed=postprocess_allowed,
        reference_paths=tuple(reference_paths or ()),
        route=get_value("transparency_route", args, task, None),
        mask_path=Path(str(mask_value)).expanduser().resolve() if mask_value else None,
        options=options_value or {},
    )
    return resolve_plan(context, policy)


def apply_prompt_directives(
    prompt: str,
    args: Any,
    task: dict[str, Any],
    transparency_plan: TransparencyPlan | None = None,
) -> str:
    prompt = transparency_plan.prompt if transparency_plan else prompt
    directives: list[str] = []
    if bool(get_value("asset", args, task, False)):
        directives.append(
            "single visual deliverable, preserve the requested composition, "
            "no extra text unless explicitly requested"
        )
    if not directives:
        return prompt
    lower_prompt = prompt.lower()
    additions = [item for item in directives if item.lower() not in lower_prompt]
    return prompt if not additions else f"{prompt}\n\nGeneration constraints: {'; '.join(additions)}."


def transparent_intent(args: Any, task: dict[str, Any]) -> bool:
    return bool(get_value("transparent", args, task, False))


def get_value(name: str, args: Any, task: dict[str, Any], fallback: Any) -> Any:
    if name in task and task[name] not in (None, ""):
        return task[name]
    return getattr(args, name, fallback)
