import { Router } from 'express';
import { authRoutes } from './authRoutes';
import { profileRoutes } from './profileRoutes';
import { uploadRoutes } from './uploadRoutes';
import { catalogRoutes } from './catalogRoutes';
import { searchRoutes } from './searchRoutes';
import { matchesRoutes } from './matchesRoutes';
import { notificationsRoutes } from './notificationsRoutes';
import { internalRoutes } from './internalRoutes';

export const routes = Router();

routes.use(authRoutes);
routes.use(profileRoutes);
routes.use(uploadRoutes);
routes.use(catalogRoutes);
routes.use(searchRoutes);
routes.use(matchesRoutes);
routes.use(notificationsRoutes);
routes.use(internalRoutes);
