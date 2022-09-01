import hoursToMilliseconds from 'date-fns/hoursToMilliseconds';
import minutesToMilliseconds from 'date-fns/minutesToMilliseconds';
import secondsToMilliseconds from 'date-fns/secondsToMilliseconds';

export enum TimeSpanUnit {
  Hours = 'hours',
  Minutes = 'minutes',
  Seconds = 'seconds'
}

const timeSpanRx = /(?<quantity>\d+) (?<unit>\w+)/;

export class TimespanParsingError extends Error {
  constructor(msg: string) {
    super(msg);
  }
}

export function parseTimespan(timespan: string) {
  const normalized = timespan.toLowerCase().replace(/\s/, ' ');
  const matches = normalized.match(timeSpanRx);
  if (!matches) {
    throw new TimespanParsingError('unable to parse timespan ' + timespan);
  }
  const quantity = parseInt(matches.groups!['quantity']);
  const unit = matches.groups!['unit']

  let milliseconds: number;
  switch (unit) {
    case TimeSpanUnit.Hours:
      milliseconds = hoursToMilliseconds(quantity);
      break;
    case TimeSpanUnit.Minutes:
      milliseconds = minutesToMilliseconds(quantity);
      break;
    case TimeSpanUnit.Seconds:
      milliseconds = secondsToMilliseconds(quantity);
      break;
    default:
      throw new Error(`Unkonwn timespan unit ${unit}. Valid are ${Object.values(TimeSpanUnit).join(', ')}`)
  }

  return milliseconds
}
