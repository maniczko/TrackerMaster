"""Disposable contract spike; NOT production timekeeping software.

Uses wall clock for intervals: it does not safely handle sleep, crashes or clock
changes. Those decisions remain open and must be solved in the Tauri product.
"""
import sqlite3
from datetime import datetime, timezone


def utc_now():
    return datetime.now(timezone.utc).isoformat(timespec="microseconds")


class Tracker:
    def __init__(self, path, clock=utc_now):
        self.clock = clock
        self.db = sqlite3.connect(path, timeout=5)
        self.db.row_factory = sqlite3.Row
        self.db.execute("PRAGMA foreign_keys = ON")
        self.db.executescript("""
        CREATE TABLE IF NOT EXISTS clients(id INTEGER PRIMARY KEY, name TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS projects(id INTEGER PRIMARY KEY, client_id INTEGER NOT NULL REFERENCES clients(id), name TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS tasks(id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES projects(id), name TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS entries(id INTEGER PRIMARY KEY, task_id INTEGER NOT NULL REFERENCES tasks(id), started_at TEXT NOT NULL, ended_at TEXT);
        CREATE UNIQUE INDEX IF NOT EXISTS one_active ON entries((1)) WHERE ended_at IS NULL;
        """)

    def close(self):
        self.db.close()

    def _insert(self, sql, *args):
        with self.db:
            return self.db.execute(sql, args).lastrowid

    @staticmethod
    def _name(value):
        if not isinstance(value, str) or not value.strip():
            raise ValueError("Nazwa nie może być pusta")
        return value.strip()

    def create_client(self, name):
        return self._insert("INSERT INTO clients(name) VALUES (?)", self._name(name))

    def create_project(self, client_id, name):
        return self._insert("INSERT INTO projects(client_id,name) VALUES (?,?)", client_id, self._name(name))

    def create_task(self, project_id, name):
        return self._insert("INSERT INTO tasks(project_id,name) VALUES (?,?)", project_id, self._name(name))

    def clients(self):
        return [dict(x) for x in self.db.execute("SELECT * FROM clients ORDER BY name,id")]

    def projects(self, client_id):
        return [dict(x) for x in self.db.execute("SELECT * FROM projects WHERE client_id=? ORDER BY name,id", (client_id,))]

    def tasks(self, project_id):
        return [dict(x) for x in self.db.execute("SELECT * FROM tasks WHERE project_id=? ORDER BY name,id", (project_id,))]

    def active(self):
        row = self.db.execute("SELECT e.*,t.name AS task,p.name AS project,c.name AS client FROM entries e JOIN tasks t ON t.id=e.task_id JOIN projects p ON p.id=t.project_id JOIN clients c ON c.id=p.client_id WHERE e.ended_at IS NULL").fetchone()
        return dict(row) if row else None

    def start(self, task_id):
        """Switch to a task in one transaction. Rollback keeps previous active entry."""
        now = self.clock()
        with self.db:
            if not self.db.execute("SELECT 1 FROM tasks WHERE id=?", (task_id,)).fetchone():
                raise ValueError("Nie znaleziono zadania")
            self.db.execute("UPDATE entries SET ended_at=? WHERE ended_at IS NULL", (now,))
            return self.db.execute("INSERT INTO entries(task_id,started_at) VALUES (?,?)", (task_id, now)).lastrowid

    def stop(self):
        now = self.clock()
        with self.db:
            result = self.db.execute("UPDATE entries SET ended_at=? WHERE ended_at IS NULL", (now,))
            return result.rowcount == 1

    def history(self):
        return [dict(x) for x in self.db.execute("SELECT e.*,t.name AS task,p.name AS project,c.name AS client FROM entries e JOIN tasks t ON t.id=e.task_id JOIN projects p ON p.id=t.project_id JOIN clients c ON c.id=p.client_id ORDER BY e.id DESC")]
