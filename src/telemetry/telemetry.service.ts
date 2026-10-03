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

    if (!device) {
      throw new NotFoundException(`Device ${dto.deviceId} not found`);
    }

    let recordTime = new Date();
    let reading: { id: string } | null = null;

    if (dto.timestamp) {
      recordTime = new Date(dto.timestamp);
      if (Number.isNaN(recordTime.getTime())) {
        throw new Error(`Invalid Pod timestamp: ${dto.timestamp}`);
      }

      // MQTT brokers can redeliver the same message more than once and those
      // deliveries can arrive concurrently. A plain findFirst() + create()
      // check is vulnerable to a race where both requests see no existing row.
      // The PostgreSQL transaction-scoped advisory lock serializes processing
      // for this exact device/timestamp key across backend requests/instances.
      const dedupeKey = `pod:${device.id}:${recordTime.toISOString()}`;

      const result = await this.prisma.$transaction(async (tx) => {
        await tx.$executeRaw`
          SELECT pg_advisory_xact_lock(hashtext(${dedupeKey})::bigint)
        `;

        const existingReading = await tx.environmental_readings.findFirst({
          where: {
            device_id: device.id,
            recorded_at: recordTime,
          },
        });

        if (existingReading) {
          return { duplicate: true as const, reading: null };
        }

        const created = await tx.environmental_readings.create({
          data: {
            device_id: device.id,
            temperature: dto.temperature,
            humidity: dto.humidity,
            gas_resistance: dto.gasResistance,
            air_quality_score: dto.airQualityScore,
            occupancy: dto.occupancy ?? false,
            recorded_at: recordTime,
          },
        });

        return { duplicate: false as const, reading: created };
      });

      if (result.duplicate) {
        this.logger.debug(
          `[DEDUPE] Ignored duplicate Pod payload from ${dto.timestamp}`,
        );
        return { success: true, duplicate: true };
      }

      reading = result.reading;
    } else {
      reading = await this.prisma.environmental_readings.create({
        data: {
          device_id: device.id,
          temperature: dto.temperature,
          humidity: dto.humidity,
          gas_resistance: dto.gasResistance,
          air_quality_score: dto.airQualityScore,
          occupancy: dto.occupancy ?? false,
          recorded_at: recordTime,
        },
      });
    }

    this.logger.log(`Processing telemetry for device: ${dto.deviceId}`);

    if (device.senior_id) {
      await this.evaluateThresholds(device.senior_id, dto);
    }

    return { success: true, readingId: reading!.id };
  }

  async processWearableTelemetry(dto: CreateWearableTelemetryDto) {
    this.logger.log(
      `Received wearable event [${dto.eventType}] for device: ${dto.deviceId}`,
    );

    const device = await this.prisma.devices.findUnique({
      where: { id: dto.deviceId },
      select: { id: true, senior_id: true },
    });

    if (!device) {
      throw new NotFoundException(`Device ${dto.deviceId} not found`);
    }

    let recordTime = new Date();
    let event: { id: string } | null = null;

    if (dto.timestamp) {
      recordTime = new Date(dto.timestamp);
      if (Number.isNaN(recordTime.getTime())) {
        throw new Error(`Invalid wearable timestamp: ${dto.timestamp}`);
      }

      const dedupeKey = `wearable:${device.id}:${dto.eventType}:${recordTime.toISOString()}`;

      const result = await this.prisma.$transaction(async (tx) => {
        await tx.$executeRaw`
          SELECT pg_advisory_xact_lock(hashtext(${dedupeKey})::bigint)
        `;

        const existingEvent = await tx.activity_events.findFirst({
          where: {
            device_id: device.id,
            type: dto.eventType as any,
            recorded_at: recordTime,
          },
        });

        if (existingEvent) {
          return { duplicate: true as const, event: null };
        }

        const created = await tx.activity_events.create({
          data: {
            device_id: device.id,
            type: dto.eventType as any,
            recorded_at: recordTime,
          },
        });

        return { duplicate: false as const, event: created };
      });

      if (result.duplicate) {
        this.logger.debug(
          `[DEDUPE] Ignored duplicate wearable event [${dto.eventType}] from ${dto.timestamp}`,
        );

        return {
          success: true,
          duplicate: true,
          receivedTimestamp: dto.timestamp,
          matchedTimestamp: recordTime.toISOString(),
        };
      }

      event = result.event;
    } else {
      event = await this.prisma.activity_events.create({
        data: {
          device_id: device.id,
          type: dto.eventType as any,
          recorded_at: recordTime,
        },
      });
    }

    if (device.senior_id) {
      if (dto.eventType === 'FALL') {
        await this.triggerAlert(
          device.senior_id,
          '🚨 CRITICAL: Fall Detected',
          'Sudden impact and orientation change detected. Immediate check required.',
        );
      } else if (dto.eventType === 'PANIC') {
        // PANIC remains supported as a software/API event type. The physical
        // wearable prototype itself does not contain a panic button.
        await this.triggerAlert(
          device.senior_id,
          '🆘 EMERGENCY: Panic Button',
          'Senior pressed the emergency panic button.',
        );
      }
    }

    return {
      success: true,
      duplicate: false,
      eventId: event!.id,
      receivedTimestamp: dto.timestamp ?? null,
      storedTimestamp: recordTime.toISOString(),
    };
  }

  private async evaluateThresholds(
    seniorId: string,
    dto: CreatePodTelemetryDto,
  ) {
    const thresholds = await this.prisma.thresholds.findMany({
      where: { OR: [{ senior_id: seniorId }, { senior_id: null }] },
    });

    const getActiveThreshold = (metric: string) => {
      const personal = thresholds.find(
        (t) => t.metric === metric && t.senior_id === seniorId,
      );
      const global = thresholds.find(
        (t) => t.metric === metric && t.senior_id === null,
      );
      return personal || global;
    };

    const tempThreshold = getActiveThreshold('TEMPERATURE');
    if (tempThreshold) {
      if (
        tempThreshold.max_value &&
        dto.temperature > Number(tempThreshold.max_value)
      ) {
        await this.triggerAlert(
          seniorId,
          'High Temperature Alert',
          `Room temperature is ${dto.temperature}°C.`,
        );
      }
      if (
        tempThreshold.min_value &&
        dto.temperature < Number(tempThreshold.min_value)
      ) {
        await this.triggerAlert(
          seniorId,
          'Low Temperature Alert',
          `Room temperature is ${dto.temperature}°C.`,
        );
      }
    }

    const airThreshold = getActiveThreshold('AIR_QUALITY_PERCENT');
    if (
      airThreshold &&
      airThreshold.min_value &&
      dto.airQualityScore !== undefined &&
      dto.airQualityScore !== null &&
      dto.airQualityScore < Number(airThreshold.min_value)
    ) {
      await this.triggerAlert(
        seniorId,
        'Poor Air Quality',
        `Air quality has dropped to ${dto.airQualityScore.toFixed(0)}%. Please ventilate the room.`,
      );
    }
  }

  private async triggerAlert(
    seniorId: string,
    title: string,
    message: string,
  ) {
    const existingAlert = await this.prisma.alerts.findFirst({
      where: {
        senior_id: seniorId,
        title,
        status: 'ACTIVE',
      },
    });

    if (!existingAlert) {
      this.logger.warn(`ALERT TRIGGERED for Senior ${seniorId}: ${title}`);
      await this.prisma.alerts.create({
        data: {
          senior_id: seniorId,
          title,
          message,
          status: 'ACTIVE',
        },
      });
    } else {
      this.logger.debug(`Alert [${title}] is already ACTIVE. Skipping duplicate.`);
    }
  }
}
