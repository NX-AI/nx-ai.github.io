import datetime as dt
import unittest
import json
from pathlib import Path
import tempfile
from unittest.mock import patch
from scripts import fetch_generation
from scripts.fetch_generation import normalize, GENERATION_TYPES

class GenerationTests(unittest.TestCase):
    def test_total_excludes_non_generation_and_flags_missing_components(self):
        p = self.payload()
        for row in p['data']:
            row['values'] = {key: 10.0 for key in GENERATION_TYPES}
            row['values'].update(load=9999, cross_border_electricity_trading=500,
                                 hydro_pumped_storage_consumption=-500,
                                 renewable_share_of_generation=50)
        p['data'][40]['values']['biomass'] = None
        p['data'][41]['values']['solar'] = 0
        result = normalize(p, dt.datetime(2026, 11, 1, tzinfo=dt.timezone.utc))
        total = result['series'][0]
        self.assertEqual(total['id'], 'total_generation')
        self.assertEqual(total['values'][0], 10 * len(GENERATION_TYPES))
        self.assertEqual(total['values'][40], 10 * (len(GENERATION_TYPES) - 1))
        self.assertTrue(total['incomplete'][40])
        self.assertEqual(total['missing_components'][40], ['Biomass'])
        self.assertEqual(total['missing_components'][41], [])
        self.assertFalse(total['incomplete'][41])
        self.assertEqual(total['values'][41], 10 * (len(GENERATION_TYPES) - 1))

    def test_country_specific_total_and_hourly_grid(self):
        p = self.payload()
        p['country'] = 'fr'
        p['interval_minutes'] = 60
        p['timezone'] = 'Europe/Paris'
        p['series'] = [{'id': key, 'name': key} for key in ('nuclear', 'solar', 'load')]
        start = dt.datetime(2026, 10, 20, tzinfo=dt.timezone.utc)
        for i, row in enumerate(p['data']):
            row['timestamp'] = (start + dt.timedelta(hours=i)).isoformat()
            row['values'] = {'nuclear': 100, 'solar': 10, 'load': 999}
        p['data'][40]['values']['nuclear'] = None
        result = normalize(p, dt.datetime(2026, 11, 1, tzinfo=dt.timezone.utc), 'fr')
        self.assertEqual(result['country'], 'FR')
        self.assertEqual(result['step_seconds'], 3600)
        self.assertEqual(result['series'][0]['values'][0], 110)
        self.assertEqual(result['series'][0]['values'][40], 10)
        self.assertTrue(result['series'][0]['incomplete'][40])
        with self.assertRaises(ValueError):
            normalize(p, dt.datetime.now(dt.timezone.utc), 'de')

    def test_refresh_isolates_country_failures_and_preserves_snapshot(self):
        payload = self.payload()
        payload['country'] = 'de'
        start = dt.datetime.now(dt.timezone.utc).replace(minute=0, second=0, microsecond=0) - dt.timedelta(days=3)
        for i, row in enumerate(payload['data']):
            row['timestamp'] = (start + dt.timedelta(minutes=15*i)).isoformat()
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / 'data.json'
            saved = normalize(payload, dt.datetime.now(dt.timezone.utc), 'de')
            saved['country'] = 'AT'
            output.write_text(json.dumps(saved))
            stale = {**saved, 'country': 'FR', 'series': [dict(s, start=s['start'] - 3 * 86400) for s in saved['series']]}
            (Path(directory) / 'data').mkdir()
            (Path(directory) / 'data/fr.json').write_text(json.dumps(stale))
            with patch('sys.argv', ['fetch_generation', '--output', str(output)]), \
                 patch.object(fetch_generation, 'COUNTRIES', ['at', 'de', 'fr']), \
                 patch.object(fetch_generation, 'download', side_effect=[OSError('offline'), payload, OSError('offline')]):
                self.assertEqual(fetch_generation.main(), 0)
            self.assertEqual(json.loads(output.read_text())['fetched_at'], saved['fetched_at'])
            self.assertTrue(json.loads(output.read_text())['series'])
            self.assertEqual(json.loads((Path(directory) / 'data/fr.json').read_text())['series'], [])
            self.assertEqual(json.loads((Path(directory) / 'data/de.json').read_text())['country'], 'DE')
            manifest = json.loads((Path(directory) / 'countries.json').read_text())
            self.assertEqual([c['available'] for c in manifest], [True, True, False])

    def test_sparse_and_delayed_components_remain_available_for_recent_country(self):
        now = dt.datetime(2026, 11, 1, tzinfo=dt.timezone.utc)
        step = 900
        def series(key, count=1344, missing=0, lag=0):
            return {'id': key, 'name': key,
                    'start': int(now.timestamp()) - (count + lag) * step,
                    'values': ([0.0] * count if key == 'total_generation' else [None] * missing + [0.0] * (count - missing)),
                    'incomplete': [True] * missing + [False] * (count - missing)}
        def kept(*items):
            snapshot = {'step_seconds': step, 'series': list(items)}
            return fetch_generation.filter_usable_series(snapshot, now)['series']
        healthy = series('total_generation', missing=20)
        self.assertEqual(kept(healthy), [healthy])
        self.assertTrue(kept(series('total_generation', missing=516)))
        self.assertTrue(kept(series('total_generation', count=548)))
        self.assertFalse(kept(series('total_generation', lag=97)))
        solar = series('solar', count=200)
        self.assertEqual(len(kept(series('total_generation', missing=1247), solar)), 2)
        self.assertTrue(kept(series('solar', missing=516)))
        delayed = series('fossil_oil', lag=200)
        self.assertEqual(kept(healthy, delayed), [healthy, delayed])
        self.assertFalse(kept(series('solar', lag=97)))

    def test_total_includes_other_renewables_and_battery_discharge(self):
        p = self.payload()
        for row in p['data']:
            row['values'] = {'solar': 10, 'other_renewables': 20, 'battery': 30,
                             'battery_consumption': -40, 'load': 1000}
        result = normalize(p, dt.datetime(2026, 11, 1, tzinfo=dt.timezone.utc))
        self.assertEqual(result['series'][0]['values'][0], 60)
        self.assertIn('other_renewables', [s['id'] for s in result['series']])
        self.assertIn('battery', [s['id'] for s in result['series']])

    def payload(self):
        start = dt.datetime(2026, 10, 24, tzinfo=dt.timezone.utc)
        return {'country': 'at', 'unit': 'MW', 'interval_minutes': 15,
                'data': [{'timestamp': (start + dt.timedelta(minutes=15*i)).isoformat(),
                          'values': {'solar': float(i)}} for i in range(200)]}

    def test_preserves_gaps_and_real_zero(self):
        p = self.payload()
        del p['data'][40]
        result = normalize(p, dt.datetime(2026, 11, 1, tzinfo=dt.timezone.utc))
        s = result['series'][0]
        self.assertEqual(len(s['values']), 200)
        self.assertEqual(s['values'][0], 0)
        self.assertIsNone(s['values'][40])
        self.assertTrue(s['incomplete'][40])
        self.assertEqual(s['missing_components'][40], ['Solar'])
        self.assertFalse(s['incomplete'][0])
        self.assertIsNone(result['series'][1]['values'][40])

    def test_all_missing_total_is_missing_and_trailing_gaps_are_trimmed(self):
        p = self.payload()
        p['data'][50]['values']['solar'] = None
        p['data'][-1]['values']['solar'] = None
        total = normalize(p, dt.datetime(2026, 11, 1, tzinfo=dt.timezone.utc))['series'][0]
        self.assertIsNone(total['values'][50])
        self.assertTrue(total['incomplete'][50])
        self.assertEqual(total['values'][-1], 198)
        self.assertFalse(total['incomplete'][-1])
        self.assertEqual(len(total['values']), 199)

    def test_known_zero_with_missing_component_remains_zero(self):
        p = self.payload()
        for row in p['data']:
            row['values'] = {'solar': 0, 'wind_onshore': None}
        total = normalize(p, dt.datetime(2026, 11, 1, tzinfo=dt.timezone.utc))['series'][0]
        self.assertEqual(total['values'][50], 0)
        self.assertTrue(total['incomplete'][50])

    def test_only_completed_intervals(self):
        p = self.payload()
        now = dt.datetime.fromisoformat(p['data'][100]['timestamp']) + dt.timedelta(minutes=5)
        s = normalize(p, now)['series'][0]
        self.assertEqual(len(s['values']), 100)
        self.assertEqual(s['values'][-1], 99)

    def test_rejects_duplicates_and_wrong_units(self):
        p = self.payload()
        p['data'].append(p['data'][0])
        with self.assertRaises(ValueError):
            normalize(p, dt.datetime.now(dt.timezone.utc))
        p = self.payload()
        p['unit'] = 'GW'
        with self.assertRaises(ValueError):
            normalize(p, dt.datetime.now(dt.timezone.utc))

    def test_dst_offsets_preserve_elapsed_time(self):
        p = self.payload()
        p['data'][0]['timestamp'] = '2026-10-24T02:00:00+02:00'
        s = normalize(p, dt.datetime(2026, 11, 1, tzinfo=dt.timezone.utc))['series'][0]
        self.assertEqual(s['start'], 1792800000)
        self.assertEqual(len(s['values']), 200)
