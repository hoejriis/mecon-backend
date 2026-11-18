import type { components } from './schema.gen';
import type { components as obs } from './observations.gen';

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

export type Identity = S['Identity'];
export type IdentityList = S['IdentityList'];
export type Conversation = S['Conversation'];
export type ConversationList = S['ConversationList'];
export type Message = S['Message'];
export type MessageList = S['MessageList'];
export type Channel = S['Channel'];
export type ChannelList = S['ChannelList'];
export type Target = S['Target'];
export type SendRequest = S['SendRequest'];
export type SendAttempt = S['SendAttempt'];
export type SendStatus = S['SendStatus'];
export type EventEnvelope = S['EventEnvelope'];

export type LeasePayload = S['LeasePayload'];
export type LeaseOperation = S['LeaseOperation'];
export type LeaseIssued = S['LeaseIssued'];
export type LeaseKey = S['LeaseKey'];
export type LeaseKeyList = S['LeaseKeyList'];

// Live observation API (authorized projection), contracts/observations/v1.
export type Observer = obs['schemas']['Observer'];
export type ObserverList = obs['schemas']['ObserverList'];
export type ObserverLocation = obs['schemas']['Location'];
export type ObserverFreshness = obs['schemas']['Freshness'];
export type Reception = obs['schemas']['Reception'];
export type ObservationSnapshot = obs['schemas']['Snapshot'];
export type ObservationEvent = obs['schemas']['ObservationEvent'];
