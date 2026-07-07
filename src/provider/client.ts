import axios, { AxiosError } from "axios";

export interface ProviderRequest {
  requestId: string;
  amount: number;
  currency: string;
  recipient: string;
}

export interface ProviderResponse {
  providerReference: string;
  status: "SUCCESS" | "FAILED";
}

export class ProviderRejectionError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "ProviderRejectionError";
  }
}

export class ProviderTimeoutError extends Error {
  constructor() {
    super("Provider request timed out");
    this.name = "ProviderTimeoutError";
  }
}

export class ProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderError";
  }
}

export async function submitToProvider(req: ProviderRequest): Promise<ProviderResponse> {
  const baseUrl = process.env.PROVIDER_URL || "http://localhost:4000";
  const timeoutMs = parseInt(process.env.PROVIDER_TIMEOUT_MS || "5000", 10);

  try {
    const { data } = await axios.post<ProviderResponse>(
      `${baseUrl}/provider/payments`,
      req,
      { timeout: timeoutMs }
    );
    return data;
  } catch (err) {
    const axiosErr = err as AxiosError;
    if (axiosErr.code === "ECONNABORTED" || axiosErr.code === "ETIMEDOUT") {
      throw new ProviderTimeoutError();
    }
    if (axiosErr.response?.status === 422) {
      const body = axiosErr.response.data as { error: string; message: string };
      throw new ProviderRejectionError(body.error, body.message);
    }
    throw new ProviderError(axiosErr.message);
  }
}
