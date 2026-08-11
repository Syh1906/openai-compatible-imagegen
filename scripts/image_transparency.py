"""Transparency planning and deterministic chroma-key processing."""

from __future__ import annotations

from collections import deque
from dataclasses import dataclass
import math
from pathlib import Path
import re
import shutil
from typing import Any

from image_png import PixelBuffer, read_png_rgba, write_png_rgba


KEY_CANDIDATES: tuple[tuple[str, tuple[int, int, int], tuple[str, ...]], ...] = (
    ("#00FF00", (0, 255, 0), ("green", "lime", "emerald", "绿色", "青绿")),
    ("#00FFFF", (0, 255, 255), ("cyan", "teal", "turquoise", "blue", "青色", "蓝色", "蓝绿")),
    ("#FFEA00", (255, 234, 0), ("yellow", "gold", "amber", "黄色", "金色")),
    ("#FF00FF", (255, 0, 255), ("magenta", "pink", "purple", "violet", "洋红", "粉色", "紫色")),
)
FULL_TOLERANCE = 56.0
BORDER_SOFT_TOLERANCE = 92.0
MATTE_OUTER_TOLERANCE = 132.0
CONTAMINATION_TOLERANCE = 160.0
REFERENCE_NEAR_TOLERANCE = 48.0
MIN_BORDER_HARD_COVERAGE = 0.60
MIN_BORDER_SOFT_COVERAGE = 0.90
MIN_TRANSPARENT_RATIO = 0.005
MIN_VISIBLE_RATIO = 0.01
MAX_VISIBLE_BORDER_RATIO = 0.10
MAX_KEY_CONTAMINATION_RATIO = 0.005
MIN_KEY_CONTAMINATION_PIXELS = 8
DESPILL_STRENGTH = 1.0


class TransparencyUnavailableError(ValueError):
    """Raised before a request when no declared transparency route matches."""


@dataclass(frozen=True)
class PromptOnlyRule:
    model: str
    mode: str
    size: str


@dataclass(frozen=True)
class TransparencyPolicy:
    prompt_only_allow: tuple[PromptOnlyRule, ...] = ()


@dataclass(frozen=True)
class TransparencyContext:
    requested: bool
    prompt: str
    model: str
    mode: str
    size: str
    postprocess_allowed: bool
    reference_paths: tuple[Path, ...] = ()


@dataclass(frozen=True)
class TransparencyPlan:
    mode: str
    prompt: str
    key_hex: str | None = None

    def to_record(self) -> dict[str, Any]:
        return {
            "requested": self.mode != "none",
            "mode": self.mode,
            "key": self.key_hex,
            "status": "pending" if self.mode != "none" else "not_requested",
            "warnings": [],
        }

    @classmethod
    def from_record(cls, value: dict[str, Any], prompt: str = "") -> "TransparencyPlan":
        return cls(
            mode=str(value.get("mode") or "none"),
            prompt=prompt,
            key_hex=str(value["key"]) if value.get("key") else None,
        )


def resolve_policy(value: Any) -> TransparencyPolicy:
    if value is None:
        return TransparencyPolicy()
    if not isinstance(value, dict):
        raise ValueError("auth.json transparency must be an object")
    rules_value = value.get("prompt_only_allow", [])
    if not isinstance(rules_value, list):
        raise ValueError("auth.json transparency.prompt_only_allow must be an array")
    rules: list[PromptOnlyRule] = []
    seen: set[tuple[str, str, str]] = set()
    for index, item in enumerate(rules_value):
        if not isinstance(item, dict):
            raise ValueError(f"auth.json transparency.prompt_only_allow[{index}] must be an object")
        model = str(item.get("model") or "").strip()
        mode = str(item.get("mode") or "").strip().lower()
        size = str(item.get("size") or "").strip().lower()
        if not model or mode not in {"generate", "edit"} or not _valid_size(size):
            raise ValueError(
                f"auth.json transparency.prompt_only_allow[{index}] requires model, "
                "mode=generate|edit, and an exact WIDTHxHEIGHT size"
            )
        key = (model, mode, size)
        if key in seen:
            raise ValueError(f"duplicate transparency prompt-only rule: {model}/{mode}/{size}")
        seen.add(key)
        rules.append(PromptOnlyRule(model=model, mode=mode, size=size))
    return TransparencyPolicy(prompt_only_allow=tuple(rules))


