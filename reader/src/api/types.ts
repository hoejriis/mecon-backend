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
