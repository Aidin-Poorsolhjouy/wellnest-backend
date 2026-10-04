import { BadRequestException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { createClient } from '@supabase/supabase-js';
import { PrismaService } from '../prisma/prisma.service';
import { UsersService } from './users.service';

jest.mock('@supabase/supabase-js', () => ({
  createClient: jest.fn(),
}));

describe('UsersService', () => {
  let service: UsersService;

  const prisma = {
    users: {
      create: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    },
    caregiver_senior: {
      create: jest.fn(),
      deleteMany: jest.fn(),
    },
    devices: {
      findUnique: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
  };

  const supabaseAdmin = {
    auth: {
      admin: {
        createUser: jest.fn(),
        deleteUser: jest.fn(),
      },
    },
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    (createClient as unknown as jest.Mock).mockReturnValue(supabaseAdmin);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UsersService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();

    service = module.get<UsersService>(UsersService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('assigns an available device to a senior', async () => {
    prisma.devices.findUnique.mockResolvedValue({
      id: 'device-id',
      type: 'POD',
      senior_id: null,
    });
    prisma.devices.update.mockResolvedValue({ id: 'device-id' });

    await service.assignDevice('senior-id', 'POD-1001', 'POD');

    expect(prisma.devices.update).toHaveBeenCalledWith({
      where: { id: 'device-id' },
      data: { senior_id: 'senior-id' },
    });
  });

  it('rejects a missing device', async () => {
    prisma.devices.findUnique.mockResolvedValue(null);

    await expect(
      service.assignDevice('senior-id', 'POD-404', 'POD'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a device with the wrong type', async () => {
    prisma.devices.findUnique.mockResolvedValue({
      id: 'device-id',
      type: 'WEARABLE',
      senior_id: null,
    });

    await expect(
      service.assignDevice('senior-id', 'WEAR-1001', 'POD'),
    ).rejects.toThrow('Device WEAR-1001 is not a POD.');
  });

  it('rejects an already assigned device', async () => {
    prisma.devices.findUnique.mockResolvedValue({
      id: 'device-id',
      type: 'POD',
      senior_id: 'another-senior',
    });

    await expect(
      service.assignDevice('senior-id', 'POD-1001', 'POD'),
    ).rejects.toThrow('Device POD-1001 is already assigned.');
  });

  it('creates an admin/caregiver/senior user in auth and public profile', async () => {
    supabaseAdmin.auth.admin.createUser.mockResolvedValue({
      data: { user: { id: 'new-user-id' } },
      error: null,
    });
    prisma.users.create.mockResolvedValue({ id: 'new-user-id' });

    await expect(
      service.createAnyUser({
        email: 'caregiver@example.com',
        password: 'SafePassword123!',
        firstName: 'Care',
        lastName: 'Giver',
        role: 'CAREGIVER',
      }),
    ).resolves.toEqual({ success: true, userId: 'new-user-id' });

    expect(prisma.users.create).toHaveBeenCalledWith({
      data: {
        id: 'new-user-id',
        email: 'caregiver@example.com',
        first_name: 'Care',
        last_name: 'Giver',
        role: 'CAREGIVER',
      },
    });
  });

  it('rejects createAnyUser when password is missing before calling Supabase', async () => {
    await expect(
      service.createAnyUser({
        email: 'caregiver@example.com',
        firstName: 'Care',
        lastName: 'Giver',
        role: 'CAREGIVER',
      }),
    ).rejects.toThrow('Password is required.');

    expect(supabaseAdmin.auth.admin.createUser).not.toHaveBeenCalled();
  });

  it('propagates Supabase auth creation errors as BadRequestException', async () => {
    supabaseAdmin.auth.admin.createUser.mockResolvedValue({
      data: { user: null },
      error: { message: 'User already registered' },
    });

    await expect(
      service.createAnyUser({
        email: 'duplicate@example.com',
        password: 'SafePassword123!',
        firstName: 'Duplicate',
        lastName: 'User',
        role: 'CAREGIVER',
      }),
    ).rejects.toThrow('User already registered');
  });

  it('deletes the Auth user if public-profile creation fails', async () => {
    supabaseAdmin.auth.admin.createUser.mockResolvedValue({
      data: { user: { id: 'new-user-id' } },
      error: null,
    });
    prisma.users.create.mockRejectedValue(new Error('database failure'));
    supabaseAdmin.auth.admin.deleteUser.mockResolvedValue({ error: null });

    await expect(
      service.createAnyUser({
        email: 'caregiver@example.com',
        password: 'SafePassword123!',
        firstName: 'Care',
        lastName: 'Giver',
        role: 'CAREGIVER',
      }),
    ).rejects.toThrow('database failure');

    expect(supabaseAdmin.auth.admin.deleteUser).toHaveBeenCalledWith(
      'new-user-id',
    );
  });

  it('rejects managed-senior creation for an invalid caregiver before creating Auth state', async () => {
    prisma.users.findUnique.mockResolvedValue(null);

    await expect(
      service.createManagedSenior({
        email: 'senior@example.com',
        password: 'SafePassword123!',
        firstName: 'Senior',
        lastName: 'User',
        caregiverId: 'missing-caregiver',
      }),
    ).rejects.toThrow('A valid caregiver is required.');

    expect(supabaseAdmin.auth.admin.createUser).not.toHaveBeenCalled();
  });
});
