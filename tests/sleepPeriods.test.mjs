import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const schema = readFileSync(new URL('../src-tauri/src/sleep_periods.sql', import.meta.url), 'utf8');
function dbAt(path = ':memory:') {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys=ON; CREATE TABLE time_entries(id INTEGER PRIMARY KEY); INSERT INTO time_entries VALUES (1), (2);');
  db.exec(schema);
  return db;
}
const insert = (db, entry, start, end = null) => db.prepare('INSERT INTO sleep_periods(entry_id,started_ms,ended_ms) VALUES(?,?,?)').run(entry, start, end);

test('records separate half-open sleep periods and rejects overlap or missing owner', () => {
  const db = dbAt();
  insert(db, 1, 1000, 2000); insert(db, 1, 2000, 3000); insert(db, 2, 1500, 2500);
  assert.throws(() => insert(db, 1, 1999, 2001), /overlapping/);
  assert.throws(() => insert(db, 1, 4000, 4000), /CHECK/);
  assert.throws(() => insert(db, 9, 4000, 5000), /FOREIGN KEY/);
  assert.throws(() => insert(db, 1, -1, 0), /CHECK/);
  assert.throws(() => insert(db, 1, 8640000000000001, null), /CHECK/);
  assert.equal(db.prepare('SELECT count(*) AS n FROM sleep_periods').get().n, 3);
  db.close();
});

test('records suspend before resume, refuses an overlapping second open period and preserves decisions', () => {
  const db = dbAt();
  assert.throws(() => db.prepare("INSERT INTO sleep_periods(entry_id,started_ms,ended_ms,decision,decided_ms) VALUES(1,10,20,'included',30)").run(), /start pending/);
  insert(db, 1, 1000);
  assert.throws(() => insert(db, 1, 2000), /overlapping|UNIQUE/);
  assert.throws(() => db.prepare("UPDATE sleep_periods SET decision='included', decided_ms=2100").run(), /CHECK/);
  db.prepare('UPDATE sleep_periods SET ended_ms=2000 WHERE entry_id=1').run();
  db.prepare("UPDATE sleep_periods SET decision='excluded', decided_ms=2500 WHERE entry_id=1 AND decision='pending'").run();
  assert.throws(() => db.prepare("UPDATE sleep_periods SET decision='included' WHERE entry_id=1").run(), /immutable/);
  assert.throws(() => db.prepare('UPDATE sleep_periods SET started_ms=500 WHERE entry_id=1').run(), /immutable/);
  assert.throws(() => db.prepare('DELETE FROM sleep_periods').run(), /retained/);
  db.close();
});

test('keeps pending and decided periods across closing and reopening a separate file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tracker-sleep-test-'));
  try {
    const path = join(dir, 'fixture.sqlite'); let db = dbAt(path);
    insert(db, 1, 1000, 2000); insert(db, 1, 3000, 4000);
    db.prepare("UPDATE sleep_periods SET decision='included', decided_ms=5000 WHERE started_ms=1000").run();
    db.close(); db = new DatabaseSync(path); db.exec('PRAGMA foreign_keys=ON');
    assert.deepEqual(db.prepare('SELECT started_ms,ended_ms,decision FROM sleep_periods ORDER BY started_ms').all().map(x => ({...x})), [
      { started_ms:1000, ended_ms:2000, decision:'included' }, { started_ms:3000, ended_ms:4000, decision:'pending' }
    ]);
    assert.equal(db.prepare("UPDATE sleep_periods SET decision='excluded', decided_ms=6000 WHERE started_ms=1000 AND decision='pending'").run().changes, 0);
    db.close();
  } finally { rmSync(dir, {recursive:true, force:true}); }
});


test('a failed migration rolls back, and a verified pre-migration backup keeps the original entries', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tracker-sleep-migration-'));
  try {
    const path = join(dir, 'live.sqlite'), backupPath = join(dir, 'before.sqlite');
    const db = new DatabaseSync(path);
    db.exec("PRAGMA foreign_keys=ON; CREATE TABLE time_entries(id INTEGER PRIMARY KEY, note TEXT); INSERT INTO time_entries VALUES(41,'oryginalny wpis'); PRAGMA user_version=11;");
    db.prepare('VACUUM INTO ?').run(backupPath);
    const backup = new DatabaseSync(backupPath, { readOnly:true });
    assert.equal(backup.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    assert.equal(backup.prepare('PRAGMA user_version').get().user_version, 11);
    assert.equal(backup.prepare('SELECT note FROM time_entries WHERE id=41').get().note, 'oryginalny wpis');
    db.exec('CREATE TABLE sleep_periods(id INTEGER PRIMARY KEY); BEGIN IMMEDIATE;');
    assert.throws(() => db.exec(schema));
    db.exec('ROLLBACK;');
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 11);
    assert.equal(db.prepare('SELECT note FROM time_entries WHERE id=41').get().note, 'oryginalny wpis');
    db.exec('DROP TABLE sleep_periods; BEGIN IMMEDIATE;');
    db.exec(schema);
    db.exec('PRAGMA user_version=12; COMMIT;');
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 12);
    assert.equal(db.prepare('SELECT note FROM time_entries WHERE id=41').get().note, 'oryginalny wpis');
    assert.equal(backup.prepare('PRAGMA user_version').get().user_version, 11);
    backup.close(); db.close();
  } finally { rmSync(dir, {recursive:true, force:true}); }
});

