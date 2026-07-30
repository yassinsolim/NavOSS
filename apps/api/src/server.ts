import { z } from 'zod/v4';

import { buildApp } from './app.js';
import { createCalgaryRoadEventProvider } from './calgary-road-event-provider.js';
import { createOntarioRoadEventProvider } from './ontario-road-event-provider.js';

const ServerEnvironmentSchema = z
  .object({
    HOST: z.string().min(1).default('127.0.0.1'),
    PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  })
  .strict();

const environment = ServerEnvironmentSchema.parse({
  HOST: process.env.HOST,
  PORT: process.env.PORT,
});
const eventProvider = createCalgaryRoadEventProvider();
const ontarioEventProvider = createOntarioRoadEventProvider();
const app = await buildApp({ eventProvider, logger: true, ontarioEventProvider });

app.addHook('onClose', () => {
  eventProvider.stop?.();
  ontarioEventProvider.stop?.();
});

try {
  await app.listen({ host: environment.HOST, port: environment.PORT });
  eventProvider.start?.();
  ontarioEventProvider.start?.();
} catch (error: unknown) {
  app.log.error(error);
  process.exitCode = 1;
}
