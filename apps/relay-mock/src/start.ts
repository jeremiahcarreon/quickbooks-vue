import { RelayMock, type RelayMockOptions } from './server.js';

export interface StartedRelayMock {
  mock: RelayMock;
  url: string;
  port: number;
  close(): Promise<void>;
}

/**
 * Start a relay mock on a free port (or `port`). Intended for tests of other
 * workspaces: `const relay = await startRelayMock({ seed: true }); ... relay.url`.
 */
export async function startRelayMock(
  opts: RelayMockOptions & { port?: number; host?: string } = {},
): Promise<StartedRelayMock> {
  const mock = new RelayMock(opts);
  const { url, port } = await mock.listen(opts.port ?? 0, opts.host ?? '127.0.0.1');
  return { mock, url, port, close: () => mock.close() };
}
