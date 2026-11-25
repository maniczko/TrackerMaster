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

// TECH-12 / DEV-39 PR 1, schema v15: the same SQL files and resume statement the Rust code executes
// (sleep_periods.rs, migrate_source and RESUME_SQL). Every period carries a source, 'sleep' or 'idle'.
const schemaV15 = readFileSync(new URL('../src-tauri/src/sleep_periods_v15.sql', import.meta.url), 'utf8');
const migrationV15 = readFileSync(new URL('../src-tauri/src/sleep_periods_v15_migration.sql', import.meta.url), 'utf8');
const sleepRust = readFileSync(new URL('../src-tauri/src/sleep_periods.rs', import.meta.url), 'utf8');
const resumeV15 = sleepRust.match(/const RESUME_SQL: &str = "(UPDATE sleep_periods SET ended_ms=\?1, decision=CASE[^"]+)"/)[1];
const shortSleepMs = 300000;
const dbV14 = () => {
  const db = dbAt();
  const [prepare, copy] = migrationV14.split('-- @schema');
  db.exec('BEGIN IMMEDIATE'); db.exec(prepare); db.exec(schemaV14); db.exec(copy); db.exec('DROP TABLE sleep_periods_v13; COMMIT');
  return db;
};
const migrateV15 = db => {
  const [prepare, copy] = migrationV15.split('-- @schema');
  assert.ok(prepare && copy, 'the migration has one schema marker');
  db.exec('BEGIN IMMEDIATE'); db.exec(prepare); db.exec(schemaV15); db.exec(copy);
  const same = db.prepare('SELECT (SELECT COUNT(*) FROM (SELECT id,entry_id,started_ms,ended_ms,manual_resume,decision,decided_ms FROM sleep_periods EXCEPT SELECT id,entry_id,started_ms,ended_ms,manual_resume,decision,decided_ms FROM sleep_periods_v14)) + (SELECT COUNT(*) FROM (SELECT id,entry_id,started_ms,ended_ms,manual_resume,decision,decided_ms FROM sleep_periods_v14 EXCEPT SELECT id,entry_id,started_ms,ended_ms,manual_resume,decision,decided_ms FROM sleep_periods)) AS n').get().n;
  assert.equal(same, 0);
  db.exec('DROP TABLE sleep_periods_v14; COMMIT');
};
const dbV15 = () => { const db = dbV14(); migrateV15(db); return db; };
const insertIdle = (db, entry, start, end = null) => Number(db.prepare("INSERT INTO sleep_periods(entry_id,source,started_ms,ended_ms) VALUES(?,'idle',?,?)").run(entry, start, end).lastInsertRowid);

test('v15 migration keeps every v14 row and decision, marks it sleep and installs the exact v15 definitions', () => {
  const db = dbV14();
  const id = (start, end) => Number(insert(db, 1, start, end).lastInsertRowid);
  const auto = id(0, 60000); db.prepare("UPDATE sleep_periods SET decision='auto_included', decided_ms=ended_ms WHERE id=?").run(auto);
  const included = id(100000, 800000); db.prepare("UPDATE sleep_periods SET decision='included', decided_ms=900000 WHERE id=?").run(included);
  const excluded = id(1000000, 1600000); db.prepare("UPDATE sleep_periods SET decision='excluded', decided_ms=1700000 WHERE id=?").run(excluded);
  const manual = id(2000000, null); db.prepare('UPDATE sleep_periods SET ended_ms=2100000, manual_resume=1 WHERE id=?').run(manual);
  id(3600000, null); insert(db, 2, 5000, null);
  const before = sleepRows(db);
  migrateV15(db);
  assert.deepEqual(sleepRows(db), before, 'ids, boundaries, flags and decisions are unchanged, including auto_included');
  assert.deepEqual(db.prepare('SELECT DISTINCT source FROM sleep_periods').all().map(row => row.source), ['sleep']);
  const canonical = new DatabaseSync(':memory:');
  canonical.exec('CREATE TABLE time_entries(id INTEGER PRIMARY KEY);'); canonical.exec(schemaV15);
  const definition = (target, name) => target.prepare('SELECT sql FROM sqlite_master WHERE name=?').get(name)?.sql;
  for (const name of schemaObjects) assert.equal(definition(db, name), definition(canonical, name), name);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name='sleep_periods_v14'").get().n, 0);
  assert.throws(() => insert(db, 1, 1500, 2500), /overlapping/);
  assert.throws(() => db.prepare('DELETE FROM sleep_periods').run(), /retained for audit/);
  assert.throws(() => db.prepare("UPDATE sleep_periods SET decision='excluded', decided_ms=1 WHERE id=?").run(auto), /immutable/);
  canonical.close(); db.close();
});

