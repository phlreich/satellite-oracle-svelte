# Test Queries

Last Updated: 2026-02-10

Purpose: keep a small set of high-value manual query prompts with SQL definitions and expected counts against the current local DB snapshot.
Revalidated: 2026-02-10 local snapshot still matches the expected counts in Q1/Q2/Q3.

## Q1 OneWeb Soyuz Subset

Prompt:

- Show only OneWeb commercial-communications payloads that are still trackable, excluding Falcon 9 launches; restrict to Soyuz-2-1B Fregat launches from Vostochny or Baikonur.

Expected visible objects:

- `386`

SQL definition:

```sql
SELECT COUNT(DISTINCT d.norad_cat_id) AS c
FROM discos_objects d
JOIN gp g ON g.norad_cat_id = d.norad_cat_id
JOIN discos_object_entities op
  ON op.norad_cat_id = d.norad_cat_id
 AND op.role = 'operator'
 AND op.entity_type = 'organisation'
WHERE d.object_class = 'Payload'
  AND d.mission = 'Commercial Communications'
  AND d.launch_vehicle_name = 'Soyuz-2-1B Fregat'
  AND d.launch_site_name IN ('Vostochny Cosmodrome', 'Baikonur Cosmodrome (Tyuratam)')
  AND op.entity_name IN (
    'One Web (Network Access Associates Ltd.)',
    'One Web',
    'Eutelsat OneWeb (Network Access Associates Ltd.)'
  );
```

## Q2 US Launch + Non-US State Commercial Payloads

Prompt:

- Show payloads launched from the United States where the owning state is not United States, keeping only Commercial Communications; then focus the largest non-US state group.

Expected visible objects:

- `53`

Largest state group:

- `Japan` with `9`

SQL definition:

```sql
SELECT COUNT(DISTINCT d.norad_cat_id) AS c
FROM discos_objects d
JOIN gp g ON g.norad_cat_id = d.norad_cat_id
JOIN discos_object_entities l
  ON l.norad_cat_id = d.norad_cat_id
 AND l.role = 'launch'
 AND l.entity_type = 'country'
JOIN discos_object_entities s
  ON s.norad_cat_id = d.norad_cat_id
 AND s.role = 'state'
 AND s.entity_type = 'country'
WHERE d.object_class = 'Payload'
  AND d.mission = 'Commercial Communications'
  AND l.entity_name = 'United States'
  AND s.entity_name != 'United States';
```

## Q3 GEO-Like Mission-Related Kourou/Xichang

Prompt:

- Show only mission-related objects (`Payload Mission Related Object` or `Rocket Mission Related Object`) with GEO-like period (1300-1600 minutes), limited to launches from Kourou or Xichang.

Expected visible objects:

- `33`

SQL definition:

```sql
SELECT COUNT(DISTINCT d.norad_cat_id) AS c
FROM discos_objects d
JOIN gp g ON g.norad_cat_id = d.norad_cat_id
WHERE d.object_class IN ('Payload Mission Related Object', 'Rocket Mission Related Object')
  AND g.period BETWEEN 1300 AND 1600
  AND d.launch_site_name IN ('Guiana Space Center (Kourou)', 'Xichang Satellite Launch Center');
```
