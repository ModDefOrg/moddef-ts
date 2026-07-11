/**
 * Modbus transport interface (spec §32.3). Offsets are 0-based wire offsets
 * (spec §7.1). Implementations wrap an RTU/TCP client (see
 * `@moddef/transport-modbus-serial`) or a browser-side bridge.
 */

export interface TransportOpts {
  signal?: AbortSignal;
  /** Override the target Modbus unit/slave id for this call. */
  unitId?: number;
}

export interface Transport {
  readHolding(offset: number, quantity: number, opts?: TransportOpts): Promise<Uint16Array>;
  readInput(offset: number, quantity: number, opts?: TransportOpts): Promise<Uint16Array>;
  readCoils(offset: number, quantity: number, opts?: TransportOpts): Promise<boolean[]>;
  readDiscrete(offset: number, quantity: number, opts?: TransportOpts): Promise<boolean[]>;
  writeHolding(offset: number, values: ArrayLike<number>, opts?: TransportOpts): Promise<void>;
  writeCoil(offset: number, value: boolean, opts?: TransportOpts): Promise<void>;
}
