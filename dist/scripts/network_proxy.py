"""Shared proxy route selection for provider HTTP requests."""

from __future__ import annotations


def proxy_mapping(proxy_url: str | None, *, direct: bool = False) -> dict[str, str] | None:
    if direct:
        return {}
    if proxy_url:
        return {"http": proxy_url, "https": proxy_url}
    return None
