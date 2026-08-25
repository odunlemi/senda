export class BadRequestError extends Error {}
export class NotFoundError extends Error {}

export function badRequest(message: string): never {
  throw new BadRequestError(message);
}

export function notFound(message: string): never {
  throw new NotFoundError(message);
}
