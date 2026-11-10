import {selectSeries, formatDuration} from './forecast-core.mjs?v=full-context';
const $ = id => document.getElementById(`demo-${id}`);
let data, selected, forecast, worker, running = false, hasModel = false;
let countries = [{code:'AT',file:'data.json',available:true}], country = 'AT', loading = false;
const regionNames = new Intl.DisplayNames(['en'], {type:'region'});
const countryName = code => regionNames.of(code === 'UK' ? 'GB' : code);
const flag = code => [...(code === 'UK' ? 'GB' : code)].map(c => String.fromCodePoint(127397 + c.charCodeAt(0))).join('');
const step = () => data?.step_seconds || 900;
const date = t => new Intl.DateTimeFormat('en-GB', {timeZone:data?.timezone || 'Europe/Vienna', day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit',timeZoneName:'short'}).format(new Date(t * 1000));
const number = v => new Intl.NumberFormat('en-GB', {maximumFractionDigits:0}).format(v);
function status(message, error = false) {
  $('download-progress').hidden = true;
  if (error) window.alert(message);
}
function busy(value) {
  running = value;
  ['series','series-toggle','context','horizon','refresh','country','country-select'].forEach(id => $(id).disabled = value || loading || !data);
  $('run').disabled = value || loading || !selected;
  $('cancel').hidden = !value;
  $('download').disabled = value || loading || !forecast;
}
function choose() {
  $('forecast-time').hidden = true;
  forecast = null;
  try {
    selected = selectSeries(data.series.find(s => s.id === $('series').value), Number($('context').value) / 24, step());
    $('series-toggle').textContent = selected.name;
    const last = selected.start + (selected.values.length - 1) * step();
    const age = Math.max(0, (Date.now() / 1000 - last - step()) / 3600);
    const missing = selected.values.filter(v => v === null).length;
    const incomplete = selected.incomplete?.filter((flag, i) => flag && Number.isFinite(selected.values[i])).length || 0;
    $('incomplete-legend').hidden = !incomplete;
    $('data-note').textContent = `Updated ${date(Date.parse(data.fetched_at) / 1000)}. Forecast starts ${date(last + step())}.${age > 6 ? ' Observations are delayed.' : ''}${missing ? ` ${missing} readings are missing.` : ''}${incomplete ? ` Red totals count missing components as zero (${incomplete} readings).` : ''}${data.series.some(s => s.id === 'total_generation') ? '' : ' Total generation is unavailable because its history is incomplete or delayed.'}`;
    $('chart-title').textContent = `${selected.name}${selected.id === 'total_generation' ? '' : ' generation'} · ${countryName(country)}`;
    $('empty').hidden = true;
    status(hasModel ? 'Ready. Adjust the forecast horizon or run a new forecast.' : 'Ready. Load the model to forecast on your device. First download: approximately 407 MB.');
  } catch (error) { selected = null; status(error.message, true); }
  busy(false); draw();
}
async function refresh(nextCountry = country) {
  if (loading || running) return;
  loading = true; busy(false);
  status(`Loading ${countryName(nextCountry)} generation…`);
  try {
    const entry = countries.find(c => c.code === nextCountry && c.available);
    if (!entry) throw new Error('No generation snapshot is available for this country.');
    const response = await fetch(new URL(`./${entry.file}?t=${Math.floor(Date.now()/60000)}`, import.meta.url), {cache:'no-store', signal:AbortSignal.timeout(20000)});
    if (!response.ok) throw new Error(`Data fetch failed (${response.status}).`);
    const next = await response.json();
    if (next.version !== 1 || next.country !== nextCountry || next.unit !== 'MW' || ![900,1800,3600].includes(next.step_seconds) || !next.series?.length || !Number.isFinite(Date.parse(next.fetched_at))) throw new Error('Unexpected generation data format.');
    for (const series of next.series) selectSeries(series, 7, next.step_seconds);
    new Intl.DateTimeFormat('en', {timeZone:next.timezone || 'UTC'});
    const previous = $('series').value;
    const horizonHours = Number($('horizon').value) * step() / 3600;
    data = next; country = nextCountry;
    $('country').textContent = `${flag(country)} ${countryName(country)}`;
    $('country-select').value = country;
    $('source').href = `https://energy-charts.info/charts/power/chart.htm?l=en&c=${country}`;
    $('horizon').max = 7 * 86400 / step();
    $('horizon').value = Math.max(1, Math.min(Number($('horizon').max), Math.round(horizonHours * 3600 / step())));
    const horizonLabel = formatDuration(Number($('horizon').value) * step() / 60);
    $('horizon-value').textContent = horizonLabel;
    $('horizon').setAttribute('aria-valuetext', horizonLabel);
    $('series').replaceChildren(...data.series.map(s => new Option(s.name, s.id)));
    if (data.series.some(s => s.id === previous)) $('series').value = previous;
    else if (data.series.some(s => s.id === 'total_generation')) $('series').value = 'total_generation';
    else $('series').value = data.series[0].id;
    loading = false; choose();
  } catch (error) {
    $('country-select').value = country;
    status(`${error.message} ${data ? 'Keeping the previously loaded observations.' : 'Please try Refresh data again later.'}`, true);
    if (!data) $('empty').textContent = 'Generation data is currently unavailable.';
  } finally {
    loading = false;
    if (!running) busy(false);
    $('refresh').disabled = running;
  }
}
function draw() {
  const svg = $('chart');
  const tooltip = $('tooltip');
  tooltip.hidden = true;
  svg.replaceChildren();
  if (!selected) return;
  const width = svg.clientWidth, height = svg.clientHeight;
  if (!width || !height) return;
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  const left = 52, right = width - 12, top = 25, bottom = height - 50;
  const plotWidth = Math.max(1, right - left);
  const NS = 'http://www.w3.org/2000/svg';
  const el = (tag, attrs, text) => { const n = document.createElementNS(NS, tag); for (const [k,v] of Object.entries(attrs)) n.setAttribute(k,v); if (text) n.textContent=text; svg.append(n); return n; };
  const obs = selected.values, n = obs.length;
  const h = Number($('horizon').value);
  const visibleForecast = forecast;
  const start = selected.start;
  const all = [...obs, ...(visibleForecast ? [...visibleForecast.low,...visibleForecast.high,...visibleForecast.median] : [])].filter(Number.isFinite);
  const min = Math.min(0,...all), max = Math.max(1,...all) * 1.1;
  const x = i => left + i / (n + h - 1) * plotWidth, y = v => bottom - (v - min)/(max-min)*(bottom-top);
  el('desc',{id:'demo-chart-desc'},`${selected.name}, in MW. Observations through ${date(start+(n-1)*step())}. ${visibleForecast ? 'Forecast median and 10th to 90th quantiles follow.' : h ? 'No forecast yet.' : 'Historical observations; scroll right for the forecast.'}`);
  for (let i=0;i<=4;i++) { const v=min+(max-min)*i/4;el('line',{x1:left,x2:right,y1:y(v),y2:y(v),stroke:'var(--line)'});el('text',{x:left-10,y:y(v)+4,fill:'var(--soft)','text-anchor':'end','font-size':12},number(v)); }
  const tickCount = width < 600 ? 2 : 4;
  for (let i=0;i<=tickCount;i++) { const k=Math.round((n+h-1)*i/tickCount);el('text',{x:x(k),y:bottom+24,fill:'var(--soft)','text-anchor':i===0?'start':i===tickCount?'end':'middle','font-size':11},date(start+k*step())); }
  if (h > 0) {
  const cutoff=x(n);el('line',{x1:cutoff,x2:cutoff,y1:top,y2:bottom,stroke:'var(--accent)','stroke-dasharray':'4 5',opacity:.6});
  el('text',{x:Math.min(cutoff+9,right-68),y:top-8,fill:'var(--accent)','font-size':12},'Forecast →');
  }
  function line(values, offset, color) {
    let path='', pen=false;
    values.forEach((v,i)=>{ if(!Number.isFinite(v)){pen=false;return;}path+=`${pen?'L':'M'}${x(i+offset)},${y(v)} `;pen=true; });
    el('path',{d:path,fill:'none',stroke:color,'stroke-width':2,'stroke-linejoin':'round'});
  }
  if (visibleForecast) {
    const top=visibleForecast.high.map((v,i)=>`${x(n+i)},${y(v)}`), bottom=visibleForecast.low.map((v,i)=>`${x(n+i)},${y(v)}`).reverse();
    el('polygon',{points:[...top,...bottom].join(' '),fill:'var(--shade)'});
    line(visibleForecast.median,n,'var(--accent)');
  }
  line(obs,0,'var(--observed)');
  let incompletePath = '';
  obs.forEach((v, i) => {
    if (!Number.isFinite(v)) return;
    if (i && Number.isFinite(obs[i-1]) && (selected.incomplete?.[i] || selected.incomplete?.[i-1])) {
      incompletePath += `M${x(i-1)},${y(obs[i-1])}L${x(i)},${y(v)} `;
    }
    if (selected.incomplete?.[i] && (!selected.incomplete[i-1] || !Number.isFinite(obs[i-1])) && (!selected.incomplete[i+1] || !Number.isFinite(obs[i+1]))) el('circle', {cx:x(i), cy:y(v), r:2.5, fill:'#d64545'});
  });
  if (incompletePath) el('path', {d:incompletePath, fill:'none', stroke:'#d64545', 'stroke-width':2});
  const marker = el('line',{y1:top,y2:bottom,stroke:'var(--accent)','stroke-dasharray':'3 4',visibility:'hidden'});
  const hideTooltip = () => { marker.setAttribute('visibility','hidden'); tooltip.hidden = true; };
  const inspect = event => {
    const point = new DOMPoint(event.clientX,event.clientY).matrixTransform(svg.getScreenCTM().inverse());
    if (point.x < left || point.x > right || point.y < top || point.y > bottom) { hideTooltip(); return; }
    const i = Math.max(0,Math.min(n+h-1,Math.round((point.x-left)/plotWidth*(n+h-1))));
    marker.setAttribute('x1',x(i));marker.setAttribute('x2',x(i));marker.setAttribute('visibility','visible');
    let value;
    if(i<n) {
      value=Number.isFinite(obs[i]) ? `${number(obs[i])} MW${selected.incomplete?.[i] ? '' : ' observed'}` : 'Missing observation';
      if (selected.missing_components?.[i]?.length) value += `\nMissing components:\n${selected.missing_components[i].map(name => `• ${name}`).join('\n')}`;
      else if (selected.incomplete?.[i]) value += '\nMissing components: details unavailable';
    }
    else if(visibleForecast) { const k=i-n;value=`${number(visibleForecast.median[k])} MW median · ${number(visibleForecast.low[k])}–${number(visibleForecast.high[k])} MW (10–90%)`; }
    else value='Run the model to see a forecast';
    $('tooltip-time').textContent=date(start+i*step());
    $('tooltip-value').textContent=value;
    tooltip.hidden=false;
    const bounds=svg.parentElement.getBoundingClientRect();
    const px=event.clientX-bounds.left, py=event.clientY-bounds.top;
    const tooltipWidth=tooltip.offsetWidth, tooltipHeight=tooltip.offsetHeight;
    let tx=px+14, ty=py-tooltipHeight-12;
    if(tx+tooltipWidth>bounds.width-8) tx=px-tooltipWidth-14;
    if(ty<8) ty=py+14;
    tooltip.style.left=`${Math.max(8,Math.min(tx,bounds.width-tooltipWidth-8))}px`;
    tooltip.style.top=`${Math.max(8,Math.min(ty,bounds.height-tooltipHeight-8))}px`;
  };
  svg.onpointermove=inspect;
  svg.onpointerleave=hideTooltip;
  svg.onpointercancel=hideTooltip;
}
new ResizeObserver(() => draw()).observe($('chart'));
$('model-dialog').onclose = () => {
  worker?.postMessage({type:'download-decision', approved:$('model-dialog').returnValue === 'download'});
};
$('run').onclick = () => {
  if (running || !selected) return;
  $('forecast-time').hidden = true;
  forecast = null; draw(); busy(true);
  if (!worker) {
    worker = new Worker(new URL('./inference-worker.mjs',import.meta.url), {type:'module'});
    worker.onmessage = ({data: message}) => {
      if (message.type === 'confirm-download') {
        $('model-dialog').returnValue = '';
        $('model-dialog').showModal();
      }
      if (message.type === 'cancelled') { busy(false); status('Download cancelled.'); $('run').focus(); }
      if (message.type === 'status') status(message.message);
      if (message.type === 'progress') {
        $('download-progress').hidden = false;
        const mb = bytes => (bytes / 1e6).toFixed(1);
        if (message.total > 0) {
          const percent = Math.min(100, message.loaded / message.total * 100);
          $('model-progress').value = percent;
          $('progress-label').textContent = `Downloading checkpoint · ${percent.toFixed(0)}% · ${mb(message.loaded)} / ${mb(message.total)} MB`;
        } else {
          $('model-progress').removeAttribute('value');
          $('progress-label').textContent = `Downloading checkpoint · ${mb(message.loaded)} MB received`;
        }
      }
      if (message.type === 'error') { status(`Forecast failed: ${message.message} Try a desktop browser with more free memory, or retry.`,true); worker.terminate();worker=null;hasModel=false;busy(false); }
      if (message.type === 'result') {
        forecast=message.forecast;hasModel=true;busy(false);draw();
        $('forecast-time').textContent = `Forecasted in ${message.seconds.toFixed(1)} s`;
        $('forecast-time').hidden = false;
        status(`Forecast complete in ${message.seconds.toFixed(1)} seconds · ONNX Runtime Web / WASM · computed locally.`);
      }
    };
    worker.onerror = event => { status(`Unable to run the model: ${event.message || 'Worker failed.'} Check your connection and available browser memory.`,true);worker.terminate();worker=null;hasModel=false;busy(false); };
  }
  status(hasModel?'Forecasting…':'Loading model…');
  worker.postMessage({values:selected.values,horizon:Number($('horizon').value)});
};
$('cancel').onclick=()=>{worker?.terminate();worker=null;hasModel=false;busy(false);status('Forecast cancelled. You can retry when ready.');};
$('series').onchange=()=>{closeSeries(); $('series-toggle').focus(); choose();};
$('context').oninput=()=>{
  const hours=Number($('context').value);
  const days=Math.floor(hours/24), rest=hours%24;
  const label=days ? `${days} ${days===1?'day':'days'}${rest?` ${rest} ${rest===1?'hour':'hours'}`:''}` : `${hours} ${hours===1?'hour':'hours'}`;
  $('context-value').textContent=label;
  $('context').setAttribute('aria-valuetext',label);
  if(data) choose();
};
$('horizon').oninput=()=>{
  const label=formatDuration(Number($('horizon').value)*step()/60);
  $('horizon-value').textContent=label;
  $('horizon').setAttribute('aria-valuetext',label);
  forecast=null;$('forecast-time').hidden=true;$('download').disabled=true;draw();
};
$('refresh').onclick=()=>refresh();
$('download').onclick=()=>{
  if(!forecast)return;
  const start=selected.start+selected.values.length*step();
  const rows=['timestamp_utc,country,series,unit,q10,q50,q90',...forecast.median.map((v,i)=>`${new Date((start+i*step())*1000).toISOString()},${country},${selected.id},MW,${forecast.low[i]},${v},${forecast.high[i]}`)];
  const url=URL.createObjectURL(new Blob([rows.join('\n')+'\n'],{type:'text/csv'}));
  const a=document.createElement('a');a.href=url;a.download=`tirex2-${country.toLowerCase()}-${selected.id}.csv`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
};
function closeSeries() {
  $('series-menu').hidden = true;
  $('series-toggle').setAttribute('aria-expanded', 'false');
}
$('series-toggle').onclick = () => {
  const open = $('series-menu').hidden;
  closeCountries();
  $('series-menu').hidden = !open;
  $('series-toggle').setAttribute('aria-expanded', String(open));
  if (open) {
    const menu = $('series-menu'), anchor = $('series-toggle').getBoundingClientRect();
    menu.style.left = `${Math.max(8 - anchor.left, Math.min(0, document.documentElement.clientWidth - 8 - anchor.left - menu.offsetWidth))}px`;
    $('series').focus();
  }
};
document.addEventListener('click', event => { if (!event.target.closest('.demo-series-picker')) closeSeries(); });
document.addEventListener('keydown', event => { if (event.key === 'Escape' && !$('series-menu').hidden) { closeSeries(); $('series-toggle').focus(); } });
function closeCountries() {
  $('country-menu').hidden = true;
  $('country').setAttribute('aria-expanded', 'false');
}
$('country').onclick = () => {
  closeSeries();
  const open = $('country-menu').hidden;
  $('country-menu').hidden = !open;
  $('country').setAttribute('aria-expanded', String(open));
  if (open) {
    const menu = $('country-menu');
    const anchor = $('country').getBoundingClientRect();
    menu.style.left = `${Math.max(8 - anchor.left, Math.min(0, document.documentElement.clientWidth - 8 - anchor.left - menu.offsetWidth))}px`;
    $('country-select').focus();
  }
};
$('country-select').onchange = () => {
  const next = $('country-select').value;
  closeCountries(); $('country').focus(); refresh(next);
};
document.addEventListener('click', event => { if (!event.target.closest('.demo-country-picker')) closeCountries(); });
document.addEventListener('keydown', event => { if (event.key === 'Escape' && !$('country-menu').hidden) { closeCountries(); $('country').focus(); } });
async function initialize() {
  try {
    const response = await fetch(new URL('./countries.json', import.meta.url), {cache:'no-store', signal:AbortSignal.timeout(20000)});
    if (!response.ok) throw new Error('Country list unavailable');
    const list = await response.json();
    if (!Array.isArray(list) || !list.some(c => c.code === 'AT') || list.some(c => !/^[A-Z]{2}$/.test(c.code) || !/^(data\.json|data\/[a-z]{2}\.json)$/.test(c.file))) throw new Error('Invalid country list');
    countries = list;
  } catch { /* The bundled Austria snapshot remains usable if the manifest is unavailable. */ }
  $('country-select').replaceChildren(...countries.filter(c => c.available)
    .sort((a,b)=>countryName(a.code).localeCompare(countryName(b.code)))
    .map(c => new Option(`${flag(c.code)} ${countryName(c.code)}`, c.code)));
  const initialCountry = countries.find(c => c.code === country && c.available)
    || countries.find(c => c.available);
  if (!initialCountry) {
    $('empty').textContent = 'Recent generation data is currently unavailable.';
    busy(false);
    return;
  }
  $('country-select').value = initialCountry.code;
  await refresh(initialCountry.code);
}
initialize();
// Update freshness and observations while open, but never interrupt active inference.
setInterval(()=>{if(!running && !document.hidden) refresh();},30*60*1000);

// Shared overlay for control hints, including keyboard focus.
const hint = document.createElement('div');
hint.id = 'demo-control-tooltip';
hint.setAttribute('role', 'tooltip');
hint.hidden = true;
document.getElementById('forecast-demo').append(hint);
let hintTarget;
function hideHint() {
  hint.hidden = true;
  hintTarget?.removeAttribute('aria-describedby');
  hintTarget = null;
}
function showHint(target) {
  hideHint();
  if (target.disabled || target.getAttribute('aria-expanded') === 'true') return;
  hintTarget = target;
  hint.textContent = target.dataset.tooltip;
  target.setAttribute('aria-describedby', hint.id);
  hint.hidden = false;
  const rect = target.getBoundingClientRect();
  const left = Math.max(8, Math.min(rect.left + (rect.width - hint.offsetWidth) / 2,
    document.documentElement.clientWidth - hint.offsetWidth - 8));
  const top = rect.top >= hint.offsetHeight + 16 ? rect.top - hint.offsetHeight - 8 : rect.bottom + 8;
  hint.style.left = `${left}px`;
  hint.style.top = `${top}px`;
}
document.querySelectorAll('#forecast-demo [data-tooltip]').forEach(target => {
  target.addEventListener('pointerenter', () => showHint(target));
  target.addEventListener('focus', () => showHint(target));
  target.addEventListener('pointerleave', hideHint);
  target.addEventListener('blur', hideHint);
  target.addEventListener('click', hideHint);
});
document.addEventListener('keydown', event => { if (event.key === 'Escape') hideHint(); });
window.addEventListener('scroll', hideHint, true);
window.addEventListener('resize', hideHint);
