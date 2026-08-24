import { Router } from 'express';
import * as internalController from '../controllers/internalController';

export const internalRoutes = Router();

internalRoutes.post('/internal/property-match-check', internalController.propertyMatchCheck);
