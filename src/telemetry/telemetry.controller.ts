import { Controller, Post, Body, HttpCode, HttpStatus, Logger } from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';
import { TelemetryService } from './telemetry.service';
import { CreatePodTelemetryDto, CreateWearableTelemetryDto } from './dto/create-telemetry.dto';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';

@ApiTags('Telemetry (IoT Data Ingestion)')
@Controller('telemetry')
export class TelemetryController {
  private readonly logger = new Logger(TelemetryController.name);

  constructor(private readonly telemetryService: TelemetryService) {}

  // ==========================================
  // HTTP ENDPOINTS (For Software Simulator)
  // ==========================================
  @Post('pod')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Ingest environmental data from a WellNest Pod' })
  @ApiResponse({ status: 201, description: 'Telemetry saved and evaluated successfully.' })
  async receivePodData(@Body() createPodTelemetryDto: CreatePodTelemetryDto) {
    return await this.telemetryService.processPodTelemetry(createPodTelemetryDto);
  }

  @Post('wearable')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Ingest motion events from a WellNest Wearable' })
  async receiveWearableData(@Body() dto: CreateWearableTelemetryDto) {
    return await this.telemetryService.processWearableTelemetry(dto);
  }

  // ==========================================
  // MQTT ENDPOINTS (For Real Arduino Hardware)
  // ==========================================
  @MessagePattern('wellnest/mvp/pod')
  async handlePodMqtt(@Payload() data: any) {
    this.logger.log(`Received MQTT Pod Data`);
    try {
      // MQTT payloads often arrive as strings, so we parse them safely
      const parsedData = typeof data === 'string' ? JSON.parse(data) : data;
      await this.telemetryService.processPodTelemetry(parsedData);
    } catch (error) {
      this.logger.error(`Failed to process MQTT Pod data: ${error.message}`);
    }
  }

  @MessagePattern('wellnest/mvp/wearable')
  async handleWearableMqtt(@Payload() data: any) {
    this.logger.log(`Received MQTT Wearable Data`);
    try {
      const parsedData = typeof data === 'string' ? JSON.parse(data) : data;
      await this.telemetryService.processWearableTelemetry(parsedData);
    } catch (error) {
      this.logger.error(`Failed to process MQTT Wearable data: ${error.message}`);
    }
  }
}