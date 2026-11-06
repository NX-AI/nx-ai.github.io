# nx-ai.github.io

Source of the landing page at https://nx-ai.github.io, listing NXAI's public repositories,
documentation sites and resources.

## Editing content

Project listings live in `projects.yml`. To add, remove or change a project, edit that file and
push to `main`. The workflow builds and deploys the page automatically and refreshes the
GitHub star counts and Austrian generation snapshots approximately every 30 minutes.

Before adding a project, make sure its repository has a description, a LICENSE file and
topics. The build fails on placeholder licences such as `[LICENSE TBC]`, so unfinished
entries cannot be published by accident.

## Local preview

```bash
uv sync --locked

## TiRex-2 demo

`demo/` powers the homepage forecast using [TiRex-2 ONNX](https://nx-ai.github.io/tirex-2/how-to/onnx/) in the browser (407 MB download).
Austrian generation comes from [Energy-Charts](https://api.energy-charts.info/) (CC BY 4.0),
refreshed by CI every 30 minutes; failed refreshes retain the dated snapshot.
