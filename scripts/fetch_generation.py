"""Fetch public generation for every country supported by Energy-Charts. No credentials; flag partial totals and preserve wholly missing intervals."""
import argparse
import datetime as dt
import json
import math
from pathlib import Path
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

SOURCE = 'https://api.energy-charts.info/v2/public_power'
TYPES = {'solar': 'Solar', 'wind_onshore': 'Wind onshore',
         'hydro_run_of_river': 'Hydro run-of-river',
         'hydro_water_reservoir': 'Hydro reservoir', 'fossil_gas': 'Fossil gas'}
# Known production categories. Load, trading, percentage
# shares and pumped-storage consumption are deliberately not production.
GENERATION_TYPES = ('hydro_run_of_river', 'biomass', 'fossil_gas', 'geothermal',
                    'hydro_water_reservoir', 'hydro_pumped_storage', 'others',
                    'waste', 'wind_onshore', 'solar')
COUNTRIES = 'at ba be bg ch cy cz de dk ee es fi fr ge gr hr hu ie it lt lu lv md me mk nl no pl pt ro rs se si sk xk'.split()
GENERATION_TYPES += ('nuclear', 'fossil_brown_coal_lignite', 'fossil_hard_coal',
                     'fossil_oil', 'fossil_oil_shale', 'fossil_peat',
                     'fossil_coal_derived_gas', 'wind_offshore', 'other_renewable',
                     'marine', 'other_renewables', 'battery')


def filter_usable_series(snapshot, now):
    """Keep every component when the country has any recent observations."""
    step = snapshot['step_seconds']
    recent = any(now.timestamp() - (series['start'] + len(series['values']) * step) <= 86400
                 for series in snapshot['series'])
    return snapshot if recent else {**snapshot, 'series': []}


def is_number(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def normalize(payload, now, country='at'):
    if (payload.get('country') != country or payload.get('unit') != 'MW'
            or payload.get('interval_minutes') not in (15, 30, 60)):
        raise ValueError('Unexpected country, units or interval in source response')
    step = payload['interval_minutes'] * 60
    descriptors = {s['id']: s.get('name', s['id']) for s in payload.get('series', [])}
    keys = set(descriptors) or {key for row in payload['data'] for key in row['values']}
    production = [key for key in GENERATION_TYPES if key in keys]
    if not production:
        raise ValueError('No recognized generation categories')
    points = {}
    for row in payload['data']:
        stamp = int(dt.datetime.fromisoformat(row['timestamp']).timestamp())
        if stamp % step:
            raise ValueError('Timestamp is off the source interval grid')
        if stamp + step > now.timestamp():
            continue  # completed observation intervals only
        if stamp in points:
            raise ValueError('Duplicate timestamp in source')
        values = dict(row['values'])
        components = [values.get(key) for key in production]
        # Preserve which totals depend on zero-filled source components.
        observed = [v for v in components if is_number(v)]
        values['total_generation'] = sum(observed) if observed else None
        values['total_incomplete'] = not all(map(is_number, components))
        points[stamp] = values
    if not points:
        raise ValueError('No completed observations')
    series = []
    names = {'total_generation': 'Total generation',
             **{key: descriptors.get(key, TYPES.get(key, key.replace('_', ' ').capitalize()))
                for key in production}}
    for key, name in names.items():
        finite = {t: row[key] for t, row in points.items()
                  if is_number(row.get(key))}
        if len(finite) < 86400 // step:
            continue
        end = max(finite)
        start = max(min(finite), end - 2047 * step)
        timestamps = list(range(start, end + step, step))
        item = {'id': key, 'name': name, 'start': start,
                'values': [finite.get(t) for t in timestamps]}
        if key == 'total_generation':
            item['incomplete'] = [points.get(t, {}).get('total_incomplete', True) for t in timestamps]
            item['missing_components'] = [[names[component] for component in production
                                           if not is_number(points.get(t, {}).get(component))]
                                          for t in timestamps]
        series.append(item)
    if not series:
        raise ValueError('Not enough observations for a forecast')
    return {'version': 1, 'country': country.upper(), 'unit': 'MW', 'step_seconds': step,
            'timezone': payload.get('timezone', 'UTC'),
            'fetched_at': now.isoformat(), 'source': SOURCE,
            'attribution': 'Energy-Charts.info / Fraunhofer ISE',
            'license': 'CC BY 4.0', 'series': series}


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix('.tmp')
    temporary.write_text(json.dumps(value, indent=2, allow_nan=False) + '\n')
    temporary.replace(path)


def download(request):
    for attempt in range(4):
        try:
            with urllib.request.urlopen(request, timeout=60) as response:
                return json.load(response)
        except urllib.error.HTTPError as error:
            if error.code not in (429, 500, 502, 503, 504) or attempt == 3:
                raise
            try:
                retry_after = int(error.headers.get('Retry-After', '0'))
            except ValueError:
                retry_after = 0
            time.sleep(min(60, max(2 ** attempt, retry_after)))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, default=Path('_site/demo/data.json'),
                        help='Austria snapshot path; other countries and manifest are written alongside it')
    args = parser.parse_args()
    now = dt.datetime.now(dt.timezone.utc)
    countries = []
    for country in COUNTRIES:
        path = args.output if country == 'at' else args.output.parent / 'data' / f'{country}.json'
        query = urllib.parse.urlencode({'country': country,
            'start': (now - dt.timedelta(days=22)).date().isoformat(),
            'end': now.date().isoformat()})
        try:
            request = urllib.request.Request(SOURCE + '?' + query,
                headers={'User-Agent': 'NXAI-TiRex2-browser-demo/1.0'})
            result = filter_usable_series(normalize(download(request), now, country), now)
            write_json(path, result)
            print(f'Updated {country}: {len(result["series"])} series', flush=True)
        except Exception as error:
            print(f'::warning::{country}: refresh failed ({error}); retaining any dated snapshot.', file=sys.stderr)
        available = False
        if path.exists():
            # Failed refreshes must not keep countries with only stale data selectable.
            saved = json.loads(path.read_text())
            if saved.get('version') == 1:
                saved = filter_usable_series(saved, now)
                write_json(path, saved)
                available = bool(saved['series'])
        countries.append({'code': country.upper(), 'file': str(path.relative_to(args.output.parent)),
                          'available': available})
    write_json(args.output.parent / 'countries.json', countries)
    return 0 if any(c['available'] for c in countries) else 1


if __name__ == '__main__':
    sys.exit(main())
