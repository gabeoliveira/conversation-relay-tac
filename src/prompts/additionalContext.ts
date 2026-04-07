export function getAdditionalContext(): string {
  const now = new Date();
  return `Current date and time: ${now.toISOString()}`;
}
