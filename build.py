"""Build https://nx-ai.github.io from projects.yml.

Usage:
    pip install -r requirements.txt
    python build.py              # writes _site/index.html

Star counts are fetched from the GitHub API at build time. Set GITHUB_TOKEN to avoid
the low anonymous rate limit (GitHub Actions provides it automatically). If the API is
unreachable, the page is still built, without star counts.
"""

from __future__ import annotations

import datetime as dt
import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path

import yaml
from jinja2 import Environment, FileSystemLoader, StrictUndefined, select_autoescape

ROOT = Path(__file__).resolve().parent
OUT_DIR = ROOT / "_site"

VENUES = {"NeurIPS", "ICLR", "ICML", "preprint"}
LINK_ICONS = {
    "github": "i-github",
    "docs": "i-book",
    "paper": "i-paper",
    "huggingface": "i-hf",
    "demo": "i-hf",
    "pypi": "i-pkg",
    "page": "i-globe",
    "pro": "i-arrow",
}
DOC_ICONS = {"book", "globe", "list"}
# Paths served by other NX-AI repositories. Never create folders with these names here.
RESERVED_PATHS = {"linktree", "tirex", "tirex-2", "vision-lstm"}


class ConfigError(ValueError):
    pass


def validate(data: dict) -> None:
    errors: list[str] = []

    for d in data.get("documentation", []):
        if d.get("icon") not in DOC_ICONS:
            errors.append(f"documentation '{d.get('title')}': icon must be one of {sorted(DOC_ICONS)}")
        if not str(d.get("url", "")).startswith("https://"):
            errors.append(f"documentation '{d.get('title')}': url must start with https://")

    seen_ids: set[str] = set()
    for g in data.get("groups", []):
        gid = g.get("id")
        if not gid or gid in seen_ids:
            errors.append(f"group '{g.get('title')}': id missing or duplicated")
        seen_ids.add(gid)
        for p in g.get("projects", []):
            name = p.get("name", "?")
            for field in ("name", "repo", "description", "venue", "license", "links"):
                if not p.get(field):
                    errors.append(f"{name}: '{field}' is missing")
            lic = str(p.get("license", ""))
            if "[" in lic or "TBC" in lic.upper() or "PENDING" in lic.upper():
                errors.append(f"{name}: license '{lic}' is a placeholder; set the final licence first")
            venue = p.get("venue") or {}
            if venue.get("conf") not in VENUES:
                errors.append(f"{name}: venue conf must be one of {sorted(VENUES)}")
            if not venue.get("detail"):
                errors.append(f"{name}: venue detail is missing")
            for link in p.get("links", []):
                if link.get("type") not in LINK_ICONS:
                    errors.append(f"{name}: link type '{link.get('type')}' must be one of {sorted(LINK_ICONS)}")
                if not str(link.get("url", "")).startswith("https://"):
                    errors.append(f"{name}: link '{link.get('label')}' must use https://")

    for reserved in RESERVED_PATHS:
        if (ROOT / reserved).exists():
            errors.append(f"folder '{reserved}/' would shadow nx-ai.github.io/{reserved}/; remove it")

    if errors:
        raise ConfigError("projects.yml has problems:\n  - " + "\n  - ".join(errors))


def fetch_stars(repo: str, token: str | None) -> int | None:
    request = urllib.request.Request(
        f"https://api.github.com/repos/{repo}",
        headers={"Accept": "application/vnd.github+json", "User-Agent": "nx-ai.github.io-build"},
    )
    if token:
        request.add_header("Authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(request, timeout=15) as response:
            return int(json.load(response)["stargazers_count"])
    except (urllib.error.URLError, TimeoutError, KeyError, ValueError) as exc:
        print(f"warning: no star count for {repo}: {exc}", file=sys.stderr)
        return None


def display_url(url: str) -> str:
    return url.removeprefix("https://").rstrip("/")


def main() -> int:
    data = yaml.safe_load((ROOT / "projects.yml").read_text(encoding="utf-8"))
    try:
        validate(data)
    except ConfigError as exc:
        print(exc, file=sys.stderr)
        return 1

    token = os.environ.get("GITHUB_TOKEN")
    stars_ok = True
    total = 0
    for group in data["groups"]:
        for p in group["projects"]:
            total += 1
            count = fetch_stars(p["repo"], token)
            if count is None:
                stars_ok = False
            # Repositories without stars show no count rather than a zero.
            p["stars"] = f"{count:,}" if count else ""
            conf = p["venue"]["conf"]
            detail = str(p["venue"]["detail"])
            p["venue_label"] = detail if conf == "preprint" else f"{conf} {detail}"
            p["install"] = p.get("install", "")
            for link in p["links"]:
                link["icon"] = LINK_ICONS[link["type"]]

    for d in data["documentation"]:
        d["display_url"] = display_url(d["url"])

    now = dt.datetime.now(dt.timezone.utc)
    stars_note = (
        f"Star counts from the GitHub API, updated {now:%d %B %Y}."
        if stars_ok
        else f"Some star counts unavailable at build time ({now:%d %B %Y})."
    )

    env = Environment(
        loader=FileSystemLoader(ROOT / "templates"),
        autoescape=select_autoescape(["html", "j2"]),
        undefined=StrictUndefined,
        trim_blocks=True,
        lstrip_blocks=True,
    )
    html = env.get_template("index.html.j2").render(
        documentation=data["documentation"],
        groups=data["groups"],
        total=total,
        stars_note=stars_note,
        build_year=now.year,
    )

    OUT_DIR.mkdir(exist_ok=True)
    (OUT_DIR / "index.html").write_text(html, encoding="utf-8")
    print(f"wrote {OUT_DIR / 'index.html'} ({total} projects)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
