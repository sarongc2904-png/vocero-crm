-- Cierra a nivel PostgreSQL las relaciones entre dos tablas tenant-aware.
--
-- Se conservan las FKs simples existentes para no cambiar sus nombres ni el
-- contrato histórico de Drizzle. La FK compuesta adicional vuelve imposible
-- que el organization_id del hijo difiera del organization_id del padre.
-- El catálogo es la fuente de verdad porque varias tablas históricas (RBAC,
-- asignaciones y trazas) nacieron en migraciones SQL y no viven en schema.ts.
DO $$
DECLARE
  relation record;
  parent_relation record;
  tenant_constraint_name text;
  parent_index_name text;
  delete_action text;
  update_action text;
BEGIN
  -- Cada padre necesita una llave candidata (organization_id, id). Se crea una
  -- vez por tabla antes de agregar las FKs que la referencian.
  FOR parent_relation IN
    SELECT DISTINCT parent.relname AS parent_table
    FROM pg_constraint fk
    JOIN pg_class child ON child.oid = fk.conrelid
    JOIN pg_class parent ON parent.oid = fk.confrelid
    JOIN pg_namespace child_namespace ON child_namespace.oid = child.relnamespace
    JOIN pg_namespace parent_namespace ON parent_namespace.oid = parent.relnamespace
    JOIN LATERAL unnest(fk.confkey) WITH ORDINALITY
      AS parent_key(parent_attnum, position)
      ON parent_key.position = 1
    JOIN pg_attribute parent_column
      ON parent_column.attrelid = fk.confrelid
     AND parent_column.attnum = parent_key.parent_attnum
    WHERE fk.contype = 'f'
      AND array_length(fk.conkey, 1) = 1
      AND child_namespace.nspname = 'public'
      AND parent_namespace.nspname = 'public'
      AND parent_column.attname = 'id'
      AND EXISTS (
        SELECT 1 FROM pg_attribute organization_column
        WHERE organization_column.attrelid = child.oid
          AND organization_column.attname = 'organization_id'
          AND NOT organization_column.attisdropped
      )
      AND EXISTS (
        SELECT 1 FROM pg_attribute organization_column
        WHERE organization_column.attrelid = parent.oid
          AND organization_column.attname = 'organization_id'
          AND NOT organization_column.attisdropped
      )
    ORDER BY parent.relname
  LOOP
    parent_index_name := left(
      parent_relation.parent_table || '_organization_id_id_uq',
      63
    );
    EXECUTE format(
      'CREATE UNIQUE INDEX IF NOT EXISTS %I ON %I.%I (organization_id, id)',
      parent_index_name,
      'public',
      parent_relation.parent_table
    );
  END LOOP;

  FOR relation IN
    SELECT
      child.oid AS child_oid,
      child.relname AS child_table,
      parent.oid AS parent_oid,
      parent.relname AS parent_table,
      child_column.attname AS child_column,
      parent_column.attname AS parent_column,
      fk.confdeltype,
      fk.confupdtype
    FROM pg_constraint fk
    JOIN pg_class child ON child.oid = fk.conrelid
    JOIN pg_class parent ON parent.oid = fk.confrelid
    JOIN pg_namespace child_namespace ON child_namespace.oid = child.relnamespace
    JOIN pg_namespace parent_namespace ON parent_namespace.oid = parent.relnamespace
    JOIN LATERAL unnest(fk.conkey, fk.confkey) WITH ORDINALITY
      AS key_pair(child_attnum, parent_attnum, position)
      ON key_pair.position = 1
    JOIN pg_attribute child_column
      ON child_column.attrelid = fk.conrelid
     AND child_column.attnum = key_pair.child_attnum
    JOIN pg_attribute parent_column
      ON parent_column.attrelid = fk.confrelid
     AND parent_column.attnum = key_pair.parent_attnum
    WHERE fk.contype = 'f'
      AND array_length(fk.conkey, 1) = 1
      AND child_namespace.nspname = 'public'
      AND parent_namespace.nspname = 'public'
      AND parent_column.attname = 'id'
      AND EXISTS (
        SELECT 1
        FROM pg_attribute organization_column
        WHERE organization_column.attrelid = child.oid
          AND organization_column.attname = 'organization_id'
          AND NOT organization_column.attisdropped
      )
      AND EXISTS (
        SELECT 1
        FROM pg_attribute organization_column
        WHERE organization_column.attrelid = parent.oid
          AND organization_column.attname = 'organization_id'
          AND NOT organization_column.attisdropped
      )
    ORDER BY child.relname, child_column.attname
  LOOP
    tenant_constraint_name := left(
      relation.child_table || '_' || relation.child_column || '_tenant_fk',
      63
    );

    IF NOT EXISTS (
      SELECT 1
      FROM pg_constraint existing
      WHERE existing.conrelid = relation.child_oid
        AND existing.conname = tenant_constraint_name
    ) THEN
      update_action := CASE relation.confupdtype
        WHEN 'r' THEN 'RESTRICT'
        WHEN 'c' THEN 'CASCADE'
        WHEN 'n' THEN 'SET NULL'
        WHEN 'd' THEN 'SET DEFAULT'
        ELSE 'NO ACTION'
      END;
      delete_action := CASE relation.confdeltype
        WHEN 'r' THEN 'RESTRICT'
        WHEN 'c' THEN 'CASCADE'
        WHEN 'n' THEN format('SET NULL (%I)', relation.child_column)
        WHEN 'd' THEN format('SET DEFAULT (%I)', relation.child_column)
        ELSE 'NO ACTION'
      END;

      EXECUTE format(
        'ALTER TABLE %I.%I ADD CONSTRAINT %I FOREIGN KEY (organization_id, %I) REFERENCES %I.%I (organization_id, %I) ON UPDATE %s ON DELETE %s NOT VALID',
        'public',
        relation.child_table,
        tenant_constraint_name,
        relation.child_column,
        'public',
        relation.parent_table,
        relation.parent_column,
        update_action,
        delete_action
      );

      -- VALIDATE falla de forma atómica si ya existe cualquier cruce tenant.
      EXECUTE format(
        'ALTER TABLE %I.%I VALIDATE CONSTRAINT %I',
        'public',
        relation.child_table,
        tenant_constraint_name
      );
    END IF;
  END LOOP;
END $$;
