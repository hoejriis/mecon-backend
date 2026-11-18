import { ApiError, createApiClient } from './client';
import { createBackend, fx, json } from '../test/backend';

describe('api client', () => {
  it('uses the same-origin base, credentials and parses the Error body', async () => {
    const b = createBackend();
    b.on('GET /devices', json(fx.error401, 401));
    const onUnauthorized = vi.fn();
    const client = createApiClient({ fetchImpl: b.fetchMock as unknown as typeof fetch, onUnauthorized });
    const err = await client.listDevices().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({
      status: 401,
      code: 'unauthenticated',
      requestId: 'req_synthetic_401',
      retryable: false,
      message: 'Sign in to continue.',
    });
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
    expect(b.fetchMock.mock.calls[0]![0]).toBe('/api/reader/v1/devices');
    expect(b.fetchMock.mock.calls[0]![1]).toMatchObject({ credentials: 'same-origin' });
  });

  it('survives a non-JSON error body', async () => {
    const b = createBackend();
    b.on('GET /health', () => new Response('<html>bad gateway</html>', { status: 502 }));
    const client = createApiClient({ fetchImpl: b.fetchMock as unknown as typeof fetch });
    await expect(client.getHealth()).rejects.toMatchObject({ status: 502, code: 'unknown' });
  });
});
