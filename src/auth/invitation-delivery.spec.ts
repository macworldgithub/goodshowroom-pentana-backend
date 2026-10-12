import { invitationDeliveryFailure } from './invitation-delivery.js';

describe('Invitation delivery diagnostics', () => {
  it('distinguishes existing identities from email delivery restrictions', () => {
    expect(invitationDeliveryFailure({ code: 'email_exists', status: 422 }).message).toContain('password recovery');
    expect(invitationDeliveryFailure({ code: 'email_address_not_authorized', status: 400 }).message).toContain('custom SMTP');
    expect(invitationDeliveryFailure({ code: 'over_email_send_rate_limit', status: 429 }).message).toContain('rate limit');
  });

  it('keeps useful diagnostics without exposing raw provider error details', () => {
    const error = { code: 'unexpected_failure', status: 500, message: 'SMTP password: secret-value' };
    const failure = invitationDeliveryFailure(error);
    expect(failure.errorCode).toBe('unexpected_failure');
    expect(failure.providerStatus).toBe(500);
    expect(JSON.stringify(failure)).not.toContain('secret-value');
    expect(invitationDeliveryFailure({ code: 'secret-value-in-code' }).errorCode).toBe('email_delivery_failed');
  });
});
