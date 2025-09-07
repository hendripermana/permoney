class AddEffectiveClassificationToAccounts < ActiveRecord::Migration[7.2]
  def up
    add_column :accounts, :effective_classification, :string

    execute <<~SQL
      UPDATE accounts a
      SET effective_classification =
        CASE
          WHEN a.accountable_type IN ('Loan','CreditCard','OtherLiability') THEN 'liability'
          WHEN a.accountable_type = 'PersonalLending' AND EXISTS (
            SELECT 1 FROM personal_lendings pl WHERE pl.id = a.accountable_id AND pl.lending_direction = 'borrowing_from'
          ) THEN 'liability'
          ELSE 'asset'
        END;
    SQL

    execute <<~SQL
      CREATE OR REPLACE FUNCTION compute_effective_classification(a accounts)
      RETURNS text
      LANGUAGE plpgsql
      AS $$
      DECLARE
        dir text;
      BEGIN
        IF a.accountable_type IN ('Loan','CreditCard','OtherLiability') THEN
          RETURN 'liability';
        ELSIF a.accountable_type = 'PersonalLending' THEN
          SELECT lending_direction INTO dir FROM personal_lendings WHERE id = a.accountable_id;
          IF dir = 'borrowing_from' THEN
            RETURN 'liability';
          ELSE
            RETURN 'asset';
          END IF;
        ELSE
          RETURN 'asset';
        END IF;
      END;
      $$;
    SQL

    execute <<~SQL
      CREATE OR REPLACE FUNCTION trg_set_accounts_effective_classification()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      BEGIN
        NEW.effective_classification := compute_effective_classification(NEW);
        RETURN NEW;
      END;
      $$;
    SQL

    execute <<~SQL
      CREATE TRIGGER set_accounts_effective_classification
      BEFORE INSERT OR UPDATE OF accountable_type, accountable_id
      ON accounts
      FOR EACH ROW
      EXECUTE FUNCTION trg_set_accounts_effective_classification();
    SQL

    execute <<~SQL
      CREATE OR REPLACE FUNCTION trg_update_accounts_effective_classification_from_pl()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      BEGIN
        UPDATE accounts
        SET effective_classification = CASE WHEN NEW.lending_direction = 'borrowing_from' THEN 'liability' ELSE 'asset' END
        WHERE accounts.accountable_type = 'PersonalLending' AND accounts.accountable_id = NEW.id;
        RETURN NEW;
      END;
      $$;
    SQL

    execute <<~SQL
      CREATE TRIGGER update_accounts_effective_classification_from_pl
      AFTER INSERT OR UPDATE OF lending_direction
      ON personal_lendings
      FOR EACH ROW
      EXECUTE FUNCTION trg_update_accounts_effective_classification_from_pl();
    SQL
  end

  def down
    execute "DROP TRIGGER IF EXISTS update_accounts_effective_classification_from_pl ON personal_lendings;"
    execute "DROP FUNCTION IF EXISTS trg_update_accounts_effective_classification_from_pl();"
    execute "DROP TRIGGER IF EXISTS set_accounts_effective_classification ON accounts;"
    execute "DROP FUNCTION IF EXISTS trg_set_accounts_effective_classification();"
    execute "DROP FUNCTION IF EXISTS compute_effective_classification(accounts);"
    remove_column :accounts, :effective_classification
  end
end
