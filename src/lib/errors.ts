export class BadRequestError extends Error {}
export class NotFoundError extends Error {}
export class ConflictError extends Error {}

export function badRequest(message: string): never {
  throw new BadRequestError(message);
}

export function notFound(message: string): never {
  throw new NotFoundError(message);
}

export function conflict(message: string): never {
  throw new ConflictError(message);
}