test('v15 migration refuses a damaged v14 table without changing it', () => {
  const db = dbV14();
  insert(db, 1, 1000, 2000);
  db.exec('DROP TRIGGER sleep_periods_immutable');
  const before = sleepRows(db);
  const [prepare] = migrationV15.split('-- @schema');
  db.exec('BEGIN IMMEDIATE');
  assert.throws(() => db.exec(prepare), /no such trigger/);
  db.exec('ROLLBACK');
  assert.deepEqual(sleepRows(db), before);
  assert.doesNotMatch(db.prepare("SELECT sql FROM sqlite_master WHERE name='sleep_periods'").get().sql, /source/);
  db.close();
});

test('v15: idle and sleep share one timeline per entry; overlap is refused in both directions (I11)', () => {
  const db = dbV15();
  insert(db, 1, 600000, 1200000);
  assert.throws(() => insertIdle(db, 1, 0, 600001), /overlapping/);
  assert.throws(() => insertIdle(db, 1, 1199999, 1300000), /overlapping/);
  assert.throws(() => insertIdle(db, 1, 900000), /overlapping/);
  const before = insertIdle(db, 1, 0, 600000);
  const open = insertIdle(db, 1, 1200000);
  assert.throws(() => insert(db, 1, 100000, 200000), /overlapping/);
  assert.throws(() => insert(db, 1, 1500000, null), /overlapping|UNIQUE/);
  db.prepare('UPDATE sleep_periods SET ended_ms=1800000 WHERE id=?').run(open);
  assert.deepEqual(db.prepare('SELECT source FROM sleep_periods WHERE entry_id=1 ORDER BY started_ms').all().map(row => row.source), ['idle', 'sleep', 'idle']);
  assert.ok(before > 0 && open > before);
  db.close();
});

test('v15 CHECK: auto_included is sleep only, the source is known and immutable, idle may carry a recovery end (I12)', () => {
  const db = dbV15();
  const idle = insertIdle(db, 1, 0, 60000);
  assert.throws(() => db.prepare("UPDATE sleep_periods SET decision='auto_included', decided_ms=ended_ms WHERE id=?").run(idle), /CHECK/);
  assert.throws(() => db.prepare("INSERT INTO sleep_periods(entry_id,source,started_ms) VALUES(1,'away',100000)").run(), /CHECK/);
  assert.throws(() => db.prepare("UPDATE sleep_periods SET source='sleep' WHERE id=?").run(idle), /immutable/);
  assert.throws(() => db.prepare("INSERT INTO sleep_periods(entry_id,source,started_ms,ended_ms,decision,decided_ms) VALUES(1,'idle',200000,210000,'included',1)").run(), /start pending/);
  // close_open_at_entry_end (recovery) sets manual_resume=1; allowed for idle, which stays pending.
  const open = insertIdle(db, 1, 200000);
  db.prepare('UPDATE sleep_periods SET ended_ms=?1,manual_resume=1 WHERE entry_id=?2 AND ended_ms IS NULL AND decision=\'pending\' AND started_ms<?1').run(260000, 1);
  assert.deepEqual({ ...db.prepare('SELECT source,ended_ms,manual_resume,decision FROM sleep_periods WHERE id=?').get(open) }, { source: 'idle', ended_ms: 260000, manual_resume: 1, decision: 'pending' });
  db.prepare("UPDATE sleep_periods SET decision='excluded', decided_ms=300000 WHERE id=?").run(idle);
  assert.throws(() => db.prepare("UPDATE sleep_periods SET decision='included' WHERE id=?").run(idle), /immutable/);
  db.close();
});

