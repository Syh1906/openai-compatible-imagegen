"""Command-line parser for the image generation runtime."""

from __future__ import annotations

import argparse
from collections.abc import Collection


def build_parser(
    supported_aspects: Collection[str],
    supported_resolutions: Collection[str],
) -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="imagegen")
    sub = parser.add_subparsers(dest="command", required=True)

    init_parser = sub.add_parser("init")
    init_parser.add_argument("--force", action="store_true", help="Recreate auth.json from the example template")
    init_parser.add_argument("--base-url", default=None, help="OpenAI-compatible API base URL, usually ending in /v1")
    init_parser.add_argument("--model", default=None, help="Default image model")
    init_parser.add_argument("--api-key-env", default=None, help="Environment variable name to read the API key from")

    add_generate_args(sub.add_parser("generate"), supported_aspects, supported_resolutions)
    add_generate_args(sub.add_parser("edit"), supported_aspects, supported_resolutions, edit=True)

    batch_parser = sub.add_parser("batch")
    add_common_args(batch_parser, supported_aspects, supported_resolutions)
    batch_parser.add_argument("--input", required=True, help="JSONL task file")
    batch_parser.add_argument("--out", required=True, help="Output directory")
    batch_parser.add_argument("--concurrency", type=int, default=None, help="Limited batch concurrency")
    add_postprocess_args(batch_parser)

    inspect_parser = sub.add_parser("inspect-image")
    inspect_parser.add_argument("file")

    normalize_parser = sub.add_parser("normalize")
    normalize_parser.add_argument("file")
    normalize_parser.add_argument("--delivery-size", required=True)
    normalize_parser.add_argument("--out", required=True)

    grid_parser = sub.add_parser("split-grid")
    grid_parser.add_argument("file")
    grid_parser.add_argument("--grid", required=True, help="Grid rows and columns, for example 3x3")
    grid_parser.add_argument("--delivery-size", required=True)
    grid_parser.add_argument("--out-dir", required=True)
    grid_parser.add_argument("--expected-count", type=int, default=None)

    machine_parser = sub.add_parser("machine")
    machine_parser.add_argument("--project-root", required=True)
    machine_parser.add_argument("--artifact-root", required=True)

    sub.add_parser("info")
    return parser


def add_generate_args(
    parser: argparse.ArgumentParser,
    supported_aspects: Collection[str],
    supported_resolutions: Collection[str],
    edit: bool = False,
) -> None:
    add_common_args(parser, supported_aspects, supported_resolutions)
    parser.add_argument("-p", "--prompt", required=True)
    parser.add_argument("-f", "--file", default=None)
    parser.add_argument("--out", default=None)
    if edit:
        parser.add_argument("-i", "--image", action="append", default=None)
        parser.add_argument("-m", "--mask", default=None)
    add_postprocess_args(parser)


def add_common_args(
    parser: argparse.ArgumentParser,
    supported_aspects: Collection[str],
    supported_resolutions: Collection[str],
) -> None:
    parser.add_argument("--model", default=None)
    parser.add_argument("--size", default=None)
    parser.add_argument("--aspect", default=None, choices=sorted(supported_aspects))
    parser.add_argument("--resolution", default=None, choices=sorted(supported_resolutions))
    parser.add_argument("--quality", default=None, choices=["auto", "low", "medium", "high"])
    parser.add_argument("--n", type=int, default=None)
    parser.add_argument("--format", default=None, choices=["png", "jpeg", "jpg", "webp"])
    parser.add_argument("--background", default=None, choices=["auto", "opaque"])
    parser.add_argument("--transparent", action="store_true")
    parser.add_argument("--asset", action="store_true")
    parser.add_argument("--moderation", default=None, choices=["auto", "low"])
    parser.add_argument("--compression", type=int, default=None)
    parser.add_argument("--timeout", type=int, default=None)
    parser.add_argument(
        "--allow-direct-url-download",
        action="store_true",
        help="Download returned image URLs directly without the configured proxy for this run",
    )


def add_postprocess_args(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--postprocess", action="store_true", help="Enable optional post-processing for this run")
    parser.add_argument("--delivery-size", default=None, help="Final delivery size, for example 128x128")
    parser.add_argument("--grid", default=None, help="Split generated output as rows x cols, for example 3x3")
    parser.add_argument("--expected-count", type=int, default=None)
    parser.add_argument("--postprocess-out-dir", default=None)
