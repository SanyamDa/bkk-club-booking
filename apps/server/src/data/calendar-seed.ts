/**
 * The city calendar seed (spec §14.3, plan B13): Thai national public holidays, the five Buddhist
 * holy days and the alcohol-ban days for 2026 and 2027. Election and city-event days are entered
 * by hand from the console as they are announced (POST /api/admin/calendar-days).
 *
 * The Buddhist days follow the lunar calendar. 2027's lunar dates are computed from the full moons
 * and must be checked against the cabinet's holiday announcement; they carry a note until then.
 */
export type CalendarKind = 'public_holiday' | 'holy_day' | 'alcohol_ban' | 'election' | 'city_event';

export interface CalendarSeedRow {
  date: string;
  kind: CalendarKind;
  name: string;
  notes?: string;
}

const SUB = 'substitution day';
const LUNAR_2027 = 'lunar date, confirm against the cabinet announcement';

const holidays = (rows: [string, string, string?][]): CalendarSeedRow[] =>
  rows.map(([date, name, notes]) => ({ date, kind: 'public_holiday', name, ...(notes ? { notes } : {}) }));

/** Each Buddhist day is a holy day and an alcohol-ban day (sale of alcohol is banned nationwide). */
const buddhist = (rows: [string, string][], notes?: string): CalendarSeedRow[] =>
  rows.flatMap(([date, name]) =>
    (['holy_day', 'alcohol_ban'] as const).map((kind) => ({ date, kind, name, ...(notes ? { notes } : {}) })),
  );

export const CALENDAR_SEED: readonly CalendarSeedRow[] = Object.freeze([
  // 2026 (BE 2569)
  ...holidays([
    ['2026-01-01', "New Year's Day"],
    ['2026-03-03', 'Makha Bucha Day'],
    ['2026-04-06', 'Chakri Memorial Day'],
    ['2026-04-13', 'Songkran'],
    ['2026-04-14', 'Songkran'],
    ['2026-04-15', 'Songkran'],
    ['2026-05-01', 'National Labour Day'],
    ['2026-05-04', 'Coronation Day'],
    ['2026-05-31', 'Visakha Bucha Day'],
    ['2026-06-01', 'Visakha Bucha Day', SUB],
    ['2026-06-03', "Queen Suthida's Birthday"],
    ['2026-07-28', "King Vajiralongkorn's Birthday"],
    ['2026-07-29', 'Asahna Bucha Day'],
    ['2026-07-30', 'Khao Phansa Day'],
    ['2026-08-12', "Queen Mother's Birthday and Mother's Day"],
    ['2026-10-13', 'King Bhumibol Memorial Day'],
    ['2026-10-23', 'Chulalongkorn Day'],
    ['2026-12-05', "King Bhumibol's Birthday and Father's Day"],
    ['2026-12-07', "King Bhumibol's Birthday and Father's Day", SUB],
    ['2026-12-10', 'Constitution Day'],
    ['2026-12-31', "New Year's Eve"],
  ]),
  ...buddhist([
    ['2026-03-03', 'Makha Bucha'],
    ['2026-05-31', 'Visakha Bucha'],
    ['2026-07-29', 'Asahna Bucha'],
    ['2026-07-30', 'Khao Phansa'],
    ['2026-10-26', 'Ok Phansa'],
  ]),
  // 2027 (BE 2570)
  ...holidays([
    ['2027-01-01', "New Year's Day"],
    ['2027-02-20', 'Makha Bucha Day', LUNAR_2027],
    ['2027-02-22', 'Makha Bucha Day', `${SUB}; ${LUNAR_2027}`],
    ['2027-04-06', 'Chakri Memorial Day'],
    ['2027-04-13', 'Songkran'],
    ['2027-04-14', 'Songkran'],
    ['2027-04-15', 'Songkran'],
    ['2027-05-01', 'National Labour Day'],
    ['2027-05-03', 'National Labour Day', SUB],
    ['2027-05-04', 'Coronation Day'],
    ['2027-05-20', 'Visakha Bucha Day', LUNAR_2027],
    ['2027-06-03', "Queen Suthida's Birthday"],
    ['2027-07-18', 'Asahna Bucha Day', LUNAR_2027],
    ['2027-07-19', 'Khao Phansa Day', LUNAR_2027],
    ['2027-07-20', 'Asahna Bucha Day', `${SUB}; ${LUNAR_2027}`],
    ['2027-07-28', "King Vajiralongkorn's Birthday"],
    ['2027-08-12', "Queen Mother's Birthday and Mother's Day"],
    ['2027-10-13', 'King Bhumibol Memorial Day'],
    ['2027-10-23', 'Chulalongkorn Day'],
    ['2027-10-25', 'Chulalongkorn Day', SUB],
    ['2027-12-05', "King Bhumibol's Birthday and Father's Day"],
    ['2027-12-06', "King Bhumibol's Birthday and Father's Day", SUB],
    ['2027-12-10', 'Constitution Day'],
    ['2027-12-31', "New Year's Eve"],
  ]),
  ...buddhist(
    [
      ['2027-02-20', 'Makha Bucha'],
      ['2027-05-20', 'Visakha Bucha'],
      ['2027-07-18', 'Asahna Bucha'],
      ['2027-07-19', 'Khao Phansa'],
      ['2027-10-15', 'Ok Phansa'],
    ],
    LUNAR_2027,
  ),
]);
