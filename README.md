# nx-ai.github.io

Source of the landing page at https://nx-ai.github.io, listing NXAI's public repositories,
documentation sites and resources.

## Editing content

Project listings live in `projects.yml`. To add, remove or change a project, edit that file and
push to `main`. The workflow builds and deploys the page automatically and refreshes the
GitHub star counts and generation snapshots approximately every 30 minutes.

Before adding a project, make sure its repository has a description, a LICENSE file and
topics. The build fails on placeholder licences such as `[LICENSE TBC]`, so unfinished
entries cannot be published by accident.

## Local preview

```bash
uv sync --locked
uv run build.py                    # builds _site/
uv run scripts/fetch_generation.py # refresh demo data
uv run python -m http.server -d _site
```

Without a `GITHUB_TOKEN` the anonymous GitHub API rate limit may apply; the page is then
built without star counts.

## TiRex-2 demo

`demo/` powers the homepage forecast using [TiRex-2 ONNX](https://nx-ai.github.io/tirex-2/how-to/onnx/) in the browser (407 MB download).
Country generation data comes from [Energy-Charts](https://api.energy-charts.info/) (CC BY 4.0),
refreshed by CI every 30 minutes; failed refreshes retain the dated snapshot.

## Rules

- Never create a folder named `linktree`, `tirex`, `tirex-2` or `vision-lstm` in this
  repository. Those paths are served by other NX-AI repositories, and a folder here would
  shadow them. The build checks for this.
- Do not set a custom domain for this repository. It would redirect all NX-AI project
  sites, including URLs already shared with customers and printed in papers.
- Third-party logos: only use marks whose owners permit this use (GitHub, Hugging Face).
  Conference names and arXiv appear as text only.
- The theme choice is stored under the localStorage key `nxai-links-theme`, shared with
  the linktree.

## Structure

| File | Purpose |
|---|---|
| `projects.yml` | Page content |
| `templates/index.html.j2` | Page layout and styles |
| `build.py` | Validates `projects.yml`, fetches star counts, renders `_site/index.html` |
| `.github/workflows/pages.yml` | Build and deployment via GitHub Actions |
