import { Body, Controller, Get, Patch, Post } from '@nestjs/common';
import type { AuthenticatedUser } from '../auth/authenticated-user';
import { CurrentUser } from '../auth/current-user.decorator';
import { UpdateUserDto } from './dto/update-user.dto';
import { UsersService } from './users.service';

@Controller('me')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Post('bootstrap')
  bootstrap(@CurrentUser() user: AuthenticatedUser) {
    return this.usersService.bootstrap(user);
  }

  @Get()
  findMe(@CurrentUser() user: AuthenticatedUser) {
    return this.usersService.findMe(user);
  }

  @Patch()
  updateMe(
    @CurrentUser() user: AuthenticatedUser,
    @Body() updateUserDto: UpdateUserDto,
  ) {
    return this.usersService.updateMe(user, updateUserDto);
  }
}
