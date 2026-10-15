/**
 * Errors the configurator may show.
 *
 * A PublicError's message is written for the person using the configurator
 * and is safe to send back. Anything else that is caught (a D1 failure, a
 * bug) stays in the Worker logs: its message can carry internals.
 */

export class PublicError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

export const INTERNAL_ERROR = "internal error; the details are in the Worker logs (npx wrangler tail)";

export function publicError(err: unknown): { status: number; message: string } {
  if (err instanceof PublicError) return { status: err.status, message: err.message };
  return { status: 500, message: INTERNAL_ERROR };
}
