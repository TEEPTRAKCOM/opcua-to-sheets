'use strict';

// A small OPC UA server that simulates one machine, for tests and for trying the tool without a PLC.
const { OPCUAServer } = require('node-opcua-server');
const { Variant, DataType, VariantArrayType } = require('node-opcua-client');

async function startServer(port = 0) {
  const server = new OPCUAServer({ port: port || 26000 + Math.floor(Math.random() * 2000), resourcePath: '', buildInfo: { productName: 'opcua-to-sheets test server' } });
  await server.initialize();
  const ns = server.engine.addressSpace.getOwnNamespace();
  const machine = ns.addObject({ organizedBy: server.engine.addressSpace.rootFolder.objects, browseName: 'Press01' });
  const state = { count: 0, running: true, speed: 42.5, name: '=HYPERLINK("http://example.com")' };
  const timer = setInterval(() => { state.count += 1; }, 100);
  ns.addVariable({ componentOf: machine, browseName: 'PartCounter', nodeId: 's=Press01.PartCounter', dataType: 'UInt32',
    value: { get: () => new Variant({ dataType: DataType.UInt32, value: state.count }) } });
  ns.addVariable({ componentOf: machine, browseName: 'Running', nodeId: 's=Press01.Running', dataType: 'Boolean',
    value: { get: () => new Variant({ dataType: DataType.Boolean, value: state.running }) } });
  ns.addVariable({ componentOf: machine, browseName: 'Speed', nodeId: 's=Press01.Speed', dataType: 'Double',
    value: { get: () => new Variant({ dataType: DataType.Double, value: state.speed }) } });
  ns.addVariable({ componentOf: machine, browseName: 'Recipe', nodeId: 's=Press01.Recipe', dataType: 'String',
    value: { get: () => new Variant({ dataType: DataType.String, value: state.name }) } });
  ns.addVariable({ componentOf: machine, browseName: 'TotalEnergy', nodeId: 's=Press01.TotalEnergy', dataType: 'Int64',
    value: { get: () => new Variant({ dataType: DataType.Int64, arrayType: VariantArrayType.Scalar, value: [1, 5] }) } });
  await server.start();
  const endpoint = server.getEndpointUrl().replace(/\/\/[^:]+:/, '//localhost:');
  const nsIndex = ns.index;
  return {
    server, state, endpoint, nsIndex,
    stop: async () => { clearInterval(timer); await server.shutdown(0); },
  };
}

module.exports = { startServer };

if (require.main === module) {
  startServer(Number(process.argv[2]) || 4840).then((s) => {
    console.log(`Test server running at ${s.endpoint} (namespace ${s.nsIndex}). Ctrl+C to stop.`);
    process.on('SIGINT', () => s.stop().then(() => process.exit(0)));
  });
}
