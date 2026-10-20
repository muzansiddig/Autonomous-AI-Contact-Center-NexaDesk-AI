export type AccessTokenProvider = () => Promise<string | null>;

export class AccessTokenError extends Error {
  constructor() {
    super("The current sign-in session cannot provide an API access token.");
    this.name = "AccessTokenError";
  }
}

export function notifyAuthenticationExpired(): void {
  window.dispatchEvent(new Event("nexadesk:auth-expired"));
}

let accessTokenProvider: AccessTokenProvider | null = null;

export function configureAccessTokenProvider(provider: AccessTokenProvider): void {
  accessTokenProvider = provider;
}

export async function getAccessToken(): Promise<string | null> {
  if (!accessTokenProvider) return null;
  try {
    return await accessTokenProvider();
  } catch {
    throw new AccessTokenError();
  }
}
