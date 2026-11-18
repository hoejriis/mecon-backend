import type { components } from './schema.gen';

type S = components['schemas'];
export type Session = S['Session'];
export type CapabilityState = S['CapabilityState'];
export type Capabilities = S['Session']['capabilities'];
export type Device = S['Device'];
export type DeviceList = components['schemas']['DeviceList'];
export type Health = S['Health'];
export type LoginStarted = S['LoginStarted'];
export type LoginState = S['LoginState'];
export type ApiErrorBody = S['Error'];
