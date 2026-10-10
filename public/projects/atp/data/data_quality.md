# Data quality log

| Severity | Check | Count | Action |
|---|---|---|---|
| error | Lines not in UTF-8 (Windows-1252) | 2 | Re-decoded as cp1252 |
| error | [weekly] Header line repeated inside a file | 1 | Rows dropped |
| error | [weekly] Rows with no player id | 71,494 | 30 names matched to a bio by name; the rest get an 'X:<name>' id |
| error | [weekly] Exact duplicate rows | 2,256 | Dropped |
| error | [weekly] Player listed twice on one list | 3 | Kept the better rank |
| error | [official] Exact duplicate rows | 2,256 | Dropped |
| error | TML weekly set vs official ATP lists: top-20 disagreements | 355 | Flag only; 1967/2322 official lists match the TML list exactly |
| error | [canonical] Top-20 rank numbers skip or repeat inconsistently | 1 | Flag only (list kept) |
| error | Implausible height in cm (ranked players) | 1 | Set to missing |
| error | Implausible weight in kg (ranked players) | 2 | Set to missing |
| error | [weekly reconstruction] Career weeks at No. 1 vs official totals (±1.5 wk) | 2 | 24/26 players match |
| warning | [weekly] Names with no matching bio | 847 | Kept with 'X:<name>' id; no bio fields |
| warning | [weekly] Isolated 0-point entries on lists that otherwise have points | 120,742 | Set to missing (a ranked player cannot hold 0 points) |
| warning | [official] Isolated 0-point entries on lists that otherwise have points | 1,409 | Set to missing (a ranked player cannot hold 0 points) |
| warning | [canonical] Lists not dated on a Monday, 1985 on | 1 | Flag only |
| warning | [canonical] In-season gaps longer than a week | 12 | Flag only; plot lines bridge the gap |
| warning | [canonical] Top-100 player with more points than the player ranked above | 1 | Flag only (rank order is official) |
| warning | Ranked players with no date of birth | 716 | Left blank |
| info | [weekly] Lists with every points value 0 | 306 | Points set to missing (not published for those lists) |
| info | [weekly] Same player id spelled differently across lists | 13 | Bio name used everywhere |
| info | [weekly] Rows kept | 4,066,564 | 4,068,824 raw -> 4,066,564 clean |
| info | [official] Lists with every points value 0 | 927 | Points set to missing (not published for those lists) |
| info | [official] Rows kept | 3,344,991 | 3,347,247 raw -> 3,344,991 clean |
| info | Canonical history: source by era | 3 | Official ATP lists before 1985; TML weekly lists from 1985 |
| info | [canonical] Lists not dated on a Monday, before 1985 | 48 | Expected: early lists were issued on varying weekdays |
| info | [canonical] Known gaps | 1 | Expected |
| info | [canonical] Lists per year before 1985 (irregular era) | 12 | Reference: each list stays in force until the next one |
| info | [canonical] Tied ranks inside the top 20 | 35 | Kept; ties ordered by points then name |
| info | Different players sharing one name | 3 | Kept separate (ids differ); display name gets country/birth year |
| info | Year-end list notes | 1 | Reference |
| info | Year-end No. 1 vs official record | 0 | 53/53 seasons match |
| info | [canonical] Career weeks at No. 1 vs official totals (±1.5 wk) | 0 | 26/26 players match |
| info | [official only] Career weeks at No. 1 vs official totals (±1.5 wk) | 0 | 26/26 players match |

## Lines not in UTF-8 (Windows-1252)
- ATP_Database.csv line 1372: "C0NB","Federico Cina","Federico Cina",20070330,73,185,,"Palermo","Francesco Cin
- ATP_Database.csv line 2177: "E661","Gonzalo Escobar","Gonzalo Escobar",19890120,79,178,2013,"Manta, Ecuador"

## [weekly] Header line repeated inside a file
- 2025.csv

## [weekly] Rows with no player id
- Chris Lewis (NZL) -> L024 (best rank 19)
- Thomaz Koch -> K036 (best rank 23)
- Jairo Velasco Sr -> V294 (best rank 46)
- Fred McNair IV -> M146 (best rank 76)
- Jan-Erik Lundqvist -> L158 (best rank 122)
- Kiyoski Tanabe -> T062 (best rank 171)
- Kanyab Derafshijavan -> D649 (best rank 228)
- James Mcardle -> MD15 (best rank 315)
- Bo Svensson -> SE09 (best rank 334)
- Moharram-Ali Khodai -> K747 (best rank 338)

## [weekly] Exact duplicate rows
- ['2016-04-04', '1', 'Novak Djokovic']
- ['2016-04-04', '2', 'Andy Murray']
- ['2016-04-04', '3', 'Roger Federer']
- ['2016-04-04', '4', 'Stan Wawrinka']
- ['2016-04-04', '5', 'Rafael Nadal']
- ['2016-04-04', '6', 'Kei Nishikori']
- ['2016-04-04', '7', 'Tomas Berdych']
- ['2016-04-04', '8', 'David Ferrer']
- ['2016-04-04', '9', 'Jo-Wilfried Tsonga']
- ['2016-04-04', '10', 'Richard Gasquet']

