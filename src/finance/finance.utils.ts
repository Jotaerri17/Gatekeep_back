import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

export const BRAZIL_TIMEZONE = 'America/Sao_Paulo';

export function currentReferenceMonth(
  date = new Date(),
  timezone = BRAZIL_TIMEZONE,
) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
    })
      .formatToParts(date)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value]),
  );
  return `${parts.year}-${parts.month}`;
}

export function parseReferenceMonth(value?: string) {
  const fallback = currentReferenceMonth();
  const referenceMonth = value ?? fallback;

  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(referenceMonth)) {
    throw new BadRequestException('month must use YYYY-MM');
  }

  const [year, month] = referenceMonth.split('-').map(Number);
  return { referenceMonth, year, month };
}

export function zonedDateTimeToUtc(
  year: number,
  month: number,
  day: number,
  timezone: string,
) {
  const utcGuess = Date.UTC(year, month - 1, day);
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  const parts = Object.fromEntries(
    formatter
      .formatToParts(new Date(utcGuess))
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, Number(part.value)]),
  );
  const representedAsUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );

  return new Date(utcGuess - (representedAsUtc - utcGuess));
}

export function getMonthRange(referenceMonth: string, timezone: string) {
  const { year, month } = parseReferenceMonth(referenceMonth);
  const nextYear = month === 12 ? year + 1 : year;
  const nextMonth = month === 12 ? 1 : month + 1;

  return {
    start: zonedDateTimeToUtc(year, month, 1, timezone),
    end: zonedDateTimeToUtc(nextYear, nextMonth, 1, timezone),
    snapshotDate: new Date(Date.UTC(year, month - 1, 1)),
  };
}

export function parseMoney(value: string, field = 'amount') {
  if (!/^\d{1,12}(\.\d{1,2})?$/.test(value)) {
    throw new BadRequestException(`${field} must be a positive decimal string`);
  }

  const decimal = new Prisma.Decimal(value);
  if (decimal.lte(0)) {
    throw new BadRequestException(`${field} must be greater than zero`);
  }
  return decimal;
}

export function money(value: Prisma.Decimal | number | string | null) {
  if (value === null) return null;
  return new Prisma.Decimal(value).toFixed(2);
}
