import { IsUUID, IsNumber, IsBoolean, Min, Max, IsEnum, IsOptional, IsString } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class CreatePodTelemetryDto {
  @ApiProperty({ description: 'The UUID of the Pod device' })
  @IsUUID()
  deviceId: string;

  @ApiProperty({ example: '2026-05-23T10:15:00Z', description: 'Device generated timestamp' })
  @IsString()
  @IsOptional()
  timestamp?: string;

  @ApiProperty({ example: 22.5 })
  @IsNumber()
  temperature: number;

  @ApiProperty({ example: 45.0 })
  @IsNumber()
  humidity: number;

  @ApiProperty({ example: 15432 })
  @IsNumber()
  @IsOptional()
  gasResistance?: number;

  @ApiProperty({ example: true })
  @IsBoolean()
  @IsOptional()
  occupancy?: boolean;

  @IsNumber()
  @IsOptional()
  airQualityScore?: number;
}

export enum EventType {
  FALL = 'FALL',
  PANIC = 'PANIC',
  REGULAR_MOVEMENT = 'REGULAR_MOVEMENT',
  NO_MOVEMENT = 'NO_MOVEMENT',
}

export class CreateWearableTelemetryDto {
  @ApiProperty({ description: 'The UUID of the Wearable device' })
  @IsUUID()
  deviceId: string;

  @ApiProperty({
    enum: EventType,
    description: 'The type of motion event detected',
  })
  @IsEnum(EventType)
  eventType: EventType;

  @ApiProperty({
  example: '2026-09-25T00:15:30Z',
  description: 'Device generated timestamp',
  required: false,
  })
  @IsString()
  @IsOptional()
  timestamp?: string;
}
