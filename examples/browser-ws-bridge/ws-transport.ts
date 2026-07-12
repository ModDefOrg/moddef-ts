// SPDX-License-Identifier: Apache-2.0

/**
 * Browser-safe Transport over a WebSocket bridge (see README.md for the
 * protocol). Works with the generated device classes unchanged:
 *
 *   const transport = await WsTransport.connect("ws://localhost:8502");
 *   const inverter = new GrowattSph(transport);
 */
import { TransportError, type Transport, type TransportOpts } from "@moddef/core";

type Req = {
  id: number;
  op: string;
  offset: number;
  quantity?: number;
  values?: number[];
  value?: boolean;
  unitId?: number;
};
type Res = { id: number; ok: boolean; data?: (number | boolean)[]; error?: string; code?: number };

export class WsTransport implements Transport {
  private nextId = 1;
  private pending = new Map<number, { resolve: (r: Res) => void; reject: (e: Error) => void }>();

  private constructor(private readonly ws: WebSocket) {
    ws.onmessage = (ev) => {
      const res = JSON.parse(String(ev.data)) as Res;
      const p = this.pending.get(res.id);
      if (!p) return;
      this.pending.delete(res.id);
      p.resolve(res);
    };
    ws.onclose = () => {
      for (const [, p] of this.pending) p.reject(new TransportError("bridge connection closed"));
      this.pending.clear();
    };
  }

  static connect(url: string): Promise<WsTransport> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.onopen = () => resolve(new WsTransport(ws));
      ws.onerror = () => reject(new TransportError(`cannot connect to bridge at ${url}`));
    });
  }

  close(): void {
    this.ws.close();
  }

  private call(req: Omit<Req, "id">, opts?: TransportOpts): Promise<Res> {
    const id = this.nextId++;
    return new Promise<Res>((resolve, reject) => {
      opts?.signal?.addEventListener("abort", () => {
        this.pending.delete(id);
        reject(new TransportError("aborted"));
      });
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, unitId: opts?.unitId, ...req }));
    }).then((res) => {
      if (!res.ok) throw new TransportError(res.error ?? "bridge error", res.code);
      return res;
    });
  }

  async readHolding(offset: number, quantity: number, opts?: TransportOpts): Promise<Uint16Array> {
    const r = await this.call({ op: "readHolding", offset, quantity }, opts);
    return Uint16Array.from((r.data ?? []) as number[]);
  }
  async readInput(offset: number, quantity: number, opts?: TransportOpts): Promise<Uint16Array> {
    const r = await this.call({ op: "readInput", offset, quantity }, opts);
    return Uint16Array.from((r.data ?? []) as number[]);
  }
  async readCoils(offset: number, quantity: number, opts?: TransportOpts): Promise<boolean[]> {
    const r = await this.call({ op: "readCoils", offset, quantity }, opts);
    return (r.data ?? []) as boolean[];
  }
  async readDiscrete(offset: number, quantity: number, opts?: TransportOpts): Promise<boolean[]> {
    const r = await this.call({ op: "readDiscrete", offset, quantity }, opts);
    return (r.data ?? []) as boolean[];
  }
  async writeHolding(offset: number, values: ArrayLike<number>, opts?: TransportOpts): Promise<void> {
    await this.call({ op: "writeHolding", offset, values: Array.from(values) }, opts);
  }
  async writeCoil(offset: number, value: boolean, opts?: TransportOpts): Promise<void> {
    await this.call({ op: "writeCoil", offset, value }, opts);
  }
}
