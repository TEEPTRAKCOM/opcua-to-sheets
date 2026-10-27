#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { loadConfig } = require('../src/config');
const { browse } = require('../src/opcua');
const { SheetsWriter, ConsoleWriter } = require('../src/sheets');
const { Agent } = require('../src/agent');
const pkg = require('../package.json');

const HELP = `opcua-to-sheets ${pkg.version}
Log OPC UA machine data into a Google Sheet. Read-only: it never writes to your PLC.

Usage
  opcua-to-sheets browse <opc.tcp://host:4840> [--depth 4] [--user U --password P] [--mode None --policy None]
      List the variables of a server with the node IDs to copy into your config.
  opcua-to-sheets init [config.yaml]
      Write an example config to start from.
  opcua-to-sheets run --config config.yaml [--dry-run] [--once]
      Start logging. --dry-run prints rows instead of writing them (no Google account needed).
      --once takes one sample, writes it and exits (good for a first test).

Docs: ${pkg.homepage}`;

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) args[key] = true;
      else { args[key] = next; i += 1; }
    } else args._.push(a);
  }
  return args;
}

const log = (msg) => console.log(`${new Date().toISOString()} ${msg}`);

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];

  if (args.version || cmd === 'version') { console.log(pkg.version); return; }
  if (!cmd || args.help || cmd === 'help') { console.log(HELP); return; }

  if (cmd === 'init') {
    const target = path.resolve(args._[1] || 'config.yaml');
    if (fs.existsSync(target)) throw new Error(`${target} already exists, not overwriting it`);
    fs.copyFileSync(path.join(__dirname, '..', 'examples', 'config.example.yaml'), target);
    console.log(`Wrote ${target}. Next: opcua-to-sheets browse <your endpoint> to find node IDs.`);
    return;
  }

  if (cmd === 'browse') {
    const endpoint = args._[1];
    if (!endpoint) throw new Error('browse needs an endpoint, e.g. opc.tcp://192.168.0.10:4840');
    const n = await browse({
      endpoint,
      user: args.user,
      password: args.password || process.env.OPCUA_PASSWORD,
      securityMode: args.mode || 'None',
      securityPolicy: args.policy || 'None',
      depth: Number(args.depth || 4),
    });
    console.log(`\n${n} variable(s) found. Copy the nodeId of each tag you want into config.yaml.`);
    return;
  }

  if (cmd === 'run') {
    if (!args.config) throw new Error('run needs --config <file>');
    const cfg = loadConfig(args.config);
    let writer;
    if (args['dry-run']) writer = new ConsoleWriter();
    else {
      if (!cfg.sheet) throw new Error('config has no "sheet" section. Add it, or use --dry-run.');
      if (!fs.existsSync(cfg.sheet.credentials)) throw new Error(`service account key not found: ${cfg.sheet.credentials}`);
      writer = new SheetsWriter(cfg.sheet, log);
    }
    const agent = new Agent(cfg, writer, { log });

    if (args.once) {
      await agent.sampleOnce();
      await agent.flush(true);
      await agent.stop();
      if (agent.bufferedCount()) process.exitCode = 1;
      return;
    }

    let stopping = false;
    const shutdown = async () => {
      if (stopping) return;
      stopping = true;
      log('stopping, writing what is left');
      await agent.stop();
      process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    await agent.start();
    return;
  }

  throw new Error(`unknown command "${cmd}". Run opcua-to-sheets --help`);
}

main().catch((e) => {
  console.error(`error: ${e.message}`);
  process.exit(1);
});
