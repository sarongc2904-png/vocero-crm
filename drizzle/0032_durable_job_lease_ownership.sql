-- Un token nuevo por reclamación impide que un worker cuyo lease expiró
-- modifique o elimine el durable_job después de que otro worker lo recuperó.
ALTER TABLE "durable_job" ADD COLUMN "lease_token" text;
