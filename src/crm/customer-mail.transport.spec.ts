import { CustomerMailTransport } from './customer-mail.transport.js';
import { sourceCustomer, customerInput } from '../integration/validation.js';
const mocks = vi.hoisted(() => ({ createTransport: vi.fn(), sendMail: vi.fn(), close: vi.fn() }));
vi.mock('nodemailer', () => ({ default: { createTransport: mocks.createTransport } }));
describe('Customer SMTP transport', () => {
  const transport = new CustomerMailTransport();
  beforeEach(() => {
    vi.stubEnv('MESSAGE_TRANSPORT', 'smtp'); vi.stubEnv('SMTP_HOST', 'mail.example.test');
    vi.stubEnv('SMTP_PORT', '587'); vi.stubEnv('SMTP_FROM', 'showroom@example.test');
    vi.stubEnv('SMTP_USER', 'smtp-user'); vi.stubEnv('SMTP_PASSWORD', 'test-only');
    vi.stubEnv('NODE_ENV', 'test'); vi.stubEnv('ALLOW_SIMULATED_INTEGRATION', 'true');
    vi.clearAllMocks();
    mocks.createTransport.mockReturnValue({ sendMail: mocks.sendMail, close: mocks.close });
    mocks.sendMail.mockResolvedValue({ accepted: ['customer@example.test'], messageId: 'provider-message-id' });
  });
  afterEach(() => vi.unstubAllEnvs());
  it('uses mandatory validated TLS and a single server-controlled envelope, recording acceptance only', async () => {
    const result = await transport.send('message-id', 'customer@example.test', 'Update', 'Plain text');
    expect(result).toEqual({ outcome: 'accepted', providerId: 'provider-message-id' });
    expect(mocks.createTransport).toHaveBeenCalledWith(expect.objectContaining({ requireTLS: true, secure: false, tls: { rejectUnauthorized: true } }));
    expect(mocks.sendMail).toHaveBeenCalledWith(expect.objectContaining({ envelope: { from: 'showroom@example.test', to: ['customer@example.test'] }, disableFileAccess: true, disableUrlAccess: true }));
    expect(mocks.close).toHaveBeenCalledTimes(1);
  });
  it('uses implicit TLS on port 465', async () => {
    vi.stubEnv('SMTP_PORT', '465');
    await transport.send('id', 'customer@example.test', 'Update', 'Text');
    expect(mocks.createTransport).toHaveBeenCalledWith(expect.objectContaining({ secure: true, port: 465, tls: { rejectUnauthorized: true } }));
  });
  it('treats network/SMTP data failures as uncertain without exposing diagnostics', async () => {
    mocks.sendMail.mockRejectedValue({ code: 'ETIMEDOUT', message: 'Sensitive server detail' });
    expect(await transport.send('id', 'customer@example.test', 'Update', 'Text')).toEqual({ outcome: 'unknown', errorCode: 'SMTP_UNCERTAIN' });
    mocks.sendMail.mockRejectedValue({ code: 'EAUTH' });
    expect(await transport.send('id', 'customer@example.test', 'Update', 'Text')).toEqual({ outcome: 'rejected', errorCode: 'SMTP_REJECTED' });
  });
  it('fails closed for disabled or invalid configuration', async () => {
    vi.stubEnv('MESSAGE_TRANSPORT', 'disabled'); expect(() => transport.assertReady()).toThrow();
    vi.stubEnv('MESSAGE_TRANSPORT', 'smtp'); vi.stubEnv('SMTP_PORT', 'NaN'); expect(() => transport.assertReady()).toThrow();
    vi.stubEnv('SMTP_PORT', '587'); vi.stubEnv('SMTP_PASSWORD', ''); expect(() => transport.assertReady()).toThrow();
    expect(mocks.createTransport).not.toHaveBeenCalled();
  });
  it('simulates without network and disallows production simulation', async () => {
    vi.stubEnv('MESSAGE_TRANSPORT', 'simulated');
    expect(await transport.send('id', 'customer@example.test', 'Update', 'Text')).toEqual({ outcome: 'accepted', providerId: 'simulated-email-id' });
    expect(mocks.createTransport).not.toHaveBeenCalled();
    vi.stubEnv('NODE_ENV', 'production'); expect(() => transport.assertReady()).toThrow();
  });
  it('rejects address lists and header injection before creating an SMTP connection', async () => {
    await expect(transport.send('id', 'customer@example.test,other', 'Update', 'Text')).rejects.toThrow();
    await expect(transport.send('id', 'customer@example.test', 'Update\r\nBcc: other@example.test', 'Text')).rejects.toThrow();
    expect(() => customerInput({ firstName: 'A', lastName: 'B', email: 'customer@example.test,other' })).toThrow();
    expect(mocks.createTransport).not.toHaveBeenCalled();
  });
  it('requires complete validated source privacy rather than inferring consent', () => {
    const record = { external_id: 'source', revision: '1', observed_at: '2026-10-13T00:00:00Z', first_name: 'Test', last_name: 'Customer', email: 'customer@example.test' };
    expect(sourceCustomer(record).privacy).toBeUndefined();
    expect(() => sourceCustomer({ ...record, privacy: { email: 'granted' } })).toThrow();
  });
});
