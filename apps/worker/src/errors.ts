// Errors a handler throws on purpose. The server maps them to `{ error: code, message }` with `status` (default 422),
// and the agent can say `message` to the merchant as is, so write it for a hawker, not a developer:
//   throw new UserFacingError("insufficient_funds", "You have S$42.10 available to withdraw.");
// Anything else thrown from a handler becomes a 500 and is logged.

export class UserFacingError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status = 422) {
    super(message);
    this.name = "UserFacingError";
    this.code = code;
    this.status = status;
  }
}

export function isUserFacingError(err: unknown): err is UserFacingError {
  return err instanceof UserFacingError;
}

/** For stubs whose task hasn't landed yet: 501 with a readable code. */
export function notImplemented(task: string, what: string): UserFacingError {
  return new UserFacingError("not_implemented", `${what} isn't available yet (${task}).`, 501);
}
