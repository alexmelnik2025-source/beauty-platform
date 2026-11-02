-- Optional coordinates for public directory map markers.
ALTER TABLE "location"
  ADD COLUMN "latitude" DOUBLE PRECISION,
  ADD COLUMN "longitude" DOUBLE PRECISION;

ALTER TABLE "location"
  ADD CONSTRAINT "location_coordinates_pair_check"
  CHECK (("latitude" IS NULL) = ("longitude" IS NULL));

ALTER TABLE "location"
  ADD CONSTRAINT "location_latitude_range_check"
  CHECK ("latitude" IS NULL OR ("latitude" >= -90 AND "latitude" <= 90));

ALTER TABLE "location"
  ADD CONSTRAINT "location_longitude_range_check"
  CHECK ("longitude" IS NULL OR ("longitude" >= -180 AND "longitude" <= 180));
