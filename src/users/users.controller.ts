import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Param,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth } from '@nestjs/swagger';
import { UsersService } from './users.service';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { AuthorizationService } from '../auth/authorization.service';
import type { AuthenticatedUser } from '../auth/auth.types';

type AuthenticatedRequest = {
  authUser: AuthenticatedUser;
};

@ApiBearerAuth()
@UseGuards(SupabaseAuthGuard, RolesGuard)
@Controller('users')
export class UsersController {
  constructor(
    private readonly usersService: UsersService,
    private readonly authorization: AuthorizationService,
  ) {}

  @Roles('CAREGIVER', 'ADMIN')
  @Post('create-senior')
  async createSenior(
    @Req() req: AuthenticatedRequest,
    @Body() body: any,
  ) {
    if (
      req.authUser.role === 'CAREGIVER' &&
      body.caregiverId !== req.authUser.id
    ) {
      throw new ForbiddenException(
        'Caregiver may only create a Senior in their own care circle',
      );
    }

    if (req.authUser.role === 'ADMIN' && !body.caregiverId) {
      throw new ForbiddenException('caregiverId is required');
    }

    return this.usersService.createManagedSenior(body);
  }

  @Roles('CAREGIVER', 'ADMIN')
  @Patch('devices/unassign/:id')
  async unassignDevice(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
  ) {
    await this.authorization.assertCanManageDevice(req.authUser, id);
    return this.usersService.unassignDevice(id);
  }

  @Roles('CAREGIVER', 'ADMIN')
  @Delete('senior/:id')
  async deleteSenior(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
  ) {
    await this.authorization.assertCanManageSenior(req.authUser, id);
    return this.usersService.deleteSenior(id);
  }

  @Roles('CAREGIVER', 'ADMIN')
  @Patch('assign-device/:seniorId')
  async assignDeviceToSenior(
    @Req() req: AuthenticatedRequest,
    @Param('seniorId') seniorId: string,
    @Body() body: { serial: string; type: 'POD' | 'WEARABLE' },
  ) {
    await this.authorization.assertCanManageSenior(req.authUser, seniorId);
    return this.usersService.assignDevice(seniorId, body.serial, body.type);
  }

  @Roles('ADMIN')
  @Post('admin-create')
  async createAnyUser(@Body() body: any) {
    return this.usersService.createAnyUser(body);
  }

  @Roles('ADMIN')
  @Patch(':id')
  async updateUser(@Param('id') id: string, @Body() body: any) {
    return this.usersService.updateUser(id, body);
  }

  @Roles('ADMIN')
  @Post('relationships')
  async assignRelationship(
    @Body() body: { caregiverId: string; seniorId: string },
  ) {
    return this.usersService.assignRelationship(
      body.caregiverId,
      body.seniorId,
    );
  }

  @Roles('ADMIN')
  @Delete('relationships')
  async removeRelationship(
    @Body() body: { caregiverId: string; seniorId: string },
  ) {
    return this.usersService.removeRelationship(
      body.caregiverId,
      body.seniorId,
    );
  }
}
