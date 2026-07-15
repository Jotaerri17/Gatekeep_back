import {
  IsDateString,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
} from 'class-validator';

export class ConnectionAttemptErrorDto {
  @IsUUID()
  attemptId!: string;

  @IsString()
  @Matches(/^[A-Z0-9_]{1,100}$/)
  code!: string;

  @IsString()
  @MaxLength(500)
  message!: string;

  @IsOptional()
  @IsUUID()
  itemId?: string;

  @IsDateString()
  occurredAt!: string;
}
