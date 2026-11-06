"""Build https://nx-ai.github.io from projects.yml.

Usage:
    uv sync --locked
    uv run build.py              # writes _site/index.html

Star counts are fetched from the GitHub API at build time. Set GITHUB_TOKEN to avoid the
low anonymous rate limit (GitHub Actions provides it automatically).

PyPI downloads (all-time totals, last 30 days, weekly history) for projects with a "pypi"
field come from the public ClickHouse PyPI dataset (the data behind clickpy.clickhouse.com),
queried with its public read-only "play" user. No key or account is needed.

Hugging Face model downloads (all time and last 30 days) for the models listed under
"hf_models" come from the public Hugging Face API. No key is needed.

If a source is unreachable, the page is still built, without those numbers.
"""

from __future__ import annotations

import datetime as dt
import json
import os
import re
import shutil
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
PYPI_NAME = re.compile(r"^[A-Za-z0-9]([A-Za-z0-9._-]*[A-Za-z0-9])?$")
USER_AGENT = "nx-ai.github.io-build"
CLICKHOUSE_URL = "https://sql-clickhouse.clickhouse.com/?user=play"
# Models of this Hugging Face organisation that no project lists are reported as a warning.
HF_ORG = "NX-AI"
HF_MODEL = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")
# Categorical colour slots defined in the template (--s1 ... --s8).
COLOR_SLOTS = 8


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
            if "pypi" in p and not PYPI_NAME.match(str(p.get("pypi") or "")):
                errors.append(f"{name}: pypi '{p.get('pypi')}' is not a valid package name")
            models = p.get("hf_models", [])
            if not isinstance(models, list) or not all(HF_MODEL.match(str(m)) for m in models):
                errors.append(f"{name}: hf_models must be a list of Hugging Face ids like 'NX-AI/TiRex'")
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


def github_get(url: str, token: str | None):
    request = urllib.request.Request(url, headers={"Accept": "application/vnd.github+json", "User-Agent": USER_AGENT})
    if token:
        request.add_header("Authorization", f"Bearer {token}")
    with urllib.request.urlopen(request, timeout=30) as response:
        return json.load(response)


def fetch_stars(repo: str, token: str | None) -> int | None:
    try:
        return int(github_get(f"https://api.github.com/repos/{repo}", token)["stargazers_count"])
    except (urllib.error.URLError, TimeoutError, KeyError, ValueError) as exc:
        print(f"warning: no star count for {repo}: {exc}", file=sys.stderr)
        return None


def hf_get(url: str):
    request = urllib.request.Request(url, headers={"Accept": "application/json", "User-Agent": USER_AGENT})
    with urllib.request.urlopen(request, timeout=30) as response:
        return json.load(response)


def fetch_hf(model: str) -> tuple[int, int] | None:
    """(all-time downloads, downloads in the last 30 days) of a Hugging Face model."""
    try:
        data = hf_get(f"https://huggingface.co/api/models/{model}?expand[]=downloadsAllTime&expand[]=downloads")
        return int(data.get("downloadsAllTime") or 0), int(data.get("downloads") or 0)
    except (urllib.error.URLError, TimeoutError, KeyError, TypeError, ValueError) as exc:
        print(f"warning: no Hugging Face downloads for {model}: {exc}", file=sys.stderr)
        return None


def warn_unlisted_models(listed: set[str]) -> None:
    try:
        models = hf_get(f"https://huggingface.co/api/models?author={HF_ORG}&limit=500")
    except (urllib.error.URLError, TimeoutError, ValueError) as exc:
        print(f"warning: could not list {HF_ORG} models on Hugging Face: {exc}", file=sys.stderr)
        return
    for m in sorted(m["id"] for m in models if m["id"] not in listed):
        print(f"warning: Hugging Face model {m} is not listed under hf_models in projects.yml", file=sys.stderr)


def normalise(package: str) -> str:
    # PEP 503 normalised name, as used by the PyPI download dataset.
    return re.sub(r"[-_.]+", "-", package).lower()


def clickhouse(query: str) -> list[dict] | None:
    request = urllib.request.Request(
        CLICKHOUSE_URL,
        data=(query + " FORMAT JSON").encode(),
        headers={"User-Agent": USER_AGENT},
    )
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            return json.load(response)["data"]
    except (urllib.error.URLError, TimeoutError, KeyError, ValueError) as exc:
        print(f"warning: PyPI download query failed: {exc}", file=sys.stderr)
        return None


