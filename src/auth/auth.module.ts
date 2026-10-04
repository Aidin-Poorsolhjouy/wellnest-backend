import { Global, Module } from '@nestjs/common';
import { AuthorizationService } from './authorization.service';
import { RolesGuard } from './roles.guard';
import { SupabaseAuthGuard } from './supabase-auth.guard';
import { TelemetryHttpGuard } from './telemetry-http.guard';

@Global()
@Module({
  providers: [
    SupabaseAuthGuard,
    RolesGuard,
    AuthorizationService,
    TelemetryHttpGuard,
  ],
  exports: [
    SupabaseAuthGuard,
    RolesGuard,
    AuthorizationService,
    TelemetryHttpGuard,
  ],
})
export class AuthModule {}
