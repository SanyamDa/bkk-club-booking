import { Hono } from 'hono';
import { requirePlatformAdmin, type AuthEnv } from '../auth.js';
import type { AppContext } from '../context.js';
import { calendarRoutes } from './calendar.js';
import { clubsRoutes } from './clubs.js';
import { controlsRoutes } from './controls.js';
import { dataRoutes } from './data.js';
import { debugRoutes } from './debug.js';
import { instagramAdminRoutes } from './instagram.js';
import { busynessKeyAdminRoutes } from '../data.js';
import { lineWizardRoutes } from './line-wizard.js';
import { onboardingAdminRoutes } from './onboarding.js';
import { platformRoutes } from './platform.js';
import { supportRoutes } from './support.js';

/**
 * Founder console API (plan A5, spec §12.3), mounted at /api/admin. Every route needs a live
 * platform-admin session (`requirePlatformAdmin`); anyone else gets 403.
 */
export function adminRoutes(app: AppContext) {
  const r = new Hono<AuthEnv>();
  r.use('*', requirePlatformAdmin(app));
  r.route('/', clubsRoutes(app));
  r.route('/', lineWizardRoutes(app));
  r.route('/', onboardingAdminRoutes(app)); // A17 onboarding wizard
  r.route('/', controlsRoutes(app));
  r.route('/', platformRoutes(app));
  r.route('/', supportRoutes(app));
  r.route('/', debugRoutes(app));
  r.route('/', dataRoutes(app));
  r.route('/', calendarRoutes(app)); // A9 event calendar and city calendar entry
  r.route('/', instagramAdminRoutes(app)); // A18 Instagram via Chatwoot
  r.route('/', busynessKeyAdminRoutes(app)); // B21 busyness feed keys
  return r;
}
