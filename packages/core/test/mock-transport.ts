// SPDX-License-Identifier: Apache-2.0

/** In-memory Modbus register image implementing the Transport interface. */
import type { Transport, TransportOpts } from "@moddef/core";

export class MockTransport implements Transport {
  holding: Uint16Array;
  input: Uint16Array;
  coils: boolean[];
  discrete: boolean[];
  readLog: string[] = [];

  constructor(size = 1024) {
    this.holding = new Uint16Array(size);
    this.input = new Uint16Array(size);
    this.coils = new Array(size).fill(false);
    this.discrete = new Array(size).fill(false);
  }

  async readHolding(offset: number, quantity: number, _opts?: TransportOpts): Promise<Uint16Array> {
    this.readLog.push(`H@${offset}x${quantity}`);
    if (offset + quantity > this.holding.length) throw new Error(`illegal address ${offset}`);
    return this.holding.slice(offset, offset + quantity);
  }
  async readInput(offset: number, quantity: number): Promise<Uint16Array> {
    this.readLog.push(`I@${offset}x${quantity}`);
    if (offset + quantity > this.input.length) throw new Error(`illegal address ${offset}`);
    return this.input.slice(offset, offset + quantity);
  }
  async readCoils(offset: number, quantity: number): Promise<boolean[]> {
    return this.coils.slice(offset, offset + quantity);
  }
  async readDiscrete(offset: number, quantity: number): Promise<boolean[]> {
    return this.discrete.slice(offset, offset + quantity);
  }
  async writeHolding(offset: number, values: ArrayLike<number>): Promise<void> {
    for (let i = 0; i < values.length; i++) this.holding[offset + i] = values[i]! & 0xffff;
  }
  async writeCoil(offset: number, value: boolean): Promise<void> {
    this.coils[offset] = value;
  }
}
