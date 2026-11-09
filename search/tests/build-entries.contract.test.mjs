import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Runs build.py on a temporary copy of the site sources with all network access refused.
// Run with `uv run --locked node --test search/tests/*.test.mjs` to use the project dependencies.
// NXAI_BUILD_PYTHON can override the default python3 interpreter on PATH.
const python = process.env.NXAI_BUILD_PYTHON || 'python3';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const offlineRunner = `
import runpy, socket, sys, urllib.error, urllib.request
def refuse(*args, **kwargs):
    raise urllib.error.URLError("network access is disabled in this test")
def no_connect(*args, **kwargs):
    raise OSError("network access is disabled in this test")
urllib.request.urlopen = refuse
socket.socket.connect = no_connect
socket.create_connection = no_connect
script = sys.argv[1]
sys.argv = [script]
runpy.run_path(script, run_name="__main__")
`;
const yamlToJson = 'import json, sys, yaml\nprint(json.dumps(yaml.safe_load(open(sys.argv[1], encoding="utf-8").read())))';

let workdir;
let built;

after(() => {
  if (workdir) fs.rmSync(workdir, { recursive: true, force: true });
});

function run(args, cwd) {
  return spawnSync(python, args, { cwd, encoding: 'utf8', timeout: 120000 });
}

function build() {
  if (built) return built;
  const probe = run(['-c', 'import jinja2, yaml'], root);
  assert.equal(probe.status, 0,
    `${python} cannot import jinja2 and yaml; run tests with uv run --locked node --test search/tests/*.test.mjs, or set NXAI_BUILD_PYTHON to a Python with the project dependencies installed.\n${probe.stderr ?? probe.error}`);
  workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'nxai-build-entries-'));
  for (const file of ['build.py', 'projects.yml']) fs.copyFileSync(path.join(root, file), path.join(workdir, file));
  fs.cpSync(path.join(root, 'templates'), path.join(workdir, 'templates'), { recursive: true });
  fs.cpSync(path.join(root, 'demo'), path.join(workdir, 'demo'), { recursive: true });
  const searchDir = path.join(root, 'search');
  fs.cpSync(searchDir, path.join(workdir, 'search'), {
    recursive: true,
    filter: (source) => path.relative(searchDir, source).split(path.sep)[0] !== 'tests',
  });
  const result = run(['-c', offlineRunner, path.join(workdir, 'build.py')], workdir);
  assert.equal(result.status, 0, `build.py failed without network:\n${result.stdout}\n${result.stderr}`);
  const data = run(['-c', yamlToJson, path.join(workdir, 'projects.yml')], workdir);
  assert.equal(data.status, 0, `projects.yml could not be read:\n${data.stderr}`);
  const site = path.join(workdir, '_site');
  built = {
    projects: JSON.parse(data.stdout),
    entriesText: fs.readFileSync(path.join(site, 'search', 'entries.json'), 'utf8'),
    html: fs.readFileSync(path.join(site, 'index.html'), 'utf8'),
  };
  return built;
}

// The embedding text format must not change: the published vectors are computed from it.
function expectedEntries(projects) {
  const entries = projects.documentation.map((d) => ({
    id: d.url,
    title: d.title,
    text: `Resource type: documentation | Description: ${d.description}`,
    group: 'documentation',
    url: d.url,
    snippet: d.description,
  }));
  for (const group of projects.groups) {
    for (const project of group.projects) {
      const labels = [
        `Model family: ${group.title}`,
        'Resource type: project',
        `Description: ${project.description}`,
        `Repository: ${project.repo}`,
        `Licence: ${project.license}`,
        `Venue: ${project.venue.conf} ${project.venue.detail}`,
        `Links: ${project.links.map((link) => link.label).join(', ')}`,
      ];
      if (project.install) labels.push(`Install: ${project.install}`);
      entries.push({
        id: project.repo,
        title: project.name,
        text: labels.join(' | '),
        group: group.id,
        url: `https://github.com/${project.repo}`,
        snippet: project.description,
      });
    }
  }
  return entries;
}

function inlineEntries(html) {
  const match = html.match(/<script\b[^>]*\bid="search-entries"[^>]*>([\s\S]*?)<\/script>/);
  assert.ok(match, 'index.html has no <script id="search-entries"> element');
  return JSON.parse(match[1]);
}

test('entries.json gives every documentation and project entry a snippet equal to its description', () => {
  const { projects, entriesText } = build();
  const entries = JSON.parse(entriesText);
  const descriptions = new Map([
    ...projects.documentation.map((d) => [d.url, d.description]),
    ...projects.groups.flatMap((group) => group.projects.map((p) => [p.repo, p.description])),
  ]);
  assert.equal(entries.length, descriptions.size, 'entries.json does not have one entry per documentation item and project');
  for (const entry of entries) {
    assert.ok(descriptions.has(entry.id), `Unknown entry id ${entry.id}`);
    assert.ok(Object.hasOwn(entry, 'snippet'), `${entry.id} has no snippet field`);
    assert.equal(entry.snippet, descriptions.get(entry.id), `${entry.id} snippet is not its projects.yml description`);
  }
});

test('entries.json keeps id, title, text, group and url unchanged and adds only snippet', () => {
  const { projects, entriesText } = build();
  const entries = JSON.parse(entriesText);
  const expected = expectedEntries(projects);
  assert.deepEqual(entries.map((entry) => entry.id), expected.map((entry) => entry.id), 'Entry order changed');
  entries.forEach((entry, i) => {
    assert.deepEqual(Object.keys(entry).sort(), ['group', 'id', 'snippet', 'text', 'title', 'url'], `${entry.id} has unexpected fields`);
    for (const field of ['id', 'title', 'text', 'group', 'url']) {
      assert.equal(entry[field], expected[i][field], `${entry.id} changed field ${field}`);
    }
  });
});

test('the inline search-entries script carries the same entries, snippets included', () => {
  const { projects, entriesText, html } = build();
  const inline = inlineEntries(html);
  assert.deepEqual(inline, JSON.parse(entriesText), 'Inline entries differ from entries.json');
  assert.deepEqual(inline, expectedEntries(projects), 'Inline entries do not match projects.yml');
});
