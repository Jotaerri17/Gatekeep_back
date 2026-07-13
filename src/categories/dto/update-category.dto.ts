import { CategoryType } from '@prisma/client';
import {
  IsBoolean,
  IsEnum,
  IsHexColor,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

export class UpdateCategoryDto {
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(50)
  name?: string;

  @IsOptional()
  @IsEnum(CategoryType)
  type?: CategoryType;

  @IsOptional()
  @IsHexColor()
  color?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  icon?: string | null;

  @IsOptional()
  @Matches(/^\d{1,12}(\.\d{1,2})?$/)
  monthlyLimit?: string | null;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