def resolve_plan(context: TransparencyContext, policy: TransparencyPolicy) -> TransparencyPlan:
    if not context.requested:
        return TransparencyPlan(mode="none", prompt=context.prompt)
    if context.postprocess_allowed:
        key_hex = _select_key(context.prompt, context.reference_paths)
        return TransparencyPlan(
            mode="chroma-key",
            prompt=_chroma_prompt(context.prompt, key_hex),
            key_hex=key_hex,
        )
    normalized_size = context.size.strip().lower()
    if any(
        rule.model == context.model and rule.mode == context.mode and rule.size == normalized_size
        for rule in policy.prompt_only_allow
    ):
        return TransparencyPlan(mode="prompt-alpha", prompt=_alpha_prompt(context.prompt))
    raise TransparencyUnavailableError(
        "transparent delivery is unavailable for "
        f"model={context.model}, mode={context.mode}, size={context.size}: "
        "local post-processing is disabled and no exact prompt-only rule matches. "
        "No image request was sent."
    )


def process_file(source: Path, target: Path, plan: TransparencyPlan) -> dict[str, Any]:
    source = source.expanduser().resolve()
    target = target.expanduser().resolve()
    if plan.mode == "none":
        _copy_exact(source, target)
        return _result(source, target, plan, "not_requested", {}, [])
    try:
        image = read_png_rgba(source)
        source_check = _assess(image["pixels"], image["width"], image["height"])
    except (OSError, ValueError) as exc:
        _copy_exact(source, target)
        return _result(
            source,
            target,
            plan,
            "unmet",
            {},
            [f"local_transparency_check_unavailable: {exc}; returned the original image"],
        )

    if plan.mode == "prompt-alpha":
        _copy_exact(source, target)
        if source_check["status"] == "pass":
            return _result(source, target, plan, "pass", source_check, [])
        return _result(
            source,
            target,
            plan,
            "unmet",
            source_check,
            ["alpha_prompt_unmet: the returned image has no usable transparent background; returned the original image"],
        )

    if plan.mode != "chroma-key" or not plan.key_hex:
        _copy_exact(source, target)
        return _result(
            source,
            target,
            plan,
            "unmet",
            source_check,
            [f"unsupported_transparency_mode: {plan.mode}; returned the original image"],
        )

    if source_check["status"] == "pass":
        _copy_exact(source, target)
        return _result(source, target, plan, "pass", source_check, [])

    try:
        requested_key = _parse_key(plan.key_hex)
        effective_key = _estimate_key(image["pixels"], image["width"], image["height"], requested_key)
        border_check = _border_key_coverage(
            image["pixels"],
            image["width"],
            image["height"],
            effective_key,
        )
        border_check["requested_key"] = _format_key(requested_key)
        border_check["effective_key"] = _format_key(effective_key)
        if (
            border_check["hard_coverage"] < MIN_BORDER_HARD_COVERAGE
            or border_check["soft_coverage"] < MIN_BORDER_SOFT_COVERAGE
        ):
            _copy_exact(source, target)
            checks = dict(source_check)
            checks["border_key"] = border_check
            return _result(
                source,
                target,
                plan,
                "unmet",
                checks,
                [
                    "background_not_solid: the canvas edge does not contain the requested solid key color; "
                    "returned the original image"
                ],
            )
        keyed = _edge_connected_key(
            image["pixels"],
            image["width"],
            image["height"],
            effective_key,
        )
        output_check = _assess(
            keyed,
            image["width"],
            image["height"],
            key=effective_key,
        )
        output_check["border_key"] = border_check
        if output_check["status"] != "pass":
            _copy_exact(source, target)
            return _result(
                source,
                target,
                plan,
                "unmet",
                output_check,
                ["transparent_qa_unmet: chroma-key output did not meet the transparency checks; returned the original image"],
            )
        write_png_rgba(target, image["width"], image["height"], keyed)
        return _result(source, target, plan, "pass", output_check, [], changed=True)
    except (OSError, ValueError) as exc:
        _copy_exact(source, target)
        return _result(
            source,
            target,
            plan,
            "unmet",
            source_check,
            [f"chroma_key_unavailable: {exc}; returned the original image"],
        )


