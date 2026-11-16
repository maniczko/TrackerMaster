import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from tracker import Tracker


class TrackerTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path = str(Path(self.temp.name) / "tracker.sqlite")
        self.times = iter(["2026-01-01T09:00:00+00:00", "2026-01-01T09:10:00+00:00", "2026-01-01T09:20:00+00:00"])
        self.t = Tracker(self.path, lambda: next(self.times))
        self.client = self.t.create_client("Klient A")
        self.project = self.t.create_project(self.client, "Projekt")
        self.a = self.t.create_task(self.project, "Zadanie A")
        self.b = self.t.create_task(self.project, "Zadanie B")

    def tearDown(self):
        self.t.close()
        self.temp.cleanup()

    def test_switch_stop_and_reload(self):
        self.t.start(self.a)
        self.t.start(self.b)
        self.assertEqual(self.t.active()["task_id"], self.b)
        self.assertTrue(self.t.stop())
        records = self.t.history()
        self.assertEqual(records[1]["ended_at"], records[0]["started_at"])
        self.t.close()
        self.t = Tracker(self.path)
        self.assertIsNone(self.t.active())
        self.assertEqual(len(self.t.history()), 2)
        self.assertEqual(self.t.history()[0]["client"], "Klient A")

    def test_invalid_switch_keeps_original_active(self):
        self.t.start(self.a)
        with self.assertRaises(ValueError):
            self.t.start(999999)
        self.assertEqual(self.t.active()["task_id"], self.a)
        self.assertEqual(len(self.t.history()), 1)

    def test_invalid_parent_and_empty_name(self):
        with self.assertRaises(sqlite3.IntegrityError):
            self.t.create_project(999999, "X")
        with self.assertRaises(ValueError):
            self.t.create_client("  ")
        self.assertEqual(len(self.t.clients()), 1)

    def test_database_rejects_two_active_entries(self):
        self.t.start(self.a)
        with self.assertRaises(sqlite3.IntegrityError):
            with self.t.db:
                self.t.db.execute("INSERT INTO entries(task_id,started_at) VALUES (?,?)", (self.b, "2026-01-01"))
        self.assertEqual(self.t.active()["task_id"], self.a)


if __name__ == "__main__":
    unittest.main()
