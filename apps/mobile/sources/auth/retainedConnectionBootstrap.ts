/** Single owner for startup and explicit retry; never introduces a new account. */
export function retainedConnectionBootstrap<T>(operation: () => Promise<T>) {
    let flight: Promise<T> | null = null;
    return () => {
        if (flight) return flight;
        flight = Promise.resolve().then(operation).finally(() => { flight = null; });
        return flight;
    };
}