## [weekly] Player listed twice on one list
- ['1995-10-16', 'W237', 'Andreas Weber', [983, 983]]
- ['1996-02-12', 'W237', 'Andreas Weber', [994, 994]]
- ['1996-02-19', 'W237', 'Andreas Weber', [989, 989]]

## [official] Exact duplicate rows
- ['2016-04-04', '1', 'Novak Djokovic']
- ['2016-04-04', '2', 'Andy Murray']
- ['2016-04-04', '3', 'Roger Federer']
- ['2016-04-04', '4', 'Stan Wawrinka']
- ['2016-04-04', '5', 'Rafael Nadal']
- ['2016-04-04', '6', 'Kei Nishikori']
- ['2016-04-04', '7', 'Tomas Berdych']
- ['2016-04-04', '8', 'David Ferrer']
- ['2016-04-04', '9', 'Jo-Wilfried Tsonga']
- ['2016-04-04', '10', 'Richard Gasquet']

## TML weekly set vs official ATP lists: top-20 disagreements
- 1973-08-23 vs 1973-08-20: B129: official 12 vs TML None; C044: official 10 vs TML 12; D082: official None vs TML 20; E030: official 19 vs TML 14 …
- 1973-09-13 vs 1973-09-10: A022: official 20 vs TML None; A063: official 7 vs TML 6; B129: official 17 vs TML None; C044: official 10 vs TML 9 …
- 1973-09-26 vs 1973-09-24: A022: official 20 vs TML None; A063: official 9 vs TML 8; B129: official 16 vs TML None; C044: official 5 vs TML 7 …
- 1973-10-15 vs 1973-10-15: B058: official None vs TML 20; B129: official 19 vs TML None; C044: official 3 vs TML 7; C090: official 17 vs TML 15 …
- 1973-10-31 vs 1973-10-29: A063: official 9 vs TML 8; B129: official 20 vs TML None; C044: official 4 vs TML 6; C090: official 19 vs TML 17 …
- 1973-11-26 vs 1973-11-26: B058: official 17 vs TML 18; B129: official 20 vs TML None; F024: official 18 vs TML 17; G029: official None vs TML 20 …
- 1973-12-14 vs 1973-12-17: B129: official 20 vs TML None; G029: official None vs TML 20; O032: official 4 vs TML 5; S060: official 5 vs TML 4
- 1974-03-02 vs 1974-03-04: B058: official 16 vs TML 14; C044: official 4 vs TML 2; C090: official 19 vs TML None; D026: official None vs TML 19 …
- 1974-04-19 vs 1974-04-22: C090: official 19 vs TML None; D026: official None vs TML 19; D082: official 15 vs TML 13; F024: official 16 vs TML 14 …
- 1974-05-01 vs 1974-04-29: B058: official 11 vs TML 13; B129: official 14 vs TML 17; D082: official 13 vs TML 12; F024: official 17 vs TML 16 …

## [canonical] Top-20 rank numbers skip or repeat inconsistently
- 1981-09-21: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 19, 19, 20]

## Implausible height in cm (ranked players)
- ['N0BU', 'Daniel Antonio Nunez', 0.0]

## Implausible weight in kg (ranked players)
- ['B0LL', 'Viacheslav Bielinskyi', 151.0]
- ['B293', 'Patrick Baur', 186.0]

## [weekly reconstruction] Career weeks at No. 1 vs official totals (±1.5 wk)
- Jimmy Connors: data 252 vs official 268 (-16)
- Ilie Nastase: data 36 vs official 40 (-4)

## [weekly] Names with no matching bio
- Teimuraz Kakoulia (best rank 88)
- Alejandro Riba (best rank 160)
- Matt Wooldridge (best rank 220)
- Bob Hansen (best rank 221)
- Mike Sassano (best rank 227)
- Rob Keighery (best rank 248)
- Geoff MacDonald (best rank 252)
- Greg Neuhart (best rank 257)
- Lee Tomlinson (best rank 259)
- Jack Bushman (best rank 259)

## [weekly] Isolated 0-point entries on lists that otherwise have points
- ['1995-06-05', '1', 'Andre Agassi']
- ['1993-05-31', '1', 'Pete Sampras']
- ['1990-02-05', '1', 'Ivan Lendl']
- ['1990-02-05', '2', 'Boris Becker']
- ['1993-05-31', '2', 'Jim Courier']
- ['1995-06-05', '2', 'Pete Sampras']
- ['1995-06-05', '3', 'Boris Becker']
- ['1993-05-31', '3', 'Stefan Edberg']
- ['1990-02-05', '3', 'Stefan Edberg']
- ['1990-02-05', '4', 'Brad Gilbert']

