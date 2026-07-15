import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  BRAZIL_TIMEZONE,
  getMonthRange,
  money,
  parseMoney,
  parseReferenceMonth,
} from '../finance/finance.utils';
import { PrismaService } from '../infrastructure/prisma/prisma.service';
import { CreateCategoryDto } from './dto/create-category.dto';
import { UpdateCategoryDto } from './dto/update-category.dto';

@Injectable()
export class CategoriesService {
  constructor(private readonly prisma: PrismaService) {}

  async list(userId: string, month?: string) {
    await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    const { referenceMonth } = parseReferenceMonth(month);
    const { start, end, snapshotDate } = getMonthRange(
      referenceMonth,
      BRAZIL_TIMEZONE,
    );

    const [categories, totals, budget] = await Promise.all([
      this.prisma.category.findMany({
        where: { userId },
        orderBy: [{ isActive: 'desc' }, { type: 'asc' }, { name: 'asc' }],
      }),
      this.prisma.transaction.groupBy({
        by: ['categoryId'],
        where: {
          userId,
          excludedFromBudget: false,
          transactionDate: { gte: start, lt: end },
        },
        _sum: { amount: true },
        _count: true,
      }),
      this.prisma.monthlyBudget.findUnique({
        where: {
          userId_referenceMonth: { userId, referenceMonth: snapshotDate },
        },
        include: { categoryBudgets: true },
      }),
    ]);

    const totalsByCategory = new Map(
      totals.map((row) => [row.categoryId, row]),
    );
    const limitsByCategory = new Map(
      budget?.categoryBudgets.map((item) => [item.categoryId, item.limit]) ??
        [],
    );

    return categories.map((category) => {
      const spent =
        totalsByCategory.get(category.id)?._sum.amount ?? new Prisma.Decimal(0);
      const limit = limitsByCategory.get(category.id) ?? category.monthlyLimit;
      return {
        ...category,
        monthlyLimit: money(category.monthlyLimit),
        effectiveLimit: money(limit),
        spent: money(spent),
        transactionCount: totalsByCategory.get(category.id)?._count ?? 0,
        progress:
          limit && limit.gt(0)
            ? Math.min(999, Math.round(spent.div(limit).mul(100).toNumber()))
            : null,
      };
    });
  }

  async create(userId: string, dto: CreateCategoryDto) {
    try {
      const category = await this.prisma.category.create({
        data: {
          userId,
          name: dto.name.trim(),
          type: dto.type,
          color: dto.color ?? null,
          icon: dto.icon?.trim() ?? null,
          monthlyLimit: dto.monthlyLimit
            ? parseMoney(dto.monthlyLimit, 'monthlyLimit')
            : null,
        },
      });
      return { ...category, monthlyLimit: money(category.monthlyLimit) };
    } catch (error) {
      this.handleError(error);
    }
  }

  async update(userId: string, id: string, dto: UpdateCategoryDto) {
    await this.assertOwner(userId, id);
    try {
      const category = await this.prisma.category.update({
        where: { id },
        data: {
          ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
          ...(dto.type !== undefined ? { type: dto.type } : {}),
          ...(dto.color !== undefined ? { color: dto.color } : {}),
          ...(dto.icon !== undefined ? { icon: dto.icon?.trim() || null } : {}),
          ...(dto.monthlyLimit !== undefined
            ? {
                monthlyLimit: dto.monthlyLimit
                  ? parseMoney(dto.monthlyLimit, 'monthlyLimit')
                  : null,
              }
            : {}),
          ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
        },
      });
      return { ...category, monthlyLimit: money(category.monthlyLimit) };
    } catch (error) {
      this.handleError(error);
    }
  }

  async deactivate(userId: string, id: string) {
    await this.assertOwner(userId, id);
    await this.prisma.category.update({
      where: { id },
      data: { isActive: false },
    });
    return { deactivated: true };
  }

  private async assertOwner(userId: string, id: string) {
    const category = await this.prisma.category.findFirst({
      where: { id, userId },
    });
    if (!category) throw new NotFoundException('Category not found');
    return category;
  }

  private handleError(error: unknown): never {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002'
    ) {
      throw new ConflictException(
        'A category with this name and type already exists',
      );
    }
    throw error;
  }
}
