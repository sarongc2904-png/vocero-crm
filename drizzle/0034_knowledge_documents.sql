CREATE TABLE "kb_document" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"filename" text NOT NULL,
	"mime_type" text NOT NULL,
	"file_size" integer NOT NULL,
	"storage_path" text NOT NULL,
	"status" text DEFAULT 'uploaded' NOT NULL,
	"error" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "kb_document_file_size_nonnegative" CHECK ("kb_document"."file_size" >= 0),
	CONSTRAINT "kb_document_mime_type_allowed" CHECK ("kb_document"."mime_type" in ('text/plain', 'application/pdf')),
	CONSTRAINT "kb_document_status_allowed" CHECK ("kb_document"."status" in ('uploaded', 'processing', 'review', 'ready', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "kb_document_chunk" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"document_id" text NOT NULL,
	"content" text NOT NULL,
	"position" integer NOT NULL,
	"page" integer,
	"approved" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "kb_document_chunk_position_nonnegative" CHECK ("kb_document_chunk"."position" >= 0),
	CONSTRAINT "kb_document_chunk_page_positive" CHECK ("kb_document_chunk"."page" is null or "kb_document_chunk"."page" > 0),
	CONSTRAINT "kb_document_chunk_content_nonempty" CHECK (length(btrim("kb_document_chunk"."content")) > 0)
);
--> statement-breakpoint
ALTER TABLE "kb_document" ADD CONSTRAINT "kb_document_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "kb_document_chunk" ADD CONSTRAINT "kb_document_chunk_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "kb_document_org_id_uq" ON "kb_document" USING btree ("organization_id","id");
--> statement-breakpoint
ALTER TABLE "kb_document_chunk" ADD CONSTRAINT "kb_document_chunk_org_document_fk" FOREIGN KEY ("organization_id","document_id") REFERENCES "public"."kb_document"("organization_id","id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "kb_document_org_storage_path_uq" ON "kb_document" USING btree ("organization_id","storage_path");
--> statement-breakpoint
CREATE INDEX "kb_document_org_status_idx" ON "kb_document" USING btree ("organization_id","status");
--> statement-breakpoint
CREATE INDEX "kb_document_org_created_idx" ON "kb_document" USING btree ("organization_id","created_at");
--> statement-breakpoint
CREATE UNIQUE INDEX "kb_document_chunk_org_document_position_uq" ON "kb_document_chunk" USING btree ("organization_id","document_id","position");
--> statement-breakpoint
CREATE INDEX "kb_document_chunk_org_approved_idx" ON "kb_document_chunk" USING btree ("organization_id","approved");
