/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import { Injectable, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { createClient } from '@supabase/supabase-js';

@Injectable()
export class UsersService {
  private supabaseAdmin;

  constructor(private readonly prisma: PrismaService) {
    this.supabaseAdmin = createClient(
      process.env.SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
      { auth: { autoRefreshToken: false, persistSession: false } },
    );
  }

  private requireText(value: unknown, fieldName: string) {
    if (typeof value !== 'string' || !value.trim()) {
      throw new BadRequestException(`${fieldName} is required.`);
    }
    return value.trim();
  }

  private validateUserFields(data: any) {
    const email = this.requireText(data?.email, 'Email');
    const password = this.requireText(data?.password, 'Password');
    const firstName = this.requireText(data?.firstName, 'First name');
    const lastName = this.requireText(data?.lastName, 'Last name');
    return { email, password, firstName, lastName };
  }

  private async validateAvailableDevice(
    serial: string | undefined,
    type: 'POD' | 'WEARABLE',
  ) {
    if (!serial) return null;

    const device = await this.prisma.devices.findUnique({
      where: { serial_number: serial },
    });

    if (!device) {
      throw new BadRequestException(`${type} with serial ${serial} not found.`);
    }
    if (device.type !== type) {
      throw new BadRequestException(`Device ${serial} is not a ${type}.`);
    }
    if (device.senior_id) {
      throw new BadRequestException(`Device ${serial} is already assigned.`);
    }

    return device;
  }

  async createManagedSenior(data: any) {
    const { email, password, firstName, lastName } =
      this.validateUserFields(data);

    const caregiverId = this.requireText(data?.caregiverId, 'Caregiver ID');
    const podSerial =
      typeof data?.podSerial === 'string' && data.podSerial.trim()
        ? data.podSerial.trim()
        : undefined;
    const wearableSerial =
      typeof data?.wearableSerial === 'string' && data.wearableSerial.trim()
        ? data.wearableSerial.trim()
        : undefined;

    // Validate all references before creating the external Supabase Auth user.
    const caregiver = await this.prisma.users.findUnique({
      where: { id: caregiverId },
    });
    if (!caregiver || caregiver.role !== 'CAREGIVER') {
      throw new BadRequestException('A valid caregiver is required.');
    }

    const pod = await this.validateAvailableDevice(podSerial, 'POD');
    const wearable = await this.validateAvailableDevice(
      wearableSerial,
      'WEARABLE',
    );

    const { data: authUser, error: authError } =
      await this.supabaseAdmin.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
        user_metadata: { role: 'SENIOR' },
      });

    if (authError) throw new BadRequestException(authError.message);
    if (!authUser?.user?.id) {
      throw new BadRequestException('Failed to create authentication user.');
    }

    const seniorId = authUser.user.id;

    try {
      await this.prisma.users.create({
        data: {
          id: seniorId,
          email,
          first_name: firstName,
          last_name: lastName,
          role: 'SENIOR',
        },
      });

      await this.prisma.caregiver_senior.create({
        data: {
          caregiver_id: caregiverId,
          senior_id: seniorId,
        },
      });

      if (pod) {
        await this.prisma.devices.update({
          where: { id: pod.id },
          data: { senior_id: seniorId },
        });
      }

      if (wearable) {
        await this.prisma.devices.update({
          where: { id: wearable.id },
          data: { senior_id: seniorId },
        });
      }

      return { success: true, seniorId };
    } catch (error) {
      // Supabase Auth is external to PostgreSQL, so compensate explicitly if
      // any local persistence step fails. Each cleanup step is best-effort.
      try {
        await this.prisma.devices.updateMany({
          where: { senior_id: seniorId },
          data: { senior_id: null },
        });
      } catch {}

      try {
        await this.prisma.caregiver_senior.deleteMany({
          where: { senior_id: seniorId },
        });
      } catch {}

      try {
        await this.prisma.users.delete({
          where: { id: seniorId },
        });
      } catch {}

      try {
        await this.supabaseAdmin.auth.admin.deleteUser(seniorId);
      } catch {}

      throw error;
    }
  }

  async assignDevice(
    seniorId: string,
    serial: string,
    type: 'POD' | 'WEARABLE',
  ) {
    const device = await this.prisma.devices.findUnique({
      where: { serial_number: serial },
    });

    if (!device)
      throw new BadRequestException(`${type} with serial ${serial} not found.`);
    if (device.type !== type)
      throw new BadRequestException(`Device ${serial} is not a ${type}.`);
    if (device.senior_id)
      throw new BadRequestException(`Device ${serial} is already assigned.`);

    await this.prisma.devices.update({
      where: { id: device.id },
      data: { senior_id: seniorId },
    });
  }

  async unassignDevice(deviceId: string) {
    return await this.prisma.devices.update({
      where: { id: deviceId },
      data: { senior_id: null },
    });
  }

  async deleteSenior(seniorId: string) {
    await this.supabaseAdmin.auth.admin.deleteUser(seniorId);

    await this.prisma.caregiver_senior.deleteMany({
      where: { senior_id: seniorId },
    });

    await this.prisma.devices.updateMany({
      where: { senior_id: seniorId },
      data: { senior_id: null },
    });

    await this.prisma.users.delete({
      where: { id: seniorId },
    });

    return { success: true };
  }

  // --- ADMIN USER MANAGEMENT ---

  async createAnyUser(data: any) {
    const { email, password, firstName, lastName } =
      this.validateUserFields(data);

    const roleText = this.requireText(data?.role, 'Role');
    let role: 'ADMIN' | 'CAREGIVER' | 'SENIOR';
    switch (roleText) {
      case 'ADMIN':
      case 'CAREGIVER':
      case 'SENIOR':
        role = roleText;
        break;
      default:
        throw new BadRequestException('Role must be ADMIN, CAREGIVER, or SENIOR.');
    }

    const { data: authUser, error: authError } =
      await this.supabaseAdmin.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
        user_metadata: { role },
      });

    if (authError) throw new BadRequestException(authError.message);
    if (!authUser?.user?.id) {
      throw new BadRequestException('Failed to create authentication user.');
    }

    try {
      await this.prisma.users.create({
        data: {
          id: authUser.user.id,
          email,
          first_name: firstName,
          last_name: lastName,
          role,
        },
      });
    } catch (error) {
      // Do not leave an Auth-only user if the public profile insert fails.
      try {
        await this.supabaseAdmin.auth.admin.deleteUser(authUser.user.id);
      } catch {}
      throw error;
    }

    return { success: true, userId: authUser.user.id };
  }

  async updateUser(id: string, data: any) {
    return await this.prisma.users.update({
      where: { id },
      data: {
        first_name: data.firstName,
        last_name: data.lastName,
      },
    });
  }

  // --- RELATIONSHIP MANAGEMENT ---

  async assignRelationship(caregiverId: string, seniorId: string) {
    try {
      await this.prisma.caregiver_senior.create({
        data: { caregiver_id: caregiverId, senior_id: seniorId },
      });
      return { success: true };
    } catch (e) {
      // Existing relationship is intentionally idempotent.
      return { success: true };
    }
  }

  async removeRelationship(caregiverId: string, seniorId: string) {
    await this.prisma.caregiver_senior.deleteMany({
      where: { caregiver_id: caregiverId, senior_id: seniorId },
    });
    return { success: true };
  }
}
