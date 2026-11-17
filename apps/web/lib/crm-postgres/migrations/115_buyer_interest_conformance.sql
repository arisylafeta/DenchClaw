-- Wants conformance (R1-R6) for the buyer_interest writers (additive; 112, 113 and 114 stay as applied).
--
--   R1  make + chemistry + kWh + format stay paired as the source states them. A row that states products as pairs
--       (spec.products, or a title such as "Toyota Proace 50 kWh NMC + Stellantis 52 kWh LFP") gives one line per
--       product. Two or more dimensions with several values and no stated pairing give one line per value of each
--       dimension, never the cross product.
--   R2  A closed request never writes a declined line: closed 'bought_from_us' is a bought line, every other closed
--       reason except not_demand / duplicate / supply_misfiled (and the profile reasons) is an ask that expires as closed.
--       Declined lines come only from an offer the buyer declined or a dossier declined product. Existing declined
--       lines synced from demand rows are removed here.
--   R3  Model keys use the canonical slug of the shared alias list (buyer_interest_model_slug, generated from
--       apps/web/lib/match/model-aliases.json by scripts/rebattery/model_aliases.py --sql), so "Kona Electric" is kona.
--   R4  One line per source x kind x product key, and no line next to a more specific line of the same source that
--       already says it (model:nissan-leaf beside model:nissan-leaf-40kwh).
--   R5  A vehicle make is never paired with a battery system from a format list.
--   R6  Cell makers, cell formats, every part number and the pack voltage a source states are kept on the line in
--       buyer_interest.stated (jsonb); kWh stays in kwh_min / kwh_max.
--
-- Lines already written change on their next sync: run scripts/rebattery/backfill_buyer_interest.py after applying.
-- Apply after a current backup and outside the 08:00 importer window. The column add and the delete take short
-- locks (lock_timeout 3s, re-run on timeout). Idempotent.
begin;
set local lock_timeout = '3s';

alter table buyer_interest add column if not exists stated jsonb;

-- ---------------------------------------------------------------------------
-- Canonical model slug (generated: scripts/rebattery/model_aliases.py --sql)
-- ---------------------------------------------------------------------------
create or replace function buyer_interest_model_slug(p_make text, p_model text) returns text language plpgsql immutable as $fn$
declare
  raw text := coalesce(p_model, '');
  txt text;
  norm text;
  brand text;
  spaced text;
  tokens text[];
  mk text := nullif(buyer_interest_fold(p_make), '');
  best text;
  exact_only boolean := position('/' in coalesce(p_model, '')) > 0;
  pass int;
  variants text[] := array['long', 'range', 'standard', 'awd', 'rwd', 'fwd', '4wd', '2wd', 'lr', 'sr', 'dual', 'motor', 'performance', 'premium', 'se'];
