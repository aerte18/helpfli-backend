describe('rate limiter IPv6 safety', () => {
  const originalNodeEnv = process.env.NODE_ENV;

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
    jest.restoreAllMocks();
    jest.resetModules();
  });

  test('initializes production limiters without the unsafe IPv6 key warning', () => {
    process.env.NODE_ENV = 'production';
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});

    expect(() => require('../../middleware/rateLimiter')).not.toThrow();

    const output = consoleError.mock.calls.flat().map(String).join('\n');
    expect(output).not.toContain('ERR_ERL_KEY_GEN_IPV6');
  });
});
