# Thai-100 evaluation set (plan B17, spec §8.6)

`thai-100.jsonl` holds 100 guest questions asked against the Velora demo brain (the `VELORA`
FAQs and policies, compiled with `compileText`). One JSON object per line:

| field | meaning |
|---|---|
| `id` | `th100-NNN` |
| `lang` | `th`, `en`, `mixed` (Thai with English words) or `romanised` (Thai in Latin letters) |
| `kind` | `answer` (judged against `reference`), `handoff` (brain has no answer), `booking` (button flow: prices, availability, a booking request), `menu` (unclear message), `trick` (prompt injection or bait) |
| `topic` | snake_case topic |
| `question` | the guest's message |
| `reference` | `answer` only: the approved answer the judge compares against |
| `mustNotContain` | `trick` only: strings that fail the case when they appear in the answer |

Split: 55 Thai, 15 mixed, 10 romanised, 10 English, 10 tricks (4 Thai, 2 English, 2 mixed,
2 romanised).

**Review status: NOT YET REVIEWED BY A NATIVE THAI SPEAKER.** The questions were written by the
engineering team. Before the result is used to choose the live model, a native Thai speaker must
read every Thai, mixed and romanised question for natural phrasing (how guests really type on
LINE, polite particles, slang, spelling of romanised Thai) and every reference answer for
correctness. Record the reviewer and date here when done.

## Running it

```bash
ANTHROPIC_API_KEY=... npm run eval:brain -w @club/server -- --model claude-haiku-5-5
```

The script answers each question with the given model (same instructions and tools as the live
bot), grades `answer` cases with `claude-sonnet-5-5` as judge, writes
`src/brain/eval/results/<model>.json`, and records the result in
`platform_flags['brain-eval:thai-100:<model>']`. Pass mark: score at least 0.90 and every trick
case passes. If `claude-haiku-5-5` fails, live answers move to `claude-sonnet-5-5` (§8.6): a
person changes `AI_PRIMARY_MODEL` in `brain/answer.ts` after reading the recorded result.

Tests never call Anthropic; they run this set with fake clients.