begin
  if btrim(raw) = '' or raw ~ '[,;:]' then return null; end if;
  for pass in 1..2 loop
    txt := buyer_interest_unaccent(raw);
    txt := regexp_replace(txt, '\y[0-9]+(\.[0-9]+)?\s*(kwh|kw|ps|hp|bhp|ah)\y', ' ', 'g');
    txt := regexp_replace(txt, '\([^)]*\)|\[[^\]]*\]', ' ', 'g');
    if pass = 1 then txt := regexp_replace(txt, '\y(19|20)[0-9]{2}\y', ' ', 'g'); end if;
    txt := regexp_replace(txt, '\y(battery|batteries|packs?|modules?|hv|high voltage)\y', ' ', 'g');
    txt := btrim(regexp_replace(regexp_replace(txt, '[^a-z0-9]+', ' ', 'g'), '\s+', ' ', 'g'));
    for brand in
      select b from (select distinct b from unnest(array[btrim(regexp_replace(buyer_interest_unaccent(p_make), '[^a-z0-9]+', ' ', 'g')),
        'volkswagen', 'vw', 'audi', 'mini', 'skoda', 'cupra', 'porsche', 'bmw', 'mercedes benz', 'mercedes', 'tesla', 'stellantis', 'nissan', 'renault', 'dacia', 'peugeot', 'citroen', 'opel', 'vauxhall', 'fiat', 'jeep', 'ford', 'hyundai', 'kia', 'genesis', 'toyota', 'lexus', 'honda', 'mazda', 'mitsubishi', 'suzuki', 'subaru', 'volvo', 'polestar', 'jaguar', 'land rover', 'mg', 'byd', 'lotus', 'lucid', 'rivian', 'nio', 'xpeng', 'zeekr', 'leapmotor', 'maxus', 'smart', 'seat']) b where b <> '') u order by length(b) desc
    loop
      if txt like brand || ' %' then txt := substr(txt, length(brand) + 2); exit; end if;
    end loop;
    tokens := string_to_array(txt, ' ');
    while coalesce(array_length(tokens, 1), 0) > 1 and tokens[array_length(tokens, 1)] = any(variants) loop
      tokens := tokens[1:array_length(tokens, 1) - 1];
    end loop;
    norm := array_to_string(tokens, ' ');
    exit when norm <> '';
  end loop;
  if norm = '' then return null; end if;
  select slug into best from (values
    ('audi', 'a3', 'a3', false),
    ('audi', 'a3 s3 8v', 'a3', true),
    ('audi', 'a6', 'a6', false),
    ('audi', 'a6 c8 avant 4a5', 'a6', true),
    ('audi', 'e tron', 'etron', true),
    ('audi', 'e tron 55 quattro', 'etron', true),
    ('audi', 'e tron gt', 'etrongt', true),
    ('audi', 'e tron s ge 2019', 'etron', true),
    ('audi', 'e tron sportback', 'etron', true),
    ('audi', 'e tron sportback gea', 'etron', true),
    ('audi', 'etron', 'etron', true),
    ('audi', 'q4', 'q4etron', false),
    ('audi', 'q4 e tron', 'q4etron', true),
    ('audi', 'q4 e tron fz', 'q4etron', true),
    ('audi', 'q4 etron', 'q4etron', true),
    ('audi', 'q5', 'q5', false),
    ('audi', 'q5 fy', 'q5', true),
    ('audi', 'q7', 'q7', false),
    ('audi', 'q8 4m', 'q8etron', true),
    ('audi', 'q8 e tron', 'q8etron', true),
    ('audi', 'q8 e tron sportback', 'q8etron', true),
    ('bmw', '2 f45 active tourer', '2series', true),
    ('bmw', '2 series', '2series', true),
    ('bmw', '2 u06 active tourer', '2series', true),
    ('bmw', '225xe', '225xe', true),
    ('bmw', '3 serie', '3series', true),
    ('bmw', '3 series', '3series', true),
    ('bmw', '330e', '330e', true),
    ('bmw', '5 serie', '5series', true),
    ('bmw', '5 series', '5series', true),
    ('bmw', '530e', '530e', true),
    ('bmw', '740e', '740e', true),
    ('bmw', 'i3', 'i3', false),
    ('bmw', 'i3 120ah', 'i3', true),
    ('bmw', 'i3 94ah', 'i3', true),
    ('bmw', 'i3 i01', 'i3', true),
    ('bmw', 'i3s', 'i3', true),
    ('bmw', 'i4', 'i4', false),
    ('bmw', 'i4 g26', 'i4', true),
    ('bmw', 'ix', 'ix', false),
    ('bmw', 'ix xdrive', 'ix', true),
    ('bmw', 'ix1', 'ix1', true),
    ('bmw', 'x1', 'x1', false),
    ('bmw', 'x1 f48', 'x1', true),
    ('bmw', 'x1 ix1 u11', 'ix1', true),
    ('bmw', 'x1 u11', 'x1', true),
    ('bmw', 'x3', 'x3', false),
    ('bmw', 'x3 g01', 'x3', true),
    ('bmw', 'x5', 'x5', false),
    ('bmw', 'x5 g05', 'x5', true),
    ('bmw', 'x5 g05 f95', 'x5', true),
    ('bmw', 'x5 xdrive45e', 'x5', true),
    ('byd', 'atto 3', 'atto3', true),
    ('byd', 'atto3', 'atto3', true),
    ('byd', 'dolphin', 'dolphin', true),
    ('byd', 'han', 'han', true),
    ('byd', 'seal', 'seal', true),
    ('byd', 'seal u', 'seal', true),
    ('byd', 't3', 't3', false),
    ('byd', 'tang', 'tang', true),
    ('chevrolet', 'bolt', 'boltev', true),
    ('chevrolet', 'bolt euv', 'boltev', true),
    ('chevrolet', 'bolt ev', 'boltev', true),
    ('chevrolet', 'chevrolet bolt', 'boltev', true),
    ('chevrolet', 'chevrolet volt', 'volt', true),
    ('chevrolet', 'chevy bolt', 'boltev', true),
    ('chevrolet', 'chevy volt', 'volt', true),
    ('chevrolet', 'volt', 'volt', true),
    ('citroen', 'ami', 'ami', true),
    ('citroen', 'berlingo', 'berlingo', true),
    ('citroen', 'berlingo van', 'berlingo', true),
    ('citroen', 'c3', 'c3', false),
    ('citroen', 'c3 aircross', 'c3', true),
    ('citroen', 'c4', 'c4', false),
    ('citroen', 'c4 e c4', 'c4', true),
    ('citroen', 'c4 e c4 c4x e c4x', 'c4', true),
    ('citroen', 'e berlingo', 'berlingo', true),
    ('citroen', 'e c4', 'c4', true),
    ('citroen', 'e jumpy', 'jumpy', true),
    ('citroen', 'jumpy', 'jumpy', true),
    ('cupra', 'born', 'born', true),
    ('cupra', 'formentor', 'formentor', true),
    ('cupra', 'leon', 'leon', true),
    ('dacia', 'spring', 'spring', true),
    ('ds', '3 crossback', 'ds3crossback', true),
    ('ds', 'ds3', 'ds3crossback', true),
    ('ds', 'ds3 crossback', 'ds3crossback', true),
    ('ds', 'ds7', 'ds7', true),
    ('ds', 'ds7 crossback', 'ds7', true),
    ('fiat', '500', '500', false),
    ('fiat', '500 e', '500e', true),
    ('fiat', '500e', '500e', true),
    ('fiat', '500e low range', '500e', true),
    ('fiat', 'doblo', 'doblo', true),
    ('fiat', 'ducato', 'ducato', true),
    ('fiat', 'e doblo', 'doblo', true),
    ('fiat', 'e ducato', 'ducato', true),
    ('fiat', 'fiat 500e', '500e', true),
    ('fiat', 'panda', 'panda', true),
    ('ford', 'e transit', 'etransit', true),
    ('ford', 'e transit custom', 'transitcustom', true),
    ('ford', 'explorer', 'explorer', true),
    ('ford', 'fiesta', 'fiesta', true),
    ('ford', 'focus', 'focus', true),
    ('ford', 'kuga', 'kuga', true),
    ('ford', 'kuga fhev', 'kuga', true),
    ('ford', 'kuga kuga phev fhev', 'kuga', true),
    ('ford', 'kuga phev', 'kuga', true),
    ('ford', 'mach e', 'mustangmache', true),
    ('ford', 'mache', 'mustangmache', true),
    ('ford', 'mondeo', 'mondeo', true),
    ('ford', 'mustang mach e', 'mustangmache', true),
    ('ford', 'puma', 'puma', true),
    ('ford', 'puma j2k cf7', 'puma', true),
    ('ford', 'puma mhev', 'puma', true),
    ('ford', 'transit custom', 'transitcustom', true),
    ('genesis', 'electrified gv70', 'gv70', true),
    ('genesis', 'g80', 'g80', true),
    ('genesis', 'gv60', 'gv60', true),
    ('genesis', 'gv70', 'gv70', true),
    ('honda', 'civic', 'civic', true),
    ('honda', 'cr v', 'crv', true),
    ('honda', 'crv', 'crv', true),
    ('honda', 'e', 'hondae', false),
    ('honda', 'e ny1', 'eny1', true),
    ('honda', 'honda e', 'hondae', true),
    ('honda', 'hr v', 'hrv', true),
    ('honda', 'hrv', 'hrv', true),
    ('honda', 'insight', 'insight', true),
    ('honda', 'jazz', 'jazz', true),
    ('honda', 'jazz v gr', 'jazz', true),
    ('hyundai', 'bayon', 'bayon', true),
    ('hyundai', 'genesis', 'genesis', true),
    ('hyundai', 'i20', 'i20', true),
    ('hyundai', 'i30', 'i30', true),
    ('hyundai', 'ioniq', 'ioniq', true),
    ('hyundai', 'ioniq 5', 'ioniq5', true),
    ('hyundai', 'ioniq 5 long range', 'ioniq5', true),
    ('hyundai', 'ioniq 5 n', 'ioniq5', true),
    ('hyundai', 'ioniq 5 ne', 'ioniq5', true),
    ('hyundai', 'ioniq 5 standard range', 'ioniq5', true),
    ('hyundai', 'ioniq 6', 'ioniq6', true),
    ('hyundai', 'ioniq ae', 'ioniq', true),
    ('hyundai', 'ioniq electric', 'ioniq', true),
    ('hyundai', 'ioniq hybrid', 'ioniq', true),
    ('hyundai', 'ioniq phev', 'ioniq', true),
    ('hyundai', 'ioniq premium', 'ioniq', true),
    ('hyundai', 'ioniq premium se bev', 'ioniq', true),
    ('hyundai', 'ioniq5', 'ioniq5', true),
    ('hyundai', 'ioniq6', 'ioniq6', true),
    ('hyundai', 'kona', 'kona', true),
    ('hyundai', 'kona 39 kwh', 'kona', true),
    ('hyundai', 'kona 64 kwh', 'kona', true),
    ('hyundai', 'kona electric', 'kona', true),
    ('hyundai', 'kona electric 64 kwh', 'kona', true),
    ('hyundai', 'kona electric os', 'kona', true),
    ('hyundai', 'kona ev', 'kona', true),
    ('hyundai', 'kona hybrid', 'kona', true),
    ('hyundai', 'santa fe', 'santafe', true),
    ('hyundai', 'tucson', 'tucson', true),
    ('jaguar', 'i pace', 'ipace', true),
    ('jaguar', 'ipace', 'ipace', true),
    ('jeep', 'avenger', 'avenger', true),
    ('jeep', 'avenger 1 generation', 'avenger', true),
    ('jeep', 'compass', 'compass', true),
    ('jeep', 'renegade', 'renegade', true),
    ('kia', 'ceed', 'ceed', true),
    ('kia', 'ceed ceed sw', 'ceed', true),
    ('kia', 'ceed sw', 'ceed', true),
    ('kia', 'e niro', 'niro', true),
    ('kia', 'e soul', 'soul', true),
    ('kia', 'ev3', 'ev3', true),
    ('kia', 'ev3 long range', 'ev3', true),
    ('kia', 'ev3 standard range', 'ev3', true),
    ('kia', 'ev4', 'ev4', true),
    ('kia', 'ev6', 'ev6', true),
    ('kia', 'ev6 cv', 'ev6', true),
    ('kia', 'ev6 gt', 'ev6', true),
    ('kia', 'ev6 long range', 'ev6', true),
    ('kia', 'ev6 standard range', 'ev6', true),
    ('kia', 'ev9', 'ev9', true),
    ('kia', 'ev9 long range', 'ev9', true),
    ('kia', 'kia soul', 'soul', true),
    ('kia', 'niro', 'niro', true),
    ('kia', 'niro 2', 'niro', true),
    ('kia', 'niro de', 'niro', true),
    ('kia', 'niro electric', 'niro', true),
    ('kia', 'niro ev', 'niro', true),
    ('kia', 'niro hybrid', 'niro', true),
    ('kia', 'niro ii', 'niro', true),
    ('kia', 'niro mk1', 'niro', true),
    ('kia', 'niro mk2', 'niro', true),
    ('kia', 'niro phev', 'niro', true),
    ('kia', 'niro sg2', 'niro', true),
    ('kia', 'optima', 'optima', true),
    ('kia', 'rio', 'rio', true),
    ('kia', 'sorento', 'sorento', true),
    ('kia', 'soul', 'soul', true),
    ('kia', 'soul ev', 'soul', true),
    ('kia', 'sportage', 'sportage', true),
    ('kia', 'sportage nq5', 'sportage', true),
    ('kia', 'stonic', 'stonic', true),
    ('kia', 'xceed', 'xceed', true),
    ('landrover', 'defender', 'defender', true),
    ('landrover', 'evoque', 'evoque', true),
    ('landrover', 'range rover sport', 'rangeroversport', true),
    ('lexus', 'ct', 'ct', false),
    ('lexus', 'ct 200h', 'ct', true),
    ('lexus', 'ct zwa10', 'ct', true),
    ('lexus', 'nx', 'nx', false),
    ('lexus', 'nx 350h', 'nx', true),
    ('lexus', 'nx 350h 450h', 'nx', true),
    ('lexus', 'rx', 'rx', false),
    ('lexus', 'rx series', 'rx', true),
    ('lexus', 'ux', 'ux', false),
    ('lynkco', '01', '01', false),
    ('lynkco', '1', '01', false),
    ('lynkco', 'lynk o co 01', '01', true),
    ('maxus', 'deliver 3', 'edeliver3', true),
    ('maxus', 'deliver 9', 'edeliver9', true),
    ('maxus', 'e deliver 3', 'edeliver3', true),
    ('maxus', 'e deliver 9', 'edeliver9', true),
    ('maxus', 'e deliver3 ev30', 'edeliver3', true),
    ('maxus', 'ev80', 'ev80', true),
    ('mazda', '2', '2', false),
    ('mazda', '2 kb hybrid', '2', true),
    ('mazda', '3', '3', false),
    ('mazda', 'cx 30', 'cx30', true),
    ('mazda', 'cx 30 dm', 'cx30', true),
    ('mazda', 'cx 5', 'cx5', true),
    ('mazda', 'cx 5 kf', 'cx5', true),
    ('mazda', 'cx 60', 'cx60', true),
    ('mazda', 'cx 60 kh', 'cx60', true),
    ('mazda', 'mazda 2', '2', true),
    ('mazda', 'mazda 3', '3', true),
    ('mazda', 'mazda2', '2', true),
    ('mazda', 'mazda3', '3', true),
    ('mazda', 'mx 30', 'mx30', true),
    ('mercedesbenz', 'a class', 'aclass', true),
    ('mercedesbenz', 'a class w177', 'aclass', true),
    ('mercedesbenz', 'b 180 200 w246 w242', 'bclass', true),
    ('mercedesbenz', 'b class', 'bclass', true),
    ('mercedesbenz', 'c class', 'cclass', true),
    ('mercedesbenz', 'c class w206', 'cclass', true),
    ('mercedesbenz', 'c klasse', 'cclass', true),
    ('mercedesbenz', 'cla', 'cla', true),
    ('mercedesbenz', 'cla class', 'cla', true),
    ('mercedesbenz', 'cla class c118 x118', 'cla', true),
    ('mercedesbenz', 'e class', 'eclass', true),
    ('mercedesbenz', 'e class w213', 'eclass', true),
    ('mercedesbenz', 'eq', 'eq', false),
    ('mercedesbenz', 'eqa', 'eqa', true),
    ('mercedesbenz', 'eqa h243', 'eqa', true),
    ('mercedesbenz', 'eqb', 'eqb', true),
    ('mercedesbenz', 'eqb x243', 'eqb', true),
    ('mercedesbenz', 'eqc', 'eqc', true),
    ('mercedesbenz', 'eqc 400', 'eqc', true),
    ('mercedesbenz', 'eqc 400 amg line premium 4matic', 'eqc', true),
    ('mercedesbenz', 'eqc n293', 'eqc', true),
    ('mercedesbenz', 'eqe', 'eqe', true),
    ('mercedesbenz', 'eqe v295', 'eqe', true),
    ('mercedesbenz', 'eqs', 'eqs', true),
    ('mercedesbenz', 'eqv', 'eqv', true),
    ('mercedesbenz', 'gla', 'gla', true),
    ('mercedesbenz', 'gla class h247', 'gla', true),
    ('mercedesbenz', 'glc', 'glc', true),
    ('mercedesbenz', 'glc class', 'glc', true),
    ('mercedesbenz', 'glc class x253 c253', 'glc', true),
    ('mercedesbenz', 'glc class x254', 'glc', true),
    ('mercedesbenz', 'gle', 'gle', true),
    ('mercedesbenz', 'gle class', 'gle', true),
    ('mercedesbenz', 'gle class w167 v167 c167', 'gle', true),
    ('mercedesbenz', 'gle w167', 'gle', true),
    ('mercedesbenz', 'sprinter', 'sprinter', true),
    ('mercedesbenz', 'sprinter 3 5 t van', 'sprinter', true),
    ('mercedesbenz', 'sprinter 3 5 t van 907 910', 'sprinter', true),
    ('mg', '3', 'mg3', false),
    ('mg', '4', 'mg4', false),
    ('mg', '4 eh32', 'mg4', true),
    ('mg', '5', 'mg5', false),
    ('mg', 'ehs', 'hs', true),
    ('mg', 'hs', 'hs', false),
    ('mg', 'hs ehs', 'hs', true),
    ('mg', 'hs ehs as23', 'hs', true),
    ('mg', 'marvel r', 'marvelr', true),
    ('mg', 'mg 3', 'mg3', true),
    ('mg', 'mg 4', 'mg4', true),
    ('mg', 'mg 5', 'mg5', true),
    ('mg', 'mg hs', 'hs', true),
    ('mg', 'mg zs ev', 'zsev', true),
    ('mg', 'mg3', 'mg3', true),
    ('mg', 'mg4', 'mg4', true),
    ('mg', 'mg5', 'mg5', true),
    ('mg', 'zs', 'zsev', false),
    ('mg', 'zs ev', 'zsev', true),
    ('mg', 'zs hybrid', 'zsev', true),
    ('mitsubishi', 'eclipse cross', 'eclipsecross', true),
    ('mitsubishi', 'i miev', 'imiev', true),
    ('mitsubishi', 'imiev', 'imiev', true),
    ('mitsubishi', 'mits outlander', 'outlander', true),
    ('mitsubishi', 'outlander', 'outlander', true),
    ('mitsubishi', 'outlander 2013 21', 'outlander', true),
    ('mitsubishi', 'outlander iii gg w gf w zj', 'outlander', true),
    ('mitsubishi', 'outlander phev', 'outlander', true),
    ('nissan', 'ariya', 'ariya', true),
    ('nissan', 'ariya fe0', 'ariya', true),
    ('nissan', 'e nv200', 'nv200', true),
    ('nissan', 'envy200', 'nv200', true),
    ('nissan', 'juke', 'juke', true),
    ('nissan', 'leaf', 'leaf', true),
    ('nissan', 'leaf gen1', 'leaf', true),
    ('nissan', 'leaf gen2', 'leaf', true),
    ('nissan', 'leaf ze0', 'leaf', true),
    ('nissan', 'leaf ze1', 'leaf', true),
    ('nissan', 'leaf zeo', 'leaf', true),
    ('nissan', 'nissan leaf', 'leaf', true),
    ('nissan', 'nv 200', 'nv200', true),
    ('nissan', 'nv200', 'nv200', true),
    ('nissan', 'qashqai', 'qashqai', true),
    ('nissan', 'townstar', 'townstar', true),
    ('opel', 'ampera', 'ampera', true),
    ('opel', 'ampera e', 'ampera', true),
    ('opel', 'astra', 'astra', true),
    ('opel', 'combo', 'combo', true),
    ('opel', 'combo e', 'combo', true),
    ('opel', 'combo life', 'combo', true),
    ('opel', 'corsa', 'corsa', true),
    ('opel', 'corsa e', 'corsa', true),
    ('opel', 'corsa f', 'corsa', true),
    ('opel', 'corsa f corsa e', 'corsa', true),
    ('opel', 'mokka', 'mokka', true),
    ('opel', 'mokka e', 'mokka', true),
    ('opel', 'vivaro', 'vivaro', true),
    ('opel', 'vivaro c', 'vivaro', true),
    ('opel', 'vivaro e', 'vivaro', true),
    ('opel', 'zafira', 'zafira', true),
    ('peugeot', '2008', '2008', false),
    ('peugeot', '208', '208', false),
    ('peugeot', '208 e 208', '208', true),
    ('peugeot', '208 ii ub up uw uj', '208', true),
    ('peugeot', '208 mk2', '208', true),
    ('peugeot', '208 peugeot 208', '208', true),
    ('peugeot', '3008', '3008', false),
    ('peugeot', '308', '308', false),
    ('peugeot', '5008', '5008', false),
    ('peugeot', '508', '508', false),
    ('peugeot', 'boxer', 'boxer', true),
    ('peugeot', 'e 208', '208', true),
    ('peugeot', 'e expert', 'expert', true),
    ('peugeot', 'e partner', 'partner', true),
    ('peugeot', 'expert', 'expert', true),
    ('peugeot', 'expert furgon', 'expert', true),
    ('peugeot', 'partner', 'partner', true),
    ('peugeot', 'partner furgon', 'partner', true),
    ('peugeot', 'rifter', 'rifter', true),
    ('polestar', '2', '2', false),
    ('polestar', '3', '3', false),
    ('polestar', '4', '4', false),
    ('polestar', 'polestar 2', '2', true),
    ('polestar', 'polestar 2 2020', '2', true),
    ('polestar', 'polestar 3', '3', true),
    ('polestar', 'polestar 4', '4', true),
    ('polestar', 'polestar2', '2', true),
    ('porsche', 'cayenne', 'cayenne', true),
    ('porsche', 'cayenne e hybrid', 'cayenne', true),
    ('porsche', 'macan', 'macan', true),
    ('porsche', 'panamera', 'panamera', true),
    ('porsche', 'panamera 971', 'panamera', true),
    ('porsche', 'taycan', 'taycan', true),
    ('porsche', 'taycan 4s', 'taycan', true),
    ('porsche', 'taycan turbo', 'taycan', true),
    ('proterra', 'onyx strata h4 15', 'onyxstratah415', true),
    ('renault', 'arkana', 'arkana', true),
    ('renault', 'austral', 'austral', true),
    ('renault', 'captur', 'captur', true),
    ('renault', 'captur e tech plug in', 'captur', true),
    ('renault', 'clio', 'clio', true),
    ('renault', 'clio e tech', 'clio', true),
    ('renault', 'kangoo', 'kangoo', true),
    ('renault', 'kangoo e tech', 'kangoo', true),
    ('renault', 'kangoo express', 'kangoo', true),
    ('renault', 'kangoo gen1', 'kangoo', true),
    ('renault', 'kangoo ii', 'kangoo', true),
    ('renault', 'kangoo ze', 'kangoo', true),
    ('renault', 'master', 'master', true),
    ('renault', 'master ze', 'master', true),
    ('renault', 'megane', 'megane', true),
    ('renault', 'megane break', 'megane', true),
    ('renault', 'megane e tech', 'megane', true),
    ('renault', 'twingo', 'twingo', true),
    ('renault', 'twingo ze', 'twingo', true),
    ('renault', 'ze', 'ze', false),
    ('renault', 'zoe', 'zoe', true),
    ('renault', 'zoe 2', 'zoe', true),
    ('renault', 'zoe bfm', 'zoe', true),
    ('renault', 'zoe e tech', 'zoe', true),
    ('renault', 'zoe r110', 'zoe', true),
    ('renault', 'zoe r135', 'zoe', true),
    ('renault', 'zoe r90', 'zoe', true),
    ('renault', 'zoe z e', 'zoe', true),
    ('renault', 'zoe ze', 'zoe', true),
    ('rivian', 'r1s', 'r1s', true),
    ('rivian', 'r1t', 'r1t', true),
    ('seat', 'leon', 'leon', true),
    ('seat', 'mii', 'mii', true),
    ('seat', 'mii electric', 'mii', true),
    ('skoda', 'elroq', 'elroq', true),
    ('skoda', 'enyaq', 'enyaq', true),
    ('skoda', 'enyaq iv', 'enyaq', true),
    ('skoda', 'enyaq iv 60', 'enyaq', true),
    ('skoda', 'enyaq iv 80', 'enyaq', true),
    ('skoda', 'kodiaq', 'kodiaq', true),
    ('skoda', 'octavia', 'octavia', true),
    ('skoda', 'superb', 'superb', true),
    ('skoda', 'superb iv', 'superb', true),
    ('smart', 'eq forfour', 'eqfortwo', true),
    ('smart', 'eq fortwo', 'eqfortwo', true),
    ('subaru', 'forester', 'forester', true),
    ('subaru', 'solterra', 'solterra', true),
    ('suzuki', 'across', 'across', true),
    ('suzuki', 'ignis', 'ignis', true),
    ('suzuki', 's cross', 'scross', true),
    ('suzuki', 'swace', 'swace', true),
    ('suzuki', 'swift', 'swift', true),
    ('suzuki', 'sx4 s cross', 'scross', true),
    ('suzuki', 'vitara', 'vitara', true),
    ('tesla', 'cybertruck', 'cybertruck', true),
    ('tesla', 'megapack', 'megapack', true),
    ('tesla', 'megapack 2', 'megapack', true),
    ('tesla', 'model 3', 'model3', true),
    ('tesla', 'model s', 'models', true),
    ('tesla', 'model three', 'model3', true),
    ('tesla', 'model x', 'modelx', true),
    ('tesla', 'model y', 'modely', true),
    ('tesla', 'powerpack', 'powerpack', true),
    ('tesla', 'powerwall', 'powerwall', true),
    ('tesla', 'powerwall 2', 'powerwall', true),
    ('tesla', 'powerwall 3', 'powerwall', true),
    ('toyota', 'auris', 'auris', true),
    ('toyota', 'aygo', 'aygo', true),
    ('toyota', 'bz4x', 'bz4x', true),
    ('toyota', 'bz4x ea10', 'bz4x', true),
    ('toyota', 'c hr', 'chr', true),
    ('toyota', 'camry', 'camry', true),
    ('toyota', 'chr', 'chr', true),
    ('toyota', 'corolla', 'corolla', true),
    ('toyota', 'corolla cross', 'corollacross', true),
    ('toyota', 'corolla cross xg10', 'corollacross', true),
    ('toyota', 'corolla hybrid', 'corolla', true),
    ('toyota', 'prius', 'prius', true),
    ('toyota', 'prius', 'prius', true),
    ('toyota', 'prius 50', 'prius', true),
    ('toyota', 'prius 7', 'prius', true),
    ('toyota', 'prius hybrid', 'prius', true),
    ('toyota', 'prius plus', 'prius', true),
    ('toyota', 'prius w3', 'prius', true),
    ('toyota', 'prius zvw30', 'prius', true),
    ('toyota', 'prius zvw40', 'prius', true),
    ('toyota', 'prius zvw50', 'prius', true),
    ('toyota', 'proace', 'proace', true),
    ('toyota', 'proace city', 'proace', true),
    ('toyota', 'proace city verso mpv bky', 'proace', true),
    ('toyota', 'proace electric', 'proace', true),
    ('toyota', 'proace ii', 'proace', true),
    ('toyota', 'proace verso', 'proace', true),
    ('toyota', 'rav 4', 'rav4', true),
    ('toyota', 'rav 4 prime', 'rav4', true),
    ('toyota', 'rav4', 'rav4', true),
    ('toyota', 'rav4 plug in', 'rav4', true),
    ('toyota', 'rav4 plug in prime', 'rav4', true),
    ('toyota', 'rav4 xa50', 'rav4', true),
    ('toyota', 'swace', 'swace', true),
    ('toyota', 'yaris', 'yaris', true),
    ('toyota', 'yaris cross', 'yariscross', true),
    ('toyota', 'yaris cross mxp', 'yariscross', true),
    ('toyota', 'yaris cross suv', 'yariscross', true),
    ('toyota', 'yaris cross xp21', 'yariscross', true),
    ('toyota', 'yaris hybrid', 'yaris', true),
    ('toyota', 'yaris p21', 'yaris', true),
    ('toyota', 'yaris xp21', 'yaris', true),
    ('volkswagen', 'e golf', 'egolf', true),
    ('volkswagen', 'e golf vii', 'egolf', true),
    ('volkswagen', 'e up', 'eup', true),
    ('volkswagen', 'egolf', 'egolf', true),
    ('volkswagen', 'golf', 'golf', true),
    ('volkswagen', 'golf e golf vii', 'egolf', true),
    ('volkswagen', 'golf gte', 'golf', true),
    ('volkswagen', 'golf vii', 'golf', true),
    ('volkswagen', 'golf viii', 'golf', true),
    ('volkswagen', 'id 3', 'id3', true),
    ('volkswagen', 'id 3 e11', 'id3', true),
    ('volkswagen', 'id 4', 'id4', true),
    ('volkswagen', 'id 5', 'id5', true),
    ('volkswagen', 'id 7', 'id7', true),
    ('volkswagen', 'id 7 tourer', 'id7', true),
    ('volkswagen', 'id buzz', 'idbuzz', true),
    ('volkswagen', 'id3', 'id3', true),
    ('volkswagen', 'id4', 'id4', true),
    ('volkswagen', 'id5', 'id5', true),
    ('volkswagen', 'id7', 'id7', true),
    ('volkswagen', 'idbuzz', 'idbuzz', true),
    ('volkswagen', 'passat', 'passat', true),
    ('volkswagen', 'passat gte', 'passat', true),
    ('volkswagen', 'tayron', 'tayron', true),
    ('volkswagen', 'tiguan', 'tiguan', true),
    ('volkswagen', 'tiguan ehybrid', 'tiguan', true),
    ('volkswagen', 'up', 'eup', false),
    ('volkswagen', 'up e up', 'eup', true),
    ('volvo', 'c40', 'c40', true),
    ('volvo', 'c40 recharge', 'c40', true),
    ('volvo', 'c40 recharge 21', 'c40', true),
    ('volvo', 'ex30', 'ex30', true),
    ('volvo', 'ex30 2024', 'ex30', true),
    ('volvo', 'ex90', 'ex90', true),
    ('volvo', 's90', 's90', true),
    ('volvo', 'v60', 'v60', true),
    ('volvo', 'v60 18', 'v60', true),
    ('volvo', 'v60 19', 'v60', true),
    ('volvo', 'v60 2014 18', 'v60', true),
    ('volvo', 'v90', 'v90', true),
    ('volvo', 'v90 cc', 'v90', true),
    ('volvo', 'v90 v90 cc s90', 'v90', true),
    ('volvo', 'xc40', 'xc40', true),
    ('volvo', 'xc40 536', 'xc40', true),
    ('volvo', 'xc40 recharge', 'xc40', true),
    ('volvo', 'xc40 recharge 18', 'xc40', true),
    ('volvo', 'xc60', 'xc60', true),
    ('volvo', 'xc60 18', 'xc60', true),
    ('volvo', 'xc90', 'xc90', true),
    ('xpeng', 'g6', 'g6', false),
    ('xpeng', 'g9', 'g9', false),
    ('xpeng', 'p7', 'p7', false),
    ('xpeng', 'xpeng p7', 'p7', true)
  ) a(own, alias, slug, is_global)
  where (norm = alias or (not exact_only and norm like alias || ' %'))
    and (own = mk or is_global)
  order by (own = mk) desc, length(alias) desc limit 1;
  if best is not null then return best; end if;
  if exact_only or coalesce(array_length(tokens, 1), 0) >= 4 then return null; end if;
  return nullif(regexp_replace(norm, '[^a-z0-9]+', '', 'g'), '');
