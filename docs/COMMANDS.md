# WhatsApp command dictionary

Send these to your WhatsApp business number. Anything the parser does not
recognise as a command becomes a task — except messages starting with a command
word, which never silently create one.

| Message | Result |
|---|---|
| `Call the accountant` | new task |
| `Pay the invoice entro il 20/8` | new task with a deadline |
| `cal tomorrow 15 meeting with Sam` | calendar event |
| `nota: idea for the landing page` | stored in the inbox, no task |
| `lista` (or `task`, `?`) | your open tasks, numbered |
| `fatto 2` | archives task number 2 |
| `fatto invoice` | archives the task matching "invoice" |
| `fatto` | asks which one, and lists them |
| `aiuto` (or `help`, `comandi`) | this list |

`fatto` also answers to `done` and `completato`, and ignores brackets or quotes.
When several tasks match, it lists the candidates and asks for the number.

## Dates and times the `cal` parser understands

The wording is Italian; adapt `MESI`, `GIORNI` and the keyword regexes in
`src/index.js` (`parseEventText`) for another language.

| You write | Read as |
|---|---|
| `oggi`, `domani`, `dopodomani` | today / tomorrow / the day after |
| `lunedì`, `venerdi` … | the **next** occurrence (a week away if it is today) |
| `12/9`, `12-9`, `12.9.2026` | 12 September |
| `5 settembre`, `5 set` | 5 September |
| `alle 15`, `ore 9.30`, `h 18` | start time |
| `15:30` | start time |
| `dalle 10.30 alle 12` | time range |
| `9 - 12`, `20-22` | time range |
| `15` on its own | start time |
| `venerdì 13` | day **13** of the month, not 13:00 |
| `13/8 - 16/8`, `venerdì 13 - lunedì 16 agosto` | a multi-day, all-day span |

Rules that avoid the usual ambiguities:
- Day words win over numbers, so `cal domani, 9 - 12, Sam` is *tomorrow 09:00-12:00*,
  not 9 December.
- Every matched fragment is blanked out, so the same text is never read twice.
- A date already in the past rolls to next year (`3/1` in August → 3 January next year).
- No time → all-day event. A start with no end → one hour.
- Filler words are trimmed only at the edges, so `cena di capodanno` keeps its "di".
- A number right after a weekday is the day of the month, so `venerdì 13` is not 13:00.
- Two dates joined by `-` or `al` become a span; the first borrows the month from the
  second (`venerdì 13 - lunedì 16 agosto` = 13→16 August, all-day).
- The reply prints the year whenever it is not the current one, so a date that rolled
  into next year is visible instead of silent.

Check any phrase without touching your calendar:

```
GET /api/parse?q=cal domani 15 dentist&t=<ACCESS_TOKEN>
```

and run a whole command (it does act) with:

```
GET /api/cmd?q=lista&t=<ACCESS_TOKEN>
```

## Reply window

Free-form replies only work within **24 hours** of your last inbound message —
a WhatsApp rule. That is invisible in normal use because you always write first;
it only matters if you want the bot to message you **unprompted** (a morning
brief, say), which requires a Meta-approved template.
