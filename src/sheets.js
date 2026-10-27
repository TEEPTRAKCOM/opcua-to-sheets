'use strict';

const { GoogleAuth } = require('google-auth-library');

const API = 'https://sheets.googleapis.com/v4/spreadsheets';
const SCOPES = ['https://www.googleapis.com/auth/spreadsheets'];

// A value typed into a sheet that starts with = + - @ would run as a formula. Tag values are data, never formulas.
function safeCell(v) {
  if (typeof v === 'string' && /^[=+\-@]/.test(v)) return `'${v}`;
  return v;
}

function a1(tab, cell = 'A1') {
  return `'${tab.replace(/'/g, "''")}'!${cell}`;
}

class SheetsWriter {
  constructor({ spreadsheetId, credentials }, log = () => {}) {
    this.spreadsheetId = spreadsheetId;
    this.log = log;
    this.auth = new GoogleAuth({ keyFile: credentials, scopes: SCOPES });
    this.client = null;
    this.ready = new Map(); // tab -> header
  }

  async request(opts) {
    if (!this.client) this.client = await this.auth.getClient();
    try {
      const res = await this.client.request(opts);
      return res.data;
    } catch (e) {
      const status = e.response ? e.response.status : e.code;
      const err = new Error(`Google Sheets API error ${status || ''}: ${e.response && e.response.data && e.response.data.error ? e.response.data.error.message : e.message}`.trim());
      err.status = Number(status) || 0;
      throw err;
    }
  }

  async ensureTab(tab, header) {
    if (this.ready.has(tab)) return;
    const meta = await this.request({ url: `${API}/${this.spreadsheetId}`, params: { fields: 'sheets.properties.title' } });
    const titles = (meta.sheets || []).map((s) => s.properties.title);
    if (!titles.includes(tab)) {
      await this.request({
        url: `${API}/${this.spreadsheetId}:batchUpdate`,
        method: 'POST',
        data: { requests: [{ addSheet: { properties: { title: tab, gridProperties: { frozenRowCount: 1 } } } }] },
      });
      this.log(`created tab "${tab}"`);
    }
    const first = await this.request({ url: `${API}/${this.spreadsheetId}/values/${encodeURIComponent(a1(tab, '1:1'))}` });
    const existing = (first.values && first.values[0]) || [];
    const isPrefix = existing.every((h, i) => h === header[i]);
    if (existing.length === 0 || (isPrefix && existing.length < header.length)) {
      await this.request({
        url: `${API}/${this.spreadsheetId}/values/${encodeURIComponent(a1(tab, 'A1'))}`,
        method: 'PUT',
        params: { valueInputOption: 'RAW' },
        data: { values: [header] },
      });
    } else if (!isPrefix || existing.length > header.length) {
      throw new Error(`tab "${tab}" already has different columns (${existing.join(', ')}). Use a new machine name or remove the tags you deleted from the config order.`);
    }
    this.ready.set(tab, header);
  }

  async write(tab, header, rows) {
    await this.ensureTab(tab, header);
    await this.request({
      url: `${API}/${this.spreadsheetId}/values/${encodeURIComponent(a1(tab, 'A1'))}:append`,
      method: 'POST',
      params: { valueInputOption: 'USER_ENTERED', insertDataOption: 'INSERT_ROWS' },
      data: { values: rows.map((r) => r.map(safeCell)) },
    });
  }
}

// --dry-run: same rows, printed instead of written. Lets anyone test the PLC side without a Google account.
class ConsoleWriter {
  constructor(out = console.log) { this.out = out; this.headers = new Map(); }
  async write(tab, header, rows) {
    if (this.headers.get(tab) !== header.join('|')) {
      this.out(`[${tab}] ${header.join(' | ')}`);
      this.headers.set(tab, header.join('|'));
    }
    for (const r of rows) this.out(`[${tab}] ${r.map(safeCell).join(' | ')}`);
  }
}

module.exports = { SheetsWriter, ConsoleWriter, safeCell, a1 };