end $fn$;

-- Models a free text names (generated: scripts/rebattery/model_aliases.py --sql-text): a make named in the text or an alias with a
-- digit owned by one model. Returns [{make, model, slug}].
create or replace function buyer_interest_text_models(p_text text, p_makes text[] default '{}') returns jsonb language plpgsql immutable as $fn$
declare
  words text := ' ' || btrim(regexp_replace(buyer_interest_unaccent(coalesce(p_text, '')), '[^a-z0-9]+', ' ', 'g')) || ' ';
  hints text[];
  found jsonb := '[]'::jsonb;
  r record;
begin
  select coalesce(array_agg(distinct case h when 'mb' then 'mercedesbenz' when 'mercedes' then 'mercedesbenz' when 'psa' then 'peugeot' when 'vauxhall' then 'opel' when 'vw' then 'volkswagen' else h end), '{}') into hints
  from (select w as h from unnest(string_to_array(btrim(words), ' ')) w
        union select buyer_interest_fold(piece) from unnest(coalesce(p_makes, '{}')) m
          cross join lateral unnest(regexp_split_to_array(m, '\s*(,|/|&|\yand\y)\s*', 'i')) piece) x
  where h is not null and h <> '';
  for r in select * from (values
    ('audi', 'Audi', 'a3', 'a3', 'A3', false),
    ('audi', 'Audi', 'a3 s3 8v', 'a3', 'A3', true),
    ('audi', 'Audi', 'a6', 'a6', 'A6', false),
    ('audi', 'Audi', 'a6 c8 avant 4a5', 'a6', 'A6', true),
    ('audi', 'Audi', 'e tron', 'etron', 'e-tron', false),
    ('audi', 'Audi', 'e tron 55 quattro', 'etron', 'e-tron', true),
    ('audi', 'Audi', 'e tron gt', 'etrongt', 'e-tron GT', false),
    ('audi', 'Audi', 'e tron s ge 2019', 'etron', 'e-tron', true),
    ('audi', 'Audi', 'e tron sportback', 'etron', 'e-tron', false),
    ('audi', 'Audi', 'e tron sportback gea', 'etron', 'e-tron', false),
    ('audi', 'Audi', 'etron', 'etron', 'e-tron', false),
    ('audi', 'Audi', 'q4', 'q4etron', 'Q4 e-tron', false),
    ('audi', 'Audi', 'q4 e tron', 'q4etron', 'Q4 e-tron', true),
    ('audi', 'Audi', 'q4 e tron fz', 'q4etron', 'Q4 e-tron', true),
    ('audi', 'Audi', 'q4 etron', 'q4etron', 'Q4 e-tron', true),
    ('audi', 'Audi', 'q5', 'q5', 'Q5', false),
    ('audi', 'Audi', 'q5 fy', 'q5', 'Q5', true),
    ('audi', 'Audi', 'q7', 'q7', 'Q7', false),
    ('audi', 'Audi', 'q8 4m', 'q8etron', 'Q8 e-tron', true),
    ('audi', 'Audi', 'q8 e tron', 'q8etron', 'Q8 e-tron', true),
    ('audi', 'Audi', 'q8 e tron sportback', 'q8etron', 'Q8 e-tron', true),
    ('bmw', 'BMW', '2 f45 active tourer', '2series', '2 Series', true),
    ('bmw', 'BMW', '2 series', '2series', '2 Series', true),
    ('bmw', 'BMW', '2 u06 active tourer', '2series', '2 Series', true),
    ('bmw', 'BMW', '225xe', '225xe', '225xe', true),
    ('bmw', 'BMW', '3 serie', '3series', '3 Series', true),
    ('bmw', 'BMW', '3 series', '3series', '3 Series', true),
    ('bmw', 'BMW', '330e', '330e', '330e', true),
    ('bmw', 'BMW', '5 serie', '5series', '5 Series', true),
    ('bmw', 'BMW', '5 series', '5series', '5 Series', true),
    ('bmw', 'BMW', '530e', '530e', '530e', true),
    ('bmw', 'BMW', '740e', '740e', '740e', true),
    ('bmw', 'BMW', 'i3', 'i3', 'i3', false),
    ('bmw', 'BMW', 'i3 120ah', 'i3', 'i3', true),
    ('bmw', 'BMW', 'i3 94ah', 'i3', 'i3', true),
    ('bmw', 'BMW', 'i3 i01', 'i3', 'i3', true),
    ('bmw', 'BMW', 'i3s', 'i3', 'i3', true),
    ('bmw', 'BMW', 'i4', 'i4', 'i4', false),
    ('bmw', 'BMW', 'i4 g26', 'i4', 'i4', true),
    ('bmw', 'BMW', 'ix', 'ix', 'iX', false),
    ('bmw', 'BMW', 'ix xdrive', 'ix', 'iX', false),
    ('bmw', 'BMW', 'ix1', 'ix1', 'iX1', true),
    ('bmw', 'BMW', 'x1', 'x1', 'X1', false),
    ('bmw', 'BMW', 'x1 f48', 'x1', 'X1', true),
    ('bmw', 'BMW', 'x1 ix1 u11', 'ix1', 'iX1', true),
    ('bmw', 'BMW', 'x1 u11', 'x1', 'X1', true),
    ('bmw', 'BMW', 'x3', 'x3', 'X3', false),
    ('bmw', 'BMW', 'x3 g01', 'x3', 'X3', true),
    ('bmw', 'BMW', 'x5', 'x5', 'X5', false),
    ('bmw', 'BMW', 'x5 g05', 'x5', 'X5', true),
    ('bmw', 'BMW', 'x5 g05 f95', 'x5', 'X5', true),
    ('bmw', 'BMW', 'x5 xdrive45e', 'x5', 'X5', true),
    ('byd', 'BYD', 'atto 3', 'atto3', 'Atto 3', true),
    ('byd', 'BYD', 'atto3', 'atto3', 'Atto 3', true),
    ('byd', 'BYD', 'dolphin', 'dolphin', 'Dolphin', false),
    ('byd', 'BYD', 'han', 'han', 'Han', false),
    ('byd', 'BYD', 'seal', 'seal', 'Seal', false),
    ('byd', 'BYD', 'seal u', 'seal', 'Seal', false),
    ('byd', 'BYD', 't3', 't3', 'T3', false),
    ('byd', 'BYD', 'tang', 'tang', 'Tang', false),
    ('chevrolet', 'Chevrolet', 'bolt', 'boltev', 'Bolt EV', false),
    ('chevrolet', 'Chevrolet', 'bolt euv', 'boltev', 'Bolt EV', false),
    ('chevrolet', 'Chevrolet', 'bolt ev', 'boltev', 'Bolt EV', false),
    ('chevrolet', 'Chevrolet', 'chevrolet bolt', 'boltev', 'Bolt EV', false),
    ('chevrolet', 'Chevrolet', 'chevrolet volt', 'volt', 'Volt', false),
    ('chevrolet', 'Chevrolet', 'chevy bolt', 'boltev', 'Bolt EV', false),
    ('chevrolet', 'Chevrolet', 'chevy volt', 'volt', 'Volt', false),
    ('chevrolet', 'Chevrolet', 'volt', 'volt', 'Volt', false),
    ('citroen', 'Citroen', 'ami', 'ami', 'Ami', false),
    ('citroen', 'Citroen', 'berlingo', 'berlingo', 'Berlingo', false),
    ('citroen', 'Citroen', 'berlingo van', 'berlingo', 'Berlingo', false),
    ('citroen', 'Citroen', 'c3', 'c3', 'C3', false),
    ('citroen', 'Citroen', 'c3 aircross', 'c3', 'C3', true),
    ('citroen', 'Citroen', 'c4', 'c4', 'C4', false),
    ('citroen', 'Citroen', 'c4 e c4', 'c4', 'C4', true),
    ('citroen', 'Citroen', 'c4 e c4 c4x e c4x', 'c4', 'C4', true),
    ('citroen', 'Citroen', 'e berlingo', 'berlingo', 'Berlingo', false),
    ('citroen', 'Citroen', 'e c4', 'c4', 'C4', true),
    ('citroen', 'Citroen', 'e jumpy', 'jumpy', 'Jumpy', false),
    ('citroen', 'Citroen', 'jumpy', 'jumpy', 'Jumpy', false),
    ('cupra', 'Cupra', 'born', 'born', 'Born', false),
    ('cupra', 'Cupra', 'formentor', 'formentor', 'Formentor', false),
    ('cupra', 'Cupra', 'leon', 'leon', 'Leon', false),
    ('dacia', 'Dacia', 'spring', 'spring', 'Spring', false),
    ('ds', 'DS', '3 crossback', 'ds3crossback', 'DS3 Crossback', true),
    ('ds', 'DS', 'ds3', 'ds3crossback', 'DS3 Crossback', true),
    ('ds', 'DS', 'ds3 crossback', 'ds3crossback', 'DS3 Crossback', true),
    ('ds', 'DS', 'ds7', 'ds7', 'DS7', true),
    ('ds', 'DS', 'ds7 crossback', 'ds7', 'DS7', true),
    ('fiat', 'Fiat', '500', '500', '500', true),
    ('fiat', 'Fiat', '500 e', '500e', '500e', true),
    ('fiat', 'Fiat', '500e', '500e', '500e', true),
    ('fiat', 'Fiat', '500e low range', '500e', '500e', true),
    ('fiat', 'Fiat', 'doblo', 'doblo', 'Doblo', false),
    ('fiat', 'Fiat', 'ducato', 'ducato', 'Ducato', false),
    ('fiat', 'Fiat', 'e doblo', 'doblo', 'Doblo', false),
    ('fiat', 'Fiat', 'e ducato', 'ducato', 'Ducato', false),
    ('fiat', 'Fiat', 'fiat 500e', '500e', '500e', true),
    ('fiat', 'Fiat', 'panda', 'panda', 'Panda', false),
    ('ford', 'Ford', 'e transit', 'etransit', 'E-Transit', false),
    ('ford', 'Ford', 'e transit custom', 'transitcustom', 'Transit Custom', false),
    ('ford', 'Ford', 'explorer', 'explorer', 'Explorer', false),
    ('ford', 'Ford', 'fiesta', 'fiesta', 'Fiesta', false),
    ('ford', 'Ford', 'focus', 'focus', 'Focus', false),
    ('ford', 'Ford', 'kuga', 'kuga', 'Kuga', false),
    ('ford', 'Ford', 'kuga fhev', 'kuga', 'Kuga', false),
    ('ford', 'Ford', 'kuga kuga phev fhev', 'kuga', 'Kuga', false),
    ('ford', 'Ford', 'kuga phev', 'kuga', 'Kuga', false),
    ('ford', 'Ford', 'mach e', 'mustangmache', 'Mustang Mach-E', false),
    ('ford', 'Ford', 'mache', 'mustangmache', 'Mustang Mach-E', false),
    ('ford', 'Ford', 'mondeo', 'mondeo', 'Mondeo', false),
    ('ford', 'Ford', 'mustang mach e', 'mustangmache', 'Mustang Mach-E', false),
    ('ford', 'Ford', 'puma', 'puma', 'Puma', false),
    ('ford', 'Ford', 'puma j2k cf7', 'puma', 'Puma', true),
    ('ford', 'Ford', 'puma mhev', 'puma', 'Puma', false),
    ('ford', 'Ford', 'transit custom', 'transitcustom', 'Transit Custom', false),
    ('genesis', 'Genesis', 'electrified gv70', 'gv70', 'GV70', true),
    ('genesis', 'Genesis', 'g80', 'g80', 'G80', true),
    ('genesis', 'Genesis', 'gv60', 'gv60', 'GV60', true),
    ('genesis', 'Genesis', 'gv70', 'gv70', 'GV70', true),
    ('honda', 'Honda', 'civic', 'civic', 'Civic', false),
    ('honda', 'Honda', 'cr v', 'crv', 'CR-V', false),
    ('honda', 'Honda', 'crv', 'crv', 'CR-V', false),
    ('honda', 'Honda', 'e', 'hondae', 'Honda e', false),
    ('honda', 'Honda', 'e ny1', 'eny1', 'e:Ny1', true),
    ('honda', 'Honda', 'honda e', 'hondae', 'Honda e', false),
    ('honda', 'Honda', 'hr v', 'hrv', 'HR-V', false),
    ('honda', 'Honda', 'hrv', 'hrv', 'HR-V', false),
    ('honda', 'Honda', 'insight', 'insight', 'Insight', false),
    ('honda', 'Honda', 'jazz', 'jazz', 'Jazz', false),
    ('honda', 'Honda', 'jazz v gr', 'jazz', 'Jazz', false),
    ('hyundai', 'Hyundai', 'bayon', 'bayon', 'Bayon', false),
    ('hyundai', 'Hyundai', 'genesis', 'genesis', 'Genesis', false),
    ('hyundai', 'Hyundai', 'i20', 'i20', 'i20', true),
    ('hyundai', 'Hyundai', 'i30', 'i30', 'i30', true),
    ('hyundai', 'Hyundai', 'ioniq', 'ioniq', 'Ioniq', false),
    ('hyundai', 'Hyundai', 'ioniq 5', 'ioniq5', 'Ioniq 5', true),
    ('hyundai', 'Hyundai', 'ioniq 5 long range', 'ioniq5', 'Ioniq 5', true),
    ('hyundai', 'Hyundai', 'ioniq 5 n', 'ioniq5', 'Ioniq 5', true),
    ('hyundai', 'Hyundai', 'ioniq 5 ne', 'ioniq5', 'Ioniq 5', true),
    ('hyundai', 'Hyundai', 'ioniq 5 standard range', 'ioniq5', 'Ioniq 5', true),
    ('hyundai', 'Hyundai', 'ioniq 6', 'ioniq6', 'Ioniq 6', true),
    ('hyundai', 'Hyundai', 'ioniq ae', 'ioniq', 'Ioniq', false),
    ('hyundai', 'Hyundai', 'ioniq electric', 'ioniq', 'Ioniq', false),
    ('hyundai', 'Hyundai', 'ioniq hybrid', 'ioniq', 'Ioniq', false),
    ('hyundai', 'Hyundai', 'ioniq phev', 'ioniq', 'Ioniq', false),
    ('hyundai', 'Hyundai', 'ioniq premium', 'ioniq', 'Ioniq', false),
    ('hyundai', 'Hyundai', 'ioniq premium se bev', 'ioniq', 'Ioniq', false),
    ('hyundai', 'Hyundai', 'ioniq5', 'ioniq5', 'Ioniq 5', true),
    ('hyundai', 'Hyundai', 'ioniq6', 'ioniq6', 'Ioniq 6', true),
    ('hyundai', 'Hyundai', 'kona', 'kona', 'Kona', false),
    ('hyundai', 'Hyundai', 'kona 39 kwh', 'kona', 'Kona', true),
    ('hyundai', 'Hyundai', 'kona 64 kwh', 'kona', 'Kona', true),
    ('hyundai', 'Hyundai', 'kona electric', 'kona', 'Kona', false),
    ('hyundai', 'Hyundai', 'kona electric 64 kwh', 'kona', 'Kona', true),
    ('hyundai', 'Hyundai', 'kona electric os', 'kona', 'Kona', false),
    ('hyundai', 'Hyundai', 'kona ev', 'kona', 'Kona', false),
    ('hyundai', 'Hyundai', 'kona hybrid', 'kona', 'Kona', false),
    ('hyundai', 'Hyundai', 'santa fe', 'santafe', 'Santa Fe', false),
    ('hyundai', 'Hyundai', 'tucson', 'tucson', 'Tucson', false),
    ('jaguar', 'Jaguar', 'i pace', 'ipace', 'I-Pace', false),
    ('jaguar', 'Jaguar', 'ipace', 'ipace', 'I-Pace', false),
    ('jeep', 'Jeep', 'avenger', 'avenger', 'Avenger', false),
    ('jeep', 'Jeep', 'avenger 1 generation', 'avenger', 'Avenger', true),
    ('jeep', 'Jeep', 'compass', 'compass', 'Compass', false),
    ('jeep', 'Jeep', 'renegade', 'renegade', 'Renegade', false),
    ('kia', 'Kia', 'ceed', 'ceed', 'Ceed', false),
    ('kia', 'Kia', 'ceed ceed sw', 'ceed', 'Ceed', false),
    ('kia', 'Kia', 'ceed sw', 'ceed', 'Ceed', false),
    ('kia', 'Kia', 'e niro', 'niro', 'Niro', false),
    ('kia', 'Kia', 'e soul', 'soul', 'Soul', false),
    ('kia', 'Kia', 'ev3', 'ev3', 'EV3', true),
    ('kia', 'Kia', 'ev3 long range', 'ev3', 'EV3', true),
    ('kia', 'Kia', 'ev3 standard range', 'ev3', 'EV3', true),
    ('kia', 'Kia', 'ev4', 'ev4', 'EV4', true),
    ('kia', 'Kia', 'ev6', 'ev6', 'EV6', true),
    ('kia', 'Kia', 'ev6 cv', 'ev6', 'EV6', true),
    ('kia', 'Kia', 'ev6 gt', 'ev6', 'EV6', true),
    ('kia', 'Kia', 'ev6 long range', 'ev6', 'EV6', true),
    ('kia', 'Kia', 'ev6 standard range', 'ev6', 'EV6', true),
    ('kia', 'Kia', 'ev9', 'ev9', 'EV9', true),
    ('kia', 'Kia', 'ev9 long range', 'ev9', 'EV9', true),
    ('kia', 'Kia', 'kia soul', 'soul', 'Soul', false),
    ('kia', 'Kia', 'niro', 'niro', 'Niro', false),
    ('kia', 'Kia', 'niro 2', 'niro', 'Niro', true),
    ('kia', 'Kia', 'niro de', 'niro', 'Niro', false),
    ('kia', 'Kia', 'niro electric', 'niro', 'Niro', false),
    ('kia', 'Kia', 'niro ev', 'niro', 'Niro', false),
    ('kia', 'Kia', 'niro hybrid', 'niro', 'Niro', false),
    ('kia', 'Kia', 'niro ii', 'niro', 'Niro', false),
    ('kia', 'Kia', 'niro mk1', 'niro', 'Niro', true),
    ('kia', 'Kia', 'niro mk2', 'niro', 'Niro', true),
    ('kia', 'Kia', 'niro phev', 'niro', 'Niro', false),
    ('kia', 'Kia', 'niro sg2', 'niro', 'Niro', true),
    ('kia', 'Kia', 'optima', 'optima', 'Optima', false),
    ('kia', 'Kia', 'rio', 'rio', 'Rio', false),
    ('kia', 'Kia', 'sorento', 'sorento', 'Sorento', false),
    ('kia', 'Kia', 'soul', 'soul', 'Soul', false),
    ('kia', 'Kia', 'soul ev', 'soul', 'Soul', false),
    ('kia', 'Kia', 'sportage', 'sportage', 'Sportage', false),
    ('kia', 'Kia', 'sportage nq5', 'sportage', 'Sportage', true),
    ('kia', 'Kia', 'stonic', 'stonic', 'Stonic', false),
    ('kia', 'Kia', 'xceed', 'xceed', 'Xceed', false),
    ('landrover', 'Land Rover', 'defender', 'defender', 'Defender', false),
    ('landrover', 'Land Rover', 'evoque', 'evoque', 'Evoque', false),
    ('landrover', 'Land Rover', 'range rover sport', 'rangeroversport', 'Range Rover Sport', false),
    ('lexus', 'Lexus', 'ct', 'ct', 'CT', false),
    ('lexus', 'Lexus', 'ct 200h', 'ct', 'CT', true),
    ('lexus', 'Lexus', 'ct zwa10', 'ct', 'CT', true),
    ('lexus', 'Lexus', 'nx', 'nx', 'NX', false),
    ('lexus', 'Lexus', 'nx 350h', 'nx', 'NX', true),
    ('lexus', 'Lexus', 'nx 350h 450h', 'nx', 'NX', true),
    ('lexus', 'Lexus', 'rx', 'rx', 'RX', false),
    ('lexus', 'Lexus', 'rx series', 'rx', 'RX', false),
    ('lexus', 'Lexus', 'ux', 'ux', 'UX', false),
    ('lynkco', 'Lynk & Co', '01', '01', '01', false),
    ('lynkco', 'Lynk & Co', '1', '01', '01', false),
    ('lynkco', 'Lynk & Co', 'lynk o co 01', '01', '01', true),
    ('maxus', 'Maxus', 'deliver 3', 'edeliver3', 'e-Deliver 3', true),
    ('maxus', 'Maxus', 'deliver 9', 'edeliver9', 'e-Deliver 9', true),
    ('maxus', 'Maxus', 'e deliver 3', 'edeliver3', 'e-Deliver 3', true),
    ('maxus', 'Maxus', 'e deliver 9', 'edeliver9', 'e-Deliver 9', true),
    ('maxus', 'Maxus', 'e deliver3 ev30', 'edeliver3', 'e-Deliver 3', true),
    ('maxus', 'Maxus', 'ev80', 'ev80', 'EV80', true),
    ('mazda', 'Mazda', '2', '2', '2', false),
    ('mazda', 'Mazda', '2 kb hybrid', '2', '2', true),
    ('mazda', 'Mazda', '3', '3', '3', false),
    ('mazda', 'Mazda', 'cx 30', 'cx30', 'CX-30', true),
    ('mazda', 'Mazda', 'cx 30 dm', 'cx30', 'CX-30', true),
    ('mazda', 'Mazda', 'cx 5', 'cx5', 'CX-5', true),
    ('mazda', 'Mazda', 'cx 5 kf', 'cx5', 'CX-5', true),
    ('mazda', 'Mazda', 'cx 60', 'cx60', 'CX-60', true),
    ('mazda', 'Mazda', 'cx 60 kh', 'cx60', 'CX-60', true),
    ('mazda', 'Mazda', 'mazda 2', '2', '2', true),
    ('mazda', 'Mazda', 'mazda 3', '3', '3', true),
    ('mazda', 'Mazda', 'mazda2', '2', '2', true),
    ('mazda', 'Mazda', 'mazda3', '3', '3', true),
    ('mazda', 'Mazda', 'mx 30', 'mx30', 'MX-30', true),
    ('mercedesbenz', 'Mercedes-Benz', 'a class', 'aclass', 'A-Class', false),
    ('mercedesbenz', 'Mercedes-Benz', 'a class w177', 'aclass', 'A-Class', true),
    ('mercedesbenz', 'Mercedes-Benz', 'b 180 200 w246 w242', 'bclass', 'B-Class', true),
    ('mercedesbenz', 'Mercedes-Benz', 'b class', 'bclass', 'B-Class', false),
    ('mercedesbenz', 'Mercedes-Benz', 'c class', 'cclass', 'C-Class', false),
    ('mercedesbenz', 'Mercedes-Benz', 'c class w206', 'cclass', 'C-Class', true),
    ('mercedesbenz', 'Mercedes-Benz', 'c klasse', 'cclass', 'C-Class', false),
    ('mercedesbenz', 'Mercedes-Benz', 'cla', 'cla', 'CLA', false),
    ('mercedesbenz', 'Mercedes-Benz', 'cla class', 'cla', 'CLA', false),
    ('mercedesbenz', 'Mercedes-Benz', 'cla class c118 x118', 'cla', 'CLA', true),
    ('mercedesbenz', 'Mercedes-Benz', 'e class', 'eclass', 'E-Class', false),
    ('mercedesbenz', 'Mercedes-Benz', 'e class w213', 'eclass', 'E-Class', true),
    ('mercedesbenz', 'Mercedes-Benz', 'eq', 'eq', 'EQ', false),
    ('mercedesbenz', 'Mercedes-Benz', 'eqa', 'eqa', 'EQA', false),
    ('mercedesbenz', 'Mercedes-Benz', 'eqa h243', 'eqa', 'EQA', true),
    ('mercedesbenz', 'Mercedes-Benz', 'eqb', 'eqb', 'EQB', false),
    ('mercedesbenz', 'Mercedes-Benz', 'eqb x243', 'eqb', 'EQB', true),
    ('mercedesbenz', 'Mercedes-Benz', 'eqc', 'eqc', 'EQC', false),
    ('mercedesbenz', 'Mercedes-Benz', 'eqc 400', 'eqc', 'EQC', true),
    ('mercedesbenz', 'Mercedes-Benz', 'eqc 400 amg line premium 4matic', 'eqc', 'EQC', true),
    ('mercedesbenz', 'Mercedes-Benz', 'eqc n293', 'eqc', 'EQC', true),
    ('mercedesbenz', 'Mercedes-Benz', 'eqe', 'eqe', 'EQE', false),
    ('mercedesbenz', 'Mercedes-Benz', 'eqe v295', 'eqe', 'EQE', true),
    ('mercedesbenz', 'Mercedes-Benz', 'eqs', 'eqs', 'EQS', false),
    ('mercedesbenz', 'Mercedes-Benz', 'eqv', 'eqv', 'EQV', false),
    ('mercedesbenz', 'Mercedes-Benz', 'gla', 'gla', 'GLA', false),
    ('mercedesbenz', 'Mercedes-Benz', 'gla class h247', 'gla', 'GLA', true),
    ('mercedesbenz', 'Mercedes-Benz', 'glc', 'glc', 'GLC', false),
    ('mercedesbenz', 'Mercedes-Benz', 'glc class', 'glc', 'GLC', false),
    ('mercedesbenz', 'Mercedes-Benz', 'glc class x253 c253', 'glc', 'GLC', true),
    ('mercedesbenz', 'Mercedes-Benz', 'glc class x254', 'glc', 'GLC', true),
    ('mercedesbenz', 'Mercedes-Benz', 'gle', 'gle', 'GLE', false),
    ('mercedesbenz', 'Mercedes-Benz', 'gle class', 'gle', 'GLE', false),
    ('mercedesbenz', 'Mercedes-Benz', 'gle class w167 v167 c167', 'gle', 'GLE', true),
    ('mercedesbenz', 'Mercedes-Benz', 'gle w167', 'gle', 'GLE', true),
    ('mercedesbenz', 'Mercedes-Benz', 'sprinter', 'sprinter', 'Sprinter', false),
    ('mercedesbenz', 'Mercedes-Benz', 'sprinter 3 5 t van', 'sprinter', 'Sprinter', true),
    ('mercedesbenz', 'Mercedes-Benz', 'sprinter 3 5 t van 907 910', 'sprinter', 'Sprinter', true),
    ('mg', 'MG', '3', 'mg3', '3', false),
    ('mg', 'MG', '4', 'mg4', '4', false),
    ('mg', 'MG', '4 eh32', 'mg4', '4', true),
    ('mg', 'MG', '5', 'mg5', '5', false),
    ('mg', 'MG', 'ehs', 'hs', 'HS', false),
    ('mg', 'MG', 'hs', 'hs', 'HS', false),
    ('mg', 'MG', 'hs ehs', 'hs', 'HS', false),
    ('mg', 'MG', 'hs ehs as23', 'hs', 'HS', true),
    ('mg', 'MG', 'marvel r', 'marvelr', 'Marvel R', false),
    ('mg', 'MG', 'mg 3', 'mg3', '3', true),
    ('mg', 'MG', 'mg 4', 'mg4', '4', true),
    ('mg', 'MG', 'mg 5', 'mg5', '5', true),
    ('mg', 'MG', 'mg hs', 'hs', 'HS', false),
    ('mg', 'MG', 'mg zs ev', 'zsev', 'ZS EV', false),
    ('mg', 'MG', 'mg3', 'mg3', '3', true),
    ('mg', 'MG', 'mg4', 'mg4', '4', true),
    ('mg', 'MG', 'mg5', 'mg5', '5', true),
    ('mg', 'MG', 'zs', 'zsev', 'ZS EV', false),
    ('mg', 'MG', 'zs ev', 'zsev', 'ZS EV', false),
    ('mg', 'MG', 'zs hybrid', 'zsev', 'ZS EV', false),
    ('mitsubishi', 'Mitsubishi', 'eclipse cross', 'eclipsecross', 'Eclipse Cross', false),
    ('mitsubishi', 'Mitsubishi', 'i miev', 'imiev', 'i-MiEV', false),
    ('mitsubishi', 'Mitsubishi', 'imiev', 'imiev', 'i-MiEV', false),
    ('mitsubishi', 'Mitsubishi', 'mits outlander', 'outlander', 'Outlander', false),
    ('mitsubishi', 'Mitsubishi', 'outlander', 'outlander', 'Outlander', false),
    ('mitsubishi', 'Mitsubishi', 'outlander 2013 21', 'outlander', 'Outlander', true),
    ('mitsubishi', 'Mitsubishi', 'outlander iii gg w gf w zj', 'outlander', 'Outlander', false),
    ('mitsubishi', 'Mitsubishi', 'outlander phev', 'outlander', 'Outlander', false),
    ('nissan', 'Nissan', 'ariya', 'ariya', 'Ariya', false),
    ('nissan', 'Nissan', 'ariya fe0', 'ariya', 'Ariya', true),
    ('nissan', 'Nissan', 'e nv200', 'nv200', 'NV200', true),
    ('nissan', 'Nissan', 'envy200', 'nv200', 'NV200', true),
    ('nissan', 'Nissan', 'juke', 'juke', 'Juke', false),
    ('nissan', 'Nissan', 'leaf', 'leaf', 'Leaf', false),
    ('nissan', 'Nissan', 'leaf gen1', 'leaf', 'Leaf', true),
    ('nissan', 'Nissan', 'leaf gen2', 'leaf', 'Leaf', true),
    ('nissan', 'Nissan', 'leaf ze0', 'leaf', 'Leaf', true),
    ('nissan', 'Nissan', 'leaf ze1', 'leaf', 'Leaf', true),
    ('nissan', 'Nissan', 'leaf zeo', 'leaf', 'Leaf', false),
    ('nissan', 'Nissan', 'nissan leaf', 'leaf', 'Leaf', false),
    ('nissan', 'Nissan', 'nv 200', 'nv200', 'NV200', true),
    ('nissan', 'Nissan', 'nv200', 'nv200', 'NV200', true),
    ('nissan', 'Nissan', 'qashqai', 'qashqai', 'Qashqai', false),
    ('nissan', 'Nissan', 'townstar', 'townstar', 'Townstar', false),
    ('opel', 'Opel', 'ampera', 'ampera', 'Ampera', false),
    ('opel', 'Opel', 'ampera e', 'ampera', 'Ampera', false),
    ('opel', 'Opel', 'astra', 'astra', 'Astra', false),
    ('opel', 'Opel', 'combo', 'combo', 'Combo', false),
    ('opel', 'Opel', 'combo e', 'combo', 'Combo', false),
    ('opel', 'Opel', 'combo life', 'combo', 'Combo', false),
    ('opel', 'Opel', 'corsa', 'corsa', 'Corsa', false),
    ('opel', 'Opel', 'corsa e', 'corsa', 'Corsa', false),
    ('opel', 'Opel', 'corsa f', 'corsa', 'Corsa', false),
    ('opel', 'Opel', 'corsa f corsa e', 'corsa', 'Corsa', false),
    ('opel', 'Opel', 'mokka', 'mokka', 'Mokka', false),
    ('opel', 'Opel', 'mokka e', 'mokka', 'Mokka', false),
    ('opel', 'Opel', 'vivaro', 'vivaro', 'Vivaro', false),
    ('opel', 'Opel', 'vivaro c', 'vivaro', 'Vivaro', false),
    ('opel', 'Opel', 'vivaro e', 'vivaro', 'Vivaro', false),
    ('opel', 'Opel', 'zafira', 'zafira', 'Zafira', false),
    ('peugeot', 'Peugeot', '2008', '2008', '2008', true),
    ('peugeot', 'Peugeot', '208', '208', '208', true),
    ('peugeot', 'Peugeot', '208 e 208', '208', '208', true),
    ('peugeot', 'Peugeot', '208 ii ub up uw uj', '208', '208', true),
    ('peugeot', 'Peugeot', '208 mk2', '208', '208', true),
    ('peugeot', 'Peugeot', '208 peugeot 208', '208', '208', true),
    ('peugeot', 'Peugeot', '3008', '3008', '3008', true),
    ('peugeot', 'Peugeot', '308', '308', '308', true),
    ('peugeot', 'Peugeot', '5008', '5008', '5008', true),
    ('peugeot', 'Peugeot', '508', '508', '508', true),
    ('peugeot', 'Peugeot', 'boxer', 'boxer', 'Boxer', false),
    ('peugeot', 'Peugeot', 'e 208', '208', '208', true),
    ('peugeot', 'Peugeot', 'e expert', 'expert', 'Expert', false),
    ('peugeot', 'Peugeot', 'e partner', 'partner', 'Partner', false),
    ('peugeot', 'Peugeot', 'expert', 'expert', 'Expert', false),
    ('peugeot', 'Peugeot', 'expert furgon', 'expert', 'Expert', false),
    ('peugeot', 'Peugeot', 'partner', 'partner', 'Partner', false),
    ('peugeot', 'Peugeot', 'partner furgon', 'partner', 'Partner', false),
    ('peugeot', 'Peugeot', 'rifter', 'rifter', 'Rifter', false),
    ('polestar', 'Polestar', '2', '2', '2', false),
    ('polestar', 'Polestar', '3', '3', '3', false),
    ('polestar', 'Polestar', '4', '4', '4', false),
    ('polestar', 'Polestar', 'polestar 2', '2', '2', true),
    ('polestar', 'Polestar', 'polestar 2 2020', '2', '2', true),
    ('polestar', 'Polestar', 'polestar 3', '3', '3', true),
    ('polestar', 'Polestar', 'polestar 4', '4', '4', true),
    ('polestar', 'Polestar', 'polestar2', '2', '2', true),
    ('porsche', 'Porsche', 'cayenne', 'cayenne', 'Cayenne', false),
    ('porsche', 'Porsche', 'cayenne e hybrid', 'cayenne', 'Cayenne', false),
    ('porsche', 'Porsche', 'macan', 'macan', 'Macan', false),
    ('porsche', 'Porsche', 'panamera', 'panamera', 'Panamera', false),
    ('porsche', 'Porsche', 'panamera 971', 'panamera', 'Panamera', true),
    ('porsche', 'Porsche', 'taycan', 'taycan', 'Taycan', false),
    ('porsche', 'Porsche', 'taycan 4s', 'taycan', 'Taycan', true),
    ('porsche', 'Porsche', 'taycan turbo', 'taycan', 'Taycan', false),
    ('proterra', 'Proterra', 'onyx strata h4 15', 'onyxstratah415', 'Onyx Strata H4-15', true),
    ('renault', 'Renault', 'arkana', 'arkana', 'Arkana', false),
    ('renault', 'Renault', 'austral', 'austral', 'Austral', false),
    ('renault', 'Renault', 'captur', 'captur', 'Captur', false),
    ('renault', 'Renault', 'captur e tech plug in', 'captur', 'Captur', false),
    ('renault', 'Renault', 'clio', 'clio', 'Clio', false),
    ('renault', 'Renault', 'clio e tech', 'clio', 'Clio', false),
    ('renault', 'Renault', 'kangoo', 'kangoo', 'Kangoo', false),
    ('renault', 'Renault', 'kangoo e tech', 'kangoo', 'Kangoo', false),
    ('renault', 'Renault', 'kangoo express', 'kangoo', 'Kangoo', false),
    ('renault', 'Renault', 'kangoo gen1', 'kangoo', 'Kangoo', true),
    ('renault', 'Renault', 'kangoo ii', 'kangoo', 'Kangoo', false),
    ('renault', 'Renault', 'kangoo ze', 'kangoo', 'Kangoo', false),
    ('renault', 'Renault', 'master', 'master', 'Master', false),
    ('renault', 'Renault', 'master ze', 'master', 'Master', false),
    ('renault', 'Renault', 'megane', 'megane', 'Megane', false),
    ('renault', 'Renault', 'megane break', 'megane', 'Megane', false),
    ('renault', 'Renault', 'megane e tech', 'megane', 'Megane', false),
    ('renault', 'Renault', 'twingo', 'twingo', 'Twingo', false),
    ('renault', 'Renault', 'twingo ze', 'twingo', 'Twingo', false),
    ('renault', 'Renault', 'ze', 'ze', 'ZE', false),
    ('renault', 'Renault', 'zoe', 'zoe', 'Zoe', false),
    ('renault', 'Renault', 'zoe 2', 'zoe', 'Zoe', true),
    ('renault', 'Renault', 'zoe bfm', 'zoe', 'Zoe', false),
    ('renault', 'Renault', 'zoe e tech', 'zoe', 'Zoe', false),
    ('renault', 'Renault', 'zoe r110', 'zoe', 'Zoe', true),
    ('renault', 'Renault', 'zoe r135', 'zoe', 'Zoe', true),
    ('renault', 'Renault', 'zoe r90', 'zoe', 'Zoe', true),
    ('renault', 'Renault', 'zoe z e', 'zoe', 'Zoe', false),
    ('renault', 'Renault', 'zoe ze', 'zoe', 'Zoe', false),
    ('rivian', 'Rivian', 'r1s', 'r1s', 'R1S', true),
    ('rivian', 'Rivian', 'r1t', 'r1t', 'R1T', true),
    ('seat', 'Seat', 'leon', 'leon', 'Leon', false),
    ('seat', 'Seat', 'mii', 'mii', 'Mii', false),
    ('seat', 'Seat', 'mii electric', 'mii', 'Mii', false),
    ('skoda', 'Skoda', 'elroq', 'elroq', 'Elroq', false),
    ('skoda', 'Skoda', 'enyaq', 'enyaq', 'Enyaq', false),
    ('skoda', 'Skoda', 'enyaq iv', 'enyaq', 'Enyaq', false),
    ('skoda', 'Skoda', 'enyaq iv 60', 'enyaq', 'Enyaq', true),
    ('skoda', 'Skoda', 'enyaq iv 80', 'enyaq', 'Enyaq', true),
    ('skoda', 'Skoda', 'kodiaq', 'kodiaq', 'Kodiaq', false),
    ('skoda', 'Skoda', 'octavia', 'octavia', 'Octavia', false),
    ('skoda', 'Skoda', 'superb', 'superb', 'Superb', false),
    ('skoda', 'Skoda', 'superb iv', 'superb', 'Superb', false),
    ('smart', 'Smart', 'eq forfour', 'eqfortwo', 'EQ Fortwo', false),
    ('smart', 'Smart', 'eq fortwo', 'eqfortwo', 'EQ Fortwo', false),
    ('subaru', 'Subaru', 'forester', 'forester', 'Forester', false),
    ('subaru', 'Subaru', 'solterra', 'solterra', 'Solterra', false),
    ('suzuki', 'Suzuki', 'across', 'across', 'Across', false),
    ('suzuki', 'Suzuki', 'ignis', 'ignis', 'Ignis', false),
    ('suzuki', 'Suzuki', 's cross', 'scross', 'S-Cross', false),
    ('suzuki', 'Suzuki', 'swace', 'swace', 'Swace', false),
    ('suzuki', 'Suzuki', 'swift', 'swift', 'Swift', false),
    ('suzuki', 'Suzuki', 'sx4 s cross', 'scross', 'S-Cross', true),
    ('suzuki', 'Suzuki', 'vitara', 'vitara', 'Vitara', false),
    ('tesla', 'Tesla', 'cybertruck', 'cybertruck', 'Cybertruck', false),
    ('tesla', 'Tesla', 'megapack', 'megapack', 'Megapack', false),
    ('tesla', 'Tesla', 'megapack 2', 'megapack', 'Megapack', true),
    ('tesla', 'Tesla', 'model 3', 'model3', 'Model 3', true),
    ('tesla', 'Tesla', 'model s', 'models', 'Model S', false),
    ('tesla', 'Tesla', 'model three', 'model3', 'Model 3', false),
    ('tesla', 'Tesla', 'model x', 'modelx', 'Model X', false),
    ('tesla', 'Tesla', 'model y', 'modely', 'Model Y', false),
    ('tesla', 'Tesla', 'powerpack', 'powerpack', 'Powerpack', false),
    ('tesla', 'Tesla', 'powerwall', 'powerwall', 'Powerwall', false),
    ('tesla', 'Tesla', 'powerwall 2', 'powerwall', 'Powerwall', true),
    ('tesla', 'Tesla', 'powerwall 3', 'powerwall', 'Powerwall', true),
    ('toyota', 'Toyota', 'auris', 'auris', 'Auris', false),
    ('toyota', 'Toyota', 'aygo', 'aygo', 'Aygo', false),
    ('toyota', 'Toyota', 'bz4x', 'bz4x', 'bZ4X', true),
    ('toyota', 'Toyota', 'bz4x ea10', 'bz4x', 'bZ4X', true),
    ('toyota', 'Toyota', 'c hr', 'chr', 'C-HR', false),
    ('toyota', 'Toyota', 'camry', 'camry', 'Camry', false),
    ('toyota', 'Toyota', 'chr', 'chr', 'C-HR', false),
    ('toyota', 'Toyota', 'corolla', 'corolla', 'Corolla', false),
    ('toyota', 'Toyota', 'corolla cross', 'corollacross', 'Corolla Cross', false),
    ('toyota', 'Toyota', 'corolla cross xg10', 'corollacross', 'Corolla Cross', true),
    ('toyota', 'Toyota', 'corolla hybrid', 'corolla', 'Corolla', false),
    ('toyota', 'Toyota', 'prius', 'prius', 'Prius', false),
    ('toyota', 'Toyota', 'prius', 'prius', 'Prius+', false),
    ('toyota', 'Toyota', 'prius 50', 'prius', 'Prius', true),
    ('toyota', 'Toyota', 'prius 7', 'prius', 'Prius+', true),
    ('toyota', 'Toyota', 'prius hybrid', 'prius', 'Prius', false),
    ('toyota', 'Toyota', 'prius plus', 'prius', 'Prius+', false),
    ('toyota', 'Toyota', 'prius w3', 'prius', 'Prius', true),
    ('toyota', 'Toyota', 'prius zvw30', 'prius', 'Prius', true),
    ('toyota', 'Toyota', 'prius zvw40', 'prius', 'Prius+', true),
    ('toyota', 'Toyota', 'prius zvw50', 'prius', 'Prius', true),
    ('toyota', 'Toyota', 'proace', 'proace', 'Proace', false),
    ('toyota', 'Toyota', 'proace city', 'proace', 'Proace', false),
    ('toyota', 'Toyota', 'proace city verso mpv bky', 'proace', 'Proace', false),
    ('toyota', 'Toyota', 'proace electric', 'proace', 'Proace', false),
    ('toyota', 'Toyota', 'proace ii', 'proace', 'Proace', false),
    ('toyota', 'Toyota', 'proace verso', 'proace', 'Proace', false),
    ('toyota', 'Toyota', 'rav 4', 'rav4', 'RAV4', true),
    ('toyota', 'Toyota', 'rav 4 prime', 'rav4', 'RAV4', true),
    ('toyota', 'Toyota', 'rav4', 'rav4', 'RAV4', true),
    ('toyota', 'Toyota', 'rav4 plug in', 'rav4', 'RAV4', true),
    ('toyota', 'Toyota', 'rav4 plug in prime', 'rav4', 'RAV4', true),
    ('toyota', 'Toyota', 'rav4 xa50', 'rav4', 'RAV4', true),
    ('toyota', 'Toyota', 'swace', 'swace', 'Swace', false),
    ('toyota', 'Toyota', 'yaris', 'yaris', 'Yaris', false),
    ('toyota', 'Toyota', 'yaris cross', 'yariscross', 'Yaris Cross', false),
    ('toyota', 'Toyota', 'yaris cross mxp', 'yariscross', 'Yaris Cross', false),
    ('toyota', 'Toyota', 'yaris cross suv', 'yariscross', 'Yaris Cross', false),
    ('toyota', 'Toyota', 'yaris cross xp21', 'yariscross', 'Yaris Cross', true),
    ('toyota', 'Toyota', 'yaris hybrid', 'yaris', 'Yaris', false),
    ('toyota', 'Toyota', 'yaris p21', 'yaris', 'Yaris', true),
    ('toyota', 'Toyota', 'yaris xp21', 'yaris', 'Yaris', true),
    ('volkswagen', 'Volkswagen', 'e golf', 'egolf', 'e-Golf', false),
    ('volkswagen', 'Volkswagen', 'e golf vii', 'egolf', 'e-Golf', false),
    ('volkswagen', 'Volkswagen', 'e up', 'eup', 'e-Up', false),
    ('volkswagen', 'Volkswagen', 'egolf', 'egolf', 'e-Golf', false),
    ('volkswagen', 'Volkswagen', 'golf', 'golf', 'Golf', false),
    ('volkswagen', 'Volkswagen', 'golf e golf vii', 'egolf', 'e-Golf', false),
    ('volkswagen', 'Volkswagen', 'golf gte', 'golf', 'Golf', false),
    ('volkswagen', 'Volkswagen', 'golf vii', 'golf', 'Golf', false),
    ('volkswagen', 'Volkswagen', 'golf viii', 'golf', 'Golf', false),
    ('volkswagen', 'Volkswagen', 'id 3', 'id3', 'ID.3', true),
    ('volkswagen', 'Volkswagen', 'id 3 e11', 'id3', 'ID.3', true),
    ('volkswagen', 'Volkswagen', 'id 4', 'id4', 'ID.4', true),
    ('volkswagen', 'Volkswagen', 'id 5', 'id5', 'ID.5', true),
    ('volkswagen', 'Volkswagen', 'id 7', 'id7', 'ID.7', true),
    ('volkswagen', 'Volkswagen', 'id 7 tourer', 'id7', 'ID.7', true),
    ('volkswagen', 'Volkswagen', 'id buzz', 'idbuzz', 'ID. Buzz', false),
    ('volkswagen', 'Volkswagen', 'id3', 'id3', 'ID.3', true),
    ('volkswagen', 'Volkswagen', 'id4', 'id4', 'ID.4', true),
    ('volkswagen', 'Volkswagen', 'id5', 'id5', 'ID.5', true),
    ('volkswagen', 'Volkswagen', 'id7', 'id7', 'ID.7', true),
    ('volkswagen', 'Volkswagen', 'idbuzz', 'idbuzz', 'ID. Buzz', false),
    ('volkswagen', 'Volkswagen', 'passat', 'passat', 'Passat', false),
    ('volkswagen', 'Volkswagen', 'passat gte', 'passat', 'Passat', false),
    ('volkswagen', 'Volkswagen', 'tayron', 'tayron', 'Tayron', false),
    ('volkswagen', 'Volkswagen', 'tiguan', 'tiguan', 'Tiguan', false),
    ('volkswagen', 'Volkswagen', 'tiguan ehybrid', 'tiguan', 'Tiguan', false),
    ('volkswagen', 'Volkswagen', 'up', 'eup', 'e-Up', false),
    ('volkswagen', 'Volkswagen', 'up e up', 'eup', 'e-Up', false),
    ('volvo', 'Volvo', 'c40', 'c40', 'C40', true),
    ('volvo', 'Volvo', 'c40 recharge', 'c40', 'C40', true),
    ('volvo', 'Volvo', 'c40 recharge 21', 'c40', 'C40', true),
    ('volvo', 'Volvo', 'ex30', 'ex30', 'EX30', true),
    ('volvo', 'Volvo', 'ex30 2024', 'ex30', 'EX30', true),
    ('volvo', 'Volvo', 'ex90', 'ex90', 'EX90', true),
    ('volvo', 'Volvo', 's90', 's90', 'S90', true),
    ('volvo', 'Volvo', 'v60', 'v60', 'V60', true),
    ('volvo', 'Volvo', 'v60 18', 'v60', 'V60', true),
    ('volvo', 'Volvo', 'v60 19', 'v60', 'V60', true),
    ('volvo', 'Volvo', 'v60 2014 18', 'v60', 'V60', true),
    ('volvo', 'Volvo', 'v90', 'v90', 'V90', true),
    ('volvo', 'Volvo', 'v90 cc', 'v90', 'V90', true),
    ('volvo', 'Volvo', 'v90 v90 cc s90', 'v90', 'V90', true),
    ('volvo', 'Volvo', 'xc40', 'xc40', 'XC40', true),
    ('volvo', 'Volvo', 'xc40 536', 'xc40', 'XC40', true),
    ('volvo', 'Volvo', 'xc40 recharge', 'xc40', 'XC40', true),
    ('volvo', 'Volvo', 'xc40 recharge 18', 'xc40', 'XC40', true),
    ('volvo', 'Volvo', 'xc60', 'xc60', 'XC60', true),
    ('volvo', 'Volvo', 'xc60 18', 'xc60', 'XC60', true),
    ('volvo', 'Volvo', 'xc90', 'xc90', 'XC90', true),
    ('xpeng', 'Xpeng', 'g6', 'g6', 'G6', false),
    ('xpeng', 'Xpeng', 'g9', 'g9', 'G9', false),
    ('xpeng', 'Xpeng', 'p7', 'p7', 'P7', false),
    ('xpeng', 'Xpeng', 'xpeng p7', 'p7', 'P7', true)
  ) a(own, make, alias, slug, name, alone) order by length(alias) desc, alias
  loop
    if (r.own = any(hints) or r.alone) and position(' ' || r.alias || ' ' in words) > 0
       and not exists (select 1 from jsonb_array_elements(found) f where f->>'slug' = r.slug and f->>'make' = r.make) then
      found := found || jsonb_build_array(jsonb_build_object('make', r.make, 'model', r.name, 'slug', r.slug));
    end if;
  end loop;
  return found;
