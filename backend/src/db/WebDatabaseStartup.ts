import { DatabaseService } from './DatabaseService';

/** The web process keeps the legacy bootstrap unless explicitly disabled. */
export function createWebDatabase(
  env: NodeJS.ProcessEnv = process.env,
  create: (options?: { skipSchemaBootstrap?: boolean }) => DatabaseService = (options) => new DatabaseService(options),
): DatabaseService {
  const value = String(env.WEB_DATABASE_SCHEMA_BOOTSTRAP_ENABLED ?? '').trim().toLowerCase();
  if (value !== '' && value !== 'true' && value !== 'false') {
    throw new Error('WEB_DATABASE_SCHEMA_BOOTSTRAP_ENABLED must be true or false');
  }
  return value === 'false' ? create({ skipSchemaBootstrap: true }) : create();
}
