import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { PrismaService } from '../prisma/prisma.service';
import type { AuthenticatedUser, WellNestRole } from './auth.types';

@Injectable()
export class SupabaseAuthGuard implements CanActivate {
  private readonly supabase: SupabaseClient;

  constructor(private readonly prisma: PrismaService) {
    this.supabase = createClient(
      process.env.SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
      { auth: { autoRefreshToken: false, persistSession: false } },
    );
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const authHeader = String(request.headers?.authorization ?? '');

    if (!authHeader.toLowerCase().startsWith('bearer ')) {
      throw new UnauthorizedException('Bearer token required');
    }

    const token = authHeader.slice(7).trim();
    if (!token) {
      throw new UnauthorizedException('Bearer token required');
    }

    const {
      data: { user },
      error,
    } = await this.supabase.auth.getUser(token);

    if (error || !user) {
      throw new UnauthorizedException('Invalid or expired access token');
    }

    const profile = await this.prisma.users.findUnique({
      where: { id: user.id },
      select: { id: true, email: true, role: true },
    });

    if (!profile) {
      throw new UnauthorizedException('User profile not found');
    }

    request.authUser = {
      id: profile.id,
      email: profile.email,
      role: profile.role as WellNestRole,
    } satisfies AuthenticatedUser;

    return true;
  }
}
