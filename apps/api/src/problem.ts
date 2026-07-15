import type { ProblemCode, ProblemDetails } from '@navoss/contracts';
import type { FastifyRequest } from 'fastify';

export function createProblem(
  request: FastifyRequest,
  status: number,
  code: ProblemCode,
  title: string,
  detail: string,
): ProblemDetails {
  return {
    code,
    detail,
    requestId: request.id,
    status,
    title,
  };
}
