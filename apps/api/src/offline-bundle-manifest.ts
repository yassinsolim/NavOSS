import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';

import { OfflineBundleManifestSchema, ProblemDetailsSchema } from '@navoss/contracts';
import type { FastifyPluginCallback } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod/v4';

import { createProblem } from './problem.js';

const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;

/** Artifacts are served by static hosting; this endpoint never downloads or proxies them. */
export const registerOfflineBundleManifest: FastifyPluginCallback = (app, _options, done) => {
  const manifestPath = process.env.NAVOSS_OFFLINE_MANIFEST_PATH;

  app.withTypeProvider<ZodTypeProvider>().get(
    '/v1/offline/manifest',
    {
      schema: {
        description: 'Lists versioned, checksummed regional offline build artifacts.',
        response: {
          200: OfflineBundleManifestSchema,
          304: z.null().optional().describe('No response body'),
          503: ProblemDetailsSchema,
        },
        tags: ['config'],
      },
    },
    async (request, reply) => {
      try {
        if (!manifestPath) throw new Error('OfflineManifestNotConfigured');
        const file = await open(manifestPath, 'r');
        let text: string;
        try {
          const stat = await file.stat();
          if (!stat.isFile() || stat.size > MAX_MANIFEST_BYTES) {
            throw new Error('OfflineManifestTooLarge');
          }
          // Bound allocation to the actual file, and detect an in-place writer changing its size.
          const buffer = Buffer.allocUnsafe(stat.size + 1);
          let bytesRead = 0;
          while (bytesRead < buffer.length) {
            const part = await file.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
            if (part.bytesRead === 0) break;
            bytesRead += part.bytesRead;
          }
          if (bytesRead !== stat.size) throw new Error('OfflineManifestChangedDuringRead');
          text = buffer.toString('utf8', 0, bytesRead);
        } finally {
          await file.close();
        }
        const manifest = OfflineBundleManifestSchema.parse(JSON.parse(text));
        const etag = `W/"${createHash('sha256').update(JSON.stringify(manifest)).digest('hex')}"`;
        reply.header('Cache-Control', 'public, max-age=300, must-revalidate');
        reply.header('ETag', etag);
        const candidates = request.headers['if-none-match']?.split(',').map((tag) => tag.trim());
        if (candidates?.some((tag) => tag === '*' || tag.replace(/^W\//, '') === etag.slice(2))) {
          return await reply.status(304).send(undefined);
        }
        return await reply.send(manifest);
      } catch {
        // Never expose filesystem paths, source JSON, or artifact credentials through errors/logs.
        return reply
          .header('Cache-Control', 'no-store')
          .status(503)
          .type('application/problem+json')
          .send(
            createProblem(
              request,
              503,
              'service_unavailable',
              'Offline bundles unavailable',
              'No validated offline bundle manifest is currently available.',
            ),
          );
      }
    },
  );
  done();
};
