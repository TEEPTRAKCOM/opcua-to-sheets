'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { startServer } = require('./server');
const { browse, MachineReader } = require('../src/opcua');
const { normalizeConfig } = require('../src/config');
const { Agent } = require('../src/agent');

let srv;
test.before(async () => { srv = await startServer(); });
test.after(async () => { await srv.stop(); });

test('browse lists the variables with their node IDs', async () => {
  const lines = [];
  const n = await browse({ endpoint: srv.endpoint, depth: 3, out: (l) => lines.push(l) });
  assert.ok(n >= 5, `expected at least 5 variables, got ${n}`);
  const text = lines.join('\n');
  assert.match(text, new RegExp(`PartCounter\\s+nodeId: ns=${srv.nsIndex};s=Press01\\.PartCounter`));
  assert.doesNotMatch(text, /^Server\//m);
});

test('end to end: read real OPC UA values into rows', async () => {
  const ns = srv.nsIndex;
  const cfg = normalizeConfig({
    sampleSeconds: 1, flushSeconds: 1,
    machines: [{ name: 'Press 01', endpoint: srv.endpoint, tags: [
      { name: 'PartCounter', nodeId: `ns=${ns};s=Press01.PartCounter` },
      { name: 'Running', nodeId: `ns=${ns};s=Press01.Running` },
      { name: 'Speed', nodeId: `ns=${ns};s=Press01.Speed` },
      { name: 'Recipe', nodeId: `ns=${ns};s=Press01.Recipe` },
      { name: 'TotalEnergy', nodeId: `ns=${ns};s=Press01.TotalEnergy` },
      { name: 'Missing', nodeId: `ns=${ns};s=Press01.DoesNotExist` },
    ] }],
  });
  const rows = [];
  const agent = new Agent(cfg, { write: async (tab, header, r) => { assert.equal(header[1], 'Status'); rows.push(...r); } }, { log: () => {} });
  await agent.sampleOnce();
  await new Promise((r) => setTimeout(r, 300));
  await agent.sampleOnce();
  await agent.flush(true);
  await agent.stop();
  assert.equal(rows.length, 2);
  const [ts, status, count1, running, speed, recipe, energy, missing] = rows[0];
  assert.match(ts, /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/);
  assert.match(status, /^bad: Missing \(Bad/);
  assert.equal(typeof count1, 'number');
  assert.ok(rows[1][2] > count1, 'counter should increase between samples');
  assert.equal(running, true);
  assert.equal(speed, 42.5);
  assert.equal(recipe, '=HYPERLINK("http://example.com")'); // raw here; the Sheets writer neutralises it
  assert.equal(energy, 4294967296 + 5);
  assert.equal(missing, '');
});

test('reader reconnects after the server connection is closed', async () => {
  const ns = srv.nsIndex;
  const r = new MachineReader({ name: 'P', endpoint: srv.endpoint, securityMode: 'None', securityPolicy: 'None', tags: [{ name: 'Speed', nodeId: `ns=${ns};s=Press01.Speed` }] });
  assert.equal((await r.read()).values.Speed, 42.5);
  await r.close();
  assert.equal((await r.read()).values.Speed, 42.5);
  await r.close();
});
