import { isRbacError, type RbacError } from '../errors.js';

/** RFC 9457 problem details body used by every HTTP adapter. */
export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  detail: string;
  code: string;
  errors?: readonly { path: string; message: string }[];
}

const TITLES: Record<number, string> = {
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  409: 'Conflict',
  413: 'Payload Too Large',
  415: 'Unsupported Media Type',
  500: 'Internal Server Error',
};

/**
 * Maps an error to problem+json. Forbidden responses never reveal the permission name.
 */
export function toProblem(err: unknown): ProblemDetails {
  if (isRbacError(err)) return fromRbacError(err);
  return {
    type: 'about:blank',
    title: 'Internal Server Error',
    status: 500,
    detail: 'An unexpected error occurred',
    code: 'RBAC_INTERNAL',
  };
}

function fromRbacError(err: RbacError): ProblemDetails {
  const status = err.expose ? err.status : 500;
  const detail =
    status === 403 ? 'Forbidden' : err.expose ? err.message : 'An unexpected error occurred';
  const problem: ProblemDetails = {
    type: 'about:blank',
    title: TITLES[status] ?? 'Error',
    status,
    detail,
    code: status === 500 && !err.expose ? 'RBAC_INTERNAL' : err.code,
  };
  if (err.expose && err.details && typeof err.details === 'object' && err.details !== null) {
    const details = err.details as { issues?: { path: string; message: string }[] };
    if (Array.isArray(details.issues) && details.issues.length > 0) {
      problem.errors = details.issues;
    }
  }
  return problem;
}

export const PROBLEM_CONTENT_TYPE = 'application/problem+json';
