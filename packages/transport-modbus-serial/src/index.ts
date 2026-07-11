/**
 * @moddef/transport-modbus-serial — ModDef Transport adapter (spec §32.3) for
 * the `modbus-serial` package. Node-only (RTU needs serialport; TCP needs
 * net). Browser applications implement Transport over a bridge instead.
 *
 * Concurrency: modbus-serial multiplexes one request at a time on a
 * connection, so all operations are serialized through a FIFO promise queue.
 */

import ModbusSerialDefault from "modbus-serial";
import type { ModbusRTU as IModbusRTU } from "modbus-serial/ModbusRTU.js";
import { TransportError, type Transport, type TransportOpts } from "@moddef/core";

// modbus-serial is CJS with `module.exports = ModbusRTU`; under NodeNext the
// default import is typed as the module namespace, so unwrap the constructor.
const ModbusRTU = ModbusSerialDefault as unknown as new () => IModbusRTU;

export interface ModbusSerialOptions {
  /** Default Modbus unit/slave id (per-call override via TransportOpts). */
  unitId?: number;
  /** Request timeout in milliseconds (default 2000). */
  timeoutMs?: number;
  /**
   * Cap on registers per read request (default 125, the Modbus maximum).
   * Some devices enforce a lower window, e.g. 40 parameters on the Eastron
   * SDM630 or 11 words on the Carlo Gavazzi EM24.
   */
  maxReadWords?: number;
}

export interface RtuOptions extends ModbusSerialOptions {
  baudRate?: number;
  dataBits?: 5 | 6 | 7 | 8;
  stopBits?: 1 | 2;
  parity?: "none" | "even" | "odd";
}

export interface TcpOptions extends ModbusSerialOptions {
  port?: number;
}

export class ModbusSerialTransport implements Transport {
  private queue: Promise<unknown> = Promise.resolve();

  private constructor(
    private readonly client: IModbusRTU,
    private readonly opts: ModbusSerialOptions,
  ) {
    client.setTimeout(opts.timeoutMs ?? 2000);
    if (opts.unitId !== undefined) client.setID(opts.unitId);
  }

  /** Connect over Modbus TCP. */
  static async tcp(host: string, opts: TcpOptions = {}): Promise<ModbusSerialTransport> {
    const client = new ModbusRTU();
    await client.connectTCP(host, { port: opts.port ?? 502 });
    return new ModbusSerialTransport(client, opts);
  }

  /** Connect over Modbus RTU (buffered serial). */
  static async rtu(path: string, opts: RtuOptions = {}): Promise<ModbusSerialTransport> {
    const client = new ModbusRTU();
    await client.connectRTUBuffered(path, {
      baudRate: opts.baudRate ?? 9600,
      dataBits: opts.dataBits ?? 8,
      stopBits: opts.stopBits ?? 1,
      parity: opts.parity ?? "none",
    });
    return new ModbusSerialTransport(client, opts);
  }

  /** Wrap an already-connected modbus-serial client. */
  static wrap(client: IModbusRTU, opts: ModbusSerialOptions = {}): ModbusSerialTransport {
    return new ModbusSerialTransport(client, opts);
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => this.client.close(() => resolve()));
  }

  // ----- Transport --------------------------------------------------------- //

  async readHolding(offset: number, quantity: number, opts?: TransportOpts): Promise<Uint16Array> {
    return this.readWords(offset, quantity, opts, (o, n) => this.client.readHoldingRegisters(o, n));
  }

  async readInput(offset: number, quantity: number, opts?: TransportOpts): Promise<Uint16Array> {
    return this.readWords(offset, quantity, opts, (o, n) => this.client.readInputRegisters(o, n));
  }

  async readCoils(offset: number, quantity: number, opts?: TransportOpts): Promise<boolean[]> {
    return this.enqueue(opts, async () => {
      const res = await this.client.readCoils(offset, quantity);
      return res.data.slice(0, quantity);
    });
  }

  async readDiscrete(offset: number, quantity: number, opts?: TransportOpts): Promise<boolean[]> {
    return this.enqueue(opts, async () => {
      const res = await this.client.readDiscreteInputs(offset, quantity);
      return res.data.slice(0, quantity);
    });
  }

  async writeHolding(offset: number, values: ArrayLike<number>, opts?: TransportOpts): Promise<void> {
    const arr = Array.from(values, (v) => v & 0xffff);
    await this.enqueue(opts, async () => {
      if (arr.length === 1) await this.client.writeRegister(offset, arr[0]!);
      else await this.client.writeRegisters(offset, arr);
    });
  }

  async writeCoil(offset: number, value: boolean, opts?: TransportOpts): Promise<void> {
    await this.enqueue(opts, async () => {
      await this.client.writeCoil(offset, value);
    });
  }

  // ----- internals ---------------------------------------------------------- //

  /** Chunked register reads honoring maxReadWords. */
  private async readWords(
    offset: number,
    quantity: number,
    opts: TransportOpts | undefined,
    read: (offset: number, n: number) => Promise<{ data: number[] }>,
  ): Promise<Uint16Array> {
    const max = Math.max(1, Math.min(this.opts.maxReadWords ?? 125, 125));
    const out = new Uint16Array(quantity);
    let done = 0;
    while (done < quantity) {
      const n = Math.min(max, quantity - done);
      const off = offset + done;
      const chunk = await this.enqueue(opts, async () => (await read(off, n)).data);
      out.set(chunk.slice(0, n), done);
      done += n;
    }
    return out;
  }

  /** Serialize an operation on the connection; apply unit id and abort. */
  private enqueue<T>(opts: TransportOpts | undefined, op: () => Promise<T>): Promise<T> {
    const task = this.queue.then(async () => {
      opts?.signal?.throwIfAborted();
      const unit = opts?.unitId ?? this.opts.unitId;
      if (unit !== undefined) this.client.setID(unit);
      try {
        return await op();
      } catch (e) {
        throw toTransportError(e);
      }
    });
    // Keep the queue alive regardless of individual task failures.
    this.queue = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  }
}

function toTransportError(e: unknown): TransportError {
  if (e instanceof TransportError) return e;
  const err = e as { message?: string; modbusCode?: number };
  return new TransportError(err?.message ?? String(e), err?.modbusCode, { cause: e });
}
