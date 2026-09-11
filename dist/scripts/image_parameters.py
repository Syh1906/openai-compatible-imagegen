"""Extensible provider JSON fields, independent of model names."""

from __future__ import annotations

from copy import deepcopy
import json
from typing import Any

from model_profiles import CONTRACT


def validate_parameters(parameters: Any) -> None:
    if not isinstance(parameters, dict):
        raise ValueError("parameters must be a JSON object")
    if set(parameters).intersection(CONTRACT["reservedParameterKeys"]):
        raise ValueError("parameters cannot replace request identity, inputs, authentication or routing")
    try:
        json.dumps(parameters, allow_nan=False)
    except (TypeError, ValueError) as exc:
        raise ValueError("parameters must contain finite JSON values") from exc


def merge_parameters(lower: dict[str, Any], higher: dict[str, Any]) -> dict[str, Any]:
    result = deepcopy(lower)
    for key, value in higher.items():
        result[key] = merge_parameters(result[key], value) if isinstance(result.get(key), dict) and isinstance(value, dict) else deepcopy(value)
    return result


def extend_payload(payload: dict[str, Any], parameters: dict[str, Any] | None) -> dict[str, Any]:
    validate_parameters(parameters or {})
    # Explicit common intent wins when it overlaps a provider default.
    return merge_parameters(parameters or {}, payload)


def validate_parameter_fields(fields: Any) -> None:
    if not isinstance(fields, dict):
        raise ValueError("parameter_fields must be an object")
    paths = []
    for name, field in fields.items():
        if not isinstance(name, str) or not name.strip() or not isinstance(field, dict) or set(field) - set(CONTRACT["parameterFieldKeys"]):
            raise ValueError("invalid parameter field")
        if field.get("type") not in CONTRACT["parameterFieldTypes"]:
            raise ValueError("invalid parameter field type")
        path = field.get("path")
        if not isinstance(path, list) or not path or any(not isinstance(key, str) or not key or key in {"__proto__", "constructor", "prototype"} for key in path):
            raise ValueError("parameter field path must be a non-empty list of object keys")
        validate_parameters({path[0]: None})
        if any(path[:len(other)] == other or other[:len(path)] == path for other in paths):
            raise ValueError("parameter field paths must not overlap")
        paths.append(path)
        for key in ("title", "description"):
            if key in field and (not isinstance(field[key], str) or not field[key].strip()):
                raise ValueError("invalid parameter field text")
        for key in ("minimum", "maximum"):
            if key in field and (field["type"] not in {"integer", "number"} or type(field[key]) not in {int, float}):
                raise ValueError("invalid numeric parameter bound")
        if field.get("minimum", float("-inf")) > field.get("maximum", float("inf")):
            raise ValueError("minimum exceeds maximum")
        if "enum" in field:
            if not isinstance(field["enum"], list) or not field["enum"]:
                raise ValueError("parameter enum must be a non-empty list")
            for value in field["enum"]:
                _validate_field_value(field, value)
        if "default" in field:
            _validate_field_value(field, field["default"])
    json.dumps(fields, allow_nan=False)


def _validate_field_value(field: dict, value: Any) -> None:
    types = {"string": (str,), "integer": (int,), "number": (int, float), "boolean": (bool,), "object": (dict,), "array": (list,)}
    if type(value) not in types[field["type"]]:
        raise ValueError("parameter default or option has the wrong type")
    if field["type"] in {"integer", "number"} and not field.get("minimum", float("-inf")) <= value <= field.get("maximum", float("inf")):
        raise ValueError("parameter default or option is outside declared bounds")


def resolve_parameter_defaults(fields: dict, parameters: dict) -> dict:
    validate_parameter_fields(fields)
    validate_parameters(parameters)
    defaults = {}
    for field in fields.values():
        if "default" not in field:
            continue
        target = defaults
        for segment in field["path"][:-1]:
            target = target.setdefault(segment, {})
        target[field["path"][-1]] = deepcopy(field["default"])
    resolved = merge_parameters(defaults, parameters)
    validate_parameter_values(fields, resolved)
    return resolved


def validate_parameter_values(fields: dict, parameters: dict) -> None:
    validate_parameters(parameters)
    for field in fields.values():
        value = parameters
        for key in field["path"]:
            if not isinstance(value, dict) or key not in value:
                break
            value = value[key]
        else:
            _validate_field_value(field, value)
