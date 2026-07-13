import { BadRequestException, Injectable } from '@nestjs/common';
import { CategoryType, Prisma } from '@prisma/client';
import {
  getMonthRange,
  money,
  parseMoney,
  parseReferenceMonth,
} from '../finance/finance.utils';
import { PrismaService } from '../infrastructure/prisma/prisma.service';
import { UpdateBudgetDto } from './dto/update-budget.dto';

@Injectable()
export class BudgetsService {
  constructor(private readonly prisma: PrismaService) {}

  async get(userId: string, month: string) {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
    });
    const { referenceMonth } = parseReferenceMonth(month);
    const { snapshotDate } = getMonthRange(referenceMonth, user.timezone);
    let budget = await this.findBudget(userId, snapshotDate);

    if (!budget && user.defaultMonthlyLimit) {
      const categories = await this.prisma.category.findMany({
        where: { userId, type: CategoryType.EXPENSE, isActive: true },
      });
      try {
        budget = await this.prisma.monthlyBudget.create({
          data: {
            userId,
            referenceMonth: snapshotDate,
            totalLimit: user.defaultMonthlyLimit,
            categoryBudgets: {
              create: categories
                .filter((category) => category.monthlyLimit)
                .map((category) => ({
                  categoryId: category.id,
                  limit: category.monthlyLimit!,
                })),
            },
          },
          include: { categoryBudgets: { include: { category: true } } },
        });
      } catch (error) {
        if (
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === 'P2002'
        ) {
          budget = await this.findBudget(userId, snapshotDate);
        } else {
          throw error;
        }
      }
    }

    return this.serialize(referenceMonth, user.defaultMonthlyLimit, budget);
  }

  async update(userId: string, month: string, dto: UpdateBudgetDto) {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
    });
    const { referenceMonth } = parseReferenceMonth(month);
    const { snapshotDate } = getMonthRange(referenceMonth, user.timezone);
    const totalLimit = parseMoney(dto.totalLimit, 'totalLimit');
    const uniqueCategoryIds = new Set(
      dto.categoryBudgets.map((item) => item.categoryId),
    );

    if (uniqueCategoryIds.size !== dto.categoryBudgets.length) {
      throw new BadRequestException('Category limits must not be duplicated');
    }

    const ownedCategories = await this.prisma.category.findMany({
      where: {
        userId,
        id: { in: [...uniqueCategoryIds] },
        type: CategoryType.EXPENSE,
      },
    });
    if (ownedCategories.length !== uniqueCategoryIds.size) {
      throw new BadRequestException('One or more categories are invalid');
    }

    await this.prisma.$transaction(async (tx) => {
      const budget = await tx.monthlyBudget.upsert({
        where: {
          userId_referenceMonth: { userId, referenceMonth: snapshotDate },
        },
        update: { totalLimit },
        create: { userId, referenceMonth: snapshotDate, totalLimit },
      });
      await tx.categoryBudget.deleteMany({
        where: { monthlyBudgetId: budget.id },
      });
      if (dto.categoryBudgets.length > 0) {
        await tx.categoryBudget.createMany({
          data: dto.categoryBudgets.map((item) => ({
            monthlyBudgetId: budget.id,
            categoryId: item.categoryId,
            limit: parseMoney(item.limit, 'categoryLimit'),
          })),
        });
      }

      const currentMonth = new Date().toISOString().slice(0, 7);
      if (referenceMonth === currentMonth) {
        await tx.user.update({
          where: { id: userId },
          data: { defaultMonthlyLimit: totalLimit },
        });
        await Promise.all(
          dto.categoryBudgets.map((item) =>
            tx.category.update({
              where: { id: item.categoryId },
              data: { monthlyLimit: parseMoney(item.limit, 'categoryLimit') },
            }),
          ),
        );
      }
    });

    return this.get(userId, referenceMonth);
  }

  private findBudget(userId: string, referenceMonth: Date) {
    return this.prisma.monthlyBudget.findUnique({
      where: { userId_referenceMonth: { userId, referenceMonth } },
      include: { categoryBudgets: { include: { category: true } } },
    });
  }

  private serialize(
    referenceMonth: string,
    defaultMonthlyLimit: Prisma.Decimal | null,
    budget: Awaited<ReturnType<BudgetsService['findBudget']>>,
  ) {
    return {
      referenceMonth,
      defaultMonthlyLimit: money(defaultMonthlyLimit),
      totalLimit: money(budget?.totalLimit ?? null),
      categoryBudgets:
        budget?.categoryBudgets.map((item) => ({
          categoryId: item.categoryId,
          categoryName: item.category.name,
          limit: money(item.limit),
        })) ?? [],
      allocatedTotal: money(
        budget?.categoryBudgets.reduce(
          (sum, item) => sum.add(item.limit),
          new Prisma.Decimal(0),
        ) ?? new Prisma.Decimal(0),
      ),
    };
  }
}
