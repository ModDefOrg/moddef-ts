/**
 * Measurand queries (spec §22, §26.1). A query selects points by their
 * semantic tuple; unspecified qualifiers are wildcards, base_quantity is
 * required. Mirrors go/client measurandMatches.
 */

import {
  Accumulation,
  Aggregation,
  Direction,
  MeasurementLocation,
  PhaseRef,
  type MeasurandRef,
} from "./schema/index.js";

export interface MeasurandQuery {
  baseQuantity: string;
  direction?: Direction;
  phaseRef?: PhaseRef;
  aggregation?: Aggregation;
  location?: MeasurementLocation;
  accumulation?: Accumulation;
}

export function measurandMatches(m: MeasurandRef | undefined, q: MeasurandQuery): boolean {
  if (!m) return false;
  if (m.baseQuantity !== q.baseQuantity) return false;
  if (q.direction !== undefined && q.direction !== Direction.DIRECTION_UNSPECIFIED && m.direction !== q.direction) return false;
  if (q.phaseRef !== undefined && q.phaseRef !== PhaseRef.PHASE_REF_UNSPECIFIED && m.phaseRef !== q.phaseRef) return false;
  if (q.aggregation !== undefined && q.aggregation !== Aggregation.AGGREGATION_UNSPECIFIED && m.aggregation !== q.aggregation) return false;
  if (q.location !== undefined && q.location !== MeasurementLocation.LOCATION_UNSPECIFIED && m.location !== q.location) return false;
  if (q.accumulation !== undefined && q.accumulation !== Accumulation.ACCUMULATION_UNSPECIFIED && m.accumulation !== q.accumulation) return false;
  return true;
}
