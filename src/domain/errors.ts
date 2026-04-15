export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

export class FatalLLMError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FatalLLMError";
  }
}

export class TransientLLMError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TransientLLMError";
  }
}
