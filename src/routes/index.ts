import { Router } from 'express';
import { authRoutes } from './authRoutes';
import { profileRoutes } from './profileRoutes';
import { uploadRoutes } from './uploadRoutes';
import { catalogRoutes } from './catalogRoutes';
import propertiesRoutes from './properties';
import { searchRoutes } from './searchRoutes';
import { matchesRoutes } from './matchesRoutes';
import { notificationsRoutes } from './notificationsRoutes';
import { internalRoutes } from './internalRoutes';
import { systemRoutes } from './systemRoutes';
import { adminPanelRoutes } from './adminPanelRoutes';

export const routes = Router();

routes.use(authRoutes);
routes.use(profileRoutes);
routes.use(uploadRoutes);
routes.use(catalogRoutes);
// KAN-273 (CRUD de propiedades del tenant, GET/POST/PATCH/DELETE /api/catalog/properties): quedó
// sin montar tras el split de src/index.ts en la estructura routes/*Routes.ts + controllers/*
// (commit "add: new routes structure", 2026-08-24) — el router ya existía, solo faltaba este
// `routes.use`. Hallado al enforcear el cap de cartera del plan Free acá (Fase 1 pre-lanzamiento).
routes.use(propertiesRoutes);
routes.use(searchRoutes);
routes.use(matchesRoutes);
routes.use(notificationsRoutes);
routes.use(internalRoutes);
routes.use(systemRoutes);
routes.use(adminPanelRoutes);
