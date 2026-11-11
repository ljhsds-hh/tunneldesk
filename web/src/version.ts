/**
 * Version shown in the UI. The value is injected at build time from the
 * repository root package.json (see vite.config.ts), so there is exactly one
 * place to bump it.
 */
export const APP_VERSION = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '0.0.0';
