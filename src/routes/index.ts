import { Router } from 'express';
import { authRoutes } from './authRoutes';
import { profileRoutes } from './profileRoutes';
import { uploadRoutes } from './uploadRoutes';
import { catalogRoutes } from './catalogRoutes';
import { searchRoutes } from './searchRoutes';
import { matchesRoutes } from './matchesRoutes';
import { notificationsRoutes } from './notificationsRoutes';
import { internalRoutes } from './internalRoutes';
import systemRoutes from './system';
import propertiesRoutes from './properties';

export const routes = Router();

routes.use(authRoutes);
routes.use(profileRoutes);
routes.use(uploadRoutes);
routes.use(catalogRoutes);
routes.use(searchRoutes);
routes.use(matchesRoutes);
routes.use(notificationsRoutes);
routes.use(internalRoutes);
// KAN-142/KAN-273: system.ts (config-status, dashboard-metrics) y properties.ts (CRUD de
// /api/catalog/properties) quedaron afuera del split de "add: new routes structure" — el refactor
// movió las rutas inline de src/index.ts a controllers/ pero nunca migró estos dos routers, que ya
// vivían en archivos propios desde antes. internalRoutes ya cubre /internal/property-match-check
// (ver internalController.ts), así que el mismo path duplicado dentro de systemRoutes queda inerte.
routes.use(systemRoutes);
routes.use(propertiesRoutes);
