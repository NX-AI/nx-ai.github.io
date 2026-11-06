import {selectSeries} from './forecast-core.mjs';
const $ = id => document.getElementById(`demo-${id}`);
let data, selected, forecast, worker, running = false, hasModel = false;
const date = t => new Intl.DateTimeFormat('en-GB', {timeZone:'Europe/Vienna', day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit',timeZoneName:'short'}).format(new Date(t * 1000));
const number = v => new Intl.NumberFormat('en-GB', {maximumFractionDigits:0}).format(v);
function status(message, error = false) { $('status').textContent = message; $('status').classList.toggle('error', error); $('download-progress').hidden = true; }
function busy(value) {
  running = value;
  ['series','context','horizon','refresh'].forEach(id => $(id).disabled = value || !data);
  $('run').disabled = value || !selected;
  $('cancel').hidden = !value;
  $('download').disabled = value || !forecast;
}
function choose() {
  forecast = null;
  try {
    selected = selectSeries(data.series.find(s => s.id === $('series').value), Number($('context').value) / 24);
    const last = selected.start + (selected.values.length - 1) * 900;
    const age = Math.max(0, (Date.now() / 1000 - last - 900) / 3600);
    const missing = selected.values.filter(v => v === null).length;
    $('data-note').textContent = `Snapshot fetched ${date(Date.parse(data.fetched_at) / 1000)}. ${age > 6 ? 'Data is stale. ' : ''}Forecasts start at ${date(last + 900)}, after the last completed observation. ${missing} missing intervals are passed to the model as NaN.`;
    $('chart-title').textContent = `${selected.name}${selected.id === 'total_generation' ? '' : ' generation'} · Austria`;
    $('details').textContent = `${selected.values.length} context steps · 15 minutes · MW · the full selected context is shown`;
    $('empty').hidden = true;
    status(hasModel ? 'Ready. Adjust the forecast horizon or run a new forecast.' : 'Ready. Load the model to forecast on your device. First download: approximately 407 MB.');
  } catch (error) { selected = null; status(error.message, true); }
  busy(false); draw();
}
async function refresh() {
  $('refresh').disabled = true;
  try {
    const response = await fetch(new URL(`./data.json?t=${Math.floor(Date.now()/60000)}`, import.meta.url), {cache:'no-store', signal:AbortSignal.timeout(20000)});
    if (!response.ok) throw new Error(`Data fetch failed (${response.status}).`);
    const next = await response.json();
    if (next.version !== 1 || next.country !== 'AT' || next.unit !== 'MW' || next.step_seconds !== 900 || !next.series?.length || !Number.isFinite(Date.parse(next.fetched_at))) throw new Error('Unexpected generation data format.');
    const previous = $('series').value;
    data = next;
    $('series').replaceChildren(...data.series.map(s => new Option(s.name, s.id)));
    if (data.series.some(s => s.id === previous)) $('series').value = previous;
    else if (data.series.some(s => s.id === 'total_generation')) $('series').value = 'total_generation';
    choose();
  } catch (error) {
    status(`${error.message} ${data ? 'Keeping the previously loaded observations.' : 'Please try Refresh data again later.'}`, true);
    if (!data) $('empty').textContent = 'Generation data is currently unavailable.';
    $('refresh').disabled = false;
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
  el('desc',{id:'demo-chart-desc'},`${selected.name}, in MW. Observations through ${date(start+(n-1)*900)}. ${visibleForecast ? 'Forecast median and 10th to 90th quantiles follow.' : h ? 'No forecast yet.' : 'Historical observations; scroll right for the forecast.'}`);
  for (let i=0;i<=4;i++) { const v=min+(max-min)*i/4;el('line',{x1:left,x2:right,y1:y(v),y2:y(v),stroke:'var(--line)'});el('text',{x:left-10,y:y(v)+4,fill:'var(--soft)','text-anchor':'end','font-size':12},number(v)); }
  const tickCount = width < 600 ? 2 : 4;
  for (let i=0;i<=tickCount;i++) { const k=Math.round((n+h-1)*i/tickCount);el('text',{x:x(k),y:bottom+24,fill:'var(--soft)','text-anchor':i===0?'start':i===tickCount?'end':'middle','font-size':11},date(start+k*900)); }
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
  const marker = el('line',{y1:top,y2:bottom,stroke:'var(--accent)','stroke-dasharray':'3 4',visibility:'hidden'});
  const hideTooltip = () => { marker.setAttribute('visibility','hidden'); tooltip.hidden = true; };
  const inspect = event => {
    const point = new DOMPoint(event.clientX,event.clientY).matrixTransform(svg.getScreenCTM().inverse());
    if (point.x < left || point.x > right || point.y < top || point.y > bottom) { hideTooltip(); return; }
    const i = Math.max(0,Math.min(n+h-1,Math.round((point.x-left)/plotWidth*(n+h-1))));
    marker.setAttribute('x1',x(i));marker.setAttribute('x2',x(i));marker.setAttribute('visibility','visible');
    let value;
    if(i<n) value=Number.isFinite(obs[i]) ? `${number(obs[i])} MW observed` : 'Missing observation';
    else if(visibleForecast) { const k=i-n;value=`${number(visibleForecast.median[k])} MW median · ${number(visibleForecast.low[k])}–${number(visibleForecast.high[k])} MW (10–90%)`; }
    else value='Run the model to see a forecast';
    $('tooltip-time').textContent=date(start+i*900);
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
$('run').onclick = () => {
  if (running || !selected) return;
  forecast = null; draw(); busy(true);
  if (!worker) {
    worker = new Worker(new URL('./inference-worker.mjs',import.meta.url), {type:'module'});
    worker.onmessage = ({data: message}) => {
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
        forecast=message.forecast;hasModel=true;busy(false);draw();$('run').textContent='Run forecast ↗';
        status(`Forecast complete in ${message.seconds.toFixed(1)} seconds · ONNX Runtime Web / WASM · computed locally.`);
      }
    };
    worker.onerror = event => { status(`Unable to run the model: ${event.message || 'Worker failed.'} Check your connection and available browser memory.`,true);worker.terminate();worker=null;hasModel=false;busy(false); };
  }
  status(hasModel?'Forecasting…':'Loading model…');
  worker.postMessage({values:selected.values,horizon:Number($('horizon').value)});
};
$('cancel').onclick=()=>{worker?.terminate();worker=null;hasModel=false;busy(false);status('Forecast cancelled. You can retry when ready.');};
$('series').onchange=()=>{choose();if(hasModel && selected) $('run').click();};
$('context').oninput=()=>{
  const hours=Number($('context').value);
  const days=Math.floor(hours/24), rest=hours%24;
  const label=days ? `${days} ${days===1?'day':'days'}${rest?` ${rest} ${rest===1?'hour':'hours'}`:''}` : `${hours} ${hours===1?'hour':'hours'}`;
  $('context-value').textContent=label;
  $('context').setAttribute('aria-valuetext',label);
  if(data) choose();
  status(hasModel?'Release the slider to update the forecast.':'Load the model to forecast this context.');
};
$('context').onchange=()=>{if(hasModel && selected) $('run').click();};
$('horizon').oninput=()=>{
  const hours=Number($('horizon').value)/4;
  $('horizon-value').textContent=`${hours} hours`;
  $('horizon').setAttribute('aria-valuetext',`${hours} hours`);
  forecast=null;$('download').disabled=true;draw();
  status(hasModel?'Release the slider to update the forecast.':'Load the model to forecast this horizon.');
};
$('horizon').onchange=()=>{if(hasModel && selected) $('run').click();};
$('refresh').onclick=refresh;
$('download').onclick=()=>{
  if(!forecast)return;
  const start=selected.start+selected.values.length*900;
  const rows=['timestamp_utc,series,unit,q10,q50,q90',...forecast.median.map((v,i)=>`${new Date((start+i*900)*1000).toISOString()},${selected.id},MW,${forecast.low[i]},${v},${forecast.high[i]}`)];
  const url=URL.createObjectURL(new Blob([rows.join('\n')+'\n'],{type:'text/csv'}));
  const a=document.createElement('a');a.href=url;a.download=`tirex2-austria-${selected.id}.csv`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
};
refresh();
// Update freshness and observations while open, but never interrupt active inference.
setInterval(()=>{if(!running && !document.hidden) refresh();},30*60*1000);
