import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyRequest } from 'fastify';
import type { JWTPayload } from 'jose';
import type { AuthenticatedUser } from './authenticated-user';
import { IS_PUBLIC_KEY } from './public.decorator';

type AuthenticatedRequest = FastifyRequest & { user?: AuthenticatedUser };
type RemoteJwkSet = ReturnType<(typeof import('jose'))['createRemoteJWKSet']>;

@Injectable()
export class SupabaseAuthGuard implements CanActivate {
  private readonly reflector: Reflector;
  private readonly supabaseUrl: string;
  private readonly supabaseKey: string;
  private readonly issuer: string;
  private jwks: RemoteJwkSet | null = null;

  constructor(reflector: Reflector) {
    this.reflector = reflector;
    this.supabaseUrl = process.env.SUPABASE_URL?.replace(/\/$/, '') ?? '';
    this.supabaseKey =
      process.env.SUPABASE_ANON_KEY ?? process.env.SUPABASE_KEY ?? '';
    this.issuer = `${this.supabaseUrl}/auth/v1`;
  }

  async canActivate(context: ExecutionContext) {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isPublic) {
      return true;
    }

    if (!this.supabaseUrl || !this.supabaseKey) {
      throw new UnauthorizedException('Authentication is not configured');
    }

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const authorization = request.headers.authorization;

    if (!authorization?.startsWith('Bearer ')) {
      throw new UnauthorizedException('Missing bearer token');
    }

    const token = authorization.slice('Bearer '.length).trim();

    try {
      const { createRemoteJWKSet, decodeProtectedHeader, jwtVerify } =
        await import('jose');
      const header = decodeProtectedHeader(token);
      if (!this.jwks) {
        this.jwks = createRemoteJWKSet(
          new URL(`${this.issuer}/.well-known/jwks.json`),
        );
      }
      const claims =
        header.alg === 'HS256'
          ? await this.verifyWithAuthServer(token)
          : (
              await jwtVerify(token, this.jwks, {
                issuer: this.issuer,
              })
            ).payload;

      request.user = this.toAuthenticatedUser(claims);
      return true;
    } catch {
      throw new UnauthorizedException('Invalid or expired access token');
    }
  }

  private async verifyWithAuthServer(token: string): Promise<JWTPayload> {
    const response = await fetch(`${this.issuer}/user`, {
      headers: {
        apikey: this.supabaseKey,
        Authorization: `Bearer ${token}`,
      },
      signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) {
      throw new Error('Token rejected by Supabase');
    }

    const user = (await response.json()) as {
      id?: string;
      email?: string;
      user_metadata?: Record<string, unknown>;
    };

    return {
      sub: user.id,
      email: user.email,
      user_metadata: user.user_metadata,
    };
  }

  private toAuthenticatedUser(claims: JWTPayload): AuthenticatedUser {
    if (!claims.sub) {
      throw new Error('Token does not contain a subject');
    }

    const metadata =
      claims.user_metadata && typeof claims.user_metadata === 'object'
        ? (claims.user_metadata as Record<string, unknown>)
        : {};
    const fullName = [
      metadata.full_name,
      metadata.name,
      metadata.display_name,
    ].find(
      (value): value is string =>
        typeof value === 'string' && value.trim().length > 0,
    );

    return {
      id: claims.sub,
      email: typeof claims.email === 'string' ? claims.email : null,
      fullName: fullName?.trim() ?? null,
    };
  }
}
