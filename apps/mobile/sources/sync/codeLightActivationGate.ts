/** Only concurrent entries coalesce. An observer can retire under the same owner. */
export class CodeLightActivationGate {
    private flights = new Map<string, Promise<unknown>>();
    run(identity: string, activate: () => Promise<unknown>): Promise<unknown> {
        const existing = this.flights.get(identity);
        if (existing) return existing;
        const flight = Promise.resolve().then(activate).finally(() => {
            if (this.flights.get(identity) === flight) this.flights.delete(identity);
        });
        this.flights.set(identity, flight);
        return flight;
    }
}
