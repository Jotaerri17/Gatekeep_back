import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { SupabaseAuthGuard } from './supabase-auth.guard';

function createContext(request: { headers: Record<string, string> }) {
  return {
    getHandler: () => function handler() {},
    getClass: () => class Controller {},
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

describe('SupabaseAuthGuard', () => {
  const originalUrl = process.env.SUPABASE_URL;
  const originalKey = process.env.SUPABASE_ANON_KEY;

  beforeEach(() => {
    process.env.SUPABASE_URL = 'https://project.supabase.co';
    process.env.SUPABASE_ANON_KEY = 'publishable-key';
  });

  afterAll(() => {
    process.env.SUPABASE_URL = originalUrl;
    process.env.SUPABASE_ANON_KEY = originalKey;
  });

  it('allows routes explicitly marked as public', async () => {
    const reflector = {
      getAllAndOverride: jest.fn().mockReturnValue(true),
    } as unknown as Reflector;
    const guard = new SupabaseAuthGuard(reflector);

    await expect(
      guard.canActivate(createContext({ headers: {} })),
    ).resolves.toBe(true);
  });

  it('rejects protected routes without a bearer token', async () => {
    const reflector = {
      getAllAndOverride: jest.fn().mockReturnValue(false),
    } as unknown as Reflector;
    const guard = new SupabaseAuthGuard(reflector);

    await expect(
      guard.canActivate(createContext({ headers: {} })),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
