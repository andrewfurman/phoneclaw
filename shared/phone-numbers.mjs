export function isAllowedCaller(fromNumber, allowedCallerNumbers) {
  const allowedNumbers = parseAllowedCallerNumbers(allowedCallerNumbers);
  if (allowedNumbers.length === 0) return true;
  return allowedNumbers.includes(normalizePhoneNumber(fromNumber));
}

export function parseAllowedCallerNumbers(value) {
  if (!value) return [];
  return value
    .split(/[,\s]+/)
    .map(normalizePhoneNumber)
    .filter(Boolean);
}

export function normalizePhoneNumber(value) {
  if (!value) return "";
  const digits = String(value).replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  if (String(value).trim().startsWith("+") && digits.length > 0) return `+${digits}`;
  return digits ? `+${digits}` : "";
}

export function lastFourDigits(value) {
  const digits = String(value || "").replace(/\D/g, "");
  return digits.slice(-4);
}