## [official] Isolated 0-point entries on lists that otherwise have points
- ['1990-05-21', '1', 'Ivan Lendl']
- ['1990-05-21', '2', 'Stefan Edberg']
- ['1990-05-21', '3', 'Boris Becker']
- ['1990-05-21', '4', 'Brad Gilbert']
- ['1990-05-21', '5', 'Andre Agassi']
- ['1990-05-21', '6', 'Andres Gomez']
- ['1990-05-21', '7', 'Aaron Krickstein']
- ['1990-05-21', '8', 'Emilio Sanchez']
- ['1990-05-21', '9', 'Thomas Muster']
- ['1990-05-21', '10', 'Andrei Chesnokov']

## [canonical] Lists not dated on a Monday, 1985 on
- 1985-01-02 Wed

## [canonical] In-season gaps longer than a week
- 2025-08-04 -> 2025-08-18 (14 days)
- 2025-08-25 -> 2025-09-08 (14 days)
- 2025-09-22 -> 2025-10-13 (21 days)
- 2026-01-19 -> 2026-02-02 (14 days)
- 2026-03-02 -> 2026-03-16 (14 days)
- 2026-03-16 -> 2026-03-30 (14 days)
- 2026-04-20 -> 2026-05-04 (14 days)
- 2026-05-04 -> 2026-05-18 (14 days)
- 2026-05-25 -> 2026-06-08 (14 days)
- 2026-06-29 -> 2026-07-13 (14 days)

## [canonical] Top-100 player with more points than the player ranked above
- ['1995-11-13', 65, 'Carlos Moya', 695.0, 673.0]

## Ranked players with no date of birth
- Rotimi Akinloye
- Marc Albert
- Marco Alciati
- Edoardo Artaldi
- Aniceto Alvarez
- M. Arenzon
- Tim Anderson
- Orlando Agudelo
- Rich Andrews
- Gabriel Auroux

## [weekly] Same player id spelled differently across lists
- A0M2: ['Yannick Theodor Alexandrescou', 'Yannick Theodor Alexandrescu']
- D008: ['Horacio De La Pena', 'Horacio de la Pena']
- D0LJ: ['Diego Dedura', 'Diego Dedura-Palomero']
- E007: ['Constantinos Efremoglou', 'Konstantinos Effraimoglou']
- H0JL: ['Jay Dylan Hara Friend', 'Jay Friend']
- L024: ['Chris Lewis', 'Chris Lewis (NZL)']
- L0CK: ['Younes Lalami', 'Younes Lalami Laaroussi']
- M0C2: ['Dan  Martin', 'Dan Martin']
- M1D0: ['Oliver Majdandzic', 'Oliver Majdanzic']
- R102: ['Saleem Rana', 'Selim Rana']

## Canonical history: source by era
- 381 official lists 1973-08-23 -> 1984-12-24
- 2145 weekly lists 1985-01-02 -> 2026-10-05
- 0 official lists added where the weekly set has no list

## [canonical] Lists not dated on a Monday, before 1985
- 1973-08-23 Thu
- 1973-09-13 Thu
- 1973-09-26 Wed
- 1973-10-31 Wed
- 1973-12-14 Fri
- 1974-03-02 Sat
- 1974-04-19 Fri
- 1974-05-01 Wed
- 1974-08-09 Fri
- 1974-09-04 Wed

## [canonical] Known gaps
- 2020-03-16 -> 2020-08-24 (161 days): COVID-19 tour suspension, rankings frozen

## [canonical] Lists per year before 1985 (irregular era)
- 1973: 7
- 1974: 10
- 1975: 13
- 1976: 23
- 1977: 33
- 1978: 38
- 1979: 42
- 1980: 43
- 1981: 41
- 1982: 44

## [canonical] Tied ranks inside the top 20
- ['1973-11-26', 15, ['Adriano Panatta', 'Nikola Pilic']]
- ['1975-04-08', 15, ['Harold Solomon', 'Dick Stockton']]
- ['1975-04-30', 2, ['Ken Rosewall', 'Guillermo Vilas']]
- ['1976-08-30', 19, ['Jan Kodes', 'Tom Okker', 'Dick Stockton']]
- ['1977-12-05', 15, ['Sandy Mayer', 'Harold Solomon']]
- ['1977-12-12', 11, ['Corrado Barazzutti', 'Ken Rosewall']]
- ['1977-12-12', 16, ['Sandy Mayer', 'Harold Solomon']]
- ['1977-12-19', 16, ['Sandy Mayer', 'Harold Solomon']]
- ['1978-02-13', 2, ['Bjorn Borg', 'Guillermo Vilas']]
- ['1978-02-20', 2, ['Bjorn Borg', 'Guillermo Vilas']]

## Different players sharing one name
- ['L639', 'Chris Lewis', 'GBR']
- ['L024', 'Chris Lewis', 'NZL']
- ['D0DT', 'Martin Damm', 'USA']
- ['D214', 'Martin Damm', 'CZE']
- ['A240', 'Unknown Unknown', nan]
- ['M557', 'Unknown Unknown', nan]
- ['M530', 'Unknown Unknown', nan]
- ['L269', 'Unknown Unknown', nan]
- ['H295', 'Unknown Unknown', nan]
- ['H267', 'Unknown Unknown', nan]

## Year-end list notes
- 2026: season in progress; latest list 2026-10-05 is provisional
