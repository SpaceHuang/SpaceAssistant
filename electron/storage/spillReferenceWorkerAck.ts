export type SpillReferenceAckAtomics = Pick<typeof Atomics, 'load' | 'wait'>

/** Wait against the value already observed; a concurrent acknowledgement then returns not-equal immediately. */
export function waitForSpillReferenceAck(ack: Int32Array, expected: number, atomics: SpillReferenceAckAtomics = Atomics): void {
  let observed = atomics.load(ack, 1)
  while (observed !== expected) {
    atomics.wait(ack, 1, observed)
    observed = atomics.load(ack, 1)
  }
}
