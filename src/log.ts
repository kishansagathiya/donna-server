const PREFIX = '[donna-server]';

export function log(message: string, data?: Record<string, unknown>): void {
  if (data) {
    console.log(PREFIX, message, data);
  } else {
    console.log(PREFIX, message);
  }
}

export function logWarn(message: string, data?: Record<string, unknown>): void {
  if (data) {
    console.warn(PREFIX, message, data);
  } else {
    console.warn(PREFIX, message);
  }
}

export function shortId(id: string): string {
  return id.slice(0, 8);
}
