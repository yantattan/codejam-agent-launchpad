import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export interface AuthUser {
  id: string;
  email: string | null;
}

export interface UserVerifier {
  verify(accessToken: string): Promise<AuthUser | null>;
}

/**
 * Verifies a Supabase session token by asking Supabase's own Auth server
 * whose token it is. No JWT-signature handling on our side, so this keeps
 * working across Supabase's key-rotation and signing-algorithm changes.
 */
export class SupabaseUserVerifier implements UserVerifier {
  private readonly client: SupabaseClient;

  constructor(url: string, anonKey: string) {
    this.client = createClient(url, anonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }

  async verify(accessToken: string): Promise<AuthUser | null> {
    const { data, error } = await this.client.auth.getUser(accessToken);
    if (error || !data.user) {
      return null;
    }
    return { id: data.user.id, email: data.user.email ?? null };
  }
}

/** Used when SUPABASE_URL/SUPABASE_ANON_KEY are not set. Fails closed. */
export class UnconfiguredVerifier implements UserVerifier {
  async verify(): Promise<AuthUser | null> {
    return null;
  }
}
