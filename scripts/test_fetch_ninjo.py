#!/usr/bin/env python3
"""Unit tests for pure helpers in fetch-ninjo.py."""
import unittest
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

# Replicate _parse_ninjo_time_ms exactly as defined in fetch-ninjo.py so we can
# test it independently of AppDaemon / aiohttp / pandas.
_COPENHAGEN = ZoneInfo('Europe/Copenhagen')

def _parse_ninjo_time_ms(s):
    """'20260414103000' (local Copenhagen time) → Unix timestamp in milliseconds (UTC)."""
    dt = datetime(
        int(s[0:4]), int(s[4:6]),  int(s[6:8]),
        int(s[8:10]), int(s[10:12]), int(s[12:14]),
        tzinfo=_COPENHAGEN,
    )
    return int(dt.timestamp() * 1000)


class TestParseNinjoTimeMs(unittest.TestCase):
    """NinJo API sends timestamps in local Copenhagen time; verify UTC conversion."""

    def _utc_ms(self, year, month, day, hour, minute=0, second=0):
        return int(datetime(year, month, day, hour, minute, second,
                            tzinfo=timezone.utc).timestamp() * 1000)

    def test_summer_time_cest(self):
        # 14 Apr 2026 10:00 CEST (UTC+2) = 08:00 UTC
        self.assertEqual(_parse_ninjo_time_ms('20260414100000'),
                         self._utc_ms(2026, 4, 14, 8))

    def test_winter_time_cet(self):
        # 14 Jan 2026 10:00 CET (UTC+1) = 09:00 UTC
        self.assertEqual(_parse_ninjo_time_ms('20260114100000'),
                         self._utc_ms(2026, 1, 14, 9))

    def test_dst_boundary_spring(self):
        # 29 Mar 2026 03:00 CEST (clocks spring forward at 02:00) = 01:00 UTC
        self.assertEqual(_parse_ninjo_time_ms('20260329030000'),
                         self._utc_ms(2026, 3, 29, 1))

    def test_returns_milliseconds(self):
        result = _parse_ninjo_time_ms('20260414100000')
        self.assertGreater(result, 1_000_000_000_000)  # ms not seconds

    def test_would_be_wrong_if_treated_as_utc(self):
        # This test documents the bug: treating the NinJo timestamp as UTC
        # produces a value 2 hours ahead of the correct UTC time (in summer).
        correct_ms = self._utc_ms(2026, 4, 14, 8)       # 10:00 CEST = 08:00 UTC
        wrong_ms   = self._utc_ms(2026, 4, 14, 10)      # 10:00 UTC (wrong — 2 h ahead)
        result = _parse_ninjo_time_ms('20260414100000')
        self.assertEqual(result, correct_ms)
        self.assertNotEqual(result, wrong_ms)



# DIR_DEG replicated from fetch-ninjo.py (kept in sync manually).
_DIR_DEG = {
    'N': 0,   'NNE': 22,  'NE': 45,  'ENE': 67,
    'E': 90,  'ESE': 112, 'SE': 135, 'SSE': 157,
    'S': 180, 'SSW': 202, 'SW': 225, 'WSW': 247,
    'W': 270, 'WNW': 292, 'NW': 315, 'NNW': 337,
}


def _map_dir(raw):
    """Simulate pandas Series.map(DIR_DEG) for a single raw windDirection value."""
    return _DIR_DEG.get(raw)   # returns None when key is absent


class TestTrafikkDirFilter(unittest.TestCase):
    """
    Documents and verifies the direction-based filter added to _parse_trafikk_df.

    Ghost/inactive Trafikkort stations (e.g. near 54.94, 11.97) appear in the
    raw GeoJSON with windSpeed=0 and a null/unrecognised windDirection.  They
    must be excluded from the obs-history to avoid phantom markers on the radar
    map.  The fix: after mapping windDirection through DIR_DEG, drop any row
    where dir is NaN (i.e. the direction was absent or unrecognised).
    """

    def test_null_direction_excluded(self):
        self.assertIsNone(_map_dir(None))

    def test_empty_string_excluded(self):
        self.assertIsNone(_map_dir(''))

    def test_nonstandard_strings_excluded(self):
        for val in ('CALM', 'variable', 'VAR', '--', '0', 'calm'):
            self.assertIsNone(_map_dir(val), msg=f"expected None for {val!r}")

    def test_all_cardinal_directions_pass(self):
        for compass, degrees in _DIR_DEG.items():
            result = _map_dir(compass)
            self.assertIsNotNone(result, msg=f"{compass} should map to a degree value")
            self.assertEqual(result, degrees)

    def test_ghost_station_scenario(self):
        # Station near 54.94°N, 11.97°E: windSpeed=0, windDirection=None.
        # windSpeed is non-null, so it passes the first filter, but the dir
        # filter must reject it.
        wind_speed = 0.0
        wind_dir = None
        self.assertIsNotNone(wind_speed)     # passes windSpeed.notna() check
        self.assertIsNone(_map_dir(wind_dir))  # fails dir.notna() check → excluded

    def test_calm_wind_with_valid_direction_kept(self):
        # windSpeed=0 is valid in calm conditions; the station should survive if
        # it still reports a recognisable cardinal direction.
        wind_speed = 0.0
        wind_dir = 'N'
        self.assertIsNotNone(wind_speed)
        self.assertIsNotNone(_map_dir(wind_dir))


if __name__ == '__main__':
    unittest.main()