def output_path(source: Path, out_dir: str | Path | None = None) -> Path:
    source = source.expanduser().resolve()
    root = Path(out_dir).expanduser().resolve() if out_dir else source.parent / f"{source.stem}-postprocess"
    return root / f"{source.stem}-transparent.png"


def unmet_result(source: Path, plan: TransparencyPlan, warning: str) -> dict[str, Any]:
    source = source.expanduser().resolve()
    return _result(source, source, plan, "unmet", {}, [warning])


def _select_key(prompt: str, reference_paths: tuple[Path, ...]) -> str:
    prompt_scores = [_prompt_conflicts(prompt, terms) for _, _, terms in KEY_CANDIDATES]
    reference_scores = _reference_color_ratios(reference_paths)
    winner = min(
        range(len(KEY_CANDIDATES)),
        key=lambda index: (prompt_scores[index], reference_scores[index], index),
    )
    return KEY_CANDIDATES[winner][0]


def _prompt_conflicts(prompt: str, terms: tuple[str, ...]) -> int:
    lowered = prompt.lower()
    count = 0
    for term in terms:
        if term.isascii():
            count += len(re.findall(rf"\b{re.escape(term)}\b", lowered))
        else:
            count += lowered.count(term)
    return count


def _reference_color_ratios(paths: tuple[Path, ...]) -> list[float]:
    matches = [0] * len(KEY_CANDIDATES)
    sampled = 0
    threshold = REFERENCE_NEAR_TOLERANCE * REFERENCE_NEAR_TOLERANCE
    for path in paths:
        try:
            image = read_png_rgba(path)
        except (OSError, ValueError):
            continue
        total = image["width"] * image["height"]
        step = max(1, math.ceil(total / 4096))
        for index in range(0, total, step):
            red, green, blue, alpha = image["pixels"][index]
            if alpha < 24:
                continue
            sampled += 1
            for candidate_index, (_, key, _) in enumerate(KEY_CANDIDATES):
                if _distance_squared((red, green, blue), key) <= threshold:
                    matches[candidate_index] += 1
    if not sampled:
        return [0.0] * len(KEY_CANDIDATES)
    return [value / sampled for value in matches]


def _chroma_prompt(prompt: str, key_hex: str) -> str:
    return (
        f"{prompt}\n\n"
        "Transparency processing contract: render the requested subject fully visible and isolated against "
        f"one uniform flat {key_hex} background. The entire background must be exactly {key_hex}, with no "
        "gradient, texture, lighting, shadow, glow, checkerboard, floor, scenery, or border. Do not use the "
        "key color on the subject, text, outline, reflections, or antialiased subject edge. Keep clear color "
        "separation and a clean margin around the subject."
    )


def _alpha_prompt(prompt: str) -> str:
    return (
        f"{prompt}\n\n"
        "Transparency delivery contract: output a PNG with a real alpha channel. Every pixel outside the "
        "requested subject must have alpha 0, not a white, black, colored, or checkerboard background. Keep "
        "only the requested subject and preserve antialiased partially transparent edge pixels. No floor, "
        "backdrop, cast shadow, glow, or ambient background. The final image must contain a real alpha channel."
    )


def _assess(
    pixels: Any,
    width: int,
    height: int,
    key: tuple[int, int, int] | None = None,
) -> dict[str, Any]:
    total = width * height
    transparent = 0
    visible = 0
    for pixel in pixels:
        alpha = pixel[3]
        transparent += alpha <= 8
        visible += alpha >= 24
    border = _border_indices(width, height)
    visible_border = sum(1 for index in border if pixels[index][3] >= 24)
    transparent_ratio = transparent / total
    visible_ratio = visible / total
    visible_border_ratio = visible_border / len(border)
    failures: list[str] = []
    if transparent_ratio < MIN_TRANSPARENT_RATIO:
        failures.append("transparent_pixel_ratio")
    if visible_ratio < MIN_VISIBLE_RATIO:
        failures.append("visible_pixel_ratio")
    if visible_border_ratio > MAX_VISIBLE_BORDER_RATIO:
        failures.append("visible_border_ratio")
    result: dict[str, Any] = {
        "status": "pass" if not failures else "unmet",
        "transparent_pixel_ratio": round(transparent_ratio, 6),
        "visible_pixel_ratio": round(visible_ratio, 6),
        "visible_border_ratio": round(visible_border_ratio, 6),
        "failures": failures,
    }
    if key is not None:
        contamination = _key_contamination(pixels, width, height, key)
        result["key_contamination"] = contamination
        if contamination["status"] != "pass":
            failures.append("key_contamination")
            result["status"] = "unmet"
    return result


