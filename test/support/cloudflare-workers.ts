// Minimal stand-in for the Workers runtime module in Node-based tests.
export class DurableObject<Env = unknown> {
  constructor(
    protected ctx: unknown,
    protected env: Env
  ) {}
}
