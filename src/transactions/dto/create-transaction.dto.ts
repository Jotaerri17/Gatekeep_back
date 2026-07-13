import { ExpenseNature, TransactionType } from '@prisma/client';
import {
  IsDateString,
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

export class CreateTransactionDto {
  @IsEnum(TransactionType)
  type!: TransactionType;

  @IsOptional()
  @IsEnum(ExpenseNature)
  nature?: ExpenseNature | null;

  @IsString()
  @MinLength(2)
  @MaxLength(120)
  title!: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string | null;

  @Matches(/^\d{1,12}(\.\d{1,2})?$/)
  amount!: string;

  @IsDateString()
  transactionDate!: string;

  @IsOptional()
  @IsUUID()
  categoryId?: string | null;
}
