import { IsIn, IsOptional, Matches } from 'class-validator';

export class DashboardQueryDto {
  @IsOptional()
  @Matches(/^\d{4}-(0[1-9]|1[0-2])$/)
  month?: string;

  @IsOptional()
  @IsIn(['day', 'week', 'month'])
  period: 'day' | 'week' | 'month' = 'month';

  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  anchor?: string;
}
