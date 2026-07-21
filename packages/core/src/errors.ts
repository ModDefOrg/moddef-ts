// SPDX-License-Identifier: Apache-2.0

/**
 * Typed error hierarchy (spec §26.3, §26.4, §32). All errors carry structured
 * fields so callers can branch without parsing messages.
 */

export class ModDefError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** Document failed to parse (bad YAML/JSON/binary, unknown fields, bad enums). */
export class ParseError extends ModDefError {}

/** A referenced point id does not exist in the device profile. */
export class PointNotFoundError extends ModDefError {
  constructor(readonly pointId: string) {
    super(`point not found: ${pointId}`);
  }
}

/** No point matches the measurand query (spec §26.3). */
export class MeasurandNotSupportedError extends ModDefError {
  constructor(readonly query: object) {
    super(`measurand not supported: ${JSON.stringify(query)}`);
  }
}

/** More than one point matches the measurand query (spec §26.4). */
export class AmbiguousMeasurandError extends ModDefError {
  constructor(
    readonly query: object,
    readonly matches: readonly string[],
  ) {
    super(
      `measurand query is ambiguous: ${JSON.stringify(query)} matches [${matches.join(", ")}]`,
    );
  }
}

/** The facade cannot serve this mapping (composed value, unknown discovery kind). */
export class UnsupportedMappingError extends ModDefError {
  constructor(
    readonly pointId: string,
    detail: string,
  ) {
    super(`unsupported mapping for ${pointId}: ${detail}`);
  }
}

export class DecodeError extends ModDefError {
  constructor(
    readonly pointId: string,
    detail: string,
  ) {
    super(`decode ${pointId}: ${detail}`);
  }
}

export class EncodeError extends ModDefError {
  constructor(
    readonly pointId: string,
    detail: string,
  ) {
    super(`encode ${pointId}: ${detail}`);
  }
}

/** The point's access mode does not permit the requested write. */
export class WriteAccessError extends ModDefError {
  constructor(
    readonly pointId: string,
    readonly access: string,
  ) {
    super(`point ${pointId} is not writable (access ${access})`);
  }
}

/** A write value violates the point's WriteConstraints (spec §11.4). */
export class WriteConstraintError extends ModDefError {
  constructor(
    readonly pointId: string,
    readonly constraint: "min_value" | "max_value" | "step" | "allowed_values",
    readonly value: unknown,
    detail: string,
  ) {
    super(`write ${pointId}: ${detail}`);
  }
}

/** Transport-level failure; carries the Modbus exception code when known. */
export class TransportError extends ModDefError {
  constructor(
    message: string,
    readonly exceptionCode?: number,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

/** A command id does not exist in the device profile (spec §11.7). */
export class CommandNotFoundError extends ModDefError {
  constructor(readonly commandId: string) {
    super(`command not found: ${commandId}`);
  }
}

/** A required command param was not supplied to runCommand (spec §11.7). */
export class RequiredParamMissingError extends ModDefError {
  constructor(
    readonly commandId: string,
    readonly field: string,
  ) {
    super(`command ${commandId}: required param missing: ${field}`);
  }
}

/** A poll step exceeded its timeout_ms (spec §11.7). */
export class PollTimeoutError extends ModDefError {
  constructor(
    readonly pointId: string,
    readonly timeoutMs: number,
  ) {
    super(`poll step timed out on ${pointId} after ${timeoutMs}ms`);
  }
}

/** A command step/result reference does not resolve (spec §11.7). */
export class StepReferenceError extends ModDefError {
  constructor(
    readonly ref: string,
    readonly kind: string,
  ) {
    super(`command step reference not found: ${kind} ${ref}`);
  }
}
