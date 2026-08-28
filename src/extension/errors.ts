import type { BridgeErrorCode } from "../shared/protocol.js";

export class BridgeFault extends Error {
  constructor(readonly code: BridgeErrorCode) {
    super("Couch Potato bridge operation failed");
    this.name = "BridgeFault";
  }
}

export function asBridgeFault(error: unknown): BridgeFault {
  return error instanceof BridgeFault ? error : new BridgeFault("INTERNAL_ERROR");
}
