-- Sodium-ion is a chemistry the dossier schema allows (buyer_dossier.CHEMISTRIES) and buyers ask for. The key vocabulary
-- did not know it, so a "Sodium-ion" product wrote a line with no chemistry. Same function as 112 plus the one case.
create or replace function buyer_interest_chemistry(value text) returns text language sql immutable as $$
  with folded as (select buyer_interest_fold(value) as text)
  select case
    when text is null then null
    when text ~ '(sodiumion|naion)' then 'Sodium-ion'
    when text ~ '(lfp|lifepo|lithiumironphosphate|lithiumferrophosphate)' then 'LFP'
    when text ~ '(nmc|ncm|nickelmanganesecobalt)' then 'NMC'
    when text ~ '(nca|nickelcobaltalumin)' then 'NCA'
    when text ~ '(lto|titanate)' then 'LTO'
    when text ~ '(nimh|nickelmetalhydride)' then 'NiMH'
    when text ~ '(lmo|manganeseoxide)' then 'LMO'
    else null end
  from folded
$$;
