import { Test, TestingModule } from '@nestjs/testing';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';

describe('UsersController', () => {
  let controller: UsersController;

  const usersService = {
    createManagedSenior: jest.fn(),
    unassignDevice: jest.fn(),
    deleteSenior: jest.fn(),
    assignDevice: jest.fn(),
    createAnyUser: jest.fn(),
    updateUser: jest.fn(),
    assignRelationship: jest.fn(),
    removeRelationship: jest.fn(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      controllers: [UsersController],
      providers: [{ provide: UsersService, useValue: usersService }],
    }).compile();

    controller = module.get<UsersController>(UsersController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  it('delegates senior creation to UsersService', async () => {
    const body = {
      email: 'senior@example.com',
      password: 'SafePassword123!',
      firstName: 'Test',
      lastName: 'Senior',
      caregiverId: '22222222-2222-4222-8222-222222222222',
    };
    usersService.createManagedSenior.mockResolvedValue({ success: true, seniorId: 'senior-id' });

    await expect(controller.createSenior(body)).resolves.toEqual({
      success: true,
      seniorId: 'senior-id',
    });
    expect(usersService.createManagedSenior).toHaveBeenCalledWith(body);
  });

  it('delegates device assignment to UsersService', async () => {
    usersService.assignDevice.mockResolvedValue(undefined);

    await controller.assignDeviceToSenior('senior-id', {
      serial: 'POD-1001',
      type: 'POD',
    });

    expect(usersService.assignDevice).toHaveBeenCalledWith(
      'senior-id',
      'POD-1001',
      'POD',
    );
  });

  it('delegates relationship creation to UsersService', async () => {
    usersService.assignRelationship.mockResolvedValue({ success: true });

    await expect(
      controller.assignRelationship({
        caregiverId: 'caregiver-id',
        seniorId: 'senior-id',
      }),
    ).resolves.toEqual({ success: true });

    expect(usersService.assignRelationship).toHaveBeenCalledWith(
      'caregiver-id',
      'senior-id',
    );
  });
});