end $fn$;
;

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

-- A make that builds vehicles, groups included ("Hyundai or Kia", "VW Group"). A battery system is not theirs. Mirrors isVehicleMake().
create or replace function buyer_interest_is_vehicle_make(p_make text) returns boolean language sql immutable as $$
  select coalesce(exists (
    select 1 from unnest(regexp_split_to_array(regexp_replace(buyer_interest_unaccent(p_make), '[^a-z0-9]+', ' ', 'g'), '\s+')) w
    where w in ('volkswagen', 'vw', 'audi', 'mini', 'skoda', 'cupra', 'porsche', 'bmw', 'mercedes', 'benz', 'tesla', 'stellantis',
      'nissan', 'renault', 'dacia', 'peugeot', 'citroen', 'opel', 'vauxhall', 'fiat', 'jeep', 'ford', 'hyundai', 'kia', 'genesis',
      'toyota', 'lexus', 'honda', 'mazda', 'mitsubishi', 'suzuki', 'subaru', 'volvo', 'polestar', 'jaguar', 'mg', 'saic', 'lotus',
      'lucid', 'rivian', 'nio', 'xpeng', 'zeekr', 'leapmotor', 'maxus', 'smart', 'seat', 'jlr', 'gm', 'ds', 'lynk')), false)
$$;

