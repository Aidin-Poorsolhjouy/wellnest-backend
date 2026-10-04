import { SetMetadata } from '@nestjs/common';
import type { WellNestRole } from './auth.types';

export const ROLES_KEY = 'wellnest_roles';
export const Roles = (...roles: WellNestRole[]) => SetMetadata(ROLES_KEY, roles);
