CREATE TABLE "commercial_admin_audit" (
  "id" text PRIMARY KEY NOT NULL,
  "actor_user_id" text NOT NULL,
  "action" text NOT NULL,
  "organization_id" text,
  "plan_id" text,
  "before_state" jsonb,
  "after_state" jsonb,
  "created_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "commercial_admin_audit_actor_user_id_user_id_fk"
    FOREIGN KEY ("actor_user_id") REFERENCES "public"."user"("id")
    ON DELETE restrict ON UPDATE no action,
  CONSTRAINT "commercial_admin_audit_organization_id_organization_id_fk"
    FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id")
    ON DELETE set null ON UPDATE no action,
  CONSTRAINT "commercial_admin_audit_plan_id_commercial_plan_id_fk"
    FOREIGN KEY ("plan_id") REFERENCES "public"."commercial_plan"("id")
    ON DELETE set null ON UPDATE no action
);

CREATE INDEX "commercial_admin_audit_created_idx"
  ON "commercial_admin_audit" ("created_at");

CREATE INDEX "commercial_admin_audit_org_created_idx"
  ON "commercial_admin_audit" ("organization_id", "created_at");

CREATE INDEX "commercial_admin_audit_actor_created_idx"
  ON "commercial_admin_audit" ("actor_user_id", "created_at");
