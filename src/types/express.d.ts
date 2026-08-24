declare global {
  namespace Express {
    interface Request {
      merchantId?: string;
    }
  }
}

export {};
