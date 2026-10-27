'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { normalizeConfig } = require('../src/config');
const { safeCell, a1, SheetsWriter } = require('../src/sheets');
const { Agent, headerFor } = require('../src/agent');

const machine = { name: 'Press 01', endpoint: 'opc.tcp://localhost:4840', tags: [{ name: 'Count', nodeId: 'ns=1;s=C' }] };

test('config: valid config is normalised and the write budget computed', () => {
  const cfg = normalizeConfig({ flushSeconds: 30, machines: [machine, { ...machine, name: 'Press 02' }] });
  assert.equal(cfg.machines.length, 2);
  assert.equal(cfg.writesPerMinute, 4);
  assert.equal(cfg.machines[0].securityMode, 'None');
});

test('config: rejects bad input with a clear message', () => {
  assert.throws(() => normalizeConfig({ machines: [] }), /at least one machine/);
  assert.throws(() => normalizeConfig({ machines: [{ ...machine, endpoint: 'http://x' }] }), /opc\.tcp/);
  assert.throws(() => normalizeConfig({ machines: [{ ...machine, name: 'a/b' }] }), /cannot contain/);
  assert.throws(() => normalizeConfig({ machines: [machine, machine] }), /duplicate machine/);
  assert.throws(() => normalizeConfig({ sampleSeconds: 30, flushSeconds: 10, machines: [machine] }), /flushSeconds/);
});

test('config: ${VAR} is read from the environment', () => {
  process.env.TEST_OPCUA_PW = 's3cret';
  const cfg = normalizeConfig({ machines: [{ ...machine, user: 'reader', password: '${TEST_OPCUA_PW}' }] });
  assert.equal(cfg.machines[0].password, 's3cret');
  assert.throws(() => normalizeConfig({ machines: [{ ...machine, password: '${NOT_SET_X}' }] }), /NOT_SET_X is not set/);
});

test('sheets: tag values can never run as formulas', () => {
  assert.equal(safeCell('=HYPERLINK("x")'), '\'=HYPERLINK("x")');
  assert.equal(safeCell('+1'), "'+1");
  assert.equal(safeCell('@x'), "'@x");
  assert.equal(safeCell(-5), -5);
  assert.equal(safeCell('ok'), 'ok');
  assert.equal(a1("Line 1's press", 'A1'), "'Line 1''s press'!A1");
});

test('sheets: creates the tab, writes the header once, appends rows', async () => {
  const calls = [];
  const w = new SheetsWriter({ spreadsheetId: 'SHEET', credentials: '/dev/null' });
  let header = [];
  w.client = { request: async (o) => {
    calls.push(`${o.method || 'GET'} ${decodeURIComponent(o.url.split('/SHEET')[1])}`);
    if (!o.method && o.params && o.params.fields) return { data: { sheets: [{ properties: { title: 'Other' } }] } };
    if (!o.method) return { data: { values: header.length ? [header] : undefined } };
    if (o.method === 'PUT') header = o.data.values[0];
    return { data: {} };
  } };
  await w.write('Press 01', ['Timestamp', 'Status', 'Count'], [['2026-11-02 10:00:00', 'ok', '=1']]);
  await w.write('Press 01', ['Timestamp', 'Status', 'Count'], [['2026-11-02 10:00:10', 'ok', 2]]);
  assert.deepEqual(calls, [
    'GET ',
    'POST :batchUpdate',
    "GET /values/'Press 01'!1:1",
    "PUT /values/'Press 01'!A1",
    "POST /values/'Press 01'!A1:append",
    "POST /values/'Press 01'!A1:append",
  ]);
});

test('sheets: refuses to mix columns when the tab already has other headers', async () => {
  const w = new SheetsWriter({ spreadsheetId: 'SHEET', credentials: '/dev/null' });
  w.client = { request: async (o) => {
    if (o.params && o.params.fields) return { data: { sheets: [{ properties: { title: 'Press 01' } }] } };
    return { data: { values: [['Timestamp', 'Status', 'Speed']] } };
  } };
  await assert.rejects(() => w.write('Press 01', ['Timestamp', 'Status', 'Count'], [['t', 'ok', 1]]), /different columns/);
});

test('agent: keeps rows and backs off when Google refuses, then writes them in order', async () => {
  const written = [];
  let fail = 2;
  const writer = { write: async (tab, header, rows) => {
    if (fail-- > 0) { const e = new Error('quota'); e.status = 429; throw e; }
    written.push(...rows);
  } };
  const cfg = normalizeConfig({ sampleSeconds: 1, flushSeconds: 1, machines: [machine] });
  let n = 0;
  const logs = [];
  const agent = new Agent(cfg, writer, { log: (m) => logs.push(m), readerFactory: (m) => ({ machine: m, read: async () => ({ values: { Count: ++n }, bad: [] }), close: async () => {} }) });
  await agent.sampleOnce();
  await agent.flush(true);
  assert.equal(agent.bufferedCount(), 1);
  assert.match(logs.at(-1), /retry in 5 s.*raise flushSeconds/);
  await agent.sampleOnce();
  await agent.flush(); // still in back-off window: nothing happens
  assert.equal(agent.bufferedCount(), 2);
  await agent.flush(true); // second failure, back-off doubles
  assert.match(logs.at(-1), /retry in 10 s/);
  await agent.flush(true);
  assert.equal(agent.bufferedCount(), 0);
  assert.deepEqual(written.map((r) => r[2]), [1, 2]);
});

test('agent: a failed read still writes a row, so gaps are visible in the sheet', async () => {
  const rows = [];
  const cfg = normalizeConfig({ machines: [machine] });
  const agent = new Agent(cfg, { write: async (t, h, r) => rows.push(...r) }, { log: () => {}, readerFactory: (m) => ({ machine: m, read: async () => { throw new Error('ECONNREFUSED'); }, close: async () => {} }) });
  await agent.sampleOnce();
  await agent.flush(true);
  assert.equal(rows.length, 1);
  assert.match(rows[0][1], /^error: ECONNREFUSED/);
  assert.equal(rows[0][2], '');
});

test('agent: buffer is capped so a long outage cannot exhaust memory', async () => {
  const cfg = normalizeConfig({ maxBufferedRows: 3, machines: [machine] });
  let n = 0;
  const agent = new Agent(cfg, { write: async () => { throw new Error('down'); } }, { log: () => {}, readerFactory: (m) => ({ machine: m, read: async () => ({ values: { Count: ++n }, bad: [] }), close: async () => {} }) });
  for (let i = 0; i < 5; i += 1) await agent.sampleOnce();
  assert.equal(agent.bufferedCount(), 3);
  assert.deepEqual(agent.buffers.get('Press 01').map((r) => r[2]), [3, 4, 5]);
});

test('header: Status stays in column B', () => {
  assert.deepEqual(headerFor(machine), ['Timestamp', 'Status', 'Count']);
});
