/** API error type and async-handler plumbing. Every error leaves the service
 *  in the frozen envelope shape `{error: {code, message}}` (api-contract line
 *  28); the mapping lives in app.ts. */

import type { NextFunction, Request, RequestHandler, Response } from 'express';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** Express 4 does not forward rejected promises to the error middleware. */
export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    fn(req, res, next).catch(next);
  };
}