test('a manually supplied resume remains pending and cannot be silently rewritten', () => {
  const db = dbAt();
  try {
    insert(db, 1, 1000);
    assert.throws(() => db.prepare('UPDATE sleep_periods SET manual_resume=1').run(), /CHECK/);
    db.prepare('UPDATE sleep_periods SET ended_ms=2000,manual_resume=1 WHERE entry_id=1 AND ended_ms IS NULL').run();
    assert.deepEqual({...db.prepare('SELECT ended_ms,manual_resume,decision FROM sleep_periods WHERE entry_id=1').get()}, {ended_ms:2000,manual_resume:1,decision:'pending'});
    assert.throws(() => db.prepare('UPDATE sleep_periods SET manual_resume=0').run(), /immutable/);
    assert.throws(() => db.prepare('UPDATE sleep_periods SET ended_ms=3000').run(), /immutable/);
  } finally { db.close(); }
});

// D4 short sleep, schema v14: the same SQL files the Rust migration executes (sleep_periods.rs).
const schemaV14 = readFileSync(new URL('../src-tauri/src/sleep_periods_v14.sql', import.meta.url), 'utf8');
const migrationV14 = readFileSync(new URL('../src-tauri/src/sleep_periods_v14_migration.sql', import.meta.url), 'utf8');
const sleepRows = db => db.prepare('SELECT id,entry_id,started_ms,ended_ms,manual_resume,decision,decided_ms FROM sleep_periods ORDER BY id').all().map(row => ({ ...row }));
const schemaObjects = ['sleep_periods', 'sleep_periods_pending', 'sleep_periods_one_open', 'sleep_periods_initial_pending', 'sleep_periods_no_overlap_insert', 'sleep_periods_no_overlap_update', 'sleep_periods_immutable', 'sleep_periods_no_delete'];

test('v14 migration rebuilds the table with every row and decision kept and the exact v14 definitions', () => {
  const db = dbAt();
  insert(db, 1, 1000, 2000); insert(db, 1, 3000, 400000); insert(db, 1, 500000, 600000); insert(db, 2, 1000, null);
  db.prepare("UPDATE sleep_periods SET decision='included', decided_ms=700000 WHERE started_ms=3000").run();
  db.prepare("UPDATE sleep_periods SET decision='excluded', decided_ms=700001 WHERE started_ms=500000").run();
  const before = sleepRows(db);
  const [prepare, copy] = migrationV14.split('-- @schema');
  assert.ok(prepare && copy, 'the migration has one schema marker');
  db.exec('BEGIN IMMEDIATE');
  db.exec(prepare); db.exec(schemaV14); db.exec(copy);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM (SELECT id,entry_id,started_ms,ended_ms,manual_resume,decision,decided_ms FROM sleep_periods EXCEPT SELECT id,entry_id,started_ms,ended_ms,manual_resume,decision,decided_ms FROM sleep_periods_v13)').get().n, 0);
  db.exec('DROP TABLE sleep_periods_v13; COMMIT');
  assert.deepEqual(sleepRows(db), before, 'ids, boundaries, flags and decisions are unchanged; the short pending sleep stays pending');
  const canonical = new DatabaseSync(':memory:');
  canonical.exec('CREATE TABLE time_entries(id INTEGER PRIMARY KEY);'); canonical.exec(schemaV14);
  const definition = (target, name) => target.prepare('SELECT sql FROM sqlite_master WHERE name=?').get(name)?.sql;
  for (const name of schemaObjects) assert.equal(definition(db, name), definition(canonical, name), name);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name='sleep_periods_v13'").get().n, 0);
  // The v14 protections still hold after the rebuild.
  assert.throws(() => insert(db, 1, 1500, 2500), /overlapping/);
  assert.throws(() => db.prepare('DELETE FROM sleep_periods').run(), /retained for audit/);
  assert.throws(() => db.prepare("UPDATE sleep_periods SET decision='excluded' WHERE started_ms=3000").run(), /immutable/);
  canonical.close(); db.close();
});

test('v14 stores an automatic decision only for a complete, observed sleep under 300000 ms, at its end', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON; CREATE TABLE time_entries(id INTEGER PRIMARY KEY); INSERT INTO time_entries VALUES (1);');
  db.exec(schemaV14);
  const auto = id => db.prepare("UPDATE sleep_periods SET decision='auto_included', decided_ms=ended_ms WHERE id=?").run(id);
  const id = (start, end) => Number(insert(db, 1, start, end).lastInsertRowid);
  assert.throws(() => db.prepare("INSERT INTO sleep_periods(entry_id,started_ms,ended_ms,decision,decided_ms) VALUES(1,800000,801000,'auto_included',801000)").run(), /start pending/);
  const short = id(0, 299999), boundary = id(300000, 600000), open = id(700000, null);
  auto(short);
  assert.throws(() => auto(boundary), /CHECK/, 'exactly five minutes asks');
  assert.throws(() => auto(open), /CHECK/, 'an unfinished period asks');
  assert.throws(() => db.prepare("UPDATE sleep_periods SET decision='auto_included', decided_ms=ended_ms-1 WHERE id=?").run(boundary), /CHECK/);
  db.prepare('UPDATE sleep_periods SET ended_ms=750000, manual_resume=1 WHERE id=?').run(open);
  assert.throws(() => auto(open), /CHECK/, 'a user-supplied resume is never decided automatically');
  assert.throws(() => db.prepare("UPDATE sleep_periods SET decision='excluded', decided_ms=1 WHERE id=?").run(short), /immutable/);
  assert.deepEqual(sleepRows(db).map(row => [row.decision, row.decided_ms]), [['auto_included', 299999], ['pending', null], ['pending', null]]);
  db.close();
});