def fetch_downloads(packages: list[str]) -> tuple[dict, dict] | None:
    """Return ({package: (total, last_30_days)}, {package: {monday: downloads}})."""
    # Names are checked against PYPI_NAME in validate(), so quoting them here is safe.
    names = ", ".join(f"'{normalise(p)}'" for p in packages)
    totals = clickhouse(
        "SELECT project, sum(count) AS total, sumIf(count, date >= today() - 30) AS recent "
        f"FROM pypi.pypi_downloads_per_day WHERE project IN ({names}) GROUP BY project"
    )
    weekly = clickhouse(
        "SELECT project, toString(toMonday(date)) AS week, sum(count) AS n "
        f"FROM pypi.pypi_downloads_per_day WHERE project IN ({names}) "
        "GROUP BY project, week ORDER BY project, week"
    )
    if totals is None or weekly is None:
        return None
    by_total = {r["project"]: (int(r["total"]), int(r["recent"])) for r in totals}
    by_week: dict[str, dict[dt.date, int]] = {}
    for r in weekly:
        by_week.setdefault(r["project"], {})[dt.date.fromisoformat(r["week"])] = int(r["n"])
    return by_total, by_week


def mondays(start: dt.date, end: dt.date) -> list[dt.date]:
    first = start - dt.timedelta(days=start.weekday())
    return [first + dt.timedelta(weeks=i) for i in range((end - first).days // 7 + 1)]


def download_chart(projects: list[dict], by_week: dict, today: dt.date) -> dict | None:
    """Weekly downloads per package, complete weeks only."""
    pkgs = [p for p in projects if by_week.get(normalise(p.get("pypi", "")))]
    if not pkgs:
        return None
    last_complete = today - dt.timedelta(days=today.weekday() + 7)
    first = min(min(by_week[normalise(p["pypi"])]) for p in pkgs)
    weeks = mondays(first, last_complete)
    series = []
    for p in pkgs:
        data = by_week[normalise(p["pypi"])]
        start = min(data)
        # No value before the package's first download week, so its line starts there.
        values = [None if w < start else data.get(w, 0) for w in weeks]
        series.append({"name": p["name"], "key": p["repo"], "values": values})
    return {"weeks": [w.isoformat() for w in weeks], "series": series}


def assign_colors(projects: list[dict], charts: list[dict]) -> None:
    """One colour per project across both charts, in projects.yml order, never by rank."""
    used = {s["key"] for c in charts for s in c["series"]}
    slots = {}
    for p in projects:
        if p["repo"] in used and len(slots) < COLOR_SLOTS:
            slots[p["repo"]] = len(slots) + 1
    for c in charts:
        for s in c["series"]:
            s["color"] = "other" if s["key"] == "_other" else str(slots.get(s["key"], "other"))


def display_url(url: str) -> str:
    return url.removeprefix("https://").rstrip("/")


def main() -> int:
    data = yaml.safe_load((ROOT / "projects.yml").read_text(encoding="utf-8"))
    try:
        validate(data)
    except ConfigError as exc:
        print(exc, file=sys.stderr)
        return 1

    search_entries = [
        {
            "id": d["url"],
            "title": d["title"],
            "text": f"Resource type: documentation | Description: {d['description']}",
            "snippet": d["description"],
            "group": "documentation",
            "url": d["url"],
        }
        for d in data["documentation"]
    ]
    for group in data["groups"]:
        for project in group["projects"]:
            labels = [
                f"Model family: {group['title']}",
                "Resource type: project",
                f"Description: {project['description']}",
                f"Repository: {project['repo']}",
                f"Licence: {project['license']}",
                f"Venue: {project['venue']['conf']} {project['venue']['detail']}",
                "Links: " + ", ".join(link["label"] for link in project["links"]),
            ]
            if project.get("install"):
                labels.append(f"Install: {project['install']}")
            search_entries.append({
                "id": project["repo"],
                "title": project["name"],
                "text": " | ".join(labels),
                "snippet": project["description"],
                "group": group["id"],
                "url": f"https://github.com/{project['repo']}",
            })
    search_entries_json = json.dumps(search_entries, ensure_ascii=False, separators=(",", ":")).replace("</", "<\\/")

    token = os.environ.get("GITHUB_TOKEN")
    now = dt.datetime.now(dt.timezone.utc)
    today = now.date()
    projects = [p for group in data["groups"] for p in group["projects"]]

    stars_ok = True
    star_total = 0
    for p in projects:
        count = fetch_stars(p["repo"], token)
        if count is None:
            stars_ok = False
        star_total += count or 0
        p["star_count"] = count or 0
        # Repositories without stars show no count rather than a zero.
        p["stars"] = f"{count:,}" if count else ""
        conf = p["venue"]["conf"]
        detail = str(p["venue"]["detail"])
        p["venue_label"] = detail if conf == "preprint" else f"{conf} {detail}"
        p["install"] = p.get("install", "")
        for link in p["links"]:
            link["icon"] = LINK_ICONS[link["type"]]

    packages = [p["pypi"] for p in projects if p.get("pypi")]
    downloads = fetch_downloads(packages) if packages else None
    downloads_ok = downloads is not None or not packages
    by_total, by_week = downloads or ({}, {})
    download_total = download_recent = 0
    for p in projects:
        total, recent = by_total.get(normalise(p.get("pypi", "")), (0, 0))
        download_total += total
        download_recent += recent
        p["downloads"] = f"{total:,}" if total else ""
        p["downloads_recent"] = f"{recent:,}" if recent else ""

    hf_ok = True
    hf_total = hf_recent = 0
    listed: set[str] = set()
    for p in projects:
        p["hf_downloads"] = p["hf_downloads_recent"] = ""
        p["has_hf"] = bool(p.get("hf_models"))
        results = [fetch_hf(m) for m in p.get("hf_models", [])]
        listed.update(p.get("hf_models", []))
        if any(r is None for r in results):
            # A partial sum would understate the project, so show nothing instead.
            hf_ok = False
            p["has_hf"] = False
            continue
        if results:
            total, recent = sum(r[0] for r in results), sum(r[1] for r in results)
            hf_total += total
            hf_recent += recent
            p["hf_downloads"] = f"{total:,}" if total else ""
            p["hf_downloads_recent"] = f"{recent:,}"
            p["hf_downloads_all"] = f"{total:,}"
    if listed:
        warn_unlisted_models(listed)

    charts = {}
    if (c := download_chart(projects, by_week, today)) is not None:
        charts["downloads"] = c
    assign_colors(projects, list(charts.values()))

    for d in data["documentation"]:
        d["display_url"] = display_url(d["url"])

    checks = (("star counts", stars_ok), ("PyPI download counts", downloads_ok), ("Hugging Face download counts", hf_ok))
    missing = [label for label, ok in checks if not ok]
    sources = "Stars from the GitHub API"
    if packages:
        sources += ", PyPI downloads from the public ClickHouse PyPI dataset"
    if listed:
        sources += ", model downloads from the Hugging Face API"
    stars_note = (
        f"Some {' and '.join(missing)} unavailable at build time ({now:%d %B %Y})."
        if missing
        else f"{sources}, updated {now:%d %B %Y}."
    )

    stat_rows = sorted(projects, key=lambda p: (-p["star_count"], p["name"].lower()))
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
        total=len(projects),
        stars_note=stars_note,
        build_year=now.year,
        star_total=f"{star_total:,}" if star_total else "",
        download_total=f"{download_total:,}" if download_total else "",
        download_recent=f"{download_recent:,}" if download_recent else "",
        hf_total=f"{hf_total:,}" if hf_total else "",
        hf_recent=f"{hf_recent:,}" if hf_total else "",
        stat_rows=stat_rows,
        # "</" is escaped so the JSON cannot close the surrounding <script> element.
        chart_json=json.dumps(charts, separators=(",", ":")).replace("</", "<\\/"),
        has_charts=bool(charts),
        search_entries_json=search_entries_json,
    )

    OUT_DIR.mkdir(exist_ok=True)
    (OUT_DIR / "index.html").write_text(html, encoding="utf-8")
    shutil.copytree(ROOT / "demo", OUT_DIR / "demo", dirs_exist_ok=True)
