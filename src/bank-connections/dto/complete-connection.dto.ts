import { IsUUID } from 'class-validator';

export class CompleteConnectionDto {
  @IsUUID()
  itemId!: string;
}