def _border_key_coverage(
    pixels: Any,
    width: int,
    height: int,
    key: tuple[int, int, int],
) -> dict[str, float]:
    border = _border_indices(width, height)
    hard_limit = FULL_TOLERANCE * FULL_TOLERANCE
    soft_limit = BORDER_SOFT_TOLERANCE * BORDER_SOFT_TOLERANCE
    hard = soft = 0
    for index in border:
        red, green, blue, _ = pixels[index]
        distance = _distance_squared((red, green, blue), key)
        hard += distance <= hard_limit
        soft += distance <= soft_limit
    return {
        "hard_coverage": round(hard / len(border), 6),
        "soft_coverage": round(soft / len(border), 6),
    }


def _estimate_key(
    pixels: Any,
    width: int,
    height: int,
    requested_key: tuple[int, int, int],
) -> tuple[int, int, int]:
    border = _border_indices(width, height)
    limit = MATTE_OUTER_TOLERANCE * MATTE_OUTER_TOLERANCE
    samples = [
        pixels[index][:3]
        for index in border
        if _distance_squared(pixels[index][:3], requested_key) <= limit
    ]
    if len(samples) / max(1, len(border)) < MIN_BORDER_SOFT_COVERAGE:
        return requested_key
    return tuple(
        sorted(sample[channel] for sample in samples)[len(samples) // 2]
        for channel in range(3)
    )


def _key_contamination(
    pixels: Any,
    width: int,
    height: int,
    key: tuple[int, int, int],
) -> dict[str, Any]:
    total = width * height
    tested = 0
    contaminated = 0
    limit = CONTAMINATION_TOLERANCE * CONTAMINATION_TOLERANCE
    for index, pixel in enumerate(pixels):
        alpha = pixel[3]
        if alpha < 24:
            continue
        partial = alpha < 250
        adjacent_to_transparent = False
        x = index % width
        y = index // width
        for dx, dy in (
            (-1, -1),
            (0, -1),
            (1, -1),
            (-1, 0),
            (1, 0),
            (-1, 1),
            (0, 1),
            (1, 1),
        ):
            nx = x + dx
            ny = y + dy
            if nx < 0 or nx >= width or ny < 0 or ny >= height:
                continue
            if pixels[ny * width + nx][3] <= 8:
                adjacent_to_transparent = True
                break
        if not partial and not adjacent_to_transparent:
            continue
        tested += 1
        contaminated += _distance_squared(pixel[:3], key) <= limit
    allowed = max(MIN_KEY_CONTAMINATION_PIXELS, round(tested * MAX_KEY_CONTAMINATION_RATIO))
    return {
        "status": "pass" if contaminated <= allowed else "unmet",
        "pixels": contaminated,
        "tested_pixels": tested,
        "ratio": round(contaminated / max(1, tested), 6),
        "allowed_pixels": allowed,
        "tolerance": CONTAMINATION_TOLERANCE,
    }


def _edge_connected_key(
    pixels: Any,
    width: int,
    height: int,
    key: tuple[int, int, int],
) -> PixelBuffer:
    total = width * height
    soft_limit = MATTE_OUTER_TOLERANCE * MATTE_OUTER_TOLERANCE
    candidate = bytearray(total)
    for index, pixel in enumerate(pixels):
        distance = _distance_squared(pixel[:3], key)
        if distance <= soft_limit:
            candidate[index] = 1

    stack: deque[tuple[int, int]] = deque()
    for index in _border_indices(width, height):
        if candidate[index] == 1:
            stack.append((index % width, index // width))
    while stack:
        x, y = stack.pop()
        index = y * width + x
        if candidate[index] != 1:
            continue
        left = x
        while left > 0 and candidate[y * width + left - 1] == 1:
            left -= 1
        right = x
        while right + 1 < width and candidate[y * width + right + 1] == 1:
            right += 1
        row_start = y * width
        for current_x in range(left, right + 1):
            candidate[row_start + current_x] = 2
        for neighbor_y in (y - 1, y + 1):
            if neighbor_y < 0 or neighbor_y >= height:
                continue
            neighbor_start = neighbor_y * width
            current_x = left
            while current_x <= right:
                if candidate[neighbor_start + current_x] == 1:
                    stack.append((current_x, neighbor_y))
                    while current_x <= right and candidate[neighbor_start + current_x] == 1:
                        current_x += 1
                current_x += 1

    packed = pixels.packed() if isinstance(pixels, PixelBuffer) else bytes(channel for pixel in pixels for channel in pixel)
    output = bytearray(packed)
    for index, state in enumerate(candidate):
        if state != 2:
            continue
        offset = index * 4
        distance = math.sqrt(_distance_squared(tuple(output[offset : offset + 3]), key))
        if distance <= FULL_TOLERANCE:
            alpha = 0
        else:
            position = min(
                1.0,
                max(
                    0.0,
                    (distance - FULL_TOLERANCE)
                    / (MATTE_OUTER_TOLERANCE - FULL_TOLERANCE),
                ),
            )
            smooth = position * position * (3.0 - 2.0 * position)
            alpha = round(255 * smooth)
        alpha = min(alpha, output[offset + 3])
        if alpha <= 0:
            output[offset : offset + 4] = b"\x00\x00\x00\x00"
            continue
        output[offset + 3] = alpha
        if alpha >= 255:
            continue
        opacity = alpha / 255.0
        strength = DESPILL_STRENGTH
        estimated_channels: list[float] = []
        for channel in range(3):
            original = output[offset + channel]
            estimated = (original - (1.0 - opacity) * key[channel]) / max(opacity, 1 / 255)
            estimated_channels.append(max(0.0, min(255.0, estimated)))
        corrected = _despill_color(tuple(estimated_channels), key)
        for channel in range(3):
            original = output[offset + channel]
            output[offset + channel] = round(
                original + (corrected[channel] - original) * strength
            )
    return PixelBuffer(output)


def _border_indices(width: int, height: int) -> list[int]:
    indices = list(range(width))
    if height > 1:
        indices.extend(range((height - 1) * width, height * width))
    for y in range(1, height - 1):
        indices.append(y * width)
        if width > 1:
            indices.append(y * width + width - 1)
    return indices


def _parse_key(value: str) -> tuple[int, int, int]:
    normalized = value.strip().lstrip("#")
    if len(normalized) != 6:
        raise ValueError(f"invalid chroma key: {value}")
    try:
        red = int(normalized[0:2], 16)
        green = int(normalized[2:4], 16)
        blue = int(normalized[4:6], 16)
        return red, green, blue
    except ValueError as exc:
        raise ValueError(f"invalid chroma key: {value}") from exc


def _format_key(value: tuple[int, int, int]) -> str:
    return "#" + "".join(f"{channel:02X}" for channel in value)


def _despill_color(
    color: tuple[float, float, float],
    key: tuple[int, int, int],
) -> tuple[float, float, float]:
    key_channels = [
        channel
        for channel, value in enumerate(key)
        if value >= 128 and value - min(key) >= 64
    ]
    if not key_channels or len(key_channels) == 3:
        return color
    foreground_channels = [channel for channel in range(3) if channel not in key_channels]
    ceiling = max((color[channel] for channel in foreground_channels), default=0.0) + 16.0
    output = list(color)
    for channel in key_channels:
        output[channel] = min(output[channel], ceiling)
    return output[0], output[1], output[2]


def _distance_squared(color: tuple[int, int, int], key: tuple[int, int, int]) -> int:
    return sum((color[index] - key[index]) ** 2 for index in range(3))


def _valid_size(value: str) -> bool:
    parts = value.replace("*", "x").split("x", 1)
    if len(parts) != 2:
        return False
    try:
        return int(parts[0]) > 0 and int(parts[1]) > 0
    except ValueError:
        return False


def _copy_exact(source: Path, target: Path) -> None:
    if source == target:
        return
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(source, target)


def _result(
    source: Path,
    target: Path,
    plan: TransparencyPlan,
    status: str,
    checks: dict[str, Any],
    warnings: list[str],
    changed: bool = False,
) -> dict[str, Any]:
    return {
        "requested": plan.mode != "none",
        "mode": plan.mode,
        "key": plan.key_hex,
        "status": status,
        "source": source.as_posix(),
        "file": target.as_posix(),
        "changed": changed,
        "checks": checks,
        "warnings": warnings,
    }
