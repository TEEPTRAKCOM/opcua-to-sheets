'use strict';

const fs = require('node:fs');
const path = require('node:path');
const YAML = require('yaml');

const DEFAULTS = {
  sampleSeconds: 10,
  flushSeconds: 30,
  maxBufferedRows: 20000,
  timezone: undefined, // undefined = local time of the machine running the agent
};

// ${VAR} in the YAML is replaced by the environment variable VAR, so passwords stay out of the file.
function expandEnv(value, where) {
  if (typeof value !== 'string') return value;
  return value.replace(/\$\{([A-Z0-9_]+)\}/gi, (_, name) => {
    if (process.env[name] === undefined) {
      throw new Error(`${where}: environment variable ${name} is not set`);
    }
    return process.env[name];
  });
}

function validateTabName(name, where) {
  if (!name || typeof name !== 'string') throw new Error(`${where}: "name" is required`);
  if (name.length > 100) throw new Error(`${where}: name must be 100 characters or fewer (Google Sheets tab limit)`);
  if (/[\[\]:*?\/\\]/.test(name)) throw new Error(`${where}: name cannot contain [ ] : * ? / \\`);
}

function loadConfig(file) {
  const abs = path.resolve(file);
  const raw = YAML.parse(fs.readFileSync(abs, 'utf8'));
  return normalizeConfig(raw, path.dirname(abs));
}

function normalizeConfig(raw, baseDir = process.cwd()) {
  if (!raw || typeof raw !== 'object') throw new Error('config: empty or not a YAML mapping');
  const cfg = { ...DEFAULTS, ...raw };

  for (const k of ['sampleSeconds', 'flushSeconds', 'maxBufferedRows']) {
    if (typeof cfg[k] !== 'number' || !(cfg[k] > 0)) throw new Error(`config: ${k} must be a positive number`);
  }
  if (cfg.sampleSeconds < 1) throw new Error('config: sampleSeconds must be at least 1');
  if (cfg.flushSeconds < cfg.sampleSeconds) throw new Error('config: flushSeconds must be >= sampleSeconds');

  if (cfg.sheet) {
    if (!cfg.sheet.spreadsheetId) throw new Error('config: sheet.spreadsheetId is required');
    if (!cfg.sheet.credentials) throw new Error('config: sheet.credentials (service account JSON key file) is required');
    cfg.sheet.credentials = path.resolve(baseDir, expandEnv(cfg.sheet.credentials, 'sheet.credentials'));
  }

  if (!Array.isArray(cfg.machines) || cfg.machines.length === 0) {
    throw new Error('config: "machines" must list at least one machine');
  }
  const names = new Set();
  cfg.machines = cfg.machines.map((m, i) => {
    const where = `machines[${i}]`;
    validateTabName(m.name, where);
    if (names.has(m.name)) throw new Error(`${where}: duplicate machine name "${m.name}"`);
    names.add(m.name);
    if (!m.endpoint || !/^opc\.tcp:\/\//.test(m.endpoint)) throw new Error(`${where}: endpoint must start with opc.tcp://`);
    if (!Array.isArray(m.tags) || m.tags.length === 0) throw new Error(`${where}: "tags" must list at least one tag`);
    const tagNames = new Set();
    const tags = m.tags.map((t, j) => {
      const tw = `${where}.tags[${j}]`;
      if (!t || !t.name || !t.nodeId) throw new Error(`${tw}: each tag needs "name" and "nodeId"`);
      if (tagNames.has(t.name)) throw new Error(`${tw}: duplicate tag name "${t.name}"`);
      tagNames.add(t.name);
      return { name: String(t.name), nodeId: String(t.nodeId) };
    });
    const security = m.security || {};
    return {
      name: m.name,
      endpoint: m.endpoint,
      tags,
      securityMode: security.mode || 'None',
      securityPolicy: security.policy || 'None',
      user: m.user ? expandEnv(m.user, `${where}.user`) : undefined,
      password: m.password ? expandEnv(m.password, `${where}.password`) : undefined,
    };
  });

  const writesPerMinute = cfg.machines.length * (60 / cfg.flushSeconds);
  cfg.writesPerMinute = writesPerMinute;
  return cfg;
}

module.exports = { loadConfig, normalizeConfig, DEFAULTS };
