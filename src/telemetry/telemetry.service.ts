/* eslint-disable @typescript-eslint/no-unsafe-enum-comparison */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/restrict-template-expressions */
import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  CreatePodTelemetryDto,
  CreateWearableTelemetryDto,
} from './dto/create-telemetry.dto';

@Injectable()
export class TelemetryService {
  private readonly logger = new Logger(TelemetryService.name);

  constructor(private readonly prisma: PrismaService) {}

  async processPodTelemetry(dto: CreatePodTelemetryDto) {
    const device = await this.prisma.devices.findUnique({
      where: { id: dto.deviceId },
      select: { id: true, senior_id: true },
    });

    if (!device) throw new NotFoundException(`Device ${dto.deviceId} not found`);

    // 1. BULLETPROOF DEDUPLICATION
    let recordTime = new Date(); // Fallback to server time
    
    if (dto.timestamp) {
      recordTime = new Date(dto.timestamp);
      
      // Check if this exact timestamp from this device already exists in the DB
      const existingReading = await this.prisma.environmental_readings.findFirst({
        where: {
          device_id: device.id,
          recorded_at: recordTime,
        },
      });

      if (existingReading) {
        this.logger.debug(`[DEDUPE] Ignored duplicate MQTT payload from ${dto.timestamp}`);
        return { success: true, duplicate: true };
      }
    }

    this.logger.log(`Processing telemetry for device: ${dto.deviceId}`);

    // 2. Save to Database (Using the Device's exact timestamp)
    const reading = await this.prisma.environmental_readings.create({
      data: {
        device_id: device.id,
        temperature: dto.temperature,
        humidity: dto.humidity,
        gas_resistance: dto.gasResistance,
        air_quality_score: dto.airQualityScore,
        occupancy: dto.occupancy || false,
        recorded_at: recordTime, // Overrides the default NOW()
      },
    });

    // 3. Evaluate Thresholds
    if (device.senior_id) {
      await this.evaluateThresholds(device.senior_id, dto);
    }

    return { success: true, readingId: reading.id };
  }

  async processWearableTelemetry(dto: CreateWearableTelemetryDto) {
    this.logger.log(
      `Received wearable event [${dto.eventType}] for device: ${dto.deviceId}`,
    );

    const device = await this.prisma.devices.findUnique({
      where: { id: dto.deviceId },
      select: { id: true, senior_id: true },
    });

    if (!device)
      throw new NotFoundException(`Device ${dto.deviceId} not found`);

    // 1. Save the event to the database
    await this.prisma.activity_events.create({
      data: {
        device_id: device.id,
        type: dto.eventType as any,
      },
    });

    // 2. Trigger Alerts for Emergencies
    if (device.senior_id) {
      if (dto.eventType === 'FALL') {
        await this.triggerAlert(
          device.senior_id,
          '🚨 CRITICAL: Fall Detected',
          'Sudden impact and orientation change detected. Immediate check required.',
        );
      } else if (dto.eventType === 'PANIC') {
        await this.triggerAlert(
          device.senior_id,
          '🆘 EMERGENCY: Panic Button',
          'Senior pressed the emergency panic button on their wearable.',
        );
      }
    }

    return { success: true };
  }

  /**
   * THE THRESHOLD ENGINE
   * Evaluates incoming data against Personal or Global thresholds.
   */
  private async evaluateThresholds(seniorId: string, dto: CreatePodTelemetryDto) {
    const thresholds = await this.prisma.thresholds.findMany({
      where: { OR: [{ senior_id: seniorId }, { senior_id: null }] },
    });

    const getActiveThreshold = (metric: string) => {
      const personal = thresholds.find((t) => t.metric === metric && t.senior_id === seniorId);
      const global = thresholds.find((t) => t.metric === metric && t.senior_id === null);
      return personal || global;
    };

    // Evaluate Temperature
    const tempThreshold = getActiveThreshold('TEMPERATURE');
    if (tempThreshold) {
      if (tempThreshold.max_value && dto.temperature > Number(tempThreshold.max_value)) {
        await this.triggerAlert(seniorId, 'High Temperature Alert', `Room temperature is ${dto.temperature}°C.`);
      }
      if (tempThreshold.min_value && dto.temperature < Number(tempThreshold.min_value)) {
        await this.triggerAlert(seniorId, 'Low Temperature Alert', `Room temperature is ${dto.temperature}°C.`);
      }
    }

    // // Evaluate Air Quality (Gas Resistance)
    // // Lower resistance = Higher VOCs (Worse Air)
    // const gasThreshold = getActiveThreshold('GAS_RESISTANCE');
    // if (gasThreshold && gasThreshold.min_value && dto.gasResistance && dto.gasResistance < Number(gasThreshold.min_value)) {
    //   await this.triggerAlert(seniorId, 'Poor Air Quality', `High VOC levels detected. Please ventilate the room.`);
    // }

    // Evaluate Air Quality Score (0-100%)
    // Alert if score drops below the minimum (e.g., 50%)
    const airThreshold = getActiveThreshold('AIR_QUALITY_PERCENT');
    if (airThreshold && airThreshold.min_value && dto.airQualityScore && dto.airQualityScore < Number(airThreshold.min_value)) {
      await this.triggerAlert(seniorId, 'Poor Air Quality', `Air quality has dropped to ${dto.airQualityScore.toFixed(0)}%. Please ventilate the room.`);
    }
  }

  /**
   * Creates an Alert in the database
   */
  private async triggerAlert(seniorId: string, title: string, message: string) {
    // 1. Check if there is already an ACTIVE alert with this exact title for this senior
    const existingAlert = await this.prisma.alerts.findFirst({
      where: {
        senior_id: seniorId,
        title: title,
        status: 'ACTIVE',
      },
    });

    // 2. Only create a new alert if one doesn't already exist
    // This prevents spamming the caregiver every 30 seconds.
    if (!existingAlert) {
      this.logger.warn(`ALERT TRIGGERED for Senior ${seniorId}: ${title}`);
      await this.prisma.alerts.create({
        data: {
          senior_id: seniorId,
          title: title,
          message: message,
          status: 'ACTIVE',
        },
      });
    } else {
      this.logger.debug(`Alert [${title}] is already ACTIVE. Skipping duplicate.`);
    }
  }
}
