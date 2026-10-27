'use strict';

const {
  OPCUAClient,
  MessageSecurityMode,
  SecurityPolicy,
  AttributeIds,
  BrowseDirection,
  NodeClass,
  DataType,
  UserTokenType,
} = require('node-opcua-client');

const APP_NAME = 'opcua-to-sheets';

function makeClient({ securityMode = 'None', securityPolicy = 'None' } = {}) {
  const mode = MessageSecurityMode[securityMode];
  const policy = SecurityPolicy[securityPolicy];
  if (mode === undefined) throw new Error(`unknown security mode "${securityMode}" (use None, Sign or SignAndEncrypt)`);
  if (policy === undefined) throw new Error(`unknown security policy "${securityPolicy}" (e.g. None, Basic256Sha256)`);
  return OPCUAClient.create({
    applicationName: APP_NAME,
    securityMode: mode,
    securityPolicy: policy,
    endpointMustExist: false,
    keepSessionAlive: true,
    connectionStrategy: { initialDelay: 1000, maxDelay: 30000, maxRetry: 3 },
  });
}

function userIdentity(user, password) {
  if (!user) return undefined;
  return { type: UserTokenType.UserName, userName: user, password: password || '' };
}

// One OPC UA connection per machine. Read-only: this class never writes to the server.
class MachineReader {
  constructor(machine, log = () => {}) {
    this.machine = machine;
    this.log = log;
    this.client = null;
    this.session = null;
  }

  async connect() {
    const m = this.machine;
    this.client = makeClient({ securityMode: m.securityMode, securityPolicy: m.securityPolicy });
    this.client.on('connection_lost', () => this.log(`[${m.name}] connection lost, reconnecting`));
    this.client.on('connection_reestablished', () => this.log(`[${m.name}] connection re-established`));
    await this.client.connect(m.endpoint);
    this.session = await this.client.createSession(userIdentity(m.user, m.password));
    this.log(`[${m.name}] connected to ${m.endpoint}`);
  }

  // Returns { values: { tagName: cellValue }, bad: [tagName, ...] }
  async read() {
    if (!this.session) await this.connect();
    const nodes = this.machine.tags.map((t) => ({ nodeId: t.nodeId, attributeId: AttributeIds.Value }));
    const results = await this.session.read(nodes);
    const values = {};
    const bad = [];
    this.machine.tags.forEach((t, i) => {
      const dv = results[i];
      if (dv && dv.statusCode && dv.statusCode.isGood()) {
        values[t.name] = variantToCell(dv.value);
      } else {
        values[t.name] = '';
        bad.push(`${t.name} (${dv && dv.statusCode ? dv.statusCode.name : 'no value'})`);
      }
    });
    return { values, bad };
  }

  async close() {
    try { if (this.session) await this.session.close(); } catch (_) { /* ignore */ }
    try { if (this.client) await this.client.disconnect(); } catch (_) { /* ignore */ }
    this.session = null;
    this.client = null;
  }
}

function int64ToNumber(v) {
  // node-opcua returns Int64/UInt64 as [high, low]
  if (Array.isArray(v) && v.length === 2) return v[0] * 4294967296 + v[1];
  return v;
}

function variantToCell(variant) {
  if (!variant) return '';
  let v = variant.value;
  if (v === null || v === undefined) return '';
  if (variant.dataType === DataType.Int64 || variant.dataType === DataType.UInt64) {
    if (variant.arrayType && variant.arrayType !== 0) return JSON.stringify(Array.from(v, int64ToNumber));
    return int64ToNumber(v);
  }
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'bigint') return Number(v);
  if (ArrayBuffer.isView(v) || Array.isArray(v)) return JSON.stringify(Array.from(v));
  if (typeof v === 'object') {
    if (v.text !== undefined) return v.text; // LocalizedText
    return JSON.stringify(v);
  }
  return v;
}

// Prints the address space so engineers can copy node IDs into the config.
async function browse({ endpoint, user, password, securityMode, securityPolicy, depth = 4, start = 'ObjectsFolder', includeServer = false, out = console.log }) {
  const client = makeClient({ securityMode, securityPolicy });
  await client.connect(endpoint);
  const session = await client.createSession(userIdentity(user, password));
  let count = 0;
  try {
    const walk = async (nodeId, level, prefix) => {
      if (level > depth) return;
      const res = await session.browse({
        nodeId,
        browseDirection: BrowseDirection.Forward,
        referenceTypeId: 'HierarchicalReferences',
        includeSubtypes: true,
        nodeClassMask: 0,
        resultMask: 63,
      });
      for (const ref of res.references || []) {
        const id = ref.nodeId.toString();
        if (!includeServer && id === 'ns=0;i=2253') continue; // the Server object is large and rarely useful
        const name = ref.browseName.name;
        const cls = NodeClass[ref.nodeClass];
        if (ref.nodeClass === NodeClass.Variable) {
          count += 1;
          out(`${prefix}${name}    nodeId: ${id}`);
        } else {
          out(`${prefix}${name}/  (${cls})`);
        }
        if (ref.nodeClass === NodeClass.Object || ref.nodeClass === NodeClass.Variable) {
          await walk(ref.nodeId, level + 1, prefix + '  ');
        }
      }
    };
    await walk(start, 1, '');
  } finally {
    await session.close();
    await client.disconnect();
  }
  return count;
}

module.exports = { MachineReader, browse, variantToCell, makeClient };
