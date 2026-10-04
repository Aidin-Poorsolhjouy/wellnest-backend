import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { timingSafeEqual } from 'crypto';

@Injectable()
export class TelemetryHttpGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const configured = process.env.TELEMETRY_HTTP_API_KEY;
    if (!configured) {
      throw new UnauthorizedException('HTTP telemetry ingestion is not configured');
    }

    const request = context.switchToHttp().getRequest();
    const supplied = String(request.headers?.['x-wellnest-telemetry-key'] ?? '');

    const a = Buffer.from(configured);
    const b = Buffer.from(supplied);

    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new UnauthorizedException('Invalid telemetry API key');
    }

    return true;
  }
}
