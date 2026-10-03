import { NotFoundException } from '@nestjs/common';
import { TelemetryService } from './telemetry.service';
import { EventType } from './dto/create-telemetry.dto';

describe('TelemetryService', () => {
  let service: TelemetryService;

  const prisma = {
    devices: {
      findUnique: jest.fn(),
    },
    environmental_readings: {
      findFirst: jest.fn(),
      create: jest.fn(),
    },
    activity_events: {
      findFirst: jest.fn(),
      create: jest.fn(),
    },
    thresholds: {
      findMany: jest.fn(),
    },
    alerts: {
      findFirst: jest.fn(),
      create: jest.fn(),
    },
  };

  beforeEach(() => {
    jest.clearAllMocks();
    service = new TelemetryService(prisma as any);

    prisma.environmental_readings.findFirst.mockResolvedValue(null);
    prisma.activity_events.findFirst.mockResolvedValue(null);
    prisma.thresholds.findMany.mockResolvedValue([]);
    prisma.alerts.findFirst.mockResolvedValue(null);
    prisma.environmental_readings.create.mockResolvedValue({ id: 'reading-1' });
    prisma.activity_events.create.mockResolvedValue({ id: 'event-1' });
    prisma.alerts.create.mockResolvedValue({ id: 'alert-1' });
  });

  describe('processPodTelemetry', () => {
    const basePod = {
      deviceId: '11111111-1111-4111-8111-111111111111',
      temperature: 22.5,
      humidity: 45,
      gasResistance: 50000,
      airQualityScore: 75,
      occupancy: true,
    };

    it('rejects telemetry for an unknown Pod', async () => {
      prisma.devices.findUnique.mockResolvedValue(null);

      await expect(service.processPodTelemetry(basePod)).rejects.toBeInstanceOf(
        NotFoundException,
      );

      expect(prisma.environmental_readings.create).not.toHaveBeenCalled();
    });

    it('stores a normal Pod reading', async () => {
      prisma.devices.findUnique.mockResolvedValue({
        id: basePod.deviceId,
        senior_id: null,
      });

      const result = await service.processPodTelemetry(basePod);

      expect(result).toEqual({ success: true, readingId: 'reading-1' });
      expect(prisma.environmental_readings.create).toHaveBeenCalledTimes(1);
      expect(prisma.environmental_readings.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          device_id: basePod.deviceId,
          temperature: 22.5,
          humidity: 45,
          gas_resistance: 50000,
          air_quality_score: 75,
          occupancy: true,
        }),
      });
    });

    it('preserves a valid device timestamp', async () => {
      prisma.devices.findUnique.mockResolvedValue({
        id: basePod.deviceId,
        senior_id: null,
      });
      const timestamp = '2026-10-03T18:30:00.000Z';

      await service.processPodTelemetry({ ...basePod, timestamp });

      expect(prisma.environmental_readings.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          recorded_at: new Date(timestamp),
        }),
      });
    });

    it('deduplicates a Pod reading with the same device and timestamp', async () => {
      prisma.devices.findUnique.mockResolvedValue({
        id: basePod.deviceId,
        senior_id: null,
      });
      prisma.environmental_readings.findFirst.mockResolvedValue({ id: 'existing' });
      const timestamp = '2026-10-03T18:30:00.000Z';

      const result = await service.processPodTelemetry({ ...basePod, timestamp });

      expect(result).toEqual({ success: true, duplicate: true });
      expect(prisma.environmental_readings.create).not.toHaveBeenCalled();
    });

    it('creates a high-temperature alert when a threshold is exceeded', async () => {
      prisma.devices.findUnique.mockResolvedValue({
        id: basePod.deviceId,
        senior_id: '22222222-2222-4222-8222-222222222222',
      });
      prisma.thresholds.findMany.mockResolvedValue([
        {
          metric: 'TEMPERATURE',
          min_value: 18,
          max_value: 30,
          senior_id: null,
        },
      ]);

      await service.processPodTelemetry({ ...basePod, temperature: 31.5 });

      expect(prisma.alerts.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          senior_id: '22222222-2222-4222-8222-222222222222',
          title: 'High Temperature Alert',
          status: 'ACTIVE',
        }),
      });
    });

    it('creates a low-temperature alert when a threshold is crossed', async () => {
      prisma.devices.findUnique.mockResolvedValue({
        id: basePod.deviceId,
        senior_id: '22222222-2222-4222-8222-222222222222',
      });
      prisma.thresholds.findMany.mockResolvedValue([
        {
          metric: 'TEMPERATURE',
          min_value: 18,
          max_value: 30,
          senior_id: null,
        },
      ]);

      await service.processPodTelemetry({ ...basePod, temperature: 17 });

      expect(prisma.alerts.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          title: 'Low Temperature Alert',
        }),
      });
    });

    it('uses a personal temperature threshold instead of the global threshold', async () => {
      const seniorId = '22222222-2222-4222-8222-222222222222';
      prisma.devices.findUnique.mockResolvedValue({
        id: basePod.deviceId,
        senior_id: seniorId,
      });
      prisma.thresholds.findMany.mockResolvedValue([
        {
          metric: 'TEMPERATURE',
          min_value: 18,
          max_value: 25,
          senior_id: null,
        },
        {
          metric: 'TEMPERATURE',
          min_value: 17,
          max_value: 30,
          senior_id: seniorId,
        },
      ]);

      await service.processPodTelemetry({ ...basePod, temperature: 28 });

      expect(prisma.alerts.create).not.toHaveBeenCalled();
    });

    it('does not create a duplicate ACTIVE alert with the same title', async () => {
      prisma.devices.findUnique.mockResolvedValue({
        id: basePod.deviceId,
        senior_id: '22222222-2222-4222-8222-222222222222',
      });
      prisma.thresholds.findMany.mockResolvedValue([
        {
          metric: 'TEMPERATURE',
          min_value: 18,
          max_value: 30,
          senior_id: null,
        },
      ]);
      prisma.alerts.findFirst.mockResolvedValue({ id: 'already-active' });

      await service.processPodTelemetry({ ...basePod, temperature: 35 });

      expect(prisma.alerts.create).not.toHaveBeenCalled();
    });

    it('should alert when air quality score is 0 and the minimum is above 0', async () => {
      prisma.devices.findUnique.mockResolvedValue({
        id: basePod.deviceId,
        senior_id: '22222222-2222-4222-8222-222222222222',
      });
      prisma.thresholds.findMany.mockResolvedValue([
        {
          metric: 'AIR_QUALITY_PERCENT',
          min_value: 50,
          max_value: null,
          senior_id: null,
        },
      ]);

      await service.processPodTelemetry({ ...basePod, airQualityScore: 0 });

      expect(prisma.alerts.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ title: 'Poor Air Quality' }),
      });
    });
  });

  describe('processWearableTelemetry', () => {
    const wearableId = '33333333-3333-4333-8333-333333333333';
    const seniorId = '44444444-4444-4444-8444-444444444444';

    it('rejects events from an unknown wearable', async () => {
      prisma.devices.findUnique.mockResolvedValue(null);

      await expect(
        service.processWearableTelemetry({
          deviceId: wearableId,
          eventType: EventType.FALL,
        }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('stores normal movement without creating an alert', async () => {
      prisma.devices.findUnique.mockResolvedValue({
        id: wearableId,
        senior_id: seniorId,
      });

      const result = await service.processWearableTelemetry({
        deviceId: wearableId,
        eventType: EventType.REGULAR_MOVEMENT,
      });

      expect(result).toEqual(
        expect.objectContaining({ success: true, duplicate: false, eventId: 'event-1' }),
      );
      expect(prisma.activity_events.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          device_id: wearableId,
          type: EventType.REGULAR_MOVEMENT,
        }),
      });
      expect(prisma.alerts.create).not.toHaveBeenCalled();
    });

    it('stores a FALL event and creates a critical alert', async () => {
      prisma.devices.findUnique.mockResolvedValue({
        id: wearableId,
        senior_id: seniorId,
      });

      await service.processWearableTelemetry({
        deviceId: wearableId,
        eventType: EventType.FALL,
      });

      expect(prisma.activity_events.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ type: EventType.FALL }),
      });
      expect(prisma.alerts.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          senior_id: seniorId,
          title: '🚨 CRITICAL: Fall Detected',
          status: 'ACTIVE',
        }),
      });
    });

    it('deduplicates the same wearable event at the same timestamp', async () => {
      prisma.devices.findUnique.mockResolvedValue({
        id: wearableId,
        senior_id: seniorId,
      });
      prisma.activity_events.findFirst.mockResolvedValue({ id: 'existing-event' });
      const timestamp = '2026-10-03T19:00:00.000Z';

      const result = await service.processWearableTelemetry({
        deviceId: wearableId,
        eventType: EventType.FALL,
        timestamp,
      });

      expect(result).toEqual(
        expect.objectContaining({ success: true, duplicate: true, receivedTimestamp: timestamp }),
      );
      expect(prisma.activity_events.create).not.toHaveBeenCalled();
      expect(prisma.alerts.create).not.toHaveBeenCalled();
    });

    it('rejects an invalid wearable timestamp', async () => {
      prisma.devices.findUnique.mockResolvedValue({
        id: wearableId,
        senior_id: seniorId,
      });

      await expect(
        service.processWearableTelemetry({
          deviceId: wearableId,
          eventType: EventType.REGULAR_MOVEMENT,
          timestamp: 'not-a-date',
        }),
      ).rejects.toThrow('Invalid wearable timestamp');
    });
  });
});
