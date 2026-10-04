import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ROLES_KEY } from './roles.decorator';
import type { AuthenticatedUser, WellNestRole } from './auth.types';

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const allowed = this.reflector.getAllAndOverride<WellNestRole[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (!allowed || allowed.length === 0) return true;

    const request = context.switchToHttp().getRequest();
    const user = request.authUser as AuthenticatedUser | undefined;

    if (!user || !allowed.includes(user.role)) {
      throw new ForbiddenException('Insufficient role');
    }

    return true;
  }
}
