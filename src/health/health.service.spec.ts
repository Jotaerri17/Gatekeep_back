import { HealthService } from './health.service';

describe('HealthService', () => {
  it('returns service and database health information', async () => {
    const prisma = {
      $queryRaw: jest.fn().mockResolvedValue([{ result: 1 }]),
    };
    const service = new HealthService(prisma as never);

    const result = await service.check();

    expect(prisma.$queryRaw).toHaveBeenCalled();
    expect(result).toMatchObject({
      status: 'ok',
      backend: true,
      database: true,
    });
    expect(typeof result.timestamp).toBe('string');
  });
});
