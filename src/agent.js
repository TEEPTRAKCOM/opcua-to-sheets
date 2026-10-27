'use strict';

const { MachineReader } = require('./opcua');

function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function headerFor(machine) {
  // Status stays in column B so new tags can be appended at the end without breaking old rows.
  return ['Timestamp', 'Status', ...machine.tags.map((t) => t.name)];
}

class Agent {
  constructor(cfg, writer, { log = console.log, readerFactory } = {}) {
    this.cfg = cfg;
    this.writer = writer;
    this.log = log;
    this.readers = cfg.machines.map((m) => (readerFactory ? readerFactory(m, log) : new MachineReader(m, log)));
    this.buffers = new Map(cfg.machines.map((m) => [m.name, []]));
    this.backoffMs = 0;
    this.nextFlushAt = 0;
    this.timers = [];
    this.stopped = false;
    this.dropped = 0;
  }

  bufferedCount() {
    let n = 0;
    for (const b of this.buffers.values()) n += b.length;
    return n;
  }

  push(machine, row) {
    const buf = this.buffers.get(machine.name);
    buf.push(row);
    // Never let a long Google outage fill the memory: drop the oldest rows of the largest buffer.
    while (this.bufferedCount() > this.cfg.maxBufferedRows) {
      let biggest = buf;
      for (const b of this.buffers.values()) if (b.length > biggest.length) biggest = b;
      biggest.shift();
      this.dropped += 1;
      if (this.dropped === 1 || this.dropped % 1000 === 0) this.log(`buffer full: ${this.dropped} oldest rows dropped so far`);
    }
  }

  async sampleOnce() {
    const ts = stamp();
    await Promise.all(this.readers.map(async (r) => {
      const m = r.machine;
      try {
        const { values, bad } = await r.read();
        const status = bad.length ? `bad: ${bad.join(', ')}` : 'ok';
        this.push(m, [ts, status, ...m.tags.map((t) => values[t.name])]);
      } catch (e) {
        const msg = String(e.message).replace(/\s+/g, ' ').trim();
        this.push(m, [ts, `error: ${msg}`.slice(0, 200), ...m.tags.map(() => '')]);
        this.log(`[${m.name}] read failed: ${msg}`);
        try { await r.close(); } catch (_) { /* reconnect on next sample */ }
      }
    }));
  }

  async flush(force = false) {
    if (!force && Date.now() < this.nextFlushAt) return;
    for (const m of this.cfg.machines) {
      const buf = this.buffers.get(m.name);
      if (!buf.length) continue;
      const rows = buf.slice();
      try {
        await this.writer.write(m.name, headerFor(m), rows);
        buf.splice(0, rows.length);
        this.backoffMs = 0;
        this.nextFlushAt = 0;
      } catch (e) {
        this.backoffMs = Math.min(this.backoffMs ? this.backoffMs * 2 : 5000, 300000);
        this.nextFlushAt = Date.now() + this.backoffMs;
        let hint = '';
        if (e.status === 403 || e.status === 404) hint = ' Check the spreadsheet ID and share the sheet (Editor) with the service account e-mail.';
        if (e.status === 429) hint = ' Google write quota reached: raise flushSeconds.';
        this.log(`[${m.name}] write failed, ${rows.length} rows kept, retry in ${Math.round(this.backoffMs / 1000)} s: ${e.message}.${hint}`);
        return; // keep order: try again later for every machine
      }
    }
  }

  async start() {
    const { sampleSeconds, flushSeconds, machines, writesPerMinute } = this.cfg;
    this.log(`logging ${machines.length} machine(s) every ${sampleSeconds} s, writing every ${flushSeconds} s (${writesPerMinute.toFixed(1)} writes/min)`);
    if (writesPerMinute > 50) {
      this.log('warning: more than 50 writes per minute is close to the Google Sheets per-user limit (60/min). Raise flushSeconds.');
    }
    let sampling = false;
    let flushing = false;
    const sample = async () => {
      if (sampling || this.stopped) return;
      sampling = true;
      try { await this.sampleOnce(); } finally { sampling = false; }
    };
    const flush = async () => {
      if (flushing || this.stopped) return;
      flushing = true;
      try { await this.flush(); } finally { flushing = false; }
    };
    await sample();
    this.timers.push(setInterval(sample, sampleSeconds * 1000));
    this.timers.push(setInterval(flush, flushSeconds * 1000));
  }

  async stop() {
    this.stopped = true;
    this.timers.forEach(clearInterval);
    this.timers = [];
    try { await this.flush(true); } catch (_) { /* logged in flush */ }
    await Promise.all(this.readers.map((r) => r.close()));
    const left = this.bufferedCount();
    if (left) this.log(`${left} rows could not be written before exit`);
  }
}

module.exports = { Agent, headerFor, stamp };
