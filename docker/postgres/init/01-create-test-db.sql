-- Runs once, when the database volume is created.
-- A separate database for automated tests, so tests never touch development data.
CREATE DATABASE beauty_test OWNER beauty;