-- Products a free text states as pairs ("Toyota Proace 50 kWh NMC + Stellantis 52 kWh LFP"): each listed make starts a
-- segment that runs to the next make; a segment gives its model (the words after the make up to a figure or a chemistry),
-- its kWh and its chemistry. Returned only when every make appears once, every segment states at most one chemistry
-- and each stated chemistry is one the row lists; otherwise null (the pairing is not stated, so none is guessed).
create or replace function buyer_interest_text_pairs(p_text text, p_makes text[], p_chemists text[]) returns jsonb
language plpgsql immutable as $$
declare
  txt text := buyer_interest_unaccent(p_text);
  real_makes text[];
  m text;
  pos int[] := '{}';
  p int;
  order_ text[];
  i int;
  seg text;
  nxt int;
  chem text;
  chems text[];
  kwh_ text;
  model_ text;
  out_ jsonb := '[]'::jsonb;
begin
  if txt is null or btrim(txt) = '' then return null; end if;
  select array_agg(x) into real_makes from unnest(p_makes) x where x is not null;
  if coalesce(cardinality(real_makes), 0) < 2 then return null; end if;
  -- every make once, in text order
  select array_agg(mk order by ps) into order_ from (
    select x as mk, (regexp_match(txt, '\y' || regexp_replace(buyer_interest_unaccent(x), '[^a-z0-9 ]+', '', 'g') || '\y'))[1] as hit,
           strpos(txt, regexp_replace(buyer_interest_unaccent(x), '[^a-z0-9 ]+', '', 'g')) as ps
    from unnest(real_makes) x) t where ps > 0;
  if order_ is null or cardinality(order_) <> cardinality(real_makes) then return null; end if;
  for i in 1..cardinality(order_) loop
    p := strpos(txt, regexp_replace(buyer_interest_unaccent(order_[i]), '[^a-z0-9 ]+', '', 'g'));
    nxt := case when i < cardinality(order_)
      then strpos(txt, regexp_replace(buyer_interest_unaccent(order_[i + 1]), '[^a-z0-9 ]+', '', 'g')) else length(txt) + 1 end;
    seg := substr(txt, p, nxt - p);
    if strpos(substr(txt, p + 1), regexp_replace(buyer_interest_unaccent(order_[i]), '[^a-z0-9 ]+', '', 'g')) > 0
       and strpos(substr(txt, p + 1), regexp_replace(buyer_interest_unaccent(order_[i]), '[^a-z0-9 ]+', '', 'g')) < nxt - p then
      return null;  -- the make is named twice in its own segment: not a clean pairing
    end if;
    select array_agg(distinct c) into chems from (
      select buyer_interest_chemistry(w) as c from regexp_split_to_table(seg, '[^a-z0-9]+') w) x where c is not null;
    if coalesce(cardinality(chems), 0) > 1 then return null; end if;
    chem := chems[1];
    if chem is not null and not exists (select 1 from unnest(p_chemists) pc where buyer_interest_chemistry(pc) = chem) then
      return null;
    end if;
    kwh_ := (regexp_match(seg, '([0-9]+(?:\.[0-9]+)?)\s*kwh'))[1];
    model_ := nullif(btrim(regexp_replace((regexp_match(substr(seg, length(regexp_replace(buyer_interest_unaccent(order_[i]), '[^a-z0-9 ]+', '', 'g')) + 1),
      '^\s*([a-z][a-z0-9-]*(?:\s+[a-z][a-z0-9-]*)?)'))[1], '\y(nmc|lfp|nca|lto|kwh|packs?|modules?|cells?|systems?|and|or)\y.*$', '', 'g')), '');
    out_ := out_ || jsonb_build_array(jsonb_strip_nulls(jsonb_build_object('make', order_[i], 'model', model_, 'kwh', kwh_::numeric,
      'chemistry', chem)));
  end loop;
  return out_;
