export type ApiKeysErrorCode =
  | 'API_KEYS_INVALID_CONFIG'
  | 'API_KEYS_INVALID_ARGUMENT'
  | 'API_KEYS_NOT_FOUND'
  | 'API_KEYS_REVOKED'
  | 'API_KEYS_EXPIRED'
  | 'API_KEYS_DISABLED'
  | 'API_KEYS_SCOPE_DENIED'
  | 'API_KEYS_UNAUTHORIZED'
  | 'API_KEYS_FORBIDDEN'
  | 'API_KEYS_CONFLICT'
  | 'API_KEYS_RATE_LIMITED'
  | 'API_KEYS_VALIDATION'
  | 'API_KEYS_ESCALATION'
  | 'API_KEYS_PAYLOAD_TOO_LARGE'
  | 'API_KEYS_UNSUPPORTED_MEDIA_TYPE'
  | 'API_KEYS_METHOD_NOT_ALLOWED';

export interface ApiKeysErrorOptions {
  status?: number;
  expose?: boolean;
  details?: unknown;
  cause?: unknown;
}

/** Base error for the module. Satisfies the ErrorLike port. */
export class ApiKeysError extends Error {
  readonly code: ApiKeysErrorCode;
  readonly status: number;
  readonly expose: boolean;
  readonly details: unknown;

  constructor(code: ApiKeysErrorCode, message: string, options: ApiKeysErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'ApiKeysError';
    this.code = code;
    this.status = options.status ?? 500;
    this.expose = options.expose ?? false;
    this.details = options.details;
  }
}

export function configError(option: string, message: string): ApiKeysError {
  return new ApiKeysError(
    'API_KEYS_INVALID_CONFIG',
    `Invalid api-keys option "${option}": ${message}`,
    { status: 500, details: { option } },
  );
}

export function argumentError(argument: string, message: string): ApiKeysError {
  return new ApiKeysError(
    'API_KEYS_INVALID_ARGUMENT',
    `Invalid argument "${argument}": ${message}`,
    { status: 400, expose: true, details: { argument } },
  );
}

export function validationError(message: string, details?: unknown): ApiKeysError {
  return new ApiKeysError('API_KEYS_VALIDATION', message, {
    status: 400,
    expose: true,
    details,
  });
}

export function notFound(resource: string, id: string): ApiKeysError {
  return new ApiKeysError('API_KEYS_NOT_FOUND', `${resource} not found`, {
    status: 404,
    expose: true,
    details: { resource, id },
  });
}

export function isApiKeysError(error: unknown): error is ApiKeysError {
  return error instanceof ApiKeysError;
}
