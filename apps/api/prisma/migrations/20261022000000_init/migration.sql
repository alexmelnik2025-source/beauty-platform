-- btree_gist enables the exclusion constraint that prevents double booking
-- (EXCLUDE USING gist on staff_id + time range), added together with the appointment table.
CREATE EXTENSION IF NOT EXISTS btree_gist;
