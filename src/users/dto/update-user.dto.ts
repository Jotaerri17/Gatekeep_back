import { IsOptional, IsString, MaxLength } from 'class-validator';

export class UpdateUserDto {
  @IsOptional()
  @IsString()
  @MaxLength(120)
  fullName?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  timezone?: string;
}