end $$;

-- What a source states that a product key cannot hold: every part number, cell maker and cell format, and the pack
-- voltage. Written on every line of the source, so none of it is lost when the key falls back to a broader level (R6).
create or replace function buyer_interest_stated(p_spec jsonb, p_context jsonb, p_fields jsonb, p_product jsonb default null)
returns jsonb language sql immutable as $$
  select nullif(jsonb_strip_nulls(jsonb_build_object(
    'cell_makers', to_jsonb(nullif(buyer_interest_stated_list(coalesce(p_product->'cell_makers', p_spec->'cell_makers'),
       buyer_interest_first_text(coalesce(p_product->'cell_maker', p_spec->'cell_maker')), buyer_interest_first_text(p_context->'cell_maker')),
       array[null]::text[])),
    'cell_formats', to_jsonb(nullif(buyer_interest_stated_list(coalesce(p_product->'cell_formats', p_spec->'cell_formats'),
       buyer_interest_first_text(coalesce(p_product->'cell_format', p_spec->'cell_format')), buyer_interest_first_text(p_context->'cell_format')),
       array[null]::text[])),
    'part_numbers', case when jsonb_typeof(coalesce(p_product->'part_numbers', p_spec->'part_numbers', p_spec->'partNumbers',
        p_context->'part_numbers', p_fields->'part_numbers')) = 'array'
      then coalesce(p_product->'part_numbers', p_spec->'part_numbers', p_spec->'partNumbers', p_context->'part_numbers', p_fields->'part_numbers') end,
    'min_pack_voltage', coalesce(buyer_interest_number(p_spec->'min_pack_voltage'), buyer_interest_number(p_spec->'pack_voltage'),
       buyer_interest_number(p_spec->'voltage_v'), buyer_interest_number(p_spec->'voltage'), buyer_interest_number(p_context->'min_pack_voltage'),
       buyer_interest_number(p_context->'voltage_v'), buyer_interest_number(p_fields->'voltage_v'), buyer_interest_number(p_fields->'voltage_nominal'))
  )), '{}'::jsonb)
$$;

-- Which of two lines of one source says less: a line is redundant when another line is at a more specific level and
-- states everything it does (R4). Level order: part, model + kWh, model, cell, broad.
create or replace function buyer_interest_key_rank(key text) returns int language sql immutable as $$
  select case when key like 'part:%' then 1 when key like 'pack:%' then 2
    when key like 'model:%' and key ~ '-[0-9]+(\.[0-9]+)?kwh$' then 3 when key like 'model:%' then 4
    when key like 'cell:%' then 5 else 6 end
$$;

create or replace function buyer_interest_drop_redundant(p_sets jsonb[]) returns jsonb[] language sql immutable as $$
  select coalesce(array_agg(a order by buyer_interest_key_rank(buyer_interest_product_key(a)), a::text), '{}')
  from unnest(p_sets) a
  where not exists (
    select 1 from unnest(p_sets) b
    where buyer_interest_key_rank(buyer_interest_product_key(b)) < buyer_interest_key_rank(buyer_interest_product_key(a))
      -- Only the SAME product is redundant: same make (both none counts) and, for a broad or cell line, the same format.
      -- A broad line a source states on its own (packs, modules and cells; Packs and modules) is the buyer's breadth and
      -- stays next to model lines of another make or format.
      and buyer_interest_make(a->>'make') is not distinct from buyer_interest_make(b->>'make')
      and (buyer_interest_key_rank(buyer_interest_product_key(a)) < 5
           or buyer_interest_format(a->>'format') is not distinct from buyer_interest_format(b->>'format'))
      and (buyer_interest_key_rank(buyer_interest_product_key(a)) >= 5
           or (buyer_interest_model_slug(a->>'make', a->>'model') = buyer_interest_model_slug(b->>'make', b->>'model')
               and buyer_interest_make(a->>'make') = buyer_interest_make(b->>'make')))
      and (buyer_interest_key_rank(buyer_interest_product_key(a)) < 5
           or ((buyer_interest_chemistry(a->>'chemistry') is null or buyer_interest_chemistry(a->>'chemistry') = buyer_interest_chemistry(b->>'chemistry'))
               and (buyer_interest_format(a->>'format') is null or buyer_interest_format(a->>'format') = buyer_interest_format(b->>'format'))
               and (buyer_interest_model_slug(a->>'make', a->>'model') is null
                    or buyer_interest_model_slug(a->>'make', a->>'model') = buyer_interest_model_slug(b->>'make', b->>'model'))))
      -- a part-level line replaces a broader one only when nothing in the broader one is left unsaid
      and (buyer_interest_key_rank(buyer_interest_product_key(b)) > 1 or buyer_interest_key_rank(buyer_interest_product_key(a)) >= 5)
  )
$$;

-- The model with a make-stated model key: the canonical slug from the alias list, so "Kona Electric" and "Kona" are one.
-- (buyer_interest_model_slug is generated from apps/web/lib/match/model-aliases.json by scripts/rebattery/model_aliases.py --sql.)

-- A text that is a model name but not a prose list: raw_product keeps only what the key could not.
create or replace function buyer_interest_raw_product(facts jsonb) returns text language sql immutable as $$
  select coalesce(
    case when buyer_interest_prose_model(facts->>'model') and buyer_interest_model_slug(facts->>'make', facts->>'model') is null
      then btrim(facts->>'model') end,
    (select min(btrim(part)) from jsonb_array_elements_text(
       case when jsonb_typeof(facts->'part_numbers') = 'array' then facts->'part_numbers' else '[]'::jsonb end) part
      where buyer_interest_part(part) is null and nullif(btrim(part), '') is not null))
$$;

create or replace function buyer_interest_product_key(facts jsonb) returns text language sql immutable as $$
  with kwh as (
    select coalesce(buyer_interest_number(facts->'kwh'),
      case when facts->>'kwh_min' is not null and facts->>'kwh_min' = facts->>'kwh_max'
        then buyer_interest_number(facts->'kwh_min') end) as value
  ), part as (
    select 'part:' || buyer_interest_part(part) as key
    from jsonb_array_elements_text(coalesce(facts->'part_numbers', '[]'::jsonb)) part
    where buyer_interest_part(part) is not null
    order by 1 limit 1
  ), model as (
    select buyer_interest_model_slug(facts->>'make', facts->>'model') as slug
  )
  select coalesce(
    (select key from part),
    case when buyer_interest_make(facts->>'make') is not null and (select slug from model) is not null
        and (select value from kwh) is not null
      then 'model:' || buyer_interest_make(facts->>'make') || '-' || (select slug from model) || '-'
        || buyer_interest_kwh_text((select value from kwh)) || 'kwh' end,
    case when buyer_interest_slug(facts->>'cell_maker') is not null
        and buyer_interest_slug(facts->>'model') is not null
        and not buyer_interest_prose_model(facts->>'model')
      then 'cell:' || buyer_interest_slug(facts->>'cell_maker') || '-' || buyer_interest_slug(facts->>'model') end,
    -- A model with no single kWh figure (none stated, or a range) covers every pack size of that model.
    case when buyer_interest_make(facts->>'make') is not null and (select slug from model) is not null
        and (select value from kwh) is null
      then 'model:' || buyer_interest_make(facts->>'make') || '-' || (select slug from model) end,
    -- A stated make scopes the key; with no make, a stated cell maker does (broad:calb-lfp-cells), so a cell or module ask
    -- keeps who makes the cells, and with neither, a stated cell format does (broad:18650-any-cells).
    'broad:' || coalesce(buyer_interest_make(facts->>'make') || '-', buyer_interest_slug(facts->>'cell_maker') || '-',
        buyer_interest_slug(facts->>'cell_format') || '-', '')
      || coalesce(buyer_interest_slug(buyer_interest_chemistry(facts->>'chemistry')), 'any') || '-'
      || case buyer_interest_format(facts->>'format')
           when 'pack' then 'packs' when 'module' then 'modules' when 'cell' then 'cells' when 'system' then 'systems'
           else 'batteries' end
  )
$$;

-- ---------------------------------------------------------------------------
-- What a request's own words state (conformance R8/R9): a row that lacks makes, models, kWh, cell formats or cell
-- makers in its spec still states them in product_family and the summary. Only stated values are taken; a spec value
-- always wins.
-- ---------------------------------------------------------------------------

-- A price unit the table accepts: kWh, pack or cell. Anything else (a lot, a batch, a dangling "/") is no unit.
create or replace function buyer_interest_price_unit(p_unit text) returns text language sql immutable as $$
  select case regexp_replace(lower(btrim(coalesce(p_unit, ''))), '^[\s/]+|[\s/]+$|^per\s+', '', 'g')
    when 'kwh' then 'kWh' when 'pack' then 'pack' when 'packs' then 'pack' when 'cell' then 'cell' when 'cells' then 'cell'
    else null end
$$;

-- Reviewed cell makers (scripts/rebattery/buyer_dossier.py CELL_MAKERS + EXTRA_CELL_MAKERS) a text names as words.
create or replace function buyer_interest_text_cell_makers(p_text text) returns text[] language sql immutable as $$
  select coalesce(array_agg(m.name order by m.name), '{}') from (values ('AESC'), ('BYD'), ('CALB'), ('CATL'), ('EVE'),
    ('Farasis'), ('Gotion'), ('Kokam'), ('LG'), ('Lishen'), ('Northvolt'), ('Panasonic'), ('Samsung SDI'), ('SK On'), ('Svolt')) m(name)
  where position(' ' || btrim(regexp_replace(buyer_interest_unaccent(m.name), '[^a-z0-9]+', ' ', 'g')) || ' ' in
    ' ' || btrim(regexp_replace(buyer_interest_unaccent(p_text), '[^a-z0-9]+', ' ', 'g')) || ' ') > 0
$$;

-- Makes a text names: vehicle makes and the system makers a request names (CATL, FPT).
create or replace function buyer_interest_text_makes(p_text text) returns text[] language sql immutable as $$
  select coalesce(array_agg(distinct case when m in ('bmw', 'mg', 'byd', 'nio', 'catl', 'fpt') then upper(m) when m = 'vw' then 'Volkswagen'
      else initcap(m) end), '{}')
  from (select (regexp_matches(buyer_interest_unaccent(p_text),
    '\y(volkswagen|vw|audi|mini|skoda|cupra|porsche|bmw|mercedes-benz|mercedes|tesla|stellantis|nissan|renault|dacia|peugeot|citroen|opel|vauxhall|fiat|jeep|ford|hyundai|kia|genesis|toyota|lexus|honda|mazda|mitsubishi|suzuki|subaru|volvo|polestar|jaguar|land rover|mg|byd|lotus|lucid|rivian|nio|xpeng|zeekr|leapmotor|maxus|chevrolet|catl|fpt|sungrow|huawei)\y', 'g'))[1] as m) found
$$;

-- One quantity a text states ("10 packs", "100,000 cells"): only when the text states exactly one. A cell format is not a quantity.
create or replace function buyer_interest_text_quantity(p_text text) returns jsonb language plpgsql immutable as $fn$
declare
  m text[];
  raw text;
  v numeric;
  found jsonb := '[]'::jsonb;
  item jsonb;
begin
  for m in select regexp_matches(buyer_interest_unaccent(p_text),
      '(?:^|[^a-z0-9])(?:(model|id|ev|gen|series|type|class|kona|leaf)\s+)?(\d{1,3}(?:[,.]\d{3})+|\d+)\s*(?:x\s*)?(?:single\s+)?(packs?|modules?|cells?|units?|pcs|pieces|systems?|vehicles?)\y', 'g')
  loop
    continue when m[1] is not null;
    raw := m[2];
    continue when raw in ('18650', '21700', '4680', '26650', '46800');
    v := case when raw ~ '^\d{1,3}([,.]\d{3})+$' then replace(replace(raw, ',', ''), '.', '')::numeric else raw::numeric end;
    continue when v <= 0;
    item := jsonb_build_object('quantity', v, 'unit', case when m[3] in ('pcs', 'pieces') then 'pieces' else regexp_replace(m[3], 's$', '') || 's' end);
    if not found @> jsonb_build_array(item) then found := found || jsonb_build_array(item); end if;
  end loop;
  return case when jsonb_array_length(found) = 1 then found->0 end;
end $fn$;

-- One price a text states ("EUR 2,500", "£3,000 per pack"): amount, currency and a unit only when the text gives one.
create or replace function buyer_interest_text_price(p_text text) returns jsonb language plpgsql immutable as $fn$
declare
  m text[];
  amount numeric;
  found jsonb := '[]'::jsonb;
  item jsonb;
  cur text;
