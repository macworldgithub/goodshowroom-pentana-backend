import { IntegrationConfig } from './integration.config.js';
import { customerInput, sourceCustomer, commandResult } from './validation.js';
import { BadRequestException } from '@nestjs/common';

describe('Integration modes and source contracts', () => {
  afterEach(() => vi.unstubAllEnvs());
  it('defaults to disabled with no implicit simulation', () => {
    vi.stubEnv('INTEGRATION_MODE', undefined);
    const config = new IntegrationConfig(); config.onModuleInit();
    expect(config.mode).toBe('disabled'); expect(config.writesEnabled).toBe(false);
  });
  it.each(['production', 'development'])('rejects non-opted-in simulation in %s', env => {
    vi.stubEnv('NODE_ENV', env); vi.stubEnv('INTEGRATION_MODE', 'simulated'); vi.stubEnv('ALLOW_SIMULATED_INTEGRATION', 'false');
    expect(() => new IntegrationConfig().onModuleInit()).toThrow();
  });
  it('rejects simulation in production even with opt-in', () => {
    vi.stubEnv('NODE_ENV', 'production'); vi.stubEnv('INTEGRATION_MODE', 'simulated'); vi.stubEnv('ALLOW_SIMULATED_INTEGRATION', 'true');
    expect(() => new IntegrationConfig().onModuleInit()).toThrow();
  });
  it('explicitly labels opted-in development simulation', () => {
    vi.stubEnv('NODE_ENV', 'development'); vi.stubEnv('INTEGRATION_MODE', 'simulated'); vi.stubEnv('ALLOW_SIMULATED_INTEGRATION', 'true');
    const config = new IntegrationConfig(); config.onModuleInit();
    expect(config.info().simulated).toBe(true); expect(config.writesEnabled).toBe(true);
  });
  it('requires write opt-in for scraping and reports its external transport', () => {
    vi.stubEnv('INTEGRATION_MODE', 'scraping'); vi.stubEnv('INTEGRATION_WRITES_ENABLED', 'false');
    const config = new IntegrationConfig(); config.onModuleInit();
    expect(config.writesEnabled).toBe(false); expect(config.info().transport).toBe('external_scraping_runner');
    vi.stubEnv('INTEGRATION_WRITES_ENABLED', 'true'); config.onModuleInit(); expect(config.writesEnabled).toBe(true);
  });
  it('rejects unsupported modes', () => {
    vi.stubEnv('INTEGRATION_MODE', 'pentana'); expect(() => new IntegrationConfig().onModuleInit()).toThrow();
  });
  it('normalizes contacts and rejects invalid source timestamps and unconfirmed outcomes', () => {
    expect(customerInput({ firstName: ' Test ', lastName: ' Customer ', email: 'TEST@example.test' })).toEqual({ first_name: 'Test', last_name: 'Customer', email: 'test@example.test', phone: null });
    expect(() => customerInput({ firstName: 'Test', lastName: 'Customer' })).toThrow(BadRequestException);
    expect(() => sourceCustomer({ first_name: 'Test', last_name: 'Customer', email: 'test@example.test', external_id: '123', revision: '1', observed_at: 'bad-date' })).toThrow(BadRequestException);
    expect(() => commandResult({ outcome: 'accepted' })).toThrow(BadRequestException);
    expect(() => commandResult({ outcome: 'succeeded' })).toThrow(BadRequestException);
    expect(() => commandResult({ outcome: 'unknown' })).toThrow(BadRequestException);
  });
});
