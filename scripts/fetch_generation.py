"""Fetch public Austrian generation. No credentials; never synthesize missing readings."""
import argparse
import datetime as dt
import json
import math
from pathlib import Path
import sys
import urllib.parse
import urllib.request

SOURCE = 'https://api.energy-charts.info/v2/public_power'
TYPES = {'solar': 'Solar', 'wind_onshore': 'Wind onshore',
         'hydro_run_of_river': 'Hydro run-of-river',
         'hydro_water_reservoir': 'Hydro reservoir', 'fossil_gas': 'Fossil gas'}
# All generation components published for Austria. Load, trading, percentage
# shares and pumped-storage consumption are deliberately not production.
GENERATION_TYPES = ('hydro_run_of_river', 'biomass', 'fossil_gas', 'geothermal',
                    'hydro_water_reservoir', 'hydro_pumped_storage', 'others',
                    'waste', 'wind_onshore', 'solar')
STEP = 900


def is_number(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def normalize(payload, now):
    if (payload.get('country') != 'at' or payload.get('unit') != 'MW'
            or payload.get('interval_minutes') != 15):
        raise ValueError('Unexpected country, units or interval in source response')
    points = {}
    for row in payload['data']:
        stamp = int(dt.datetime.fromisoformat(row['timestamp']).timestamp())
        if stamp % STEP:
            raise ValueError('Timestamp is off the 15-minute grid')
        if stamp + STEP > now.timestamp():
            continue  # completed observation intervals only
        if stamp in points:
            raise ValueError('Duplicate timestamp in source')
        values = dict(row['values'])
        components = [values.get(key) for key in GENERATION_TYPES]
        # A partial sum would understate total generation. Preserve it as a gap.
        values['total_generation'] = sum(components) if all(map(is_number, components)) else None
        points[stamp] = values
    if not points:
        raise ValueError('No completed observations')
    series = []
    for key, name in {'total_generation': 'Total generation', **TYPES}.items():
        finite = {t: row[key] for t, row in points.items()
                  if is_number(row.get(key))}
        if len(finite) < 96:
            continue
        end = max(finite)
        start = max(min(finite), end - 2047 * STEP)
        timestamps = list(range(start, end + STEP, STEP))
        series.append({'id': key, 'name': name, 'start': start,
                       'values': [finite.get(t) for t in timestamps]})
    if not series:
        raise ValueError('Not enough observations for a forecast')
    return {'version': 1, 'country': 'AT', 'unit': 'MW', 'step_seconds': STEP,
            'fetched_at': now.isoformat(), 'source': SOURCE,
            'attribution': 'Energy-Charts.info / Fraunhofer ISE',
            'license': 'CC BY 4.0', 'series': series}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path,
                        default=Path('_site/demo/data.json'))
    args = parser.parse_args()
    now = dt.datetime.now(dt.timezone.utc)
    query = urllib.parse.urlencode({'country': 'at',
        'start': (now - dt.timedelta(days=22)).date().isoformat(),
        'end': now.date().isoformat()})
    try:
        request = urllib.request.Request(SOURCE + '?' + query,
            headers={'User-Agent': 'NXAI-TiRex2-browser-demo/1.0'})
        with urllib.request.urlopen(request, timeout=60) as response:
            result = normalize(json.load(response), now)
        args.output.parent.mkdir(parents=True, exist_ok=True)
        temporary = args.output.with_suffix('.tmp')
        temporary.write_text(json.dumps(result, separators=(',', ':'), allow_nan=False) + '\n')
        temporary.replace(args.output)
        print(f'Updated {len(result["series"])} generation series at {args.output}')
    except Exception as error:
        # The build already copied the dated real snapshot; the UI reports its age.
        print(f'::warning::Generation refresh failed ({type(error).__name__}); retaining dated snapshot.', file=sys.stderr)
        if not args.output.exists():
            return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
