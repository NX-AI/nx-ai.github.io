import datetime as dt
import unittest
from scripts.fetch_generation import normalize, GENERATION_TYPES

class GenerationTests(unittest.TestCase):
    def test_total_excludes_non_generation_and_requires_all_components(self):
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
        self.assertEqual(total['values'][0], 100)
        self.assertIsNone(total['values'][40])
        self.assertEqual(total['values'][41], 90)

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
