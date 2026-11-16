/** @typedef {Record<string,any>} Value */
/** Explicit full native-summary fixture for backend tests; no RPC or history IO.
 * @param {()=>Value} readHeaders @param {()=>number} [now] @returns {(scope:Value)=>Value} */
export function fixtureSummaryReplica(readHeaders, now = Date.now) {
  let instances = 0;
  return (/** @type {Value} */ scope) => {
    const epoch = `fixture-stream-${++instances}`, capturedAt = now();
    let alive = true;
    return {
      scope,
      subscribe: () => () => {},
      /** @param {string[]} ids @param {Value} context */
      getReplica(ids, context) {
        const current = alive && context.expectedHostId === scope.hostId && context.generation === scope.generation;
        const native = readHeaders(), headers = /** @type {Value} */ ({}), states = /** @type {Value} */ ({}), captures = /** @type {Value} */ ({});
        for (const id of ids) {
          if (current && native[id]) {
            const summary = structuredClone(native[id]);
            headers[id] = { notFullyIdle: false, hasRunningSubagents: false, hasActiveChildren: false, backgroundTaskCount: 0, ...summary };
            states[id] = 'ready'; captures[id] = capturedAt;
          } else states[id] = 'unknown';
        }
        return { available: current, complete: current && ids.every(id => states[id] === 'ready'), headers, states, captures, scope,
          streamEpoch: epoch, revision: 1, observedAt: capturedAt,
          liveProof: current ? { ...scope, currentAlive: true, fullReplacement: true, proto3Defaults: true, streamEpoch: epoch } : null };
      },
      /** @param {string[]} ids @param {Value} context */
      async read(ids, context) { return this.getReplica(ids, context); },
      async dispose() { alive = false; }
    };
  };
}
