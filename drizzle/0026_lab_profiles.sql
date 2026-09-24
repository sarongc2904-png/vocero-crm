CREATE TABLE "lab_profile" (
  "id" text PRIMARY KEY NOT NULL,
  "organization_id" text NOT NULL,
  "business_context" text,
  "enabled_scenarios" jsonb,
  "scenario_scripts" jsonb,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "lab_profile_organization_id_organization_id_fk"
    FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id")
    ON DELETE cascade ON UPDATE no action
);

CREATE UNIQUE INDEX "lab_profile_org_uq" ON "lab_profile" USING btree ("organization_id");
