import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Logger,
  Post,
  UseGuards,
} from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { TelemetryService } from './telemetry.service';
import {
  CreatePodTelemetryDto,
  CreateWearableTelemetryDto,
} from './dto/create-telemetry.dto';
import { TelemetryHttpGuard } from '../auth/telemetry-http.guard';

@ApiTags('Telemetry (IoT Data Ingestion)')
@Controller('telemetry')
export class TelemetryController {
  private readonly logger = new Logger(TelemetryController.name);

  constructor(private readonly telemetryService: TelemetryService) {}

  @Post('pod')
  @UseGuards(TelemetryHttpGuard)
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Ingest environmental data from a WellNest Pod simulator' })
  @ApiResponse({ status: 201, description: 'Telemetry saved and evaluated successfully.' })
  async receivePodData(@Body() dto: CreatePodTelemetryDto) {
    return this.telemetryService.processPodTelemetry(dto);
  }

  @Post('wearable')
  @UseGuards(TelemetryHttpGuard)
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Ingest motion events from a WellNest Wearable simulator' })
  async receiveWearableData(@Body() dto: CreateWearableTelemetryDto) {
    return this.telemetryService.processWearableTelemetry(dto);
  }

  @MessagePattern('wellnest/mvp/pod')
  async handlePodMqtt(@Payload() data: any) {
    this.logger.log('Received MQTT Pod Data');
    try {
      const parsedData = typeof data === 'string' ? JSON.parse(data) : data;
      await this.telemetryService.processPodTelemetry(parsedData);
    } catch (error: any) {
      this.logger.error(`Failed to process MQTT Pod data: ${error.message}`);
    }
  }

  @MessagePattern('wellnest/mvp/wearable')
  async handleWearableMqtt(@Payload() data: any) {
    this.logger.log('Received MQTT Wearable Data');
    try {
      const parsedData = typeof data === 'string' ? JSON.parse(data) : data;
      await this.telemetryService.processWearableTelemetry(parsedData);
    } catch (error: any) {
      this.logger.error(`Failed to process MQTT Wearable data: ${error.message}`);
    }
  }
}
