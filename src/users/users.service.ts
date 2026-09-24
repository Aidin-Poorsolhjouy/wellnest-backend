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
    // Initialize Supabase Admin Client (Service Role Key is required here!)
    this.supabaseAdmin = createClient(
      process.env.SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
      { auth: { autoRefreshToken: false, persistSession: false } },
    );
  }

  async createManagedSenior(data: any) {
    const {
      email,
      password,
      firstName,
      lastName,
      caregiverId,
      podSerial,
      wearableSerial,
    } = data;

    // 1. Create Auth User in Supabase (This generates the UUID)
    const { data: authUser, error: authError } =
      await this.supabaseAdmin.auth.admin.createUser({
        email: email,
        password: password,
        email_confirm: true, // Auto-confirm so they can login immediately
        user_metadata: { role: 'SENIOR' },
      });

    if (authError) throw new BadRequestException(authError.message);
    const seniorId = authUser.user.id;

    // 2. Create Public User Profile
    await this.prisma.users.create({
      data: {
        id: seniorId,
        email: email,
        first_name: firstName,
        last_name: lastName,
        role: 'SENIOR',
      },
    });

    // 3. Link to Caregiver
    await this.prisma.caregiver_senior.create({
      data: {
        caregiver_id: caregiverId,
        senior_id: seniorId,
      },
    });

    // 4. Assign Devices (if provided)
    if (podSerial) await this.assignDevice(seniorId, podSerial, 'POD');
    if (wearableSerial)
      await this.assignDevice(seniorId, wearableSerial, 'WEARABLE');

    return { success: true, seniorId };
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

  // async deleteSenior(seniorId: string) {
  //   // 1. Delete from Auth (Admin only)
  //   await this.supabaseAdmin.auth.admin.deleteUser(seniorId);
  //   // 2. Prisma Cascade will handle the public.users table and relationships
  //   return { success: true };
  // }

  async deleteSenior(seniorId: string) {
    // 1. Delete from Supabase Auth
    await this.supabaseAdmin.auth.admin.deleteUser(seniorId);

    // 2. Delete caregiver_senior links
    await this.prisma.caregiver_senior.deleteMany({
      where: { senior_id: seniorId },
    });

    // 3. Unassign devices
    await this.prisma.devices.updateMany({
      where: { senior_id: seniorId },
      data: { senior_id: null }, // keeps devices but unassigns them
    });

    // 4. Delete the senior profile
    await this.prisma.users.delete({
      where: { id: seniorId },
    });

    return { success: true };
  }

  // --- ADMIN USER MANAGEMENT ---

  async createAnyUser(data: any) {
    const { email, password, firstName, lastName, role } = data;

    // 1. Create Auth User
    const { data: authUser, error: authError } =
      await this.supabaseAdmin.auth.admin.createUser({
        email: email,
        password: password,
        email_confirm: true,
        user_metadata: { role: role },
      });

    if (authError) throw new BadRequestException(authError.message);

    // 2. Create Public Profile
    await this.prisma.users.create({
      data: {
        id: authUser.user.id,
        email: email,
        first_name: firstName,
        last_name: lastName,
        role: role,
      },
    });

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
      // Ignore if already exists
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
