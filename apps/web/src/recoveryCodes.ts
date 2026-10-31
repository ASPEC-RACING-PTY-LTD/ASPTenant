/**
 * File name for a person's saved recovery codes: their initials and the first label of the
 * host, for example Ali Saied on apt.aspecracing.com.au gives "as-apt-recovery-codes.txt".
 */
export function recoveryCodesFileName(
  displayName: string | null | undefined,
  email: string,
  hostname: string,
): string {
  const source = displayName?.trim() || email.split('@')[0] || '';
  const words = source.split(/[\s._-]+/).filter(Boolean);
  const first = words[0]?.[0] ?? '';
  const last = words.length > 1 ? (words[words.length - 1]?.[0] ?? '') : '';
  const initials = `${first}${last}`.toLowerCase().replace(/[^a-z0-9]/g, '');
  const prefix = (hostname.split('.')[0] ?? '').toLowerCase().replace(/[^a-z0-9-]/g, '');
  return `${[initials, prefix].filter(Boolean).join('-') || 'account'}-recovery-codes.txt`;
}

export function recoveryCodesText(codes: string[], email: string, host: string): string {
  return [
    `Recovery codes for ${email} on ${host}`,
    `Saved ${new Date().toLocaleString()}`,
    '',
    'Each code signs you in once if you lose access to your authenticator app.',
    'Keep this file somewhere safe. New codes replace all of these.',
    '',
    ...codes,
    '',
  ].join('\r\n');
}

/** Saves the codes as a .txt file through the browser's download. */
export function downloadRecoveryCodes(
  codes: string[],
  displayName: string | null | undefined,
  email: string,
): void {
  const { hostname, host } = window.location;
  const blob = new Blob([recoveryCodesText(codes, email, host)], {
    type: 'text/plain;charset=utf-8',
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = recoveryCodesFileName(displayName, email, hostname);
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
