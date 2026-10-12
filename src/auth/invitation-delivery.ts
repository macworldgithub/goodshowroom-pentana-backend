// Return provider codes and actionable guidance, never raw provider errors or secrets.
export function invitationDeliveryFailure(error: { code?: string; status?: number }) {
  const errorCode = error.code && /^[a-z_]{1,80}$/.test(error.code) ? error.code : 'email_delivery_failed';
  const guidance: Record<string, string> = {
    email_exists: 'This email already has an account. Sign in and accept the invitation, or use password recovery to set a password.',
    user_already_exists: 'This email already has an account. Sign in and accept the invitation, or use password recovery to set a password.',
    email_address_not_authorized: 'Supabase does not allow email delivery to this address with its default mail service. Configure custom SMTP in Supabase.',
    over_email_send_rate_limit: 'Supabase email rate limit reached. Wait before retrying or configure custom SMTP and review email limits.',
    over_request_rate_limit: 'Supabase request rate limit reached. Wait before retrying.',
    email_provider_disabled: 'Email authentication is disabled in Supabase. Enable the email provider.',
    not_admin: 'Supabase rejected the backend administrative key. Check its server-only secret/service-role key.',
    unexpected_failure: 'Supabase could not send the email. Check Supabase Auth logs and SMTP configuration for the underlying cause.',
  };
  return { errorCode, providerStatus: error.status,
    message: guidance[errorCode] ?? 'Supabase rejected email delivery. Check Supabase Auth logs using the returned errorCode and providerStatus.' };
}
