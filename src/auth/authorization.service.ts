import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import type { AuthenticatedUser } from './auth.types';

@Injectable()
export class AuthorizationService {
  constructor(private readonly prisma: PrismaService) {}

  async assertCanManageSenior(
    actor: AuthenticatedUser,
    seniorId: string,
  ): Promise<void> {
    if (actor.role === 'ADMIN') return;

    if (actor.role !== 'CAREGIVER') {
      throw new ForbiddenException('Only Admins or assigned Caregivers can manage Seniors');
    }

    const relation = await this.prisma.caregiver_senior.findUnique({
      where: {
        caregiver_id_senior_id: {
          caregiver_id: actor.id,
          senior_id: seniorId,
        },
      },
      select: { caregiver_id: true },
    });

    if (!relation) {
      throw new ForbiddenException('Senior is not assigned to this Caregiver');
    }
  }

  async assertCanManageDevice(
    actor: AuthenticatedUser,
    deviceId: string,
  ): Promise<void> {
    if (actor.role === 'ADMIN') return;

    const device = await this.prisma.devices.findUnique({
      where: { id: deviceId },
      select: { senior_id: true },
    });

    if (!device) {
      throw new NotFoundException('Device not found');
    }

    if (!device.senior_id) {
      throw new ForbiddenException('Caregiver cannot manage an unassigned device');
    }

    await this.assertCanManageSenior(actor, device.senior_id);
  }
}
