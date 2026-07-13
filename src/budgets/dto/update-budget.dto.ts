import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsString,
  IsUUID,
  Matches,
  ValidateNested,
} from 'class-validator';

class CategoryBudgetInputDto {
  @IsUUID()
  categoryId!: string;

  @Matches(/^\d{1,12}(\.\d{1,2})?$/)
  limit!: string;
}

export class UpdateBudgetDto {
  @IsString()
  @Matches(/^\d{1,12}(\.\d{1,2})?$/)
  totalLimit!: string;

  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => CategoryBudgetInputDto)
  categoryBudgets!: CategoryBudgetInputDto[];
}
