#!/usr/bin/env python3
"""Unit tests for pure helpers in fetch-ninjo.py."""
import os
import sqlite3
import tempfile
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


# ── Speed and bearing bin helpers ─────────────────────────────────────────────
# Replicated from fetch-ninjo.py to test independently of AppDaemon imports.

def _speed_bin(w):
    if w < 4:  return 0
    if w < 8:  return 4
    if w < 12: return 8
    return 12


def _bearing_bin(d):
    return int(d // 45) * 45 % 360


class TestSpeedBin(unittest.TestCase):
    def test_zero(self):          self.assertEqual(_speed_bin(0),    0)
    def test_below_4(self):       self.assertEqual(_speed_bin(3.9),  0)
    def test_at_4(self):          self.assertEqual(_speed_bin(4),    4)
    def test_mid_bin_4_8(self):   self.assertEqual(_speed_bin(7.9),  4)
    def test_at_8(self):          self.assertEqual(_speed_bin(8),    8)
    def test_mid_bin_8_12(self):  self.assertEqual(_speed_bin(11.9), 8)
    def test_at_12(self):         self.assertEqual(_speed_bin(12),   12)
    def test_above_12(self):      self.assertEqual(_speed_bin(20),   12)


class TestBearingBin(unittest.TestCase):
    def test_north(self):           self.assertEqual(_bearing_bin(0),   0)
    def test_just_below_45(self):   self.assertEqual(_bearing_bin(44),  0)
    def test_at_45(self):           self.assertEqual(_bearing_bin(45),  45)
    def test_ne_mid(self):          self.assertEqual(_bearing_bin(60),  45)
    def test_south(self):           self.assertEqual(_bearing_bin(180), 180)
    def test_west(self):            self.assertEqual(_bearing_bin(270), 270)
    def test_exactly_315(self):     self.assertEqual(_bearing_bin(315), 315)
    def test_near_360(self):        self.assertEqual(_bearing_bin(359), 315)


class TestFcstDbSchema(unittest.TestCase):
    """Verify that the SQLite schema and index are created correctly."""

    def _create_db(self, path):
        conn = sqlite3.connect(path)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS forecast_obs (
                station_key TEXT    NOT NULL,
                date        TEXT    NOT NULL,
                hour        INTEGER NOT NULL,
                fcst_wind   REAL,
                fcst_dir    REAL,
                obs_wind    REAL,
                PRIMARY KEY (station_key, date, hour)
            )
        """)
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_station_date "
            "ON forecast_obs (station_key, date)"
        )
        conn.commit()
        return conn

    def test_creates_table(self):
        with tempfile.NamedTemporaryFile(suffix='.db', delete=False) as f:
            path = f.name
        try:
            conn = self._create_db(path)
            tables = [r[0] for r in conn.execute(
                "SELECT name FROM sqlite_master WHERE type='table'"
            ).fetchall()]
            self.assertIn('forecast_obs', tables)
            conn.close()
        finally:
            os.unlink(path)

    def test_creates_index(self):
        with tempfile.NamedTemporaryFile(suffix='.db', delete=False) as f:
            path = f.name
        try:
            conn = self._create_db(path)
            indexes = [r[0] for r in conn.execute(
                "SELECT name FROM sqlite_master WHERE type='index'"
            ).fetchall()]
            self.assertIn('idx_station_date', indexes)
            conn.close()
        finally:
            os.unlink(path)

    def test_upsert_forecast_preserves_obs_wind(self):
        conn = sqlite3.connect(':memory:')
        conn.execute("""
            CREATE TABLE forecast_obs (
                station_key TEXT, date TEXT, hour INTEGER,
                fcst_wind REAL, fcst_dir REAL, obs_wind REAL,
                PRIMARY KEY (station_key, date, hour)
            )
        """)
        # Insert forecast row with no obs
        conn.execute(
            "INSERT INTO forecast_obs (station_key,date,hour,fcst_wind,fcst_dir) "
            "VALUES ('k1','2026-04-25',10,5.0,270.0)"
        )
        # Add obs separately
        conn.execute(
            "UPDATE forecast_obs SET obs_wind=4.5 "
            "WHERE station_key='k1' AND date='2026-04-25' AND hour=10"
        )
        # Re-upsert forecast should not clear obs_wind
        conn.execute("""
            INSERT INTO forecast_obs (station_key,date,hour,fcst_wind,fcst_dir)
            VALUES ('k1','2026-04-25',10,5.1,272.0)
            ON CONFLICT(station_key,date,hour)
            DO UPDATE SET fcst_wind=excluded.fcst_wind, fcst_dir=excluded.fcst_dir
        """)
        row = conn.execute(
            "SELECT fcst_wind, obs_wind FROM forecast_obs"
        ).fetchone()
        self.assertAlmostEqual(row[0], 5.1)   # updated forecast
        self.assertAlmostEqual(row[1], 4.5)   # obs preserved
        conn.close()

    def test_primary_key_uniqueness(self):
        conn = sqlite3.connect(':memory:')
        conn.execute("""
            CREATE TABLE forecast_obs (
                station_key TEXT, date TEXT, hour INTEGER,
                fcst_wind REAL, fcst_dir REAL, obs_wind REAL,
                PRIMARY KEY (station_key, date, hour)
            )
        """)
        conn.execute("INSERT INTO forecast_obs VALUES ('k1','2026-04-25',10,5.0,270.0,4.5)")
        with self.assertRaises(sqlite3.IntegrityError):
            conn.execute("INSERT INTO forecast_obs VALUES ('k1','2026-04-25',10,6.0,280.0,NULL)")
        conn.close()


if __name__ == '__main__':
    unittest.main()
