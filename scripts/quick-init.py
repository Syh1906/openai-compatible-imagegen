#!/usr/bin/env python3
"""First-run auth.json setup wizard for openai-compatible-imagegen."""

from __future__ import annotations

import argparse
import getpass
import json
from pathlib import Path
import sys
from typing import Any


SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

import imagegen  # noqa: E402


class QuickInitError(Exception):
    """User-facing quick-init error."""


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="quick-init")
    parser.add_argument("--base-url", default=None, help="OpenAI-compatible API base URL, usually ending in /v1")
    parser.add_argument("--model", default=None, help="Default image model")
    parser.add_argument("--auth-method", choices=("env", "local"), default=None, help="Where to store API auth")
    parser.add_argument("--api-key-env", default=None, help="Environment variable name to read the API key from")
    parser.add_argument("--force", action="store_true", help="Recreate auth.json if it already exists")
    parser.add_argument("--non-interactive", action="store_true", help="Require all setup values as flags")
    transparent = parser.add_mutually_exclusive_group()
    transparent.add_argument(
        "--transparent-background",
        action="store_true",
        dest="transparent_background",
        default=None,
        help="Mark the backend as supporting background=transparent",
    )
    transparent.add_argument(
        "--no-transparent-background",
        action="store_false",
        dest="transparent_background",
        help="Mark the backend as not supporting background=transparent",
    )
    return parser


def load_template() -> dict[str, Any]:
    if not imagegen.EXAMPLE_AUTH_PATH.is_file():
        raise QuickInitError(f"missing example auth template: {imagegen.display_path(imagegen.EXAMPLE_AUTH_PATH)}")
    try:
        data = json.loads(imagegen.EXAMPLE_AUTH_PATH.read_text(encoding="utf-8-sig"))
    except json.JSONDecodeError as exc:
        raise QuickInitError(f"example auth template is not valid JSON: {exc}") from exc
    if not isinstance(data, dict):
        raise QuickInitError("example auth template must be a JSON object")
    return data


def prompt_text(label: str, default: str | None = None) -> str:
    suffix = f" [{default}]" if default else ""
    value = input(f"{label}{suffix}: ").strip()
    if value:
        return value
    return default or ""


def prompt_auth_method(default: str = "env") -> str:
    while True:
        value = prompt_text("Auth method (env/local)", default).lower()
        if value in {"env", "local"}:
            return value
        print("Enter 'env' or 'local'.", file=sys.stderr)


def prompt_yes_no(label: str, default: bool = False) -> bool:
    default_text = "y" if default else "n"
    while True:
        value = prompt_text(label, default_text).lower()
        if value in {"y", "yes"}:
            return True
        if value in {"n", "no"}:
            return False
        print("Enter 'y' or 'n'.", file=sys.stderr)


def require_value(value: str | None, flag_name: str) -> str:
    selected = (value or "").strip()
    if not selected:
        raise QuickInitError(f"{flag_name} is required in --non-interactive mode")
    return selected


def collect_values(args: argparse.Namespace, template: dict[str, Any]) -> dict[str, Any]:
    base_url_default = str(template.get("base_url") or "").strip()
    model_default = str(template.get("model") or imagegen.DEFAULT_MODEL).strip()
    api_key_env_default = str(template.get("api_key_env") or "OPENAI_API_KEY").strip()

    if args.non_interactive:
        base_url = require_value(args.base_url, "--base-url")
        model = require_value(args.model, "--model")
        auth_method = require_value(args.auth_method, "--auth-method")
        if auth_method == "env":
            api_key_env = require_value(args.api_key_env, "--api-key-env")
            api_key = str(template.get("api_key") or "").strip()
        else:
            raise QuickInitError("local auth requires interactive setup so the API key is not stored in shell history")
        if args.transparent_background is None:
            raise QuickInitError(
                "--transparent-background or --no-transparent-background is required in --non-interactive mode"
            )
        transparent_background = bool(args.transparent_background)
    else:
        base_url = (args.base_url or prompt_text("API base URL", base_url_default)).strip()
        if not base_url:
            raise QuickInitError("API base URL is required")
        model = (args.model or prompt_text("Image model", model_default)).strip()
        if not model:
            raise QuickInitError("Image model is required")
        auth_method = args.auth_method or prompt_auth_method()
        if auth_method == "env":
            api_key_env = (args.api_key_env or prompt_text("API key environment variable", api_key_env_default)).strip()
            if not api_key_env:
                raise QuickInitError("API key environment variable is required for env auth")
            api_key = str(template.get("api_key") or "").strip()
        else:
            api_key = getpass.getpass("API key (hidden): ").strip()
            if not api_key:
                raise QuickInitError("API key is required for local auth")
            api_key_env = ""
        transparent_background = (
            bool(args.transparent_background)
            if args.transparent_background is not None
            else prompt_yes_no("Does this backend support transparent backgrounds?", False)
        )

    return {
        "base_url": base_url.rstrip("/"),
        "model": model,
        "api_key": api_key,
        "api_key_env": api_key_env,
        "transparent_background": transparent_background,
    }


def write_auth_config(values: dict[str, Any], template: dict[str, Any]) -> None:
    data = dict(template)
    data["base_url"] = values["base_url"]
    data["model"] = values["model"]
    data["api_key"] = values["api_key"]
    data["api_key_env"] = values["api_key_env"]
    capabilities = data.get("capabilities") if isinstance(data.get("capabilities"), dict) else {}
    capabilities["transparent_background"] = bool(values["transparent_background"])
    data["capabilities"] = capabilities
    imagegen.AUTH_PATH.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def print_info_summary() -> None:
    try:
        imagegen.info(imagegen.load_config(require_api_key=False))
    except imagegen.ImagegenError as exc:
        print(f"warning: {exc}", file=sys.stderr)


def run(args: argparse.Namespace) -> int:
    if imagegen.AUTH_PATH.exists() and not args.force:
        print(f"auth.json already exists: {imagegen.display_path(imagegen.AUTH_PATH)}")
        print("Use --force to recreate it. Existing api_key is never printed.")
        print_info_summary()
        return 0

    template = load_template()
    values = collect_values(args, template)
    write_auth_config(values, template)
    print(f"created local auth config: {imagegen.display_path(imagegen.AUTH_PATH)}")
    print("Config summary:")
    print_info_summary()
    if values["api_key_env"]:
        print(f"Set environment variable {values['api_key_env']} before generating images.")
    else:
        print("Local auth.json api_key is configured. Keep this file private.")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        return run(args)
    except QuickInitError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
