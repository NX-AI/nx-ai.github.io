export const CONTEXT = 2048, FUTURE = 320, PATCH = 32;
export function makeContext(values) {
  if (!Array.isArray(values) || !values.some(Number.isFinite)) {
    throw new Error('At least one observed value is needed.');
  }
  const context = new Float32Array(CONTEXT + FUTURE).fill(NaN);
  const tail = values.slice(-CONTEXT);
  tail.forEach((v, i) => { if (Number.isFinite(v)) context[CONTEXT - tail.length + i] = v; });
  return context;
}
export function extractForecast(data, dims, horizon) {
  if (!Number.isInteger(horizon) || horizon < 1 || horizon > FUTURE) throw new Error('Invalid horizon.');
  if (dims.length !== 3 || dims[0] !== 1 || dims[1] !== 9 || dims[2] < FUTURE + PATCH) {
    throw new Error(`Unexpected model output shape: ${dims.join(' × ')}`);
  }
  const width = dims[2], start = width - FUTURE - PATCH;
  const result = [0, 4, 8].map(q => Array.from(data.slice(q * width + start, q * width + start + horizon)));
  if (!result.flat().every(Number.isFinite)) throw new Error('Model returned non-finite predictions.');
  return {low: result[0], median: result[1], high: result[2]};
}
export function selectSeries(series, days, step = 900) {
  if (!Number.isInteger(series.start) || !Array.isArray(series.values) || series.values.length > CONTEXT) {
    throw new Error('Invalid generation data.');
  }
  if (series.values.some(v => v !== null && !Number.isFinite(v))) throw new Error('Invalid generation value.');
  const steps = days * 86400 / step;
  if (!Number.isInteger(steps) || days < 1 / 24 || days > 21 || ![900, 1800, 3600].includes(step)) throw new Error("Context must be between 1 hour and 21 days.");
  const values = series.values.slice(-steps);
  if (!Number.isFinite(values.at(-1))) throw new Error('Latest observation is missing.');
  return {...series, values, start: series.start + (series.values.length - values.length) * step};
}

export function formatDuration(minutes) {
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const rest = minutes % 60;
  const units = days ? [[days, 'day'], [hours, 'hour']] : [[hours, 'hour'], [rest, 'minute']];
  return units
    .filter(([n]) => n).map(([n, unit]) => `${n} ${unit}${n === 1 ? '' : 's'}`).join(' ');
}

// Later passes condition on prior medians; their bands are conditional intervals.
export async function forecastLong(values, horizon, predict) {
  if (!Number.isInteger(horizon) || horizon < 1 || horizon > 672) throw new Error('Invalid horizon.');
  let context = values.slice(-CONTEXT);
  const result = {low: [], median: [], high: []};
  while (result.median.length < horizon) {
    const count = Math.min(FUTURE, horizon - result.median.length);
    const chunk = await predict(makeContext(context), count);
    for (const key of ['low', 'median', 'high']) {
      if (chunk[key]?.length !== count || !chunk[key].every(Number.isFinite)) throw new Error('Invalid forecast chunk.');
      result[key].push(...chunk[key]);
    }
    context = [...context, ...chunk.median].slice(-CONTEXT);
  }
  return result;
}
