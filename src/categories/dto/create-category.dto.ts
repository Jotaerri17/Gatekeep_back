import { CategoryType } from '@prisma/client';
import {
  IsEnum,
  IsHexColor,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

export class CreateCategoryDto {
  @IsString()
  @MinLength(2)
  @MaxLength(50)
  name!: string;

  @IsEnum(CategoryType)
  type!: CategoryType;

  @IsOptional()
  @IsHexColor()
  color?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  icon?: string;

  @IsOptional()
  @Matches(/^\d{1,12}(\.\d{1,2})?$/)
  monthlyLimit?: string | null;
}
