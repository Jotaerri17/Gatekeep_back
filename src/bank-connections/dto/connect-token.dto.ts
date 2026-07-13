import { IsOptional, IsUUID } from 'class-validator';

export class ConnectTokenDto {
  @IsOptional()
  @IsUUID()
  connectionId?: string;
}
