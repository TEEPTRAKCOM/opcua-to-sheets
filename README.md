# opcua-to-sheets

**Your machine data in a Google Sheet in 10 minutes.**

`opcua-to-sheets` reads tags from any OPC UA server (Siemens S7-1500, Beckhoff TwinCAT, KEPServerEX, Ignition, and others) and appends them to a Google Sheet, one tab per machine and one row per sample.

- **Read-only.** It never writes to your PLC.
- **No telemetry.** Nothing leaves your network except the rows you send to your own sheet.
- **MIT licensed,** built on [node-opcua](https://github.com/node-opcua/node-opcua).

```
Timestamp            Status  Running  PartCounter  Scrap
2026-11-02 06:00:00  ok      TRUE     12840        31
2026-11-02 06:00:10  ok      TRUE     12846        31
2026-11-02 06:00:20  ok      FALSE    12846        31
```

## Quickstart (10 minutes)

You need Node.js 22.13 or newer on a PC or Raspberry Pi that can reach the PLC, and a Google account.

**0. Install**

```bash
npm install -g github:TEEPTRAKCOM/opcua-to-sheets
```

On Linux you may need `sudo`. Without a global install, prefix every command with `npx github:TEEPTRAKCOM/opcua-to-sheets` instead of `opcua-to-sheets`.

**1. Find your tags**

```bash
opcua-to-sheets browse opc.tcp://192.168.0.10:4840
```

This prints every variable with the `nodeId` to copy, for example `PartCounter    nodeId: ns=3;s="DB_OEE"."PartCounter"`.

**2. Write a config**

```bash
opcua-to-sheets init config.yaml
```

Edit `config.yaml`: put in the endpoint and the tags you want. See [examples/](examples/) for Siemens, Beckhoff and Rockwell (via KEPServerEX).

**3. Test without Google**

```bash
opcua-to-sheets run --config config.yaml --dry-run
```

This prints the rows on screen. If they look right, the PLC side works.

**4. Connect the sheet**

1. In the [Google Cloud console](https://console.cloud.google.com/), create a project, enable the **Google Sheets API**, create a **service account** and download its JSON key as `service-account.json`.
2. Create a Google Sheet, and share it with the service account e-mail (`...@...iam.gserviceaccount.com`) as **Editor**.
3. Copy the sheet ID from its URL (`https://docs.google.com/spreadsheets/d/<ID>/edit`) into `sheet.spreadsheetId`.

**5. Run**

```bash
opcua-to-sheets run --config config.yaml --once   # one row, to check
opcua-to-sheets run --config config.yaml          # keep logging
```

To run it as a service on Linux, see [examples/opcua-to-sheets.service](examples/opcua-to-sheets.service).

No PLC at hand? Clone this repo (`git clone https://github.com/TEEPTRAKCOM/opcua-to-sheets`), run `npm install && npm run demo-server`, and point the config at `opc.tcp://localhost:4840`.

## How it works

- **Sampling:** every `sampleSeconds`, all tags of a machine are read in one OPC UA Read call.
- **Writing:** rows are buffered and written every `flushSeconds`, in one append per machine.
- **Status column:** `ok`, `bad: <tags>` (a tag returned a bad status code) or `error: <message>` (the machine could not be read). A gap in production is visible in the sheet; it is never silent.
- **Outages:** if Google is unreachable, rows stay in memory (up to `maxBufferedRows`) and are written when it comes back, with exponential back-off. If the PLC disconnects, it reconnects on the next sample.
- **Adding tags:** new tags can be added at the end of the list. Column B is always `Status`, so old rows stay aligned.

## Security

- The agent only reads values. Give it a **read-only OPC UA user** if your server supports users.
- Keep passwords out of the file: `password: "${OPCUA_PASSWORD}"` reads an environment variable.
- `security: { mode: SignAndEncrypt, policy: Basic256Sha256 }` encrypts the session. On first connection, trust the client certificate on the server; node-opcua creates it in its PKI folder.
- Text values that start with `=`, `+`, `-` or `@` are written as text, never as formulas.
- Keep `service-account.json` private. It can edit only the sheets you shared with it.

## Limits (by design)

This is a logger, not a production system. Know where it stops:

| Limit | Why |
| --- | --- |
| About 50 writes per minute in total | The Google Sheets API allows 60 write requests per minute per user. With `flushSeconds: 30` that is about 25 machines. |
| Spreadsheet size | A Google Sheet has a total cell limit; a fast sample rate on many tags fills it in weeks. |
| No shifts, no downtime reasons, no OEE | The sheet holds raw values. Shift calendars, stop reasons entered by operators, and OEE per shift are not in scope. |
| No alerts, no operator screens | Nobody is told when a line stops. |
| One process, in memory | If the PC running it is switched off, sampling stops. |

## When you outgrow this

Most teams start here and hit the same wall: several machines, three shifts, and the question "why did the line stop?", which a PLC tag cannot answer on its own.

That is what [TEEPTRAK](https://partners.teeptrak.com/en/opc-ua-to-google-sheets/?utm_source=github&utm_medium=readme&utm_campaign=opcua-to-sheets) does. It gives real-time OEE for every machine and every shift, with stop reasons entered by operators and screens on the shop floor. TEEPTRAK runs in more than 700 factories in over 30 countries.

**Engineers who bring TEEPTRAK into their plant can join the partner programme and get paid for the introduction:** [partners.teeptrak.com](https://partners.teeptrak.com/en/business-introducer/?utm_source=github&utm_medium=readme&utm_campaign=opcua-to-sheets).

## Configuration reference

| Key | Default | Meaning |
| --- | --- | --- |
| `sampleSeconds` | 10 | Seconds between two reads of each machine (minimum 1) |
| `flushSeconds` | 30 | Seconds between two writes to Google (at least `sampleSeconds`) |
| `maxBufferedRows` | 20000 | Rows kept in memory while Google is unreachable; the oldest are dropped first |
| `sheet.spreadsheetId` | | ID of the Google Sheet |
| `sheet.credentials` | | Path to the service account JSON key |
| `machines[].name` | | Tab name (100 characters max, no `[ ] : * ? / \`) |
| `machines[].endpoint` | | `opc.tcp://host:port` |
| `machines[].user` / `password` | | Optional OPC UA user name and password |
| `machines[].security` | `None` / `None` | `mode`: None, Sign, SignAndEncrypt; `policy`: None, Basic256Sha256, ... |
| `machines[].tags[]` | | `name` (column header) and `nodeId` |

## Troubleshooting

| Message | Fix |
| --- | --- |
| `Google Sheets API error 403` | Share the sheet with the service account e-mail as Editor. |
| `Google Sheets API error 404` | Check `spreadsheetId`. |
| `Google Sheets API error 429` | Raise `flushSeconds`, or split machines across two service accounts. |
| `bad: Tag (BadNodeIdUnknown)` | The nodeId is wrong. Run `browse` and copy it again. |
| `BadUserAccessDenied` / `BadIdentityTokenRejected` | Check the OPC UA user, or the server's anonymous access setting. |
| `tab "X" already has different columns` | You changed or removed tags. Use a new machine name, or only add new tags at the end. |

## Contributing

Issues and pull requests are welcome. Please include your OPC UA server brand and version, and the output of `browse` for the tags concerned (remove anything confidential).

## License

MIT, © 2026 TEEPTRAK. See [LICENSE](LICENSE).

OPC UA is a specification of the OPC Foundation. This project is not affiliated with or endorsed by the OPC Foundation, Google, Siemens, Beckhoff, Rockwell Automation or PTC (Kepware).