begin
  for m in select regexp_matches(buyer_interest_unaccent(p_text),
      '(€|£|\$|\yeur\y|\ygbp\y|\yusd\y)\s?(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)(?:\s?(?:/|per)\s?(kwh|packs?|cells?)\y)?|(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\s?(€|£|\$|\yeur\y|\ygbp\y|\yusd\y)(?:\s?(?:/|per)\s?(kwh|packs?|cells?)\y)?', 'g')
  loop
    cur := coalesce(m[1], m[5]);
    amount := replace(coalesce(m[2], m[4]), ',', '')::numeric;
    continue when amount <= 0;
    item := jsonb_build_object('price', amount,
      'currency', case when cur in ('€', 'eur') then 'EUR' when cur in ('£', 'gbp') then 'GBP' else 'USD' end,
      'unit', buyer_interest_price_unit(coalesce(m[3], m[6])));
    if not found @> jsonb_build_array(item) then found := found || jsonb_build_array(item); end if;
  end loop;
  return case when jsonb_array_length(found) = 1 then found->0 end;
end $fn$;

-- The spec with what its product_family and the title state added, never overriding a value the spec has.
create or replace function buyer_interest_text_spec(p_spec jsonb, p_context jsonb, p_title text) returns jsonb language plpgsql immutable as $fn$
declare
  spec jsonb := coalesce(p_spec, '{}'::jsonb);
  ctx jsonb := coalesce(p_context, '{}'::jsonb);
  txt text := concat_ws(' ; ', nullif(btrim(coalesce(spec->>'product_family', '')), ''), nullif(btrim(coalesce(p_title, '')), ''));
  low text;
  makes text[];
  has_make boolean;
  has_model boolean;
  items text[] := '{}';
  entries jsonb := '[]'::jsonb;
  item text;
  hit jsonb;
  mk text;
  figures numeric[];
  formats_ text[];
  cell_makers_ text[];
  n int;
begin
  if txt = '' or spec ? 'products' then return spec; end if;
  low := buyer_interest_unaccent(txt);
  makes := buyer_interest_make_list(buyer_interest_stated_list(
    case when jsonb_typeof(spec->'makes') = 'array' then spec->'makes' else spec->'system_brands' end,
    buyer_interest_first_text(spec->'make'), buyer_interest_first_text(ctx->'make')));
  has_make := makes <> array[null]::text[];
  if has_make and jsonb_typeof(spec->'makes') is distinct from 'array' then
    spec := spec || jsonb_build_object('makes', to_jsonb(makes));
  end if;
  if not has_make then
    makes := buyer_interest_text_makes(txt);
    if cardinality(makes) > 0 then
      has_make := true;
      spec := spec || jsonb_build_object('makes', to_jsonb(makes));
    end if;
  end if;

  -- models: the spec's own list, else the models the text names
  has_model := coalesce(buyer_interest_first_text(spec->'model'), buyer_interest_first_text(ctx->'model')) is not null
    or jsonb_typeof(coalesce(spec->'part_numbers', spec->'partNumbers', ctx->'part_numbers')) = 'array';
  if not has_model then
    if jsonb_typeof(spec->'models') = 'array' and jsonb_array_length(spec->'models') > 0 then
      for item in select btrim(v) from jsonb_array_elements_text(spec->'models') v where btrim(v) <> '' loop
        hit := (buyer_interest_text_models(item, case when has_make then makes else '{}' end))->0;
        mk := case when has_make and cardinality(makes) = 1 then makes[1] else hit->>'make' end;
        entries := entries || jsonb_build_array(jsonb_strip_nulls(jsonb_build_object('make', mk, 'model', item)));
      end loop;
    else
      for hit in select value from jsonb_array_elements(buyer_interest_text_models(txt, case when has_make then makes else '{}' end)) loop
        mk := case when has_make and cardinality(makes) = 1 then makes[1] else hit->>'make' end;
        entries := entries || jsonb_build_array(jsonb_build_object('make', mk, 'model', hit->>'model'));
      end loop;
    end if;
    n := jsonb_array_length(entries);
    if n >= 1 and not has_make then
      select coalesce(array_agg(distinct e->>'make') filter (where e->>'make' is not null), '{}') into makes
        from jsonb_array_elements(entries) e;
      if cardinality(makes) > 0 then spec := spec || jsonb_build_object('makes', to_jsonb(makes)); end if;
    end if;
    if n = 1 then
      spec := spec || jsonb_build_object('model', entries->0->>'model');
    elsif n > 1 then
      spec := spec || jsonb_build_object('products', entries);
    end if;
  else
    n := 0;
  end if;

  -- one kWh figure: a stated pack capacity, else the one figure the text states (several models share no single figure)
  if buyer_interest_number(spec->'kwh') is null and buyer_interest_number(spec->'capacity_kwh') is null
     and buyer_interest_number(spec->'kwh_min') is null and buyer_interest_number(spec->'kwh_max') is null
     and buyer_interest_number(ctx->'kwh') is null and buyer_interest_number(ctx->'capacity_kwh') is null then
    if buyer_interest_number(spec->'pack_kwh') is not null then
      spec := spec || jsonb_build_object('kwh', spec->'pack_kwh');
    elsif coalesce(n, 0) <= 1 then
      select coalesce(array_agg(distinct f::numeric), '{}') into figures
        from (select (regexp_matches(low, '(?<![a-z0-9.])(\d{1,3}(?:\.\d+)?)\s?kwh\y', 'g'))[1] as f) k
       where f::numeric between 1 and 200;
      if cardinality(figures) = 1 then spec := spec || jsonb_build_object('kwh', figures[1]); end if;
    end if;
  end if;

  -- cell formats and cell makers the text states
  if jsonb_typeof(spec->'cell_formats') is distinct from 'array' and buyer_interest_first_text(spec->'cell_format') is null then
    select coalesce(array_agg(distinct f order by f), '{}') into formats_
      from (select (regexp_matches(low, '\y(18650|21700|4680|26650|46800|pouch|prismatic)\y', 'g'))[1] as f) k;
    if cardinality(formats_) = 0 and low ~ '\ycylindrical\y' then formats_ := array['cylindrical']; end if;
    if cardinality(formats_) > 0 then
      spec := spec || jsonb_build_object('cell_formats', to_jsonb(formats_));
      if jsonb_typeof(spec->'formats') is distinct from 'array' and buyer_interest_first_text(spec->'format') is null
         and (formats_ && array['18650', '21700', '4680', '26650', '46800'] or low ~ '\ycells?\y') then
        spec := spec || jsonb_build_object('formats', jsonb_build_array('Cells'));
      end if;
    end if;
  end if;
  if jsonb_typeof(spec->'cell_makers') is distinct from 'array' and buyer_interest_first_text(spec->'cell_maker') is null then
    cell_makers_ := buyer_interest_text_cell_makers(txt);
    if cardinality(cell_makers_) > 0 then spec := spec || jsonb_build_object('cell_makers', to_jsonb(cell_makers_)); end if;
  end if;
  return spec;
end $fn$;

-- ---------------------------------------------------------------------------
-- Fact sets: products stay paired (R1), no vehicle make on a system (R5), nothing redundant (R4), nothing stated is lost (R6)
-- ---------------------------------------------------------------------------
--
-- - spec.products (or a text that pairs them) gives one set per product: its own make, model, chemistry, format and kWh.
--   A dimension the product leaves out is inherited only when the row states exactly one value for it.
-- - At most one dimension with several values: the values multiply out, single values apply to every line.
-- - Two or more dimensions with several values ("Tesla, Nissan; NMC, LFP") do not say which goes with which, so no line
--   pairs them: one set per value of each such dimension, carrying only the single-valued dimensions.
-- - A vehicle make is never paired with a battery system from a list.
-- p_independent (a buy box's lists): the lists are the buyer's criteria, so make x chemistry x format multiply out as
-- before 115 (Nissan, Tesla x NMC x Modules, Packs gives broad:nissan-nmc-modules, ...), never one make-free format line.
drop function if exists buyer_interest_fact_sets(jsonb, jsonb, jsonb, int, text);
drop function if exists buyer_interest_fact_sets(jsonb, jsonb, jsonb, int, text, boolean);
create or replace function buyer_interest_fact_sets(p_spec jsonb, p_context jsonb default '{}'::jsonb,
  p_fields jsonb default '{}'::jsonb, p_limit int default 12, p_title text default null, p_independent boolean default false)
returns table (facts jsonb[], stated_total int) language plpgsql immutable as $$
declare
  makes text[] := buyer_interest_make_list(buyer_interest_stated_list(p_spec->'makes', buyer_interest_first_text(p_spec->'make'),
    buyer_interest_first_text(p_context->'make'), buyer_interest_first_text(p_fields->'make')));
  chemists text[] := buyer_interest_stated_list(p_spec->'chemistries', buyer_interest_first_text(p_spec->'chemistry'),
    buyer_interest_first_text(p_context->'chemistry'), buyer_interest_first_text(p_fields->'chemistry'));
  formats text[] := buyer_interest_stated_list(p_spec->'formats', buyer_interest_first_text(p_spec->'format'),
    buyer_interest_first_text(p_context->'format'), buyer_interest_first_text(p_fields->'format'));
  products jsonb := case when jsonb_typeof(p_spec->'products') = 'array' and jsonb_array_length(p_spec->'products') > 0
    then p_spec->'products' end;
  multi int;
  one_make text;
  one_chem text;
  one_format text;
  pair jsonb;
  prod jsonb;
  pmakes text[];
  sets jsonb[] := '{}';
  m text;
  c text;
  f text;
  base jsonb := coalesce(p_spec, '{}'::jsonb) - 'products';
  built jsonb;
  spec_ jsonb;
  split_ jsonb[];
  s_ jsonb;
  cf text;
begin
  if makes = array[null]::text[] and buyer_interest_title_make(p_title) is not null then
    makes := array[buyer_interest_title_make(p_title)];
  end if;
  if formats = array[null]::text[] and buyer_interest_format(coalesce(buyer_interest_first_text(p_spec->'trade_kind'),
      buyer_interest_first_text(p_context->'trade_kind'))) is not null then
    formats := array[buyer_interest_format(coalesce(buyer_interest_first_text(p_spec->'trade_kind'),
      buyer_interest_first_text(p_context->'trade_kind')))];
  end if;
  multi := (cardinality(makes) > 1)::int + (cardinality(chemists) > 1)::int + (cardinality(formats) > 1)::int;
  one_make := case when cardinality(makes) = 1 then makes[1] end;
  one_chem := case when cardinality(chemists) = 1 then chemists[1] end;
  one_format := case when cardinality(formats) = 1 then formats[1] end;

  if products is null and multi >= 2 and not p_independent then
    pair := buyer_interest_text_pairs(p_title, makes, chemists);
    if pair is not null then products := pair; end if;
  end if;

  if products is not null then
    for prod in select value from jsonb_array_elements(products) loop
      pmakes := buyer_interest_make_list(buyer_interest_stated_list(prod->'makes', buyer_interest_first_text(prod->'make'), null));
      foreach m in array pmakes loop
        c := coalesce(buyer_interest_first_text(prod->'chemistry'), buyer_interest_first_text(prod->'chemistries'), one_chem);
        f := coalesce(buyer_interest_first_text(prod->'format'), buyer_interest_first_text(prod->'formats'), one_format);
        spec_ := base || jsonb_build_object(
          'makes', case when m is null then '[]'::jsonb else jsonb_build_array(m) end, 'make', m,
          'chemistries', case when c is null then '[]'::jsonb else jsonb_build_array(c) end, 'chemistry', c,
          'formats', case when f is null then '[]'::jsonb else jsonb_build_array(f) end, 'format', f)
          || case when prod ? 'model' then jsonb_build_object('model', prod->'model') else jsonb_build_object('model', null) end
          || case when buyer_interest_number(prod->'kwh') is not null
               then jsonb_build_object('kwh', prod->'kwh', 'capacity_kwh', null, 'kwh_min', prod->'kwh', 'kwh_max', prod->'kwh')
               when buyer_interest_number(prod->'kwh_min') is not null or buyer_interest_number(prod->'kwh_max') is not null
               then jsonb_build_object('kwh', null, 'capacity_kwh', null, 'kwh_min', prod->'kwh_min', 'kwh_max', prod->'kwh_max')
               else '{}'::jsonb end
          || case when prod ? 'part_numbers' then jsonb_build_object('part_numbers', prod->'part_numbers') else '{}'::jsonb end
          || case when prod ? 'cell_maker' then jsonb_build_object('cell_maker', prod->'cell_maker', 'cell_makers', '[]'::jsonb) else '{}'::jsonb end;
        built := buyer_interest_facts(spec_, p_context, p_fields) || jsonb_build_object('stated', buyer_interest_stated(spec_, p_context, p_fields, prod));
        sets := sets || jsonb_strip_nulls(built);
      end loop;
    end loop;
  elsif multi <= 1 or p_independent then
    for m, c, f in
      select x.value, y.value, z.value from unnest(makes) x(value) cross join unnest(chemists) y(value) cross join unnest(formats) z(value)
    loop
      spec_ := base || jsonb_build_object(
        'makes', case when m is null then '[]'::jsonb else jsonb_build_array(m) end, 'make', m,
        'chemistries', case when c is null then '[]'::jsonb else jsonb_build_array(c) end, 'chemistry', c,
        'formats', case when f is null then '[]'::jsonb else jsonb_build_array(f) end, 'format', f);
      sets := sets || jsonb_strip_nulls(buyer_interest_facts(spec_, p_context, p_fields)
        || jsonb_build_object('stated', buyer_interest_stated(spec_, p_context, p_fields)));
    end loop;
  else
    for m, c, f in
      select x.value, one_chem, one_format from unnest(makes) x(value) where cardinality(makes) > 1
      union all select one_make, y.value, one_format from unnest(chemists) y(value) where cardinality(chemists) > 1
      union all select one_make, one_chem, z.value from unnest(formats) z(value) where cardinality(formats) > 1
    loop
      spec_ := base || jsonb_build_object(
        'makes', case when m is null then '[]'::jsonb else jsonb_build_array(m) end, 'make', m,
        'chemistries', case when c is null then '[]'::jsonb else jsonb_build_array(c) end, 'chemistry', c,
        'formats', case when f is null then '[]'::jsonb else jsonb_build_array(f) end, 'format', f);
      sets := sets || jsonb_strip_nulls(buyer_interest_facts(spec_, p_context, p_fields)
        || jsonb_build_object('stated', buyer_interest_stated(spec_, p_context, p_fields)));
    end loop;
  end if;

  -- A cell request with no make or cell maker states its cell formats ("18650 / 21700 cells"): one line per format, each keyed
  -- broad:<format>-any-cells. With a make or a cell maker the key already scopes the line; the formats stay in stated.
  split_ := '{}';
  foreach s_ in array sets loop
    if buyer_interest_make(s_->>'make') is null and buyer_interest_slug(s_->>'cell_maker') is null
       and jsonb_typeof(s_->'stated'->'cell_formats') = 'array' and buyer_interest_format(s_->>'format') is not distinct from 'cell' then
      for cf in select jsonb_array_elements_text(s_->'stated'->'cell_formats') loop
        split_ := split_ || (s_ || jsonb_build_object('cell_format', lower(cf)));
      end loop;
    else
      split_ := split_ || s_;
    end if;
  end loop;
  sets := split_;

  -- R5: a vehicle make on a battery system is a system of no stated make (unless the model is itself stationary).
  select coalesce(array_agg(case when buyer_interest_format(s->>'format') = 'system' and buyer_interest_is_vehicle_make(s->>'make')
      and coalesce(s->>'model', '') !~* '\y(megapack|powerwall|powerpack|bess|container|cabinet|rack|ess)\y'
    then s - 'make' - 'makes' else s end), '{}') into sets from unnest(sets) s;
  -- one set per distinct product, nothing redundant next to a more specific one (R4), in a stable order
  select coalesce(array_agg(s order by s->>'make' nulls first, s->>'chemistry' nulls first, s->>'format' nulls first, s->>'model' nulls first, s::text), '{}')
    into sets from (select distinct s from unnest(buyer_interest_drop_redundant(sets)) s) d;
  stated_total := cardinality(sets);
  facts := sets[1:greatest(p_limit, 1)];
  return next;
end $$;

-- ---------------------------------------------------------------------------
-- Demand rows and offers: same writers as 112 with the changes above
-- ---------------------------------------------------------------------------

create or replace function buyer_interest_sync_demand_row(p_id text) returns void language plpgsql as $$
declare
  row_ crm_bulk_listings%rowtype;
  fact_sets jsonb[];
  product_sets jsonb[];
  stated_total int;
  facts jsonb;
  keys text[] := '{}';
  line_kind text;
  line_reason text;
  first_d date;
  last_d date;
  qty numeric;
  unit text;
  price_v numeric;
  currency_v text;
  price_unit_v text;
  price_basis_v text;
  needed date;
  expiry date;
  expiry_sticky boolean := false;
  refs text[];
  stated_text text;
  text_qty jsonb;
  text_price jsonb;
  price_max_v numeric;
begin
  -- One writer per source: the trigger and the backfill queue here, and each reads the row after the lock is
  -- granted, so the last one in always writes the newest facts. FOR KEY SHARE re-reads the current row version
  -- without blocking an ordinary UPDATE, so a writer holding the row cannot deadlock with a sync waiting here.
  perform pg_advisory_xact_lock(hashtext('demand:' || p_id));
  select * into row_ from crm_bulk_listings where id = p_id and kind = 'demand' for key share;
  if row_.id is null then
    -- Deleted, or no longer a demand row: its lines no longer describe a buyer's wish.
    delete from buyer_interest where demand_id = p_id;
    return;
  end if;

  -- A buyer we cannot name a company for cannot hold a line; the api resolves the company on write.
  if row_.company_id is null then
    delete from buyer_interest where demand_id = row_.id;
    return;
  end if;

  first_d := coalesce(row_.observed_on, row_.created_at::date, current_date);
  last_d := greatest(coalesce(buyer_interest_first_text(row_.spec->'confirmed_on')::date, first_d), first_d);

  -- Quantity and price: the spec's fields, else the one figure the request's own words state.
  stated_text := concat_ws(' ; ', nullif(btrim(coalesce(row_.spec->>'product_family', '')), ''), nullif(btrim(coalesce(row_.summary, '')), ''));
  qty := buyer_interest_number(row_.spec->'volume');
  unit := nullif(btrim(coalesce(row_.spec->>'volume_unit', '')), '');
  if qty is null then
    text_qty := buyer_interest_text_quantity(stated_text);
    qty := (text_qty->>'quantity')::numeric;
    unit := text_qty->>'unit';
  end if;
  -- A buyer's target per pack, with the ceiling beside it, is the price; else the ceiling is the price.
  price_max_v := buyer_interest_number(row_.spec->'max_price');
  price_v := coalesce(buyer_interest_number(row_.spec->'target_price_per_pack'), price_max_v);
  currency_v := nullif(btrim(coalesce(row_.spec->>'price_currency', '')), '');
  price_unit_v := buyer_interest_price_unit(coalesce(row_.spec->>'price_unit',
    case when row_.spec ? 'target_price_per_pack' then 'pack' end));
  if price_v is null then
    text_price := buyer_interest_text_price(stated_text);
    price_v := (text_price->>'price')::numeric;
    currency_v := coalesce(currency_v, text_price->>'currency');
    price_unit_v := coalesce(price_unit_v, text_price->>'unit');
  end if;
  -- A price carries its unit or is not written; the unit comes from the source (the volume unit of a pack or cell ask).
  price_unit_v := coalesce(price_unit_v, case when price_v is not null then buyer_interest_price_unit(row_.spec->>'volume_unit') end);
  if price_v is null or price_unit_v is null then
    price_v := null; price_max_v := null; currency_v := null; price_unit_v := null;
  elsif price_max_v is not null and price_max_v <= price_v then
    price_max_v := null;
  end if;
  price_basis_v := case when price_v is null then null else 'target' end;
  needed := case when coalesce(row_.spec->>'needed_by', '') ~ '^\d{4}-\d{2}-\d{2}$'
    then (row_.spec->>'needed_by')::date end;
  refs := array_remove(array[row_.source_id, 'crm:' || row_.id]::text[], null);

  if row_.status in ('open', 'qualifying') then
    line_kind := 'ask';
    expiry := needed;
  elsif row_.status = 'closed' and row_.closed_reason = 'bought_from_us' then
    -- A purchase from us: a bought line, no expiry.
    line_kind := 'bought';
    expiry := null;
  elsif row_.status = 'closed' and row_.closed_reason <> all (array['not_demand', 'duplicate',
      'supply_misfiled', 'moved_to_profile', 'research_profile']) then
    -- R2: a closed request is history, never a decline. Expired, 'no_longer_needed', 'bought_elsewhere' and every other
    -- reason that is still a buyer's ask stays visible as an ask that expires as closed (the day it lapsed or was
    -- closed), so a re-staged ask never keeps a superseded decision. Declined lines come only from a declined offer
    -- or dossier product.
    line_kind := 'ask';
    expiry := coalesce(needed, current_date);
    expiry_sticky := true;
  else
    -- Not a buying fact (duplicate, not a demand, misfiled supply) or owned by the profile path (moved to profile,
    -- research row): drop the asks.
    delete from buyer_interest where demand_id = row_.id;
    return;
  end if;

  select fs.facts, fs.stated_total into fact_sets, stated_total
  from buyer_interest_fact_sets(buyer_interest_text_spec(row_.spec, row_.context, row_.summary), row_.context, '{}'::jsonb, 12, row_.summary) fs;

  -- A row that states no product at all is not a want: it is not written, only recorded for a person to fix.
  select coalesce(array_agg(fact), '{}') into product_sets from unnest(fact_sets) fact
   where buyer_interest_states_product(fact);
  delete from buyer_interest_sync_errors where operation = 'no_product_facts' and source_id = row_.id;
  if cardinality(product_sets) = 0 then
    delete from buyer_interest where demand_id = row_.id;
    insert into buyer_interest_sync_errors (source_table, source_id, operation, message)
    values ('crm_bulk_listings', row_.id, 'no_product_facts',
      format('states no product fact (make, chemistry, format, part or kWh): %s',
        left(coalesce(nullif(btrim(coalesce(row_.summary, '')), ''), row_.source_id, row_.id), 120)));
    return;
  end if;

  -- The key set this row states now. Anything else on this source is stale: an old chemistry, a dropped make,
  -- or an outcome the row has since superseded.
  select coalesce(array_agg(distinct buyer_interest_product_key(fact)), '{}') into keys
  from unnest(product_sets) fact;

  delete from buyer_interest
  where demand_id = row_.id and not (kind = line_kind and product_key = any(keys));

  foreach facts in array product_sets loop
    insert into buyer_interest (id, company_id, person_id, kind, ownership, product_key, product_key_level,
      make, model, raw_product, format, chemistry, kwh_min, kwh_max, first_seen, last_seen, quantity, quantity_unit,
      quantity_basis, price, price_max, price_currency, price_unit, price_basis, source_refs, expires_on, demand_id,
      decline_reason, stated)
    values ('bi_' || replace(gen_random_uuid()::text, '-', ''), row_.company_id, row_.person_id, line_kind, 'synced',
      buyer_interest_product_key(facts), buyer_interest_key_level(buyer_interest_product_key(facts)),
      facts->>'make', facts->>'model', buyer_interest_raw_product(facts),
      buyer_interest_format(facts->>'format'),
      buyer_interest_chemistry(facts->>'chemistry'), buyer_interest_number(facts->'kwh_min'),
      buyer_interest_number(facts->'kwh_max'), first_d, last_d, qty, unit,
      case when qty is null then 'not_stated' else 'stated' end,
      price_v, price_max_v, currency_v, price_unit_v, price_basis_v, refs, expiry, row_.id, line_reason, facts->'stated')
    on conflict (kind, demand_id, product_key) where demand_id is not null do update set
      company_id = excluded.company_id,
      person_id = coalesce(excluded.person_id, buyer_interest.person_id),
      product_key_level = excluded.product_key_level,
      make = coalesce(excluded.make, buyer_interest.make),
      model = coalesce(excluded.model, buyer_interest.model),
      raw_product = coalesce(excluded.raw_product, buyer_interest.raw_product),
      format = coalesce(excluded.format, buyer_interest.format),
      chemistry = coalesce(excluded.chemistry, buyer_interest.chemistry),
      kwh_min = coalesce(excluded.kwh_min, buyer_interest.kwh_min),
      kwh_max = coalesce(excluded.kwh_max, buyer_interest.kwh_max),
      first_seen = least(buyer_interest.first_seen, excluded.first_seen),
      last_seen = greatest(buyer_interest.last_seen, excluded.last_seen),
      quantity = coalesce(excluded.quantity, buyer_interest.quantity),
      quantity_unit = coalesce(excluded.quantity_unit, buyer_interest.quantity_unit),
      quantity_basis = coalesce(excluded.quantity_basis, buyer_interest.quantity_basis),
      price = coalesce(excluded.price, buyer_interest.price),
      price_max = case when excluded.price is not null then excluded.price_max else buyer_interest.price_max end,
      price_currency = coalesce(excluded.price_currency, buyer_interest.price_currency),
      price_unit = coalesce(excluded.price_unit, buyer_interest.price_unit),
      price_basis = coalesce(excluded.price_basis, buyer_interest.price_basis),
      source_refs = (select array_agg(distinct ref order by ref) from unnest(buyer_interest.source_refs || excluded.source_refs) ref),
      expires_on = case when expiry_sticky then coalesce(buyer_interest.expires_on, excluded.expires_on)
        else excluded.expires_on end,
      decline_reason = coalesce(excluded.decline_reason, buyer_interest.decline_reason),
      stated = coalesce(excluded.stated, buyer_interest.stated),
      updated_at = now();
  end loop;

  if stated_total > cardinality(product_sets) then
    insert into buyer_interest_sync_errors (source_table, source_id, operation, message)
    values ('crm_bulk_listings', row_.id, 'truncated',
      format('kept %s of %s stated combinations', cardinality(product_sets), stated_total));
  end if;
