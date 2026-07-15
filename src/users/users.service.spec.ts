import { PrismaService } from '../infrastructure/prisma/prisma.service';
import { UsersService } from './users.service';

describe('UsersService', () => {
  const tx = {
    user: { upsert: jest.fn() },
    category: { upsert: jest.fn() },
  };
  const prisma = {
    $transaction: jest.fn((callback: (client: typeof tx) => Promise<unknown>) =>
      callback(tx),
    ),
    user: { update: jest.fn() },
  };
  const savedUser = {
    id: '2b5d43c2-b170-46ef-b0e2-8fd63ce18da8',
    email: 'user@example.com',
    fullName: 'Nome salvo',
    currency: 'BRL',
    timezone: 'America/Maceio',
    defaultMonthlyLimit: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    tx.user.upsert.mockResolvedValue(savedUser);
    tx.category.upsert.mockResolvedValue({});
    prisma.user.update.mockResolvedValue(savedUser);
  });

  it('does not overwrite a saved profile name and creates only supported defaults', async () => {
    const service = new UsersService(prisma as unknown as PrismaService);

    await service.bootstrap({
      id: savedUser.id,
      email: 'USER@example.com',
      fullName: 'Nome do provedor',
    });

    expect(tx.user.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: { email: 'user@example.com' },
      }),
    );
    expect(tx.category.upsert).toHaveBeenCalledTimes(8);
    for (const removedName of ['Educação', 'Lazer', 'Impostos e Taxas']) {
      expect(tx.category.upsert).not.toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({ name: removedName }) as unknown,
        }),
      );
    }
    expect(tx.category.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ name: 'Outros' }) as unknown,
      }),
    );
  });

  it('normalizes profile updates and always serializes Brasilia time', async () => {
    const service = new UsersService(prisma as unknown as PrismaService);

    const result = await service.updateMe(
      {
        id: savedUser.id,
        email: savedUser.email,
        fullName: savedUser.fullName,
      },
      { fullName: '  Novo nome  ' },
    );

    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: savedUser.id },
      data: { fullName: 'Novo nome' },
    });
    expect(result.timezone).toBe('America/Sao_Paulo');
  });
});
