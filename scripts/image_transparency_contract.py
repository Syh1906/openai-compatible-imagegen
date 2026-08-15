"""Plugin-facing transparency requests and path-free artifact records."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any

from image_transparency import (
    LOCAL_ROUTES,
    TransparencyContext,
    TransparencyPlan,
    TransparencyPolicy,
    resolve_plan,
)


REQUEST_KEYS = {"route", "options", "maskImageId"}


@dataclass(frozen=True)
class ResolvedTransparency:
    plan: TransparencyPlan
    record: dict[str, Any]
    mask_image_id: str | None = None


def resolve_transparency_request(
    value: Any,
    *,
    prompt: str,
    model: str,
    mode: str,
    size: str,
    postprocess_enabled: bool,
    policy: TransparencyPolicy,
    reference_paths: tuple[Path, ...] = (),
    mask_path: Path | None = None,
) -> ResolvedTransparency:
    request = parse_transparency_request(value)
    route = request.get("route")
    mask_image_id = request.get("maskImageId")
    postprocess_allowed = bool(postprocess_enabled) or route in LOCAL_ROUTES
    plan = resolve_plan(
        TransparencyContext(
            requested=True,
            prompt=prompt,
            model=model,
            mode=mode,
            size=size,
            postprocess_allowed=postprocess_allowed,
            reference_paths=reference_paths,
            route=route,
            mask_path=mask_path,
            options=request.get("options") or {},
        ),
        policy,
    )
    if mask_image_id is not None and plan.mode != "mask-alpha":
        raise ValueError("maskImageId is only valid for the mask-alpha transparency route")
    return ResolvedTransparency(
        plan=plan,
        record=transparency_storage_record(plan, mask_image_id),
        mask_image_id=mask_image_id,
    )


def parse_transparency_request(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ValueError("transparency must be an object")
    unknown = sorted(set(value) - REQUEST_KEYS)
    if unknown:
        raise ValueError(f"unsupported transparency option: {unknown[0]}")
    route_value = value.get("route")
    route = str(route_value).strip().lower() if route_value not in (None, "") else None
    options = value.get("options")
    if options is None:
        options = {}
    if not isinstance(options, dict):
        raise ValueError("transparency.options must be an object")
    mask_image_id = value.get("maskImageId")
    if mask_image_id is not None and (
        not isinstance(mask_image_id, str) or not mask_image_id.strip()
    ):
        raise ValueError("transparency.maskImageId must be a stable image ID")
    return {
        "route": route,
        "options": dict(options),
        "maskImageId": mask_image_id.strip() if isinstance(mask_image_id, str) else None,
    }


def transparency_storage_record(
    plan: TransparencyPlan,
    mask_image_id: str | None = None,
) -> dict[str, Any]:
    record = plan.to_record()
    record.pop("mask", None)
    if mask_image_id is not None:
        record["maskImageId"] = mask_image_id
    return record


def restore_transparency_plan(
    value: Any,
    *,
    prompt: str,
    mask_path: Path | None = None,
) -> ResolvedTransparency:
    if not isinstance(value, dict):
        raise ValueError("stored transparency plan must be an object")
    mask_image_id = value.get("maskImageId")
    if mask_image_id is not None and (
        not isinstance(mask_image_id, str) or not mask_image_id.strip()
    ):
        raise ValueError("stored transparency mask image ID is invalid")
    plan_value = dict(value)
    plan_value.pop("maskImageId", None)
    plan_value.pop("mask", None)
    if mask_path is not None:
        plan_value["mask"] = mask_path.as_posix()
    plan = TransparencyPlan.from_record(plan_value, prompt)
    if plan.mode == "mask-alpha" and mask_path is None:
        raise ValueError("stored mask-alpha plan requires its stable mask image")
    return ResolvedTransparency(
        plan=plan,
        record=transparency_storage_record(plan, mask_image_id),
        mask_image_id=mask_image_id.strip() if isinstance(mask_image_id, str) else None,
    )
