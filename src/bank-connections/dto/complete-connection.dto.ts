import { IsUUID } from 'class-validator';

export class CompleteConnectionDto {
  @IsUUID()
  attemptId!: string;

  @IsUUID()
  itemId!: string;
}