end $$;

create or replace function buyer_interest_sync_offer_row(p_id text) returns void language plpgsql as $$
declare
  offer crm_bulk_offers%rowtype;
  listing crm_bulk_listings%rowtype;
  fields jsonb;
  fact_sets jsonb[];
  product_sets jsonb[];
  stated_total int;
  facts jsonb;
  keys text[] := '{}';
  line_kind text;
  line_reason text;
  first_d date;
  last_d date;
  qty numeric;
  unit text;
  price_v numeric;
  currency_v text;
  price_unit_v text;
  price_basis_v text;
  refs text[];
begin
  -- Same single-writer rule as the demand sync: lock on the offer, then read offer, listing and fields.
  perform pg_advisory_xact_lock(hashtext('offer:' || p_id));
  select * into offer from crm_bulk_offers where id = p_id for key share;
  if offer.id is null then
    delete from buyer_interest where offer_id = p_id;
    return;
  end if;

  -- Only a counterparty (a buyer) on a supply listing describes a purchase. Our own contacts do not.
  select * into listing from crm_bulk_listings where id = offer.bulk_listing_id for key share;
  if coalesce(offer.role, '') <> 'counterparty' or offer.company_id is null or listing.id is null
      or listing.kind <> 'supply' then
    delete from buyer_interest where offer_id = offer.id;
    return;
  end if;

  -- Signed is a committed purchase, so it counts as bought; contract_out alone does not.
  if offer.stage in ('signed', 'invoiced', 'paid', 'complete') then
    line_kind := 'bought';
  elsif offer.stage in ('declined', 'lost') then
    line_kind := 'declined';
    line_reason := nullif(btrim(coalesce(offer.declined_reason, '')), '');
  else
    delete from buyer_interest where offer_id = offer.id;  -- no committed purchase: no line
    return;
  end if;

  select coalesce(jsonb_object_agg(lower(field_key), value), '{}'::jsonb) into fields
  from crm_bulk_listing_fields where bulk_listing_id = listing.id and value is not null and status <> 'conflict';

  select fs.facts, fs.stated_total into fact_sets, stated_total
  from buyer_interest_fact_sets(listing.spec, listing.context, fields, 12,
    coalesce(nullif(btrim(listing.context->>'listing_title'), ''), nullif(btrim(coalesce(listing.spec->>'listing_title', '')), ''),
      listing.summary)) fs;

  -- A listing that states no product at all gives the purchase nothing to match: it is recorded, not written.
  select coalesce(array_agg(fact), '{}') into product_sets from unnest(fact_sets) fact
   where buyer_interest_states_product(fact);
  delete from buyer_interest_sync_errors where operation = 'no_product_facts' and source_id = offer.id;
  if cardinality(product_sets) = 0 then
    delete from buyer_interest where offer_id = offer.id;
    insert into buyer_interest_sync_errors (source_table, source_id, operation, message)
    values ('crm_bulk_offers', offer.id, 'no_product_facts',
      format('listing %s states no product fact (make, chemistry, format, part or kWh): %s', listing.id,
        left(coalesce(nullif(btrim(coalesce(listing.summary, '')), ''), listing.id), 100)));
    return;
  end if;

  -- The product the listing states now; a line for another product or outcome on this offer is stale.
  select coalesce(array_agg(distinct buyer_interest_product_key(fact)), '{}') into keys
  from unnest(product_sets) fact;
  delete from buyer_interest
  where offer_id = offer.id and not (kind = line_kind and product_key = any(keys));

  first_d := coalesce(listing.observed_on, offer.created_at::date, current_date);
  last_d := greatest(coalesce(offer.last_touch_on, offer.updated_at::date, current_date), first_d);
  -- "40 packs" on the listing is the closest the row states; the offer's terms carry the money.
  qty := case when coalesce(listing.quantity, '') ~ '^\s*[0-9]+(\.[0-9]+)?'
    then (regexp_match(listing.quantity, '^\s*([0-9]+(?:\.[0-9]+)?)'))[1]::numeric end;
  unit := nullif(btrim(coalesce(listing.spec->>'volume_unit', '')), '');
  price_v := buyer_interest_number(offer.terms->'amount');
  currency_v := nullif(btrim(coalesce(offer.terms->>'currency', '')), '');
  price_unit_v := buyer_interest_price_unit(offer.terms->>'unit');
  -- A price with no unit the source gives ("EUR 6,175 whole batch") is not written: a dangling "EUR/" says nothing.
  if price_v is not null and price_unit_v is null then
    price_v := null; currency_v := null; price_unit_v := null;
  end if;
  price_basis_v := case when price_v is null then null when line_kind = 'bought' then 'paid' else 'bid' end;
  refs := array_remove(array['crm:' || offer.id, 'crm:' || listing.id]::text[]
    || case when offer.counterpart_id is not null then array['crm:' || offer.counterpart_id]::text[] else '{}'::text[] end,
    null);

  foreach facts in array product_sets loop
    insert into buyer_interest (id, company_id, person_id, kind, ownership, product_key, product_key_level,
      make, model, raw_product, format, chemistry, kwh_min, kwh_max, first_seen, last_seen, quantity, quantity_unit,
      quantity_basis, price, price_currency, price_unit, price_basis, source_refs, expires_on, offer_id,
      decline_reason, stated)
    values ('bi_' || replace(gen_random_uuid()::text, '-', ''), offer.company_id, offer.person_id, line_kind, 'synced',
      buyer_interest_product_key(facts), buyer_interest_key_level(buyer_interest_product_key(facts)),
      facts->>'make', facts->>'model', buyer_interest_raw_product(facts),
      buyer_interest_format(facts->>'format'),
      buyer_interest_chemistry(facts->>'chemistry'), buyer_interest_number(facts->'kwh_min'),
      buyer_interest_number(facts->'kwh_max'), first_d, last_d, qty, unit,
      case when qty is null then 'not_stated' else 'stated' end,
      price_v, currency_v, price_unit_v, price_basis_v, refs, null, offer.id, line_reason, facts->'stated')
    on conflict (kind, offer_id, product_key) where offer_id is not null do update set
      company_id = excluded.company_id,
      person_id = coalesce(excluded.person_id, buyer_interest.person_id),
      product_key_level = excluded.product_key_level,
      make = coalesce(excluded.make, buyer_interest.make),
      model = coalesce(excluded.model, buyer_interest.model),
      raw_product = coalesce(excluded.raw_product, buyer_interest.raw_product),
      format = coalesce(excluded.format, buyer_interest.format),
      chemistry = coalesce(excluded.chemistry, buyer_interest.chemistry),
      kwh_min = coalesce(excluded.kwh_min, buyer_interest.kwh_min),
      kwh_max = coalesce(excluded.kwh_max, buyer_interest.kwh_max),
      first_seen = least(buyer_interest.first_seen, excluded.first_seen),
      last_seen = greatest(buyer_interest.last_seen, excluded.last_seen),
      quantity = coalesce(excluded.quantity, buyer_interest.quantity),
      price = coalesce(excluded.price, buyer_interest.price),
      price_currency = coalesce(excluded.price_currency, buyer_interest.price_currency),
      price_unit = coalesce(excluded.price_unit, buyer_interest.price_unit),
      price_basis = coalesce(excluded.price_basis, buyer_interest.price_basis),
      source_refs = (select array_agg(distinct ref order by ref) from unnest(buyer_interest.source_refs || excluded.source_refs) ref),
      decline_reason = coalesce(excluded.decline_reason, buyer_interest.decline_reason),
      stated = coalesce(excluded.stated, buyer_interest.stated),
      updated_at = now();
  end loop;

  if stated_total > cardinality(product_sets) then
    insert into buyer_interest_sync_errors (source_table, source_id, operation, message)
    values ('crm_bulk_offers', offer.id, 'truncated',
      format('kept %s of %s stated combinations', cardinality(product_sets), stated_total));
  end if;
end $$;


-- R2 for lines written before this migration.
delete from buyer_interest where kind = 'declined' and demand_id is not null;

do $$ begin
  insert into crm_data_migrations (id) values ('115_buyer_interest_conformance') on conflict do nothing;
end $$;

commit;
