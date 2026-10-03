import { TelemetryController } from './telemetry.controller';
import { EventType } from './dto/create-telemetry.dto';

describe('TelemetryController', () => {
  const telemetryService = {
    processPodTelemetry: jest.fn(),
    processWearableTelemetry: jest.fn(),
  };

  let controller: TelemetryController;

  beforeEach(() => {
    jest.clearAllMocks();
    controller = new TelemetryController(telemetryService as any);
  });

  it('delegates HTTP Pod telemetry to TelemetryService', async () => {
    telemetryService.processPodTelemetry.mockResolvedValue({
      success: true,
      readingId: 'reading-1',
    });
    const dto = {
      deviceId: '11111111-1111-4111-8111-111111111111',
      temperature: 22.5,
      humidity: 45,
    };

    await expect(controller.receivePodData(dto)).resolves.toEqual({
      success: true,
      readingId: 'reading-1',
    });
    expect(telemetryService.processPodTelemetry).toHaveBeenCalledWith(dto);
  });

  it('delegates HTTP wearable telemetry to TelemetryService', async () => {
    telemetryService.processWearableTelemetry.mockResolvedValue({
      success: true,
      eventId: 'event-1',
    });
    const dto = {
      deviceId: '33333333-3333-4333-8333-333333333333',
      eventType: EventType.FALL,
    };

    await expect(controller.receiveWearableData(dto)).resolves.toEqual({
      success: true,
      eventId: 'event-1',
    });
    expect(telemetryService.processWearableTelemetry).toHaveBeenCalledWith(dto);
  });

  it('parses a string Pod MQTT payload before processing', async () => {
    const payload = {
      deviceId: '11111111-1111-4111-8111-111111111111',
      temperature: 23,
      humidity: 50,
    };

    await controller.handlePodMqtt(JSON.stringify(payload));

    expect(telemetryService.processPodTelemetry).toHaveBeenCalledWith(payload);
  });

  it('accepts an object Pod MQTT payload', async () => {
    const payload = {
      deviceId: '11111111-1111-4111-8111-111111111111',
      temperature: 23,
      humidity: 50,
    };

    await controller.handlePodMqtt(payload);

    expect(telemetryService.processPodTelemetry).toHaveBeenCalledWith(payload);
  });

  it('does not crash on malformed Pod MQTT JSON', async () => {
    await expect(controller.handlePodMqtt('{bad json')).resolves.toBeUndefined();
    expect(telemetryService.processPodTelemetry).not.toHaveBeenCalled();
  });

  it('parses a wearable MQTT FALL payload', async () => {
    const payload = {
      deviceId: '33333333-3333-4333-8333-333333333333',
      eventType: 'FALL',
      timestamp: '2026-10-03T19:30:00.000Z',
    };

    await controller.handleWearableMqtt(JSON.stringify(payload));

    expect(telemetryService.processWearableTelemetry).toHaveBeenCalledWith(payload);
  });

  it('does not crash on malformed wearable MQTT JSON', async () => {
    await expect(controller.handleWearableMqtt('{bad json')).resolves.toBeUndefined();
    expect(telemetryService.processWearableTelemetry).not.toHaveBeenCalled();
  });
});
