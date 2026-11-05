export function validateEntries(entries) {
  if (!Array.isArray(entries)) throw new Error('Search entries must be an array.');
  const ids = new Set();
  for (const entry of entries) {
    for (const field of ['id', 'title', 'text', 'group', 'url']) {
      if (typeof entry?.[field] !== 'string' || !entry[field].trim()) {
        throw new Error(`Search entry has an invalid ${field}.`);
      }
    }
    if (ids.has(entry.id)) throw new Error(`Duplicate search entry: ${entry.id}`);
    ids.add(entry.id);
  }
}
