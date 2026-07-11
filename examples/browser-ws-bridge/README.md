# Browser example — Modbus over a WebSocket bridge

Browsers cannot open raw TCP or serial connections, so the browser side
implements `@moddef/core`'s `Transport` over a WebSocket, and a small Node
bridge forwards frames to the real Modbus device.

- `bridge.ts` — Node WebSocket server; forwards JSON requests to a
  `@moddef/transport-modbus-serial` connection.
- `ws-transport.ts` — browser-safe `Transport` implementation speaking the
  bridge's JSON protocol.
- The generated device classes and all of `@moddef/core` are isomorphic; the
  bundle check in CI (`npm run smoke:browser`) proves no Node builtins leak
  into the browser path.

Protocol (one JSON object per message, request/response by `id`):

```json
{ "id": 1, "op": "readHolding", "offset": 0, "quantity": 2, "unitId": 1 }
{ "id": 1, "ok": true, "data": [1234, 5678] }
```
