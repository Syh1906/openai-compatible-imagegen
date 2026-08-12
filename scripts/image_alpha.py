"""Shared deterministic alpha-matte extraction, refinement, and edge cleanup."""

from __future__ import annotations

from collections import deque
import math
from typing import Any

from image_png import PixelBuffer


KEY_SPILL_THRESHOLD = 18.0


def edge_connected_color_alpha(
    pixels: Any,
    width: int,
    height: int,
    key: tuple[int, int, int],
    inner_tolerance: float,
    outer_tolerance: float,
    *,
    scope: str = "edge-connected",
) -> tuple[bytearray, dict[str, Any]]:
    """Build an 8-bit foreground alpha matte from a bounded key-color range."""
    total = width * height
    if width < 1 or height < 1 or len(pixels) != total:
        raise ValueError("pixel buffer does not match image dimensions")
    if scope not in {"edge-connected", "global"}:
        raise ValueError(f"unsupported color range scope: {scope}")
    packed = _packed(pixels)
    key_red, key_green, key_blue = key
    soft_limit = outer_tolerance * outer_tolerance
    candidate = bytearray(total)
    for index in range(total):
        offset = index * 4
        distance = (
            (packed[offset] - key_red) ** 2
            + (packed[offset + 1] - key_green) ** 2
            + (packed[offset + 2] - key_blue) ** 2
        )
        if distance <= soft_limit:
            candidate[index] = 1

    if scope == "global":
        connected = candidate.count(1)
        for index, state in enumerate(candidate):
            if state == 1:
                candidate[index] = 2
    else:
        stack: deque[tuple[int, int]] = deque()
        for index in _border_indices(width, height):
            if candidate[index] == 1:
                stack.append((index % width, index // width))
        connected = 0
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
                connected += 1
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

    alpha = bytearray(packed[3::4])
    partial = 0
    transparent = 0
    for index, state in enumerate(candidate):
        if state != 2:
            continue
        offset = index * 4
        distance = math.sqrt(
            (packed[offset] - key_red) ** 2
            + (packed[offset + 1] - key_green) ** 2
            + (packed[offset + 2] - key_blue) ** 2
        )
        if distance <= inner_tolerance:
            value = 0
        else:
            position = min(
                1.0,
                max(0.0, (distance - inner_tolerance) / (outer_tolerance - inner_tolerance)),
            )
            value = round(255 * position * position * (3.0 - 2.0 * position))
        alpha[index] = min(alpha[index], value)
        transparent += alpha[index] == 0
        partial += 0 < alpha[index] < 255
    return alpha, {
        "method": "edge-connected-color-range",
        "scope": scope,
        "alpha_bits": 8,
        "candidate_pixels": candidate.count(1) + connected,
        "edge_connected_pixels": connected,
        "transparent_pixels": transparent,
        "partial_alpha_pixels": partial,
        "inner_tolerance": inner_tolerance,
        "outer_tolerance": outer_tolerance,
    }


def refine_alpha(
    values: bytearray,
    width: int,
    height: int,
    *,
    threshold: float | None = None,
    expand: int = 0,
    feather: int = 0,
    gamma: float = 1.0,
    min_component_area: int = 0,
) -> tuple[bytearray, dict[str, Any]]:
    """Refine a continuous 8-bit alpha channel without interpreting image semantics."""
    if width < 1 or height < 1 or len(values) != width * height:
        raise ValueError("alpha buffer does not match image dimensions")
    alpha = bytearray(values)
    if threshold is not None:
        for index, value in enumerate(alpha):
            alpha[index] = 255 if value >= threshold else 0
    removed_components = 0
    removed_pixels = 0
    if min_component_area > 1:
        removed_components, removed_pixels = _remove_small_components(
            alpha,
            width,
            height,
            min_component_area,
        )
    if expand:
        alpha = _extreme_filter(alpha, width, height, abs(expand), maximum=expand > 0)
    if feather:
        alpha = _box_blur(alpha, width, height, feather)
    if gamma != 1.0:
        for index, value in enumerate(alpha):
            alpha[index] = round(255 * ((value / 255) ** gamma))
    return alpha, {
        "alpha_bits": 8,
        "threshold": threshold,
        "expand": expand,
        "feather": feather,
        "gamma": gamma,
        "min_component_area": min_component_area,
        "removed_components": removed_components,
        "removed_pixels": removed_pixels,
    }


def compose_with_alpha(pixels: Any, alpha: bytearray) -> PixelBuffer:
    """Apply a foreground alpha channel while preserving any stricter source alpha."""
    if len(pixels) != len(alpha):
        raise ValueError("alpha buffer does not match pixel buffer")
    output = bytearray(_packed(pixels))
    for index, mask_alpha in enumerate(alpha):
        offset = index * 4
        value = min(output[offset + 3], mask_alpha)
        if value <= 0:
            output[offset : offset + 4] = b"\x00\x00\x00\x00"
        else:
            output[offset + 3] = value
    return PixelBuffer(output)


def remove_matte_and_defringe(
    pixels: Any,
    alpha: bytearray,
    width: int,
    height: int,
    matte: tuple[int, int, int],
    *,
    tolerance: float,
    defringe_radius: int,
    strength: float = 1.0,
    mode: str = "background-matte",
    clean_opaque_edges: bool = True,
) -> tuple[PixelBuffer, dict[str, Any]]:
    """Remove antialias matte color and replace contaminated outer-edge colors."""
    if width < 1 or height < 1 or len(pixels) != width * height or len(alpha) != len(pixels):
        raise ValueError("alpha cleanup buffers do not match image dimensions")
    output = bytearray(_packed(pixels))
    unmatte_pixels = 0
    for offset, mask_alpha in zip(range(0, len(output), 4), alpha):
        value = min(output[offset + 3], mask_alpha)
        if value <= 0:
            output[offset : offset + 4] = b"\x00\x00\x00\x00"
            continue
        output[offset + 3] = value
        if value >= 255 or strength <= 0:
            continue
        opacity = value / 255.0
        estimated = []
        for channel in range(3):
            original = output[offset + channel]
            foreground = (original - (1.0 - opacity) * matte[channel]) / max(
                opacity,
                1 / 255,
            )
            estimated.append(max(0.0, min(255.0, foreground)))
        corrected = _suppress_matte(tuple(estimated), matte)
        for channel in range(3):
            original = output[offset + channel]
            output[offset + channel] = round(
                original + (corrected[channel] - original) * strength
            )
        unmatte_pixels += 1

    tolerance_squared = tolerance * tolerance
    matte_red, matte_green, matte_blue = matte
    spill_mask = _key_spill_mask(matte)
    reliable = bytearray(width * height)
    reliable_count = 0
    for index in range(width * height):
        offset = index * 4
        if output[offset + 3] < 250:
            continue
        distance = (
            (output[offset] - matte_red) ** 2
            + (output[offset + 1] - matte_green) ** 2
            + (output[offset + 2] - matte_blue) ** 2
        )
        spill = _profiled_key_spill_score(
            output[offset],
            output[offset + 1],
            output[offset + 2],
            spill_mask,
        )
        if distance > tolerance_squared and spill < KEY_SPILL_THRESHOLD:
            reliable[index] = 1
            reliable_count += 1

    if reliable_count == 0 or defringe_radius <= 0 or strength <= 0:
        unresolved = _count_defringe_candidates(
            output,
            alpha,
            width,
            height,
            matte,
            tolerance_squared,
            spill_mask,
            clean_opaque_edges,
        )
        strategy = (
            "skipped-no-reliable-color"
            if reliable_count == 0
            else "skipped-disabled"
        )
        return PixelBuffer(output), {
            "mode": mode,
            "matte": _format_color(matte),
            "unmatte_pixels": unmatte_pixels,
            "defringe": {
                "radius": defringe_radius,
                "pixels": 0,
                "spill_pixels": 0,
                "unresolved_pixels": unresolved,
                "tolerance": tolerance,
                "spill_threshold": KEY_SPILL_THRESHOLD,
                "opaque_edge_cleanup": clean_opaque_edges,
                "search_strategy": strategy,
            },
        }

    left_distances, right_distances = _reliable_row_distances(
        reliable,
        width,
        height,
        defringe_radius,
    )

    replaced = 0
    unresolved = 0
    spill_pixels = 0
    for index in range(width * height):
        offset = index * 4
        value = output[offset + 3]
        if value < 24:
            continue
        distance = (
            (output[offset] - matte_red) ** 2
            + (output[offset + 1] - matte_green) ** 2
            + (output[offset + 2] - matte_blue) ** 2
        )
        spill = _profiled_key_spill_score(
            output[offset],
            output[offset + 1],
            output[offset + 2],
            spill_mask,
        )
        direct_match = distance <= tolerance_squared
        spill_match = spill >= KEY_SPILL_THRESHOLD
        if not direct_match and not spill_match:
            continue
        if value >= 250:
            if not clean_opaque_edges:
                continue
            if not _adjacent_to_transparent(alpha, index, width, height):
                continue
        replacement = _nearest_reliable_color_from_rows(
            output,
            left_distances,
            right_distances,
            index,
            width,
            height,
            defringe_radius,
        )
        if replacement is None or strength <= 0:
            unresolved += 1
            continue
        for channel in range(3):
            original = output[offset + channel]
            output[offset + channel] = round(
                original + (replacement[channel] - original) * strength
            )
        replaced += 1
        spill_pixels += spill_match
    return PixelBuffer(output), {
        "mode": mode,
        "matte": _format_color(matte),
        "unmatte_pixels": unmatte_pixels,
        "defringe": {
            "radius": defringe_radius,
            "pixels": replaced,
            "spill_pixels": spill_pixels,
            "unresolved_pixels": unresolved,
            "tolerance": tolerance,
            "spill_threshold": KEY_SPILL_THRESHOLD,
            "opaque_edge_cleanup": clean_opaque_edges,
            "search_strategy": "row-distance-map",
        },
    }


def key_spill_score(
    red: int,
    green: int,
    blue: int,
    key: tuple[int, int, int],
) -> float:
    """Measure key-channel dominance independently from absolute RGB distance."""
    return _profiled_key_spill_score(red, green, blue, _key_spill_mask(key))


def _key_spill_mask(key: tuple[int, int, int]) -> int:
    minimum_key = min(key)
    mask = 0
    for channel, value in enumerate(key):
        if value >= 128 and value - minimum_key >= 64:
            mask |= 1 << channel
    return mask if mask not in {0, 7} else 0


def _profiled_key_spill_score(red: int, green: int, blue: int, mask: int) -> float:
    if mask == 1:
        return float(red - max(green, blue))
    if mask == 2:
        return float(green - max(red, blue))
    if mask == 4:
        return float(blue - max(red, green))
    if mask == 3:
        return float(min(red, green) - blue)
    if mask == 5:
        return float(min(red, blue) - green)
    if mask == 6:
        return float(min(green, blue) - red)
    return 0.0


def _remove_small_components(
    alpha: bytearray,
    width: int,
    height: int,
    minimum_area: int,
) -> tuple[int, int]:
    visited = bytearray(len(alpha))
    removed_components = 0
    removed_pixels = 0
    for start, value in enumerate(alpha):
        if value < 128 or visited[start]:
            continue
        visited[start] = 1
        queue: deque[int] = deque((start,))
        retained: list[int] = [start]
        count = 0
        while queue:
            index = queue.popleft()
            count += 1
            if count < minimum_area:
                retained.append(index) if index != start else None
            elif retained:
                retained.clear()
            x = index % width
            y = index // width
            for dy in (-1, 0, 1):
                ny = y + dy
                if ny < 0 or ny >= height:
                    continue
                for dx in (-1, 0, 1):
                    if dx == 0 and dy == 0:
                        continue
                    nx = x + dx
                    if nx < 0 or nx >= width:
                        continue
                    neighbor = ny * width + nx
                    if not visited[neighbor] and alpha[neighbor] >= 128:
                        visited[neighbor] = 1
                        queue.append(neighbor)
        if count < minimum_area:
            for index in retained:
                alpha[index] = 0
            removed_components += 1
            removed_pixels += count
    return removed_components, removed_pixels


def _extreme_filter(
    values: bytearray,
    width: int,
    height: int,
    radius: int,
    maximum: bool,
) -> bytearray:
    horizontal = bytearray(len(values))
    for y in range(height):
        row = y * width
        queue: deque[int] = deque()
        right = -1
        for center in range(width):
            target_right = min(width - 1, center + radius)
            while right < target_right:
                right += 1
                while queue and _dominates(values[row + right], values[row + queue[-1]], maximum):
                    queue.pop()
                queue.append(right)
            left = max(0, center - radius)
            while queue and queue[0] < left:
                queue.popleft()
            horizontal[row + center] = values[row + queue[0]]

    output = bytearray(len(values))
    for x in range(width):
        queue = deque()
        bottom = -1
        for center in range(height):
            target_bottom = min(height - 1, center + radius)
            while bottom < target_bottom:
                bottom += 1
                while queue and _dominates(
                    horizontal[bottom * width + x],
                    horizontal[queue[-1] * width + x],
                    maximum,
                ):
                    queue.pop()
                queue.append(bottom)
            top = max(0, center - radius)
            while queue and queue[0] < top:
                queue.popleft()
            output[center * width + x] = horizontal[queue[0] * width + x]
    return output


def _box_blur(values: bytearray, width: int, height: int, radius: int) -> bytearray:
    horizontal = bytearray(len(values))
    for y in range(height):
        row = y * width
        total = sum(values[row : row + min(width, radius + 1)])
        for x in range(width):
            left = max(0, x - radius)
            right = min(width - 1, x + radius)
            if x > 0:
                previous_left = max(0, x - 1 - radius)
                previous_right = min(width - 1, x - 1 + radius)
                if left > previous_left:
                    total -= values[row + previous_left]
                if right > previous_right:
                    total += values[row + right]
            horizontal[row + x] = round(total / (right - left + 1))

    output = bytearray(len(values))
    for x in range(width):
        total = sum(horizontal[y * width + x] for y in range(min(height, radius + 1)))
        for y in range(height):
            top = max(0, y - radius)
            bottom = min(height - 1, y + radius)
            if y > 0:
                previous_top = max(0, y - 1 - radius)
                previous_bottom = min(height - 1, y - 1 + radius)
                if top > previous_top:
                    total -= horizontal[previous_top * width + x]
                if bottom > previous_bottom:
                    total += horizontal[bottom * width + x]
            output[y * width + x] = round(total / (bottom - top + 1))
    return output


def _count_defringe_candidates(
    packed: bytearray,
    alpha: bytearray,
    width: int,
    height: int,
    matte: tuple[int, int, int],
    tolerance_squared: float,
    spill_mask: int,
    clean_opaque_edges: bool,
) -> int:
    unresolved = 0
    matte_red, matte_green, matte_blue = matte
    for index in range(width * height):
        offset = index * 4
        value = packed[offset + 3]
        if value < 24:
            continue
        direct_match = (
            (packed[offset] - matte_red) ** 2
            + (packed[offset + 1] - matte_green) ** 2
            + (packed[offset + 2] - matte_blue) ** 2
            <= tolerance_squared
        )
        spill_match = _profiled_key_spill_score(
            packed[offset],
            packed[offset + 1],
            packed[offset + 2],
            spill_mask,
        ) >= KEY_SPILL_THRESHOLD
        if not direct_match and not spill_match:
            continue
        if value >= 250:
            if not clean_opaque_edges:
                continue
            if not _adjacent_to_transparent(alpha, index, width, height):
                continue
        unresolved += 1
    return unresolved


def _reliable_row_distances(
    reliable: bytearray,
    width: int,
    height: int,
    radius: int,
) -> tuple[bytearray, bytearray]:
    sentinel = radius + 1
    right = bytearray([sentinel]) * len(reliable)
    for y in range(height):
        row = y * width
        distance = sentinel
        for x in range(width - 1, -1, -1):
            index = row + x
            if reliable[index]:
                distance = 0
            elif distance < sentinel:
                distance += 1
            right[index] = min(distance, sentinel)

    left = reliable
    for y in range(height):
        row = y * width
        distance = sentinel
        for x in range(width):
            index = row + x
            if left[index]:
                distance = 0
            elif distance < sentinel:
                distance += 1
            left[index] = min(distance, sentinel)
    return left, right


def _nearest_reliable_color_from_rows(
    packed: bytearray,
    left: bytearray,
    right: bytearray,
    index: int,
    width: int,
    height: int,
    radius: int,
) -> tuple[int, int, int] | None:
    x = index % width
    y = index // width
    best: tuple[int, int] | None = None
    for ny in range(max(0, y - radius), min(height, y + radius + 1)):
        row_index = ny * width + x
        vertical = abs(ny - y)
        for horizontal, source_x in (
            (left[row_index], x - left[row_index]),
            (right[row_index], x + right[row_index]),
        ):
            if horizontal > radius or source_x < 0 or source_x >= width:
                continue
            source = ny * width + source_x
            candidate = (max(vertical, horizontal), source)
            if candidate[0] <= radius and (best is None or candidate < best):
                best = candidate
    if best is None:
        return None
    offset = best[1] * 4
    return tuple(packed[offset : offset + 3])


def _adjacent_to_transparent(
    alpha: bytearray,
    index: int,
    width: int,
    height: int,
) -> bool:
    x = index % width
    y = index // width
    for dy in (-1, 0, 1):
        ny = y + dy
        if ny < 0 or ny >= height:
            continue
        for dx in (-1, 0, 1):
            if dx == 0 and dy == 0:
                continue
            nx = x + dx
            if 0 <= nx < width and alpha[ny * width + nx] <= 8:
                return True
    return False


def _suppress_matte(
    color: tuple[float, float, float],
    matte: tuple[int, int, int],
) -> tuple[float, float, float]:
    matte_channels = [
        channel
        for channel, value in enumerate(matte)
        if value >= 128 and value - min(matte) >= 64
    ]
    if not matte_channels or len(matte_channels) == 3:
        return color
    foreground_channels = [channel for channel in range(3) if channel not in matte_channels]
    ceiling = max((color[channel] for channel in foreground_channels), default=0.0) + 16.0
    output = list(color)
    for channel in matte_channels:
        output[channel] = min(output[channel], ceiling)
    return output[0], output[1], output[2]


def _packed(pixels: Any) -> bytes:
    if isinstance(pixels, PixelBuffer):
        return pixels.packed()
    return bytes(channel for pixel in pixels for channel in pixel)


def _border_indices(width: int, height: int) -> list[int]:
    indices = list(range(width))
    if height > 1:
        indices.extend(range((height - 1) * width, height * width))
    for y in range(1, height - 1):
        indices.append(y * width)
        if width > 1:
            indices.append(y * width + width - 1)
    return indices


def _dominates(left: int, right: int, maximum: bool) -> bool:
    return left >= right if maximum else left <= right


def _distance_squared(
    color: tuple[int, int, int],
    key: tuple[int, int, int],
) -> int:
    return sum((color[index] - key[index]) ** 2 for index in range(3))


def _format_color(value: tuple[int, int, int]) -> str:
    return "#" + "".join(f"{channel:02X}" for channel in value)
