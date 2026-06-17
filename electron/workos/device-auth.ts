export type DeviceAuthStart = {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  expiresIn: number;
  interval: number;
};

export type DeviceAuthPollResult =
  | { kind: "pending" }
  | {
      kind: "authorized";
      accessToken: string;
      refreshToken: string;
      expiresIn: number;
      email: string;
      organizationId?: string;
      organizationName?: string;
    }
  | { kind: "denied"; reason: string };

export type WorkOsDeviceAuthAdapter = {
  start(): Promise<DeviceAuthStart>;
  poll(deviceCode: string): Promise<DeviceAuthPollResult>;
};

export class WorkOsDeviceAuthFlow {
  constructor(private readonly adapter: WorkOsDeviceAuthAdapter) {}

  start(): Promise<DeviceAuthStart> {
    return this.adapter.start();
  }

  poll(deviceCode: string): Promise<DeviceAuthPollResult> {
    return this.adapter.poll(deviceCode);
  }
}
