# Offer to close (slice 5)

For Ari, 12 Nov 2026. How an offer to a buyer is priced, gated, sent with a price sheet and walked to Complete. No migration: everything below uses tables from migrations 067, 116 and 118.

## Schema

Nothing new in the database. What the slice reads and writes:

- **`crm_bulk_offers.terms`** (`amount`, `currency`, `unit`, `delivery_terms`, `payment_terms`, `expires_on`): on an offer to a buyer, `amount` is the buyer price. It is the only price a sheet or email may quote. `expires_on` is filled with the seller quote's last day when left empty.
- **`crm_bulk_offers.data.open_sheet_doc_id`**: the price sheet stored with the open offer email. The send marks that document sent and drops the key, as it does `open_draft_id`.
- **`crm_bulk_offers.data.draft_terms`**: for each offer draft, the terms it was built from (`offerTermsKey`: price, unit, currency, quantity, delivery terms, last day). A change to any of them in the app drops `open_draft_id` and `open_sheet_doc_id` and marks that sheet "Out of date, not sent", so the next Draft email builds both again. Draft email never reuses a draft built from other terms, and the send refuses one: "The offer's price or terms changed after this email was drafted, so it was not sent. Draft the email again."
- **`crm_bulk_offers.take_gbp`** (slice 1): still the only place take is stored. The margin is worked out on read and only prefills it.
- **`crm_bulk_listing_documents`** (067): each price sheet is one row: an `.xlsx` file, `doc_type` Quote, `direction` prepared, `state` draft, then sent and sent with the email. Visibility `never`.
- **`crm_bulk_listing_activity`**: "Document added" and "Document sent" lines, carrying the `offer_id`, so History and the offer's thread both show the sheet.

## The quote gate

An offer on a supply listing goes to a buyer. A draft or a send to that buyer is allowed only while the seller's quote is in date: the `seller_price` field is `confirmed`, it has an amount, and `bulk_listing_quote_until()` (`spec.seller_quote_valid_until`) is today or later in London. When the offer came from a stored match that recorded its own `quote_valid_until`, the sooner of the two dates holds, and a lapsed match date blocks too.

When blocked, the API answers 409 with the reason (`The seller's quote ran out on 3 Nov. Ask them to confirm it.`) and `reconfirm: true`. The card shows the same sentence, a "Draft re-confirm to seller" button (slice 4's draft) and a field to record the seller's new date. The gate is checked again at the send click, so a draft made in date cannot go out after the quote runs out, and a hand move to Offered on the stage menu (the offer PATCH) passes the same gate. The offer's `expires_on` may not be later than the quote's date (400 otherwise). Drafts to sellers (stock asks, confirms, re-confirms) are never gated. One helper does this: `quoteGate()` in `lib/bulk-offer-close.ts`, read through `offerGate()` / `offerClose()` in `lib/crm-postgres/bulk-offer-close.ts`.

## Price sheets

Built from CRM rows only (`lib/bulk-price-sheet.ts`), as `.xlsx` (SheetJS, already a dependency):

- **Overview**: this lot and the buyer's other live offers on supply listings that are priced and in date, one row each: product, kWh, state of health, country, available, buyer price. Offers that fail the gate are left out and counted.
- **Fixed**: the confirmed line: quantity (offer, else the match's yes), unit price, line total, total, delivery, payment, valid until.
- **Send copy**: the fixed sheet made when the offer email is drafted. The email body carries its lines instead of "Price on request".

Only teaser fields are read, never `seller_price` or the listing title, and the country at most. The finished sheet is refused if it holds the seller's name, contact, email, address parts or price as written, or if a buyer price equals the seller's. References are `PS-` and 8 random hex characters.

The mail tool cannot attach files to a draft, so the `.xlsx` lives in Documents and the email carries the lines as text. To send the file itself, someone downloads it from Documents and attaches it in Gmail.

## Margin and take

Margin is (buyer price minus the confirmed seller price) times the quantity, counted in the buyer's currency. Take is that margin in pounds. When the two prices differ in currency or unit, they are converted at the CRM's fixed rates (`EUR_PER`: 1 GBP = 1.16 EUR, 1 USD = 0.86 EUR) and the kWh per unit of a single-product lot, and the figure is marked "about". Staff see it on the offer only. Mark paid prefills take and amount paid from it, and the person can change both.

## Closing

The card shows one primary button for the next stage and what that stage needs: Draft email, They replied, Contract sent (needs price, quantity and valid-until), Mark signed, Invoice sent, Mark paid (opens the paid form), Mark complete. The API holds the same rules: a move to Contract sent, Signed or Invoice sent without a buyer price, a quantity and a valid-until date is a 400 ("Add the buyer price, quantity, valid-until date first."). Paid and Complete still need the five paid facts (API 400, and the database refuses them too). On a request deal, no email to the buyer is drafted from the deal itself: offers on a request go to suppliers, and the buyer's offer lives on the supply listing, so its drafts already pass the gate against that listing. Declined and Lost stay in the stage menu and still need a reason. On the test database, a full walk to Complete sold 12 of a 24-pack lot: the request closed as bought_from_us and the lot stayed open with "Part sold: 12 of 24". A walk to Lost turned the match into a no with the reason and ended its reservation.

## Not done

There is no price-of-record flag on the card yet. `comparePrices()` (`lib/bulk-price-of-record.ts`) and `priceOfRecord(listingId, source)` are built and tested against an injected price source. Nothing calls them live, because no local copy of a deal's marketplace price exists. The daily stock sync skips bundle listings, and it writes `crm_stock_opportunities.price` only when it first adds a row. To show the flag, mirror `buy_now_price` for deal listings in that sync and pass it in.
