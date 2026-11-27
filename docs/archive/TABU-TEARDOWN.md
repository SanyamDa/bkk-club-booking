# Tabu (tabu.social) teardown

Observed 20 Nov 2026 from the public website. The native app was not inspected.

## What it is

A Bangkok nightlife and dining marketplace: restaurants, bars, clubs, rooftops and events. Tagline: *Discover. Reserve. Belong.* The revenue model is a commission on each booking.

## How it's built (visible from the site)

| Layer | Observed | Notes |
|---|---|---|
| Web frontend | Next.js (Turbopack build), hosted on Vercel (`dpl_` deployment ids) | Server-rendered venue pages, good for SEO |
| Backend | Supabase (Postgres, Storage, Edge Functions) | Venue media is served from public Supabase storage buckets and passed through Next image optimisation |
| Maps | Google Maps API | Powers "Near me" |
| SEO | schema.org `Restaurant` JSON-LD on every venue page (address, opening hours, images) | Cheap to copy, and we should do it on day one |
| i18n | `/th` route | English + Thai |
| Distribution | "Powered by Tabu" footer on venue pages | Suggests an embeddable widget or white-label booking page that venues link to |

## Product surfaces

- **Discover:** category tiles (Restaurants, Clubs, Bars, Rooftops, Near Me, The Scene), search, and "Upcoming Special Events".
- **Restaurant booking:** guests, date and time, then available timeslots for tonight, then "Book a Table". Menus are attached as documents (à la carte, beverage).
- **Club booking:** a date picker 14 days out, then "Book a Table". Table selection appears to happen after the date step and is probably app- or login-gated. Venue info lists hours, dress code, age (20+) and charges (+7% VAT, +10% service).
- **Events:** separate listing with media served from an edge function.
- **The Scene:** **app-only**. The marketing copy describes a social layer: what friends are sharing, who is going where, saved venues, "what is happening there now", then going from seeing the room to booking. In practice it's a social feed of friend activity and venue content (posts and media) tied to booking. It is not a measured crowd signal.

## Gaps we can exploit

1. **Thin supply.** Of the clubs listed, most are "Coming soon". Marketplaces live or die on venue supply. Our B2B tool has to be valuable to a venue *even with zero marketplace demand* (door check-in, table map, promoter tracking, payouts). That's how we sign venues.
2. **The Scene shows content, not data.** A photo feed tells you a place *can* look good. It doesn't tell you it's packed *right now*, or whether it'll be packed on Friday. Pulse answers both, with numbers and confidence.
3. **Bundling makes the vibe feed look like ads.** When the company that sells you the table also tells you the place is lit, users discount it. Keeping Pulse as a separate, independent brand makes its ratings believable, and that credibility is the asset.
4. **Promoters.** Bangkok club tables run largely through promoters. Tabu shows no promoter tooling. Attribution and commission splits for promoters is a strong B2B wedge.

## What to copy

- Server-rendered, SEO-structured venue pages with JSON-LD.
- Thai/English from day one.
- Showing VAT and service charge up front.
- An embeddable "book with us" widget for venues' own sites and Instagram bios.
