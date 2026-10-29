export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: { field: string; message: string }[],
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export class StorageError extends AppError {
  constructor() {
    super(503, 'STORAGE_UNAVAILABLE', 'Payment storage is unavailable.');
    this.name = 'StorageError';
  }
}

export const unavailable = () =>
  new AppError(503, 'SERVICE_UNAVAILABLE', 'The service is not ready.');