test('v15 resume statement: never resumes idle; a short sleep that begins where idle ended stays pending (O5a)', () => {
  const db = dbV15();
  const resume = (end, id, entry) => db.prepare(resumeV15).run(end, id, entry, shortSleepMs).changes;
  const idle = insertIdle(db, 1, 0);
  assert.equal(resume(60000, idle, 1), 0, 'an idle period is not a resume');
  // The suspend ends the idle period at its own time (record_suspend), then the sleep starts there.
  db.prepare("UPDATE sleep_periods SET ended_ms=?1 WHERE entry_id=?2 AND source='idle' AND ended_ms IS NULL AND decision='pending' AND started_ms<?1").run(720000, 1);
  const afterIdle = Number(insert(db, 1, 720000, null).lastInsertRowid);
  assert.equal(resume(840000, afterIdle, 1), 1);
  const alone = Number(insert(db, 1, 900000, null).lastInsertRowid);
  assert.equal(resume(960000, alone, 1), 1);
  const long = Number(insert(db, 1, 1000000, null).lastInsertRowid);
  assert.equal(resume(1000000 + shortSleepMs, long, 1), 1);
  assert.deepEqual(db.prepare('SELECT source,decision,decided_ms FROM sleep_periods WHERE entry_id=1 ORDER BY started_ms').all().map(row => ({ ...row })), [
    { source: 'idle', decision: 'pending', decided_ms: null },
    { source: 'sleep', decision: 'pending', decided_ms: null },
    { source: 'sleep', decision: 'auto_included', decided_ms: 960000 },
    { source: 'sleep', decision: 'pending', decided_ms: null },
  ]);
  assert.equal(resume(970000, alone, 1), 0, 'a repeated resume changes nothing');
  db.close();
});

test('v15 rebuild on a full disk fails with SQLITE_FULL and leaves v14 intact (T27 pattern)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sleep-v15-full-'));
  const path = join(dir, 'tracker.sqlite3');
  try {
    const db = new DatabaseSync(path);
    db.exec('PRAGMA page_size=512; PRAGMA foreign_keys=ON; CREATE TABLE time_entries(id INTEGER PRIMARY KEY); INSERT INTO time_entries VALUES (1), (2);');
    db.exec(schema);
    const [prepare14, copy14] = migrationV14.split('-- @schema');
    db.exec('BEGIN IMMEDIATE'); db.exec(prepare14); db.exec(schemaV14); db.exec(copy14); db.exec('DROP TABLE sleep_periods_v13; PRAGMA user_version=14; COMMIT');
    for (let i = 0; i < 60; i++) insert(db, 1, i * 1000000, i * 1000000 + 600000);
    db.exec('VACUUM');
    const pages = db.prepare('PRAGMA page_count').get().page_count;
    assert.equal(db.prepare('PRAGMA freelist_count').get().freelist_count, 0);
    db.exec(`PRAGMA max_page_count=${pages}`);
    const before = sleepRows(db);
    const [prepare, copy] = migrationV15.split('-- @schema');
    db.exec('BEGIN IMMEDIATE');
    assert.throws(() => { db.exec(prepare); db.exec(schemaV15); db.exec(copy); }, error => error.errcode === 13);
    if (db.isTransaction) db.exec('ROLLBACK');
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 14);
    assert.deepEqual(sleepRows(db), before);
    assert.doesNotMatch(db.prepare("SELECT sql FROM sqlite_master WHERE name='sleep_periods'").get().sql, /source/);
    db.exec(`PRAGMA max_page_count=${pages * 8}`);
    migrateV15(db);
    assert.deepEqual(sleepRows(db), before);
    db.exec('VACUUM');
    assert.equal(db.prepare('PRAGMA freelist_count').get().freelist_count, 0, 'the free pages of the rebuild are returned');
    db.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
