import { Controller, Post, Body, Delete, Param, Patch } from '@nestjs/common';
import { UsersService } from './users.service';

@Controller('users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Post('create-senior')
  async createSenior(@Body() body: any) {
    return this.usersService.createManagedSenior(body);
  }

  @Patch('devices/unassign/:id')
  async unassignDevice(@Param('id') id: string) {
    return this.usersService.unassignDevice(id);
  }

  @Delete('senior/:id')
  async deleteSenior(@Param('id') id: string) {
    return this.usersService.deleteSenior(id);
  }

  @Patch('assign-device/:seniorId')
  async assignDeviceToSenior(
    @Param('seniorId') seniorId: string,
    @Body() body: { serial: string; type: 'POD' | 'WEARABLE' },
  ) {
    const { serial, type } = body;
    return this.usersService.assignDevice(seniorId, serial, type);
  }

  @Post('admin-create')
  async createAnyUser(@Body() body: any) {
    return this.usersService.createAnyUser(body);
  }

  @Patch(':id')
  async updateUser(@Param('id') id: string, @Body() body: any) {
    return this.usersService.updateUser(id, body);
  }

  @Post('relationships')
  async assignRelationship(
    @Body() body: { caregiverId: string; seniorId: string },
  ) {
    return this.usersService.assignRelationship(
      body.caregiverId,
      body.seniorId,
    );
  }

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
