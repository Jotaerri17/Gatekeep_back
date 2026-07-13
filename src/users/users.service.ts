import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { CategoryType, Prisma } from '@prisma/client';
import type { AuthenticatedUser } from '../auth/authenticated-user';
import { PrismaService } from '../infrastructure/prisma/prisma.service';
import { UpdateUserDto } from './dto/update-user.dto';

const defaultCategories = [
  {
    name: 'Moradia',
    type: CategoryType.EXPENSE,
    color: '#6366f1',
    icon: 'House',
  },
  {
    name: 'Alimentação',
    type: CategoryType.EXPENSE,
    color: '#f59e0b',
    icon: 'Utensils',
  },
  {
    name: 'Transporte',
    type: CategoryType.EXPENSE,
    color: '#0ea5e9',
    icon: 'Car',
  },
  {
    name: 'Saúde',
    type: CategoryType.EXPENSE,
    color: '#ef4444',
    icon: 'HeartPulse',
  },
  {
    name: 'Educação',
    type: CategoryType.EXPENSE,
    color: '#8b5cf6',
    icon: 'GraduationCap',
  },
  {
    name: 'Lazer',
    type: CategoryType.EXPENSE,
    color: '#ec4899',
    icon: 'PartyPopper',
  },
  {
    name: 'Assinaturas',
    type: CategoryType.EXPENSE,
    color: '#14b8a6',
    icon: 'CreditCard',
  },
  {
    name: 'Compras',
    type: CategoryType.EXPENSE,
    color: '#f97316',
    icon: 'ShoppingBag',
  },
  {
    name: 'Impostos e Taxas',
    type: CategoryType.EXPENSE,
    color: '#64748b',
    icon: 'Receipt',
  },
  {
    name: 'Outros',
    type: CategoryType.EXPENSE,
    color: '#71717a',
    icon: 'CircleEllipsis',
  },
  {
    name: 'Receitas',
    type: CategoryType.INCOME,
    color: '#22c55e',
    icon: 'TrendingUp',
  },
] as const;

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  async bootstrap(authUser: AuthenticatedUser) {
    if (!authUser.email) {
      throw new BadRequestException(
        'Authenticated user does not have an email',
      );
    }

    const normalizedEmail = authUser.email.trim().toLowerCase();
    const user = await this.prisma.$transaction(async (tx) => {
      const savedUser = await tx.user.upsert({
        where: { id: authUser.id },
        update: {
          email: normalizedEmail,
          ...(authUser.fullName ? { fullName: authUser.fullName } : {}),
        },
        create: {
          id: authUser.id,
          email: normalizedEmail,
          fullName: authUser.fullName,
          currency: 'BRL',
        },
      });

      await Promise.all(
        defaultCategories.map((category) =>
          tx.category.upsert({
            where: {
              userId_name_type: {
                userId: savedUser.id,
                name: category.name,
                type: category.type,
              },
            },
            update: {},
            create: { userId: savedUser.id, ...category },
          }),
        ),
      );

      return savedUser;
    });

    return this.serialize(user);
  }

  async findMe(authUser: AuthenticatedUser) {
    const user = await this.prisma.user.findUnique({
      where: { id: authUser.id },
    });

    if (!user) {
      return this.bootstrap(authUser);
    }

    return this.serialize(user);
  }

  async updateMe(authUser: AuthenticatedUser, dto: UpdateUserDto) {
    if (dto.fullName === undefined && dto.timezone === undefined) {
      throw new BadRequestException('At least one field must be provided');
    }

    try {
      const user = await this.prisma.user.update({
        where: { id: authUser.id },
        data: {
          ...(dto.fullName !== undefined
            ? { fullName: this.normalizeOptionalText(dto.fullName) }
            : {}),
          ...(dto.timezone !== undefined ? { timezone: dto.timezone } : {}),
        },
      });

      return this.serialize(user);
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2025'
      ) {
        throw new NotFoundException('User not found');
      }
      throw error;
    }
  }

  private normalizeOptionalText(value: string | null) {
    if (value === null) return null;
    const trimmedValue = value.trim();
    return trimmedValue.length > 0 ? trimmedValue : null;
  }

  private serialize(user: {
    id: string;
    email: string;
    fullName: string | null;
    currency: string;
    timezone: string;
    defaultMonthlyLimit: Prisma.Decimal | null;
    createdAt: Date;
    updatedAt: Date;
  }) {
    return {
      ...user,
      defaultMonthlyLimit: user.defaultMonthlyLimit?.toFixed(2) ?? null,
    };
  }
}
