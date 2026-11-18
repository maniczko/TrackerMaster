import test from "node:test";
import assert from "node:assert/strict";
import { Temporal } from "@js-temporal/polyfill";
import { segmentCompletedEntry, summarizeCalendar } from "./contracts/time-segmentation.mjs";

const zone = "Europe/Warsaw";
const entry = (id, startUtc, endUtc, opts = {}) => ({
  entryId: id, clientId: "A", projectId: "P-A", taskId: null, billable: false,
  state: "completed", startUtc, endUtc, ...opts,
});
const sum = (items) => items.reduce((n, s) => n + s.segmentSeconds, 0);
const dates = (items) => items.map(s => [s.localDate, s.segmentSeconds]);
const r = (e, z = zone) => segmentCompletedEntry(e, z);
const dateQuery = (entries, from, to, z = zone, clientId = null) =>
  summarizeCalendar(entries, { fromLocalDate: from, toLocalDate: to, reportTimezone: z, clientId });

test("midnight: Jan 31 23:50 CET to Feb 1 00:10 CET => 600+600", () => {
  const e = entry("E1", "2026-01-31T22:50:00Z", "2026-01-31T23:10:00Z", {durationSeconds:1200});
  assert.deepEqual(dates(r(e)), [["2026-01-31",600],["2026-02-01",600]]);
  assert.equal(sum(r(e)), 1200);
  assert.deepEqual(r(e).map(s=>s.entryId), ["E1","E1"]);
  assert.equal(e.startUtc, "2026-01-31T22:50:00Z");
});
test("spring-forward 01:30 CET => 03:30 CEST takes 3600 actual seconds", () => {
  assert.deepEqual(dates(r(entry("S","2026-03-29T00:30:00Z","2026-03-29T01:30:00Z"))),
    [["2026-03-29",3600]]);
});
test("fall-back 02:30 CEST => 02:30 CET takes 3600 actual seconds", () => {
  assert.deepEqual(dates(r(entry("F","2026-10-25T00:30:00Z","2026-10-25T01:30:00Z"))),
    [["2026-10-25",3600]]);
});
test("local day boundaries are 23 and 25 hours during Warsaw DST changes", () => {
  for (const [date, expected] of [["2026-03-29",82800],["2026-10-25",90000]]) {
    const start = Temporal.PlainDate.from(date).toZonedDateTime({timeZone:zone});
    const end = start.add({days:1});
    const e = entry(date,start.toInstant().toString(),end.toInstant().toString());
    assert.equal(Number((end.epochNanoseconds-start.epochNanoseconds)/1_000_000_000n),expected);
    assert.deepEqual(dates(r(e)),[[date,expected]]);
  }
});
test("long 54-hour entry splits into 14+24+16 hours without wrapping", () => {
  const parts = r(entry("LONG","2026-01-01T10:00:00Z","2026-01-03T16:00:00Z"),"UTC");
  assert.deepEqual(dates(parts),[
    ["2026-01-01",50400],["2026-01-02",86400],["2026-01-03",57600]
  ]);
  assert.equal(sum(parts),194400);
});
test("ending exactly at midnight does not create an extra segment", () => {
  assert.deepEqual(dates(r(entry("EXACT","2026-01-31T23:00:00Z","2026-02-01T00:00:00Z"),"UTC")),
    [["2026-01-31",3600]]);
});
test("client A 7200s, B 10800s; individual filters do not leak", () => {
  const entries=[
    entry("EA","2026-11-09T08:00:00Z","2026-11-09T10:00:00Z"),
    entry("EB","2026-11-09T11:00:00Z","2026-11-09T14:00:00Z",{clientId:"B",projectId:"P-B"})
  ];
  assert.equal(dateQuery(entries,"2026-11-09","2026-11-09",zone,"A").totalSeconds,7200);
  assert.equal(dateQuery(entries,"2026-11-09","2026-11-09",zone,"B").totalSeconds,10800);
  assert.equal(dateQuery(entries,"2026-11-09","2026-11-09").totalSeconds,18000);
  assert.deepEqual(dateQuery(entries,"2026-11-09","2026-11-09",zone,"A").segments.map(s=>s.entryId),["EA"]);
});
test("switching Warsaw => London => Warsaw is reversible and preserves UTC", () => {
  const e=entry("TZ","2026-01-31T23:30:00Z","2026-02-01T00:30:00Z");
  assert.deepEqual(dates(r(e)),[["2026-02-01",3600]]);
  assert.deepEqual(dates(r(e,"Europe/London")),[["2026-01-31",1800],["2026-02-01",1800]]);
  assert.deepEqual(r(e),r(e,"Europe/Warsaw"));
  assert.equal(sum(r(e)),sum(r(e,"Europe/London")));
  assert.equal(e.startUtc,"2026-01-31T23:30:00Z");
});
test("local filter date preserved but UTC boundaries recomputed after zone change", () => {
  const items=[entry("TZ","2026-01-31T23:30:00Z","2026-02-01T00:30:00Z")];
  assert.equal(dateQuery(items,"2026-01-31","2026-01-31","Europe/Warsaw").totalSeconds,0);
  assert.equal(dateQuery(items,"2026-01-31","2026-01-31","Europe/London").totalSeconds,1800);
});
test("running and unresolved never enter finalized sums", () => {
  const entries=[
    entry("LIVE","2026-11-18T10:00:00Z",null,{state:"running"}),
    entry("PEND","2026-11-18T10:00:00Z",null,{state:"unresolved"})
  ];
  assert.equal(dateQuery(entries,"2026-11-18","2026-11-18").totalSeconds,0);
  assert.deepEqual(r(entries[0]),[]);
});
test("two sleep gaps are preserved; accept one without silently accepting another", () => {
  const e=entry("SLEEPS","2026-11-18T09:00:00Z","2026-11-18T13:00:00Z",{
    hasUnresolvedSleep:true,durationSeconds:9000,
    eligibleIntervals:[
      {startUtc:"2026-11-18T09:00:00Z",endUtc:"2026-11-18T10:00:00Z"},
      {startUtc:"2026-11-18T11:00:00Z",endUtc:"2026-11-18T11:30:00Z"},
      {startUtc:"2026-11-18T12:00:00Z",endUtc:"2026-11-18T13:00:00Z"},
    ]
  });
  assert.equal(sum(r(e)),9000);
  const accepted={...e,durationSeconds:12600,eligibleIntervals:[
    e.eligibleIntervals[0],
    {startUtc:"2026-11-18T10:00:00Z",endUtc:"2026-11-18T11:00:00Z"},
    ...e.eligibleIntervals.slice(1)
  ]};
  assert.equal(sum(r(accepted)),12600);
  assert.equal(sum(r(e)),9000);
});
test("pending with no explicit eligible intervals fails closed", () => {
  assert.throws(()=>r(entry("U","2026-11-18T09:00:00Z","2026-11-18T10:00:00Z",
    {hasUnresolvedSleep:true})),/eligibleIntervals/);
});
test("overlapping, unordered, out of bounds and incomplete eligible intervals fail", () => {
  const base=entry("X","2026-11-18T09:00:00Z","2026-11-18T11:00:00Z");
  const interval=(a,b)=>({startUtc:a,endUtc:b});
  assert.throws(()=>r({...base,eligibleIntervals:[
    interval("2026-11-18T09:00:00Z","2026-11-18T10:00:00Z"),
    interval("2026-11-18T09:30:00Z","2026-11-18T11:00:00Z")
  ]}),/ordered, disjoint/);
  assert.throws(()=>r({...base,eligibleIntervals:[
    interval("2026-11-18T08:00:00Z","2026-11-18T09:30:00Z")
  ]}),/within source/);
  assert.throws(()=>r({...base,eligibleIntervals:[
    interval("2026-11-18T09:00:00Z",null)
  ]}));
});
test("invalid end, project/client IDs, state, IANA and subsecond timestamps reject", () => {
  const e=entry("X","2026-11-18T10:00:00Z","2026-11-18T11:00:00Z");
  assert.throws(()=>r({...e,endUtc:e.startUtc}));
  assert.throws(()=>r({...e,endUtc:"2026-11-18T09:00:00Z"}));
  assert.throws(()=>r({...e,clientId:null}));
  assert.throws(()=>r({...e,projectId:null}));
  assert.throws(()=>r({...e,taskId:undefined}));
  assert.throws(()=>r({...e,billable:null}));
  assert.throws(()=>r({...e,state:"unknown"}));
  assert.throws(()=>r(e,"Europe/Invalid_Zone"));
  assert.throws(()=>r({...e,startUtc:"2026-11-18T10:00:00.500Z"}));
  assert.throws(()=>r({...e,durationSeconds:1}),/disagree/);
});
test("empty calendar, inverted dates and impossible dates", () => {
  const items=[entry("E","2026-11-18T10:00:00Z","2026-11-18T11:00:00Z")];
  assert.deepEqual(dateQuery(items,"2026-11-17","2026-11-17"),
    {segments:[],byLocalDateSeconds:{},totalSeconds:0});
  assert.throws(()=>dateQuery(items,"2026-11-19","2026-11-17"),/Inverted/);
  assert.throws(()=>dateQuery(items,"2026-02-31","2026-11-17"));
});
test("stable entryId, optional taskId null, and billable across midnight", () => {
  const segments=r(entry("stable-id","2026-11-18T22:00:00Z","2026-11-19T03:00:00Z",
    {taskId:null,billable:true}));
  assert.equal(segments.length,2);
  for(const s of segments)assert.deepEqual([s.entryId,s.taskId,s.billable,s.projectId],
    ["stable-id",null,true,"P-A"]);
  assert.equal(sum(segments),18000);
});
