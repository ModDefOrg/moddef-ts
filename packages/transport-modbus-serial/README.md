# @moddef/transport-modbus-serial

`Transport` adapter (spec §32.3) for the `modbus-serial` package. Node only.

- `ModbusSerialTransport.tcp(host, { port, unitId })` and
  `.rtu(path, { baudRate, unitId })`, or `.wrap(client)` for an existing
  connection.
- Serializes concurrent requests (modbus-serial handles one in-flight
  request), chunks reads to `maxReadWords` (default 125; set lower for
  devices like the Eastron SDM630 or Carlo Gavazzi EM24), maps failures to
  `TransportError` with the Modbus exception code preserved.
