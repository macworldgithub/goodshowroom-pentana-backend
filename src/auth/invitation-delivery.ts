// Return actionable guidance for email delivery failures, never raw provider errors or secrets.
export function invitationDeliveryFailure(error: { code?: string; status?: number }) {
  const errorCode = error.code && /^[a-z_]{1,80}$/.test(error.code) ? error.code : 'email_delivery_failed';
  const guidance: Record<string, string> = {
    email_exists: 'This email already has an account. Sign in and accept the invitation, or use password recovery to set a password.',
    user_already_exists: 'This email already has an account. Sign in and accept the invitation, or use password recovery to set a password.',
    email_address_not_authorized: 'Email delivery to this address is not authorised. Check your SMTP configuration and allowed sender domains.',
    over_email_send_rate_limit: 'Email rate limit reached. Wait before retrying or review your SMTP provider limits.',
    over_request_rate_limit: 'Request rate limit reached. Wait before retrying.',
    email_provider_disabled: 'Email delivery is disabled. Check your SMTP configuration.',
    unexpected_failure: 'Could not send the email. Check your SMTP server configuration and logs.',
  };
  return { errorCode, providerStatus: error.status,
    message: guidance[errorCode] ?? 'Email delivery failed. Check your SMTP configuration using the returned errorCode and providerStatus.' };
}
