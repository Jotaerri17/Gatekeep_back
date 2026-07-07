import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';

const uuidRegex =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const currencyRegex = /^[A-Z]{3}$/;

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  findAll() {
    return this.prisma.user.findMany({
      orderBy: { createdAt: 'desc' },
    });
  }

  async findOne(id: string) {
    this.assertUuid(id, 'id');

    const user = await this.prisma.user.findUnique({
      where: { id },
    });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    return user;
  }

  async create(createUserDto: CreateUserDto) {
    const data = this.toCreateData(createUserDto);

    try {
      return await this.prisma.user.create({ data });
    } catch (error) {
      this.handlePrismaError(error);
    }
  }

  async update(id: string, updateUserDto: UpdateUserDto) {
    this.assertUuid(id, 'id');

    const data = this.toUpdateData(updateUserDto);

    if (Object.keys(data).length === 0) {
      throw new BadRequestException('At least one field must be provided');
    }

    try {
      return await this.prisma.user.update({
        where: { id },
        data,
      });
    } catch (error) {
      this.handlePrismaError(error);
    }
  }

  async remove(id: string) {
    this.assertUuid(id, 'id');

    try {
      await this.prisma.user.delete({
        where: { id },
      });

      return { deleted: true };
    } catch (error) {
      this.handlePrismaError(error);
    }
  }

  private toCreateData(dto: CreateUserDto): Prisma.UserCreateInput {
    this.assertUuid(dto.id, 'id');
    this.assertEmail(dto.email);

    if (dto.currency !== undefined) {
      this.assertCurrency(dto.currency);
    }

    return {
      id: dto.id,
      email: dto.email.trim().toLowerCase(),
      fullName: this.normalizeOptionalText(dto.fullName),
      currency: dto.currency?.trim().toUpperCase() ?? 'BRL',
    };
  }

  private toUpdateData(dto: UpdateUserDto): Prisma.UserUpdateInput {
    const data: Prisma.UserUpdateInput = {};

    if (dto.email !== undefined) {
      this.assertEmail(dto.email);
      data.email = dto.email.trim().toLowerCase();
    }

    if (dto.fullName !== undefined) {
      data.fullName = this.normalizeOptionalText(dto.fullName);
    }

    if (dto.currency !== undefined) {
      this.assertCurrency(dto.currency);
      data.currency = dto.currency.trim().toUpperCase();
    }

    return data;
  }

  private assertUuid(value: string | undefined, field: string) {
    if (!value || !uuidRegex.test(value)) {
      throw new BadRequestException(`${field} must be a valid UUID`);
    }
  }

  private assertEmail(value: string | undefined) {
    if (!value || !emailRegex.test(value.trim())) {
      throw new BadRequestException('email must be valid');
    }
  }

  private assertCurrency(value: string) {
    if (!currencyRegex.test(value.trim().toUpperCase())) {
      throw new BadRequestException('currency must be a valid ISO code');
    }
  }

  private normalizeOptionalText(value?: string | null) {
    if (value === undefined) {
      return undefined;
    }

    if (value === null) {
      return null;
    }

    const trimmedValue = value.trim();
    return trimmedValue.length > 0 ? trimmedValue : null;
  }

  private handlePrismaError(error: unknown): never {
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      if (error.code === 'P2002') {
        throw new ConflictException('User already exists');
      }

      if (error.code === 'P2025') {
        throw new NotFoundException('User not found');
      }
    }

    throw error;
  }
}
